import { encodeFunctionData, type Abi } from "viem";
import { DOCKING_MODULE_ABI } from "@uvp-eth/protocol-bindings";
import type { ProjectionStore } from "../storage/projection-store.js";
import { noopLogger, type Hex, type LifecycleService, type Logger } from "../shared/types.js";
import { redactErrorMessage } from "../security/redaction.js";
import {
  factAttributionPayload,
  resolvePlanCapabilityTablesFromStore,
  selectorBindingForTargetStage,
  zeroSelectorBinding,
  ZERO_BYTES32 as CAPABILITY_ZERO_BYTES32,
  type BuiltFactAttribution,
  type BuiltSelectorBinding,
  type PlanCapabilityTables
} from "../submissions/capability-proofs.js";
import type {
  DockAutomationConfig,
  DockAutomationRunSummary,
  DockAutomationSubmitter,
  DockRouteOutputBinding,
  DockRouteRecord,
  DockRouteSource
} from "./types.js";

/** submitDockedSignal 的镜像事实造证结果（payload 形状见造证单源）。 */
interface DockedSignalProofs {
  readonly attribution: BuiltFactAttribution;
  readonly selectorBinding: BuiltSelectorBinding;
}

/** keeper 写面切片：submitDockedInput/submitDockedSignal 取自
 * protocol-bindings 单源（DOCKING_MODULE_ABI）——4.4 起 submitDockedSignal
 * 携 attribution/selectorBinding 造证参数，手抄副本会随协议演进漂移成错
 * selector。先放宽为泛型 Abi 再切片：直接在整表字面量类型上做
 * filter/encodeFunctionData 参数推导会让 viem 的巨型条件类型爆栈
 * （TS2589）；切片的 selector 与参数布局由 dock-automation 测试按
 * v4.4 fixture 钉住。 */
const dockingWriteAbi: Abi = (DOCKING_MODULE_ABI as Abi).filter(
  (entry) =>
    entry.type === "function" &&
    (entry.name === "submitDockedInput" || entry.name === "submitDockedSignal")
);

/** 无词表（外部发布 plan / 投影无该 plan）时的空两表：造证归零，由链上
 * 词表闸裁决（与 submissions 车道同取舍）。 */
const EMPTY_PLAN_CAPABILITY_TABLES: PlanCapabilityTables = {
  selectorBindings: [],
  signalCapabilities: []
};

/**
 * Dock liveness worker（keeper 只提供活性）。
 *
 * 候选发现完全来自投影 + route 来源，keeper 不发明任何协议 word：
 * - attach（existing）：同意门三腿（目标单 creator / 在任执行者 /
 *   publisher attach 预授权）都不含中继 keeper 钱包——keeper 只广播
 *   route 来源预组装的 attachCalldata（预授权材料在 calldata 内，对齐
 *   openDockedOrder 的 openCalldata 模式）；仅当父单与目标单都已在投影
 *   中出生且该 route 尚无 dock 实例时提交。
 * - open（new）：对称的预组装 calldata 车道；仅当投影中入口 hook 已
 *   Ready 且该 route 尚无 dock 实例时提交。
 * - input（existing 专属）：new 模式链上只登记出生锚绑定且由 open 原子
 *   投递，无活 input 面；existing 逐端口活交付——父订单 hook Ready 且
 *   binding 未投递 → submitDockedInput，无出生锚可跳过。
 * - output（两模式同构）：目标单事实已在投影中且 binding 未投递 →
 *   submitDockedSignal（attach 前已成立的目标输出由此重放回填；未成立
 *   的绑定链上 revert DockOutputNotReady，由窗口重试）。submitDockedSignal
 *   的镜像事实造证（attribution/selectorBinding）由 capability-proofs
 *   单源按父 plan 词表现场铸造。
 *
 * 未配置 routeSource/submitter 时 runOnce 为显式 no-op（summary 归零），
 * 便于仅索引部署共享同一装配。
 */
export class DockAutomationWorker implements LifecycleService {
  readonly name = "dock-automation";

  readonly #config: DockAutomationConfig;
  readonly #routeSource: DockRouteSource | undefined;
  readonly #submitter: DockAutomationSubmitter | undefined;
  readonly #projectionStore: ProjectionStore;
  readonly #dockingAddress: Hex;
  readonly #chainId: number;
  readonly #logger: Logger;
  readonly #now: () => Date;
  #timer: NodeJS.Timeout | undefined;
  #running = false;
  #checking = false;
  #lastSummary: DockAutomationRunSummary | undefined;
  /**
   * 广播 + 最终性窗口去重：同一 key 在 redeliveryWindowMs 内已尝试过
   * （无论成败）则本轮跳过。成功后窗口防的是 finalize+索引延迟内的
   * 纯 gas 浪费；失败后同样占窗——否则持续 revert 的绑定每轮重发，
   * gas 燃烧没有任何速率上限。窗口过后投影仍未呈现 delivery 才重试
   * （覆盖交易丢失），每次重试的失败照常进 summary.skipped 可见。
   * 进程内状态即可：keeper 是单实例写者，重启多发的最坏情形是窗口内
   * 每绑定一条冗余交易（投递事实以投影为准，重启后仍收敛）。
   */
  readonly #lastBroadcastAt = new Map<string, number>();
  /**
   * 词表两表解析（capability-proofs 单源）。plan 词表 finalize 后不可变，
   * 但"解析故障轮"的 failed 态会恢复、plan 也可能在 keeper 启动后才进
   * 投影——缓存只覆盖单轮（runOnce 开头重建），跨轮钉死会把手写词表当
   * 终态。
   */
  #runPlanTables = new Map<string, PlanCapabilityTables | undefined>();
  readonly #resolvePlanTables: (planId: Hex) => Promise<PlanCapabilityTables | undefined>;

  constructor(options: {
    readonly config: DockAutomationConfig;
    readonly projectionStore: ProjectionStore;
    readonly dockingAddress: Hex;
    readonly chainId: number;
    readonly routeSource?: DockRouteSource;
    readonly submitter?: DockAutomationSubmitter;
    readonly logger?: Logger;
    readonly now?: () => Date;
  }) {
    this.#config = options.config;
    this.#projectionStore = options.projectionStore;
    this.#dockingAddress = options.dockingAddress;
    this.#chainId = options.chainId;
    this.#routeSource = options.routeSource;
    this.#submitter = options.submitter;
    this.#logger = options.logger ?? noopLogger;
    this.#now = options.now ?? (() => new Date());
    this.#resolvePlanTables = resolvePlanCapabilityTablesFromStore(options.projectionStore);
  }

  async start(): Promise<void> {
    if (!this.#config.enabled || this.#running) {
      return;
    }
    // enabled 但 routeSource/submitter 未装配：runOnce 的候选扫描恒归零，
    // keeper 永远不会提交任何交易——不启动空转轮询，也不宣称 started，
    // 响亮声明装配缺口（交付形态当前就是未装配，见 api/server.ts）。
    if (!this.#routeSource || !this.#submitter) {
      this.#logger.warn(
        "dock automation is enabled but no route source/submitter is wired; the keeper stays idle until the assembly provides them"
      );
      return;
    }
    this.#running = true;
    this.#timer = setInterval(() => {
      void this.runOnce().catch((error) => {
        this.#logger.warn(`dock automation run failed: ${redactErrorMessage(error)}`);
      });
    }, this.#config.pollIntervalMs);
    this.#timer.unref?.();
    this.#logger.info("dock automation worker started");
  }

  async stop(): Promise<void> {
    if (!this.#running) {
      return;
    }
    this.#running = false;
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    this.#logger.info("dock automation worker stopped");
  }

  getLastSummary(): DockAutomationRunSummary | undefined {
    return this.#lastSummary;
  }

  async runOnce(): Promise<DockAutomationRunSummary> {
    const empty: DockAutomationRunSummary = {
      scannedRoutes: 0,
      scannedDocks: 0,
      attachCandidates: 0,
      openCandidates: 0,
      inputCandidates: 0,
      outputCandidates: 0,
      submitted: 0,
      deduplicated: 0,
      skipped: []
    };
    if (!this.#config.enabled || this.#checking) {
      return empty;
    }
    this.#checking = true;
    try {
      this.#runPlanTables = new Map();
      const routes = (await this.#routeSource?.listRoutes()) ?? [];
      // fail-closed 前置：route 记录来自链下来源（云编译产物），keeper 只
      // 提交可从链上 committed 状态推导的数据——身份字段缺失/畸形即整轮
      // 响亮报错，不静默跳过（坏一条即来源可疑，静默会让"没跑"伪装成
      // "没问题"）。校验抛错上抛 runOnce（轮询由 interval 捕获记 warn）。
      routes.forEach((route, index) =>
        validateDockRouteRecord(route, this.#chainId, index)
      );
      const snapshot = await this.#projectionStore.getOrderSnapshot();
      const docks = Object.values(snapshot.stateMachineDocks).filter(
        (dock) => dock.chainId === this.#chainId
      );
      const summary: DockAutomationRunSummary = {
        scannedRoutes: routes.length,
        scannedDocks: docks.length,
        attachCandidates: 0,
        openCandidates: 0,
        inputCandidates: 0,
        outputCandidates: 0,
        submitted: 0,
        deduplicated: 0,
        skipped: []
      };
      if (routes.length === 0 || !this.#submitter) {
        this.#lastSummary = summary;
        return summary;
      }

      for (const route of routes) {
        if (summary.submitted >= this.#config.maxCandidatesPerRun) {
          break;
        }
        // dock 实例身份是 (routeId, localPlanId, localOrderId) 且模式钉死：
        // 同 plan 复用同一 routeId 时每个订单各有一个 dock 实例，忽略
        // localOrderId 会把 binding 提交到别的订单的实例上；routeId 公式
        // 不分模式，同一三元组在 new/existing 两模式下是两个实例，按
        // mode 收敛避免串到另一模式的实例。
        const dock = docks.find(
          (candidate) =>
            candidate.mode === route.orderMode &&
            candidate.routeId.toLowerCase() === route.routeId.toLowerCase() &&
            candidate.localPlanId.toLowerCase() === route.localPlanId.toLowerCase() &&
            candidate.localOrderId.toLowerCase() === route.localOrderId.toLowerCase()
        );

        if (!dock) {
          if (route.orderMode === "new") {
            // open 候选（new）：入口 hook 已 Ready + route 来源携带 calldata。
            if (
              route.openCalldata &&
              this.entranceHookReady(snapshot, route)
            ) {
              summary.openCandidates += 1;
              await this.#submitCalldata(
                route.openCalldata,
                summary,
                "open",
                // 去重键与实例身份同构（含 localOrderId）：同 route 不同订单
                // 的 open 各自独立，不得互相吃掉对方的广播窗口。
                `open:${this.#chainId}:${route.routeId.toLowerCase()}:${route.localPlanId.toLowerCase()}:${route.localOrderId.toLowerCase()}`
              );
            }
          } else if (
            route.attachCalldata &&
            this.attachEndpointsPresent(snapshot, route)
          ) {
            // attach 候选（existing）：挂接的链上前提是父单与目标单都已
            // 出生，投影侧唯一命中才放行——否则广播必 revert
            // （DockUnknownLocalOrder/DockUnknownTargetOrder）白烧 gas。
            summary.attachCandidates += 1;
            await this.#submitCalldata(
              route.attachCalldata,
              summary,
              "attach",
              // 去重键与 open 车道同构（含 localOrderId + 模式由路由分岔
              // 前置保证互斥）。
              `attach:${this.#chainId}:${route.routeId.toLowerCase()}:${route.localPlanId.toLowerCase()}:${route.localOrderId.toLowerCase()}`
            );
          }
          continue;
        }

        // input 候选（existing 专属）：new 模式链上只登记出生锚绑定且由
        // open 原子投递，submitDockedInput 对 new 模式无活面；existing 无
        // 出生锚，逐端口全量活交付。
        if (route.orderMode === "existing") {
          for (const binding of route.inputs) {
            if (summary.submitted >= this.#config.maxCandidatesPerRun) {
              break;
            }
            if (dock.inputDeliveries[binding.bindingHash.toLowerCase()]) {
              continue;
            }
            if (!this.inputHookReady(snapshot, route, binding.localHookId, dock.stateMachineAddress)) {
              continue;
            }
            summary.inputCandidates += 1;
            const data = encodeFunctionData({
              abi: dockingWriteAbi,
              functionName: "submitDockedInput",
              args: [dock.dockInstanceId, binding.localHookId, binding.bindingHash]
            });
            await this.#submitCalldata(
              data,
              summary,
              "input",
              `input:${dock.dockInstanceId.toLowerCase()}:${binding.bindingHash.toLowerCase()}`
            );
          }
        }

        // output 候选（两模式同构）：目标事实已写入投影且 binding 未投递。
        // attach 前已成立的目标输出在此重放回填；未成立时链上 revert
        // DockOutputNotReady，由最终性窗口重试，投影呈现事实后收敛。
        for (const binding of route.outputs) {
          if (summary.submitted >= this.#config.maxCandidatesPerRun) {
            break;
          }
          if (dock.outputDeliveries[binding.bindingHash.toLowerCase()]) {
            continue;
          }
          if (!this.targetFactExists(snapshot, route, binding.targetSourceId, binding.targetSignalId)) {
            continue;
          }
          summary.outputCandidates += 1;
          // submitDockedSignal 4.4 起携 attribution/selectorBinding 造证：
          // 镜像事实落在父单（localPlanId/localSourceId/localSignalId），
          // 词表按父 plan 解析；造证单源见 submissions/capability-proofs.ts。
          let proofs: DockedSignalProofs;
          try {
            proofs = await this.#dockedSignalProofs(dock.localPlanId, binding);
          } catch (error) {
            // 词表富集 failed = 词表状态未知：全零造证会把必拒的
            // InvalidSignalCapability 留到链上 revert 才暴露（白烧 gas）。
            // 跳过留痕，下轮富集恢复后自然续上。
            summary.skipped.push(`output:${redactErrorMessage(error)}`);
            continue;
          }
          const data = encodeFunctionData({
            abi: dockingWriteAbi,
            functionName: "submitDockedSignal",
            args: [dock.dockInstanceId, binding.bindingHash, proofs.attribution, proofs.selectorBinding]
          });
          await this.#submitCalldata(
            data,
            summary,
            "output",
            `output:${dock.dockInstanceId.toLowerCase()}:${binding.bindingHash.toLowerCase()}`
          );
        }
      }

      this.#lastSummary = summary;
      return summary;
    } finally {
      this.#checking = false;
    }
  }

  /**
   * 广播 + 最终性窗口去重：同一 key 在 redeliveryWindowMs 内已尝试过
   * （成败同占窗）则本轮跳过（计数 deduplicated，不静默）。
   */
  #submitCalldata(
    data: Hex,
    summary: DockAutomationRunSummary,
    label: string,
    dedupeKey: string
  ): Promise<void> {
    const submitter = this.#submitter;
    if (!submitter) {
      return Promise.resolve();
    }
    const nowMs = this.#now().getTime();
    const lastBroadcastAt = this.#lastBroadcastAt.get(dedupeKey);
    if (lastBroadcastAt !== undefined && nowMs - lastBroadcastAt < this.#config.redeliveryWindowMs) {
      summary.deduplicated += 1;
      return Promise.resolve();
    }
    this.#lastBroadcastAt.set(dedupeKey, nowMs);
    return submitter
      .submit({
        to: this.#dockingAddress,
        data,
        ...(this.#config.maxGasPerTx ? { gas: this.#config.maxGasPerTx } : {})
      })
      .then(() => {
        summary.submitted += 1;
      })
      .catch((error) => {
        summary.skipped.push(`${label}:${redactErrorMessage(error)}`);
      });
  }

  #orderFor(
    snapshot: Awaited<ReturnType<ProjectionStore["getOrderSnapshot"]>>,
    planId: Hex,
    orderId: Hex,
    stateMachineAddress?: Hex
  ) {
    // 订单身份含 stateMachineAddress——裸 (chainId,planId,orderId)
    // 扫描在同号订单跨部署复用时会多命中；多命中 fail-closed 返回
    // undefined（对齐同仓不变量），绝不静默取首条。有 dock 上下文时按
    // 其状态机地址收敛。
    const matches = [...new Set(Object.values(snapshot.stateMachineOrders))].filter(
      (candidate) =>
        candidate.chainId === this.#chainId &&
        candidate.planId.toLowerCase() === planId.toLowerCase() &&
        candidate.orderId.toLowerCase() === orderId.toLowerCase() &&
        (!stateMachineAddress ||
          candidate.contractAddress.toLowerCase() === stateMachineAddress.toLowerCase())
    );
    return matches.length === 1 ? matches[0] : undefined;
  }

  entranceHookReady(    snapshot: Awaited<ReturnType<ProjectionStore["getOrderSnapshot"]>>,
    route: DockRouteRecord
  ): boolean {
    // new 模式恰一条 input 绑定（出生锚），其本地 hook 即 entrance。
    const entranceHookId = route.inputs[0]?.localHookId;
    if (!entranceHookId) {
      return false;
    }
    const order = this.#orderFor(snapshot, route.localPlanId, route.localOrderId);
    return order?.hooks[entranceHookId.toLowerCase()]?.status === "ready";
  }

  /** attach 就绪门：父单与目标单都已 birth 在投影中（裸 (planId,orderId)
   * 跨部署多命中时 #orderFor fail-closed 返回 undefined，不猜）。 */
  attachEndpointsPresent(
    snapshot: Awaited<ReturnType<ProjectionStore["getOrderSnapshot"]>>,
    route: DockRouteRecord
  ): boolean {
    return Boolean(
      this.#orderFor(snapshot, route.localPlanId, route.localOrderId) &&
      this.#orderFor(snapshot, route.targetPlanId, route.linkedOrderId)
    );
  }

  /**
   * submitDockedSignal 的镜像事实造证：attribution 证本地事实键
   * (localSourceId, localSignalId) 在父 plan 词表内的成员资格与属主阶段，
   * selectorBinding 按属主阶段携绑定叶 proof（与 submissions 车道的
   * resolveSubmissionCapabilityProofs 同口径：词表外/无词表 → 全零由链上
   * 词表闸裁决；富集 failed → 抛错由调用方跳过留痕）。
   */
  async #dockedSignalProofs(
    localPlanId: Hex,
    binding: DockRouteOutputBinding
  ): Promise<DockedSignalProofs> {
    const planKey = localPlanId.toLowerCase();
    let tables: PlanCapabilityTables | undefined;
    if (this.#runPlanTables.has(planKey)) {
      tables = this.#runPlanTables.get(planKey);
    } else {
      tables = await this.#resolvePlanTables(localPlanId);
      this.#runPlanTables.set(planKey, tables);
    }
    const effectiveTables = tables ?? EMPTY_PLAN_CAPABILITY_TABLES;
    const attribution = factAttributionPayload(effectiveTables, binding.localSourceId, binding.localSignalId);
    if (attribution.stageId === CAPABILITY_ZERO_BYTES32) {
      return { attribution, selectorBinding: zeroSelectorBinding() };
    }
    return {
      attribution,
      selectorBinding: selectorBindingForTargetStage(effectiveTables, attribution.stageId)
    };
  }

  inputHookReady(
    snapshot: Awaited<ReturnType<ProjectionStore["getOrderSnapshot"]>>,
    route: DockRouteRecord,
    localHookId: Hex,
    stateMachineAddress?: Hex
  ): boolean {
    const order = this.#orderFor(snapshot, route.localPlanId, route.localOrderId, stateMachineAddress);
    return order?.hooks[localHookId.toLowerCase()]?.status === "ready";
  }

  targetFactExists(
    snapshot: Awaited<ReturnType<ProjectionStore["getOrderSnapshot"]>>,
    route: DockRouteRecord,
    targetSourceId: Hex,
    targetSignalId: Hex
  ): boolean {
    const linkedOrder = this.#orderFor(snapshot, route.targetPlanId, route.linkedOrderId);
    return Boolean(
      linkedOrder?.signals[`${targetSourceId.toLowerCase()}:${targetSignalId.toLowerCase()}`]
    );
  }
}

const NON_ZERO_BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";
const CALLDATA_LIKE = /^0x(?:[0-9a-fA-F]{2})+$/;

/**
 * route 来源记录的 fail-closed 校验。
 * route 数据是链下编译产物（DockRouteSource 由云侧实现），keeper 只提交
 * 可由链上 committed 投影推导的就绪性——记录本身的身份字段必须完整且
 * 形状合法：缺字段/零值/跨链记录/开仓与挂接载荷缺失（openCalldata/
 * attachCalldata 是各自模式的唯一交易载荷）即抛错，不静默跳过。抛错即
 * 响亮失败：runOnce 上抛（轮询由 interval 捕获记 warn、运维可见），
 * 绝不带着可疑数据继续提交。
 */
function validateDockRouteRecord(
  route: DockRouteRecord,
  workerChainId: number,
  index: number
): void {
  const at = `dock route source routes[${index}]`;
  const requireBytes32 = (value: unknown, field: string): Hex => {
    if (typeof value !== "string" || !NON_ZERO_BYTES32.test(value) || value === ZERO_BYTES32) {
      throw new Error(`${at}.${field} must be a non-zero bytes32 hex identity, got ${String(value)}`);
    }
    return value as Hex;
  };
  if (route.chainId !== workerChainId) {
    throw new Error(`${at}.chainId ${String(route.chainId)} does not match the keeper chain ${String(workerChainId)}`);
  }
  requireBytes32(route.localPlanId, "localPlanId");
  requireBytes32(route.localOrderId, "localOrderId");
  requireBytes32(route.targetPlanId, "targetPlanId");
  requireBytes32(route.linkedOrderId, "linkedOrderId");
  requireBytes32(route.routeId, "routeId");
  requireBytes32(route.routeHash, "routeHash");
  if (typeof route.interfaceName !== "string" || route.interfaceName.trim().length === 0) {
    throw new Error(`${at}.interfaceName must be a non-empty string`);
  }
  if (route.orderMode !== "new" && route.orderMode !== "existing") {
    throw new Error(`${at}.orderMode must be "new" or "existing", got ${String(route.orderMode)}`);
  }
  if (!Array.isArray(route.inputs) || !Array.isArray(route.outputs)) {
    throw new Error(`${at}.inputs/outputs must be arrays`);
  }
  route.inputs.forEach((binding, bindingIndex) => {
    const bindingAt = `${at}.inputs[${bindingIndex}]`;
    requireBytes32(binding.bindingHash, `${bindingAt}.bindingHash`);
    requireBytes32(binding.localHookId, `${bindingAt}.localHookId`);
    requireBytes32(binding.targetSourceId, `${bindingAt}.targetSourceId`);
    requireBytes32(binding.targetSignalId, `${bindingAt}.targetSignalId`);
  });
  route.outputs.forEach((binding, bindingIndex) => {
    const bindingAt = `${at}.outputs[${bindingIndex}]`;
    requireBytes32(binding.bindingHash, `${bindingAt}.bindingHash`);
    requireBytes32(binding.localSourceId, `${bindingAt}.localSourceId`);
    requireBytes32(binding.localSignalId, `${bindingAt}.localSignalId`);
    requireBytes32(binding.targetSourceId, `${bindingAt}.targetSourceId`);
    requireBytes32(binding.targetSignalId, `${bindingAt}.targetSignalId`);
  });
  if (route.orderMode === "new") {
    // new 模式：entrance 绑定（inputs[0]）是出生锚，openCalldata 是
    // openDockedOrder 的唯一载荷（route 来源预组装、含 publisher permit）。
    // 两者任一缺失，该 route 永远无法开仓——来源装配缺口必须响亮暴露。
    if (route.inputs.length === 0) {
      throw new Error(`${at}: new-mode route must carry the entrance input binding`);
    }
    if (
      typeof route.openCalldata !== "string" ||
      !CALLDATA_LIKE.test(route.openCalldata) ||
      route.openCalldata.length <= 2
    ) {
      throw new Error(`${at}.openCalldata must be pre-assembled calldata hex for a new-mode route`);
    }
  } else {
    // existing 模式对位：attachCalldata 是 attachDockedOrder 的唯一载荷
    //（同意门的 publisher attach 预授权腿在 calldata 内预组装）。缺失即
    // 该 route 永远无法经 keeper 挂接——装配缺口响亮暴露，不静默跳过。
    if (
      typeof route.attachCalldata !== "string" ||
      !CALLDATA_LIKE.test(route.attachCalldata) ||
      route.attachCalldata.length <= 2
    ) {
      throw new Error(`${at}.attachCalldata must be pre-assembled calldata hex for an existing-mode route`);
    }
  }
}
