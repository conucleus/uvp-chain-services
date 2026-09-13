// 订单族：订单维度链事件（OrderRegistered/Materialized/RelayerRecorded/
// Triggered/Linked 与 StateMachineModuleSet 模块登记）、订单投影桶构造与
// 复合键（chainId:stateMachineAddress:planId:orderId）。
import type { ChainEvent } from "../events.js";
import { ProjectionError, type Address, type Hex } from "../../shared/types.js";
import {
  ZERO_BYTES32,
  optionalBytes32Arg,
  proofOf,
  provenanceOf,
  requiredAddressArg,
  requiredBytes32Arg,
  timelineOf,
  type ProjectionProvenance,
  type StateMachineProofProjection,
  type StateMachineTimelineEventProjection
} from "./proof.js";
import {
  findDeploymentByStateMachine,
  orderDeploymentIdFromPlanOrStateMachine,
  type MutableStateMachineDeploymentProjection,
  type ProjectionReplayDiagnostics,
  type Writable
} from "./snapshot.js";
import type { MutableStateMachinePlanProjection } from "./plan.js";
import type {
  StateMachineSignalAuthorizationProjection,
  StateMachineSignalDelegationProjection,
  StateMachineSignalProjection
} from "./signal.js";
import type {
  MutableStateMachineHookProjection,
  StateMachineHookProjection,
  StateMachineStageExecutorOverlayProjection,
  StateMachineStageResourceOverlayProjection
} from "./stage.js";
import type { MutableStateMachineTaskProjection, StateMachineTaskProjection } from "./task.js";

export type OrderStatus = "registered";
export type StageStatus = "approved" | "released" | "refunded" | "disputed" | "resolved";

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

export interface StateMachineOrderTriggerLinkProjection {
  readonly triggeredOrderId: Hex;
  readonly triggerOriginOrderId: Hex;
  readonly triggerStageId: Hex;
  readonly originSourceId: Hex;
  readonly originSignalId: Hex;
  readonly linkedAt: ProjectionProvenance;
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

export type MutableStateMachineModuleProjection = Writable<StateMachineModuleProjection>;

export type MutableStateMachineOrderProjection = Writable<
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

export type StateMachineModuleIndex = ReadonlyMap<string, MutableStateMachineModuleProjection>;

export function applyStateMachineModuleSet(
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
export function resolveStateMachineAddressForModuleEvent(
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
export function stateMachineAddressForOrderEvent(
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
export function ensureStateMachineOrderFromModuleEvent(
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

export function applyOrderRegistered(
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

export function applyOrderMaterialized(
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

export function applyOrderRelayerRecorded(
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

export function applyOrderTriggered(
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
  // v0.10 起携带 triggerHookId（出生 hook 定位）；旧事件无此字段按可选处理。
  const triggerHookId = optionalBytes32Arg(event, "triggerHookId");
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
  appendOrderTimeline(order, timelineOf(event, "触发信号已启动订单", proof, {
    orderId,
    planId,
    sourceId,
    signalId,
    ...(triggerHookId !== undefined ? { triggerHookId } : {})
  }));
}

export function applyOrderLinked(
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

export function ensureStateMachineOrder(
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

export function appendOrderProof(order: MutableStateMachineOrderProjection, proof: StateMachineProofProjection): void {
  if (order.proof.some((item) => item.eventId === proof.eventId)) {
    return;
  }
  order.proof.push(proof);
}

export function appendOrderTimeline(
  order: MutableStateMachineOrderProjection,
  timelineEvent: StateMachineTimelineEventProjection
): void {
  if (order.timeline.some((item) => item.timelineId === timelineEvent.timelineId)) {
    return;
  }
  order.timeline.push(timelineEvent);
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
