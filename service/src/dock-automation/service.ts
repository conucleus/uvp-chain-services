import { encodeFunctionData, type Abi } from "viem";
import { DOCKING_MODULE_ABI } from "@uvp-eth/protocol-bindings";
import type { ProjectionStore } from "../storage/projection-store.js";
import { noopLogger, type Hex, type LifecycleService, type Logger } from "../shared/types.js";
import { redactErrorMessage } from "../security/redaction.js";
import {
  factAttributionPayload,
  resolvePlanCapabilityTablesFromStore,
  ZERO_BYTES32 as CAPABILITY_ZERO_BYTES32,
  type BuiltFactAttribution,
  type PlanCapabilityTables
} from "../submissions/capability-proofs.js";
import type {
  DockAutomationConfig,
  DockAutomationRunSummary,
  DockAutomationSubmitter,
  DockRouteInputBinding,
  DockRouteOutputBinding,
  DockRouteRecord,
  DockRouteSource
} from "./types.js";

interface DockedSignalProofs {
  readonly attribution: BuiltFactAttribution;
}

const dockingWriteAbi: Abi = (DOCKING_MODULE_ABI as Abi).filter(
  (entry) =>
    entry.type === "function" &&
    (entry.name === "submitDockedInput" || entry.name === "submitDockedSignal")
);

const EMPTY_PLAN_CAPABILITY_TABLES: PlanCapabilityTables = {
  selectorBindings: [],
  signalCapabilities: []
};

// Dock liveness worker：attach/open/input/output 四车道候选发现完全来自
// 投影 + route 来源，keeper 不发明任何协议 word；未配置 routeSource/
// submitter 时 runOnce 为显式 no-op，便于仅索引部署共享同一装配。
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
  readonly #lastBroadcastAt = new Map<string, number>();
  readonly #terminalRevertWindows = new Map<string, { readonly reason: string; windows: number }>();
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
    if (!this.#routeSource || !this.#submitter) {
      this.#logger.warn(
        "dock automation is enabled but no route source/submitter is wired; the keeper stays idle until the assembly provides them"
      );
      return;
    }
    this.#running = true;
    if (this.#config.pollIntervalMs <= 0) {
      this.#logger.warn(
        "dock automation polling is disabled (UVP_DOCK_AUTOMATION_POLL_INTERVAL_MS<=0): no route candidate will ever be delivered until the interval is positive"
      );
      return;
    }
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
      attempted: 0,
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
      routes.forEach((route, index) =>
        validateDockRouteRecord(route, this.#chainId, index)
      );
      const snapshot = await this.#projectionStore.getOrderSnapshot();
      const syncState = await this.#projectionStore.getSyncState();
      const finalizedBlock = syncState?.finalizedBlock;
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
        attempted: 0,
        submitted: 0,
        deduplicated: 0,
        skipped: []
      };
      if (finalizedBlock === undefined || syncState?.syncStatus === "rebuilding") {
        summary.skipped.push(
          finalizedBlock === undefined
            ? "finality: projection sync state carries no finalizedBlock; no dock candidate is released this run"
            : "finality: projection rebuild is in progress; no dock candidate is released this run"
        );
        this.#lastSummary = summary;
        return summary;
      }
      const touchedDedupeKeys = new Set<string>();
      if (routes.length === 0 || !this.#submitter) {
        this.#evictStaleTracking(touchedDedupeKeys, this.#now().getTime());
        this.#lastSummary = summary;
        return summary;
      }

      for (const route of routes) {
        if (summary.attempted >= this.#config.maxCandidatesPerRun) {
          break;
        }
        const dock = docks.find(
          (candidate) =>
            candidate.mode === route.orderMode &&
            candidate.routeId.toLowerCase() === route.routeId.toLowerCase() &&
            candidate.localPlanId.toLowerCase() === route.localPlanId.toLowerCase() &&
            candidate.localOrderId.toLowerCase() === route.localOrderId.toLowerCase()
        );

        if (!dock) {
          if (route.orderMode === "new") {
            if (
              route.openCalldata &&
              this.entranceHookReady(snapshot, route, finalizedBlock)
            ) {
              summary.openCandidates += 1;
              await this.#submitCalldata(
                route.openCalldata,
                summary,
                "open",
                `open:${this.#chainId}:${route.routeId.toLowerCase()}:${route.localPlanId.toLowerCase()}:${route.localOrderId.toLowerCase()}`,
                undefined,
                touchedDedupeKeys
              );
            }
          } else if (!route.attachCalldata) {
            summary.skipped.push(
              `attach:route ${route.routeId} carries no pre-assembled attachCalldata; the keeper attach lane is skipped (permissionless attach belongs to the consent-gate principals)`
            );
          } else if (this.attachEndpointsPresent(snapshot, route)) {
            summary.attachCandidates += 1;
            await this.#submitCalldata(
              route.attachCalldata,
              summary,
              "attach",
              `attach:${this.#chainId}:${route.routeId.toLowerCase()}:${route.localPlanId.toLowerCase()}:${route.localOrderId.toLowerCase()}`,
              undefined,
              touchedDedupeKeys
            );
          }
          continue;
        }

        if (route.orderMode === "existing") {
          for (const binding of route.inputs) {
            if (summary.attempted >= this.#config.maxCandidatesPerRun) {
              break;
            }
            if (dock.inputDeliveries[binding.bindingHash.toLowerCase()]) {
              continue;
            }
            if (!this.inputHookReady(snapshot, route, binding.localHookId, dock.stateMachineAddress, finalizedBlock)) {
              continue;
            }
            if (
              this.targetFactExists(
                snapshot,
                route,
                binding.targetSourceId,
                binding.targetSignalId,
                dock.stateMachineAddress,
                finalizedBlock
              )
            ) {
              summary.skipped.push(
                `input:${dock.dockInstanceId}:${binding.bindingHash}:target fact slot (${binding.targetSourceId},${binding.targetSignalId}) is already occupied; submitDockedInput would revert DockInputConflict permanently`
              );
              continue;
            }
            summary.inputCandidates += 1;
            let inputAttribution: BuiltFactAttribution;
            try {
              inputAttribution = await this.#dockedInputAttribution(route.targetPlanId, binding);
            } catch (error) {
              summary.skipped.push(`input:${redactErrorMessage(error)}`);
              continue;
            }
            const data = encodeFunctionData({
              abi: dockingWriteAbi,
              functionName: "submitDockedInput",
              args: [
                dock.dockInstanceId,
                binding.localHookId,
                binding.bindingHash,
                inputAttribution
              ]
            });
            await this.#submitCalldata(
              data,
              summary,
              "input",
              `input:${dock.dockInstanceId.toLowerCase()}:${binding.bindingHash.toLowerCase()}`,
              { dockInstanceId: dock.dockInstanceId, bindingHash: binding.bindingHash },
              touchedDedupeKeys
            );
          }
        }

        for (const binding of route.outputs) {
          if (summary.attempted >= this.#config.maxCandidatesPerRun) {
            break;
          }
          if (dock.outputDeliveries[binding.bindingHash.toLowerCase()]) {
            continue;
          }
          if (
            !this.targetFactExists(
              snapshot,
              route,
              binding.targetSourceId,
              binding.targetSignalId,
              dock.stateMachineAddress,
              finalizedBlock
            )
          ) {
            continue;
          }
          summary.outputCandidates += 1;
          let proofs: DockedSignalProofs;
          try {
            proofs = await this.#dockedSignalProofs(dock.localPlanId, binding);
          } catch (error) {
            summary.skipped.push(`output:${redactErrorMessage(error)}`);
            continue;
          }
          const data = encodeFunctionData({
            abi: dockingWriteAbi,
            functionName: "submitDockedSignal",
            args: [dock.dockInstanceId, binding.bindingHash, proofs.attribution]
          });
          await this.#submitCalldata(
            data,
            summary,
            "output",
            `output:${dock.dockInstanceId.toLowerCase()}:${binding.bindingHash.toLowerCase()}`,
            { dockInstanceId: dock.dockInstanceId, bindingHash: binding.bindingHash },
            touchedDedupeKeys
          );
        }
      }

      this.#evictStaleTracking(touchedDedupeKeys, this.#now().getTime());
      this.#lastSummary = summary;
      return summary;
    } finally {
      this.#checking = false;
    }
  }

  #evictStaleTracking(touchedDedupeKeys: ReadonlySet<string>, nowMs: number): void {
    const evictionHorizonMs = 4 * this.#config.redeliveryWindowMs;
    for (const [key, lastBroadcastAt] of this.#lastBroadcastAt) {
      if (!touchedDedupeKeys.has(key) || nowMs - lastBroadcastAt > evictionHorizonMs) {
        this.#lastBroadcastAt.delete(key);
        this.#terminalRevertWindows.delete(key);
      }
    }
  }

  #submitCalldata(
    data: Hex,
    summary: DockAutomationRunSummary,
    label: string,
    dedupeKey: string,
    binding?: { readonly dockInstanceId: Hex; readonly bindingHash: Hex },
    touchedDedupeKeys?: Set<string>
  ): Promise<void> {
    const submitter = this.#submitter;
    if (!submitter) {
      return Promise.resolve();
    }
    const nowMs = this.#now().getTime();
    const lastBroadcastAt = this.#lastBroadcastAt.get(dedupeKey);
    if (lastBroadcastAt !== undefined && nowMs - lastBroadcastAt < this.#config.redeliveryWindowMs) {
      summary.deduplicated += 1;
      touchedDedupeKeys?.add(dedupeKey);
      return Promise.resolve();
    }
    summary.attempted += 1;
    touchedDedupeKeys?.add(dedupeKey);
    this.#lastBroadcastAt.set(dedupeKey, nowMs);
    return submitter
      .submit({
        to: this.#dockingAddress,
        data,
        ...(this.#config.maxGasPerTx ? { gas: this.#config.maxGasPerTx } : {})
      })
      .then(() => {
        summary.submitted += 1;
        this.#terminalRevertWindows.delete(dedupeKey);
      })
      .catch((error) => {
        const message = redactErrorMessage(error);
        summary.skipped.push(`${label}:${message}`);
        const terminalReason = terminalRevertReasonOf(message);
        if (!binding || !terminalReason) {
          return;
        }
        const streak = this.#terminalRevertWindows.get(dedupeKey);
        const windows = streak && streak.reason === terminalReason ? streak.windows + 1 : 1;
        this.#terminalRevertWindows.set(dedupeKey, { reason: terminalReason, windows });
        if (windows < TERMINAL_REVERT_ESCALATION_WINDOWS) {
          return;
        }
        this.#logger.error(
          `dock ${label} binding has failed with a no-convergence revert for ${windows} consecutive redelivery windows; manual adjudication is required (correct the route source or resolve the fact-slot conflict)`,
          {
            dockInstanceId: binding.dockInstanceId,
            bindingHash: binding.bindingHash,
            reason: terminalReason,
            windows
          }
        );
      });
  }

  #orderFor(
    snapshot: Awaited<ReturnType<ProjectionStore["getOrderSnapshot"]>>,
    planId: Hex,
    orderId: Hex,
    stateMachineAddress?: Hex
  ) {
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

  entranceHookReady(
    snapshot: Awaited<ReturnType<ProjectionStore["getOrderSnapshot"]>>,
    route: DockRouteRecord,
    finalizedBlock: bigint
  ): boolean {
    const entranceHookId = route.inputs[0]?.localHookId;
    if (!entranceHookId) {
      return false;
    }
    const order = this.#orderFor(snapshot, route.localPlanId, route.localOrderId);
    const hook = order?.hooks[entranceHookId.toLowerCase()];
    return hook?.status === "ready" && hook.updatedAt.blockNumber <= finalizedBlock;
  }

  attachEndpointsPresent(
    snapshot: Awaited<ReturnType<ProjectionStore["getOrderSnapshot"]>>,
    route: DockRouteRecord
  ): boolean {
    const parentOrder = this.#orderFor(snapshot, route.localPlanId, route.localOrderId);
    if (!parentOrder) {
      return false;
    }
    return Boolean(
      this.#orderFor(snapshot, route.targetPlanId, route.linkedOrderId, parentOrder.contractAddress)
    );
  }

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
    return {
      attribution: factAttributionPayload(effectiveTables, binding.localSourceId, binding.localSignalId)
    };
  }

  async #dockedInputAttribution(
    targetPlanId: Hex,
    binding: DockRouteInputBinding
  ): Promise<BuiltFactAttribution> {
    const planKey = targetPlanId.toLowerCase();
    let tables: PlanCapabilityTables | undefined;
    if (this.#runPlanTables.has(planKey)) {
      tables = this.#runPlanTables.get(planKey);
    } else {
      tables = await this.#resolvePlanTables(targetPlanId);
      this.#runPlanTables.set(planKey, tables);
    }
    return factAttributionPayload(
      tables ?? EMPTY_PLAN_CAPABILITY_TABLES,
      binding.targetSourceId,
      binding.targetSignalId
    );
  }

  inputHookReady(
    snapshot: Awaited<ReturnType<ProjectionStore["getOrderSnapshot"]>>,
    route: DockRouteRecord,
    localHookId: Hex,
    stateMachineAddress: Hex | undefined,
    finalizedBlock: bigint
  ): boolean {
    const order = this.#orderFor(snapshot, route.localPlanId, route.localOrderId, stateMachineAddress);
    const hook = order?.hooks[localHookId.toLowerCase()];
    return hook?.status === "ready" && hook.updatedAt.blockNumber <= finalizedBlock;
  }

  targetFactExists(
    snapshot: Awaited<ReturnType<ProjectionStore["getOrderSnapshot"]>>,
    route: DockRouteRecord,
    targetSourceId: Hex,
    targetSignalId: Hex,
    stateMachineAddress: Hex | undefined,
    finalizedBlock: bigint
  ): boolean {
    const linkedOrder = this.#orderFor(snapshot, route.targetPlanId, route.linkedOrderId, stateMachineAddress);
    const signal = linkedOrder?.signals[`${targetSourceId.toLowerCase()}:${targetSignalId.toLowerCase()}`];
    return Boolean(
      signal && signal.submittedAt.blockNumber <= finalizedBlock
    );
  }
}

const NON_ZERO_BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";
const CALLDATA_LIKE = /^0x(?:[0-9a-fA-F]{2})+$/;

const NO_CONVERGENCE_REVERT = /DockInputConflict|InvalidSignalCapability/;

const TERMINAL_REVERT_ESCALATION_WINDOWS = 3;

function terminalRevertReasonOf(message: string): string | undefined {
  return NO_CONVERGENCE_REVERT.exec(message)?.[0];
}

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
