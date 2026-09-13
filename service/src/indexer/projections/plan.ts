// 计划族：PlanCommitted/Finalized/Registered/PublisherRecorded 与 plan 元数据
// 模块事件（词表能力、阶段选择绑定）及计划投影构造。
import type { ChainEvent } from "../events.js";
import { ProjectionError, normalizeBytes32, type Address, type Hex } from "../../shared/types.js";
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
  type Writable
} from "./snapshot.js";
import { markTaskSubmittedFromExistingSignals, refreshTaskSubmitSignals } from "./task.js";

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

export type MutableStateMachinePlanProjection = Writable<StateMachinePlanProjection>;

/**
 * 真实事件顺序（UVPStateMachine v0.10）：commitPlan 同一交易先发
 * PlanCommitted 再发 PlanPublisherRecorded；finalizePlan 内先调用 plan
 * metadata 模块（SignalCapabilityRegistered 等，logIndex 更小），随后才发
 * PlanFinalized + PlanRegistered。投影必须在 PlanCommitted 建 plan 桶，
 * 否则 finalize 交易内的模块事件全部撞"unknown plan"→ ProjectionError →
 * 索引器永久 degraded。
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

export function applyPlanFinalized(
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

export function applyPlanRegistered(
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

export function applyStageSelectorBindingRegistered(
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

export function applySignalCapabilityRegistered(
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

export function findPlanForEvent(
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

export function findPlanForOrder(
  plans: Map<string, MutableStateMachinePlanProjection>,
  order: MutableStateMachineOrderProjection
): MutableStateMachinePlanProjection | undefined {
  return plans.get(stateMachineScopedKey(order.chainId, order.contractAddress, order.planId));
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
