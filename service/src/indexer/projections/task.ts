// 任务族：hook ready 生成的任务投影与提交信号推进，供 plan/signal/stage 事件族
// 在任务完成判定中复用；任务的 supplier/effective executor 由重放期统一解析。
import type { Address, Hex } from "@uvp-eth/service-runtime";
import {
  compareProofEvents,
  type ProjectionProvenance,
  type StateMachineProofProjection
} from "./proof.js";
import type { MutableStateMachineOrderProjection } from "./order.js";
import type { MutableStateMachinePlanProjection } from "./plan.js";
import { signalProjectionKey } from "./signal.js";
import type { Writable } from "./snapshot.js";

export type StateMachineTaskStatus = "ready" | "submitted" | "cancelled" | "unknown";

export interface StateMachineTaskProjection {
  readonly taskId: string;
  readonly orderId: Hex;
  readonly stateMachineAddress: Address;
  readonly planId?: Hex;
  readonly deploymentId?: Hex;
  readonly hookId: Hex;
  readonly stageIdentifier: Hex;
  readonly hookName: Hex;
  readonly assigneeSupplierId?: Hex;
  readonly assigneeExecutor?: Address;
  readonly status: StateMachineTaskStatus;
  readonly submitSignals?: readonly StateMachineTaskSubmitSignalProjection[];
  readonly createdAt: ProjectionProvenance;
  readonly updatedAt: ProjectionProvenance;
  readonly proof: StateMachineProofProjection;
}

export interface StateMachineTaskSubmitSignalProjection {
  readonly sourceId: Hex;
  readonly signalId: Hex;
}

export type MutableStateMachineTaskProjection = Writable<StateMachineTaskProjection>;

export function markMatchingTasksSubmitted(
  order: MutableStateMachineOrderProjection,
  sourceId: Hex,
  signalId: Hex,
  proof: StateMachineProofProjection
): void {
  for (const task of Object.values(order.tasks)) {
    if (!taskMatchesSubmittedSignal(task, sourceId, signalId)) {
      continue;
    }
    markTaskSubmitted(task, proof);
  }
}

export function refreshTaskSubmitSignals(
  task: MutableStateMachineTaskProjection,
  plan?: MutableStateMachinePlanProjection
): void {
  const signals = [...planSubmitSignalsForStage(plan, task.stageIdentifier)];
  task.submitSignals = dedupeTaskSubmitSignals(signals);
  if (task.submitSignals.length === 0) {
    delete task.submitSignals;
  }
}

export function planSubmitSignalsForStage(
  plan: MutableStateMachinePlanProjection | undefined,
  stageId: Hex
): readonly StateMachineTaskSubmitSignalProjection[] {
  return (plan?.signalCapabilities ?? [])
    .filter((capability) => capability.stageId === stageId && capability.targetOrderRelation === "current")
    .map((capability) => ({
      sourceId: capability.targetSourceId,
      signalId: capability.signalId
    }));
}

function dedupeTaskSubmitSignals(
  signals: readonly StateMachineTaskSubmitSignalProjection[]
): readonly StateMachineTaskSubmitSignalProjection[] {
  const byKey = new Map<string, StateMachineTaskSubmitSignalProjection>();
  for (const signal of signals) {
    byKey.set(signalProjectionKey(signal.sourceId, signal.signalId), signal);
  }
  return [...byKey.values()].sort(compareTaskSubmitSignals);
}

function compareTaskSubmitSignals(
  left: StateMachineTaskSubmitSignalProjection,
  right: StateMachineTaskSubmitSignalProjection
): number {
  return left.sourceId.localeCompare(right.sourceId) || left.signalId.localeCompare(right.signalId);
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

export function markTaskSubmittedFromExistingSignals(
  order: MutableStateMachineOrderProjection,
  task: MutableStateMachineTaskProjection
): boolean {
  const matchingProof = Object.values(order.signals)
    .filter((signal) => taskMatchesSubmittedSignal(task, signal.sourceId, signal.signalId))
    .map((signal) => signal.proof)
    .sort(compareProofEvents)[0];
  return matchingProof ? markTaskSubmitted(task, matchingProof) : false;
}

export function markTaskSubmitted(
  task: MutableStateMachineTaskProjection,
  proof: StateMachineProofProjection
): boolean {
  if (task.status === "submitted") {
    if (compareProofEvents(proof, task.proof) >= 0) {
      return false;
    }
  }
  if (task.status === "cancelled") {
    return false;
  }
  task.status = "submitted";
  task.updatedAt = proof;
  task.proof = proof;
  return true;
}

export function cancelTask(
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

export function taskProjectionId(orderId: Hex, hookId: Hex, stateMachineAddress?: Address): string {
  return stateMachineAddress ? `${stateMachineAddress}:${orderId}:${hookId}` : `${orderId}:${hookId}`;
}
