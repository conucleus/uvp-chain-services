// 任务族：任务投影与提交信号构造/推进（refreshTaskSubmitSignals 等），供
// plan/signal/stage 事件族在任务指派与完成判定中复用。
import type { Address, Hex } from "../../shared/types.js";
import {
  compareProofEvents,
  type ProjectionProvenance,
  type StateMachineProofProjection
} from "./proof.js";
import type { MutableStateMachineOrderProjection } from "./order.js";
import type { MutableStateMachinePlanProjection } from "./plan.js";
import { signalAuthorizationMatchesHook, signalProjectionKey } from "./signal.js";
import type { Writable } from "./snapshot.js";

export type StateMachineTaskStatus = "ready" | "submitted" | "cancelled" | "unknown";

export interface StateMachineTaskProjection {
  readonly taskId: string;
  readonly orderId: Hex;
  readonly stateMachineAddress: Address;
  /**
   * Stable API-facing identifier (hook/order), while the projection itself is
   * plan-scoped.  Keeping the plan id on the flattened row lets consumers join
   * a task back to the right order when two plans intentionally reuse the same
   * orderId and hookId.
   */
  readonly planId?: Hex;
  readonly deploymentId?: Hex;
  readonly hookId: Hex;
  readonly stageIdentifier: Hex;
  readonly hookName: Hex;
  readonly assigneeRole: string;
  readonly assigneeWallet?: Address;
  readonly assigneeRoleHash?: Hex;
  readonly authorizationMetadataHash?: Hex;
  readonly status: StateMachineTaskStatus;
  readonly submitSignals?: readonly StateMachineTaskSubmitSignalProjection[];
  readonly createdAt: ProjectionProvenance;
  readonly updatedAt: ProjectionProvenance;
  readonly proof: StateMachineProofProjection;
}

export interface StateMachineTaskSubmitSignalProjection {
  readonly sourceId: Hex;
  readonly signalId: Hex;
  readonly source: "plan_capability" | "authorization";
}

export type MutableStateMachineTaskProjection = Writable<StateMachineTaskProjection>;

export function markMatchingTasksSubmitted(
  order: MutableStateMachineOrderProjection,
  sourceId: Hex,
  signalId: Hex,
  proof: StateMachineProofProjection
): void {
  let changed = false;
  for (const task of Object.values(order.tasks)) {
    if (!taskMatchesSubmittedSignal(task, sourceId, signalId)) {
      continue;
    }
    changed = markTaskSubmitted(task, proof) || changed;
  }

  void changed;
}

export function refreshTaskSubmitSignals(
  order: MutableStateMachineOrderProjection,
  task: MutableStateMachineTaskProjection,
  plan?: MutableStateMachinePlanProjection
): void {
  const signals: StateMachineTaskSubmitSignalProjection[] = [...planSubmitSignalsForStage(plan, task.stageIdentifier)];
  for (const authorization of Object.values(order.authorizations)) {
    if (!signalAuthorizationMatchesHook(authorization, { ...task, submitSignals: signals })) {
      continue;
    }
    signals.push({
      sourceId: authorization.sourceId,
      signalId: authorization.signalId,
      source: "authorization"
    });
  }
  // 合约 _authorizeSignalSubmitter 不校验 plan 能力词表——授权可以
  // 落链在词表之外。任务完成判定以链上事实为准：词表外授权通过两个链上
  // 绑定键挂到任务：sourceId/signalId 即任务 hookId（既有回退键），或
  // StageExecutorSignalDelegated 显式携带的 targetStageId 阶段归属。
  // 否则 SignalSubmitted 落链后任务永远停在 ready。
  for (const authorization of Object.values(order.authorizations)) {
    if (task.hookId === authorization.sourceId || task.hookId === authorization.signalId) {
      signals.push({
        sourceId: authorization.sourceId,
        signalId: authorization.signalId,
        source: "authorization"
      });
    }
  }
  for (const delegation of Object.values(order.signalDelegations)) {
    if (delegation.targetStageId === task.stageIdentifier) {
      signals.push({
        sourceId: delegation.sourceId,
        signalId: delegation.signalId,
        source: "authorization"
      });
    }
  }
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
      signalId: capability.signalId,
      source: "plan_capability" as const
    }));
}

export function addTaskSubmitSignal(
  task: MutableStateMachineTaskProjection,
  signal: StateMachineTaskSubmitSignalProjection
): void {
  task.submitSignals = dedupeTaskSubmitSignals([...(task.submitSignals ?? []), signal]);
}

function dedupeTaskSubmitSignals(
  signals: readonly StateMachineTaskSubmitSignalProjection[]
): readonly StateMachineTaskSubmitSignalProjection[] {
  const byKey = new Map<string, StateMachineTaskSubmitSignalProjection>();
  for (const signal of signals) {
    const key = signalProjectionKey(signal.sourceId, signal.signalId);
    const existing = byKey.get(key);
    if (!existing || existing.source !== "plan_capability") {
      byKey.set(key, signal);
    }
  }
  return [...byKey.values()].sort(compareTaskSubmitSignals);
}

function compareTaskSubmitSignals(
  left: StateMachineTaskSubmitSignalProjection,
  right: StateMachineTaskSubmitSignalProjection
): number {
  const sourcePriority = taskSubmitSignalSourcePriority(left.source) - taskSubmitSignalSourcePriority(right.source);
  return sourcePriority || left.sourceId.localeCompare(right.sourceId) || left.signalId.localeCompare(right.signalId);
}

function taskSubmitSignalSourcePriority(source: StateMachineTaskSubmitSignalProjection["source"]): number {
  return source === "plan_capability" ? 0 : 1;
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
    // submitted 是已成立的完成事实。后到的匹配信号不得覆盖首个
    // 完成证明与 updatedAt（与创建路径取最早证明同口径）；仅当链上位置
    // 更早时才修正为真正最早的事实（容忍乱序回放）。
    if (compareProofEvents(proof, task.proof) >= 0) {
      return false;
    }
  }
  if (task.status === "cancelled") {
    // HookStatusChanged(cancelled) 是链上终态事实。taskMatchesSubmittedSignal
    // 的宽松回退键（hookId === sourceId/signalId）可能匹配到无关信号，
    // 不得借此把已撤销任务复活成 submitted；hook 重开会经 HookReady 重建
    // ready 任务，合法的再提交走新任务。
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
