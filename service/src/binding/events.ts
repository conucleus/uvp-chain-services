// StageEscrowV3 event surface and decoder. Only `Deposited` and `Settled` are
// business facts; anything else is counted/recorded as an anomaly instead of
// being silently dropped. The ABI is copied from the escrow_v3 contract and is
// the single decode source for the binding projection.

import { decodeEventLog, parseAbi } from "viem";
import { normalizeAddress, normalizeBytes32, type Address, type Hex } from "../shared/types.js";

export const BINDING_EVENT_ABI = parseAbi([
  "event Deposited(bytes32 indexed trancheId, bytes32 indexed orderId, bytes32 indexed stageId, address payer, address payee, address verifier, uint256 amount, uint16 feeBps, address feeRecipient, uint64 deadline, uint256 nonce, bytes32 authHash)",
  "event Settled(bytes32 indexed trancheId, bytes32 indexed orderId, bytes32 indexed stageId, uint256 payerAmount, uint256 payeeAmount, uint256 fee, bytes32 instructionRef)"
]);

export const BINDING_EVENT_NAMES: ReadonlySet<string> = new Set(["Deposited", "Settled"]);

export interface RawBindingLog {
  readonly address: Address;
  readonly blockNumber: bigint | null;
  readonly logIndex: number | null;
  readonly transactionHash?: Hex;
  readonly data: Hex;
  readonly topics: readonly Hex[];
}

interface BindingEventBase {
  readonly chainId: number;
  readonly escrowAddress: Address;
  readonly trancheId: Hex;
  readonly blockNumber: bigint;
  readonly logIndex: number;
  readonly blockTimestamp: bigint;
  readonly transactionHash: Hex;
}

export type BindingEvent =
  | (BindingEventBase & {
    readonly eventName: "Deposited";
    readonly args: {
      readonly orderId: Hex;
      readonly stageId: Hex;
      readonly payer: Address;
      readonly payee: Address;
      readonly verifier: Address;
      readonly amount: bigint;
      readonly feeBps: number;
      readonly feeRecipient: Address;
      readonly deadline: bigint;
      readonly nonce: bigint;
      readonly authHash: Hex;
    };
  })
  | (BindingEventBase & {
    readonly eventName: "Settled";
    readonly args: {
      readonly orderId: Hex;
      readonly stageId: Hex;
      readonly payerAmount: bigint;
      readonly payeeAmount: bigint;
      readonly fee: bigint;
      readonly instructionRef: Hex;
    };
  });

export type BindingEventName = BindingEvent["eventName"];

export interface BindingLogDecodeInput {
  readonly chainId: number;
  readonly escrowAddress: Address;
  readonly logs: readonly RawBindingLog[];
  readonly blockTimestampOf: (blockNumber: bigint) => bigint;
}

export interface BindingLogDecodeResult {
  readonly events: readonly BindingEvent[];
  readonly unknownLogCount: number;
}

export function decodeBindingLogs(input: BindingLogDecodeInput): BindingLogDecodeResult {
  const escrowAddress = normalizeAddress(input.escrowAddress, "escrowAddress");
  const events: BindingEvent[] = [];
  let unknownLogCount = 0;
  for (const log of input.logs) {
    if (normalizeAddress(log.address, "log.address") !== escrowAddress) {
      continue;
    }
    if (log.blockNumber === null || log.logIndex === null) {
      unknownLogCount += 1;
      continue;
    }
    if (!log.transactionHash) {
      unknownLogCount += 1;
      continue;
    }
    const decoded = decodeOne(log);
    if (!decoded) {
      unknownLogCount += 1;
      continue;
    }
    const base = {
      chainId: input.chainId,
      escrowAddress,
      trancheId: decoded.trancheId,
      blockNumber: log.blockNumber,
      logIndex: log.logIndex,
      blockTimestamp: input.blockTimestampOf(log.blockNumber),
      transactionHash: log.transactionHash
    };
    if (decoded.eventName === "Deposited") {
      events.push({ ...base, eventName: "Deposited", args: decoded.args });
    } else {
      events.push({ ...base, eventName: "Settled", args: decoded.args });
    }
  }
  return { events, unknownLogCount };
}

type DecodedBindingLog =
  | {
    readonly eventName: "Deposited";
    readonly trancheId: Hex;
    readonly args: Extract<BindingEvent, { eventName: "Deposited" }>["args"];
  }
  | {
    readonly eventName: "Settled";
    readonly trancheId: Hex;
    readonly args: Extract<BindingEvent, { eventName: "Settled" }>["args"];
  };

function decodeOne(log: RawBindingLog): DecodedBindingLog | undefined {
  let decoded: ReturnType<typeof decodeEventLog>;
  try {
    decoded = decodeEventLog({
      abi: BINDING_EVENT_ABI,
      data: log.data,
      topics: log.topics as [Hex, ...Hex[]]
    });
  } catch {
    return undefined;
  }
  if (!BINDING_EVENT_NAMES.has(decoded.eventName)) {
    return undefined;
  }
  const args = decoded.args as Record<string, unknown>;
  const trancheId = normalizeBytes32(String(args.trancheId), "event.trancheId");
  if (decoded.eventName === "Deposited") {
    return {
      eventName: "Deposited",
      trancheId,
      args: {
        orderId: normalizeBytes32(String(args.orderId), "event.orderId"),
        stageId: normalizeBytes32(String(args.stageId), "event.stageId"),
        payer: normalizeAddress(String(args.payer), "event.payer"),
        payee: normalizeAddress(String(args.payee), "event.payee"),
        verifier: normalizeAddress(String(args.verifier), "event.verifier"),
        amount: BigInt(String(args.amount)),
        feeBps: Number(args.feeBps),
        feeRecipient: normalizeAddress(String(args.feeRecipient), "event.feeRecipient"),
        deadline: BigInt(String(args.deadline)),
        nonce: BigInt(String(args.nonce)),
        authHash: normalizeBytes32(String(args.authHash), "event.authHash")
      }
    };
  }
  return {
    eventName: "Settled",
    trancheId,
    args: {
      orderId: normalizeBytes32(String(args.orderId), "event.orderId"),
      stageId: normalizeBytes32(String(args.stageId), "event.stageId"),
      payerAmount: BigInt(String(args.payerAmount)),
      payeeAmount: BigInt(String(args.payeeAmount)),
      fee: BigInt(String(args.fee)),
      instructionRef: normalizeBytes32(String(args.instructionRef), "event.instructionRef")
    }
  };
}
