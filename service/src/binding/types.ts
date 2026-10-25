// StageEscrowV3 binding domain: escrow instance registry, server-side canonical
// stage/tranche identity, accepted-terms validation, deposit intents, event
// projection and cursor types. Chain events are the only truth for what was
// deposited; product-side "accepted terms" are the only truth for what should
// be deposited. A mismatch is recorded as an anomaly, never coerced.

import { encodeAbiParameters, keccak256, stringToBytes } from "viem";
import {
  normalizeAddress,
  normalizeBytes32,
  type Address,
  type Hex
} from "../shared/types.js";

export const V3_ESCROW_DOMAIN_NAME = "UVPStageEscrow";
export const V3_ESCROW_DOMAIN_VERSION = "3";
export const V3_ESCROW_MAX_FEE_BPS = 500;
export const V3_FIXED_FEE_BPS = 100;

export const TRANCHE_BINDING_STATES = [
  "bound",
  "settled",
  "mismatch",
  "foreign"
] as const;

export type TrancheBindingState = (typeof TRANCHE_BINDING_STATES)[number];

export const DEPOSIT_INTENT_STATUSES = [
  "active",
  "submitted",
  "deposited",
  "expired",
  "cancelled"
] as const;

export type DepositIntentStatus = (typeof DEPOSIT_INTENT_STATUSES)[number];

export const BINDING_DATA_STATES = ["ok", "pending", "none", "unknown"] as const;

export type BindingDataState = (typeof BINDING_DATA_STATES)[number];

export const BINDING_ANOMALY_REASONS = [
  "deposit_without_intent",
  "deposit_terms_mismatch",
  "binding_conflict",
  "foreign_tranche",
  "settlement_without_binding",
  "unknown_log",
  "event_before_start_block",
  "start_block_after_deployment"
] as const;

export type BindingAnomalyReason = (typeof BINDING_ANOMALY_REASONS)[number];

export class BindingError extends Error {
  override readonly name = "BindingError";

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
  }
}

export interface EscrowInstanceRecord {
  readonly chainId: number;
  readonly escrowAddress: Address;
  readonly tokenAddress?: Address;
  readonly contractVersion: "v3";
  readonly uvpAddress?: Address;
  readonly uvpExecutorAddress?: Address;
  readonly deploymentBlock?: string;
  readonly startBlock: string;
  readonly status: "active" | "disabled";
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AcceptedStageTerms {
  readonly orderId: Hex;
  readonly stageKey: string;
  readonly stageId?: Hex;
  readonly payer: Address;
  readonly payee: Address;
  readonly verifier: Address;
  readonly amount: string;
  readonly feeBps: number;
  readonly feeRecipient: Address;
  readonly stageTerms: unknown;
  readonly termsHash: Hex;
}

export interface AcceptedStageTermsProvider {
  getAcceptedStageTerms(
    orderId: string,
    stageKey: string
  ): Promise<AcceptedStageTerms | undefined>;
}

export interface DepositTypedData {
  readonly types: Readonly<Record<string, readonly { readonly name: string; readonly type: string }[]>>;
  readonly primaryType: "DepositTerms";
  readonly domain: {
    readonly name: typeof V3_ESCROW_DOMAIN_NAME;
    readonly version: typeof V3_ESCROW_DOMAIN_VERSION;
    readonly chainId: number;
    readonly verifyingContract: Address;
  };
  readonly message: {
    readonly orderId: Hex;
    readonly stageId: Hex;
    readonly payer: Address;
    readonly payee: Address;
    readonly verifier: Address;
    readonly amount: string;
    readonly feeBps: number;
    readonly feeRecipient: Address;
    readonly deadline: string;
    readonly nonce: string;
  };
}

export interface DepositIntentRecord {
  readonly intentId: string;
  readonly chainId: number;
  readonly escrowAddress: Address;
  readonly orderId: Hex;
  readonly stageKey: string;
  readonly stageId: Hex;
  readonly trancheId: Hex;
  readonly payer: Address;
  readonly payee: Address;
  readonly verifier: Address;
  readonly amount: string;
  readonly feeBps: number;
  readonly feeRecipient: Address;
  readonly termsHash: Hex;
  readonly nonce: string;
  readonly deadline: string;
  readonly status: DepositIntentStatus;
  readonly idempotencyKey: string;
  readonly typedData: DepositTypedData;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DepositIntentResult {
  readonly intent: DepositIntentRecord;
  readonly typedData: DepositTypedData;
  readonly replayed: boolean;
}

export interface TrancheBindingRecord {
  readonly bindingId: string;
  readonly chainId: number;
  readonly escrowAddress: Address;
  readonly orderId: Hex;
  readonly stageKey: string;
  readonly stageId: Hex;
  readonly trancheId: Hex;
  readonly payer: Address;
  readonly payee: Address;
  readonly verifier?: Address;
  readonly amount: string;
  readonly feeBps: number;
  readonly feeRecipient: Address;
  readonly state: TrancheBindingState;
  readonly origin: "intent" | "event_only";
  readonly termsHash?: Hex;
  readonly depositTxHash?: Hex;
  readonly depositBlock?: string;
  readonly depositLogIndex?: number;
  readonly payerAmount?: string;
  readonly payeeAmount?: string;
  readonly feeAmount?: string;
  readonly settledTxHash?: Hex;
  readonly settledBlock?: string;
  readonly instructionRef?: Hex;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TrancheBindingView {
  readonly bindingId: string;
  readonly orderId: Hex;
  readonly stageKey: string;
  readonly stageId: Hex;
  readonly trancheId: Hex;
  readonly chainId: number;
  readonly escrowAddress: Address;
  readonly state: TrancheBindingState;
  readonly origin: "intent" | "event_only";
  readonly payer?: Address;
  readonly payee?: Address;
  readonly verifier?: Address;
  readonly amount?: string;
  readonly feeBps?: number;
  readonly feeRecipient?: Address;
  readonly depositTxHash?: Hex;
  readonly depositBlock?: string;
  readonly payerAmount?: string;
  readonly payeeAmount?: string;
  readonly feeAmount?: string;
  readonly settledTxHash?: Hex;
  readonly instructionRef?: Hex;
  readonly updatedAt: string;
}

export interface BindingIndexCursor {
  readonly chainId: number;
  readonly escrowAddress: Address;
  readonly startBlock: string;
  readonly nextBlock: string;
  readonly lastBlock?: string;
  readonly lastBlockHash?: Hex;
  readonly updatedAt: string;
}

export interface BindingEventAnomaly {
  readonly anomalyId: string;
  readonly chainId: number;
  readonly escrowAddress: Address;
  readonly blockNumber: string;
  readonly logIndex: number;
  readonly txHash: Hex;
  readonly reason: BindingAnomalyReason;
  readonly details?: unknown;
  readonly createdAt: string;
}

export interface BindingReadResult {
  readonly orderId: Hex;
  readonly dataState: BindingDataState;
  readonly bindings: readonly TrancheBindingView[];
  readonly foreignTrancheCount: number;
}

export interface BindingVisibilityScope {
  readonly kind: "buyer" | "stage" | "operator" | "stranger";
  readonly stages: ReadonlySet<string>;
}

export interface BindingScopeResolver {
  resolveBindingScope(
    orderId: string,
    walletAddress: Address
  ): Promise<BindingVisibilityScope>;
}

export function canonicalStageId(stageKey: string): Hex {
  const key = stageKey.trim();
  if (key.length === 0) {
    throw new BindingError(400, "invalid_stage_key", "stageKey must be a non-empty string");
  }
  return normalizeBytes32(keccak256(stringToBytes(key)), "stageId");
}

export function canonicalTrancheId(orderId: string, stageId: string, payer: string): Hex {
  return normalizeBytes32(
    keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes32" }, { type: "address" }],
        [
          normalizeBytes32(orderId, "orderId"),
          normalizeBytes32(stageId, "stageId"),
          normalizeWallet(payer, "tranche.payer")
        ]
      )
    ),
    "trancheId"
  );
}

export function normalizeOrderId(value: string): Hex {
  return normalizeBytes32(value.trim().toLowerCase(), "orderId");
}

export function normalizeWallet(value: string, fieldName: string): Address {
  return normalizeAddress(value.trim().toLowerCase(), fieldName);
}

export function normalizeBaseUnits(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (!/^(0|[1-9][0-9]*)$/.test(trimmed)) {
    throw new BindingError(400, "invalid_amount", `${fieldName} must be a base-10 integer string`);
  }
  return trimmed;
}

export function normalizePositiveBaseUnits(value: string, fieldName: string): string {
  const normalized = normalizeBaseUnits(value, fieldName);
  if (normalized === "0") {
    throw new BindingError(400, "invalid_amount", `${fieldName} must be greater than zero`);
  }
  return normalized;
}

export function normalizeFeeBps(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > V3_ESCROW_MAX_FEE_BPS) {
    throw new BindingError(
      400,
      "invalid_fee_bps",
      `feeBps must be an integer in [0, ${V3_ESCROW_MAX_FEE_BPS}]`
    );
  }
  return value;
}

export function assertDepositTermsConsistent(input: {
  readonly chainId: number;
  readonly escrowAddress: Address;
  readonly terms: AcceptedStageTerms;
  readonly stageKey: string;
}): {
  readonly orderId: Hex;
  readonly stageId: Hex;
  readonly trancheId: Hex;
  readonly payer: Address;
  readonly payee: Address;
  readonly verifier: Address;
  readonly amount: string;
  readonly feeBps: number;
  readonly feeRecipient: Address;
} {
  const orderId = normalizeOrderId(input.terms.orderId);
  const stageKey = input.stageKey.trim();
  if (input.terms.stageKey !== stageKey) {
    throw new BindingError(
      409,
      "accepted_terms_stage_mismatch",
      "accepted terms belong to a different stageKey",
      { requestedStageKey: stageKey, acceptedStageKey: input.terms.stageKey }
    );
  }
  const stageId = canonicalStageId(stageKey);
  if (input.terms.stageId !== undefined) {
    const supplied = normalizeBytes32(input.terms.stageId, "acceptedTerms.stageId");
    if (supplied !== stageId) {
      throw new BindingError(
        409,
        "accepted_terms_stage_id_mismatch",
        "accepted terms carry a stageId that is not keccak256(stageKey)",
        { stageKey, expectedStageId: stageId, acceptedStageId: supplied }
      );
    }
  }
  const payer = normalizeWallet(input.terms.payer, "acceptedTerms.payer");
  const payee = normalizeWallet(input.terms.payee, "acceptedTerms.payee");
  const verifier = normalizeWallet(input.terms.verifier, "acceptedTerms.verifier");
  if (payer === payee) {
    throw new BindingError(409, "accepted_terms_invalid_participants", "payer and payee must differ");
  }
  const amount = normalizePositiveBaseUnits(input.terms.amount, "acceptedTerms.amount");
  const feeBps = normalizeFeeBps(input.terms.feeBps);
  if (feeBps !== V3_FIXED_FEE_BPS) {
    throw new BindingError(409, "fee_bps_not_fixed", `feeBps must be ${V3_FIXED_FEE_BPS}`, { feeBps });
  }
  const feeRecipient = normalizeWallet(input.terms.feeRecipient, "acceptedTerms.feeRecipient");
  if (/^0x0{40}$/.test(feeRecipient)) {
    throw new BindingError(409, "accepted_terms_invalid_fee", "feeRecipient is required");
  }
  const escrow = input.escrowAddress.toLowerCase();
  if (verifier === payee) {
    throw new BindingError(409, "accepted_terms_invalid_verifier", "verifier must not be the payee for the same stage");
  }
  if (payee === escrow || feeRecipient === escrow || verifier === escrow) {
    throw new BindingError(409, "accepted_terms_invalid_participants", "payee/feeRecipient cannot be the escrow contract");
  }
  return {
    orderId,
    stageId,
    trancheId: canonicalTrancheId(orderId, stageId, payer),
    payer,
    payee,
    verifier,
    amount,
    feeBps,
    feeRecipient
  };
}

export function buildDepositTypedData(input: {
  readonly chainId: number;
  readonly escrowAddress: Address;
  readonly orderId: Hex;
  readonly stageId: Hex;
  readonly payer: Address;
  readonly payee: Address;
  readonly verifier: Address;
  readonly amount: string;
  readonly feeBps: number;
  readonly feeRecipient: Address;
  readonly deadline: string;
  readonly nonce: string;
}): DepositTypedData {
  return {
    types: {
      DepositTerms: [
        { name: "orderId", type: "bytes32" },
        { name: "stageId", type: "bytes32" },
        { name: "payer", type: "address" },
        { name: "payee", type: "address" },
        { name: "verifier", type: "address" },
        { name: "amount", type: "uint256" },
        { name: "feeBps", type: "uint16" },
        { name: "feeRecipient", type: "address" },
        { name: "deadline", type: "uint64" },
        { name: "nonce", type: "uint256" }
      ]
    },
    primaryType: "DepositTerms",
    domain: {
      name: V3_ESCROW_DOMAIN_NAME,
      version: V3_ESCROW_DOMAIN_VERSION,
      chainId: input.chainId,
      verifyingContract: input.escrowAddress
    },
    message: {
      orderId: input.orderId,
      stageId: input.stageId,
      payer: input.payer,
      payee: input.payee,
      verifier: input.verifier,
      amount: input.amount,
      feeBps: input.feeBps,
      feeRecipient: input.feeRecipient,
      deadline: input.deadline,
      nonce: input.nonce
    }
  };
}
