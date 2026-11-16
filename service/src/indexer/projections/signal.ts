// 信号族：SignalSubmitted/DerivedSignalSubmitted 投影与信号投影键；发信权
// 由合约按 stage 的 assigned supplier account 判定，本模块只重放链上事件。
import type { ChainEvent } from "../events.js";
import type { Address, Hex } from "@uvp-eth/service-runtime";
import { encodeAbiParameters, keccak256 } from "viem";
import {
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
import type { MutableStateMachinePlanProjection } from "./plan.js";
import { markMatchingTasksSubmitted } from "./task.js";
import type { ProjectionReplayDiagnostics } from "./snapshot.js";

export interface StateMachineSignalProjection {
  readonly orderId: Hex;
  readonly sourceId: Hex;
  readonly signalId: Hex;
  readonly payloadHash: Hex;
  readonly idempotencyKey: Hex;
  readonly submitter: Address;
  readonly relayer?: Address;
  readonly factStageId?: Hex;
  readonly replayedFromFork?: boolean;
  readonly submittedAt: ProjectionProvenance;
  readonly proof: StateMachineProofProjection;
}

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
  readonly relation?: string;
  readonly submittedAt: ProjectionProvenance;
  readonly proof: StateMachineProofProjection;
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
  const relayer = optionalAddressArg(event, "relayer");
  const factStageId = optionalNonZeroBytes32Arg(event, "factStageId");
  const proof = proofOf(event, { orderId, planId: order.planId, planHash: order.planHash, submitter });
  const signal: StateMachineSignalProjection = {
    orderId,
    sourceId,
    signalId,
    payloadHash: requiredBytes32Arg(event, "payloadHash"),
    idempotencyKey: requiredBytes32Arg(event, "idempotencyKey"),
    submitter,
    ...(relayer ? { relayer } : {}),
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
  const order = ensureStateMachineOrderFromModuleEvent(state, event, targetOrderId, planId);
  const targetSourceId = requiredBytes32Arg(event, "targetSourceId");
  const signalId = requiredBytes32Arg(event, "signalId");
  const derivedSubmitter = optionalAddressArg(event, "submitter");
  const proof = proofOf(event, {
    orderId: targetOrderId,
    planId: order.planId,
    planHash: order.planHash,
    submitter: derivedSubmitter
  });
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

export function signalProjectionKey(sourceId: Hex, signalId: Hex): string {
  return `${sourceId}:${signalId}`;
}
