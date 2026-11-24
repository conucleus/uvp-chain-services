// 统一事件顺序与重放编排：rebuildOrderProjections 是投影重建的单一入口
// （含部署注册表事件族与显式诊断计数的推进），供索引器与存储对账调用。
// 各事件族与投影构造见 ./projections/。
import { chainEventKey, filterActiveChainEvents, type ChainEvent } from "./events.js";
import type { DockArtifact } from "@uvp-eth/compiler";
import type { Address, Hex } from "@uvp-eth/service-runtime";
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
  applyOrderMaterialized,
  applyOrderRegistered,
  applyOrderRelayerRecorded,
  applyOrderTriggered,
  applyStateMachineModuleSet,
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
  applySignalSubmitted
} from "./projections/signal.js";
import {
  applyHookReady,
  applyHookStatusChanged,
  applyStageMaterialized,
  applyStageSupplierAssigned,
  applyStageSupplierPatchApplied,
  applyTimerPoked
} from "./projections/stage.js";
import { applyStageFileWritten } from "./projections/stage-files.js";
import {
  applySupplierCapabilityEvent,
  resolveStageSupplierAssignments,
  type MutableStateMachineSupplierProjection
} from "./projections/supplier.js";
import {
  applyDockBindingPoked,
  applyDockOutputSubmitted,
  applyDockRegistered,
  applyStageDockSupplierSelected
} from "./projections/dock.js";
import type { MutableStateMachinePlanProjection } from "./projections/plan.js";
import type {
  MutableStateMachineDockBindingProjection,
  StateMachineDockProjection,
  StateMachineDockSelectionProjection
} from "./projections/dock.js";
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
  const stateMachineDocks = new Map<string, StateMachineDockProjection>();
  const stateMachineDockSelections = new Map<string, StateMachineDockSelectionProjection>();
  const stateMachineDockBindings = new Map<string, MutableStateMachineDockBindingProjection>();
  const stateMachineSuppliers = new Map<string, MutableStateMachineSupplierProjection>();
  const diagnostics: ProjectionReplayDiagnostics = {
    unresolvedModuleOrderEventCount: 0,
    unresolvedStageActivationEventCount: 0,
    capabilityEnrichmentMismatchCount: 0,
    unknownEventCount: 0
  };
  const capabilityTables = new Map<string, PlanCapabilityTablesInput>();
  for (const source of options.planCapabilityTables ?? []) {
    capabilityTables.set(source.planId.toLowerCase(), source);
  }
  const dockArtifacts = new Map<string, DockArtifact>();
  const dockArtifactsByDkid = new Map<string, DockArtifact>();
  for (const artifact of options.dockArtifacts ?? []) {
    dockArtifacts.set(artifact.docHash.toLowerCase(), artifact);
    dockArtifactsByDkid.set(artifact.dkid, artifact);
  }
  let activeStateMachineDeploymentId: Hex | undefined;
  let eventCount = 0;
  let lastEvent: ProjectionProvenance | undefined;

  for (const event of filterActiveChainEvents(events)) {
    activeStateMachineDeploymentId = applyDeploymentRegistryEvent(stateMachineDeployments, activeStateMachineDeploymentId, event);
    if (applySupplierCapabilityEvent(stateMachineSuppliers, event)) {
      eventCount += 1;
      lastEvent = provenanceOf(event);
      continue;
    }
    applyStateMachineEvent({
      deployments: stateMachineDeployments,
      modules: stateMachineModules,
      governance: contractGovernance,
      plans: stateMachinePlans,
      orders: stateMachineOrders,
      docks: stateMachineDocks,
      dockSelections: stateMachineDockSelections,
      dockBindings: stateMachineDockBindings,
      dockArtifacts,
      dockArtifactsByDkid,
      capabilityTables,
      diagnostics
    }, event);
    eventCount += 1;
    lastEvent = provenanceOf(event);
  }
  resolveStageSupplierAssignments({
    suppliers: stateMachineSuppliers,
    plans: stateMachinePlans,
    orders: stateMachineOrders,
    dockSelections: stateMachineDockSelections
  });

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
      signals: { ...order.signals },
      derivedSignals: { ...order.derivedSignals },
      stageMaterializations: { ...order.stageMaterializations },
      stageSupplierAssignments: { ...order.stageSupplierAssignments },
      stageFiles: Object.fromEntries(
        Object.entries(order.stageFiles).map(([targetStageId, stageFile]) => [
          targetStageId,
          { ...stageFile, files: { ...stageFile.files } }
        ])
      ),
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
    stateMachineDocks: Object.fromEntries(stateMachineDocks),
    stateMachineDockBindings: Object.fromEntries(stateMachineDockBindings),
    stateMachineTasks: stateMachineTaskRecord,
    stateMachineSuppliers: Object.fromEntries(stateMachineSuppliers),
    unresolvedModuleOrderEventCount: diagnostics.unresolvedModuleOrderEventCount,
    unresolvedStageActivationEventCount: diagnostics.unresolvedStageActivationEventCount,
    capabilityEnrichmentMismatchCount: diagnostics.capabilityEnrichmentMismatchCount,
    unknownEventCount: diagnostics.unknownEventCount,
    ...(lastEvent ? { lastEvent } : {})
  };
}

export interface ProjectionReplayOptions {
  readonly planCapabilityTables?: readonly PlanCapabilityTablesInput[];
  readonly dockArtifacts?: readonly DockArtifact[];
}

function applyStateMachineEvent(
  state: {
    deployments: Map<string, MutableStateMachineDeploymentProjection>;
    modules: Map<string, MutableStateMachineModuleProjection>;
    governance: Map<string, MutableContractGovernanceProjection>;
    plans: Map<string, MutableStateMachinePlanProjection>;
    orders: Map<string, MutableStateMachineOrderProjection>;
    docks: Map<string, StateMachineDockProjection>;
    dockSelections: Map<string, StateMachineDockSelectionProjection>;
    dockBindings: Map<string, MutableStateMachineDockBindingProjection>;
    dockArtifacts: ReadonlyMap<string, DockArtifact>;
    dockArtifactsByDkid: ReadonlyMap<string, DockArtifact>;
    capabilityTables: ReadonlyMap<string, PlanCapabilityTablesInput>;
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
    case "SignalSubmitted":
      applySignalSubmitted(state, event);
      return;
    case "StageMaterialized":
      applyStageMaterialized(state, event);
      return;
    case "OrderTriggered":
      applyOrderTriggered(state, event);
      return;
    case "StageSupplierPatchApplied":
      applyStageSupplierPatchApplied(state, event);
      return;
    case "StageFileWritten":
      applyStageFileWritten(state, event);
      return;
    case "StageSupplierAssigned":
      applyStageSupplierAssigned(state, event);
      return;
    case "DockRegistered":
      applyDockRegistered(state, event);
      return;
    case "StageDockSupplierSelected":
      applyStageDockSupplierSelected(state, event);
      return;
    case "DockBindingPoked":
      applyDockBindingPoked(state, event);
      return;
    case "DockOutputSubmitted":
      applyDockOutputSubmitted(state, event);
      return;
    case "DockOutputDeferred":
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
