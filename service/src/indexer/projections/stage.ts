// 阶段族：StageMaterialized、阶段执行方补丁/激活与 hook 生命周期事件
// （HookStatusChanged/HookReady/TimerPoked）及 executor overlay 投影。
// overlay 只表达链上 active patch（supplierId/patchNonce/dockId）；effective
// executor 由 SupplierRegistry 事件重放解析，不在本文件查链或查库。
import type { ChainEvent } from "../events.js";
import type { Address, Hex } from "@uvp-eth/service-runtime";
import {
  optionalBytes32Arg,
  optionalNonZeroBytes32Arg,
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
  cancelTask,
  markTaskSubmittedFromExistingSignals,
  refreshTaskSubmitSignals,
  taskProjectionId,
  type MutableStateMachineTaskProjection
} from "./task.js";
import type { ProjectionReplayDiagnostics, Writable } from "./snapshot.js";

export type StateMachineHookStatus = "init" | "waiting" | "ready" | "cancelled" | "unknown";

export interface StateMachineStageExecutorOverlayProjection {
  readonly orderId: Hex;
  readonly selectorStageId?: Hex;
  readonly targetStageId: Hex;
  readonly selector?: Address;
  readonly supplierId: Hex;
  readonly previousSupplierId?: Hex;
  readonly patchNonce: string;
  readonly dockId?: Hex;
  readonly fromPlanId?: Hex;
  readonly effectiveExecutor?: Address;
  readonly updatedAt: ProjectionProvenance;
  readonly activatedAt?: ProjectionProvenance;
  readonly proof: StateMachineProofProjection;
  readonly activationProof?: StateMachineProofProjection;
}

export type MutableStateMachineStageExecutorOverlayProjection =
  Writable<StateMachineStageExecutorOverlayProjection>;

export interface StateMachineHookProjection {
  readonly orderId: Hex;
  readonly hookId: Hex;
  readonly stageIdentifier?: Hex;
  readonly hookName?: Hex;
  readonly status: StateMachineHookStatus;
  readonly previousStatus?: StateMachineHookStatus;
  readonly dueAt?: string;
  readonly updatedAt: ProjectionProvenance;
  readonly readyAt?: ProjectionProvenance;
  readonly proof: StateMachineProofProjection;
}

export interface StateMachineStageMaterializationProjection {
  readonly orderId: Hex;
  readonly stageId: Hex;
  readonly triggerHookId?: Hex;
  readonly sourceId?: Hex;
  readonly signalId?: Hex;
  readonly materializedAt: ProjectionProvenance;
  readonly proof: StateMachineProofProjection;
}

export type MutableStateMachineHookProjection = Writable<StateMachineHookProjection>;

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
  const triggerHookId = optionalBytes32Arg(event, "triggerHookId");
  const triggerSourceId = optionalBytes32Arg(event, "sourceId");
  const triggerSignalId = optionalBytes32Arg(event, "signalId");
  order.currentStage = stageId;
  order.status = "registered";
  order.stageMaterializations[stageId] = {
    orderId,
    stageId,
    ...(triggerHookId ? { triggerHookId } : {}),
    ...(triggerSourceId ? { sourceId: triggerSourceId } : {}),
    ...(triggerSignalId ? { signalId: triggerSignalId } : {}),
    materializedAt: provenanceOf(event),
    proof
  };
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
  const order = ensureStateMachineOrderFromModuleEvent(state, event, orderId, planId);
  const selectorStageId = requiredBytes32Arg(event, "selectorStageId");
  const targetStageId = requiredBytes32Arg(event, "targetStageId");
  const selector = requiredAddressArg(event, "selector");
  const supplierId = requiredBytes32Arg(event, "supplierId");
  const previousSupplierId = optionalNonZeroBytes32Arg(event, "previousSupplierId");
  const patchNonce = uintArgAsString(event, "patchNonce");
  const proof = proofOf(event, {
    orderId,
    planId: order.planId,
    planHash: order.planHash,
    submitter: selector
  });
  const key = stageExecutorOverlayProjectionKey(targetStageId);
  const existing = order.stageExecutorOverlays[key];
  if (!existing || compareUintStrings(patchNonce, existing.patchNonce) === 0) {
    order.stageExecutorOverlays[key] = {
      ...(existing ?? {}),
      orderId,
      selectorStageId,
      targetStageId,
      selector,
      supplierId,
      ...(previousSupplierId ? { previousSupplierId } : {}),
      patchNonce,
      updatedAt: provenanceOf(event),
      proof
    };
  } else if (compareUintStrings(patchNonce, existing.patchNonce) > 0) {
    order.stageExecutorOverlays[key] = {
      orderId,
      selectorStageId,
      targetStageId,
      selector,
      supplierId,
      ...(previousSupplierId ? { previousSupplierId } : {}),
      patchNonce,
      updatedAt: provenanceOf(event),
      proof
    };
  }
  order.updatedAt = provenanceOf(event);
  appendOrderProof(order, proof);
  appendOrderTimeline(order, timelineOf(event, "阶段执行方已更新", proof, { orderId, planId: order.planId }));
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
  const supplierId = requiredBytes32Arg(event, "supplierId");
  const patchNonce = uintArgAsString(event, "patchNonce");
  const proof = proofOf(event, {
    orderId,
    planId: order.planId,
    planHash: order.planHash
  });
  const key = stageExecutorOverlayProjectionKey(targetStageId);
  const existing = order.stageExecutorOverlays[key];
  if (!existing || compareUintStrings(patchNonce, existing.patchNonce) >= 0) {
    const sameNonce = existing !== undefined && compareUintStrings(patchNonce, existing.patchNonce) === 0;
    order.stageExecutorOverlays[key] = sameNonce
      ? {
        ...existing,
        supplierId,
        patchNonce,
        updatedAt: provenanceOf(event),
        activatedAt: provenanceOf(event),
        proof,
        activationProof: proof
      }
      : {
        orderId,
        targetStageId,
        supplierId,
        patchNonce,
        updatedAt: provenanceOf(event),
        activatedAt: provenanceOf(event),
        proof,
        activationProof: proof
      };
  }
  order.updatedAt = provenanceOf(event);
  appendOrderProof(order, proof);
  appendOrderTimeline(order, timelineOf(event, "阶段执行方已激活", proof, { orderId, planId: order.planId }));
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
  const previousStatus = hookStatusFromArg(event.args["previousStatus"]);
  const dueAt = optionalUintArgAsString(event, "dueAt");
  const proof = proofOf(event, { orderId, planId: order.planId, planHash: order.planHash });
  const hook = ensureStateMachineHook(order, event, hookId, proof);
  hook.status = hookStatus;
  if (previousStatus !== "unknown") {
    hook.previousStatus = previousStatus;
  }
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
    status: "ready",
    createdAt: provenanceOf(event),
    updatedAt: provenanceOf(event),
    proof
  };
  refreshTaskSubmitSignals(task, plan);
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

export function findStageExecutorOverlay(
  order: MutableStateMachineOrderProjection,
  targetStageId: Hex
): MutableStateMachineStageExecutorOverlayProjection | undefined {
  return order.stageExecutorOverlays[stageExecutorOverlayProjectionKey(targetStageId)];
}

function stageExecutorOverlayProjectionKey(targetStageId: Hex): string {
  return targetStageId.toLowerCase();
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
