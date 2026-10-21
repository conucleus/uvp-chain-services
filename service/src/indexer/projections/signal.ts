// 信号族：SignalSubmitterAuthorized/SignalSubmitted/DerivedSignalSubmitted 与
// 授权-任务匹配、信号投影键。
// patch 生效授权由 authorizeSignalSubmittersFromModule 写显式订单级
// 授权（本文件投影的 SignalSubmitterAuthorized 事件流即其完整重建源）。
import type { ChainEvent } from "../events.js";
import type { Address, Hex } from "../../shared/types.js";
import { encodeAbiParameters, keccak256 } from "viem";
import {
  compareProofEvents,
  optionalAddressArg,
  optionalBytes32Arg,
  optionalNonZeroBytes32Arg,
  optionalUintArgAsString,
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
  /**
   * 事实归属阶段（B-03，SignalSubmitted.factStageId）：0/缺省 = 词表外
   * 事实——per-stage 归属与计数从事件流重建，不依赖 stageSignalState view。
   * 旧事件面（无该字段的历史流）缺省。
   */
  readonly factStageId?: Hex;
  /**
   * fork 重放标记（B-03）：signal 键命中 OrderForked.replayedFactKeys
   * （keccak256(abi.encode(sourceId, signalId))）时为 true——该事实是
   * 父单事实在 fork 出生事务内的重放，不是 fork 单新生。
   */
  readonly replayedFromFork?: boolean;
  readonly submittedAt: ProjectionProvenance;
  readonly proof: StateMachineProofProjection;
}

/**
 * 派生信号血缘（B-03，DerivedSignalSubmitted 全参数投影）：此前投影只读
 * targetOrderId/planId/submitter，丢弃 from 复合身份、relation 与载荷
 * 承诺——派生通道授权面（relation=0 本单生产 / 1 triggerOrigin 回写）
 * 现在可从事件流全量重建。
 */
export interface StateMachineDerivedSignalProjection {
  readonly targetOrderId: Hex;
  readonly fromPlanId: Hex;
  readonly fromOrderId: Hex;
  readonly fromStageId: Hex;
  readonly targetSourceId: Hex;
  readonly signalId: Hex;
  readonly payloadHash: Hex;
  readonly idempotencyKey: Hex;
  readonly submitter?: Address;
  /** 目标单关系（事件词序）：0 = 本单生产，1 = triggerOrigin。 */
  readonly relation?: string;
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
  // B-03 事实归属阶段（旧事件面缺省；零字 = 词表外事实，归一为缺省）。
  const factStageId = optionalNonZeroBytes32Arg(event, "factStageId");
  const proof = proofOf(event, { orderId, planId: order.planId, planHash: order.planHash, submitter });
  const signal: StateMachineSignalProjection = {
    orderId,
    sourceId,
    signalId,
    payloadHash: requiredBytes32Arg(event, "payloadHash"),
    idempotencyKey: requiredBytes32Arg(event, "idempotencyKey"),
    submitter,
    ...(factStageId ? { factStageId } : {}),
    ...(isForkReplayedFact(order, sourceId, signalId) ? { replayedFromFork: true } : {}),
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

/**
 * fork 重放判据（B-03）：OrderForked.replayedFactKeys 携带
 * keccak256(abi.encode(sourceId, signalId))（合约 _signalKey 同式）；
 * 事实键命中清单即父单事实重放。OrderForked 在重放 SignalSubmitted 之前
 * 落日志（forkOrderGate 先于 forkOrderReplay），血缘在信号到达时已在桶上。
 */
function isForkReplayedFact(
  order: MutableStateMachineOrderProjection,
  sourceId: Hex,
  signalId: Hex
): boolean {
  const replayedFactKeys = order.forkLineage?.replayedFactKeys;
  if (!replayedFactKeys || replayedFactKeys.length === 0) {
    return false;
  }
  const factKey = keccak256(
    encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [sourceId, signalId])
  );
  return replayedFactKeys.some((key) => key.toLowerCase() === factKey.toLowerCase());
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
  const targetSourceId = requiredBytes32Arg(event, "targetSourceId");
  const signalId = requiredBytes32Arg(event, "signalId");
  const proof = proofOf(event, {
    orderId: targetOrderId,
    planId: order.planId,
    planHash: order.planHash,
    submitter: optionalAddressArg(event, "submitter")
  });
  // B-03 全参数投影：from 复合身份、relation 与载荷承诺按事实键落桶
  //（旧事件面的缺失字段按可选读取）。
  const derivedSubmitter = optionalAddressArg(event, "submitter");
  const derivedRelation = optionalUintArgAsString(event, "relation");
  const derived: StateMachineDerivedSignalProjection = {
    targetOrderId,
    fromPlanId: requiredBytes32Arg(event, "fromPlanId"),
    fromOrderId: requiredBytes32Arg(event, "fromOrderId"),
    fromStageId: requiredBytes32Arg(event, "fromStageId"),
    targetSourceId,
    signalId,
    payloadHash: requiredBytes32Arg(event, "payloadHash"),
    idempotencyKey: requiredBytes32Arg(event, "idempotencyKey"),
    ...(derivedSubmitter ? { submitter: derivedSubmitter } : {}),
    ...(derivedRelation !== undefined ? { relation: derivedRelation } : {}),
    submittedAt: provenanceOf(event),
    proof
  };
  order.derivedSignals[signalProjectionKey(targetSourceId, signalId)] = derived;
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
