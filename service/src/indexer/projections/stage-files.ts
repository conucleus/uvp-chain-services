// 阶段文件补丁族：重放 UVPFileResourceModule 的 StageFilePatchApplied/
// StageFileOpApplied，按事件顺序构造 per-(plan,order,targetStage) 的 stage
// file map（filesHash 链与每个 key 的 contentHash/handle/patchHash/provenance）；
// 事件形状与 filesHash 递推口径的唯一来源是执行文档 §2.4，本模块只重放不推导。
import { encodeAbiParameters, keccak256 } from "viem";
import { ProjectionError, type Hex } from "@uvp-eth/service-runtime";
import type { ChainEvent } from "../events.js";
import {
  ZERO_BYTES32,
  optionalStringArg,
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
  ensureStateMachineOrderFromModuleEvent,
  type MutableStateMachineOrderProjection,
  type StateMachineModuleIndex
} from "./order.js";
import type { ProjectionReplayDiagnostics } from "./snapshot.js";

export type StageFileOpKind = "add" | "replace" | "remove";

export interface StateMachineStageFileEntryProjection {
  readonly key: Hex;
  readonly contentHash: Hex;
  readonly handle: string;
  readonly patchHash: Hex;
  readonly updatedAt: ProjectionProvenance;
  readonly proof: StateMachineProofProjection;
}

export interface StateMachineStageFileMapProjection {
  readonly planId: Hex;
  readonly orderId: Hex;
  readonly targetStageId: Hex;
  readonly filesHash: Hex;
  readonly files: Readonly<Record<string, StateMachineStageFileEntryProjection>>;
  readonly updatedAt: ProjectionProvenance;
  readonly proof: StateMachineProofProjection;
}

export interface StageFilePatchWindow {
  readonly patchHash: Hex;
  remainingOpCount: number;
}

export type StageFileReplayIndex = Map<string, StageFilePatchWindow>;

interface StageFileReplayContext {
  readonly modules: StateMachineModuleIndex;
  readonly diagnostics: ProjectionReplayDiagnostics;
  readonly orders: Map<string, MutableStateMachineOrderProjection>;
  readonly stageFileReplay: StageFileReplayIndex;
}

export function applyStageFilePatchApplied(
  state: StageFileReplayContext,
  event: ChainEvent
): void {
  const orderId = requiredBytes32Arg(event, "orderId");
  const planId = requiredBytes32Arg(event, "planId");
  const order = ensureStateMachineOrderFromModuleEvent(state, event, orderId, planId);
  const targetStageId = requiredBytes32Arg(event, "targetStageId");
  const patchHash = requiredBytes32Arg(event, "patchHash");
  const baseHash = requiredBytes32Arg(event, "baseHash");
  const submitter = requiredAddressArg(event, "submitter");
  const opCount = stageFileOpCount(event);
  const proof = proofOf(event, {
    orderId,
    planId: order.planId,
    planHash: order.planHash,
    submitter
  });
  const replayKey = stageFileReplayKey(order, targetStageId);
  const openWindow = state.stageFileReplay.get(replayKey);
  if (openWindow) {
    throw new ProjectionError(
      `${event.eventName} for stage ${targetStageId} arrived while patch ${openWindow.patchHash} still misses ${openWindow.remainingOpCount} StageFileOpApplied event(s)`
    );
  }
  const existing = order.stageFiles[targetStageId];
  if (existing) {
    if (existing.filesHash !== baseHash) {
      throw new ProjectionError(
        `${event.eventName} baseHash ${baseHash} does not match the replayed stage files hash ${existing.filesHash} for order ${order.orderId} stage ${targetStageId}`
      );
    }
    order.stageFiles[targetStageId] = {
      ...existing,
      filesHash: nextFilesHash(existing.filesHash, patchHash),
      updatedAt: provenanceOf(event),
      proof
    };
  } else {
    if (baseHash !== ZERO_BYTES32) {
      throw new ProjectionError(
        `${event.eventName} baseHash ${baseHash} must be zero for the first patch of order ${order.orderId} stage ${targetStageId}`
      );
    }
    order.stageFiles[targetStageId] = {
      planId: order.planId,
      orderId: order.orderId,
      targetStageId,
      filesHash: nextFilesHash(ZERO_BYTES32, patchHash),
      files: {},
      updatedAt: provenanceOf(event),
      proof
    };
  }
  state.stageFileReplay.set(replayKey, { patchHash, remainingOpCount: opCount });
  order.updatedAt = provenanceOf(event);
  appendOrderProof(order, proof);
  appendOrderTimeline(order, timelineOf(event, "阶段文件已更新", proof, {
    orderId,
    planId: order.planId
  }));
}

export function applyStageFileOpApplied(
  state: StageFileReplayContext,
  event: ChainEvent
): void {
  const orderId = requiredBytes32Arg(event, "orderId");
  const planId = requiredBytes32Arg(event, "planId");
  const order = ensureStateMachineOrderFromModuleEvent(state, event, orderId, planId);
  const targetStageId = requiredBytes32Arg(event, "targetStageId");
  const key = requiredBytes32Arg(event, "key");
  const kind = stageFileOpKindFromArg(event.args["kind"]);
  const contentHash = requiredBytes32Arg(event, "contentHash");
  const handle = optionalStringArg(event, "handle") ?? "";
  const replayKey = stageFileReplayKey(order, targetStageId);
  const pending = state.stageFileReplay.get(replayKey);
  if (!pending) {
    throw new ProjectionError(
      `${event.eventName} for stage ${targetStageId} carries no open StageFilePatchApplied window`
    );
  }
  const stageFile = order.stageFiles[targetStageId];
  if (!stageFile) {
    throw new ProjectionError(
      `${event.eventName} for stage ${targetStageId} has no replayed stage file map`
    );
  }
  const files = { ...stageFile.files };
  if (kind === "remove") {
    if (files[key] === undefined) {
      throw new ProjectionError(
        `${event.eventName} remove for key ${key} found no entry in the replayed stage file map of order ${order.orderId} stage ${targetStageId}`
      );
    }
    delete files[key];
  } else {
    const present = files[key] !== undefined;
    if (kind === "add" && present) {
      throw new ProjectionError(
        `${event.eventName} add for key ${key} found an existing entry in the replayed stage file map of order ${order.orderId} stage ${targetStageId}`
      );
    }
    if (kind === "replace" && !present) {
      throw new ProjectionError(
        `${event.eventName} replace for key ${key} found no entry in the replayed stage file map of order ${order.orderId} stage ${targetStageId}`
      );
    }
    files[key] = {
      key,
      contentHash,
      handle,
      patchHash: pending.patchHash,
      updatedAt: provenanceOf(event),
      proof: proofOf(event, {
        orderId,
        planId: order.planId,
        planHash: order.planHash
      })
    };
  }
  order.stageFiles[targetStageId] = { ...stageFile, files };
  pending.remainingOpCount -= 1;
  if (pending.remainingOpCount === 0) {
    state.stageFileReplay.delete(replayKey);
  }
  order.updatedAt = provenanceOf(event);
}

export function assertStageFilePatchReplaysComplete(stageFileReplay: StageFileReplayIndex): void {
  for (const [key, pending] of stageFileReplay) {
    throw new ProjectionError(
      `stage file patch ${pending.patchHash} for ${key} misses ${pending.remainingOpCount} StageFileOpApplied event(s) at the end of the replayed log`
    );
  }
}

function stageFileReplayKey(
  order: MutableStateMachineOrderProjection,
  targetStageId: Hex
): string {
  return [
    order.chainId,
    order.contractAddress.toLowerCase(),
    order.planId,
    order.orderId,
    targetStageId
  ].join(":");
}

function stageFileOpCount(event: ChainEvent): number {
  const opCount = Number(uintArgAsString(event, "opCount"));
  if (!Number.isSafeInteger(opCount) || opCount <= 0) {
    throw new ProjectionError(`${event.eventName}.opCount must be a positive safe integer`);
  }
  return opCount;
}

function stageFileOpKindFromArg(value: unknown): StageFileOpKind {
  const kind = typeof value === "bigint"
    ? Number(value)
    : typeof value === "string"
      ? Number(value)
      : value;
  switch (kind) {
    case 0:
      return "add";
    case 1:
      return "replace";
    case 2:
      return "remove";
    default:
      throw new ProjectionError("StageFileOpApplied.kind is not a supported file op kind");
  }
}

function nextFilesHash(previousFilesHash: Hex, patchHash: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }],
      [previousFilesHash, patchHash]
    )
  );
}
