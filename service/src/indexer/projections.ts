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
  readonly selectorBindings: readonly StateMachineStageSelectorBindingProjection[];
  readonly signalCapabilities: readonly StateMachineSignalCapabilityProjection[];
  readonly registeredAt: ProjectionProvenance;
  readonly publisherRecordedAt?: ProjectionProvenance;
  readonly updatedAt: ProjectionProvenance;
  readonly proof: StateMachineProofProjection;
  readonly publisherProof?: StateMachineProofProjection;
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
  readonly authorizations: Readonly<Record<string, StateMachineSignalAuthorizationProjection>>;
  readonly signals: Readonly<Record<string, StateMachineSignalProjection>>;
  readonly stageExecutorOverlays: Readonly<Record<string, StateMachineStageExecutorOverlayProjection>>;
  readonly stageResourceOverlays: Readonly<Record<string, StateMachineStageResourceOverlayProjection>>;
  readonly dockedOrderLinks: Readonly<Record<string, StateMachineDockedOrderLinkProjection>>;
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
  readonly stateMachineTasks: Readonly<Record<string, StateMachineTaskProjection>>;
  readonly lastEvent?: ProjectionProvenance;
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
    | "stageExecutorOverlays"
    | "stageResourceOverlays"
    | "dockedOrderLinks"
    | "triggerLink"
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
  triggerLink?: StateMachineOrderTriggerLinkProjection;
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
    stateMachineModules: {},
    stateMachinePlans: {},
    stateMachineOrders: {},
    stateMachineTasks: {}
  };
}

export function rebuildOrderProjections(events: readonly ChainEvent[]): ProjectionSnapshot {
  const stateMachineDeployments = new Map<string, MutableStateMachineDeploymentProjection>();
  const stateMachineModules = new Map<string, MutableStateMachineModuleProjection>();
  const stateMachinePlans = new Map<string, MutableStateMachinePlanProjection>();
  const stateMachineOrders = new Map<string, MutableStateMachineOrderProjection>();
  let activeStateMachineDeploymentId: Hex | undefined;
  let eventCount = 0;
  let lastEvent: ProjectionProvenance | undefined;

  for (const event of filterActiveChainEvents(events)) {
    activeStateMachineDeploymentId = applyDeploymentRegistryEvent(stateMachineDeployments, activeStateMachineDeploymentId, event);
    applyStateMachineEvent({
      deployments: stateMachineDeployments,
      modules: stateMachineModules,
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
      const readonlyTask = {
        ...task,
        ...(task.submitSignals ? { submitSignals: [...task.submitSignals] } : {})
      };
      readonlyTasks[taskId] = readonlyTask;
      stateMachineTaskRecord[taskId] = readonlyTask;
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
      ...(order.triggerLink ? { triggerLink: order.triggerLink } : {}),
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
    stateMachineModules: Object.fromEntries(stateMachineModules),
    stateMachinePlans: Object.fromEntries(stateMachinePlans),
    stateMachineOrders: stateMachineOrderRecord,
    stateMachineTasks: stateMachineTaskRecord,
    ...(lastEvent ? { lastEvent } : {})
  };
}

function applyStateMachineEvent(
  state: {
    deployments: Map<string, MutableStateMachineDeploymentProjection>;
    modules: Map<string, MutableStateMachineModuleProjection>;
    plans: Map<string, MutableStateMachinePlanProjection>;
    orders: Map<string, MutableStateMachineOrderProjection>;
  },
  event: ChainEvent
): void {
  switch (event.eventName) {
    case "StateMachineModuleSet":
      applyStateMachineModuleSet(state.modules, event);
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
    case "DockedOrderLinked":
      applyDockedOrderLinked(state, event);
      return;
    case "DockedSignalMapped":
      applyDockedSignalMapped(state, event);
      return;
    case "DockedSignalSubmitted":
      applyDockedSignalSubmitted(state, event);
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
    signalCapabilities: signalCapabilitiesArg(event),
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
    plans: Map<string, MutableStateMachinePlanProjection>;
  },
  event: ChainEvent
): void {
  const planId = requiredBytes32Arg(event, "planId");
  const plan = findPlanForEvent(state.plans, event, planId);
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

function applyStageSelectorBindingRegistered(
  state: {
    plans: Map<string, MutableStateMachinePlanProjection>;
  },
  event: ChainEvent
): void {
  const planId = requiredBytes32Arg(event, "planId");
  const selectorStageId = requiredBytes32Arg(event, "selectorStageId");
  const targetStageId = requiredBytes32Arg(event, "targetStageId");
  const plan = findPlanForEvent(state.plans, event, planId);
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
    plans: Map<string, MutableStateMachinePlanProjection>;
    orders: Map<string, MutableStateMachineOrderProjection>;
  },
  event: ChainEvent
): void {
  const planId = requiredBytes32Arg(event, "planId");
  const capability = signalCapabilityFromEvent(event);
  const plan = findPlanForEvent(state.plans, event, planId);
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
  const order = ensureStateMachineOrder(state.orders, event, orderId);
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
    orders: Map<string, MutableStateMachineOrderProjection>;
  },
  event: ChainEvent
): void {
  const triggeredOrderId = requiredBytes32Arg(event, "triggeredOrderId");
  const triggerOriginOrderId = requiredBytes32Arg(event, "triggerOriginOrderId");
  const triggerStageId = requiredBytes32Arg(event, "triggerStageId");
  const originSourceId = requiredBytes32Arg(event, "originSourceId");
  const originSignalId = requiredBytes32Arg(event, "originSignalId");
  const childOrder = ensureStateMachineOrder(
    state.orders,
    event,
    triggeredOrderId,
    undefined,
    findDeploymentByStateMachine(state.deployments, event.chainId, event.contractAddress)?.deploymentId
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

function applyDerivedSignalSubmitted(
  state: {
    orders: Map<string, MutableStateMachineOrderProjection>;
  },
  event: ChainEvent
): void {
  const targetOrderId = requiredBytes32Arg(event, "targetOrderId");
  const order = ensureStateMachineOrder(state.orders, event, targetOrderId);
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
  readonly submitSignals?: readonly StateMachineTaskSubmitSignalProjection[];
}

export function signalAuthorizationMatchesHook(
  authorization: StateMachineSignalAuthorizationProjection,
  hook: SignalAuthorizationHookMatchInput
): boolean {
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
  event: ChainEvent,
  planId: Hex
): MutableStateMachinePlanProjection | undefined {
  const exact = plans.get(stateMachineScopedKey(event.chainId, event.contractAddress, planId));
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
