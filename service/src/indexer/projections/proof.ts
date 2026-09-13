// 证明族：链事件事实提取与证明构造（事件参数解码、provenance/proof/timeline
// 原语与比较器）。归位自原 indexer/projections.ts（意见书 B2 纯搬迁拆分）。
import { chainEventKey, type ChainEvent } from "../events.js";
import {
  ProjectionError,
  compareChainPointers,
  normalizeAddress,
  normalizeBytes32,
  type Address,
  type ChainPointer,
  type Hex
} from "../../shared/types.js";

export interface ProjectionProvenance {
  readonly chainId: number;
  readonly contractAddress: Address;
  readonly blockNumber: bigint;
  readonly transactionIndex?: number;
  readonly transactionHash: Hex;
  readonly logIndex: number;
}

export interface StateMachineProofProjection extends ProjectionProvenance {
  readonly eventId: string;
  readonly eventName: string;
  readonly args: EventProofArgs;
  readonly blockHash?: Hex;
  readonly orderId?: Hex;
  readonly planId?: Hex;
  readonly planHash?: Hex;
  readonly submitter?: Address;
}

export type EventProofArgs = Readonly<Record<string, string | number | boolean | null>>;

export interface StateMachineTimelineEventProjection {
  readonly timelineId: string;
  readonly orderId?: Hex;
  readonly planId?: Hex;
  readonly eventName: string;
  readonly text: string;
  readonly time: string;
  readonly proof: StateMachineProofProjection;
}

export const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000" as const;

export function proofOf(event: ChainEvent, metadata: StateMachineProofMetadata = {}): StateMachineProofProjection {
  return {
    ...provenanceOf(event),
    eventId: chainEventKey(event),
    eventName: event.eventName,
    args: normalizeProofArgs(event.args),
    ...(event.blockHash ? { blockHash: event.blockHash } : {}),
    ...(metadata.orderId ? { orderId: metadata.orderId } : {}),
    ...(metadata.planId ? { planId: metadata.planId } : {}),
    ...(metadata.planHash ? { planHash: metadata.planHash } : {}),
    ...(metadata.submitter ? { submitter: metadata.submitter } : {})
  };
}

interface StateMachineProofMetadata {
  readonly orderId?: Hex | undefined;
  readonly linkedOrderId?: Hex | undefined;
  readonly triggerOriginOrderId?: Hex | undefined;
  readonly originSourceId?: Hex | undefined;
  readonly originSignalId?: Hex | undefined;
  readonly planId?: Hex | undefined;
  readonly planHash?: Hex | undefined;
  readonly sourceId?: Hex | undefined;
  readonly signalId?: Hex | undefined;
  readonly submitter?: Address | undefined;
}

function normalizeProofArgs(args: ChainEvent["args"]): EventProofArgs {
  return Object.fromEntries(
    Object.entries(args).map(([key, value]) => [key, normalizeProofArg(value)])
  );
}

function normalizeProofArg(value: unknown): string | number | boolean | null {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "string") {
    // 事件源解码边界已按 ABI 类型归一化（bytes/address 小写、
    // string 保持原文）。这里不对 0x 开头的字符串二次小写化——
    // metadataURI 等 string 参数大小写敏感，改写不可逆。
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }
  if (value === undefined) {
    return null;
  }
  return JSON.stringify(value);
}

export function timelineOf(
  _event: ChainEvent,
  text: string,
  proof: StateMachineProofProjection,
  metadata: StateMachineProofMetadata = {}
): StateMachineTimelineEventProjection {
  return {
    timelineId: proof.eventId,
    eventName: proof.eventName,
    text,
    time: `block ${proof.blockNumber.toString()}`,
    proof,
    ...(metadata.orderId ? { orderId: metadata.orderId } : {}),
    ...(metadata.planId ? { planId: metadata.planId } : {})
  };
}

export function compareTimelineEvents(
  left: StateMachineTimelineEventProjection,
  right: StateMachineTimelineEventProjection
): number {
  return compareProofEvents(left.proof, right.proof);
}

export function compareProofEvents(left: StateMachineProofProjection, right: StateMachineProofProjection): number {
  const position = compareChainPointers(left, right);
  if (position !== 0) {
    return position;
  }
  return left.eventId.localeCompare(right.eventId);
}

export function provenanceOf(pointer: ChainPointer): ProjectionProvenance {
  return {
    chainId: pointer.chainId,
    contractAddress: pointer.contractAddress,
    blockNumber: pointer.blockNumber,
    ...(pointer.transactionIndex !== undefined ? { transactionIndex: pointer.transactionIndex } : {}),
    transactionHash: pointer.transactionHash,
    logIndex: pointer.logIndex
  };
}

function requiredStringArg(event: ChainEvent, name: string): string {
  const value = event.args[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new ProjectionError(`${event.eventName}.${name} must be a non-empty string`);
  }
  return value;
}

export function optionalStringArg(event: ChainEvent, name: string): string | undefined {
  const value = event.args[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function requiredAddressArg(event: ChainEvent, name: string): Address {
  return normalizeAddress(requiredStringArg(event, name), `${event.eventName}.${name}`);
}

export function optionalAddressArg(event: ChainEvent, name: string): Address | undefined {
  const value = optionalStringArg(event, name);
  return value ? normalizeAddress(value, `${event.eventName}.${name}`) : undefined;
}

export function requiredBytes32Arg(event: ChainEvent, name: string): Hex {
  return normalizeBytes32(requiredStringArg(event, name), `${event.eventName}.${name}`);
}

export function optionalBytes32Arg(event: ChainEvent, name: string): Hex | undefined {
  const value = optionalStringArg(event, name);
  return value ? normalizeBytes32(value, `${event.eventName}.${name}`) : undefined;
}

export function optionalNonZeroBytes32Arg(event: ChainEvent, name: string): Hex | undefined {
  const value = optionalBytes32Arg(event, name);
  return value && value !== ZERO_BYTES32 ? value : undefined;
}

export function uintArgAsString(event: ChainEvent, name: string): string {
  const value = optionalUintArgAsString(event, name);
  if (!value) {
    throw new ProjectionError(`${event.eventName}.${name} must be a uint value`);
  }
  return value;
}

export function optionalUintArgAsString(event: ChainEvent, name: string): string | undefined {
  const value = event.args[name];
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value.toString();
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return value;
  }
  return undefined;
}
