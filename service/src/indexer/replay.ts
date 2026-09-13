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
  applyOrderLinked,
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
  applySignalCapabilityRegistered,
  applyStageSelectorBindingRegistered
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
  applyStageExecutorSignalDelegated,
  applyStageMaterialized,
  applyStageResourcePatchApplied,
  applyTimerPoked
} from "./projections/stage.js";
import {
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
  type ProjectionReplayDiagnostics,
  type ProjectionSnapshot,
  type StateMachineDeploymentStatus
} from "./projections/snapshot.js";

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
  let anomalies = countDuplicateActiveEventAnomalies(events);
  try {
    rebuildOrderProjections(events);
  } catch {
    anomalies += 1;
  }
  return anomalies;
}

/**
 * 重复/矛盾投递计数（countReplayAnomalies 的第一类异常）。调用方在同一
 * 路径里已自行执行 rebuildOrderProjections（apply 失败会直接抛出走向
 * degraded，无需在此再全量重放一遍）时使用本函数，避免每轮增量触发
 * 一次冗余的 O(全历史) 投影重放。
 */
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

export function rebuildOrderProjections(events: readonly ChainEvent[]): ProjectionSnapshot {
  const stateMachineDeployments = new Map<string, MutableStateMachineDeploymentProjection>();
  const stateMachineModules = new Map<string, MutableStateMachineModuleProjection>();
  const stateMachinePlans = new Map<string, MutableStateMachinePlanProjection>();
  const stateMachineOrders = new Map<string, MutableStateMachineOrderProjection>();
  const stateMachineDocks = new Map<string, MutableStateMachineDockProjection>();
  const diagnostics: ProjectionReplayDiagnostics = {
    unresolvedModuleOrderEventCount: 0,
    unresolvedDockEventCount: 0,
    unresolvedStageActivationEventCount: 0,
    unresolvedDockTargetDeploymentCount: 0
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
    unresolvedDockTargetDeploymentCount: diagnostics.unresolvedDockTargetDeploymentCount,
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
