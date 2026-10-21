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
  // 词表产物富集索引：planId(lower) → 编译产物两表（applyPlanFinalized/
  // applyPlanRegistered 时填进投影并断言 capabilitiesRoot，见 plan.ts）。
  const capabilityTables = new Map<string, PlanCapabilityTablesInput>();
  for (const source of options.planCapabilityTables ?? []) {
    capabilityTables.set(source.planId.toLowerCase(), source);
  }
  // 本轮 resolver 故障的 planId(lower)：这些 plan 的空两表是"未知词表"
  // 而非"无词表"，富集态标 failed 供提交/触发车道拒识（见 plan.ts）。
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
  // 目标侧"谁挂了我"索引：预留索引——从已出生的 dock 集合收口派生
  // （而非逐事件记账），快照每次重建整体重算，天然幂等；existing 的 N:1
  // 由集合值承载，键与目标单订单桶同形。当前没有读取方消费它，消费方
  // （目标单视角的反查/展示面）接入前该索引不承载任何读取语义，只随
  // 快照持久化保持形状稳定。
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
    // 快照只暴露 plan 作用域的复合键：每条订单/任务恰好一个键，
    // 裸 orderId 必须走 fail-closed 扫描（uniqueOrderByBareId），绝不静默命中。
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

/**
 * 重放选项。planCapabilityTables：planId 锚定的编译产物两表（词表富集源，
 * 见 projections/plan.ts 的 fail-closed 口径）；缺省时所有 plan 两表为空
 * ——与链上无注册事件面的事实一致，只是词表相关推导不可用。
 * planCapabilityResolutionFailures：本轮 resolver 故障的 planId 集合——
 * 这些 plan 的空两表按 failed 富集态进快照（解析故障 ≠ 无词表）。
 */
export interface ProjectionReplayOptions {
  readonly planCapabilityTables?: readonly PlanCapabilityTablesInput[];
  readonly planCapabilityResolutionFailures?: readonly Hex[];
}

/**
 * B-02 派生投影：每单「最长 dock 链路」从 dock 事件图（父单 → 目标单边）
 * 计算——4.7 起链上不再维护路径深度（dockEdgeCountOfOrder 是每单总挂接
 * 边数的父链账本），路径语义归索引器。有 memo 的 DFS：无入边订单 = 0
 * （不出现在结果里），有入边订单 = max(入边父链 + 1)。链上有界祖先检查
 * 保证跨单无环；防御性 visiting 集合对异常事件流（理论上的环）截断，
 * 不抛错不静默丢边。
 */
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
    // 防御性环截断：理论不可达（链上 DockAncestorCycle 拒绝跨单环），
    // 异常事件流按当前展开值收敛而不是死循环。
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
      // fork 出生血缘（UB-39）：血缘进 fork 单投影（order.forkLineage）；
      // fork 单的注册与事实流沿用既有事件族（OrderRegistered/
      // SignalSubmitted），本分支只收血缘，不落未知事件桶。
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
    // 治理面投影（B-03）：此前 OwnershipTransferred（owner 轮换）与
    // StateMachineModulesFrozen（模块集冻结）是显式零投影分支，治理状态
    // 无法从事件流重建。两族按发出合约分桶写入 contractGovernance——
    // OwnershipTransferred 同名事件族也由 identity/deployment registry 发出，
    // 一并入桶（治理状态可全量重建）。它们不产生订单/plan/模块投影，
    // 也不落入未知计数。
    case "OwnershipTransferred":
      applyOwnershipTransferred(state.governance, event);
      return;
    case "StateMachineModulesFrozen":
      applyStateMachineModulesFrozen(state.governance, event);
      return;
    default:
      // 真未知事件：既不在状态机事件族，也不属于其他重放遍已收口的
      // 家族（部署注册表族由 applyDeploymentRegistryEvent 处理、身份族
      // 由 rebuildIdentityProjections 处理）。新合约事件上线而投影未跟
      // 进时必须显式计数（不静默），快照与索引器日志都会携带该计数。
      if (!NON_STATE_MACHINE_REPLAYED_EVENT_NAMES.has(event.eventName)) {
        state.diagnostics.unknownEventCount += 1;
      }
      return;
  }
}

/**
 * 其他重放遍已收口、允许穿过 applyStateMachineEvent default 分支且不计入
 * 未知计数的事件名：部署注册表族（applyDeploymentRegistryEvent）与身份
 * 注册表族（rebuildIdentityProjections）。rebuildOrderProjections 的输入是
 * 全量事件流，这两族事件到达这里属正常编排，不是漏跟。
 */
const NON_STATE_MACHINE_REPLAYED_EVENT_NAMES: ReadonlySet<string> = new Set([
  "DeploymentRegistered",
  "DeploymentCanaryMarked",
  "DeploymentActivated",
  "DeploymentDeprecated",
  "DeploymentRetired",
  "IdentityBindingRegistered",
  "IdentityBindingRevoked"
]);

/** 治理桶键：chainId:contractAddress（OwnershipTransferred 跨合约族同键）。 */
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
  // freezeModules 只能由 owner 发起：冻结事件先于任何 OwnershipTransferred
  // 入流的畸形序列下，owner 面留空（null address），不伪造占位 owner。
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
