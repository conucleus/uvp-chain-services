// Signature-driven stage custody instruction ledger. Escrow is a state machine
// driven by signatures/verdict/timers — NOT by a platform executor and not by
// "both parties sign every settlement":
//
//   start              B signs (B starts work)
//   refund_before_start A signs (only while Open)
//   verdict_approve    C (assigned verifier) signs → fixed full B amount - fee
//   verdict_reject     C signs → fixed full refund A
//   refund_after_start A+B co-sign (proposer first, counterparty second)
//   dispute            A+B co-sign a split (stops a pending pre-transfer)
//   resolve_dispute    A+B co-sign the final split
//   execute_transfer   UVP-side executor only, after UVP timer/fact; amount fixed
//   execute_refund     UVP-side executor only; amount fixed
//
// A relayer may carry any signed instruction on chain but has no privilege and
// cannot execute. Executor addresses come from deployment config, never from a
// generic key held by this service. If a required party refuses to sign, funds
// stay locked (by design). `unknown` is never auto-retried.

import { encodeAbiParameters, hashTypedData, keccak256, recoverTypedDataAddress } from "viem";
import {
  normalizeAddress,
  normalizeBytes32,
  type Address,
  type Hex
} from "../shared/types.js";

export const SETTLEMENT_INSTRUCTION_KINDS = [
  "start",
  "refund_before_start",
  "verdict_approve",
  "verdict_reject",
  "execute_transfer",
  "execute_refund",
  "refund_after_start",
  "dispute",
  "resolve_dispute"
] as const;

export type SettlementInstructionKind = (typeof SETTLEMENT_INSTRUCTION_KINDS)[number];

export const INSTRUCTION_SIGNER_ROLES = ["payer", "payee", "verifier"] as const;
export type InstructionSignerRole = (typeof INSTRUCTION_SIGNER_ROLES)[number];

export const REQUIRED_SIGNERS: Readonly<Record<SettlementInstructionKind, readonly InstructionSignerRole[]>> = {
  start: ["payee"],
  refund_before_start: ["payer"],
  verdict_approve: ["verifier"],
  verdict_reject: ["verifier"],
  execute_transfer: [],
  execute_refund: [],
  refund_after_start: ["payer", "payee"],
  dispute: ["payer", "payee"],
  resolve_dispute: ["payer", "payee"]
};

export const EXECUTE_INSTRUCTION_KINDS: ReadonlySet<SettlementInstructionKind> = new Set([
  "execute_transfer",
  "execute_refund"
]);

export const SETTLEMENT_INSTRUCTION_STATUSES = [
  "unsigned",
  "partially_signed",
  "ready",
  "execute_ready",
  "submitted",
  "confirmed",
  "failed",
  "unknown"
] as const;

export type SettlementInstructionStatus = (typeof SETTLEMENT_INSTRUCTION_STATUSES)[number];

export const V3_ESCROW_DOMAIN = { name: "UVPStageEscrow", version: "3" } as const;

export const FIXED_FEE_BPS = 100;

export function assertFixedFeeBps(value: number): number {
  if (!Number.isSafeInteger(value) || value !== FIXED_FEE_BPS) {
    throw new SettlementError(409, "fee_bps_not_fixed", `feeBps must be ${FIXED_FEE_BPS}`, { feeBps: value });
  }
  return value;
}

export const SETTLE_INSTRUCTION_PRIMARY_TYPE = "UVPStageInstruction";

export const SETTLE_INSTRUCTION_TYPES = {
  UVPStageInstruction: [
    { name: "trancheId", type: "bytes32" },
    { name: "orderId", type: "bytes32" },
    { name: "stageId", type: "bytes32" },
    { name: "kind", type: "string" },
    { name: "payerAmount", type: "uint256" },
    { name: "payeeAmount", type: "uint256" },
    { name: "instructionRef", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" }
  ]
} as const;

export class SettlementError extends Error {
  override readonly name = "SettlementError";

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
  }
}

export interface InstructionSignature {
  readonly role: InstructionSignerRole;
  readonly signer: Address;
  readonly signature: Hex;
}

export interface SettlementInstructionRecord {
  readonly instructionId: string;
  readonly idempotencyKey: string;
  readonly chainId: number;
  readonly escrowAddress: Address;
  readonly planId: Hex;
  readonly orderId: Hex;
  readonly stageKey: string;
  readonly stageId: Hex;
  readonly trancheId: Hex;
  readonly kind: SettlementInstructionKind;
  readonly payerAmount: string;
  readonly payeeAmount: string;
  readonly sourceFactId: Hex;
  readonly payer?: Address;
  readonly payee?: Address;
  readonly verifier?: Address;
  readonly uvpExecutorAddress?: Address;
  readonly requiredSigners: readonly InstructionSignerRole[];
  readonly signatures: readonly InstructionSignature[];
  readonly instructionRef: Hex;
  readonly typedDataHash: Hex;
  readonly nonce: string;
  readonly deadline: string;
  readonly status: SettlementInstructionStatus;
  readonly executeEligibleAt?: string;
  readonly blockedByDispute?: boolean;
  readonly txHash?: Hex;
  readonly blockNumber?: string;
  readonly errorCode?: string;
  readonly attempts: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SettlementInstructionView {
  readonly instructionId: string;
  readonly idempotencyKey: string;
  readonly chainId: number;
  readonly escrowAddress: Address;
  readonly planId: Hex;
  readonly orderId: Hex;
  readonly stageKey: string;
  readonly stageId: Hex;
  readonly trancheId: Hex;
  readonly kind: SettlementInstructionKind;
  readonly payerAmount: string;
  readonly payeeAmount: string;
  readonly sourceFactId: Hex;
  readonly payer?: Address;
  readonly payee?: Address;
  readonly verifier?: Address;
  readonly uvpExecutorAddress?: Address;
  readonly requiredSigners: readonly InstructionSignerRole[];
  readonly signatures: readonly InstructionSignature[];
  readonly instructionRef: Hex;
  readonly typedDataHash: Hex;
  readonly nonce: string;
  readonly deadline: string;
  readonly typedData: SettlementInstructionTypedData;
  readonly status: SettlementInstructionStatus;
  readonly executeEligibleAt?: string;
  readonly blockedByDispute?: boolean;
  readonly txHash?: Hex;
  readonly blockNumber?: string;
  readonly errorCode?: string;
  readonly attempts: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SettlementInstructionTypedData {
  readonly types: typeof SETTLE_INSTRUCTION_TYPES;
  readonly primaryType: typeof SETTLE_INSTRUCTION_PRIMARY_TYPE;
  readonly domain: {
    readonly name: typeof V3_ESCROW_DOMAIN.name;
    readonly version: typeof V3_ESCROW_DOMAIN.version;
    readonly chainId: number;
    readonly verifyingContract: Address;
  };
  readonly message: {
    readonly trancheId: Hex;
    readonly orderId: Hex;
    readonly stageId: Hex;
    readonly kind: SettlementInstructionKind;
    readonly payerAmount: string;
    readonly payeeAmount: string;
    readonly instructionRef: Hex;
    readonly nonce: string;
    readonly deadline: string;
  };
}

export interface SettlementReceiptRecord {
  readonly receiptId: string;
  readonly instructionId: string;
  readonly chainId: number;
  readonly escrowAddress: Address;
  readonly orderId: Hex;
  readonly stageId: Hex;
  readonly trancheId: Hex;
  readonly payerAmount: string;
  readonly payeeAmount: string;
  readonly feeAmount: string;
  readonly instructionRef: Hex;
  readonly txHash: Hex;
  readonly blockNumber: string;
  readonly logIndex: number;
  readonly confirmedAt: string;
}

export interface CreateSettlementInstructionInput {
  readonly chainId: number;
  readonly escrowAddress: string;
  readonly planId: string;
  readonly orderId: string;
  readonly stageKey: string;
  readonly stageId?: string;
  readonly trancheId?: string;
  readonly kind: SettlementInstructionKind;
  readonly payerAmount: string;
  readonly payeeAmount: string;
  readonly sourceFactId: string;
  readonly payer?: string;
  readonly payee?: string;
  readonly verifier?: string;
  readonly uvpExecutorAddress?: string;
  readonly deadlineSeconds?: number;
  readonly nonce?: string;
  readonly executeEligibleAt?: string;
  readonly idempotencyKey?: string;
}

export interface BoundTrancheView {
  readonly state: "bound" | "settled" | "mismatch" | "foreign";
  readonly amount: string;
  readonly orderId: Hex;
  readonly stageId: Hex;
  readonly payer: Address;
  readonly payee: Address;
  readonly verifier?: Address;
}

export interface BoundTrancheReader {
  getBoundTranche(input: {
    readonly chainId: number;
    readonly escrowAddress: Address;
    readonly trancheId: Hex;
  }): Promise<BoundTrancheView | undefined>;
}

export interface SettlementChainReceipt {
  readonly txHash: Hex;
  readonly blockNumber: string;
  readonly logIndex: number;
  readonly payerAmount: string;
  readonly payeeAmount: string;
  readonly feeAmount: string;
  readonly instructionRef: Hex;
}

export type SettlementSubmissionResult =
  | { readonly kind: "submitted"; readonly txHash: Hex }
  | { readonly kind: "unknown"; readonly reason: string }
  | { readonly kind: "failed"; readonly errorCode: string };

export type SettlementReceiptResult =
  | { readonly kind: "confirmed"; readonly receipt: SettlementChainReceipt }
  | { readonly kind: "pending" }
  | { readonly kind: "not_found" }
  | { readonly kind: "reverted"; readonly errorCode: string };

export interface SettlementChainAdapter {
  submitInstruction(input: {
    readonly instruction: SettlementInstructionRecord;
  }): Promise<SettlementSubmissionResult>;
  getSettlementReceipt(input: {
    readonly chainId: number;
    readonly escrowAddress: Address;
    readonly txHash: Hex;
  }): Promise<SettlementReceiptResult>;
}

export interface InstructionRefInput {
  readonly planId: Hex;
  readonly orderId: Hex;
  readonly stageId: Hex;
}

export const INSTRUCTION_REF_DOMAIN = "uvp.factsource.instruction.v1";

export function settlementInstructionRef(input: InstructionRefInput): Hex {
  return normalizeBytes32(
    keccak256(
      encodeAbiParameters(
        [{ type: "string" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
        [
          INSTRUCTION_REF_DOMAIN,
          normalizeBytes32(input.planId, "planId"),
          normalizeBytes32(input.orderId, "orderId"),
          normalizeBytes32(input.stageId, "stageId")
        ]
      )
    ),
    "instructionRef"
  );
}

export function buildSettleInstructionTypedData(input: {
  readonly chainId: number;
  readonly escrowAddress: Address;
  readonly trancheId: Hex;
  readonly orderId: Hex;
  readonly stageId: Hex;
  readonly kind: SettlementInstructionKind;
  readonly payerAmount: string;
  readonly payeeAmount: string;
  readonly instructionRef: Hex;
  readonly nonce: string;
  readonly deadline: string;
}): SettlementInstructionTypedData {
  return {
    types: SETTLE_INSTRUCTION_TYPES,
    primaryType: SETTLE_INSTRUCTION_PRIMARY_TYPE,
    domain: {
      name: V3_ESCROW_DOMAIN.name,
      version: V3_ESCROW_DOMAIN.version,
      chainId: input.chainId,
      verifyingContract: normalizeAddress(input.escrowAddress, "escrowAddress")
    },
    message: {
      trancheId: normalizeBytes32(input.trancheId, "trancheId"),
      orderId: normalizeBytes32(input.orderId, "orderId"),
      stageId: normalizeBytes32(input.stageId, "stageId"),
      kind: input.kind,
      payerAmount: normalizeBaseUnits(input.payerAmount, "payerAmount"),
      payeeAmount: normalizeBaseUnits(input.payeeAmount, "payeeAmount"),
      instructionRef: normalizeBytes32(input.instructionRef, "instructionRef"),
      nonce: normalizeBaseUnits(input.nonce, "nonce"),
      deadline: normalizeBaseUnits(input.deadline, "deadline")
    }
  };
}

export function settlementTypedDataHash(typedData: SettlementInstructionTypedData): Hex {
  return normalizeBytes32(hashTypedData(typedData as never), "typedDataHash");
}

export async function recoverSettlementSigner(
  typedData: SettlementInstructionTypedData,
  signature: string
): Promise<Address> {
  const recovered = await recoverTypedDataAddress({
    ...(typedData as unknown as Omit<Parameters<typeof recoverTypedDataAddress>[0], "signature">),
    signature: normalizeSignature(signature)
  });
  return normalizeAddress(recovered, "signatureSigner");
}

export function normalizeSignature(value: string): Hex {
  const trimmed = value.trim();
  if (!/^0x[0-9a-fA-F]{130}$/.test(trimmed)) {
    throw new SettlementError(400, "invalid_signature", "signature must be a 65-byte 0x-prefixed hex string");
  }
  return trimmed.toLowerCase() as Hex;
}

export function normalizeBaseUnits(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (!/^(0|[1-9][0-9]*)$/.test(trimmed)) {
    throw new SettlementError(400, "invalid_amount", `${fieldName} must be a base-10 integer string`);
  }
  return trimmed;
}

export function normalizeWallet(value: string, fieldName: string): Address {
  return normalizeAddress(value.trim().toLowerCase(), fieldName);
}

export function requiredSignersFor(kind: SettlementInstructionKind): readonly InstructionSignerRole[] {
  return REQUIRED_SIGNERS[kind];
}

export function isExecuteKind(kind: SettlementInstructionKind): boolean {
  return EXECUTE_INSTRUCTION_KINDS.has(kind);
}

export function assertInstructionAmountShape(
  kind: SettlementInstructionKind,
  payerAmount: string,
  payeeAmount: string
): void {
  const payer = BigInt(payerAmount);
  const payee = BigInt(payeeAmount);
  switch (kind) {
    case "start":
      if (payer !== 0n || payee !== 0n) {
        throw new SettlementError(400, "invalid_amount", "start instructions carry no amounts");
      }
      return;
    case "verdict_approve":
    case "execute_transfer":
      if (payer !== 0n || payee === 0n) {
        throw new SettlementError(400, "invalid_amount", "transfer-shaped instructions require payerAmount=0, payeeAmount>0");
      }
      return;
    case "refund_before_start":
    case "verdict_reject":
    case "execute_refund":
      if (payee !== 0n || payer === 0n) {
        throw new SettlementError(400, "invalid_amount", "refund-shaped instructions require payerAmount>0, payeeAmount=0");
      }
      return;
    case "refund_after_start":
    case "dispute":
    case "resolve_dispute":
      if (payer + payee === 0n) {
        throw new SettlementError(400, "invalid_amount", "split instructions must conserve a non-zero amount");
      }
      return;
  }
}
