// StageEscrow V2 event ABI and log decoder. Topic layout is the contract's
// emitted surface (uvp-periphery/smart_contracts/escrow/src/StageEscrow.sol);
// the indexer only ever asks the configured escrow address for these logs.

import { decodeEventLog, parseAbi } from "viem";
import type { Address, Hex } from "../shared/types.js";
import {
  ESCROW_EVENT_NAMES,
  type EscrowEvent,
  type EscrowEventName
} from "./types.js";

export const ESCROW_EVENT_ABI = parseAbi([
  "event TrancheDeposited(bytes32 indexed trancheId, bytes32 indexed orderId, bytes32 indexed stageId, address payer, address payee, address verifier, address feeRecipient, uint256 amount, uint32 observationDays, uint16 feeBps)",
  "event TrancheApproved(bytes32 indexed trancheId, address indexed verifier, uint64 releaseTime)",
  "event TrancheRejected(bytes32 indexed trancheId, address indexed verifier, uint64 refundTime)",
  "event TrancheSuspended(bytes32 indexed trancheId, address indexed party)",
  "event TranchePaid(bytes32 indexed trancheId, address indexed payee, uint256 grossAmount, uint256 fee, uint256 netAmount, uint8 reason)",
  "event TrancheRefunded(bytes32 indexed trancheId, address indexed payer, uint256 amount, uint8 reason)",
  "event FeePaid(bytes32 indexed trancheId, address indexed feeRecipient, uint256 fee)",
  "event SettlementProposed(bytes32 indexed trancheId, address indexed party, uint256 payerAmount, uint256 payeeAmount)",
  "event TrancheSettled(bytes32 indexed trancheId, uint256 payerAmount, uint256 payeeAmount, uint256 fee)"
]);

export interface RawEscrowLog {
  readonly address: Address;
  readonly blockNumber: bigint | null;
  readonly logIndex: number | null;
  readonly data: Hex;
  readonly topics: readonly Hex[];
}

export interface EscrowLogDecodeInput {
  readonly chainId: number;
  readonly escrowAddress: Address;
  readonly logs: readonly RawEscrowLog[];
  readonly blockTimestampOf: (blockNumber: bigint) => bigint;
}

export interface EscrowLogDecodeResult {
  readonly events: readonly EscrowEvent[];
  readonly unknownLogCount: number;
}

export function decodeEscrowLogs(
  input: EscrowLogDecodeInput
): EscrowLogDecodeResult {
  const configuredAddress = input.escrowAddress.toLowerCase();
  const ordered = input.logs
    .filter((log) => log.address.toLowerCase() === configuredAddress)
    .filter(
      (log): log is RawEscrowLog & {
        readonly blockNumber: bigint;
        readonly logIndex: number;
      } => log.blockNumber !== null && log.logIndex !== null
    )
    .sort((left, right) => {
      if (left.blockNumber !== right.blockNumber) {
        return left.blockNumber < right.blockNumber ? -1 : 1;
      }
      return left.logIndex - right.logIndex;
    });

  const events: EscrowEvent[] = [];
  let unknownLogCount = 0;
  for (const log of ordered) {
    const decoded = decodeEscrowEventLog(log);
    if (!decoded) {
      unknownLogCount += 1;
      continue;
    }
    events.push({
      chainId: input.chainId,
      escrowAddress: input.escrowAddress,
      trancheId: decoded.trancheId,
      blockNumber: log.blockNumber,
      logIndex: log.logIndex,
      blockTimestamp: input.blockTimestampOf(log.blockNumber),
      eventName: decoded.eventName,
      args: decoded.args
    } as EscrowEvent);
  }
  return { events, unknownLogCount };
}

type DecodedEscrowEvent =
  | {
    readonly eventName: "TrancheDeposited";
    readonly trancheId: Hex;
    readonly args: Extract<EscrowEvent, { eventName: "TrancheDeposited" }>["args"];
  }
  | {
    readonly eventName: "TrancheApproved";
    readonly trancheId: Hex;
    readonly args: Extract<EscrowEvent, { eventName: "TrancheApproved" }>["args"];
  }
  | {
    readonly eventName: "TrancheRejected";
    readonly trancheId: Hex;
    readonly args: Extract<EscrowEvent, { eventName: "TrancheRejected" }>["args"];
  }
  | {
    readonly eventName: "TrancheSuspended";
    readonly trancheId: Hex;
    readonly args: Extract<EscrowEvent, { eventName: "TrancheSuspended" }>["args"];
  }
  | {
    readonly eventName: "SettlementProposed";
    readonly trancheId: Hex;
    readonly args: Extract<EscrowEvent, { eventName: "SettlementProposed" }>["args"];
  }
  | {
    readonly eventName: "TrancheSettled";
    readonly trancheId: Hex;
    readonly args: Extract<EscrowEvent, { eventName: "TrancheSettled" }>["args"];
  }
  | {
    readonly eventName: "TranchePaid";
    readonly trancheId: Hex;
    readonly args: Extract<EscrowEvent, { eventName: "TranchePaid" }>["args"];
  }
  | {
    readonly eventName: "TrancheRefunded";
    readonly trancheId: Hex;
    readonly args: Extract<EscrowEvent, { eventName: "TrancheRefunded" }>["args"];
  }
  | {
    readonly eventName: "FeePaid";
    readonly trancheId: Hex;
    readonly args: Extract<EscrowEvent, { eventName: "FeePaid" }>["args"];
  };

function decodeEscrowEventLog(log: RawEscrowLog): DecodedEscrowEvent | undefined {
  try {
    const decoded = decodeEventLog({
      abi: ESCROW_EVENT_ABI,
      data: log.data,
      topics: log.topics as [Hex, ...Hex[]],
      strict: true
    });
    if (!ESCROW_EVENT_NAMES.has(decoded.eventName)) {
      return undefined;
    }
    const args = decoded.args as Record<string, unknown>;
    const trancheId = requiredHex(args, "trancheId");
    const eventName = decoded.eventName as EscrowEventName;
    switch (eventName) {
      case "TrancheDeposited":
        return {
          eventName,
          trancheId,
          args: {
            orderId: requiredHex(args, "orderId"),
            stageId: requiredHex(args, "stageId"),
            payer: requiredAddress(args, "payer"),
            payee: requiredAddress(args, "payee"),
            verifier: requiredAddress(args, "verifier"),
            feeRecipient: requiredAddress(args, "feeRecipient"),
            amount: requiredBigInt(args, "amount"),
            observationDays: requiredNumber(args, "observationDays"),
            feeBps: requiredNumber(args, "feeBps")
          }
        };
      case "TrancheApproved":
        return {
          eventName,
          trancheId,
          args: {
            verifier: requiredAddress(args, "verifier"),
            releaseTime: requiredBigInt(args, "releaseTime")
          }
        };
      case "TrancheRejected":
        return {
          eventName,
          trancheId,
          args: {
            verifier: requiredAddress(args, "verifier"),
            refundTime: requiredBigInt(args, "refundTime")
          }
        };
      case "TrancheSuspended":
        return {
          eventName,
          trancheId,
          args: { party: requiredAddress(args, "party") }
        };
      case "SettlementProposed":
        return {
          eventName,
          trancheId,
          args: {
            party: requiredAddress(args, "party"),
            payerAmount: requiredBigInt(args, "payerAmount"),
            payeeAmount: requiredBigInt(args, "payeeAmount")
          }
        };
      case "TrancheSettled":
        return {
          eventName,
          trancheId,
          args: {
            payerAmount: requiredBigInt(args, "payerAmount"),
            payeeAmount: requiredBigInt(args, "payeeAmount"),
            fee: requiredBigInt(args, "fee")
          }
        };
      case "TranchePaid":
        return {
          eventName,
          trancheId,
          args: {
            payee: requiredAddress(args, "payee"),
            grossAmount: requiredBigInt(args, "grossAmount"),
            fee: requiredBigInt(args, "fee"),
            netAmount: requiredBigInt(args, "netAmount"),
            reason: requiredNumber(args, "reason")
          }
        };
      case "TrancheRefunded":
        return {
          eventName,
          trancheId,
          args: {
            payer: requiredAddress(args, "payer"),
            amount: requiredBigInt(args, "amount"),
            reason: requiredNumber(args, "reason")
          }
        };
      case "FeePaid":
        return {
          eventName,
          trancheId,
          args: {
            feeRecipient: requiredAddress(args, "feeRecipient"),
            fee: requiredBigInt(args, "fee")
          }
        };
    }
  } catch {
    return undefined;
  }
}

function requiredHex(
  args: Readonly<Record<string, unknown>>,
  key: string
): Hex {
  const value = args[key];
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]*$/.test(value)) {
    throw new Error(`escrow event arg ${key} must be a hex string`);
  }
  return value.toLowerCase() as Hex;
}

function requiredAddress(
  args: Readonly<Record<string, unknown>>,
  key: string
): Address {
  const value = args[key];
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`escrow event arg ${key} must be an address`);
  }
  return value.toLowerCase() as Address;
}

function requiredBigInt(
  args: Readonly<Record<string, unknown>>,
  key: string
): bigint {
  const value = args[key];
  if (typeof value !== "bigint") {
    throw new Error(`escrow event arg ${key} must be a bigint`);
  }
  return value;
}

function requiredNumber(
  args: Readonly<Record<string, unknown>>,
  key: string
): number {
  const value = args[key];
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value !== "number") {
    throw new Error(`escrow event arg ${key} must be a number`);
  }
  return value;
}
