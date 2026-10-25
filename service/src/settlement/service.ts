// Settlement ledger service: turns a UVP fact / verdict / timer into an
// instruction that carries its required signer roles, collects exactly those
// signatures (A=payer, B=payee, C=assigned verifier), and marks execute_*
// instructions ready for the UVP-side executor only. A party refusing to sign
// simply leaves the instruction short of `ready`; no coercion path exists.

import { randomBytes, randomUUID } from "node:crypto";
import {
  canonicalStageId,
  canonicalTrancheId,
  normalizeWallet
} from "../binding/types.js";
import { normalizeBytes32, type Address, type Hex } from "../shared/types.js";
import { hashCanonicalJson } from "../shared/canonical-json.js";
import { StorageConstraintError } from "../storage/errors.js";
import type { SettlementStore } from "./store.js";
import {
  SETTLEMENT_INSTRUCTION_KINDS,
  SettlementError,
  assertInstructionAmountShape,
  buildSettleInstructionTypedData,
  isExecuteKind,
  normalizeBaseUnits,
  normalizeSignature,
  recoverSettlementSigner,
  requiredSignersFor,
  settlementInstructionRef,
  settlementTypedDataHash,
  type BoundTrancheReader,
  type CreateSettlementInstructionInput,
  type InstructionSignature,
  type InstructionSignerRole,
  type SettlementInstructionKind,
  type SettlementInstructionRecord,
  type SettlementInstructionStatus,
  type SettlementInstructionTypedData,
  type SettlementInstructionView
} from "./types.js";

export interface SettlementLedgerOptions {
  readonly store: SettlementStore;
  readonly tranches?: BoundTrancheReader;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  readonly nonceFactory?: () => string;
  readonly defaultDeadlineSeconds?: number;
}

export interface CreatedSettlementInstruction {
  readonly instruction: SettlementInstructionView;
  readonly created: boolean;
}

export interface SignedSettlementInstruction {
  readonly instruction: SettlementInstructionView;
  readonly replayed: boolean;
}

export interface SettlementLedger {
  createInstruction(input: CreateSettlementInstructionInput): Promise<CreatedSettlementInstruction>;
  addSignature(input: {
    readonly instructionId: string;
    readonly signer: string;
    readonly signature: string;
  }): Promise<SignedSettlementInstruction>;
  getInstruction(instructionId: string): Promise<SettlementInstructionView | undefined>;
  listInstructions(
    status: SettlementInstructionStatus,
    limit?: number
  ): Promise<readonly SettlementInstructionView[]>;
}

const DEFAULT_DEADLINE_SECONDS = 900;

export function createSettlementLedger(options: SettlementLedgerOptions): SettlementLedger {
  const now = options.now ?? (() => new Date());
  const idFactory = options.idFactory ?? (() => `sinstr_${randomUUID()}`);
  const nonceFactory = options.nonceFactory ?? (() => BigInt(`0x${randomBytes(16).toString("hex")}`).toString(10));
  const defaultDeadlineSeconds = options.defaultDeadlineSeconds ?? DEFAULT_DEADLINE_SECONDS;

  return {
    async createInstruction(input) {
      const instruction = await normalizeInstruction(input, {
        now,
        idFactory,
        nonceFactory,
        defaultDeadlineSeconds,
        ...(options.tranches ? { tranches: options.tranches } : {})
      });
      const byKey = await options.store.getInstructionByIdempotencyKey(instruction.idempotencyKey);
      if (byKey) {
        if (byKey.instructionRef !== instruction.instructionRef) {
          throw new SettlementError(
            409,
            "idempotency_key_conflict",
            "the idempotency key was already used for a different settlement instruction",
            { idempotencyKey: instruction.idempotencyKey, existingInstructionId: byKey.instructionId }
          );
        }
        return { instruction: instructionView(byKey), created: false };
      }
      try {
        await options.store.createInstruction(instruction);
      } catch (error) {
        if (error instanceof StorageConstraintError) {
          const raced = await options.store.getInstructionByIdempotencyKey(instruction.idempotencyKey);
          if (raced) {
            return { instruction: instructionView(raced), created: false };
          }
          throw new SettlementError(
            409,
            "settlement_instruction_conflict",
            "a conflicting settlement instruction already exists",
            { instructionRef: instruction.instructionRef }
          );
        }
        throw error;
      }
      if (instruction.kind === "dispute") {
        await blockExecuteInstructions(options.store, instruction, now());
      }
      return { instruction: instructionView(instruction), created: true };
    },

    async addSignature(input) {
      const instruction = await options.store.getInstruction(input.instructionId);
      if (!instruction) {
        throw new SettlementError(404, "instruction_not_found", "settlement instruction not found");
      }
      const signer = normalizeWallet(input.signer, "signer");
      const signature = normalizeSignature(input.signature);
      const typedData = typedDataFor(instruction);
      const recovered = await recoverSettlementSigner(typedData, signature);
      if (recovered !== signer) {
        throw new SettlementError(400, "signature_signer_mismatch", "signature does not recover to the claimed signer", {
          claimed: signer,
          recovered
        });
      }
      const role = expectedRole(instruction, signer);
      if (role === undefined) {
        throw new SettlementError(
          403,
          "signer_not_authorized",
          "only the assigned payer, payee or verifier can sign this instruction",
          { signer, kind: instruction.kind }
        );
      }
      if (!instruction.requiredSigners.includes(role)) {
        throw new SettlementError(
          403,
          "signer_role_not_required",
          "this signer role is not required for the instruction kind",
          { signer, role, kind: instruction.kind, requiredSigners: instruction.requiredSigners }
        );
      }
      if (BigInt(instruction.deadline) <= BigInt(Math.floor(now().getTime() / 1000))) {
        throw new SettlementError(409, "instruction_expired", "the signature window has elapsed", {
          instructionId: instruction.instructionId,
          deadline: instruction.deadline
        });
      }
      const already = instruction.signatures.find((entry) => entry.role === role);
      if (already) {
        if (already.signature === signature) {
          return { instruction: instructionView(instruction), replayed: true };
        }
        throw new SettlementError(
          409,
          "signature_already_recorded",
          "this participant already signed a different payload",
          { instructionId: instruction.instructionId, role }
        );
      }
      const nextStatus = nextStatusFor(instruction, role);
      const applied = await options.store.setSignature({
        instructionId: instruction.instructionId,
        role,
        signature,
        signer,
        nextStatus,
        updatedAt: now().toISOString()
      });
      if (!applied) {
        const latest = await options.store.getInstruction(instruction.instructionId);
        const latestSignature = latest?.signatures.find((entry) => entry.role === role);
        if (latestSignature?.signature === signature) {
          return { instruction: instructionView(latest!), replayed: true };
        }
        throw new SettlementError(409, "instruction_state_conflict", "the instruction changed while recording the signature", {
          instructionId: instruction.instructionId,
          role
        });
      }
      const stored = await options.store.getInstruction(instruction.instructionId);
      if (!stored) {
        throw new SettlementError(500, "instruction_lost", "instruction disappeared after signing");
      }
      return { instruction: instructionView(stored), replayed: false };
    },

    async getInstruction(instructionId) {
      const instruction = await options.store.getInstruction(instructionId);
      return instruction ? instructionView(instruction) : undefined;
    },

    async listInstructions(status, limit = 100) {
      const records = await options.store.listByStatus(status, limit);
      return records.map(instructionView);
    }
  };
}

async function normalizeInstruction(
  input: CreateSettlementInstructionInput,
  context: {
    readonly now: () => Date;
    readonly idFactory: () => string;
    readonly nonceFactory: () => string;
    readonly defaultDeadlineSeconds: number;
    readonly tranches?: BoundTrancheReader;
  }
): Promise<SettlementInstructionRecord> {
  const planId = normalizeBytes32(input.planId, "planId");
  const orderId = normalizeBytes32(input.orderId, "orderId");
  const stageKey = input.stageKey.trim();
  if (stageKey.length === 0) {
    throw new SettlementError(400, "invalid_stage_key", "stageKey must be a non-empty string");
  }
  const expectedStageId = canonicalStageId(stageKey);
  const stageId = input.stageId === undefined ? expectedStageId : normalizeBytes32(input.stageId, "stageId");
  if (stageId !== expectedStageId) {
    throw new SettlementError(400, "stage_id_not_canonical", "stageId must equal keccak256(stageKey)", {
      stageKey,
      expectedStageId
    });
  }
  const kind = input.kind;
  if (!(SETTLEMENT_INSTRUCTION_KINDS as readonly string[]).includes(kind)) {
    throw new SettlementError(400, "invalid_kind", `unsupported instruction kind: ${kind}`);
  }
  let payer = input.payer === undefined ? undefined : normalizeWallet(input.payer, "payer");
  let payee = input.payee === undefined ? undefined : normalizeWallet(input.payee, "payee");
  let verifier = input.verifier === undefined ? undefined : normalizeWallet(input.verifier, "verifier");
  let trancheId: Hex;
  if (input.trancheId === undefined) {
    if (payer === undefined) {
      throw new SettlementError(400, "invalid_tranche_id", "trancheId is required (or provide payer)");
    }
    trancheId = canonicalTrancheId(orderId, stageId, payer);
  } else {
    trancheId = normalizeBytes32(input.trancheId, "trancheId");
    if (payer !== undefined && trancheId !== canonicalTrancheId(orderId, stageId, payer)) {
      throw new SettlementError(400, "tranche_id_not_canonical", "trancheId must equal keccak256(orderId,stageId,payer)");
    }
  }

  let bindingAmount: string | undefined;
  if (context.tranches) {
    const binding = await context.tranches.getBoundTranche({
      chainId: input.chainId,
      escrowAddress: normalizeWallet(input.escrowAddress, "escrowAddress"),
      trancheId
    });
    if (!binding) {
      throw new SettlementError(409, "tranche_not_bound", "no tranche binding exists for this instruction");
    }
    if (binding.state === "foreign") {
      throw new SettlementError(409, "tranche_is_foreign", "foreign tranches cannot produce settlement instructions");
    }
    if (binding.state !== "bound") {
      throw new SettlementError(409, "tranche_not_settleable", "tranche binding is not in the bound state");
    }
    if (binding.orderId !== orderId || binding.stageId !== stageId) {
      throw new SettlementError(409, "binding_identity_mismatch", "binding order/stage/tranche does not match");
    }
    if (payer !== undefined && payer !== binding.payer) {
      throw new SettlementError(409, "binding_payer_mismatch", "instruction payer is not the bound payer");
    }
    if (payee !== undefined && payee !== binding.payee) {
      throw new SettlementError(409, "binding_payee_mismatch", "instruction payee is not the bound payee");
    }
    if (verifier !== undefined && binding.verifier !== undefined && verifier !== binding.verifier) {
      throw new SettlementError(409, "binding_verifier_mismatch", "instruction verifier is not the bound verifier");
    }
    payer = binding.payer;
    payee = binding.payee;
    verifier = verifier ?? binding.verifier;
    bindingAmount = binding.amount;
  }

  if (requiredSignersFor(kind).includes("verifier") && verifier === undefined) {
    throw new SettlementError(409, "verifier_required", "this instruction kind requires the assigned verifier");
  }
  const amounts = normalizeAmountsForKind(kind, input, bindingAmount);
  const sourceFactId = normalizeBytes32(input.sourceFactId, "sourceFactId");
  const instructionRef = settlementInstructionRef({ planId, orderId, stageId });
  const createdAt = context.now();
  const deadlineSeconds = input.deadlineSeconds ?? context.defaultDeadlineSeconds;
  if (!Number.isSafeInteger(deadlineSeconds) || deadlineSeconds <= 0) {
    throw new SettlementError(400, "invalid_deadline", "deadlineSeconds must be a positive safe integer");
  }
  const nonce = normalizeBaseUnits(input.nonce ?? context.nonceFactory(), "nonce");
  if (nonce === "0") {
    throw new SettlementError(400, "invalid_nonce", "nonce must be greater than zero");
  }
  const deadline = BigInt(Math.floor(createdAt.getTime() / 1000) + deadlineSeconds).toString();
  const escrowAddress = normalizeWallet(input.escrowAddress, "escrowAddress");
  const typedData = buildSettleInstructionTypedData({
    chainId: input.chainId,
    escrowAddress,
    trancheId,
    orderId,
    stageId,
    kind,
    payerAmount: amounts.payerAmount,
    payeeAmount: amounts.payeeAmount,
    instructionRef,
    nonce,
    deadline
  });
  const requiredSigners = requiredSignersFor(kind);
  const isExecute = isExecuteKind(kind);
  const uvpExecutorAddress = input.uvpExecutorAddress === undefined
    ? undefined
    : normalizeWallet(input.uvpExecutorAddress, "uvpExecutorAddress");
  if (isExecute) {
    if (!input.executeEligibleAt) {
      throw new SettlementError(400, "execute_gate_required", "execute instructions require a UVP time/hook gate");
    }
    if (Number.isNaN(Date.parse(input.executeEligibleAt))) {
      throw new SettlementError(400, "invalid_execute_gate", "executeEligibleAt must be an ISO timestamp");
    }
  }
  const timestamp = createdAt.toISOString();
  return {
    instructionId: context.idFactory(),
    idempotencyKey: input.idempotencyKey?.trim() || hashCanonicalJson({
      kind,
      instructionRef,
      payerAmount: amounts.payerAmount,
      payeeAmount: amounts.payeeAmount,
      sourceFactId
    }, "settlementIdempotencyKey"),
    chainId: input.chainId,
    escrowAddress,
    planId,
    orderId,
    stageKey,
    stageId,
    trancheId,
    kind,
    payerAmount: amounts.payerAmount,
    payeeAmount: amounts.payeeAmount,
    sourceFactId,
    ...(payer !== undefined ? { payer } : {}),
    ...(payee !== undefined ? { payee } : {}),
    ...(verifier !== undefined ? { verifier } : {}),
    ...(uvpExecutorAddress !== undefined ? { uvpExecutorAddress } : {}),
    requiredSigners,
    signatures: [],
    instructionRef,
    typedDataHash: settlementTypedDataHash(typedData),
    nonce,
    deadline,
    status: isExecute ? "execute_ready" : "unsigned",
    ...(isExecute && input.executeEligibleAt ? { executeEligibleAt: input.executeEligibleAt } : {}),
    blockedByDispute: false,
    attempts: 0,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function normalizeAmountsForKind(
  kind: SettlementInstructionKind,
  input: CreateSettlementInstructionInput,
  bindingAmount: string | undefined
): { readonly payerAmount: string; readonly payeeAmount: string } {
  const fixed = (payerAmount: string, payeeAmount: string) => {
    if (declaredPayer !== payerAmount || declaredPayee !== payeeAmount) {
      throw new SettlementError(
        409,
        kind.startsWith("execute_") ? "execute_amount_immutable" : "amount_mismatch",
        "this instruction kind has fixed amounts; declared amounts must match exactly",
        { kind, expected: { payerAmount, payeeAmount }, declared: { payerAmount: declaredPayer, payeeAmount: declaredPayee } }
      );
    }
    assertInstructionAmountShape(kind, payerAmount, payeeAmount);
    if (bindingAmount !== undefined && BigInt(payerAmount) + BigInt(payeeAmount) !== BigInt(bindingAmount)) {
      throw new SettlementError(409, "amount_not_conserved_with_binding", "amounts must conserve the bound tranche", {
        bindingAmount
      });
    }
    return { payerAmount, payeeAmount };
  };
  const declaredPayer = normalizeBaseUnits(input.payerAmount, "payerAmount");
  const declaredPayee = normalizeBaseUnits(input.payeeAmount, "payeeAmount");
  switch (kind) {
    case "start":
      return fixed("0", "0");
    case "verdict_approve":
      return fixed("0", bindingAmount ?? declaredPayee);
    case "verdict_reject":
    case "refund_before_start":
      return fixed(bindingAmount ?? declaredPayer, "0");
    case "execute_transfer":
      return fixed("0", bindingAmount ?? declaredPayee);
    case "execute_refund":
      return fixed(bindingAmount ?? declaredPayer, "0");
    case "refund_after_start":
    case "dispute":
    case "resolve_dispute":
      return fixed(declaredPayer, declaredPayee);
  }
}

async function blockExecuteInstructions(
  store: SettlementStore,
  dispute: SettlementInstructionRecord,
  now: Date
): Promise<void> {
  const siblings = await store.listByTranche(dispute.chainId, dispute.escrowAddress, dispute.trancheId);
  for (const sibling of siblings) {
    if (isExecuteKind(sibling.kind) && sibling.status !== "confirmed" && sibling.status !== "failed") {
      await store.markBlockedByDispute(sibling.instructionId, now.toISOString());
    }
  }
}

function typedDataFor(record: SettlementInstructionRecord): SettlementInstructionTypedData {
  return buildSettleInstructionTypedData({
    chainId: record.chainId,
    escrowAddress: record.escrowAddress,
    trancheId: record.trancheId,
    orderId: record.orderId,
    stageId: record.stageId,
    kind: record.kind,
    payerAmount: record.payerAmount,
    payeeAmount: record.payeeAmount,
    instructionRef: record.instructionRef,
    nonce: record.nonce,
    deadline: record.deadline
  });
}

function expectedRole(
  record: SettlementInstructionRecord,
  signer: Address
): InstructionSignerRole | undefined {
  if (record.payer === signer) return "payer";
  if (record.payee === signer) return "payee";
  if (record.verifier === signer) return "verifier";
  return undefined;
}

function nextStatusFor(
  record: SettlementInstructionRecord,
  role: InstructionSignerRole
): SettlementInstructionStatus {
  const signed = new Set<InstructionSignerRole>(record.signatures.map((entry) => entry.role));
  signed.add(role);
  return record.requiredSigners.every((required) => signed.has(required))
    ? "ready"
    : "partially_signed";
}

export function instructionView(record: SettlementInstructionRecord): SettlementInstructionView {
  return {
    instructionId: record.instructionId,
    idempotencyKey: record.idempotencyKey,
    chainId: record.chainId,
    escrowAddress: record.escrowAddress,
    planId: record.planId,
    orderId: record.orderId,
    stageKey: record.stageKey,
    stageId: record.stageId,
    trancheId: record.trancheId,
    kind: record.kind,
    payerAmount: record.payerAmount,
    payeeAmount: record.payeeAmount,
    sourceFactId: record.sourceFactId,
    ...(record.payer !== undefined ? { payer: record.payer } : {}),
    ...(record.payee !== undefined ? { payee: record.payee } : {}),
    ...(record.verifier !== undefined ? { verifier: record.verifier } : {}),
    ...(record.uvpExecutorAddress !== undefined ? { uvpExecutorAddress: record.uvpExecutorAddress } : {}),
    requiredSigners: record.requiredSigners,
    signatures: record.signatures,
    instructionRef: record.instructionRef,
    typedDataHash: record.typedDataHash,
    nonce: record.nonce,
    deadline: record.deadline,
    typedData: typedDataFor(record),
    status: record.status,
    ...(record.executeEligibleAt !== undefined ? { executeEligibleAt: record.executeEligibleAt } : {}),
    blockedByDispute: record.blockedByDispute === true,
    ...(record.txHash !== undefined ? { txHash: record.txHash } : {}),
    ...(record.blockNumber !== undefined ? { blockNumber: record.blockNumber } : {}),
    ...(record.errorCode !== undefined ? { errorCode: record.errorCode } : {}),
    attempts: record.attempts,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}
