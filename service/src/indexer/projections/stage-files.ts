// 阶段文件事件族：重放 UVPFileResourceModule 的 StageFileWritten，按事件
// 顺序构造 per-(plan,order,targetStage) 的 key -> payload map；事件形状与
// stage file 读面的唯一来源是文件模块 ABI，本模块只重放不推导。
import { ProjectionError, type Hex } from "@uvp-eth/service-runtime";
import type { ChainEvent } from "../events.js";
import {
  optionalStringArg,
  proofOf,
  provenanceOf,
  requiredBytes32Arg,
  requiredAddressArg,
  timelineOf,
  type ProjectionProvenance,
  type StateMachineProofProjection
} from "./proof.js";
import {
  appendOrderProof,
  appendOrderTimeline,
  ensureStateMachineOrderFromModuleEvent,
  type MutableStateMachineOrderProjection,
  type StateMachineModuleIndex
} from "./order.js";
import type { ProjectionReplayDiagnostics } from "./snapshot.js";

export interface StateMachineStageFileEntryProjection {
  readonly key: string;
  readonly payload: Hex;
  readonly updatedAt: ProjectionProvenance;
  readonly proof: StateMachineProofProjection;
}

export interface StateMachineStageFileMapProjection {
  readonly planId: Hex;
  readonly orderId: Hex;
  readonly targetStageId: Hex;
  readonly files: Readonly<Record<string, StateMachineStageFileEntryProjection>>;
  readonly updatedAt: ProjectionProvenance;
  readonly proof: StateMachineProofProjection;
}

interface StageFileReplayContext {
  readonly modules: StateMachineModuleIndex;
  readonly diagnostics: ProjectionReplayDiagnostics;
  readonly orders: Map<string, MutableStateMachineOrderProjection>;
}

export function applyStageFileWritten(state: StageFileReplayContext, event: ChainEvent): void {
  const orderId = requiredBytes32Arg(event, "orderId");
  const planId = requiredBytes32Arg(event, "planId");
  const order = ensureStateMachineOrderFromModuleEvent(state, event, orderId, planId);
  const targetStageId = requiredBytes32Arg(event, "targetStageId");
  const key = optionalStringArg(event, "key");
  if (key === undefined || key.length === 0) {
    throw new ProjectionError(`${event.eventName} carries an empty stage file key`);
  }
  const payload = hexPayload(event, key);
  const proof = proofOf(event, {
    orderId,
    planId: order.planId,
    planHash: order.planHash,
    submitter: requiredAddressArg(event, "submitter")
  });
  const existing = order.stageFiles[targetStageId];
  const files = existing === undefined ? {} : { ...existing.files };
  Object.defineProperty(files, key, {
    value: {
      key,
      payload,
      updatedAt: provenanceOf(event),
      proof
    },
    enumerable: true,
    configurable: true,
    writable: true
  });
  order.stageFiles[targetStageId] = {
    planId: order.planId,
    orderId: order.orderId,
    targetStageId,
    files,
    updatedAt: provenanceOf(event),
    proof
  };
  order.updatedAt = provenanceOf(event);
  appendOrderProof(order, proof);
  appendOrderTimeline(order, timelineOf(event, "阶段文件已写入", proof, {
    orderId,
    planId: order.planId
  }));
}

function hexPayload(event: ChainEvent, key: string): Hex {
  const value = event.args["payload"];
  if (typeof value === "string" && /^0x[0-9a-fA-F]*$/.test(value) && value.length % 2 === 0) {
    return value.toLowerCase() as Hex;
  }
  throw new ProjectionError(
    `${event.eventName} payload for key ${key} is not a hex byte string`
  );
}
