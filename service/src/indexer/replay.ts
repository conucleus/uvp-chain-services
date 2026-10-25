// 统一事件顺序与重放编排：rebuildOrderProjections 是投影重建的单一入口
// （含部署注册表事件族与显式诊断计数的推进），供索引器与存储对账调用。
// 各事件族与投影构造见 ./projections/。
import { chainEventKey, filterActiveChainEvents, type ChainEvent } from "./events.js";
import type { Address, Hex } from "../shared/types.js";
import {
  ZERO_BYTES32,
  compareProofEvents,
  compareTimelineEvents,
  optionalBytes32Arg,
  optionalStringArg,
  proofOf,
  provenanceOf,
  requiredAddressArg,
  requiredBytes32Arg,
  uintArgAsString,
  type ProjectionProvenance
} from "./projections/proof.js";
import {
  applyOrderForked,
  applyOrderLinked,
  applyOrderMaterialized,
  applyOrderRegistered,
  applyOrderRelayerRecorded,
  applyOrderTriggered,
  applyStateMachineModuleSet,
  stateMachineOrderProjectionKey,
  stateMachineScopedKey,
  stateMachineTaskProjectionKey,
  type MutableStateMachineModuleProjection,
  type MutableStateMachineOrderProjection,
  type StateMachineOrderProjection
} from "./projections/order.js";
import {
  applyPlanCommitted,
  applyPlanFinalized,
  applyPlanPublisherRecorded,
  applyPlanRegistered,
  type PlanCapabilityTablesInput
} from "./projections/plan.js";
import {
  applyDerivedSignalSubmitted,
  applySignalSubmitted,
  applySignalSubmitterAuthorized
} from "./projections/signal.js";
import {
  applyHookReady,
  applyHookStatusChanged,
  applyStageExecutorActivated,
  applyStageExecutorPatchApplied,
  applyStageMaterialized,
  applyStageResourcePatchApplied,
  applyTimerPoked
} from "./projections/stage.js";
import {
  applyDockAttached,
  applyDockInputSubmitted,
  applyDockOpened,
  applyDockOutputSatisfied,
  applyDockOutputSubmitted,
  type MutableStateMachineDockProjection,
  type StateMachineDockProjection
} from "./projections/docking.js";
import type { MutableStateMachinePlanProjection } from "./projections/plan.js";
import type { StateMachineTaskProjection } from "./projections/task.js";
import {
  type MutableStateMachineDeploymentProjection,
  type MutableContractGovernanceProjection,
  type ProjectionReplayDiagnostics,
  type ProjectionSnapshot,
  type StateMachineDeploymentStatus
} from "./projections/snapshot.js";

export function countReplayAnomalies(events: readonly ChainEvent[]): number {
  let anomalies = countDuplicateActiveEventAnomalies(events);
  try {
    rebuildOrderProjections(events);
  } catch {
    anomalies += 1;
  }
  return anomalies;
}

export function countDuplicateActiveEventAnomalies(events: readonly ChainEvent[]): number {
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
  return anomalies;
}

export function rebuildOrderProjections(
  events: readonly ChainEvent[],
  options: ProjectionReplayOptions = {}
): ProjectionSnapshot {
  const stateMachineDeployments = new Map<string, MutableStateMachineDeploymentProjection>();
  const stateMachineModules = new Map<string, MutableStateMachineModuleProjection>();
  const contractGovernance = new Map<string, MutableContractGovernanceProjection>();
  const stateMachinePlans = new Map<string, MutableStateMachinePlanProjection>();
  const stateMachineOrders = new Map<string, MutableStateMachineOrderProjection>();
  const stateMachineDocks = new Map<string, MutableStateMachineDockProjection>();
  const diagnostics: ProjectionReplayDiagnostics = {
    unresolvedModuleOrderEventCount: 0,
    unresolvedDockEventCount: 0,
    unresolvedStageActivationEventCount: 0,
    unresolvedDockTargetDeploymentCount: 0,
    capabilityEnrichmentMismatchCount: 0,
    unknownEventCount: 0
  };
  const capabilityTables = new Map<string, PlanCapabilityTablesInput>();
  for (const source of options.planCapabilityTables ?? []) {
    capabilityTables.set(source.planId.toLowerCase(), source);
  }
  const capabilityResolutionFailures = new Set<string>(
    (options.planCapabilityResolutionFailures ?? []).map((planId) => planId.toLowerCase())
  );
  let activeStateMachineDeploymentId: Hex | undefined;
  let eventCount = 0;
  let lastEvent: ProjectionProvenance | undefined;

  for (const event of filterActiveChainEvents(events)) {
    activeStateMachineDeploymentId = applyDeploymentRegistryEvent(stateMachineDeployments, activeStateMachineDeploymentId, event);
    applyStateMachineEvent({
      deployments: stateMachineDeployments,
      modules: stateMachineModules,
      governance: contractGovernance,
      plans: stateMachinePlans,
      orders: stateMachineOrders,
      docks: stateMachineDocks,
      capabilityTables,
      capabilityResolutionFailures,
      diagnostics
    }, event);
    eventCount += 1;
    lastEvent = provenanceOf(event);
  }

  const stateMachineOrderRecord: Record<string, StateMachineOrderProjection> = {};
  const stateMachineTaskRecord: Record<string, StateMachineTaskProjection> = {};
  const stateMachineDockRecord: Record<string, StateMachineDockProjection> = {};
  const stateMachineDocksByTargetOrder: Record<string, string[]> = {};
  for (const [dockKey, dock] of stateMachineDocks) {
    stateMachineDockRecord[dockKey] = {
      ...dock,
      inputDeliveries: { ...dock.inputDeliveries },
      outputDeliveries: { ...dock.outputDeliveries }
    };
    const targetOrderKey = stateMachineScopedKey(
      dock.chainId,
      dock.stateMachineAddress,
      dock.targetPlanId,
      dock.linkedOrderId
    );
    const dockKeys = (stateMachineDocksByTargetOrder[targetOrderKey] ??= []);
    dockKeys.push(dockKey);
  }
  const stateMachineOrderDockChainDepth = deriveOrderDockChainDepth(stateMachineDocks);
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
      derivedSignals: { ...order.derivedSignals },
      stageMaterializations: { ...order.stageMaterializations },
      stageExecutorOverlays: { ...order.stageExecutorOverlays },
      stageResourceOverlays: { ...order.stageResourceOverlays },
      ...(order.triggerLink ? { triggerLink: order.triggerLink } : {}),
      ...(order.forkLineage ? { forkLineage: order.forkLineage } : {}),
      hooks: Object.fromEntries(Object.entries(order.hooks).map(([hookId, hook]) => [hookId, { ...hook }])),
      tasks: readonlyTasks,
      timeline: [...order.timeline].sort(compareTimelineEvents),
      proof: [...order.proof].sort(compareProofEvents)
    };
    stateMachineOrderRecord[orderId] = readonlyOrder;
  }

  return {
    rebuildable: true,
    eventCount,
    ...(activeStateMachineDeploymentId ? { activeStateMachineDeploymentId } : {}),
    stateMachineDeployments: Object.fromEntries(stateMachineDeployments),
    stateMachineModules: Object.fromEntries(stateMachineModules),
    contractGovernance: Object.fromEntries(contractGovernance),
    stateMachinePlans: Object.fromEntries(stateMachinePlans),
    stateMachineOrders: stateMachineOrderRecord,
    stateMachineDocks: stateMachineDockRecord,
    stateMachineDocksByTargetOrder,
    stateMachineOrderDockChainDepth,
    stateMachineTasks: stateMachineTaskRecord,
    unresolvedModuleOrderEventCount: diagnostics.unresolvedModuleOrderEventCount,
    unresolvedDockEventCount: diagnostics.unresolvedDockEventCount,
    unresolvedStageActivationEventCount: diagnostics.unresolvedStageActivationEventCount,
    unresolvedDockTargetDeploymentCount: diagnostics.unresolvedDockTargetDeploymentCount,
    capabilityEnrichmentMismatchCount: diagnostics.capabilityEnrichmentMismatchCount,
    unknownEventCount: diagnostics.unknownEventCount,
    ...(lastEvent ? { lastEvent } : {})
  };
}

export interface ProjectionReplayOptions {
  readonly planCapabilityTables?: readonly PlanCapabilityTablesInput[];
  readonly planCapabilityResolutionFailures?: readonly Hex[];
}

function deriveOrderDockChainDepth(
  docks: Map<string, MutableStateMachineDockProjection>
): Record<string, number> {
  const edgesByTarget = new Map<string, { parentKey: string; targetKey: string }[]>();
  for (const dock of docks.values()) {
    const parentKey = stateMachineOrderProjectionKey(
      dock.chainId,
      dock.stateMachineAddress,
      dock.localPlanId,
      dock.localOrderId
    );
    const targetKey = stateMachineOrderProjectionKey(
      dock.chainId,
      dock.stateMachineAddress,
      dock.targetPlanId,
      dock.linkedOrderId
    );
    const edges = edgesByTarget.get(targetKey) ?? [];
    edges.push({ parentKey, targetKey });
    edgesByTarget.set(targetKey, edges);
  }
  const memo = new Map<string, number>();
  const longestPathOf = (orderKey: string, visiting: Set<string>): number => {
    const cached = memo.get(orderKey);
    if (cached !== undefined) {
      return cached;
    }
    if (visiting.has(orderKey)) {
      return 0;
    }
    visiting.add(orderKey);
    let longest = 0;
    for (const edge of edgesByTarget.get(orderKey) ?? []) {
      longest = Math.max(longest, longestPathOf(edge.parentKey, visiting) + 1);
    }
    visiting.delete(orderKey);
    memo.set(orderKey, longest);
    return longest;
  };
  const depths: Record<string, number> = {};
  for (const targetKey of edgesByTarget.keys()) {
    const depth = longestPathOf(targetKey, new Set());
    if (depth > 0) {
      depths[targetKey] = depth;
    }
  }
  return depths;
}

function applyStateMachineEvent(
  state: {
    deployments: Map<string, MutableStateMachineDeploymentProjection>;
    modules: Map<string, MutableStateMachineModuleProjection>;
    governance: Map<string, MutableContractGovernanceProjection>;
    plans: Map<string, MutableStateMachinePlanProjection>;
    orders: Map<string, MutableStateMachineOrderProjection>;
    docks: Map<string, MutableStateMachineDockProjection>;
    capabilityTables: ReadonlyMap<string, PlanCapabilityTablesInput>;
    capabilityResolutionFailures: ReadonlySet<string>;
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
    case "OrderForked":
      applyOrderForked(state, event);
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
    case "DockOpened":
      applyDockOpened(state, event);
      return;
    case "DockAttached":
      applyDockAttached(state, event);
      return;
    case "DockInputSubmitted":
      applyDockInputSubmitted(state, event);
      return;
    case "DockOutputSubmitted":
      applyDockOutputSubmitted(state, event);
      return;
    case "DockOutputSatisfied":
      applyDockOutputSatisfied(state, event);
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
    case "OwnershipTransferred":
      applyOwnershipTransferred(state.governance, event);
      return;
    case "StateMachineModulesFrozen":
      applyStateMachineModulesFrozen(state.governance, event);
      return;
    default:
      if (!NON_STATE_MACHINE_REPLAYED_EVENT_NAMES.has(event.eventName)) {
        state.diagnostics.unknownEventCount += 1;
      }
      return;
  }
}

const NON_STATE_MACHINE_REPLAYED_EVENT_NAMES: ReadonlySet<string> = new Set([
  "DeploymentRegistered",
  "DeploymentCanaryMarked",
  "DeploymentActivated",
  "DeploymentDeprecated",
  "DeploymentRetired",
  "IdentityBindingRegistered",
  "IdentityBindingRevoked"
]);

function contractGovernanceKey(chainId: number, contractAddress: Address): string {
  return `${chainId}:${contractAddress.toLowerCase()}`;
}

function applyOwnershipTransferred(
  governance: Map<string, MutableContractGovernanceProjection>,
  event: ChainEvent
): void {
  const newOwner = requiredAddressArg(event, "newOwner");
  const key = contractGovernanceKey(event.chainId, event.contractAddress);
  const existing = governance.get(key);
  const proof = proofOf(event);
  if (existing) {
    existing.owner = newOwner;
    existing.ownerUpdatedAt = provenanceOf(event);
    existing.ownerProof = proof;
    return;
  }
  governance.set(key, {
    chainId: event.chainId,
    contractAddress: event.contractAddress,
    owner: newOwner,
    ownerUpdatedAt: provenanceOf(event),
    ownerProof: proof
  });
}

function applyStateMachineModulesFrozen(
  governance: Map<string, MutableContractGovernanceProjection>,
  event: ChainEvent
): void {
  const moduleSetHash = requiredBytes32Arg(event, "moduleSetHash");
  const key = contractGovernanceKey(event.chainId, event.contractAddress);
  const existing = governance.get(key);
  const proof = proofOf(event);
  if (existing) {
    existing.modulesFrozen = true;
    existing.moduleSetHash = moduleSetHash;
    existing.frozenAt = provenanceOf(event);
    existing.frozenProof = proof;
    return;
  }
  governance.set(key, {
    chainId: event.chainId,
    contractAddress: event.contractAddress,
    owner: "0x0000000000000000000000000000000000000000" as Address,
    ownerUpdatedAt: provenanceOf(event),
    ownerProof: proof,
    modulesFrozen: true,
    moduleSetHash,
    frozenAt: provenanceOf(event),
    frozenProof: proof
  });
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
