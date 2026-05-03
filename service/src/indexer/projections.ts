import { chainEventKey, filterActiveChainEvents, type ChainEvent } from "./events.js";
import {
  ProjectionError,
  normalizeAddress,
  normalizeBytes32,
  type Address,
  type ChainPointer,
  type Hex
} from "../shared/types.js";
import {
  EXECUTOR_PATCH_MODE_ASSIGN,
  EXECUTOR_PATCH_MODE_HANDOFF,
  EXECUTOR_PATCH_MODE_REPLACEMENT
} from "../stage-patches/typed-data.js";

export type OrderStatus = "created" | "funded" | "active" | "in_dispute" | "settled";
export type StageStatus = "approved" | "released" | "refunded" | "disputed" | "resolved";

export interface ProjectionProvenance {
  readonly chainId: number;
  readonly contractAddress: Address;
  readonly blockNumber: bigint;
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

export type StateMachineOrderStatus =
  | "registered"
  | "running"
  | "waiting"
  | "action_required"
  | "completed"
  | "cancelled"
  | "unknown";
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
  readonly selectorBindings: readonly StateMachineStageSelectorBindingProjection[];
  readonly registeredAt: ProjectionProvenance;
  readonly updatedAt: ProjectionProvenance;
  readonly proof: StateMachineProofProjection;
}

export interface StateMachineStageSelectorBindingProjection {
  readonly selectorStageIdentifier?: string;
  readonly targetStageIdentifier?: string;
  readonly selectorStageId: Hex;
  readonly targetStageId: Hex;
  readonly bindingHash?: Hex;
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

export interface StateMachineDockedSignalBindingProjection {
  readonly localOrderId: Hex;
  readonly linkedOrderId: Hex;
  readonly localSourceId: Hex;
  readonly localSignalId: Hex;
  readonly linkedSourceId: Hex;
  readonly linkedSignalId: Hex;
  readonly updatedAt: ProjectionProvenance;
  readonly proof: StateMachineProofProjection;
}

export interface StateMachineDockedOrderLinkProjection {
  readonly localOrderId: Hex;
  readonly selectorStageId: Hex;
  readonly localSourceId: Hex;
  readonly linkedOrderId: Hex;
  readonly linkedPlanId: Hex;
  readonly selectorWallet: Address;
  readonly linkHash: Hex;
  readonly linkNonce: string;
  readonly metadataURI: string;
  readonly signalBindings: Readonly<Record<string, StateMachineDockedSignalBindingProjection>>;
  readonly updatedAt: ProjectionProvenance;
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
  readonly deploymentId?: Hex;
  readonly hookId: Hex;
  readonly stageIdentifier: Hex;
  readonly hookName: Hex;
  readonly assigneeRole: string;
  readonly assigneeWallet?: Address;
  readonly assigneeRoleHash?: Hex;
  readonly authorizationMetadataHash?: Hex;
  readonly status: StateMachineTaskStatus;
  readonly createdAt: ProjectionProvenance;
  readonly updatedAt: ProjectionProvenance;
  readonly proof: StateMachineProofProjection;
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
  readonly authorizations: Readonly<Record<string, StateMachineSignalAuthorizationProjection>>;
  readonly signals: Readonly<Record<string, StateMachineSignalProjection>>;
  readonly stageExecutorOverlays: Readonly<Record<string, StateMachineStageExecutorOverlayProjection>>;
  readonly stageResourceOverlays: Readonly<Record<string, StateMachineStageResourceOverlayProjection>>;
  readonly dockedOrderLinks: Readonly<Record<string, StateMachineDockedOrderLinkProjection>>;
  readonly hooks: Readonly<Record<string, StateMachineHookProjection>>;
  readonly tasks: Readonly<Record<string, StateMachineTaskProjection>>;
  readonly timeline: readonly StateMachineTimelineEventProjection[];
  readonly proof: readonly StateMachineProofProjection[];
  readonly registeredAt?: ProjectionProvenance;
  readonly updatedAt: ProjectionProvenance;
}

export interface StateMachineDeploymentProjection {
  readonly deploymentId: Hex;
  readonly stateMachineAddress: Address;
  readonly trustRegistryAddress: Address;
  readonly officialDomainId: Hex;
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
  readonly stateMachinePlans: Readonly<Record<string, StateMachinePlanProjection>>;
  readonly stateMachineOrders: Readonly<Record<string, StateMachineOrderProjection>>;
  readonly stateMachineTasks: Readonly<Record<string, StateMachineTaskProjection>>;
  readonly lastEvent?: ProjectionProvenance;
}

type Writable<TValue> = {
  -readonly [TKey in keyof TValue]: TValue[TKey];
};

type MutableStateMachineHookProjection = Writable<StateMachineHookProjection>;
type MutableStateMachineTaskProjection = Writable<StateMachineTaskProjection>;
type MutableStateMachineOrderProjection = Writable<
  Omit<
    StateMachineOrderProjection,
    | "authorizations"
    | "signals"
    | "stageExecutorOverlays"
    | "stageResourceOverlays"
    | "dockedOrderLinks"
    | "hooks"
    | "tasks"
    | "timeline"
    | "proof"
  >
> & {
  authorizations: Record<string, StateMachineSignalAuthorizationProjection>;
  signals: Record<string, StateMachineSignalProjection>;
  stageExecutorOverlays: Record<string, StateMachineStageExecutorOverlayProjection>;
  stageResourceOverlays: Record<string, StateMachineStageResourceOverlayProjection>;
  dockedOrderLinks: Record<string, Writable<Omit<StateMachineDockedOrderLinkProjection, "signalBindings">> & {
    signalBindings: Record<string, StateMachineDockedSignalBindingProjection>;
  }>;
  hooks: Record<string, MutableStateMachineHookProjection>;
  tasks: Record<string, MutableStateMachineTaskProjection>;
  timeline: StateMachineTimelineEventProjection[];
  proof: StateMachineProofProjection[];
};

type MutableStateMachinePlanProjection = Writable<StateMachinePlanProjection>;
type MutableStateMachineDeploymentProjection = Writable<StateMachineDeploymentProjection>;

const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000" as const;
const EXECUTOR_PATCH_MODE_VALUES = {
  assign: EXECUTOR_PATCH_MODE_ASSIGN,
  handoff: EXECUTOR_PATCH_MODE_HANDOFF,
  replacement: EXECUTOR_PATCH_MODE_REPLACEMENT
} as const satisfies Record<StateMachineStageExecutorPatchMode, Hex>;

export function createEmptyProjectionSnapshot(): ProjectionSnapshot {
  return {
    rebuildable: true,
    eventCount: 0,
    orders: {},
    stateMachineDeployments: {},
    stateMachinePlans: {},
    stateMachineOrders: {},
    stateMachineTasks: {}
  };
}

export function rebuildOrderProjections(events: readonly ChainEvent[]): ProjectionSnapshot {
  const stateMachineDeployments = new Map<string, MutableStateMachineDeploymentProjection>();
  const stateMachinePlans = new Map<string, MutableStateMachinePlanProjection>();
  const stateMachineOrders = new Map<string, MutableStateMachineOrderProjection>();
  let activeStateMachineDeploymentId: Hex | undefined;
  let eventCount = 0;
  let lastEvent: ProjectionProvenance | undefined;

  for (const event of filterActiveChainEvents(events)) {
    activeStateMachineDeploymentId = applyDeploymentRegistryEvent(stateMachineDeployments, activeStateMachineDeploymentId, event);
    applyStateMachineEvent({
      deployments: stateMachineDeployments,
      plans: stateMachinePlans,
      orders: stateMachineOrders
    }, event);
    eventCount += 1;
    lastEvent = provenanceOf(event);
  }

  const stateMachineOrderRecord: Record<string, StateMachineOrderProjection> = {};
  const stateMachineTaskRecord: Record<string, StateMachineTaskProjection> = {};
  for (const [orderId, order] of stateMachineOrders) {
    const readonlyTasks: Record<string, StateMachineTaskProjection> = {};
    for (const [taskId, task] of Object.entries(order.tasks)) {
      readonlyTasks[taskId] = { ...task };
      stateMachineTaskRecord[taskId] = { ...task };
    }
    const readonlyDockedLinks: Record<string, StateMachineDockedOrderLinkProjection> = {};
    for (const [linkedOrderId, link] of Object.entries(order.dockedOrderLinks)) {
      readonlyDockedLinks[linkedOrderId] = {
        ...link,
        signalBindings: { ...link.signalBindings }
      };
    }
    stateMachineOrderRecord[orderId] = {
      ...order,
      authorizations: { ...order.authorizations },
      signals: { ...order.signals },
      stageExecutorOverlays: { ...order.stageExecutorOverlays },
      stageResourceOverlays: { ...order.stageResourceOverlays },
      dockedOrderLinks: readonlyDockedLinks,
      hooks: Object.fromEntries(Object.entries(order.hooks).map(([hookId, hook]) => [hookId, { ...hook }])),
      tasks: readonlyTasks,
      timeline: [...order.timeline].sort(compareTimelineEvents),
      proof: [...order.proof].sort(compareProofEvents)
    };
  }

  return {
    rebuildable: true,
    eventCount,
    orders: {},
    ...(activeStateMachineDeploymentId ? { activeStateMachineDeploymentId } : {}),
    stateMachineDeployments: Object.fromEntries(stateMachineDeployments),
    stateMachinePlans: Object.fromEntries(stateMachinePlans),
    stateMachineOrders: stateMachineOrderRecord,
    stateMachineTasks: stateMachineTaskRecord,
    ...(lastEvent ? { lastEvent } : {})
  };
}

function applyStateMachineEvent(
  state: {
    deployments: Map<string, MutableStateMachineDeploymentProjection>;
    plans: Map<string, MutableStateMachinePlanProjection>;
    orders: Map<string, MutableStateMachineOrderProjection>;
  },
  event: ChainEvent
): void {
  switch (event.eventName) {
    case "PlanRegistered":
      applyPlanRegistered(state, event);
      return;
    case "OrderRegistered":
      applyOrderRegistered(state, event);
      return;
    case "SignalSubmitterAuthorized":
      applySignalSubmitterAuthorized(state, event);
      return;
    case "SignalSubmitted":
      applySignalSubmitted(state, event);
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
    case "DockedOrderLinked":
      applyDockedOrderLinked(state, event);
      return;
    case "DockedSignalMapped":
      applyDockedSignalMapped(state, event);
      return;
    case "DockedSignalSubmitted":
      applyDockedSignalSubmitted(state, event);
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
        trustRegistryAddress: requiredAddressArg(event, "trustRegistry"),
        officialDomainId: requiredBytes32Arg(event, "officialDomainId"),
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
  const plan: MutableStateMachinePlanProjection = {
    planId,
    ...(deployment ? { deploymentId: deployment.deploymentId } : {}),
    stateMachineAddress: event.contractAddress,
    planHash,
    hookCount: uintArgAsString(event, "hookCount"),
    selectorBindings: selectorBindingsArg(event),
    registeredAt: provenanceOf(event),
    updatedAt: provenanceOf(event),
    proof
  };
  state.plans.set(stateMachineScopedKey(event.chainId, event.contractAddress, planId), plan);

  for (const order of state.orders.values()) {
    if (order.contractAddress !== event.contractAddress || order.planId !== planId) {
      continue;
    }
    order.planHash = planHash;
    order.updatedAt = provenanceOf(event);
    appendOrderProof(order, proof);
    appendOrderTimeline(order, timelineOf(event, "秩序版本已注册", proof, { orderId: order.orderId, planId }));
  }
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
  const order = ensureStateMachineOrder(state.orders, event, orderId, planId, findDeploymentByStateMachine(state.deployments, event.chainId, event.contractAddress)?.deploymentId);
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

function applyStageSelectorBindingRegistered(
  state: {
    plans: Map<string, MutableStateMachinePlanProjection>;
  },
  event: ChainEvent
): void {
  const planId = requiredBytes32Arg(event, "planId");
  const selectorStageId = requiredBytes32Arg(event, "selectorStageId");
  const targetStageId = requiredBytes32Arg(event, "targetStageId");
  const plan = state.plans.get(stateMachineScopedKey(event.chainId, event.contractAddress, planId));
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

function applySignalSubmitterAuthorized(
  state: {
    orders: Map<string, MutableStateMachineOrderProjection>;
  },
  event: ChainEvent
): void {
  const orderId = requiredBytes32Arg(event, "orderId");
  const order = ensureStateMachineOrder(state.orders, event, orderId);
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
  const order = ensureStateMachineOrder(state.orders, event, orderId);
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
  order.status = order.status === "registered" || order.status === "unknown" ? "running" : order.status;
  order.updatedAt = provenanceOf(event);
  markMatchingTasksSubmitted(order, sourceId, signalId, proof);
  appendOrderProof(order, proof);
  appendOrderTimeline(order, timelineOf(event, "确认动作已写入链上", proof, { orderId, planId: order.planId }));
}

function applyStageExecutorPatchApplied(
  state: {
    orders: Map<string, MutableStateMachineOrderProjection>;
  },
  event: ChainEvent
): void {
  const orderId = requiredBytes32Arg(event, "orderId");
  const order = ensureStateMachineOrder(state.orders, event, orderId);
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
    orders: Map<string, MutableStateMachineOrderProjection>;
  },
  event: ChainEvent
): void {
  const orderId = requiredBytes32Arg(event, "orderId");
  const order = ensureStateMachineOrder(state.orders, event, orderId);
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
  },
  event: ChainEvent
): void {
  const orderId = requiredBytes32Arg(event, "orderId");
  const order = ensureStateMachineOrder(state.orders, event, orderId);
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
  if (existing && compareUintStrings(patchNonce, existing.patchNonce) >= 0) {
    const overlay: StateMachineStageExecutorOverlayProjection = {
      ...existing,
      activeExecutorWallet: executor,
      roleHash: requiredBytes32Arg(event, "role"),
      executorMetadataHash: requiredBytes32Arg(event, "metadataHash"),
      patchNonce,
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

function applyDockedOrderLinked(
  state: {
    orders: Map<string, MutableStateMachineOrderProjection>;
  },
  event: ChainEvent
): void {
  const localOrderId = requiredBytes32Arg(event, "localOrderId");
  const order = ensureStateMachineOrder(state.orders, event, localOrderId);
  const linkedOrderId = requiredBytes32Arg(event, "linkedOrderId");
  const selectorWallet = requiredAddressArg(event, "selector");
  const proof = proofOf(event, {
    orderId: localOrderId,
    planId: order.planId,
    planHash: order.planHash,
    submitter: selectorWallet
  });
  const existing = order.dockedOrderLinks[linkedOrderId.toLowerCase()];
  const signalBindings = existing?.signalBindings ?? {};
  const link: MutableStateMachineOrderProjection["dockedOrderLinks"][string] = {
    localOrderId,
    selectorStageId: requiredBytes32Arg(event, "selectorStageId"),
    localSourceId: requiredBytes32Arg(event, "localSourceId"),
    linkedOrderId,
    linkedPlanId: requiredBytes32Arg(event, "linkedPlanId"),
    selectorWallet,
    linkHash: requiredBytes32Arg(event, "linkHash"),
    linkNonce: uintArgAsString(event, "linkNonce"),
    metadataURI: optionalStringArg(event, "metadataURI") ?? "",
    signalBindings,
    updatedAt: provenanceOf(event),
    proof
  };
  order.dockedOrderLinks[linkedOrderId.toLowerCase()] = link;
  order.updatedAt = provenanceOf(event);
  appendOrderProof(order, proof);
  appendOrderTimeline(order, timelineOf(event, "关联秩序已 dock 到本地秩序", proof, { orderId: localOrderId, planId: order.planId }));
}

function applyDockedSignalMapped(
  state: {
    orders: Map<string, MutableStateMachineOrderProjection>;
  },
  event: ChainEvent
): void {
  const localOrderId = requiredBytes32Arg(event, "localOrderId");
  const order = ensureStateMachineOrder(state.orders, event, localOrderId);
  const linkedOrderId = requiredBytes32Arg(event, "linkedOrderId");
  const linkedSourceId = requiredBytes32Arg(event, "linkedSourceId");
  const linkedSignalId = requiredBytes32Arg(event, "linkedSignalId");
  const proof = proofOf(event, {
    orderId: localOrderId,
    planId: order.planId,
    planHash: order.planHash
  });
  const link = order.dockedOrderLinks[linkedOrderId.toLowerCase()] ?? {
    localOrderId,
    selectorStageId: ZERO_BYTES32,
    localSourceId: requiredBytes32Arg(event, "localSourceId"),
    linkedOrderId,
    linkedPlanId: ZERO_BYTES32,
    selectorWallet: "0x0000000000000000000000000000000000000000" as Address,
    linkHash: ZERO_BYTES32,
    linkNonce: "0",
    metadataURI: "",
    signalBindings: {},
    updatedAt: provenanceOf(event),
    proof
  };
  link.signalBindings[dockedSignalBindingProjectionKey(linkedSourceId, linkedSignalId)] = {
    localOrderId,
    linkedOrderId,
    localSourceId: requiredBytes32Arg(event, "localSourceId"),
    localSignalId: requiredBytes32Arg(event, "localSignalId"),
    linkedSourceId,
    linkedSignalId,
    updatedAt: provenanceOf(event),
    proof
  };
  order.dockedOrderLinks[linkedOrderId.toLowerCase()] = link;
  order.updatedAt = provenanceOf(event);
  appendOrderProof(order, proof);
  appendOrderTimeline(order, timelineOf(event, "跨秩序信号映射已登记", proof, { orderId: localOrderId, planId: order.planId }));
}

function applyDockedSignalSubmitted(
  state: {
    orders: Map<string, MutableStateMachineOrderProjection>;
  },
  event: ChainEvent
): void {
  const localOrderId = requiredBytes32Arg(event, "localOrderId");
  const order = ensureStateMachineOrder(state.orders, event, localOrderId);
  const proof = proofOf(event, {
    orderId: localOrderId,
    planId: order.planId,
    planHash: order.planHash,
    submitter: optionalAddressArg(event, "submitter")
  });
  order.updatedAt = provenanceOf(event);
  appendOrderProof(order, proof);
  appendOrderTimeline(order, timelineOf(event, "关联秩序信号已触发本地信号", proof, { orderId: localOrderId, planId: order.planId }));
}

function applyHookStatusChanged(
  state: {
    plans: Map<string, MutableStateMachinePlanProjection>;
    orders: Map<string, MutableStateMachineOrderProjection>;
  },
  event: ChainEvent
): void {
  const orderId = requiredBytes32Arg(event, "orderId");
  const order = ensureStateMachineOrder(state.orders, event, orderId);
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
  order.status = orderStatusFromHookStatus(order, hookStatus);
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
  const order = ensureStateMachineOrder(state.orders, event, orderId);
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

  const overlay = findActiveStageOverlayForHook(order, {
    stageIdentifier,
    hookId,
    hookName
  });
  const authorization = findSignalAuthorizationForHook(order, {
    stageIdentifier,
    hookId,
    hookName
  });
  const overlayAssignment = overlay ? stageOverlayTaskAssignment(overlay) : undefined;
  const taskId = taskProjectionId(orderId, hookId, order.contractAddress);
  order.tasks[taskId] = {
    taskId,
    orderId,
    stateMachineAddress: order.contractAddress,
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
  order.currentStage = stageIdentifier;
  order.status = "action_required";
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
  const order = ensureStateMachineOrder(state.orders, event, orderId);
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
  deploymentId?: Hex
): MutableStateMachineOrderProjection {
  const orderKey = stateMachineScopedKey(event.chainId, event.contractAddress, orderId);
  const existing = orders.get(orderKey);
  if (existing) {
    if (planId && existing.planId === ZERO_BYTES32) {
      existing.planId = planId;
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
    contractAddress: event.contractAddress,
    ...(deploymentId ? { deploymentId } : {}),
    planId: planId ?? ZERO_BYTES32,
    status: planId ? "registered" : "unknown",
    authorizations: {},
    signals: {},
    stageExecutorOverlays: {},
    stageResourceOverlays: {},
    dockedOrderLinks: {},
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
    if (task.hookId !== sourceId && task.hookId !== signalId) {
      continue;
    }
    task.status = "submitted";
    task.updatedAt = proof;
    task.proof = proof;
    changed = true;
  }

  if (changed && Object.values(order.tasks).every((task) => task.status !== "ready")) {
    order.status = "running";
  }
}

function markMatchingTasksAssigned(
  order: MutableStateMachineOrderProjection,
  authorization: StateMachineSignalAuthorizationProjection
): void {
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
  }
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
  readonly planId?: Hex | undefined;
  readonly planHash?: Hex | undefined;
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
    return value.startsWith("0x") ? value.toLowerCase() : value;
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

function dockedSignalBindingProjectionKey(linkedSourceId: Hex, linkedSignalId: Hex): string {
  return `${linkedSourceId.toLowerCase()}:${linkedSignalId.toLowerCase()}`;
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
}

export function signalAuthorizationMatchesHook(
  authorization: StateMachineSignalAuthorizationProjection,
  hook: SignalAuthorizationHookMatchInput
): boolean {
  return (authorization.sourceId === hook.stageIdentifier && authorization.signalId === hook.hookName) ||
    authorization.sourceId === hook.hookId ||
    authorization.signalId === hook.hookId ||
    authorization.signalId === hook.hookName;
}

export function stateMachineScopedKey(chainId: number, stateMachineAddress: Address, id: Hex): string {
  return `${chainId}:${stateMachineAddress.toLowerCase()}:${id.toLowerCase()}`;
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
  return [...deployments.values()].find((deployment) =>
    deployment.registeredAt.chainId === chainId && deployment.stateMachineAddress.toLowerCase() === normalizedStateMachine
  );
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

function orderStatusFromHookStatus(
  order: StateMachineOrderProjection,
  hookStatus: StateMachineHookStatus
): StateMachineOrderStatus {
  switch (hookStatus) {
    case "waiting":
      return "waiting";
    case "ready":
      return order.status === "action_required" ? "action_required" : "running";
    case "cancelled":
      return "cancelled";
    case "init":
    case "unknown":
      return order.status === "registered" || order.status === "unknown" ? "running" : order.status;
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
  if (left.chainId !== right.chainId) {
    return left.chainId - right.chainId;
  }
  if (left.blockNumber !== right.blockNumber) {
    return left.blockNumber < right.blockNumber ? -1 : 1;
  }
  if (left.logIndex !== right.logIndex) {
    return left.logIndex - right.logIndex;
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
