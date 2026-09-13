// 阶段族：StageMaterialized、阶段补丁/资源/激活/信号委派与 hook 生命周期
// 事件（HookStatusChanged/HookReady/TimerPoked）及 overlay 投影。
import type { ChainEvent } from "../events.js";
import {
  EXECUTOR_PATCH_MODE_ASSIGN,
  EXECUTOR_PATCH_MODE_HANDOFF,
  EXECUTOR_PATCH_MODE_REPLACEMENT
} from "../../shared/protocol-constants.js";
import { ProjectionError, type Address, type Hex } from "../../shared/types.js";
import {
  optionalAddressArg,
  optionalBytes32Arg,
  optionalNonZeroBytes32Arg,
  optionalStringArg,
  optionalUintArgAsString,
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
  ensureStateMachineOrder,
  ensureStateMachineOrderFromModuleEvent,
  type MutableStateMachineOrderProjection,
  type StateMachineModuleIndex
} from "./order.js";
import { findPlanForOrder, type MutableStateMachinePlanProjection } from "./plan.js";
import {
  findSignalAuthorizationForHook,
  signalProjectionKey,
  type SignalAuthorizationHookMatchInput,
  type StateMachineSignalDelegationProjection
} from "./signal.js";
import {
  addTaskSubmitSignal,
  cancelTask,
  markTaskSubmittedFromExistingSignals,
  planSubmitSignalsForStage,
  refreshTaskSubmitSignals,
  taskProjectionId,
  type MutableStateMachineTaskProjection
} from "./task.js";
import type { ProjectionReplayDiagnostics, Writable } from "./snapshot.js";

export type StateMachineHookStatus = "init" | "waiting" | "ready" | "cancelled" | "unknown";

export type StateMachineStageExecutorPatchMode = "assign" | "handoff" | "replacement";

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

export type MutableStateMachineHookProjection = Writable<StateMachineHookProjection>;

const EXECUTOR_PATCH_MODE_VALUES = {
  assign: EXECUTOR_PATCH_MODE_ASSIGN,
  handoff: EXECUTOR_PATCH_MODE_HANDOFF,
  replacement: EXECUTOR_PATCH_MODE_REPLACEMENT
} as const satisfies Record<StateMachineStageExecutorPatchMode, Hex>;

export function applyStageMaterialized(
  state: {
    orders: Map<string, MutableStateMachineOrderProjection>;
  },
  event: ChainEvent
): void {
  const orderId = requiredBytes32Arg(event, "orderId");
  const planId = optionalBytes32Arg(event, "planId");
  const order = ensureStateMachineOrder(state.orders, event, orderId, planId);
  const stageId = requiredBytes32Arg(event, "stageId");
  const proof = proofOf(event, { orderId, planId: order.planId, planHash: order.planHash });
  order.currentStage = stageId;
  order.status = "registered";
  order.updatedAt = provenanceOf(event);
  appendOrderProof(order, proof);
  appendOrderTimeline(order, timelineOf(event, "环节已启动", proof, { orderId, planId: order.planId }));
}

export function applyStageExecutorPatchApplied(
  state: {
    modules: StateMachineModuleIndex;
    diagnostics: ProjectionReplayDiagnostics;
    orders: Map<string, MutableStateMachineOrderProjection>;
  },
  event: ChainEvent
): void {
  const orderId = requiredBytes32Arg(event, "orderId");
  const planId = optionalBytes32Arg(event, "planId");
  // P0 幻影订单：StageExecutorPatchApplied 由 UVPStagePatchModule 发出。
  const order = ensureStateMachineOrderFromModuleEvent(state, event, orderId, planId);
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

export function applyStageResourcePatchApplied(
  state: {
    modules: StateMachineModuleIndex;
    diagnostics: ProjectionReplayDiagnostics;
    orders: Map<string, MutableStateMachineOrderProjection>;
  },
  event: ChainEvent
): void {
  const orderId = requiredBytes32Arg(event, "orderId");
  const planId = optionalBytes32Arg(event, "planId");
  // P0 幻影订单：StageResourcePatchApplied 由 UVPStagePatchModule 发出。
  const order = ensureStateMachineOrderFromModuleEvent(state, event, orderId, planId);
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

export function applyStageExecutorActivated(
  state: {
    orders: Map<string, MutableStateMachineOrderProjection>;
    diagnostics: ProjectionReplayDiagnostics;
  },
  event: ChainEvent
): void {
  const orderId = requiredBytes32Arg(event, "orderId");
  const planId = optionalBytes32Arg(event, "planId");
  const order = ensureStateMachineOrder(state.orders, event, orderId, planId);
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
  if (!existing) {
    // StageExecutorActivated 之前必须有 StageExecutorPatchApplied 建 overlay；
    // 缺失说明补丁事件未入流。计数显式暴露，不允许静默丢弃。
    state.diagnostics.unresolvedStageActivationEventCount += 1;
  }
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

/**
 * delegateStageExecutorSignalFromModule 在链上把 (sourceId, signalId) 的
 * 提交权委派给 executor，并携带 targetStageId 阶段绑定。同一交易内先发
 * SignalSubmitterAuthorized（order.authorizations 已有记录）再发本事件；
 * 投影用本事件补齐阶段归属，供任务 submitSignals 挂接。
 */
export function applyStageExecutorSignalDelegated(
  state: {
    orders: Map<string, MutableStateMachineOrderProjection>;
  },
  event: ChainEvent
): void {
  const orderId = requiredBytes32Arg(event, "orderId");
  const planId = optionalBytes32Arg(event, "planId");
  const order = ensureStateMachineOrder(state.orders, event, orderId, planId);
  const targetStageId = requiredBytes32Arg(event, "targetStageId");
  const sourceId = requiredBytes32Arg(event, "sourceId");
  const signalId = requiredBytes32Arg(event, "signalId");
  const executor = requiredAddressArg(event, "executor");
  const patchNonce = uintArgAsString(event, "patchNonce");
  const proof = proofOf(event, {
    orderId,
    planId: order.planId,
    planHash: order.planHash,
    submitter: executor
  });
  const delegation: StateMachineSignalDelegationProjection = {
    orderId,
    targetStageId,
    sourceId,
    signalId,
    executor,
    roleHash: requiredBytes32Arg(event, "role"),
    metadataHash: requiredBytes32Arg(event, "metadataHash"),
    patchNonce,
    delegatedAt: provenanceOf(event),
    proof
  };
  const key = signalProjectionKey(sourceId, signalId);
  const existing = order.signalDelegations[key];
  if (!existing || compareUintStrings(patchNonce, existing.patchNonce) >= 0) {
    order.signalDelegations[key] = delegation;
    markTargetStageTasksAssignedFromDelegation(order, delegation);
  }
  order.updatedAt = provenanceOf(event);
  appendOrderProof(order, proof);
  appendOrderTimeline(order, timelineOf(event, "阶段信号已委派执行方", proof, { orderId, planId: order.planId }));
}

export function applyHookStatusChanged(
  state: {
    plans: Map<string, MutableStateMachinePlanProjection>;
    orders: Map<string, MutableStateMachineOrderProjection>;
  },
  event: ChainEvent
): void {
  const orderId = requiredBytes32Arg(event, "orderId");
  const planId = optionalBytes32Arg(event, "planId");
  const order = ensureStateMachineOrder(state.orders, event, orderId, planId);
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

export function applyHookReady(
  state: {
    plans: Map<string, MutableStateMachinePlanProjection>;
    orders: Map<string, MutableStateMachineOrderProjection>;
  },
  event: ChainEvent
): void {
  const orderId = requiredBytes32Arg(event, "orderId");
  const planId = optionalBytes32Arg(event, "planId");
  const order = ensureStateMachineOrder(state.orders, event, orderId, planId);
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
    planId: order.planId,
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

export function applyTimerPoked(
  state: {
    plans: Map<string, MutableStateMachinePlanProjection>;
    orders: Map<string, MutableStateMachineOrderProjection>;
  },
  event: ChainEvent
): void {
  const orderId = requiredBytes32Arg(event, "orderId");
  const planId = optionalBytes32Arg(event, "planId");
  const order = ensureStateMachineOrder(state.orders, event, orderId, planId);
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

export function ensureStateMachineHook(
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

export function markTargetStageTasksAssignedFromOverlay(
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

/**
 * StageExecutorSignalDelegated 的阶段绑定把委派信号挂到目标阶段的
 * 任务上（submitSignals + 指派委派执行方），使词表外已授权/已提交的信号
 * 能把任务推进到 submitted——投影忠于链上事实。
 */
export function markTargetStageTasksAssignedFromDelegation(
  order: MutableStateMachineOrderProjection,
  delegation: StateMachineSignalDelegationProjection
): void {
  for (const task of Object.values(order.tasks)) {
    if (task.stageIdentifier !== delegation.targetStageId) {
      continue;
    }
    task.assigneeRole = "delegated_stage_executor";
    task.assigneeWallet = delegation.executor;
    task.assigneeRoleHash = delegation.roleHash;
    task.authorizationMetadataHash = delegation.metadataHash;
    task.updatedAt = delegation.delegatedAt;
    addTaskSubmitSignal(task, {
      sourceId: delegation.sourceId,
      signalId: delegation.signalId,
      source: "authorization"
    });
    markTaskSubmittedFromExistingSignals(order, task);
  }
}

function stageExecutorOverlayProjectionKey(targetStageId: Hex): string {
  return targetStageId.toLowerCase();
}

function stageResourceOverlayProjectionKey(targetStageId: Hex, resourceKey: Hex): string {
  return `${targetStageId.toLowerCase()}:${resourceKey.toLowerCase()}`;
}

export function findActiveStageOverlayForHook(
  order: MutableStateMachineOrderProjection,
  hook: SignalAuthorizationHookMatchInput
): StateMachineStageExecutorOverlayProjection | undefined {
  return order.stageExecutorOverlays[stageExecutorOverlayProjectionKey(hook.stageIdentifier)];
}

export function stageOverlayTaskAssignment(
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

function compareUintStrings(left: string, right: string): number {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue === rightValue ? 0 : leftValue < rightValue ? -1 : 1;
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
