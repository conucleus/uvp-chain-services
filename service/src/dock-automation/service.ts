import { encodeFunctionData } from "viem";
import type { ProjectionStore } from "../storage/projection-store.js";
import { noopLogger, type Hex, type LifecycleService, type Logger } from "../shared/types.js";
import { redactErrorMessage } from "../security/redaction.js";
import type {
  DockAutomationConfig,
  DockAutomationRunSummary,
  DockAutomationSubmitter,
  DockRouteRecord,
  DockRouteSource
} from "./types.js";

/** UVPDockingModule v2 ABI（仅 keeper 写函数；事件投影在 indexer）。 */
const dockingWriteAbi = [
  {
    name: "submitDockedInput",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "dockInstanceId", type: "bytes32" },
      { name: "localHookId", type: "bytes32" },
      { name: "inputBindingHash", type: "bytes32" }
    ],
    outputs: [{ name: "submitted", type: "bool" }]
  },
  {
    name: "submitDockedSignal",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "dockInstanceId", type: "bytes32" },
      { name: "outputBindingHash", type: "bytes32" }
    ],
    outputs: [{ name: "submitted", type: "bool" }]
  }
] as const;

/**
 * Dock liveness worker（keeper 只提供活性）。
 *
 * 候选发现完全来自投影 + route 来源，keeper 不发明任何协议 word：
 * - open：仅 new 模式 route（链轨对 existing 显式拒绝）；route 来源携带
 *   预组装的 openDockedOrder calldata（permit 必须已含 publisher 签名）；
 *   仅当投影中入口 hook 已 Ready 且该 route 尚无 dock 实例时提交。
 * - input：父订单 hook Ready 且 binding 未投递 → submitDockedInput；
 *   entrance 绑定（new 模式的 inputs[0]）由 open 原子投递，跳过。
 * - output：子订单事实已在投影中且 binding 未投递 → submitDockedSignal。
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
        // 链轨只支持 new 模式（on-chain 编译期对 existing 响亮拒绝）；
        // 云轨 existing route 不经本 keeper。
        if (route.orderMode !== "new") {
          continue;
        }
        // dock 实例身份是 (routeId, localPlanId, localOrderId)：同 plan
        // 复用同一 routeId 时每个订单各有一个 dock 实例，忽略 localOrderId
        // 会把 binding 提交到别的订单的实例上。
        const dock = docks.find(
          (candidate) =>
            candidate.routeId.toLowerCase() === route.routeId.toLowerCase() &&
            candidate.localPlanId.toLowerCase() === route.localPlanId.toLowerCase() &&
            candidate.localOrderId.toLowerCase() === route.localOrderId.toLowerCase()
        );

        if (!dock) {
          // open 候选：new 模式 + 入口 hook 已 Ready + route 来源携带 calldata。
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
          continue;
        }

        // input 候选：父 hook Ready 且事件投影中未见投递；entrance 绑定
        // （new 模式的唯一 input）由 openDockedOrder 原子投递，不重发。
        for (const [bindingIndex, binding] of route.inputs.entries()) {
          if (summary.submitted >= this.#config.maxCandidatesPerRun) {
            break;
          }
          if (bindingIndex === 0) {
            continue;
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

        // output 候选：目标事实已写入投影且 binding 未投递。
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
          const data = encodeFunctionData({
            abi: dockingWriteAbi,
            functionName: "submitDockedSignal",
            args: [dock.dockInstanceId, binding.bindingHash]
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
 * route 来源记录的 fail-closed 校验（P2-2 B3，keeper 在役化前置）。
 * route 数据是链下编译产物（DockRouteSource 由云侧实现），keeper 只提交
 * 可由链上 committed 投影推导的就绪性——记录本身的身份字段必须完整且
 * 形状合法：缺字段/零值/跨链记录/openCalldata 缺失（new 模式开仓唯一
 * 载荷）即抛错，不静默跳过。抛错即响亮失败：runOnce 上抛（轮询由
 * interval 捕获记 warn、运维可见），绝不带着可疑数据继续提交。
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
  }
}
