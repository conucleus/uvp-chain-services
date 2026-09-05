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
 * - open：route 来源携带预组装的 openDockedOrder calldata（permit 路由
 *   必须已含 publisher 签名）；仅当投影中入口 hook 已 Ready 且该 route
 *   尚无 dock 实例时提交。
 * - input：父订单 hook Ready 且 binding 未投递 → submitDockedInput。
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
   * 最终性窗口去重：key → 最近一次成功广播时刻。投影要等
   * 链事件 finalize+索引后才呈现 delivery，窗口内逐轮重发同一 binding 是
   * 纯 gas 浪费的 no-op 交易；窗口过后仍未投递才允许重试（覆盖交易
   * 丢失）。进程内状态即可：keeper 是单实例写者。
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
        const dock = docks.find(
          (candidate) =>
            candidate.routeId.toLowerCase() === route.routeId.toLowerCase() &&
            candidate.localPlanId.toLowerCase() === route.localPlanId.toLowerCase()
        );

        if (!dock) {
          // open 候选：open 策略 + 入口 hook 已 Ready + route 来源携带 calldata。
          if (
            route.accessPolicy === "open" &&
            route.openCalldata &&
            this.entranceHookReady(snapshot, route)
          ) {
            summary.openCandidates += 1;
            await this.#submitCalldata(
              route.openCalldata,
              summary,
              "open",
              `open:${this.#chainId}:${route.routeId.toLowerCase()}:${route.localPlanId.toLowerCase()}`
            );
          }
          continue;
        }

        if (dock.status !== "open") {
          continue;
        }

        // input 候选：父 hook Ready 且事件投影中未见投递。
        for (const binding of route.inputs) {
          if (summary.submitted >= this.#config.maxCandidatesPerRun) {
            break;
          }
          if (binding.kind !== "signal") {
            continue;
          }
          if (dock.inputDeliveries[binding.bindingHash.toLowerCase()]) {
            continue;
          }
          if (!this.inputHookReady(snapshot, route, binding.localHookId)) {
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
   * 广播 + 最终性窗口去重：同一 key 在 redeliveryWindowMs 内
   * 已成功广播过则本轮跳过（计数 deduplicated，不静默）；窗口过后投影
   * 仍未呈现 delivery 才会重试，覆盖交易丢失的情形。
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
    return submitter
      .submit({
        to: this.#dockingAddress,
        data,
        ...(this.#config.maxGasPerTx ? { gas: this.#config.maxGasPerTx } : {})
      })
      .then(() => {
        this.#lastBroadcastAt.set(dedupeKey, this.#now().getTime());
        summary.submitted += 1;
      })
      .catch((error) => {
        summary.skipped.push(`${label}:${redactErrorMessage(error)}`);
      });
  }

  #orderFor(
    snapshot: Awaited<ReturnType<ProjectionStore["getOrderSnapshot"]>>,
    planId: Hex,
    orderId: Hex
  ) {
    return [...new Set(Object.values(snapshot.stateMachineOrders))].find(
      (candidate) =>
        candidate.chainId === this.#chainId &&
        candidate.planId.toLowerCase() === planId.toLowerCase() &&
        candidate.orderId.toLowerCase() === orderId.toLowerCase()
    );
  }

  entranceHookReady(
    snapshot: Awaited<ReturnType<ProjectionStore["getOrderSnapshot"]>>,
    route: DockRouteRecord
  ): boolean {
    const order = this.#orderFor(snapshot, route.localPlanId, route.localOrderId);
    return order?.hooks[route.entranceHookId.toLowerCase()]?.status === "ready";
  }

  inputHookReady(
    snapshot: Awaited<ReturnType<ProjectionStore["getOrderSnapshot"]>>,
    route: DockRouteRecord,
    localHookId: Hex
  ): boolean {
    const order = this.#orderFor(snapshot, route.localPlanId, route.localOrderId);
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
