// 信号族：SignalSubmitterAuthorized/SignalSubmitted/DerivedSignalSubmitted 与
// 授权-任务匹配、信号/授权投影键。
import type { ChainEvent } from "../events.js";
import type { Address, Hex } from "../../shared/types.js";
import {
  compareProofEvents,
  optionalAddressArg,
  optionalBytes32Arg,
  proofOf,
  provenanceOf,
  requiredAddressArg,
  requiredBytes32Arg,
  timelineOf,
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
import { findActiveStageOverlayForHook } from "./stage.js";
import type { MutableStateMachinePlanProjection } from "./plan.js";
import {
  addTaskSubmitSignal,
  markMatchingTasksSubmitted,
  markTaskSubmittedFromExistingSignals
} from "./task.js";
import type { StateMachineTaskSubmitSignalProjection } from "./task.js";
import type { ProjectionReplayDiagnostics } from "./snapshot.js";

export interface StateMachineSignalProjection {
  readonly orderId: Hex;
  readonly sourceId: Hex;
  readonly signalId: Hex;
  readonly payloadHash: Hex;
  readonly idempotencyKey: Hex;
  readonly submitter: Address;
  readonly submittedAt: ProjectionProvenance;
  readonly proof: StateMachineProofProjection;
}

export interface StateMachineSignalAuthorizationProjection {
  readonly orderId: Hex;
  readonly sourceId: Hex;
  readonly signalId: Hex;
  readonly submitter: Address;
  readonly role: Hex;
  readonly metadataHash: Hex;
  readonly authorizedAt: ProjectionProvenance;
  /**
   * 委任伴生授权：delegateStageExecutorSignalFromModule 同交易发出的
   * SignalSubmitterAuthorized 只反映 (sourceId, signalId) 单槽委任的当时
   * 快照（链上不写显式授权表），更高 patchNonce 的委任到达即被收回。
   * 显式（注册期）授权无此标记，不受执行者轮换影响。
   */
  readonly delegated?: boolean;
  readonly proof: StateMachineProofProjection;
}

/**
 * StageExecutorSignalDelegated 事实：delegateStageExecutorSignalFromModule 在
 * 链上把 (sourceId, signalId) 的提交权委派给 executor，并显式携带
 * targetStageId——这是词表外授权唯一的链上阶段绑定。任务投影用它把授权
 * 信号挂到对应阶段的任务上（见 refreshTaskSubmitSignals）。
 */
export interface StateMachineSignalDelegationProjection {
  readonly orderId: Hex;
  readonly targetStageId: Hex;
  readonly sourceId: Hex;
  readonly signalId: Hex;
  readonly executor: Address;
  readonly roleHash: Hex;
  readonly metadataHash: Hex;
  readonly patchNonce: string;
  readonly delegatedAt: ProjectionProvenance;
  readonly proof: StateMachineProofProjection;
}

export function applySignalSubmitterAuthorized(
  state: {
    orders: Map<string, MutableStateMachineOrderProjection>;
  },
  event: ChainEvent
): void {
  const orderId = requiredBytes32Arg(event, "orderId");
  const planId = optionalBytes32Arg(event, "planId");
  const order = ensureStateMachineOrder(state.orders, event, orderId, planId);
  const sourceId = requiredBytes32Arg(event, "sourceId");
  const signalId = requiredBytes32Arg(event, "signalId");
  const submitter = requiredAddressArg(event, "submitter");
  const authorization: StateMachineSignalAuthorizationProjection = {
    orderId,
    sourceId,
    signalId,
    submitter,
    role: requiredBytes32Arg(event, "role"),
    metadataHash: requiredBytes32Arg(event, "metadataHash"),
    authorizedAt: provenanceOf(event),
    proof: proofOf(event, { orderId, planId: order.planId, planHash: order.planHash, submitter })
  };

  order.authorizations[signalAuthorizationProjectionKey(sourceId, signalId, submitter)] = authorization;
  order.updatedAt = provenanceOf(event);
  markMatchingTasksAssigned(order, authorization);
  appendOrderProof(order, authorization.proof);
  appendOrderTimeline(order, timelineOf(event, "执行授权已写入链上", authorization.proof, { orderId, planId: order.planId }));
}

export function applySignalSubmitted(
  state: {
    plans: Map<string, MutableStateMachinePlanProjection>;
    orders: Map<string, MutableStateMachineOrderProjection>;
  },
  event: ChainEvent
): void {
  const orderId = requiredBytes32Arg(event, "orderId");
  const planId = optionalBytes32Arg(event, "planId");
  const order = ensureStateMachineOrder(state.orders, event, orderId, planId);
  const sourceId = requiredBytes32Arg(event, "sourceId");
  const signalId = requiredBytes32Arg(event, "signalId");
  const submitter = requiredAddressArg(event, "submitter");
  const proof = proofOf(event, { orderId, planId: order.planId, planHash: order.planHash, submitter });
  const signal: StateMachineSignalProjection = {
    orderId,
    sourceId,
    signalId,
    payloadHash: requiredBytes32Arg(event, "payloadHash"),
    idempotencyKey: requiredBytes32Arg(event, "idempotencyKey"),
    submitter,
    submittedAt: provenanceOf(event),
    proof
  };
  order.signals[signalProjectionKey(sourceId, signalId)] = signal;
  order.status = "registered";
  order.updatedAt = provenanceOf(event);
  markMatchingTasksSubmitted(order, sourceId, signalId, proof);
  appendOrderProof(order, proof);
  appendOrderTimeline(order, timelineOf(event, "确认动作已写入链上", proof, { orderId, planId: order.planId }));
}

export function applyDerivedSignalSubmitted(
  state: {
    modules: StateMachineModuleIndex;
    diagnostics: ProjectionReplayDiagnostics;
    orders: Map<string, MutableStateMachineOrderProjection>;
  },
  event: ChainEvent
): void {
  const targetOrderId = requiredBytes32Arg(event, "targetOrderId");
  const planId = optionalBytes32Arg(event, "targetPlanId") ?? optionalBytes32Arg(event, "planId");
  // 幻影订单：DerivedSignalSubmitted 由 UVPDerivedSignalModule 发出。
  const order = ensureStateMachineOrderFromModuleEvent(state, event, targetOrderId, planId);
  const proof = proofOf(event, {
    orderId: targetOrderId,
    planId: order.planId,
    planHash: order.planHash,
    submitter: optionalAddressArg(event, "submitter")
  });
  order.updatedAt = provenanceOf(event);
  appendOrderProof(order, proof);
  appendOrderTimeline(order, timelineOf(event, "派生信号已提交", proof, { orderId: targetOrderId, planId: order.planId }));
}

export function markMatchingTasksAssigned(
  order: MutableStateMachineOrderProjection,
  authorization: StateMachineSignalAuthorizationProjection
): void {
  let changed = false;
  for (const task of Object.values(order.tasks)) {
    if (findActiveStageOverlayForHook(order, task)) {
      continue;
    }
    if (!signalAuthorizationMatchesHook(authorization, task)) {
      continue;
    }
    task.assigneeRole = "authorized_submitter";
    task.assigneeWallet = authorization.submitter;
    task.assigneeRoleHash = authorization.role;
    task.authorizationMetadataHash = authorization.metadataHash;
    task.updatedAt = authorization.authorizedAt;
    addTaskSubmitSignal(task, {
      sourceId: authorization.sourceId,
      signalId: authorization.signalId,
      source: "authorization"
    });
    changed = markTaskSubmittedFromExistingSignals(order, task) || changed;
  }
  void changed;
}

export function signalProjectionKey(sourceId: Hex, signalId: Hex): string {
  return `${sourceId}:${signalId}`;
}

/**
 * StageExecutorSignalDelegated 落地后的授权收回：链上委任槽按
 * (sourceId, signalId) 单槽替换（nonce 递增覆盖 executor），历史轮换
 * 留下的 delegation-born 授权投影必须随之收回，否则被替换执行者仍在
 * "当前在任提交者集"里（轮换 A→B 后 A 的 verdict authorized:true 而链上
 * UnauthorizedSignalSubmitter revert）。同交易的伴生
 * SignalSubmitterAuthorized 标记为 delegated；本键上其余 delegated 授权
 * （被替换的旧执行者）删除。显式（注册期）授权在链上先于 executor 门
 * 检查、从不因委任被收回，必须保留。
 */
export function revokeSupersededDelegatedAuthorizations(
  order: MutableStateMachineOrderProjection,
  delegation: Pick<
    StateMachineSignalDelegationProjection,
    "sourceId" | "signalId" | "executor" | "delegatedAt"
  >
): void {
  const companionKey = signalAuthorizationProjectionKey(delegation.sourceId, delegation.signalId, delegation.executor);
  for (const [key, authorization] of Object.entries(order.authorizations)) {
    if (authorization.sourceId !== delegation.sourceId || authorization.signalId !== delegation.signalId) {
      continue;
    }
    if (key === companionKey && isSameTransaction(authorization.authorizedAt, delegation.delegatedAt)) {
      if (!authorization.delegated) {
        order.authorizations[key] = { ...authorization, delegated: true };
      }
      continue;
    }
    if (authorization.delegated === true) {
      delete order.authorizations[key];
    }
  }
}

function isSameTransaction(left: ProjectionProvenance, right: ProjectionProvenance): boolean {
  return left.chainId === right.chainId &&
    left.blockNumber === right.blockNumber &&
    left.transactionHash.toLowerCase() === right.transactionHash.toLowerCase();
}

export function signalAuthorizationProjectionKey(sourceId: Hex, signalId: Hex, submitter: Address): string {
  return `${sourceId}:${signalId}:${submitter.toLowerCase()}`;
}

export function findSignalAuthorizationForHook(
  order: MutableStateMachineOrderProjection,
  hook: SignalAuthorizationHookMatchInput
): StateMachineSignalAuthorizationProjection | undefined {
  return Object.values(order.authorizations)
    .sort(compareSignalAuthorizations)
    .find((authorization) => signalAuthorizationMatchesHook(authorization, hook));
}

export interface SignalAuthorizationHookMatchInput {
  readonly stageIdentifier: Hex;
  readonly hookId: Hex;
  readonly hookName: Hex;
  readonly submitSignals?: readonly StateMachineTaskSubmitSignalProjection[];
}

export function signalAuthorizationMatchesHook(
  authorization: StateMachineSignalAuthorizationProjection,
  hook: SignalAuthorizationHookMatchInput
): boolean {
  // 除 plan 词表外，sourceId/signalId 即 hookId 是链上授权与任务的
  // 另一个事实绑定键（taskMatchesSubmittedSignal 的既有回退口径一致）。
  if (hook.hookId === authorization.sourceId || hook.hookId === authorization.signalId) {
    return true;
  }
  return authorizationMatchesSubmitSignals(authorization, hook.submitSignals ?? []);
}

function authorizationMatchesSubmitSignals(
  authorization: StateMachineSignalAuthorizationProjection,
  submitSignals: readonly StateMachineTaskSubmitSignalProjection[]
): boolean {
  return submitSignals.some((signal) =>
    signal.sourceId === authorization.sourceId && signal.signalId === authorization.signalId
  );
}

export function compareSignalAuthorizations(
  left: StateMachineSignalAuthorizationProjection,
  right: StateMachineSignalAuthorizationProjection
): number {
  return compareProofEvents(left.proof, right.proof);
}
