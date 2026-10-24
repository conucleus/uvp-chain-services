// Pure StageEscrow projection: one event -> one tranche row, ordered by
// (blockNumber, logIndex) and idempotent under replay. Timestamps derive from
// the canonical block timestamp except approve/reject, whose absolute
// release/refund deadlines let us recover the exact on-chain action time.

import type { Address, Hex } from "../shared/types.js";
import {
  ESCROW_TERMINAL_STATES,
  type EscrowApplyResult,
  type EscrowEvent,
  type EscrowProjectionStore,
  type EscrowReplaySummary,
  type EscrowTrancheDTO,
  type EscrowTrancheRecord
} from "./types.js";

const SECONDS_PER_DAY = 86_400n;
const REJECTION_WINDOW_SECONDS = 48n * 60n * 60n;

export function applyEscrowEvent(
  current: EscrowTrancheRecord | undefined,
  event: EscrowEvent
): EscrowApplyResult {
  if (event.eventName === "TrancheDeposited") {
    if (!current) {
      return { applied: true, record: depositRecord(event) };
    }
    const order = compareEventPoint(current, event);
    if (order > 0) {
      return { applied: false, reason: "stale" };
    }
    if (order === 0) {
      return { applied: false, reason: "duplicate" };
    }
    if (depositTermsMatch(current, event)) {
      return { applied: false, reason: "duplicate" };
    }
    return { applied: false, reason: "conflicting_deposit" };
  }

  if (!current) {
    return { applied: false, reason: "unknown_tranche" };
  }
  const order = compareEventPoint(current, event);
  if (order > 0) {
    return { applied: false, reason: "stale" };
  }
  if (order === 0) {
    return { applied: false, reason: "duplicate" };
  }
  if (
    ESCROW_TERMINAL_STATES.has(current.state) &&
    event.eventName !== "FeePaid"
  ) {
    return { applied: false, reason: "terminal_state" };
  }

  const timestamp = isoTimestamp(event.blockTimestamp);
  const point = {
    updatedAt: timestamp,
    blockNumber: event.blockNumber.toString(),
    logIndex: event.logIndex
  };
  switch (event.eventName) {
    case "TrancheApproved":
      return {
        applied: true,
        record: {
          ...current,
          ...point,
          state: "approved",
          approvedAt: isoTimestamp(
            event.args.releaseTime -
              BigInt(current.observationDays) * SECONDS_PER_DAY
          )
        }
      };
    case "TrancheRejected":
      return {
        applied: true,
        record: {
          ...current,
          ...point,
          state: "rejected",
          rejectedAt: isoTimestamp(
            event.args.refundTime - REJECTION_WINDOW_SECONDS
          )
        }
      };
    case "TrancheSuspended":
      return {
        applied: true,
        record: {
          ...current,
          ...point,
          state: "suspended",
          suspendedAt: timestamp
        }
      };
    case "SettlementProposed":
      return { applied: true, record: { ...current, ...point } };
    case "TranchePaid":
      return {
        applied: true,
        record: {
          ...current,
          ...point,
          state: "paid",
          payerAmount: "0",
          payeeAmount: event.args.netAmount.toString(),
          feeAmount: event.args.fee.toString(),
          releasedAt: timestamp
        }
      };
    case "TrancheRefunded":
      return {
        applied: true,
        record: {
          ...current,
          ...point,
          state: "refunded",
          payerAmount: event.args.amount.toString(),
          payeeAmount: "0",
          feeAmount: "0",
          refundedAt: timestamp
        }
      };
    case "TrancheSettled": {
      const payerAmount = event.args.payerAmount.toString();
      return {
        applied: true,
        record: {
          ...current,
          ...point,
          state: "settled",
          payerAmount,
          payeeAmount: event.args.payeeAmount.toString(),
          feeAmount: event.args.fee.toString(),
          releasedAt: timestamp,
          ...(payerAmount !== "0" ? { refundedAt: timestamp } : {})
        }
      };
    }
    case "FeePaid":
      return {
        applied: true,
        record: {
          ...current,
          ...point,
          feeRecipient: event.args.feeRecipient,
          feeAmount: event.args.fee.toString()
        }
      };
  }
}

export async function replayEscrowEvents(
  store: EscrowProjectionStore,
  events: readonly EscrowEvent[]
): Promise<EscrowReplaySummary> {
  const ordered = [...events].sort(compareEscrowEvents);
  let appliedCount = 0;
  let duplicateEventCount = 0;
  let staleEventCount = 0;
  let unknownTrancheEventCount = 0;
  let conflictingDepositCount = 0;
  let terminalEventCount = 0;

  for (const event of ordered) {
    const current = await store.getTrancheById(
      event.escrowAddress,
      event.trancheId
    );
    const result = applyEscrowEvent(current, event);
    if (result.applied) {
      await store.saveTranche(result.record);
      appliedCount += 1;
      continue;
    }
    switch (result.reason) {
      case "duplicate":
        duplicateEventCount += 1;
        break;
      case "stale":
        staleEventCount += 1;
        break;
      case "unknown_tranche":
        unknownTrancheEventCount += 1;
        break;
      case "conflicting_deposit":
        conflictingDepositCount += 1;
        break;
      case "terminal_state":
        terminalEventCount += 1;
        break;
    }
  }

  return {
    eventCount: ordered.length,
    appliedCount,
    duplicateEventCount,
    staleEventCount,
    unknownTrancheEventCount,
    conflictingDepositCount,
    terminalEventCount
  };
}

export function trancheDTO(record: EscrowTrancheRecord): EscrowTrancheDTO {
  return {
    orderId: record.orderId,
    stageId: record.stageId,
    trancheId: record.trancheId,
    payer: record.payer,
    payee: record.payee,
    verifier: record.verifier,
    amount: record.amount,
    observationDays: record.observationDays,
    feeBps: record.feeBps,
    feeRecipient: record.feeRecipient,
    state: record.state,
    approvedAt: record.approvedAt ?? null,
    rejectedAt: record.rejectedAt ?? null,
    suspendedAt: record.suspendedAt ?? null,
    releaseAt: record.releasedAt ?? null,
    refundAt: record.refundedAt ?? null,
    payerAmount: record.payerAmount ?? null,
    payeeAmount: record.payeeAmount ?? null,
    feeAmount: record.feeAmount ?? null,
    updatedAt: record.updatedAt,
    blockNumber: record.blockNumber,
    logIndex: record.logIndex
  };
}

function depositRecord(
  event: Extract<EscrowEvent, { eventName: "TrancheDeposited" }>
): EscrowTrancheRecord {
  return {
    escrowAddress: event.escrowAddress,
    chainId: event.chainId,
    trancheId: event.trancheId,
    orderId: event.args.orderId,
    stageId: event.args.stageId,
    payer: event.args.payer,
    payee: event.args.payee,
    verifier: event.args.verifier,
    amount: event.args.amount.toString(),
    observationDays: event.args.observationDays,
    feeBps: event.args.feeBps,
    feeRecipient: event.args.feeRecipient,
    state: "frozen",
    updatedAt: isoTimestamp(event.blockTimestamp),
    blockNumber: event.blockNumber.toString(),
    logIndex: event.logIndex
  };
}

function depositTermsMatch(
  record: EscrowTrancheRecord,
  event: Extract<EscrowEvent, { eventName: "TrancheDeposited" }>
): boolean {
  return record.orderId === event.args.orderId &&
    record.stageId === event.args.stageId &&
    record.payer === event.args.payer &&
    record.payee === event.args.payee &&
    record.verifier === event.args.verifier &&
    record.amount === event.args.amount.toString() &&
    record.observationDays === event.args.observationDays &&
    record.feeBps === event.args.feeBps &&
    record.feeRecipient === event.args.feeRecipient;
}

function compareEventPoint(
  record: EscrowTrancheRecord,
  event: EscrowEvent
): number {
  const recordBlock = BigInt(record.blockNumber);
  if (recordBlock !== event.blockNumber) {
    return recordBlock > event.blockNumber ? 1 : -1;
  }
  if (record.logIndex !== event.logIndex) {
    return record.logIndex > event.logIndex ? 1 : -1;
  }
  return 0;
}

function compareEscrowEvents(left: EscrowEvent, right: EscrowEvent): number {
  if (left.blockNumber !== right.blockNumber) {
    return left.blockNumber < right.blockNumber ? -1 : 1;
  }
  if (left.logIndex !== right.logIndex) {
    return left.logIndex - right.logIndex;
  }
  return left.trancheId.localeCompare(right.trancheId);
}

function isoTimestamp(seconds: bigint): string {
  return new Date(Number(seconds) * 1000).toISOString();
}

export function escrowRecordKey(
  escrowAddress: Address,
  trancheId: Hex
): string {
  return `${escrowAddress.toLowerCase()}:${trancheId.toLowerCase()}`;
}
