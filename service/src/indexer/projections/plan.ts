// 计划族（PlanCommitted/Finalized/Registered/PublisherRecorded）投影：链上
// 只携带 capabilitiesRoot，selectorBindings/signalCapabilities/executorCandidates
// 由重放方按 planId 从编译产物富集并重算 root 断言（fail-closed）。
import { capabilitiesRootOf } from "@uvp-eth/compiler";
import { executorCandidatesRootOf } from "../../submissions/capability-proofs.js";
import type { ChainEvent } from "../events.js";
import { ProjectionError, type Address, type Hex } from "../../shared/types.js";
import {
  optionalAddressArg,
  optionalBytes32Arg,
  proofOf,
  provenanceOf,
  requiredAddressArg,
  requiredBytes32Arg,
  timelineOf,
  uintArgAsString,
  type ProjectionProvenance,
  type StateMachineProofProjection
} from "./proof.js";
import {
  appendOrderProof,
  appendOrderTimeline,
  resolveStateMachineAddressForModuleEvent,
  stateMachineScopedKey,
  type MutableStateMachineOrderProjection,
  type StateMachineModuleIndex
} from "./order.js";
import {
  findDeploymentByStateMachine,
  type MutableStateMachineDeploymentProjection,
  type ProjectionReplayDiagnostics,
  type Writable
} from "./snapshot.js";

export interface StateMachinePlanProjection {
  readonly planId: Hex;
  readonly deploymentId?: Hex;
  readonly stateMachineAddress: Address;
  readonly planHash: Hex;
  readonly hookCount: string;
  readonly publisher?: Address;
  readonly hooksHash?: Hex;
  readonly capabilitiesRoot?: Hex;
  readonly dockRoutesRoot?: Hex;
  readonly dockInterfaceRoot?: Hex;
  readonly executorCandidatesRoot?: Hex;
  readonly birthAuthorizer?: Address;
  readonly committedAt?: ProjectionProvenance;
  readonly finalizedAt?: ProjectionProvenance;
  readonly selectorBindings: readonly StateMachineStageSelectorBindingProjection[];
  readonly signalCapabilities: readonly StateMachineSignalCapabilityProjection[];
  readonly executorCandidates: readonly StateMachineExecutorCandidateProjection[];
  readonly capabilityEnrichment?: PlanCapabilityEnrichmentStatus;
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

export interface StateMachineExecutorCandidateProjection {
  readonly stageId: Hex;
  readonly executor: Address;
}

export interface StateMachineSignalCapabilityProjection {
  readonly stageId: Hex;
  readonly targetSourceId: Hex;
  readonly signalId: Hex;
  readonly targetOrderRelation: StateMachineSignalTargetRelation;
  readonly registeredAt: ProjectionProvenance;
  readonly proof: StateMachineProofProjection;
}

export type PlanCapabilityEnrichmentStatus = "enriched" | "empty" | "failed";

export type MutableStateMachinePlanProjection = Writable<StateMachinePlanProjection>;

export interface PlanCapabilityTablesInput {
  readonly planId: Hex;
  readonly planHash?: Hex;
  readonly selectorBindings: readonly { readonly selectorStageId: Hex; readonly targetStageId: Hex }[];
  readonly signalCapabilities: readonly {
    readonly stageId: Hex;
    readonly targetSourceId: Hex;
    readonly signalId: Hex;
    readonly targetOrderRelation: 0 | 1;
  }[];
  readonly executorCandidates?: readonly {
    readonly stageId: Hex;
    readonly executor: Address;
  }[];
}

export function applyPlanCommitted(
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
    capabilitiesRoot: requiredBytes32Arg(event, "capabilitiesRoot"),
    dockRoutesRoot: requiredBytes32Arg(event, "dockRoutesRoot"),
    dockInterfaceRoot: requiredBytes32Arg(event, "dockInterfaceRoot"),
    ...(optionalBytes32Arg(event, "executorCandidatesRoot")
      ? { executorCandidatesRoot: optionalBytes32Arg(event, "executorCandidatesRoot")! }
      : {}),
    ...((() => {
      const birthAuthorizer = optionalAddressArg(event, "birthAuthorizer");
      return birthAuthorizer && birthAuthorizer !== "0x0000000000000000000000000000000000000000"
        ? { birthAuthorizer }
        : {};
    })()),
    committedAt: provenanceOf(event),
    selectorBindings: [],
    signalCapabilities: [],
    executorCandidates: [],
    registeredAt: provenanceOf(event),
    updatedAt: provenanceOf(event),
    proof,
    commitProof: proof
  };
  state.plans.set(key, plan);
}

export function applyPlanFinalized(
  state: {
    deployments: Map<string, MutableStateMachineDeploymentProjection>;
    plans: Map<string, MutableStateMachinePlanProjection>;
    capabilityTables?: ReadonlyMap<string, PlanCapabilityTablesInput>;
    capabilityResolutionFailures?: ReadonlySet<string>;
    diagnostics?: ProjectionReplayDiagnostics;
  },
  event: ChainEvent
): void {
  const planId = requiredBytes32Arg(event, "planId");
  const planHash = requiredBytes32Arg(event, "planHash");
  const capabilitiesRoot = requiredBytes32Arg(event, "capabilitiesRoot");
  const proof = proofOf(event, { planId, planHash });
  const key = stateMachineScopedKey(event.chainId, event.contractAddress, planId);
  const existing = state.plans.get(key);
  if (existing) {
    if (!existing.finalizedAt) {
      existing.finalizedAt = provenanceOf(event);
      existing.finalizationProof = proof;
      existing.capabilitiesRoot = capabilitiesRoot;
      existing.updatedAt = provenanceOf(event);
      enrichPlanCapabilityTables(existing, event, state, { countMismatch: true });
    }
    return;
  }
  const deployment = findDeploymentByStateMachine(state.deployments, event.chainId, event.contractAddress);
  const plan: MutableStateMachinePlanProjection = {
    planId,
    ...(deployment ? { deploymentId: deployment.deploymentId } : {}),
    stateMachineAddress: event.contractAddress,
    planHash,
    hookCount: "0",
    capabilitiesRoot,
    committedAt: provenanceOf(event),
    finalizedAt: provenanceOf(event),
    selectorBindings: [],
    signalCapabilities: [],
    executorCandidates: [],
    registeredAt: provenanceOf(event),
    updatedAt: provenanceOf(event),
    proof,
    finalizationProof: proof
  };
  enrichPlanCapabilityTables(plan, event, state, { countMismatch: true });
  state.plans.set(key, plan);
}

export function applyPlanRegistered(
  state: {
    deployments: Map<string, MutableStateMachineDeploymentProjection>;
    plans: Map<string, MutableStateMachinePlanProjection>;
    orders: Map<string, MutableStateMachineOrderProjection>;
    capabilityTables?: ReadonlyMap<string, PlanCapabilityTablesInput>;
    capabilityResolutionFailures?: ReadonlySet<string>;
    diagnostics?: ProjectionReplayDiagnostics;
  },
  event: ChainEvent
): void {
  const planId = requiredBytes32Arg(event, "planId");
  const planHash = requiredBytes32Arg(event, "planHash");
  const deployment = findDeploymentByStateMachine(state.deployments, event.chainId, event.contractAddress);
  const proof = proofOf(event, { planId, planHash });
  const key = stateMachineScopedKey(event.chainId, event.contractAddress, planId);
  const existing = state.plans.get(key);
  const plan: MutableStateMachinePlanProjection = existing
    ? {
      ...existing,
      planHash,
      hookCount: uintArgAsString(event, "hookCount"),
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
      selectorBindings: [],
      signalCapabilities: [],
      executorCandidates: [],
      registeredAt: provenanceOf(event),
      updatedAt: provenanceOf(event),
      proof
    };
  enrichPlanCapabilityTables(plan, event, state, {
    countMismatch: existing === undefined || existing.finalizedAt === undefined
  });
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

export function applyPlanPublisherRecorded(
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

export function findPlanForEvent(
  plans: Map<string, MutableStateMachinePlanProjection>,
  modules: StateMachineModuleIndex,
  event: ChainEvent,
  planId: Hex
): MutableStateMachinePlanProjection | undefined {
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

export function findPlanForOrder(
  plans: Map<string, MutableStateMachinePlanProjection>,
  order: MutableStateMachineOrderProjection
): MutableStateMachinePlanProjection | undefined {
  return plans.get(stateMachineScopedKey(order.chainId, order.contractAddress, order.planId));
}

function enrichPlanCapabilityTables(
  plan: MutableStateMachinePlanProjection,
  event: ChainEvent,
  state: {
    capabilityTables?: ReadonlyMap<string, PlanCapabilityTablesInput>;
    capabilityResolutionFailures?: ReadonlySet<string>;
    diagnostics?: ProjectionReplayDiagnostics;
  },
  options: { readonly countMismatch: boolean }
): void {
  const source = state.capabilityTables?.get(plan.planId.toLowerCase());
  enrichExecutorCandidates(plan, source, state, options);
  const countMismatch = (): void => {
    if (options.countMismatch) {
      state.diagnostics && (state.diagnostics.capabilityEnrichmentMismatchCount += 1);
    }
  };
  if (plan.selectorBindings.length > 0 || plan.signalCapabilities.length > 0) {
    return;
  }
  if (!source) {
    if (state.capabilityResolutionFailures?.has(plan.planId.toLowerCase())) {
      countMismatch();
      plan.capabilityEnrichment = "failed";
      return;
    }
    plan.capabilityEnrichment = "empty";
    return;
  }
  if (source.planHash && source.planHash.toLowerCase() !== plan.planHash.toLowerCase()) {
    countMismatch();
    plan.capabilityEnrichment = "failed";
    return;
  }
  const capabilitiesRoot = capabilitiesRootOf(source.selectorBindings, source.signalCapabilities);
  if (!plan.capabilitiesRoot || plan.capabilitiesRoot.toLowerCase() !== capabilitiesRoot.toLowerCase()) {
    countMismatch();
    plan.capabilityEnrichment = "failed";
    return;
  }
  plan.selectorBindings = source.selectorBindings.map((binding) => ({
    selectorStageId: binding.selectorStageId,
    targetStageId: binding.targetStageId
  }));
  plan.signalCapabilities = source.signalCapabilities
    .map((capability): StateMachineSignalCapabilityProjection => ({
      stageId: capability.stageId,
      targetSourceId: capability.targetSourceId,
      signalId: capability.signalId,
      targetOrderRelation: capability.targetOrderRelation === 0 ? "current" : "triggerOrigin",
      registeredAt: provenanceOf(event),
      proof: proofOf(event, { planId: plan.planId })
    }))
    .sort(compareSignalCapabilities);
  plan.capabilityEnrichment = "enriched";
}

function enrichExecutorCandidates(
  plan: MutableStateMachinePlanProjection,
  source: PlanCapabilityTablesInput | undefined,
  state: {
    capabilityResolutionFailures?: ReadonlySet<string>;
    diagnostics?: ProjectionReplayDiagnostics;
  },
  options: { readonly countMismatch: boolean }
): void {
  if (plan.executorCandidates.length > 0) {
    return;
  }
  const candidates = source?.executorCandidates;
  if (!candidates || candidates.length === 0) {
    return;
  }
  const countMismatch = (): void => {
    if (options.countMismatch) {
      state.diagnostics && (state.diagnostics.capabilityEnrichmentMismatchCount += 1);
    }
  };
  const candidatesRoot = executorCandidatesRootOf(candidates);
  if (
    !plan.executorCandidatesRoot ||
    plan.executorCandidatesRoot.toLowerCase() !== candidatesRoot.toLowerCase()
  ) {
    countMismatch();
    return;
  }
  plan.executorCandidates = candidates.map((candidate) => ({
    stageId: candidate.stageId,
    executor: candidate.executor,
  }));
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
