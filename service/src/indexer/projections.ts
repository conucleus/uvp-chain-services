import { chainEventKey, filterActiveChainEvents, type ChainEvent } from "./events.js";
import {
  ProjectionError,
  normalizeAddress,
  normalizeBytes32,
  compareChainPointers,
  type Address,
  type ChainPointer,
  type Hex
} from "../shared/types.js";
import {
  EXECUTOR_PATCH_MODE_ASSIGN,
  EXECUTOR_PATCH_MODE_HANDOFF,
  EXECUTOR_PATCH_MODE_REPLACEMENT
} from "../shared/protocol-constants.js";

export type OrderStatus = "registered";
export type StageStatus = "approved" | "released" | "refunded" | "disputed" | "resolved";

export interface ProjectionProvenance {
  readonly chainId: number;
  readonly contractAddress: Address;
  readonly blockNumber: bigint;
  readonly transactionIndex?: number;
  readonly transactionHash: Hex;
  readonly logIndex: number;
}

export interface StageProjection {
  readonly orderId: string;
  readonly stageId: string;
  readonly status: StageStatus;
  readonly signal?: string;
  readonly evidenceHash?: Hex;
  readonly signer?: Address;
  readonly updatedAt: ProjectionProvenance;
}

export interface OrderProjection {
  readonly orderId: string;
  readonly chainId: number;
  readonly contractAddress: Address;
  readonly status: OrderStatus;
  readonly buyer?: Address;
  readonly seller?: Address;
  readonly zhixuHash?: Hex;
  readonly metadataHash?: Hex;
  readonly createdAt?: ProjectionProvenance;
  readonly updatedAt: ProjectionProvenance;
  readonly stages: Readonly<Record<string, StageProjection>>;
}

export type StateMachineOrderStatus = "registered" | "unknown";
export type StateMachineHookStatus = "init" | "waiting" | "ready" | "cancelled" | "unknown";
export type StateMachineTaskStatus = "ready" | "submitted" | "cancelled" | "unknown";
export type StateMachineDeploymentStatus =
  | "candidate"
  | "canary"
  | "active"
  | "deprecated"
    | "retired"
    | "unknown";
export type StateMachineStageExecutorPatchMode = "assign" | "handoff" | "replacement";

export interface StateMachineProofProjection extends ProjectionProvenance {
  readonly eventId: string;
  readonly eventName: string;
  readonly args: EventProofArgs;
  readonly blockHash?: Hex;
  readonly orderId?: Hex;
  readonly planId?: Hex;
  readonly planHash?: Hex;
  readonly submitter?: Address;
}

export type EventProofArgs = Readonly<Record<string, string | number | boolean | null>>;

export interface StateMachinePlanProjection {
  readonly planId: Hex;
  readonly deploymentId?: Hex;
  readonly stateMachineAddress: Address;
  readonly planHash: Hex;
  readonly hookCount: string;
  readonly publisher?: Address;
  /**
   * Commit-phase facts (PlanCommitted). The contract publishes plans in two
   * steps: commitPlan emits PlanCommitted + PlanPublisherRecorded, finalizePlan
   * calls the metadata module (module events with lower logIndex) and then
   * emits PlanFinalized + PlanRegistered. The bucket is created at commit so
   * the finalize-transaction module events always find their plan.
   */
  readonly hooksHash?: Hex;
  readonly metadataHash?: Hex;
  readonly dockRoutesRoot?: Hex;
  readonly dockInterfaceRoot?: Hex;
  readonly committedAt?: ProjectionProvenance;
  readonly finalizedAt?: ProjectionProvenance;
  readonly selectorBindings: readonly StateMachineStageSelectorBindingProjection[];
  readonly signalCapabilities: readonly StateMachineSignalCapabilityProjection[];
  /**
   * Commit provenance until PlanRegistered arrives, finalize provenance after.
   * Consumers that need to distinguish the phases read committedAt/finalizedAt.
   */
  readonly registeredAt: ProjectionProvenance;
  readonly publisherRecordedAt?: ProjectionProvenance;
  readonly updatedAt: ProjectionProvenance;
  readonly proof: StateMachineProofProjection;
  readonly publisherProof?: StateMachineProofProjection;
  readonly commitProof?: StateMachineProofProjection;
  readonly finalizationProof?: StateMachineProofProjection;
}

export interface StateMachineStageSelectorBindingProjection {
  readonly selectorStageIdentifier?: string;
  readonly targetStageIdentifier?: string;
  readonly selectorStageId: Hex;
  readonly targetStageId: Hex;
  readonly bindingHash?: Hex;
}

export type StateMachineSignalTargetRelation = "current" | "triggerOrigin" | "unknown";

export interface StateMachineSignalCapabilityProjection {
  readonly stageId: Hex;
  readonly targetSourceId: Hex;
  readonly signalId: Hex;
  readonly targetOrderRelation: StateMachineSignalTargetRelation;
  readonly registeredAt: ProjectionProvenance;
  readonly proof: StateMachineProofProjection;
}

export interface StateMachineSignalProjection {
  readonly orderId: Hex;
  readonly sourceId: Hex;
  readonly signalId: Hex;
  readonly payloadHash: Hex;
  readonly idempotencyKey: Hex;
  readonly submitter: Address;
  readonly submittedAt: ProjectionProvenance;
  readonly proof: StateMachineProofProjection;
}

export interface StateMachineSignalAuthorizationProjection {
  readonly orderId: Hex;
  readonly sourceId: Hex;
  readonly signalId: Hex;
  readonly submitter: Address;
  readonly role: Hex;
  readonly metadataHash: Hex;
  readonly authorizedAt: ProjectionProvenance;
  readonly proof: StateMachineProofProjection;
}

/**
 * StageExecutorSignalDelegated 事实：delegateStageExecutorSignalFromModule 在
 * 链上把 (sourceId, signalId) 的提交权委派给 executor，并显式携带
 * targetStageId——这是词表外授权唯一的链上阶段绑定。任务投影用它把授权
 * 信号挂到对应阶段的任务上（见 refreshTaskSubmitSignals）。
 */
export interface StateMachineSignalDelegationProjection {
  readonly orderId: Hex;
  readonly targetStageId: Hex;
  readonly sourceId: Hex;
  readonly signalId: Hex;
  readonly executor: Address;
  readonly roleHash: Hex;
  readonly metadataHash: Hex;
  readonly patchNonce: string;
  readonly delegatedAt: ProjectionProvenance;
  readonly proof: StateMachineProofProjection;
}

export interface StateMachineStageExecutorOverlayProjection {
  readonly orderId: Hex;
  readonly selectorStageId: Hex;
  readonly targetStageId: Hex;
  readonly selectorWallet: Address;
  readonly activeExecutorWallet: Address;
  readonly mode: StateMachineStageExecutorPatchMode;
  readonly modeHash?: Hex;
  readonly previousExecutor?: Address;
  readonly approvalSourceId?: Hex;
  readonly approvalSignalId?: Hex;
  readonly roleHash: Hex;
  readonly executorMetadataHash: Hex;
  readonly patchHash: Hex;
  readonly patchNonce: string;
  readonly metadataURI: string;
  readonly updatedAt: ProjectionProvenance;
  readonly activatedAt?: ProjectionProvenance;
  readonly proof: StateMachineProofProjection;
  readonly activationProof?: StateMachineProofProjection;
}

export interface StateMachineStageResourceOverlayProjection {
  readonly orderId: Hex;
  readonly selectorStageId: Hex;
  readonly targetStageId: Hex;
  readonly resourceKey: Hex;
  readonly selectorWallet: Address;
  readonly manifestHash: Hex;
  readonly policyHash: Hex;
  readonly patchHash: Hex;
  readonly patchNonce: string;
  readonly manifestURI: string;
  readonly updatedAt: ProjectionProvenance;
  readonly proof: StateMachineProofProjection;
}

/**
 * uvp.dock.v1 统一委托协议投影。dock 实例身份由
 * dockInstanceId 唯一确定（哈希 preimage 覆盖双方 plan/order/route），
 * 投影键为 (chainId, stateMachineAddress, dockInstanceId)；binding 细节
 * （portKey/localHookId/kind/terminal 全量 word）来自 DockingModule
 * 事件可见字段，事件不携带的补全由 keeper 通过 lens 视图按需读取。
 */
export type StateMachineDockStatus = "open" | "terminal";

export interface StateMachineDockInputDeliveryProjection {
  readonly inputBindingHash: Hex;
  readonly localPlanId: Hex;
  readonly localOrderId: Hex;
  readonly targetPlanId: Hex;
  readonly linkedOrderId: Hex;
  readonly targetSignalId: Hex;
  readonly payloadHash: Hex;
  readonly submitter: Address;
  readonly deliveredAt: ProjectionProvenance;
  readonly proof: StateMachineProofProjection;
}

export interface StateMachineDockOutputDeliveryProjection {
  readonly outputBindingHash: Hex;
  readonly localPlanId: Hex;
  readonly localOrderId: Hex;
  readonly targetPlanId: Hex;
  readonly linkedOrderId: Hex;
  readonly targetSignalId: Hex;
  readonly localSignalId: Hex;
  readonly payloadHash: Hex;
  readonly submitter: Address;
  readonly deliveredAt: ProjectionProvenance;
  readonly proof: StateMachineProofProjection;
}

export interface StateMachineDockProjection {
  readonly dockInstanceId: Hex;
  readonly chainId: number;
  readonly stateMachineAddress: Address;
  readonly localPlanId: Hex;
  readonly localOrderId: Hex;
  readonly routeId: Hex;
  readonly routeHash: Hex;
  readonly targetPlanId: Hex;
  readonly linkedOrderId: Hex;
  readonly depth: number;
  readonly opener: Address;
  readonly status: StateMachineDockStatus;
  readonly inputDeliveries: Readonly<Record<string, StateMachineDockInputDeliveryProjection>>;
  readonly outputDeliveries: Readonly<Record<string, StateMachineDockOutputDeliveryProjection>>;
  readonly openedAt: ProjectionProvenance;
  readonly terminalAt?: ProjectionProvenance;
  readonly terminalCode?: number;
  readonly updatedAt: ProjectionProvenance;
  readonly proof: StateMachineProofProjection;
  readonly terminalProof?: StateMachineProofProjection;
}

export interface StateMachineOrderTriggerLinkProjection {
  readonly triggeredOrderId: Hex;
  readonly triggerOriginOrderId: Hex;
  readonly triggerStageId: Hex;
  readonly originSourceId: Hex;
  readonly originSignalId: Hex;
  readonly linkedAt: ProjectionProvenance;
  readonly proof: StateMachineProofProjection;
}

export interface StateMachineHookProjection {
  readonly orderId: Hex;
  readonly hookId: Hex;
  readonly stageIdentifier?: Hex;
  readonly hookName?: Hex;
  readonly status: StateMachineHookStatus;
  readonly dueAt?: string;
  readonly updatedAt: ProjectionProvenance;
  readonly readyAt?: ProjectionProvenance;
  readonly proof: StateMachineProofProjection;
}

export interface StateMachineTaskProjection {
  readonly taskId: string;
  readonly orderId: Hex;
  readonly stateMachineAddress: Address;
  /**
   * Stable API-facing identifier (hook/order), while the projection itself is
   * plan-scoped.  Keeping the plan id on the flattened row lets consumers join
   * a task back to the right order when two plans intentionally reuse the same
   * orderId and hookId.
   */
  readonly planId?: Hex;
  readonly deploymentId?: Hex;
  readonly hookId: Hex;
  readonly stageIdentifier: Hex;
  readonly hookName: Hex;
  readonly assigneeRole: string;
  readonly assigneeWallet?: Address;
  readonly assigneeRoleHash?: Hex;
  readonly authorizationMetadataHash?: Hex;
  readonly status: StateMachineTaskStatus;
  readonly submitSignals?: readonly StateMachineTaskSubmitSignalProjection[];
  readonly createdAt: ProjectionProvenance;
  readonly updatedAt: ProjectionProvenance;
  readonly proof: StateMachineProofProjection;
}

export interface StateMachineTaskSubmitSignalProjection {
  readonly sourceId: Hex;
  readonly signalId: Hex;
  readonly source: "plan_capability" | "authorization";
}

export interface StateMachineTimelineEventProjection {
  readonly timelineId: string;
  readonly orderId?: Hex;
  readonly planId?: Hex;
  readonly eventName: string;
  readonly text: string;
  readonly time: string;
  readonly proof: StateMachineProofProjection;
}

export interface StateMachineOrderProjection {
  readonly orderId: Hex;
  readonly chainId: number;
  readonly contractAddress: Address;
  readonly deploymentId?: Hex;
  readonly planId: Hex;
  readonly planHash?: Hex;
  readonly status: StateMachineOrderStatus;
  readonly currentStage?: Hex;
  /** OrderRelayerRecorded 事实：订单中继方与创建者。 */
  readonly relayer?: Address;
  readonly creator?: Address;
  readonly authorizations: Readonly<Record<string, StateMachineSignalAuthorizationProjection>>;
  readonly signals: Readonly<Record<string, StateMachineSignalProjection>>;
  readonly signalDelegations: Readonly<Record<string, StateMachineSignalDelegationProjection>>;
  readonly stageExecutorOverlays: Readonly<Record<string, StateMachineStageExecutorOverlayProjection>>;
  readonly stageResourceOverlays: Readonly<Record<string, StateMachineStageResourceOverlayProjection>>;
  readonly triggerLink?: StateMachineOrderTriggerLinkProjection;
  readonly hooks: Readonly<Record<string, StateMachineHookProjection>>;
  readonly tasks: Readonly<Record<string, StateMachineTaskProjection>>;
  readonly timeline: readonly StateMachineTimelineEventProjection[];
  readonly proof: readonly StateMachineProofProjection[];
  readonly registeredAt?: ProjectionProvenance;
  readonly updatedAt: ProjectionProvenance;
}

export interface StateMachineModuleProjection {
  readonly chainId: number;
  readonly stateMachineAddress: Address;
  readonly moduleId: Hex;
  readonly previousModule: Address;
  readonly moduleAddress: Address;
  readonly updatedAt: ProjectionProvenance;
  readonly proof: StateMachineProofProjection;
}

export interface StateMachineDeploymentProjection {
  readonly deploymentId: Hex;
  readonly stateMachineAddress: Address;
  readonly artifactHash: Hex;
  readonly abiHash: Hex;
  readonly deploymentBlock: string;
  readonly activatedAtBlock?: string;
  readonly evidenceHash?: Hex;
  readonly metadataURI: string;
  readonly status: StateMachineDeploymentStatus;
  readonly registeredAt: ProjectionProvenance;
  readonly updatedAt: ProjectionProvenance;
  readonly proof: StateMachineProofProjection;
}

export interface ProjectionSnapshot {
  readonly rebuildable: true;
  readonly eventCount: number;
  readonly orders: Readonly<Record<string, OrderProjection>>;
  readonly activeStateMachineDeploymentId?: Hex;
  readonly stateMachineDeployments: Readonly<Record<string, StateMachineDeploymentProjection>>;
  readonly stateMachineModules: Readonly<Record<string, StateMachineModuleProjection>>;
  readonly stateMachinePlans: Readonly<Record<string, StateMachinePlanProjection>>;
  readonly stateMachineOrders: Readonly<Record<string, StateMachineOrderProjection>>;
  readonly stateMachineDocks: Readonly<Record<string, StateMachineDockProjection>>;
  readonly stateMachineTasks: Readonly<Record<string, StateMachineTaskProjection>>;
  readonly lastEvent?: ProjectionProvenance;
  /**
   * P0 幻影订单诊断计数：订单维度事件（patch/dock/link/derived）本应由已
   * 登记的模块合约发出，但 replay 时其 emitting 地址无法通过
   * stateMachineModules 唯一归因到所属状态机（模块未登记/replay 顺序中
   * StateMachineModuleSet 尚未出现/一址多机）。这类事件保持事件自带地址
   * 建桶（现状），但必须在此显式计数，不允许静默。
   */
  readonly unresolvedModuleOrderEventCount?: number;
  /**
   * Dock 事件（input/output/terminal）无法定位已开启 dock 桶的显式计数
   * （dock 未开启 / 模块未登记 / 回放顺序中 DockOpened 缺失）。不允许静默。
   */
  readonly unresolvedDockEventCount?: number;
  /**
   * StageExecutorActivated 到达时目标 stage 没有既有 overlay 的显式计数
   * （激活前补丁事件缺失）。不允许静默。
   */
  readonly unresolvedStageActivationEventCount?: number;
}

type Writable<TValue> = {
  -readonly [TKey in keyof TValue]: TValue[TKey];
};

type MutableStateMachineHookProjection = Writable<StateMachineHookProjection>;
type MutableStateMachineTaskProjection = Writable<StateMachineTaskProjection>;
type MutableStateMachineModuleProjection = Writable<StateMachineModuleProjection>;
type MutableStateMachineOrderProjection = Writable<
  Omit<
    StateMachineOrderProjection,
    | "authorizations"
    | "signals"
    | "signalDelegations"
    | "stageExecutorOverlays"
    | "stageResourceOverlays"
    | "triggerLink"
    | "hooks"
    | "tasks"
    | "timeline"
    | "proof"
  >
> & {
  authorizations: Record<string, StateMachineSignalAuthorizationProjection>;
  signals: Record<string, StateMachineSignalProjection>;
  signalDelegations: Record<string, StateMachineSignalDelegationProjection>;
  stageExecutorOverlays: Record<string, StateMachineStageExecutorOverlayProjection>;
  stageResourceOverlays: Record<string, StateMachineStageResourceOverlayProjection>;
  triggerLink?: StateMachineOrderTriggerLinkProjection;
  hooks: Record<string, MutableStateMachineHookProjection>;
  tasks: Record<string, MutableStateMachineTaskProjection>;
  timeline: StateMachineTimelineEventProjection[];
  proof: StateMachineProofProjection[];
};

type MutableStateMachineDockProjection = Writable<
  Omit<
    StateMachineDockProjection,
    "inputDeliveries" | "outputDeliveries"
  >
> & {
  inputDeliveries: Record<string, StateMachineDockInputDeliveryProjection>;
  outputDeliveries: Record<string, StateMachineDockOutputDeliveryProjection>;
};

type MutableStateMachinePlanProjection = Writable<StateMachinePlanProjection>;
type MutableStateMachineDeploymentProjection = Writable<StateMachineDeploymentProjection>;

const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000" as const;
const EXECUTOR_PATCH_MODE_VALUES = {
  assign: EXECUTOR_PATCH_MODE_ASSIGN,
  handoff: EXECUTOR_PATCH_MODE_HANDOFF,
  replacement: EXECUTOR_PATCH_MODE_REPLACEMENT
} as const satisfies Record<StateMachineStageExecutorPatchMode, Hex>;

/** P0 幻影订单：单次 replay 内累计的显式诊断计数。 */
interface ProjectionReplayDiagnostics {
  unresolvedModuleOrderEventCount: number;
  unresolvedDockEventCount: number;
  unresolvedStageActivationEventCount: number;
}

type StateMachineModuleIndex = ReadonlyMap<string, MutableStateMachineModuleProjection>;

export function createEmptyProjectionSnapshot(): ProjectionSnapshot {
  return {
    rebuildable: true,
    eventCount: 0,
    orders: {},
    stateMachineDeployments: {},
    stateMachineModules: {},
    stateMachinePlans: {},
    stateMachineOrders: {},
    stateMachineDocks: {},
    stateMachineTasks: {},
    unresolvedModuleOrderEventCount: 0,
    unresolvedDockEventCount: 0,
    unresolvedStageActivationEventCount: 0
  };
}

/**
 * rebuild summary 的 mismatchCount 必须反映真实 replay 异常，而不是
 * 硬编码 0。这里统计两类可观测异常：
 * 1. 重复/矛盾投递 —— 同一事件键（chain/contract/block/tx/log）作为活跃
 *    事件出现多次（replay 会静默去重，但这是真实异常，必须计数）；
 * 2. 投影 apply 失败 —— 事件流引用未知 plan 等导致 rebuildOrderProjections
 *    抛错（调用方随后按 degraded 处理，异常本身计为 1）。
 *
 * 已调查 uvp-protocol 的 @uvp-eth/statemachine 语义 replay oracle
 * （replayChainEvents）：它要求带 compiledHooks/dependencyIndex 的完整
 * plan 编译产物与 zhixuId 富化事件，索引器投影的事件流不携带这些数据，
 * 且依赖 @uvp-eth/hook-core 的原生 uvp-core 运行时；在索引器内接通属于
 * 独立集成任务，此处先用真实可观测异常计数。
 */
export function countReplayAnomalies(events: readonly ChainEvent[]): number {
  let anomalies = 0;
  const seenActive = new Set<string>();
  for (const event of events) {
    if (event.removed === true) {
      continue;
    }
    const key = chainEventKey(event);
    if (seenActive.has(key)) {
      anomalies += 1;
    }
    seenActive.add(key);
  }
  try {
    rebuildOrderProjections(events);
  } catch {
    anomalies += 1;
  }
  return anomalies;
}

export function rebuildOrderProjections(events: readonly ChainEvent[]): ProjectionSnapshot {
  const stateMachineDeployments = new Map<string, MutableStateMachineDeploymentProjection>();
  const stateMachineModules = new Map<string, MutableStateMachineModuleProjection>();
  const stateMachinePlans = new Map<string, MutableStateMachinePlanProjection>();
  const stateMachineOrders = new Map<string, MutableStateMachineOrderProjection>();
  const stateMachineDocks = new Map<string, MutableStateMachineDockProjection>();
  const diagnostics: ProjectionReplayDiagnostics = {
    unresolvedModuleOrderEventCount: 0,
    unresolvedDockEventCount: 0,
    unresolvedStageActivationEventCount: 0
  };
  let activeStateMachineDeploymentId: Hex | undefined;
  let eventCount = 0;
  let lastEvent: ProjectionProvenance | undefined;

  for (const event of filterActiveChainEvents(events)) {
    activeStateMachineDeploymentId = applyDeploymentRegistryEvent(stateMachineDeployments, activeStateMachineDeploymentId, event);
    applyStateMachineEvent({
      deployments: stateMachineDeployments,
      modules: stateMachineModules,
      plans: stateMachinePlans,
      orders: stateMachineOrders,
      docks: stateMachineDocks,
      diagnostics
    }, event);
    eventCount += 1;
    lastEvent = provenanceOf(event);
  }

  const stateMachineOrderRecord: Record<string, StateMachineOrderProjection> = {};
  const stateMachineTaskRecord: Record<string, StateMachineTaskProjection> = {};
  const stateMachineDockRecord: Record<string, StateMachineDockProjection> = {};
  for (const [dockKey, dock] of stateMachineDocks) {
    stateMachineDockRecord[dockKey] = {
      ...dock,
      inputDeliveries: { ...dock.inputDeliveries },
      outputDeliveries: { ...dock.outputDeliveries }
    };
  }
  for (const [orderId, order] of stateMachineOrders) {
    const readonlyTasks: Record<string, StateMachineTaskProjection> = {};
    for (const [taskId, task] of Object.entries(order.tasks)) {
      const readonlyTask = {
        ...task,
        ...(task.submitSignals ? { submitSignals: [...task.submitSignals] } : {})
      };
      readonlyTasks[taskId] = readonlyTask;
      stateMachineTaskRecord[stateMachineTaskProjectionKey(
        order.chainId,
        order.contractAddress,
        order.planId,
        order.orderId,
        task.hookId
      )] = readonlyTask;
    }
    const readonlyOrder = {
      ...order,
      authorizations: { ...order.authorizations },
      signals: { ...order.signals },
      signalDelegations: { ...order.signalDelegations },
      stageExecutorOverlays: { ...order.stageExecutorOverlays },
      stageResourceOverlays: { ...order.stageResourceOverlays },
      ...(order.triggerLink ? { triggerLink: order.triggerLink } : {}),
      hooks: Object.fromEntries(Object.entries(order.hooks).map(([hookId, hook]) => [hookId, { ...hook }])),
      tasks: readonlyTasks,
      timeline: [...order.timeline].sort(compareTimelineEvents),
      proof: [...order.proof].sort(compareProofEvents)
    };
    // 快照只暴露 plan 作用域的复合键：每条订单/任务恰好一个键，
    // 裸 orderId 必须走 fail-closed 扫描（uniqueOrderByBareId），绝不静默命中。
    stateMachineOrderRecord[orderId] = readonlyOrder;
  }

  return {
    rebuildable: true,
    eventCount,
    orders: {},
    ...(activeStateMachineDeploymentId ? { activeStateMachineDeploymentId } : {}),
    stateMachineDeployments: Object.fromEntries(stateMachineDeployments),
    stateMachineModules: Object.fromEntries(stateMachineModules),
    stateMachinePlans: Object.fromEntries(stateMachinePlans),
    stateMachineOrders: stateMachineOrderRecord,
    stateMachineDocks: stateMachineDockRecord,
    stateMachineTasks: stateMachineTaskRecord,
    unresolvedModuleOrderEventCount: diagnostics.unresolvedModuleOrderEventCount,
    unresolvedDockEventCount: diagnostics.unresolvedDockEventCount,
    unresolvedStageActivationEventCount: diagnostics.unresolvedStageActivationEventCount,
    ...(lastEvent ? { lastEvent } : {})
  };
}

function applyStateMachineEvent(
  state: {
    deployments: Map<string, MutableStateMachineDeploymentProjection>;
    modules: Map<string, MutableStateMachineModuleProjection>;
    plans: Map<string, MutableStateMachinePlanProjection>;
    orders: Map<string, MutableStateMachineOrderProjection>;
    docks: Map<string, MutableStateMachineDockProjection>;
    diagnostics: ProjectionReplayDiagnostics;
  },
  event: ChainEvent
): void {
  switch (event.eventName) {
    case "StateMachineModuleSet":
      applyStateMachineModuleSet(state.modules, event);
      return;
    case "PlanCommitted":
      applyPlanCommitted(state, event);
      return;
    case "PlanFinalized":
      applyPlanFinalized(state, event);
      return;
    case "PlanRegistered":
      applyPlanRegistered(state, event);
      return;
    case "PlanPublisherRecorded":
      applyPlanPublisherRecorded(state, event);
      return;
    case "OrderRegistered":
      applyOrderRegistered(state, event);
      return;
    case "OrderMaterialized":
      applyOrderMaterialized(state, event);
      return;
    case "OrderRelayerRecorded":
      applyOrderRelayerRecorded(state, event);
      return;
    case "SignalSubmitterAuthorized":
      applySignalSubmitterAuthorized(state, event);
      return;
    case "SignalSubmitted":
      applySignalSubmitted(state, event);
      return;
    case "StageMaterialized":
      applyStageMaterialized(state, event);
      return;
    case "OrderTriggered":
      applyOrderTriggered(state, event);
      return;
    case "OrderLinked":
      applyOrderLinked(state, event);
      return;
    case "SignalCapabilityRegistered":
      applySignalCapabilityRegistered(state, event);
      return;
    case "StageSelectorBindingRegistered":
      applyStageSelectorBindingRegistered(state, event);
      return;
    case "StageExecutorPatchApplied":
      applyStageExecutorPatchApplied(state, event);
      return;
    case "StageResourcePatchApplied":
      applyStageResourcePatchApplied(state, event);
      return;
    case "StageExecutorActivated":
      applyStageExecutorActivated(state, event);
      return;
    case "StageExecutorSignalDelegated":
      applyStageExecutorSignalDelegated(state, event);
      return;
    case "DockOpened":
      applyDockOpened(state, event);
      return;
    case "DockInputSubmitted":
      applyDockInputSubmitted(state, event);
      return;
    case "DockOutputSubmitted":
      applyDockOutputSubmitted(state, event);
      return;
    case "DockTerminal":
      applyDockTerminal(state, event);
      return;
    case "DerivedSignalSubmitted":
      applyDerivedSignalSubmitted(state, event);
      return;
    case "HookStatusChanged":
      applyHookStatusChanged(state, event);
      return;
    case "HookReady":
      applyHookReady(state, event);
      return;
    case "TimerPoked":
      applyTimerPoked(state, event);
      return;
    default:
      return;
  }
}

function applyDeploymentRegistryEvent(
  deployments: Map<string, MutableStateMachineDeploymentProjection>,
  activeDeploymentId: Hex | undefined,
  event: ChainEvent
): Hex | undefined {
  switch (event.eventName) {
    case "DeploymentRegistered": {
      const deploymentId = requiredBytes32Arg(event, "deploymentId");
      const proof = proofOf(event);
      deployments.set(deploymentProjectionKey(event.chainId, event.contractAddress, deploymentId), {
        deploymentId,
        stateMachineAddress: requiredAddressArg(event, "stateMachine"),
        artifactHash: requiredBytes32Arg(event, "artifactHash"),
        abiHash: requiredBytes32Arg(event, "abiHash"),
        deploymentBlock: uintArgAsString(event, "deploymentBlock"),
        metadataURI: optionalStringArg(event, "metadataURI") ?? "",
        status: "candidate",
        registeredAt: provenanceOf(event),
        updatedAt: provenanceOf(event),
        proof
      });
      return activeDeploymentId;
    }
    case "DeploymentCanaryMarked": {
      const deployment = findDeploymentById(deployments, requiredBytes32Arg(event, "deploymentId"));
      if (deployment) {
        deployment.status = "canary";
        deployment.evidenceHash = requiredBytes32Arg(event, "evidenceHash");
        deployment.updatedAt = provenanceOf(event);
        deployment.proof = proofOf(event);
      }
      return activeDeploymentId;
    }
    case "DeploymentActivated": {
      const previousDeploymentId = optionalBytes32Arg(event, "previousDeploymentId");
      const newDeploymentId = requiredBytes32Arg(event, "newDeploymentId");
      if (previousDeploymentId && previousDeploymentId !== ZERO_BYTES32) {
        const previous = findDeploymentById(deployments, previousDeploymentId);
        if (previous) {
          previous.status = "deprecated";
          previous.updatedAt = provenanceOf(event);
        }
      }
      const next = findDeploymentById(deployments, newDeploymentId);
      if (next) {
        next.status = "active";
        next.activatedAtBlock = event.blockNumber.toString();
        next.evidenceHash = requiredBytes32Arg(event, "evidenceHash");
        next.updatedAt = provenanceOf(event);
        next.proof = proofOf(event);
      }
      return newDeploymentId;
    }
    case "DeploymentDeprecated": {
      const deploymentId = requiredBytes32Arg(event, "deploymentId");
      const deployment = findDeploymentById(deployments, deploymentId);
      if (deployment) {
        deployment.status = "deprecated";
        deployment.updatedAt = provenanceOf(event);
        deployment.proof = proofOf(event);
      }
      return activeDeploymentId === deploymentId ? undefined : activeDeploymentId;
    }
    case "DeploymentRetired": {
      const deploymentId = requiredBytes32Arg(event, "deploymentId");
      const deployment = findDeploymentById(deployments, deploymentId);
      if (deployment) {
        deployment.status = "retired";
        deployment.updatedAt = provenanceOf(event);
        deployment.proof = proofOf(event);
      }
      return activeDeploymentId === deploymentId ? undefined : activeDeploymentId;
    }
    default:
      return activeDeploymentId;
  }
}

function applyStateMachineModuleSet(
  modules: Map<string, MutableStateMachineModuleProjection>,
  event: ChainEvent
): void {
  const moduleId = requiredBytes32Arg(event, "moduleId");
  const previousModule = requiredAddressArg(event, "previousModule");
  const moduleAddress = requiredAddressArg(event, "newModule");
  modules.set(stateMachineScopedKey(event.chainId, event.contractAddress, moduleId), {
    chainId: event.chainId,
    stateMachineAddress: event.contractAddress,
    moduleId,
    previousModule,
    moduleAddress,
    updatedAt: provenanceOf(event),
    proof: proofOf(event)
  });
}

/**
 * P0 幻影订单：订单/计划维度事件可能由模块合约发出（UVPStagePatchModule、
 * UVPDockingModule、UVPOrderLinkModule、UVPDerivedSignalModule、
 * UVPPlanMetadataModule），此时 event.contractAddress 是模块地址。订单必须
 * 按所属状态机地址分桶，否则同一订单会在模块地址下分裂出 planId=0 的
 * unknown 幻影桶。这里用 StateMachineModuleSet 建立的 stateMachineModules
 * 投影做 module → state machine 反向归一化：
 * - 唯一命中 → 返回所属状态机地址（resolved）；
 * - 无法唯一归因（模块未登记 / replay 顺序中 StateMachineModuleSet 尚未
 *   出现 / 同一模块地址被多个状态机登记）→ 返回事件自带地址（resolved:
 *   false），调用方保持现状建桶并计入显式诊断计数，不允许静默。
 */
function resolveStateMachineAddressForModuleEvent(
  modules: StateMachineModuleIndex,
  event: ChainEvent
): { stateMachineAddress: Address; resolved: boolean } {
  const emitter = event.contractAddress.toLowerCase();
  const matches = [...modules.values()].filter((module) =>
    module.chainId === event.chainId && module.moduleAddress.toLowerCase() === emitter
  );
  if (matches.length === 1) {
    const match = matches[0];
    if (match) {
      return { stateMachineAddress: match.stateMachineAddress, resolved: true };
    }
  }
  return { stateMachineAddress: event.contractAddress, resolved: false };
}

/**
 * P0 幻影订单：订单维度事件（7 类）建桶前的统一归一化入口——解析失败的
 * 事件保持事件地址建桶（现状）并累计 unresolvedModuleOrderEventCount。
 */
function stateMachineAddressForOrderEvent(
  state: {
    modules: StateMachineModuleIndex;
    diagnostics: ProjectionReplayDiagnostics;
  },
  event: ChainEvent
): Address {
  const resolution = resolveStateMachineAddressForModuleEvent(state.modules, event);
  if (!resolution.resolved) {
    state.diagnostics.unresolvedModuleOrderEventCount += 1;
  }
  return resolution.stateMachineAddress;
}

/** 订单维度事件专用：先归一化到状态机地址，再建/取订单桶。 */
function ensureStateMachineOrderFromModuleEvent(
  state: {
    modules: StateMachineModuleIndex;
    diagnostics: ProjectionReplayDiagnostics;
    orders: Map<string, MutableStateMachineOrderProjection>;
  },
  event: ChainEvent,
  orderId: Hex,
  planId?: Hex,
  deploymentId?: Hex
): MutableStateMachineOrderProjection {
  return ensureStateMachineOrder(
    state.orders,
    event,
    orderId,
    planId,
    deploymentId,
    stateMachineAddressForOrderEvent(state, event)
  );
}

/**
 * 真实事件顺序（UVPStateMachine v0.10）：commitPlan 同一交易先发
 * PlanCommitted 再发 PlanPublisherRecorded；finalizePlan 内先调用 plan
 * metadata 模块（SignalCapabilityRegistered 等，logIndex 更小），随后才发
 * PlanFinalized + PlanRegistered。投影必须在 PlanCommitted 建 plan 桶，
 * 否则 finalize 交易内的模块事件全部撞"unknown plan"→ ProjectionError →
 * 索引器永久 degraded。
 */
function applyPlanCommitted(
  state: {
    deployments: Map<string, MutableStateMachineDeploymentProjection>;
    plans: Map<string, MutableStateMachinePlanProjection>;
  },
  event: ChainEvent
): void {
  const planId = requiredBytes32Arg(event, "planId");
  const planHash = requiredBytes32Arg(event, "planHash");
  const publisher = requiredAddressArg(event, "publisher");
  const proof = proofOf(event, { planId, planHash, submitter: publisher });
  const key = stateMachineScopedKey(event.chainId, event.contractAddress, planId);
  const existing = state.plans.get(key);
  if (existing) {
    // 合约对同一 planId 二次 commitPlan 会 revert（PlanAlreadyRegistered）；
    // 回放流中出现重复时保留首见事实，不覆盖。
    return;
  }
  const deployment = findDeploymentByStateMachine(state.deployments, event.chainId, event.contractAddress);
  const plan: MutableStateMachinePlanProjection = {
    planId,
    ...(deployment ? { deploymentId: deployment.deploymentId } : {}),
    stateMachineAddress: event.contractAddress,
    planHash,
    hookCount: uintArgAsString(event, "hookCount"),
    publisher,
    hooksHash: requiredBytes32Arg(event, "hooksHash"),
    metadataHash: requiredBytes32Arg(event, "metadataHash"),
    dockRoutesRoot: requiredBytes32Arg(event, "dockRoutesRoot"),
    dockInterfaceRoot: requiredBytes32Arg(event, "dockInterfaceRoot"),
    committedAt: provenanceOf(event),
    selectorBindings: [],
    signalCapabilities: [],
    registeredAt: provenanceOf(event),
    updatedAt: provenanceOf(event),
    proof,
    commitProof: proof
  };
  state.plans.set(key, plan);
}

function applyPlanFinalized(
  state: {
    deployments: Map<string, MutableStateMachineDeploymentProjection>;
    plans: Map<string, MutableStateMachinePlanProjection>;
  },
  event: ChainEvent
): void {
  const planId = requiredBytes32Arg(event, "planId");
  const planHash = requiredBytes32Arg(event, "planHash");
  const metadataHash = requiredBytes32Arg(event, "metadataHash");
  const proof = proofOf(event, { planId, planHash });
  const key = stateMachineScopedKey(event.chainId, event.contractAddress, planId);
  const existing = state.plans.get(key);
  if (existing) {
    if (!existing.finalizedAt) {
      existing.finalizedAt = provenanceOf(event);
      existing.finalizationProof = proof;
      existing.metadataHash = metadataHash;
      existing.updatedAt = provenanceOf(event);
    }
    return;
  }
  // 合约路径下 PlanFinalized 必然跟在 PlanCommitted 之后（finalizePlan
  // 前置检查 plan.committed）；桶缺失说明事件流被截断，仍按链上事实建桶
  //（finalize 已发生），不抛错阻塞索引。
  const deployment = findDeploymentByStateMachine(state.deployments, event.chainId, event.contractAddress);
  const plan: MutableStateMachinePlanProjection = {
    planId,
    ...(deployment ? { deploymentId: deployment.deploymentId } : {}),
    stateMachineAddress: event.contractAddress,
    planHash,
    hookCount: "0",
    metadataHash,
    committedAt: provenanceOf(event),
    finalizedAt: provenanceOf(event),
    selectorBindings: [],
    signalCapabilities: [],
    registeredAt: provenanceOf(event),
    updatedAt: provenanceOf(event),
    proof,
    finalizationProof: proof
  };
  state.plans.set(key, plan);
}

function applyPlanRegistered(
  state: {
    deployments: Map<string, MutableStateMachineDeploymentProjection>;
    plans: Map<string, MutableStateMachinePlanProjection>;
    orders: Map<string, MutableStateMachineOrderProjection>;
  },
  event: ChainEvent
): void {
  const planId = requiredBytes32Arg(event, "planId");
  const planHash = requiredBytes32Arg(event, "planHash");
  const deployment = findDeploymentByStateMachine(state.deployments, event.chainId, event.contractAddress);
  const proof = proofOf(event, { planId, planHash });
  const key = stateMachineScopedKey(event.chainId, event.contractAddress, planId);
  const existing = state.plans.get(key);
  // 真实链序（finalizePlan）：模块元数据事件先于 PlanRegistered 落日志，
  // 词表在此前已并入桶。PlanRegistered 的 ABI 本身不携带
  // selectorBindings/signalCapabilities——合并而非覆写，否则 finalize 交易
  // 内模块事件登记的词表会被空数组清空。
  const mergedSelectorBindings = mergeSelectorBindings(
    existing?.selectorBindings ?? [],
    selectorBindingsArg(event)
  );
  const mergedSignalCapabilities = mergeSignalCapabilities(
    existing?.signalCapabilities ?? [],
    signalCapabilitiesArg(event)
  );
  const plan: MutableStateMachinePlanProjection = existing
    ? {
      ...existing,
      planHash,
      hookCount: uintArgAsString(event, "hookCount"),
      selectorBindings: mergedSelectorBindings,
      signalCapabilities: mergedSignalCapabilities,
      // PlanRegistered 在 finalize 交易末尾发出：这是"已注册"的权威时点。
      registeredAt: provenanceOf(event),
      updatedAt: provenanceOf(event),
      proof
    }
    : {
      planId,
      ...(deployment ? { deploymentId: deployment.deploymentId } : {}),
      stateMachineAddress: event.contractAddress,
      planHash,
      hookCount: uintArgAsString(event, "hookCount"),
      selectorBindings: mergedSelectorBindings,
      signalCapabilities: mergedSignalCapabilities,
      registeredAt: provenanceOf(event),
      updatedAt: provenanceOf(event),
      proof
    };
  state.plans.set(key, plan);

  for (const order of state.orders.values()) {
    if (order.contractAddress !== event.contractAddress || order.planId !== planId) {
      continue;
    }
    order.planHash = planHash;
    if (deployment && !order.deploymentId) {
      order.deploymentId = deployment.deploymentId;
    }
    order.updatedAt = provenanceOf(event);
    appendOrderProof(order, proof);
    appendOrderTimeline(order, timelineOf(event, "秩序版本已注册", proof, { orderId: order.orderId, planId }));
  }
}

function applyPlanPublisherRecorded(
  state: {
    modules: StateMachineModuleIndex;
    plans: Map<string, MutableStateMachinePlanProjection>;
  },
  event: ChainEvent
): void {
  const planId = requiredBytes32Arg(event, "planId");
  const plan = findPlanForEvent(state.plans, state.modules, event, planId);
  if (!plan) {
    throw new ProjectionError(`${event.eventName} references unknown plan ${planId}`);
  }
  const publisher = requiredAddressArg(event, "publisher");
  const proof = proofOf(event, { planId, submitter: publisher });
  plan.publisher = publisher;
  plan.publisherRecordedAt = provenanceOf(event);
  plan.publisherProof = proof;
  plan.updatedAt = provenanceOf(event);
}

function applyOrderRegistered(
  state: {
    deployments: Map<string, MutableStateMachineDeploymentProjection>;
    plans: Map<string, MutableStateMachinePlanProjection>;
    orders: Map<string, MutableStateMachineOrderProjection>;
  },
  event: ChainEvent
): void {
  const orderId = requiredBytes32Arg(event, "orderId");
  const planId = requiredBytes32Arg(event, "planId");
  const plan = state.plans.get(stateMachineScopedKey(event.chainId, event.contractAddress, planId));
  const proof = proofOf(event, { orderId, planId, planHash: plan?.planHash });
  const deploymentId = orderDeploymentIdFromPlanOrStateMachine(plan, state.deployments, event.chainId, event.contractAddress);
  const order = ensureStateMachineOrder(state.orders, event, orderId, planId, deploymentId);
  order.status = "registered";
  order.planId = planId;
  if (plan) {
    order.planHash = plan.planHash;
    appendOrderProof(order, plan.proof);
    appendOrderTimeline(order, timelineOf(event, "秩序版本已注册", plan.proof, { orderId, planId }));
  }
  order.registeredAt = provenanceOf(event);
  order.updatedAt = provenanceOf(event);
  appendOrderProof(order, proof);
  appendOrderTimeline(order, timelineOf(event, "订单已创建", proof, { orderId, planId }));
}

function applyOrderMaterialized(
  state: {
    deployments: Map<string, MutableStateMachineDeploymentProjection>;
    plans: Map<string, MutableStateMachinePlanProjection>;
    orders: Map<string, MutableStateMachineOrderProjection>;
  },
  event: ChainEvent
): void {
  const orderId = requiredBytes32Arg(event, "orderId");
  const planId = requiredBytes32Arg(event, "planId");
  const stageId = requiredBytes32Arg(event, "stageId");
  const plan = state.plans.get(stateMachineScopedKey(event.chainId, event.contractAddress, planId));
  const deploymentId = orderDeploymentIdFromPlanOrStateMachine(plan, state.deployments, event.chainId, event.contractAddress);
  const order = ensureStateMachineOrder(
    state.orders,
    event,
    orderId,
    planId,
    deploymentId
  );
  const proof = proofOf(event, { orderId, planId, planHash: order.planHash ?? plan?.planHash });
  order.status = "registered";
  order.currentStage = stageId;
  order.planId = planId;
  if (plan && !order.planHash) {
    order.planHash = plan.planHash;
  }
  order.updatedAt = provenanceOf(event);
  appendOrderProof(order, proof);
  appendOrderTimeline(order, timelineOf(event, "订单已实体化", proof, { orderId, planId }));
}

function applyOrderRelayerRecorded(
  state: {
    deployments: Map<string, MutableStateMachineDeploymentProjection>;
    plans: Map<string, MutableStateMachinePlanProjection>;
    orders: Map<string, MutableStateMachineOrderProjection>;
  },
  event: ChainEvent
): void {
  const orderId = requiredBytes32Arg(event, "orderId");
  const planId = requiredBytes32Arg(event, "planId");
  const relayer = requiredAddressArg(event, "relayer");
  const creator = requiredAddressArg(event, "creator");
  const plan = state.plans.get(stateMachineScopedKey(event.chainId, event.contractAddress, planId));
  const deploymentId = orderDeploymentIdFromPlanOrStateMachine(plan, state.deployments, event.chainId, event.contractAddress);
  // _createOrder 同一交易内先发 OrderRegistered 再发 OrderRelayerRecorded：
  // 桶通常已存在，缺失时按复合键补建（链上事实：订单已注册）。
  const order = ensureStateMachineOrder(state.orders, event, orderId, planId, deploymentId);
  const proof = proofOf(event, { orderId, planId, planHash: order.planHash, submitter: relayer });
  order.relayer = relayer;
  order.creator = creator;
  order.updatedAt = provenanceOf(event);
  appendOrderProof(order, proof);
  appendOrderTimeline(order, timelineOf(event, "订单中继方已记录", proof, { orderId, planId }));
}

function applyStageSelectorBindingRegistered(
  state: {
    modules: StateMachineModuleIndex;
    plans: Map<string, MutableStateMachinePlanProjection>;
  },
  event: ChainEvent
): void {
  const planId = requiredBytes32Arg(event, "planId");
  const selectorStageId = requiredBytes32Arg(event, "selectorStageId");
  const targetStageId = requiredBytes32Arg(event, "targetStageId");
  // P0 幻影订单同病：StageSelectorBindingRegistered 由 UVPPlanMetadataModule
  // 发出，plan 事件同样先归一化到状态机地址再查 plan。
  const plan = findPlanForEvent(state.plans, state.modules, event, planId);
  if (!plan) {
    throw new ProjectionError(`${event.eventName} references unknown plan ${planId}`);
  }
  const alreadyExists = plan.selectorBindings.some((binding) =>
    binding.selectorStageId === selectorStageId && binding.targetStageId === targetStageId
  );
  if (!alreadyExists) {
    plan.selectorBindings = [...plan.selectorBindings, { selectorStageId, targetStageId }];
  }
  plan.updatedAt = provenanceOf(event);
}

function applySignalCapabilityRegistered(
  state: {
    modules: StateMachineModuleIndex;
    plans: Map<string, MutableStateMachinePlanProjection>;
    orders: Map<string, MutableStateMachineOrderProjection>;
  },
  event: ChainEvent
): void {
  const planId = requiredBytes32Arg(event, "planId");
  const capability = signalCapabilityFromEvent(event);
  // P0 幻影订单同病：SignalCapabilityRegistered 由 UVPPlanMetadataModule
  // 发出，plan 事件同样先归一化到状态机地址再查 plan，避免同 planId 跨
  // 部署时回退扫描歧义 → ProjectionError → 索引器永久 degraded。
  const plan = findPlanForEvent(state.plans, state.modules, event, planId);
  if (!plan) {
    throw new ProjectionError(`${event.eventName} references unknown plan ${planId}`);
  }
  if (!plan.signalCapabilities.some((item) => signalCapabilityEquals(item, capability))) {
    plan.signalCapabilities = [...plan.signalCapabilities, capability].sort(compareSignalCapabilities);
  }
  plan.updatedAt = provenanceOf(event);

  for (const order of state.orders.values()) {
    if (order.planId !== planId || order.chainId !== event.chainId || order.contractAddress !== plan.stateMachineAddress) {
      continue;
    }
    let changed = false;
    for (const task of Object.values(order.tasks)) {
      if (task.stageIdentifier !== capability.stageId) {
        continue;
      }
      refreshTaskSubmitSignals(order, task, plan);
      changed = markTaskSubmittedFromExistingSignals(order, task) || changed;
    }
    void changed;
  }
}

function applySignalSubmitterAuthorized(
  state: {
    orders: Map<string, MutableStateMachineOrderProjection>;
  },
  event: ChainEvent
): void {
  const orderId = requiredBytes32Arg(event, "orderId");
  const planId = optionalBytes32Arg(event, "planId");
  const order = ensureStateMachineOrder(state.orders, event, orderId, planId);
  const sourceId = requiredBytes32Arg(event, "sourceId");
  const signalId = requiredBytes32Arg(event, "signalId");
  const submitter = requiredAddressArg(event, "submitter");
  const authorization: StateMachineSignalAuthorizationProjection = {
    orderId,
    sourceId,
    signalId,
    submitter,
    role: requiredBytes32Arg(event, "role"),
    metadataHash: requiredBytes32Arg(event, "metadataHash"),
    authorizedAt: provenanceOf(event),
    proof: proofOf(event, { orderId, planId: order.planId, planHash: order.planHash, submitter })
  };

  order.authorizations[signalAuthorizationProjectionKey(sourceId, signalId, submitter)] = authorization;
  order.updatedAt = provenanceOf(event);
  markMatchingTasksAssigned(order, authorization);
  appendOrderProof(order, authorization.proof);
  appendOrderTimeline(order, timelineOf(event, "执行授权已写入链上", authorization.proof, { orderId, planId: order.planId }));
}

function applySignalSubmitted(
  state: {
    plans: Map<string, MutableStateMachinePlanProjection>;
    orders: Map<string, MutableStateMachineOrderProjection>;
  },
  event: ChainEvent
): void {
  const orderId = requiredBytes32Arg(event, "orderId");
  const planId = optionalBytes32Arg(event, "planId");
  const order = ensureStateMachineOrder(state.orders, event, orderId, planId);
  const sourceId = requiredBytes32Arg(event, "sourceId");
  const signalId = requiredBytes32Arg(event, "signalId");
  const submitter = requiredAddressArg(event, "submitter");
  const proof = proofOf(event, { orderId, planId: order.planId, planHash: order.planHash, submitter });
  const signal: StateMachineSignalProjection = {
    orderId,
    sourceId,
    signalId,
    payloadHash: requiredBytes32Arg(event, "payloadHash"),
    idempotencyKey: requiredBytes32Arg(event, "idempotencyKey"),
    submitter,
    submittedAt: provenanceOf(event),
    proof
  };
  order.signals[signalProjectionKey(sourceId, signalId)] = signal;
  order.status = "registered";
  order.updatedAt = provenanceOf(event);
  markMatchingTasksSubmitted(order, sourceId, signalId, proof);
  appendOrderProof(order, proof);
  appendOrderTimeline(order, timelineOf(event, "确认动作已写入链上", proof, { orderId, planId: order.planId }));
}

function applyStageMaterialized(
  state: {
    orders: Map<string, MutableStateMachineOrderProjection>;
  },
  event: ChainEvent
): void {
  const orderId = requiredBytes32Arg(event, "orderId");
  const planId = optionalBytes32Arg(event, "planId");
  const order = ensureStateMachineOrder(state.orders, event, orderId, planId);
  const stageId = requiredBytes32Arg(event, "stageId");
  const proof = proofOf(event, { orderId, planId: order.planId, planHash: order.planHash });
  order.currentStage = stageId;
  order.status = "registered";
  order.updatedAt = provenanceOf(event);
  appendOrderProof(order, proof);
  appendOrderTimeline(order, timelineOf(event, "环节已启动", proof, { orderId, planId: order.planId }));
}

function applyOrderTriggered(
  state: {
    deployments: Map<string, MutableStateMachineDeploymentProjection>;
    plans: Map<string, MutableStateMachinePlanProjection>;
    orders: Map<string, MutableStateMachineOrderProjection>;
  },
  event: ChainEvent
): void {
  const orderId = requiredBytes32Arg(event, "orderId");
  const planId = requiredBytes32Arg(event, "planId");
  const triggerStageId = requiredBytes32Arg(event, "triggerStageId");
  const sourceId = requiredBytes32Arg(event, "sourceId");
  const signalId = requiredBytes32Arg(event, "signalId");
  const submitter = requiredAddressArg(event, "submitter");
  const plan = state.plans.get(stateMachineScopedKey(event.chainId, event.contractAddress, planId));
  const deploymentId = orderDeploymentIdFromPlanOrStateMachine(plan, state.deployments, event.chainId, event.contractAddress);
  const order = ensureStateMachineOrder(
    state.orders,
    event,
    orderId,
    planId,
    deploymentId
  );
  if (plan && !order.planHash) {
    order.planHash = plan.planHash;
  }
  const proof = proofOf(event, { orderId, planId, planHash: order.planHash ?? plan?.planHash, submitter });
  order.currentStage = triggerStageId;
  order.status = order.status === "unknown" ? "registered" : order.status;
  order.updatedAt = provenanceOf(event);
  appendOrderProof(order, proof);
  appendOrderTimeline(order, timelineOf(event, "触发信号已启动订单", proof, { orderId, planId, sourceId, signalId }));
}

function applyOrderLinked(
  state: {
    deployments: Map<string, MutableStateMachineDeploymentProjection>;
    modules: StateMachineModuleIndex;
    diagnostics: ProjectionReplayDiagnostics;
    orders: Map<string, MutableStateMachineOrderProjection>;
  },
  event: ChainEvent
): void {
  const triggeredOrderId = requiredBytes32Arg(event, "triggeredOrderId");
  const triggerOriginOrderId = requiredBytes32Arg(event, "triggerOriginOrderId");
  const triggerStageId = requiredBytes32Arg(event, "triggerStageId");
  const originSourceId = requiredBytes32Arg(event, "originSourceId");
  const originSignalId = requiredBytes32Arg(event, "originSignalId");
  const planId = optionalBytes32Arg(event, "planId");
  // P0 幻影订单：OrderLinked 由 UVPOrderLinkModule 发出，先归一化到所属
  // 状态机地址再做部署归属与建桶。
  const stateMachineAddress = stateMachineAddressForOrderEvent(state, event);
  const childOrder = ensureStateMachineOrder(
    state.orders,
    event,
    triggeredOrderId,
    planId,
    findDeploymentByStateMachine(state.deployments, event.chainId, stateMachineAddress)?.deploymentId,
    stateMachineAddress
  );
  const proof = proofOf(event, {
    orderId: triggeredOrderId,
    triggerOriginOrderId,
    planId: childOrder.planId,
    planHash: childOrder.planHash
  });
  childOrder.triggerLink = {
    triggeredOrderId,
    triggerOriginOrderId,
    triggerStageId,
    originSourceId,
    originSignalId,
    linkedAt: provenanceOf(event),
    proof
  };
  childOrder.currentStage = triggerStageId;
  childOrder.updatedAt = provenanceOf(event);
  appendOrderProof(childOrder, proof);
  appendOrderTimeline(childOrder, timelineOf(event, "订单已连接到触发来源", proof, {
    orderId: triggeredOrderId,
    triggerOriginOrderId,
    originSourceId,
    originSignalId
  }));
}

function applyStageExecutorPatchApplied(
  state: {
    modules: StateMachineModuleIndex;
    diagnostics: ProjectionReplayDiagnostics;
    orders: Map<string, MutableStateMachineOrderProjection>;
  },
  event: ChainEvent
): void {
  const orderId = requiredBytes32Arg(event, "orderId");
  const planId = optionalBytes32Arg(event, "planId");
  // P0 幻影订单：StageExecutorPatchApplied 由 UVPStagePatchModule 发出。
  const order = ensureStateMachineOrderFromModuleEvent(state, event, orderId, planId);
  const selectorStageId = requiredBytes32Arg(event, "selectorStageId");
  const targetStageId = requiredBytes32Arg(event, "targetStageId");
  const selectorWallet = requiredAddressArg(event, "selector");
  const patchNonce = uintArgAsString(event, "patchNonce");
  const modeHash = optionalBytes32Arg(event, "mode");
  const mode = executorPatchModeFromArg(modeHash);
  const previousExecutor = optionalAddressArg(event, "previousExecutor");
  const approvalSourceId = optionalNonZeroBytes32Arg(event, "approvalSourceId");
  const approvalSignalId = optionalNonZeroBytes32Arg(event, "approvalSignalId");
  const proof = proofOf(event, {
    orderId,
    planId: order.planId,
    planHash: order.planHash,
    submitter: selectorWallet
  });
  const existing = order.stageExecutorOverlays[stageExecutorOverlayProjectionKey(targetStageId)];
  if (!existing || compareUintStrings(patchNonce, existing.patchNonce) >= 0) {
    const overlay: StateMachineStageExecutorOverlayProjection = {
      orderId,
      selectorStageId,
      targetStageId,
      selectorWallet,
      activeExecutorWallet: requiredAddressArg(event, "executor"),
      mode,
      ...(modeHash ? { modeHash } : {}),
      ...(previousExecutor ? { previousExecutor } : {}),
      ...(approvalSourceId ? { approvalSourceId } : {}),
      ...(approvalSignalId ? { approvalSignalId } : {}),
      roleHash: requiredBytes32Arg(event, "role"),
      executorMetadataHash: requiredBytes32Arg(event, "executorMetadataHash"),
      patchHash: requiredBytes32Arg(event, "patchHash"),
      patchNonce,
      metadataURI: optionalStringArg(event, "metadataURI") ?? "",
      updatedAt: provenanceOf(event),
      proof
    };
    order.stageExecutorOverlays[stageExecutorOverlayProjectionKey(targetStageId)] = overlay;
    markTargetStageTasksAssignedFromOverlay(order, overlay);
  }
  order.updatedAt = provenanceOf(event);
  appendOrderProof(order, proof);
  appendOrderTimeline(order, timelineOf(event, "阶段执行方已更新", proof, { orderId, planId: order.planId }));
}

function applyStageResourcePatchApplied(
  state: {
    modules: StateMachineModuleIndex;
    diagnostics: ProjectionReplayDiagnostics;
    orders: Map<string, MutableStateMachineOrderProjection>;
  },
  event: ChainEvent
): void {
  const orderId = requiredBytes32Arg(event, "orderId");
  const planId = optionalBytes32Arg(event, "planId");
  // P0 幻影订单：StageResourcePatchApplied 由 UVPStagePatchModule 发出。
  const order = ensureStateMachineOrderFromModuleEvent(state, event, orderId, planId);
  const selectorStageId = requiredBytes32Arg(event, "selectorStageId");
  const targetStageId = requiredBytes32Arg(event, "targetStageId");
  const resourceKey = requiredBytes32Arg(event, "resourceKey");
  const selectorWallet = requiredAddressArg(event, "selector");
  const patchNonce = uintArgAsString(event, "patchNonce");
  const proof = proofOf(event, {
    orderId,
    planId: order.planId,
    planHash: order.planHash,
    submitter: selectorWallet
  });
  const key = stageResourceOverlayProjectionKey(targetStageId, resourceKey);
  const existing = order.stageResourceOverlays[key];
  if (!existing || compareUintStrings(patchNonce, existing.patchNonce) >= 0) {
    order.stageResourceOverlays[key] = {
      orderId,
      selectorStageId,
      targetStageId,
      resourceKey,
      selectorWallet,
      manifestHash: requiredBytes32Arg(event, "manifestHash"),
      policyHash: requiredBytes32Arg(event, "policyHash"),
      patchHash: requiredBytes32Arg(event, "patchHash"),
      patchNonce,
      manifestURI: optionalStringArg(event, "manifestURI") ?? "",
      updatedAt: provenanceOf(event),
      proof
    };
  }
  order.updatedAt = provenanceOf(event);
  appendOrderProof(order, proof);
  appendOrderTimeline(order, timelineOf(event, "阶段资源清单已更新", proof, { orderId, planId: order.planId }));
}

function applyStageExecutorActivated(
  state: {
    orders: Map<string, MutableStateMachineOrderProjection>;
    diagnostics: ProjectionReplayDiagnostics;
  },
  event: ChainEvent
): void {
  const orderId = requiredBytes32Arg(event, "orderId");
  const planId = optionalBytes32Arg(event, "planId");
  const order = ensureStateMachineOrder(state.orders, event, orderId, planId);
  const targetStageId = requiredBytes32Arg(event, "targetStageId");
  const executor = requiredAddressArg(event, "executor");
  const patchNonce = uintArgAsString(event, "patchNonce");
  const proof = proofOf(event, {
    orderId,
    planId: order.planId,
    planHash: order.planHash,
    submitter: executor
  });
  const key = stageExecutorOverlayProjectionKey(targetStageId);
  const existing = order.stageExecutorOverlays[key];
  if (!existing) {
    // StageExecutorActivated 之前必须有 StageExecutorPatchApplied 建 overlay；
    // 缺失说明补丁事件未入流。计数显式暴露，不允许静默丢弃。
    state.diagnostics.unresolvedStageActivationEventCount += 1;
  }
  if (existing && compareUintStrings(patchNonce, existing.patchNonce) >= 0) {
    const overlay: StateMachineStageExecutorOverlayProjection = {
      ...existing,
      activeExecutorWallet: executor,
      roleHash: requiredBytes32Arg(event, "role"),
      executorMetadataHash: requiredBytes32Arg(event, "metadataHash"),
      patchNonce,
      metadataURI: optionalStringArg(event, "metadataURI") ?? existing.metadataURI,
      updatedAt: provenanceOf(event),
      activatedAt: provenanceOf(event),
      activationProof: proof
    };
    order.stageExecutorOverlays[key] = overlay;
    markTargetStageTasksAssignedFromOverlay(order, overlay);
  }
  order.updatedAt = provenanceOf(event);
  appendOrderProof(order, proof);
  appendOrderTimeline(order, timelineOf(event, "阶段执行方已激活", proof, { orderId, planId: order.planId }));
}

/**
 * delegateStageExecutorSignalFromModule 在链上把 (sourceId, signalId) 的
 * 提交权委派给 executor，并携带 targetStageId 阶段绑定。同一交易内先发
 * SignalSubmitterAuthorized（order.authorizations 已有记录）再发本事件；
 * 投影用本事件补齐阶段归属，供任务 submitSignals 挂接（F25）。
 */
function applyStageExecutorSignalDelegated(
  state: {
    orders: Map<string, MutableStateMachineOrderProjection>;
  },
  event: ChainEvent
): void {
  const orderId = requiredBytes32Arg(event, "orderId");
  const planId = optionalBytes32Arg(event, "planId");
  const order = ensureStateMachineOrder(state.orders, event, orderId, planId);
  const targetStageId = requiredBytes32Arg(event, "targetStageId");
  const sourceId = requiredBytes32Arg(event, "sourceId");
  const signalId = requiredBytes32Arg(event, "signalId");
  const executor = requiredAddressArg(event, "executor");
  const patchNonce = uintArgAsString(event, "patchNonce");
  const proof = proofOf(event, {
    orderId,
    planId: order.planId,
    planHash: order.planHash,
    submitter: executor
  });
  const delegation: StateMachineSignalDelegationProjection = {
    orderId,
    targetStageId,
    sourceId,
    signalId,
    executor,
    roleHash: requiredBytes32Arg(event, "role"),
    metadataHash: requiredBytes32Arg(event, "metadataHash"),
    patchNonce,
    delegatedAt: provenanceOf(event),
    proof
  };
  const key = signalProjectionKey(sourceId, signalId);
  const existing = order.signalDelegations[key];
  if (!existing || compareUintStrings(patchNonce, existing.patchNonce) >= 0) {
    order.signalDelegations[key] = delegation;
    markTargetStageTasksAssignedFromDelegation(order, delegation);
  }
  order.updatedAt = provenanceOf(event);
  appendOrderProof(order, proof);
  appendOrderTimeline(order, timelineOf(event, "阶段信号已委派执行方", proof, { orderId, planId: order.planId }));
}

function applyDockOpened(
  state: {
    modules: StateMachineModuleIndex;
    diagnostics: ProjectionReplayDiagnostics;
    orders: Map<string, MutableStateMachineOrderProjection>;
    docks: Map<string, MutableStateMachineDockProjection>;
  },
  event: ChainEvent
): void {
  const dockInstanceId = requiredBytes32Arg(event, "dockInstanceId");
  // DockOpened 由 UVPDockingModule 发出：先归一化到所属状态机地址。
  const stateMachineAddress = stateMachineAddressForOrderEvent(state, event);
  const localPlanId = requiredBytes32Arg(event, "localPlanId");
  const localOrderId = requiredBytes32Arg(event, "localOrderId");
  const linkedOrderId = requiredBytes32Arg(event, "linkedOrderId");
  const opener = requiredAddressArg(event, "opener");
  const depth = Number(event.args["depth"] ?? 0);
  const proof = proofOf(event, {
    orderId: localOrderId,
    planId: localPlanId,
    submitter: opener
  });

  // 父订单与子订单各自补事件轨迹（订单本体由 OrderRegistered 等建桶）。
  const localOrder = ensureStateMachineOrder(state.orders, event, localOrderId, localPlanId, undefined, stateMachineAddress);
  localOrder.updatedAt = provenanceOf(event);
  appendOrderProof(localOrder, proof);
  appendOrderTimeline(localOrder, timelineOf(event, "委托 dock 已开启", proof, {
    orderId: localOrderId,
    planId: localPlanId,
    linkedOrderId
  }));
  const linkedOrder = ensureStateMachineOrder(
    state.orders,
    event,
    linkedOrderId,
    requiredBytes32Arg(event, "targetPlanId"),
    undefined,
    stateMachineAddress
  );
  linkedOrder.updatedAt = provenanceOf(event);
  appendOrderProof(linkedOrder, proof);
  appendOrderTimeline(linkedOrder, timelineOf(event, "独立子订单已由 dock 创建", proof, {
    orderId: linkedOrderId,
    planId: requiredBytes32Arg(event, "targetPlanId")
  }));

  const dock: MutableStateMachineDockProjection = {
    dockInstanceId,
    chainId: event.chainId,
    stateMachineAddress,
    localPlanId,
    localOrderId,
    routeId: requiredBytes32Arg(event, "routeId"),
    routeHash: requiredBytes32Arg(event, "routeHash"),
    targetPlanId: requiredBytes32Arg(event, "targetPlanId"),
    linkedOrderId,
    depth,
    opener,
    status: "open",
    inputDeliveries: {},
    outputDeliveries: {},
    openedAt: provenanceOf(event),
    updatedAt: provenanceOf(event),
    proof
  };
  state.docks.set(dockProjectionKey(event.chainId, stateMachineAddress, dockInstanceId), dock);
}

function applyDockInputSubmitted(
  state: {
    modules: StateMachineModuleIndex;
    diagnostics: ProjectionReplayDiagnostics;
    orders: Map<string, MutableStateMachineOrderProjection>;
    docks: Map<string, MutableStateMachineDockProjection>;
  },
  event: ChainEvent
): void {
  const dockInstanceId = requiredBytes32Arg(event, "dockInstanceId");
  const dock = findDockForEvent(state, event, dockInstanceId);
  if (!dock) {
    // dock 未开启（或模块归属无法解析）：显式计数，不允许静默丢弃。
    state.diagnostics.unresolvedDockEventCount += 1;
    return;
  }
  const inputBindingHash = requiredBytes32Arg(event, "inputBindingHash");
  const submitter = requiredAddressArg(event, "submitter");
  const proof = proofOf(event, {
    orderId: dock.localOrderId,
    planId: dock.localPlanId,
    submitter
  });
  dock.inputDeliveries[inputBindingHash.toLowerCase()] = {
    inputBindingHash,
    localPlanId: requiredBytes32Arg(event, "localPlanId"),
    localOrderId: requiredBytes32Arg(event, "localOrderId"),
    targetPlanId: requiredBytes32Arg(event, "targetPlanId"),
    linkedOrderId: requiredBytes32Arg(event, "linkedOrderId"),
    targetSignalId: requiredBytes32Arg(event, "targetSignalId"),
    payloadHash: requiredBytes32Arg(event, "payloadHash"),
    submitter,
    deliveredAt: provenanceOf(event),
    proof
  };
  dock.updatedAt = provenanceOf(event);

  // 跨订单事件：父侧记录投递轨迹，子订单侧记录输入事实写入。
  const localOrder = ensureStateMachineOrder(
    state.orders,
    event,
    dock.localOrderId,
    dock.localPlanId,
    undefined,
    dock.stateMachineAddress
  );
  localOrder.updatedAt = provenanceOf(event);
  appendOrderProof(localOrder, proof);
  appendOrderTimeline(localOrder, timelineOf(event, "dock 输入已投递", proof, {
    orderId: dock.localOrderId,
    planId: dock.localPlanId
  }));
  const linkedOrder = ensureStateMachineOrder(
    state.orders,
    event,
    dock.linkedOrderId,
    dock.targetPlanId,
    undefined,
    dock.stateMachineAddress
  );
  linkedOrder.updatedAt = provenanceOf(event);
  appendOrderProof(linkedOrder, proof);
  appendOrderTimeline(linkedOrder, timelineOf(event, "dock 输入事实已投递到子订单", proof, {
    orderId: dock.linkedOrderId,
    planId: dock.targetPlanId
  }));
}

function applyDockOutputSubmitted(
  state: {
    modules: StateMachineModuleIndex;
    diagnostics: ProjectionReplayDiagnostics;
    orders: Map<string, MutableStateMachineOrderProjection>;
    docks: Map<string, MutableStateMachineDockProjection>;
  },
  event: ChainEvent
): void {
  const dockInstanceId = requiredBytes32Arg(event, "dockInstanceId");
  const dock = findDockForEvent(state, event, dockInstanceId);
  if (!dock) {
    // dock 未开启（或模块归属无法解析）：显式计数，不允许静默丢弃。
    state.diagnostics.unresolvedDockEventCount += 1;
    return;
  }
  const outputBindingHash = requiredBytes32Arg(event, "outputBindingHash");
  const submitter = requiredAddressArg(event, "submitter");
  const proof = proofOf(event, {
    orderId: dock.localOrderId,
    planId: dock.localPlanId,
    submitter
  });
  dock.outputDeliveries[outputBindingHash.toLowerCase()] = {
    outputBindingHash,
    localPlanId: requiredBytes32Arg(event, "localPlanId"),
    localOrderId: requiredBytes32Arg(event, "localOrderId"),
    targetPlanId: requiredBytes32Arg(event, "targetPlanId"),
    linkedOrderId: requiredBytes32Arg(event, "linkedOrderId"),
    targetSignalId: requiredBytes32Arg(event, "targetSignalId"),
    localSignalId: requiredBytes32Arg(event, "localSignalId"),
    payloadHash: requiredBytes32Arg(event, "payloadHash"),
    submitter,
    deliveredAt: provenanceOf(event),
    proof
  };
  dock.updatedAt = provenanceOf(event);

  // 跨订单事件：子侧记录输出已回写，父侧记录映射事实落账。
  const linkedOrder = ensureStateMachineOrder(
    state.orders,
    event,
    dock.linkedOrderId,
    dock.targetPlanId,
    undefined,
    dock.stateMachineAddress
  );
  linkedOrder.updatedAt = provenanceOf(event);
  appendOrderProof(linkedOrder, proof);
  appendOrderTimeline(linkedOrder, timelineOf(event, "子订单事实已由 dock 回写", proof, {
    orderId: dock.linkedOrderId,
    planId: dock.targetPlanId
  }));
  const localOrder = ensureStateMachineOrder(
    state.orders,
    event,
    dock.localOrderId,
    dock.localPlanId,
    undefined,
    dock.stateMachineAddress
  );
  localOrder.updatedAt = provenanceOf(event);
  appendOrderProof(localOrder, proof);
  appendOrderTimeline(localOrder, timelineOf(event, "子订单事实已映射回父订单", proof, {
    orderId: dock.localOrderId,
    planId: dock.localPlanId
  }));
}

function applyDockTerminal(
  state: {
    modules: StateMachineModuleIndex;
    diagnostics: ProjectionReplayDiagnostics;
    orders: Map<string, MutableStateMachineOrderProjection>;
    docks: Map<string, MutableStateMachineDockProjection>;
  },
  event: ChainEvent
): void {
  const dockInstanceId = requiredBytes32Arg(event, "dockInstanceId");
  const dock = findDockForEvent(state, event, dockInstanceId);
  if (!dock) {
    // dock 未开启（或模块归属无法解析）：显式计数，不允许静默丢弃。
    state.diagnostics.unresolvedDockEventCount += 1;
    return;
  }
  const terminalCode = Number(event.args["terminal"] ?? 0);
  dock.status = "terminal";
  dock.terminalCode = terminalCode;
  dock.terminalAt = provenanceOf(event);
  dock.terminalProof = proofOf(event, { planId: dock.localPlanId });
  dock.updatedAt = provenanceOf(event);
}

/** dock 事件桶定位：模块地址归一化 + dockInstanceId 键；未开启的 dock 事件忽略。 */
function findDockForEvent(
  state: {
    modules: StateMachineModuleIndex;
    diagnostics: ProjectionReplayDiagnostics;
    docks: Map<string, MutableStateMachineDockProjection>;
  },
  event: ChainEvent,
  dockInstanceId: Hex
): MutableStateMachineDockProjection | undefined {
  const stateMachineAddress = stateMachineAddressForOrderEvent(state, event);
  return state.docks.get(dockProjectionKey(event.chainId, stateMachineAddress, dockInstanceId));
}

function applyDerivedSignalSubmitted(
  state: {
    modules: StateMachineModuleIndex;
    diagnostics: ProjectionReplayDiagnostics;
    orders: Map<string, MutableStateMachineOrderProjection>;
  },
  event: ChainEvent
): void {
  const targetOrderId = requiredBytes32Arg(event, "targetOrderId");
  const planId = optionalBytes32Arg(event, "targetPlanId") ?? optionalBytes32Arg(event, "planId");
  // P0 幻影订单：DerivedSignalSubmitted 由 UVPDerivedSignalModule 发出。
  const order = ensureStateMachineOrderFromModuleEvent(state, event, targetOrderId, planId);
  const proof = proofOf(event, {
    orderId: targetOrderId,
    planId: order.planId,
    planHash: order.planHash,
    submitter: optionalAddressArg(event, "submitter")
  });
  order.updatedAt = provenanceOf(event);
  appendOrderProof(order, proof);
  appendOrderTimeline(order, timelineOf(event, "派生信号已提交", proof, { orderId: targetOrderId, planId: order.planId }));
}

function applyHookStatusChanged(
  state: {
    plans: Map<string, MutableStateMachinePlanProjection>;
    orders: Map<string, MutableStateMachineOrderProjection>;
  },
  event: ChainEvent
): void {
  const orderId = requiredBytes32Arg(event, "orderId");
  const planId = optionalBytes32Arg(event, "planId");
  const order = ensureStateMachineOrder(state.orders, event, orderId, planId);
  const hookId = requiredBytes32Arg(event, "hookId");
  const hookStatus = hookStatusFromArg(event.args["newStatus"]);
  const dueAt = optionalUintArgAsString(event, "dueAt");
  const proof = proofOf(event, { orderId, planId: order.planId, planHash: order.planHash });
  const hook = ensureStateMachineHook(order, event, hookId, proof);
  hook.status = hookStatus;
  if (dueAt && dueAt !== "0") {
    hook.dueAt = dueAt;
  } else {
    delete hook.dueAt;
  }
  hook.updatedAt = provenanceOf(event);
  hook.proof = proof;
  order.status = "registered";
  order.updatedAt = provenanceOf(event);
  if (hookStatus === "cancelled") {
    cancelTask(order, hookId, proof);
  }
  appendOrderProof(order, proof);
  appendOrderTimeline(order, timelineOf(event, hookStatusTimelineText(hookStatus), proof, { orderId, planId: order.planId }));
}

function applyHookReady(
  state: {
    plans: Map<string, MutableStateMachinePlanProjection>;
    orders: Map<string, MutableStateMachineOrderProjection>;
  },
  event: ChainEvent
): void {
  const orderId = requiredBytes32Arg(event, "orderId");
  const planId = optionalBytes32Arg(event, "planId");
  const order = ensureStateMachineOrder(state.orders, event, orderId, planId);
  const hookId = requiredBytes32Arg(event, "hookId");
  const stageIdentifier = requiredBytes32Arg(event, "stageId");
  const hookName = requiredBytes32Arg(event, "hookName");
  const proof = proofOf(event, { orderId, planId: order.planId, planHash: order.planHash });
  const hook = ensureStateMachineHook(order, event, hookId, proof);
  hook.stageIdentifier = stageIdentifier;
  hook.hookName = hookName;
  hook.status = "ready";
  hook.readyAt = provenanceOf(event);
  hook.updatedAt = provenanceOf(event);
  hook.proof = proof;

  const plan = findPlanForOrder(state.plans, order);
  const planSubmitSignals = planSubmitSignalsForStage(plan, stageIdentifier);
  const overlay = findActiveStageOverlayForHook(order, {
    stageIdentifier,
    hookId,
    hookName
  });
  const authorization = findSignalAuthorizationForHook(order, {
    stageIdentifier,
    hookId,
    hookName,
    submitSignals: planSubmitSignals
  });
  const overlayAssignment = overlay ? stageOverlayTaskAssignment(overlay) : undefined;
  const taskId = taskProjectionId(orderId, hookId, order.contractAddress);
  const task: MutableStateMachineTaskProjection = {
    taskId,
    orderId,
    stateMachineAddress: order.contractAddress,
    planId: order.planId,
    ...(order.deploymentId ? { deploymentId: order.deploymentId } : {}),
    hookId,
    stageIdentifier,
    hookName,
    assigneeRole: overlayAssignment?.assigneeRole ?? (authorization ? "authorized_submitter" : "unknown"),
    ...(overlayAssignment ? {
      assigneeWallet: overlayAssignment.assigneeWallet,
      assigneeRoleHash: overlayAssignment.assigneeRoleHash,
      authorizationMetadataHash: overlayAssignment.authorizationMetadataHash
    } : authorization ? {
      assigneeWallet: authorization.submitter,
      assigneeRoleHash: authorization.role,
      authorizationMetadataHash: authorization.metadataHash
    } : {}),
    status: "ready",
    createdAt: provenanceOf(event),
    updatedAt: provenanceOf(event),
    proof
  };
  refreshTaskSubmitSignals(order, task, plan);
  markTaskSubmittedFromExistingSignals(order, task);
  order.tasks[taskId] = task;
  order.currentStage = stageIdentifier;
  order.status = "registered";
  order.updatedAt = provenanceOf(event);
  appendOrderProof(order, proof);
  appendOrderTimeline(order, timelineOf(event, "待办已生成", proof, { orderId, planId: order.planId }));
}

function applyTimerPoked(
  state: {
    plans: Map<string, MutableStateMachinePlanProjection>;
    orders: Map<string, MutableStateMachineOrderProjection>;
  },
  event: ChainEvent
): void {
  const orderId = requiredBytes32Arg(event, "orderId");
  const planId = optionalBytes32Arg(event, "planId");
  const order = ensureStateMachineOrder(state.orders, event, orderId, planId);
  const hookId = requiredBytes32Arg(event, "hookId");
  const dueAt = optionalUintArgAsString(event, "dueAt");
  const proof = proofOf(event, { orderId, planId: order.planId, planHash: order.planHash });
  const hook = ensureStateMachineHook(order, event, hookId, proof);
  if (dueAt && dueAt !== "0") {
    hook.dueAt = dueAt;
  }
  hook.updatedAt = provenanceOf(event);
  hook.proof = proof;
  order.updatedAt = provenanceOf(event);
  appendOrderProof(order, proof);
  appendOrderTimeline(order, timelineOf(event, "时间条件已触发检查", proof, { orderId, planId: order.planId }));
}

function ensureStateMachineOrder(
  orders: Map<string, MutableStateMachineOrderProjection>,
  event: ChainEvent,
  orderId: Hex,
  planId?: Hex,
  deploymentId?: Hex,
  /**
   * P0 幻影订单：订单维度事件由模块合约发出时，桶与订单本体必须归一到
   * 所属状态机地址；缺省保持事件自带地址（状态机直发事件的现状）。
   */
  bucketStateMachineAddress?: Address
): MutableStateMachineOrderProjection {
  const contractAddress = bucketStateMachineAddress ?? event.contractAddress;
  const normalizedContractAddress = contractAddress.toLowerCase() as Address;
  const candidates = [...orders.values()].filter((candidate) =>
    candidate.chainId === event.chainId &&
    candidate.contractAddress.toLowerCase() === normalizedContractAddress &&
    candidate.orderId.toLowerCase() === orderId.toLowerCase()
  );
  const explicitPlanId = planId;
  const orderKey = stateMachineOrderProjectionKey(
    event.chainId,
    normalizedContractAddress,
    explicitPlanId ?? ZERO_BYTES32,
    orderId
  );
  let existing = explicitPlanId ? orders.get(orderKey) : undefined;

  if (!existing && explicitPlanId) {
    const unknown = candidates.filter((candidate) => candidate.planId === ZERO_BYTES32);
    if (unknown.length > 1) {
      throw new ProjectionError(
        `${event.eventName} has multiple unknown projections for ${normalizedContractAddress}:${orderId}; planId is required`
      );
    }
    const unknownOrder = unknown[0];
    if (unknownOrder) {
      const unknownKey = stateMachineOrderProjectionKey(
        event.chainId,
        normalizedContractAddress,
        ZERO_BYTES32,
        orderId
      );
      orders.delete(unknownKey);
      unknownOrder.planId = explicitPlanId;
      existing = unknownOrder;
      orders.set(orderKey, existing);
    }
  }

  if (!existing && !explicitPlanId) {
    if (candidates.length > 1) {
      throw new ProjectionError(
        `${event.eventName} has ambiguous order ${orderId}; planId is required`
      );
    }
    existing = candidates[0];
  }

  if (existing) {
    if (explicitPlanId && existing.planId !== explicitPlanId) {
      throw new ProjectionError(
        `${event.eventName} order ${orderId} belongs to plan ${existing.planId}, not ${explicitPlanId}`
      );
    }
    if (deploymentId && !existing.deploymentId) {
      existing.deploymentId = deploymentId;
    }
    existing.updatedAt = provenanceOf(event);
    return existing;
  }

  const created: MutableStateMachineOrderProjection = {
    orderId,
    chainId: event.chainId,
    contractAddress,
    ...(deploymentId ? { deploymentId } : {}),
    planId: planId ?? ZERO_BYTES32,
    status: planId ? "registered" : "unknown",
    authorizations: {},
    signals: {},
    signalDelegations: {},
    stageExecutorOverlays: {},
    stageResourceOverlays: {},
    hooks: {},
    tasks: {},
    timeline: [],
    proof: [],
    updatedAt: provenanceOf(event)
  };
  orders.set(orderKey, created);
  return created;
}

function ensureStateMachineHook(
  order: MutableStateMachineOrderProjection,
  event: ChainEvent,
  hookId: Hex,
  proof: StateMachineProofProjection
): MutableStateMachineHookProjection {
  const existing = order.hooks[hookId];
  if (existing) {
    return existing;
  }

  const created: MutableStateMachineHookProjection = {
    orderId: order.orderId,
    hookId,
    status: "unknown",
    updatedAt: provenanceOf(event),
    proof
  };
  order.hooks[hookId] = created;
  return created;
}

function appendOrderProof(order: MutableStateMachineOrderProjection, proof: StateMachineProofProjection): void {
  if (order.proof.some((item) => item.eventId === proof.eventId)) {
    return;
  }
  order.proof.push(proof);
}

function appendOrderTimeline(
  order: MutableStateMachineOrderProjection,
  timelineEvent: StateMachineTimelineEventProjection
): void {
  if (order.timeline.some((item) => item.timelineId === timelineEvent.timelineId)) {
    return;
  }
  order.timeline.push(timelineEvent);
}

function markMatchingTasksSubmitted(
  order: MutableStateMachineOrderProjection,
  sourceId: Hex,
  signalId: Hex,
  proof: StateMachineProofProjection
): void {
  let changed = false;
  for (const task of Object.values(order.tasks)) {
    if (!taskMatchesSubmittedSignal(task, sourceId, signalId)) {
      continue;
    }
    changed = markTaskSubmitted(task, proof) || changed;
  }

  void changed;
}

function refreshTaskSubmitSignals(
  order: MutableStateMachineOrderProjection,
  task: MutableStateMachineTaskProjection,
  plan?: MutableStateMachinePlanProjection
): void {
  const signals: StateMachineTaskSubmitSignalProjection[] = [...planSubmitSignalsForStage(plan, task.stageIdentifier)];
  for (const authorization of Object.values(order.authorizations)) {
    if (!signalAuthorizationMatchesHook(authorization, { ...task, submitSignals: signals })) {
      continue;
    }
    signals.push({
      sourceId: authorization.sourceId,
      signalId: authorization.signalId,
      source: "authorization"
    });
  }
  // F25：合约 _authorizeSignalSubmitter 不校验 plan 能力词表——授权可以
  // 落链在词表之外。任务完成判定以链上事实为准：词表外授权通过两个链上
  // 绑定键挂到任务：sourceId/signalId 即任务 hookId（既有回退键），或
  // StageExecutorSignalDelegated 显式携带的 targetStageId 阶段归属。
  // 否则 SignalSubmitted 落链后任务永远停在 ready。
  for (const authorization of Object.values(order.authorizations)) {
    if (task.hookId === authorization.sourceId || task.hookId === authorization.signalId) {
      signals.push({
        sourceId: authorization.sourceId,
        signalId: authorization.signalId,
        source: "authorization"
      });
    }
  }
  for (const delegation of Object.values(order.signalDelegations)) {
    if (delegation.targetStageId === task.stageIdentifier) {
      signals.push({
        sourceId: delegation.sourceId,
        signalId: delegation.signalId,
        source: "authorization"
      });
    }
  }
  task.submitSignals = dedupeTaskSubmitSignals(signals);
  if (task.submitSignals.length === 0) {
    delete task.submitSignals;
  }
}

function planSubmitSignalsForStage(
  plan: MutableStateMachinePlanProjection | undefined,
  stageId: Hex
): readonly StateMachineTaskSubmitSignalProjection[] {
  return (plan?.signalCapabilities ?? [])
    .filter((capability) => capability.stageId === stageId && capability.targetOrderRelation === "current")
    .map((capability) => ({
      sourceId: capability.targetSourceId,
      signalId: capability.signalId,
      source: "plan_capability" as const
    }));
}

function addTaskSubmitSignal(
  task: MutableStateMachineTaskProjection,
  signal: StateMachineTaskSubmitSignalProjection
): void {
  task.submitSignals = dedupeTaskSubmitSignals([...(task.submitSignals ?? []), signal]);
}

function dedupeTaskSubmitSignals(
  signals: readonly StateMachineTaskSubmitSignalProjection[]
): readonly StateMachineTaskSubmitSignalProjection[] {
  const byKey = new Map<string, StateMachineTaskSubmitSignalProjection>();
  for (const signal of signals) {
    const key = signalProjectionKey(signal.sourceId, signal.signalId);
    const existing = byKey.get(key);
    if (!existing || existing.source !== "plan_capability") {
      byKey.set(key, signal);
    }
  }
  return [...byKey.values()].sort(compareTaskSubmitSignals);
}

function compareTaskSubmitSignals(
  left: StateMachineTaskSubmitSignalProjection,
  right: StateMachineTaskSubmitSignalProjection
): number {
  const sourcePriority = taskSubmitSignalSourcePriority(left.source) - taskSubmitSignalSourcePriority(right.source);
  return sourcePriority || left.sourceId.localeCompare(right.sourceId) || left.signalId.localeCompare(right.signalId);
}

function taskSubmitSignalSourcePriority(source: StateMachineTaskSubmitSignalProjection["source"]): number {
  return source === "plan_capability" ? 0 : 1;
}

function taskMatchesSubmittedSignal(
  task: StateMachineTaskProjection,
  sourceId: Hex,
  signalId: Hex
): boolean {
  if ((task.submitSignals ?? []).some((signal) => signal.sourceId === sourceId && signal.signalId === signalId)) {
    return true;
  }
  return task.hookId === sourceId || task.hookId === signalId;
}

function markTaskSubmittedFromExistingSignals(
  order: MutableStateMachineOrderProjection,
  task: MutableStateMachineTaskProjection
): boolean {
  const matchingProof = Object.values(order.signals)
    .filter((signal) => taskMatchesSubmittedSignal(task, signal.sourceId, signal.signalId))
    .map((signal) => signal.proof)
    .sort(compareProofEvents)[0];
  return matchingProof ? markTaskSubmitted(task, matchingProof) : false;
}

function markTaskSubmitted(
  task: MutableStateMachineTaskProjection,
  proof: StateMachineProofProjection
): boolean {
  if (task.status === "submitted" && task.proof.eventId === proof.eventId) {
    return false;
  }
  task.status = "submitted";
  task.updatedAt = proof;
  task.proof = proof;
  return true;
}

function markMatchingTasksAssigned(
  order: MutableStateMachineOrderProjection,
  authorization: StateMachineSignalAuthorizationProjection
): void {
  let changed = false;
  for (const task of Object.values(order.tasks)) {
    if (findActiveStageOverlayForHook(order, task)) {
      continue;
    }
    if (!signalAuthorizationMatchesHook(authorization, task)) {
      continue;
    }
    task.assigneeRole = "authorized_submitter";
    task.assigneeWallet = authorization.submitter;
    task.assigneeRoleHash = authorization.role;
    task.authorizationMetadataHash = authorization.metadataHash;
    task.updatedAt = authorization.authorizedAt;
    addTaskSubmitSignal(task, {
      sourceId: authorization.sourceId,
      signalId: authorization.signalId,
      source: "authorization"
    });
    changed = markTaskSubmittedFromExistingSignals(order, task) || changed;
  }
  void changed;
}

function markTargetStageTasksAssignedFromOverlay(
  order: MutableStateMachineOrderProjection,
  overlay: StateMachineStageExecutorOverlayProjection
): void {
  for (const task of Object.values(order.tasks)) {
    if (task.stageIdentifier !== overlay.targetStageId) {
      continue;
    }
    task.assigneeRole = "stage_overlay_executor";
    task.assigneeWallet = overlay.activeExecutorWallet;
    task.assigneeRoleHash = overlay.roleHash;
    task.authorizationMetadataHash = overlay.executorMetadataHash;
    task.updatedAt = overlay.updatedAt;
  }
}

/**
 * F25：StageExecutorSignalDelegated 的阶段绑定把委派信号挂到目标阶段的
 * 任务上（submitSignals + 指派委派执行方），使词表外已授权/已提交的信号
 * 能把任务推进到 submitted——投影忠于链上事实。
 */
function markTargetStageTasksAssignedFromDelegation(
  order: MutableStateMachineOrderProjection,
  delegation: StateMachineSignalDelegationProjection
): void {
  for (const task of Object.values(order.tasks)) {
    if (task.stageIdentifier !== delegation.targetStageId) {
      continue;
    }
    task.assigneeRole = "delegated_stage_executor";
    task.assigneeWallet = delegation.executor;
    task.assigneeRoleHash = delegation.roleHash;
    task.authorizationMetadataHash = delegation.metadataHash;
    task.updatedAt = delegation.delegatedAt;
    addTaskSubmitSignal(task, {
      sourceId: delegation.sourceId,
      signalId: delegation.signalId,
      source: "authorization"
    });
    markTaskSubmittedFromExistingSignals(order, task);
  }
}

function cancelTask(
  order: MutableStateMachineOrderProjection,
  hookId: Hex,
  proof: StateMachineProofProjection
): void {
  const task = order.tasks[taskProjectionId(order.orderId, hookId, order.contractAddress)];
  if (!task) {
    return;
  }
  task.status = "cancelled";
  task.updatedAt = proof;
  task.proof = proof;
}

function proofOf(event: ChainEvent, metadata: StateMachineProofMetadata = {}): StateMachineProofProjection {
  return {
    ...provenanceOf(event),
    eventId: chainEventKey(event),
    eventName: event.eventName,
    args: normalizeProofArgs(event.args),
    ...(event.blockHash ? { blockHash: event.blockHash } : {}),
    ...(metadata.orderId ? { orderId: metadata.orderId } : {}),
    ...(metadata.planId ? { planId: metadata.planId } : {}),
    ...(metadata.planHash ? { planHash: metadata.planHash } : {}),
    ...(metadata.submitter ? { submitter: metadata.submitter } : {})
  };
}

interface StateMachineProofMetadata {
  readonly orderId?: Hex | undefined;
  readonly linkedOrderId?: Hex | undefined;
  readonly triggerOriginOrderId?: Hex | undefined;
  readonly originSourceId?: Hex | undefined;
  readonly originSignalId?: Hex | undefined;
  readonly planId?: Hex | undefined;
  readonly planHash?: Hex | undefined;
  readonly sourceId?: Hex | undefined;
  readonly signalId?: Hex | undefined;
  readonly submitter?: Address | undefined;
}

function normalizeProofArgs(args: ChainEvent["args"]): EventProofArgs {
  return Object.fromEntries(
    Object.entries(args).map(([key, value]) => [key, normalizeProofArg(value)])
  );
}

function normalizeProofArg(value: unknown): string | number | boolean | null {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "string") {
    // 事件源解码边界已按 ABI 类型归一化（bytes/address 小写、
    // string 保持原文）。这里不对 0x 开头的字符串二次小写化——
    // metadataURI 等 string 参数大小写敏感，改写不可逆。
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }
  if (value === undefined) {
    return null;
  }
  return JSON.stringify(value);
}

function timelineOf(
  _event: ChainEvent,
  text: string,
  proof: StateMachineProofProjection,
  metadata: StateMachineProofMetadata = {}
): StateMachineTimelineEventProjection {
  return {
    timelineId: proof.eventId,
    eventName: proof.eventName,
    text,
    time: `block ${proof.blockNumber.toString()}`,
    proof,
    ...(metadata.orderId ? { orderId: metadata.orderId } : {}),
    ...(metadata.planId ? { planId: metadata.planId } : {})
  };
}

function taskProjectionId(orderId: Hex, hookId: Hex, stateMachineAddress?: Address): string {
  return stateMachineAddress ? `${stateMachineAddress}:${orderId}:${hookId}` : `${orderId}:${hookId}`;
}

/**
 * Canonical identity for an order projection.  `orderId` is only unique inside
 * a plan, so every storage/read path must use this four-part key when it has
 * plan context available.
 */
export function stateMachineOrderProjectionKey(
  chainId: number,
  stateMachineAddress: Address,
  planId: Hex,
  orderId: Hex
): string {
  return `${chainId}:${stateMachineAddress.toLowerCase()}:${planId.toLowerCase()}:${orderId.toLowerCase()}`;
}

/** Canonical identity for a task projection under a plan-scoped order. */
export function stateMachineTaskProjectionKey(
  chainId: number,
  stateMachineAddress: Address,
  planId: Hex,
  orderId: Hex,
  hookId: Hex
): string {
  return `${stateMachineOrderProjectionKey(chainId, stateMachineAddress, planId, orderId)}:${hookId.toLowerCase()}`;
}

function signalProjectionKey(sourceId: Hex, signalId: Hex): string {
  return `${sourceId}:${signalId}`;
}

function signalAuthorizationProjectionKey(sourceId: Hex, signalId: Hex, submitter: Address): string {
  return `${sourceId}:${signalId}:${submitter.toLowerCase()}`;
}

function stageExecutorOverlayProjectionKey(targetStageId: Hex): string {
  return targetStageId.toLowerCase();
}

function stageResourceOverlayProjectionKey(targetStageId: Hex, resourceKey: Hex): string {
  return `${targetStageId.toLowerCase()}:${resourceKey.toLowerCase()}`;
}

function dockProjectionKey(chainId: number, stateMachineAddress: Address, dockInstanceId: Hex): string {
  return stateMachineScopedKey(chainId, stateMachineAddress, dockInstanceId);
}

function findActiveStageOverlayForHook(
  order: MutableStateMachineOrderProjection,
  hook: SignalAuthorizationHookMatchInput
): StateMachineStageExecutorOverlayProjection | undefined {
  return order.stageExecutorOverlays[stageExecutorOverlayProjectionKey(hook.stageIdentifier)];
}

function stageOverlayTaskAssignment(
  overlay: StateMachineStageExecutorOverlayProjection
): {
  readonly assigneeRole: string;
  readonly assigneeWallet: Address;
  readonly assigneeRoleHash: Hex;
  readonly authorizationMetadataHash: Hex;
} {
  return {
    assigneeRole: "stage_overlay_executor",
    assigneeWallet: overlay.activeExecutorWallet,
    assigneeRoleHash: overlay.roleHash,
    authorizationMetadataHash: overlay.executorMetadataHash
  };
}

function findSignalAuthorizationForHook(
  order: MutableStateMachineOrderProjection,
  hook: SignalAuthorizationHookMatchInput
): StateMachineSignalAuthorizationProjection | undefined {
  return Object.values(order.authorizations)
    .sort(compareSignalAuthorizations)
    .find((authorization) => signalAuthorizationMatchesHook(authorization, hook));
}

export interface SignalAuthorizationHookMatchInput {
  readonly stageIdentifier: Hex;
  readonly hookId: Hex;
  readonly hookName: Hex;
  readonly submitSignals?: readonly StateMachineTaskSubmitSignalProjection[];
}

export function signalAuthorizationMatchesHook(
  authorization: StateMachineSignalAuthorizationProjection,
  hook: SignalAuthorizationHookMatchInput
): boolean {
  // F25：除 plan 词表外，sourceId/signalId 即 hookId 是链上授权与任务的
  // 另一个事实绑定键（taskMatchesSubmittedSignal 的既有回退口径一致）。
  if (hook.hookId === authorization.sourceId || hook.hookId === authorization.signalId) {
    return true;
  }
  return authorizationMatchesSubmitSignals(authorization, hook.submitSignals ?? []);
}

function authorizationMatchesSubmitSignals(
  authorization: StateMachineSignalAuthorizationProjection,
  submitSignals: readonly StateMachineTaskSubmitSignalProjection[]
): boolean {
  return submitSignals.some((signal) =>
    signal.sourceId === authorization.sourceId && signal.signalId === authorization.signalId
  );
}

/**
 * Plan/module/dock scope key: `chainId:stateMachineAddress:id`.  The
 * four-argument overload resolves to the plan-scoped order projection key so
 * order callers share one helper without changing plan/module key shapes.
 */
export function stateMachineScopedKey(chainId: number, stateMachineAddress: Address, id: Hex): string;
export function stateMachineScopedKey(
  chainId: number,
  stateMachineAddress: Address,
  planId: Hex,
  orderId: Hex,
): string;
export function stateMachineScopedKey(
  chainId: number,
  stateMachineAddress: Address,
  idOrPlanId: Hex,
  orderId?: Hex,
): string {
  return orderId === undefined
    ? `${chainId}:${stateMachineAddress.toLowerCase()}:${idOrPlanId.toLowerCase()}`
    : stateMachineOrderProjectionKey(chainId, stateMachineAddress, idOrPlanId, orderId);
}

function deploymentProjectionKey(chainId: number, registryAddress: Address, deploymentId: Hex): string {
  return `${chainId}:${registryAddress.toLowerCase()}:${deploymentId.toLowerCase()}`;
}

function findDeploymentById(
  deployments: Map<string, MutableStateMachineDeploymentProjection>,
  deploymentId: Hex
): MutableStateMachineDeploymentProjection | undefined {
  const normalizedDeploymentId = deploymentId.toLowerCase();
  return [...deployments.values()].find((deployment) => deployment.deploymentId.toLowerCase() === normalizedDeploymentId);
}

function findDeploymentByStateMachine(
  deployments: Map<string, MutableStateMachineDeploymentProjection>,
  chainId: number,
  stateMachineAddress: Address
): MutableStateMachineDeploymentProjection | undefined {
  const normalizedStateMachine = stateMachineAddress.toLowerCase();
  return [...deployments.values()]
    .filter((deployment) =>
      deployment.registeredAt.chainId === chainId && deployment.stateMachineAddress.toLowerCase() === normalizedStateMachine
    )
    .sort(compareDeploymentSelection)[0];
}

function orderDeploymentIdFromPlanOrStateMachine(
  plan: MutableStateMachinePlanProjection | undefined,
  deployments: Map<string, MutableStateMachineDeploymentProjection>,
  chainId: number,
  stateMachineAddress: Address
): Hex | undefined {
  return plan?.deploymentId ?? findDeploymentByStateMachine(deployments, chainId, stateMachineAddress)?.deploymentId;
}

function compareDeploymentSelection(
  left: StateMachineDeploymentProjection,
  right: StateMachineDeploymentProjection
): number {
  const status = deploymentStatusPriority(left.status) - deploymentStatusPriority(right.status);
  if (status !== 0) {
    return status;
  }
  const position = compareChainPointers(right.updatedAt, left.updatedAt);
  if (position !== 0) {
    return position;
  }
  return left.deploymentId.localeCompare(right.deploymentId);
}

function deploymentStatusPriority(status: StateMachineDeploymentStatus): number {
  switch (status) {
    case "active":
      return 0;
    case "canary":
      return 1;
    case "candidate":
      return 2;
    case "deprecated":
      return 3;
    case "retired":
      return 4;
    default:
      return 5;
  }
}

function findPlanForEvent(
  plans: Map<string, MutableStateMachinePlanProjection>,
  modules: StateMachineModuleIndex,
  event: ChainEvent,
  planId: Hex
): MutableStateMachinePlanProjection | undefined {
  // P0 幻影订单同病：plan 维度事件可能由模块合约发出；先用
  // stateMachineModules 归一化到所属状态机地址再查 exact key，消除同
  // planId 跨部署时回退扫描歧义（matches.length !== 1）→ ProjectionError
  // → 索引器永久 degraded 的路径。
  const { stateMachineAddress } = resolveStateMachineAddressForModuleEvent(modules, event);
  const exact = plans.get(stateMachineScopedKey(event.chainId, stateMachineAddress, planId));
  if (exact) {
    return exact;
  }
  const matches = [...plans.values()].filter((plan) =>
    plan.registeredAt.chainId === event.chainId && plan.planId === planId
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function findPlanForOrder(
  plans: Map<string, MutableStateMachinePlanProjection>,
  order: MutableStateMachineOrderProjection
): MutableStateMachinePlanProjection | undefined {
  return plans.get(stateMachineScopedKey(order.chainId, order.contractAddress, order.planId));
}

function hookStatusFromArg(value: unknown): StateMachineHookStatus {
  const status = typeof value === "bigint" ? Number(value) : typeof value === "string" ? Number(value) : value;
  switch (status) {
    case 0:
      return "init";
    case 1:
      return "waiting";
    case 2:
      return "ready";
    case 3:
      return "cancelled";
    default:
      return "unknown";
  }
}

function hookStatusTimelineText(status: StateMachineHookStatus): string {
  switch (status) {
    case "waiting":
      return "等待时间条件";
    case "ready":
      return "条件已满足";
    case "cancelled":
      return "条件已取消";
    case "init":
      return "阶段条件已初始化";
    case "unknown":
      return "阶段条件已变化";
  }
}

function compareTimelineEvents(
  left: StateMachineTimelineEventProjection,
  right: StateMachineTimelineEventProjection
): number {
  return compareProofEvents(left.proof, right.proof);
}

function compareProofEvents(left: StateMachineProofProjection, right: StateMachineProofProjection): number {
  const position = compareChainPointers(left, right);
  if (position !== 0) {
    return position;
  }
  return left.eventId.localeCompare(right.eventId);
}

function compareSignalAuthorizations(
  left: StateMachineSignalAuthorizationProjection,
  right: StateMachineSignalAuthorizationProjection
): number {
  return compareProofEvents(left.proof, right.proof);
}

function compareUintStrings(left: string, right: string): number {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue === rightValue ? 0 : leftValue < rightValue ? -1 : 1;
}

function provenanceOf(pointer: ChainPointer): ProjectionProvenance {
  return {
    chainId: pointer.chainId,
    contractAddress: pointer.contractAddress,
    blockNumber: pointer.blockNumber,
    ...(pointer.transactionIndex !== undefined ? { transactionIndex: pointer.transactionIndex } : {}),
    transactionHash: pointer.transactionHash,
    logIndex: pointer.logIndex
  };
}

function requiredStringArg(event: ChainEvent, name: string): string {
  const value = event.args[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new ProjectionError(`${event.eventName}.${name} must be a non-empty string`);
  }
  return value;
}

function optionalStringArg(event: ChainEvent, name: string): string | undefined {
  const value = event.args[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requiredAddressArg(event: ChainEvent, name: string): Address {
  return normalizeAddress(requiredStringArg(event, name), `${event.eventName}.${name}`);
}

function optionalAddressArg(event: ChainEvent, name: string): Address | undefined {
  const value = optionalStringArg(event, name);
  return value ? normalizeAddress(value, `${event.eventName}.${name}`) : undefined;
}

function requiredBytes32Arg(event: ChainEvent, name: string): Hex {
  return normalizeBytes32(requiredStringArg(event, name), `${event.eventName}.${name}`);
}

function optionalBytes32Arg(event: ChainEvent, name: string): Hex | undefined {
  const value = optionalStringArg(event, name);
  return value ? normalizeBytes32(value, `${event.eventName}.${name}`) : undefined;
}

function optionalNonZeroBytes32Arg(event: ChainEvent, name: string): Hex | undefined {
  const value = optionalBytes32Arg(event, name);
  return value && value !== ZERO_BYTES32 ? value : undefined;
}

function executorPatchModeFromArg(modeHash: Hex | undefined): StateMachineStageExecutorPatchMode {
  if (!modeHash) {
    return "assign";
  }
  if (modeHash === EXECUTOR_PATCH_MODE_VALUES.assign) {
    return "assign";
  }
  if (modeHash === EXECUTOR_PATCH_MODE_VALUES.handoff) {
    return "handoff";
  }
  if (modeHash === EXECUTOR_PATCH_MODE_VALUES.replacement) {
    return "replacement";
  }
  throw new ProjectionError(`StageExecutorPatchApplied.mode is not a supported executor patch mode`);
}

function selectorBindingsArg(event: ChainEvent): readonly StateMachineStageSelectorBindingProjection[] {
  const value = event.args["selectorBindings"];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item, index) => selectorBindingArg(item, event, index));
}

function signalCapabilitiesArg(event: ChainEvent): readonly StateMachineSignalCapabilityProjection[] {
  const value = event.args["signalCapabilities"];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item, index) => signalCapabilityArg(item, event, index)).sort(compareSignalCapabilities);
}

function signalCapabilityArg(
  value: unknown,
  event: ChainEvent,
  index: number
): StateMachineSignalCapabilityProjection {
  if (Array.isArray(value)) {
    return {
      stageId: normalizeBytes32(String(value[0] ?? ""), `${event.eventName}.signalCapabilities[${index}].stageId`),
      targetSourceId: normalizeBytes32(String(value[1] ?? ""), `${event.eventName}.signalCapabilities[${index}].targetSourceId`),
      signalId: normalizeBytes32(String(value[2] ?? ""), `${event.eventName}.signalCapabilities[${index}].signalId`),
      targetOrderRelation: signalTargetRelationFromArg(value[3]),
      registeredAt: provenanceOf(event),
      proof: proofOf(event)
    };
  }
  if (!value || typeof value !== "object") {
    throw new ProjectionError(`${event.eventName}.signalCapabilities[${index}] must be an object`);
  }
  const record = value as Record<string, unknown>;
  return {
    stageId: bytes32RecordField(record, "stageId", `${event.eventName}.signalCapabilities[${index}].stageId`),
    targetSourceId: bytes32RecordField(record, "targetSourceId", `${event.eventName}.signalCapabilities[${index}].targetSourceId`),
    signalId: bytes32RecordField(record, "signalId", `${event.eventName}.signalCapabilities[${index}].signalId`),
    targetOrderRelation: signalTargetRelationFromArg(record["targetOrderRelation"] ?? record["relation"]),
    registeredAt: provenanceOf(event),
    proof: proofOf(event)
  };
}

function signalCapabilityFromEvent(event: ChainEvent): StateMachineSignalCapabilityProjection {
  return {
    stageId: requiredBytes32Arg(event, "stageId"),
    targetSourceId: requiredBytes32Arg(event, "targetSourceId"),
    signalId: requiredBytes32Arg(event, "signalId"),
    targetOrderRelation: signalTargetRelationFromArg(event.args["targetOrderRelation"] ?? event.args["relation"]),
    registeredAt: provenanceOf(event),
    proof: proofOf(event, { planId: requiredBytes32Arg(event, "planId") })
  };
}

function signalCapabilityEquals(
  left: StateMachineSignalCapabilityProjection,
  right: StateMachineSignalCapabilityProjection
): boolean {
  return left.stageId === right.stageId &&
    left.targetSourceId === right.targetSourceId &&
    left.signalId === right.signalId &&
    left.targetOrderRelation === right.targetOrderRelation;
}

/** PlanRegistered 合并语义：finalize 模块事件与事件 args 的并集（去重）。 */
function mergeSignalCapabilities(
  existing: readonly StateMachineSignalCapabilityProjection[],
  incoming: readonly StateMachineSignalCapabilityProjection[]
): StateMachineSignalCapabilityProjection[] {
  const merged = [...existing];
  for (const capability of incoming) {
    if (!merged.some((item) => signalCapabilityEquals(item, capability))) {
      merged.push(capability);
    }
  }
  return merged.sort(compareSignalCapabilities);
}

function mergeSelectorBindings(
  existing: readonly StateMachineStageSelectorBindingProjection[],
  incoming: readonly StateMachineStageSelectorBindingProjection[]
): StateMachineStageSelectorBindingProjection[] {
  const merged = [...existing];
  for (const binding of incoming) {
    if (!merged.some((item) => item.selectorStageId === binding.selectorStageId && item.targetStageId === binding.targetStageId)) {
      merged.push(binding);
    }
  }
  return merged;
}

function compareSignalCapabilities(
  left: StateMachineSignalCapabilityProjection,
  right: StateMachineSignalCapabilityProjection
): number {
  return left.stageId.localeCompare(right.stageId) ||
    left.targetSourceId.localeCompare(right.targetSourceId) ||
    left.signalId.localeCompare(right.signalId) ||
    left.targetOrderRelation.localeCompare(right.targetOrderRelation);
}

function signalTargetRelationFromArg(value: unknown): StateMachineSignalTargetRelation {
  if (value === "current" || value === "triggerOrigin") {
    return value;
  }
  const relation = typeof value === "bigint" ? Number(value) : typeof value === "string" ? Number(value) : value;
  if (relation === 0) {
    return "current";
  }
  if (relation === 1) {
    return "triggerOrigin";
  }
  return "unknown";
}

function selectorBindingArg(
  value: unknown,
  event: ChainEvent,
  index: number
): StateMachineStageSelectorBindingProjection {
  if (Array.isArray(value)) {
    const selectorStageId = normalizeBytes32(String(value[0] ?? ""), `${event.eventName}.selectorBindings[${index}].selectorStageId`);
    const targetStageId = normalizeBytes32(String(value[1] ?? ""), `${event.eventName}.selectorBindings[${index}].targetStageId`);
    return { selectorStageId, targetStageId };
  }
  if (!value || typeof value !== "object") {
    throw new ProjectionError(`${event.eventName}.selectorBindings[${index}] must be an object`);
  }
  const record = value as Record<string, unknown>;
  const selectorStageId = bindingBytes32(record, "selectorStageId", event, index);
  const targetStageId = bindingBytes32(record, "targetStageId", event, index);
  const selectorStageIdentifier = bindingString(record, "selectorStageIdentifier");
  const targetStageIdentifier = bindingString(record, "targetStageIdentifier");
  const bindingHash = bindingOptionalBytes32(record, "bindingHash", event, index);
  return {
    ...(selectorStageIdentifier ? { selectorStageIdentifier } : {}),
    ...(targetStageIdentifier ? { targetStageIdentifier } : {}),
    selectorStageId,
    targetStageId,
    ...(bindingHash ? { bindingHash } : {})
  };
}

function bindingBytes32(
  record: Record<string, unknown>,
  field: string,
  event: ChainEvent,
  index: number
): Hex {
  const value = record[field];
  if (typeof value !== "string") {
    throw new ProjectionError(`${event.eventName}.selectorBindings[${index}].${field} must be a 32-byte hex string`);
  }
  return normalizeBytes32(value, `${event.eventName}.selectorBindings[${index}].${field}`);
}

function bytes32RecordField(record: Record<string, unknown>, field: string, context: string): Hex {
  const value = record[field];
  if (typeof value !== "string") {
    throw new ProjectionError(`${context} must be a 32-byte hex string`);
  }
  return normalizeBytes32(value, context);
}

function bindingOptionalBytes32(
  record: Record<string, unknown>,
  field: string,
  event: ChainEvent,
  index: number
): Hex | undefined {
  const value = record[field];
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new ProjectionError(`${event.eventName}.selectorBindings[${index}].${field} must be a 32-byte hex string`);
  }
  return normalizeBytes32(value, `${event.eventName}.selectorBindings[${index}].${field}`);
}

function bindingString(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function uintArgAsString(event: ChainEvent, name: string): string {
  const value = optionalUintArgAsString(event, name);
  if (!value) {
    throw new ProjectionError(`${event.eventName}.${name} must be a uint value`);
  }
  return value;
}

function optionalUintArgAsString(event: ChainEvent, name: string): string | undefined {
  const value = event.args[name];
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value.toString();
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return value;
  }
  return undefined;
}
