// 计划族：PlanCommitted/Finalized/Registered/PublisherRecorded 与计划投影
// 构造。协议重构后链上不再逐条发词表注册事件（SignalCapabilityRegistered/
// StageSelectorBindingRegistered 已删除）：计划事件只携带 capabilitiesRoot，
// 两表（selectorBindings/signalCapabilities）由重放方按 planId 从编译产物
// （store 域 onchainHookPlanArtifact）富集，并以 capabilitiesRootOf 重算
// 断言与链上 root 一致（fail-closed）。
import { capabilitiesRootOf } from "@uvp-eth/compiler";
import type { ChainEvent } from "../events.js";
import { ProjectionError, type Address, type Hex } from "../../shared/types.js";
import {
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
  /**
   * Commit-phase facts (PlanCommitted). The contract publishes plans in two
   * steps: commitPlan emits PlanCommitted + PlanPublisherRecorded, finalizePlan
   * then emits PlanFinalized + PlanRegistered. The bucket is created at commit
   * so the finalize-transaction events always find their plan.
   */
  readonly hooksHash?: Hex;
  /** 能力树根（原 metadataHash 字段改名，事件 topic 不变）：两表富集的链上锚点。 */
  readonly capabilitiesRoot?: Hex;
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

export type MutableStateMachinePlanProjection = Writable<StateMachinePlanProjection>;

/**
 * 产物富集源：planId 锚定的编译产物两表（capabilityTablesOf(artifact) 的
 * 输出形态，relation 为链上词序 0/1）。planHash 可选——提供时参与富集
 * 前的一致性断言。
 */
export interface PlanCapabilityTablesInput {
  readonly planId: Hex;
  readonly planHash?: Hex;
  readonly selectorBindings: readonly { readonly selectorStageId: Hex; readonly targetStageId: Hex }[];
  readonly signalCapabilities: readonly {
    readonly stageId: Hex;
    readonly targetSourceId: Hex;
    readonly signalId: Hex;
    /** 0=current,1=triggerOrigin（链上叶词序）。 */
    readonly targetOrderRelation: 0 | 1;
  }[];
}

/**
 * 真实事件顺序（UVPStateMachine v0.11）：commitPlan 同一交易先发
 * PlanCommitted 再发 PlanPublisherRecorded；finalizePlan 随后发
 * PlanFinalized + PlanRegistered（不再先调 plan metadata 模块注册词表——
 * 词表已 Merkle 化进 capabilitiesRoot）。投影仍在 PlanCommitted 建 plan
 * 桶，否则 finalize 交易内的计划事件会撞"unknown plan"。
 */
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
    capabilitiesRoot: requiredBytes32Arg(event, "capabilitiesRoot"),
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

export function applyPlanFinalized(
  state: {
    deployments: Map<string, MutableStateMachineDeploymentProjection>;
    plans: Map<string, MutableStateMachinePlanProjection>;
    capabilityTables?: ReadonlyMap<string, PlanCapabilityTablesInput>;
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
      // finalize 交易是词表富集的权威时点（链上 root 已定）；重复
      // PlanFinalized（流内已 finalized）不再重复计 mismatch。
      enrichPlanCapabilityTables(existing, event, state, { countMismatch: true });
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
    capabilitiesRoot,
    committedAt: provenanceOf(event),
    finalizedAt: provenanceOf(event),
    selectorBindings: [],
    signalCapabilities: [],
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
  // PlanRegistered 的 ABI 不携带词表——两表来自 finalize 时点的产物富集；
  // 这里再试一次富集，覆盖"只见 PlanRegistered"的截断流建桶路径
  //（applyPlanFinalized 未跑到），已富集的计划幂等跳过。
  const plan: MutableStateMachinePlanProjection = existing
    ? {
      ...existing,
      planHash,
      hookCount: uintArgAsString(event, "hookCount"),
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
      selectorBindings: [],
      signalCapabilities: [],
      registeredAt: provenanceOf(event),
      updatedAt: provenanceOf(event),
      proof
    };
  // 既有桶已过 finalize（mismatch 已在彼处计过一次）——注册时点只补
  // 截断流（未见 finalize）的富集与计数，不重复计。
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
  // plan 维度事件可能由模块合约发出；先用 stateMachineModules 归一化到
  // 所属状态机地址再查 exact key，消除同 planId 跨部署时回退扫描歧义
  //（matches.length !== 1）→ ProjectionError → 索引器永久 degraded 的路径。
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

/**
 * 产物富集（协议重构后的两表唯一来源）：按 planId 从编译产物读出
 * selectorBindings/signalCapabilities 填进投影，并用 capabilitiesRootOf
 * 重算断言与链上 root 一致。
 *
 * fail-closed 口径：
 * - 找不到产物（外部发布 plan / 产物未入库）→ 两表留空。词表相关推导
 *   （任务提交信号、阶段进度镜像、patch 造证）对该 plan 不可用——与旧
 *   世界"事件重建"相比是已知取舍：旧事件面能重建任何 plan 的词表，但
 *   逐条注册的 gas/事件成本正是本次重构删除的对象。链上闸（词表内事实
 *   携证验证）不受影响，只是服务端预检/造证退化为全零结构。
 * - 产物表重算 root ≠ 链上 root（或产物 planHash 不匹配）→ 不填并计
 *   capabilityEnrichmentMismatchCount（索引器消费为告警日志），不 crash
 *   indexer——把不一致的词表填进投影会让下游造出链上必拒的证明。
 *
 * 幂等：已富集的计划直接跳过（finalize 与 register 各跑一次）。
 */
function enrichPlanCapabilityTables(
  plan: MutableStateMachinePlanProjection,
  event: ChainEvent,
  state: {
    capabilityTables?: ReadonlyMap<string, PlanCapabilityTablesInput>;
    diagnostics?: ProjectionReplayDiagnostics;
  },
  options: { readonly countMismatch: boolean }
): void {
  if (plan.selectorBindings.length > 0 || plan.signalCapabilities.length > 0) {
    return;
  }
  const source = state.capabilityTables?.get(plan.planId.toLowerCase());
  if (!source) {
    return;
  }
  const countMismatch = (): void => {
    if (options.countMismatch) {
      state.diagnostics && (state.diagnostics.capabilityEnrichmentMismatchCount += 1);
    }
  };
  if (source.planHash && source.planHash.toLowerCase() !== plan.planHash.toLowerCase()) {
    // 产物锚定的 planHash 与链上 plan 不一致：同 planId 不同版本草稿，
    // 富集错表会造出对不上 root 的证明。
    countMismatch();
    return;
  }
  const capabilitiesRoot = capabilitiesRootOf(source.selectorBindings, source.signalCapabilities);
  if (!plan.capabilitiesRoot || plan.capabilitiesRoot.toLowerCase() !== capabilitiesRoot.toLowerCase()) {
    // 链上 root 缺失（截断流建桶，未见 commit/finalize 的 root）或产物表
    // 与链上词表不一致（产物过期/被改写）——都无法证明两表就是链上词表。
    countMismatch();
    return;
  }
  plan.selectorBindings = source.selectorBindings.map((binding) => ({
    selectorStageId: binding.selectorStageId,
    targetStageId: binding.targetStageId
  }));
  // provenance 锚到携带 root 的计划事件（PlanFinalized/PlanRegistered）：
  // 词表内容来自产物，链上事实是"该 root 在该事件时点已定"。
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
