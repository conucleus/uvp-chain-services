// StageEscrow V2 projection surface: tranche records, decoded chain events,
// query DTOs, and the persistence port. The event ABIs are the single source in
// events.ts; this module only carries the projection shapes.

import type { Address, Hex } from "../shared/types.js";

export const ESCROW_TRANCHE_STATES = [
  "frozen",
  "approved",
  "rejected",
  "suspended",
  "paid",
  "refunded",
  "settled"
] as const;

export type EscrowTrancheState = (typeof ESCROW_TRANCHE_STATES)[number];

export const ESCROW_TERMINAL_STATES: ReadonlySet<EscrowTrancheState> = new Set([
  "paid",
  "refunded",
  "settled"
]);

export interface EscrowTrancheRecord {
  readonly escrowAddress: Address;
  readonly chainId: number;
  readonly trancheId: Hex;
  readonly orderId: Hex;
  readonly stageId: Hex;
  readonly payer: Address;
  readonly payee: Address;
  readonly verifier: Address;
  readonly amount: string;
  readonly observationDays: number;
  readonly feeBps: number;
  readonly feeRecipient: Address;
  readonly state: EscrowTrancheState;
  readonly approvedAt?: string;
  readonly rejectedAt?: string;
  readonly suspendedAt?: string;
  readonly payerAmount?: string;
  readonly payeeAmount?: string;
  readonly feeAmount?: string;
  readonly releasedAt?: string;
  readonly refundedAt?: string;
  readonly updatedAt: string;
  readonly blockNumber: string;
  readonly logIndex: number;
}

export interface EscrowTrancheDTO {
  readonly orderId: string;
  readonly stageId: string;
  readonly trancheId: string;
  readonly payer: string;
  readonly payee: string;
  readonly verifier: string;
  readonly amount: string;
  readonly observationDays: number;
  readonly feeBps: number;
  readonly feeRecipient: string;
  readonly state: EscrowTrancheState;
  readonly approvedAt: string | null;
  readonly rejectedAt: string | null;
  readonly suspendedAt: string | null;
  readonly releaseAt: string | null;
  readonly refundAt: string | null;
  readonly payerAmount: string | null;
  readonly payeeAmount: string | null;
  readonly feeAmount: string | null;
  readonly updatedAt: string;
  readonly blockNumber: string;
  readonly logIndex: number;
}

export interface EscrowTranchesResponse {
  readonly orderId: string;
  readonly tranches: readonly EscrowTrancheDTO[];
}

interface EscrowEventBase {
  readonly chainId: number;
  readonly escrowAddress: Address;
  readonly trancheId: Hex;
  readonly blockNumber: bigint;
  readonly logIndex: number;
  readonly blockTimestamp: bigint;
}

export type EscrowEvent =
  | (EscrowEventBase & {
    readonly eventName: "TrancheDeposited";
    readonly args: {
      readonly orderId: Hex;
      readonly stageId: Hex;
      readonly payer: Address;
      readonly payee: Address;
      readonly verifier: Address;
      readonly feeRecipient: Address;
      readonly amount: bigint;
      readonly observationDays: number;
      readonly feeBps: number;
    };
  })
  | (EscrowEventBase & {
    readonly eventName: "TrancheApproved";
    readonly args: { readonly verifier: Address; readonly releaseTime: bigint };
  })
  | (EscrowEventBase & {
    readonly eventName: "TrancheRejected";
    readonly args: { readonly verifier: Address; readonly refundTime: bigint };
  })
  | (EscrowEventBase & {
    readonly eventName: "TrancheSuspended";
    readonly args: { readonly party: Address };
  })
  | (EscrowEventBase & {
    readonly eventName: "SettlementProposed";
    readonly args: {
      readonly party: Address;
      readonly payerAmount: bigint;
      readonly payeeAmount: bigint;
    };
  })
  | (EscrowEventBase & {
    readonly eventName: "TrancheSettled";
    readonly args: {
      readonly payerAmount: bigint;
      readonly payeeAmount: bigint;
      readonly fee: bigint;
    };
  })
  | (EscrowEventBase & {
    readonly eventName: "TranchePaid";
    readonly args: {
      readonly payee: Address;
      readonly grossAmount: bigint;
      readonly fee: bigint;
      readonly netAmount: bigint;
      readonly reason: number;
    };
  })
  | (EscrowEventBase & {
    readonly eventName: "TrancheRefunded";
    readonly args: { readonly payer: Address; readonly amount: bigint; readonly reason: number };
  })
  | (EscrowEventBase & {
    readonly eventName: "FeePaid";
    readonly args: { readonly feeRecipient: Address; readonly fee: bigint };
  });

export type EscrowEventName = EscrowEvent["eventName"];

export const ESCROW_EVENT_NAMES: ReadonlySet<string> = new Set([
  "TrancheDeposited",
  "TrancheApproved",
  "TrancheRejected",
  "TrancheSuspended",
  "SettlementProposed",
  "TrancheSettled",
  "TranchePaid",
  "TrancheRefunded",
  "FeePaid"
] satisfies EscrowEventName[]);

export type EscrowApplySkipReason =
  | "unknown_tranche"
  | "duplicate"
  | "stale"
  | "conflicting_deposit"
  | "terminal_state";

export type EscrowApplyResult =
  | { readonly applied: true; readonly record: EscrowTrancheRecord }
  | { readonly applied: false; readonly reason: EscrowApplySkipReason };

export interface EscrowReplaySummary {
  readonly eventCount: number;
  readonly appliedCount: number;
  readonly duplicateEventCount: number;
  readonly staleEventCount: number;
  readonly unknownTrancheEventCount: number;
  readonly conflictingDepositCount: number;
  readonly terminalEventCount: number;
}

export interface EscrowProjectionStore {
  listTranches(
    escrowAddress: Address,
    orderId: string
  ): Promise<readonly EscrowTrancheRecord[]>;
  getTranche(
    escrowAddress: Address,
    orderId: string,
    stageId: string
  ): Promise<EscrowTrancheRecord | undefined>;
  getTrancheById(
    escrowAddress: Address,
    trancheId: string
  ): Promise<EscrowTrancheRecord | undefined>;
  saveTranche(record: EscrowTrancheRecord): Promise<void>;
  clear(escrowAddress: Address): Promise<void>;
}

export interface EscrowQueryConfig {
  readonly address: Address;
  readonly chainId: number;
}

export interface EscrowQueryService {
  readonly configured: boolean;
  listTranches(orderId: string): Promise<readonly EscrowTrancheDTO[]>;
  getTranche(
    orderId: string,
    stageId: string
  ): Promise<EscrowTrancheDTO | undefined>;
}
