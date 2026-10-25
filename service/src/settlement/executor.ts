// Permissionless instruction relayer. It is NOT an authority and never signs:
// it forwards already-collected signatures/facts to StageEscrowV3. For
// execute_transfer/execute_refund it also refuses to act unless the caller is
// the deployment-configured UVP executor and the UVP timer gate has elapsed.
// A dispute blocks pending execute instructions. `unknown` is never retried.

import { randomUUID } from "node:crypto";
import { noopLogger, type Logger } from "../shared/types.js";
import type { SettlementStore } from "./store.js";
import type { ExecuteTrigger } from "./execute-trigger.js";
import {
  buildSettleInstructionTypedData,
  isExecuteKind,
  recoverSettlementSigner,
  settlementInstructionRef,
  type BoundTrancheReader,
  type SettlementChainAdapter,
  type SettlementInstructionRecord,
  type SettlementReceiptRecord
} from "./types.js";

export interface SettlementRelayerOptions {
  readonly store: SettlementStore;
  readonly adapter: SettlementChainAdapter;
  readonly bindings?: BoundTrancheReader;
  readonly executeTrigger?: ExecuteTrigger;
  readonly logger?: Logger;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  readonly maxAttempts?: number;
}

export type SettlementOutcome =
  | "submitted"
  | "confirmed"
  | "pending"
  | "failed"
  | "unknown"
  | "skipped";

export interface SettlementRunResult {
  readonly instructionId: string;
  readonly status: SettlementInstructionRecord["status"];
  readonly outcome: SettlementOutcome;
  readonly errorCode?: string;
}

export interface SettlementRunSummary {
  readonly ready: number;
  readonly submitted: number;
  readonly confirmed: number;
  readonly failed: number;
  readonly unknown: number;
  readonly pending: number;
}

export interface SettlementRelayer {
  process(instructionId: string): Promise<SettlementRunResult>;
  runOnce(input?: { readonly relayLimit?: number; readonly confirmLimit?: number }): Promise<SettlementRunSummary>;
}

const DEFAULT_LIMIT = 25;
const DEFAULT_MAX_ATTEMPTS = 5;

export function createSettlementRelayer(options: SettlementRelayerOptions): SettlementRelayer {
  const logger = options.logger ?? noopLogger;
  const now = options.now ?? (() => new Date());
  const idFactory = options.idFactory ?? (() => `sreceipt_${randomUUID()}`);
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  async function fail(instruction: SettlementInstructionRecord, errorCode: string): Promise<SettlementRunResult> {
    const updated = await options.store.markFailed(instruction.instructionId, errorCode, now().toISOString());
    return {
      instructionId: instruction.instructionId,
      status: "failed",
      outcome: updated ? "failed" : "skipped",
      errorCode
    };
  }

  async function relay(instructionId: string): Promise<SettlementRunResult> {
    const instruction = await options.store.getInstruction(instructionId);
    if (!instruction) {
      return { instructionId, status: "unsigned", outcome: "skipped", errorCode: "instruction_not_found" };
    }
    if (instruction.status !== "ready" && instruction.status !== "execute_ready") {
      return { instructionId, status: instruction.status, outcome: "skipped" };
    }
    if (isExecuteKind(instruction.kind) !== (instruction.status === "execute_ready")) {
      return { instructionId, status: instruction.status, outcome: "skipped", errorCode: "instruction_status_mismatch" };
    }
    if (instruction.attempts >= maxAttempts) {
      return fail(instruction, "max_attempts_exceeded");
    }
    if (instruction.blockedByDispute === true) {
      return fail(instruction, "blocked_by_dispute");
    }
    if (BigInt(instruction.deadline) <= BigInt(Math.floor(now().getTime() / 1000)) && !isExecuteKind(instruction.kind)) {
      return fail(instruction, "instruction_expired");
    }
    const expectedRef = settlementInstructionRef({
      planId: instruction.planId,
      orderId: instruction.orderId,
      stageId: instruction.stageId
    });
    if (expectedRef !== instruction.instructionRef) {
      return fail(instruction, "instruction_ref_mismatch");
    }

    if (isExecuteKind(instruction.kind)) {
      if (!options.executeTrigger) {
        return fail(instruction, "settlement_fact_source_not_configured");
      }
      if (instruction.executeEligibleAt === undefined) {
        return fail(instruction, "execute_gate_missing");
      }
      if (Date.parse(instruction.executeEligibleAt) > now().getTime()) {
        return {
          instructionId,
          status: instruction.status,
          outcome: "skipped",
          errorCode: "execute_gate_pending"
        };
      }
      const disputed = await trancheHasDispute(options.store, instruction);
      if (disputed) {
        await options.store.markBlockedByDispute(instruction.instructionId, now().toISOString());
        return fail(instruction, "blocked_by_dispute");
      }
      const factConfirmed = await options.executeTrigger.confirmFact({ instruction });
      if (!factConfirmed) {
        return fail(instruction, "settlement_fact_missing");
      }
    } else {
      const signatureError = await verifyRequiredSignatures(instruction);
      if (signatureError !== undefined) {
        return fail(instruction, signatureError);
      }
    }

    if (options.bindings) {
      const binding = await options.bindings.getBoundTranche({
        chainId: instruction.chainId,
        escrowAddress: instruction.escrowAddress,
        trancheId: instruction.trancheId
      });
      if (!binding) return fail(instruction, "tranche_not_bound");
      if (binding.state === "foreign") return fail(instruction, "tranche_is_foreign");
      if (binding.state === "settled") return fail(instruction, "tranche_already_settled");
      if (binding.state !== "bound") return fail(instruction, "tranche_not_settleable");
      if (
        binding.orderId !== instruction.orderId ||
        binding.stageId !== instruction.stageId ||
        (instruction.payer !== undefined && binding.payer !== instruction.payer) ||
        (instruction.payee !== undefined && binding.payee !== instruction.payee)
      ) {
        return fail(instruction, "binding_identity_mismatch");
      }
      if (
        instruction.verifier !== undefined &&
        binding.verifier !== undefined &&
        binding.verifier !== instruction.verifier
      ) {
        return fail(instruction, "binding_verifier_mismatch");
      }
      if (BigInt(instruction.payerAmount) + BigInt(instruction.payeeAmount) !== BigInt(binding.amount)) {
        return fail(instruction, "amount_not_conserved_with_binding");
      }
    }

    const claimed = await options.store.markSubmittedFromReady(
      instruction.instructionId,
      instruction.attempts + 1,
      now().toISOString()
    );
    if (!claimed) {
      const latest = await options.store.getInstruction(instructionId);
      return {
        instructionId,
        status: latest?.status ?? instruction.status,
        outcome: "skipped",
        ...(latest?.errorCode ? { errorCode: latest.errorCode } : {})
      };
    }

    let result: Awaited<ReturnType<SettlementChainAdapter["submitInstruction"]>>;
    try {
      result = await options.adapter.submitInstruction({ instruction });
    } catch (error) {
      await options.store.markUnknown(instruction.instructionId, "relay_threw_result_unknown", now().toISOString());
      logger.error("instruction relay threw; outcome is unknown and will not be auto-retried", {
        instructionId,
        message: error instanceof Error ? error.message : "unknown error"
      });
      return { instructionId, status: "unknown", outcome: "unknown", errorCode: "relay_threw_result_unknown" };
    }

    if (result.kind === "submitted") {
      const stored = await options.store.setSubmittedTx(
        instruction.instructionId,
        result.txHash,
        now().toISOString()
      );
      if (!stored) {
        logger.warn("instruction tx hash could not be recorded after relay", {
          instructionId,
          txHash: result.txHash
        });
      }
      return { instructionId, status: "submitted", outcome: "submitted" };
    }
    if (result.kind === "unknown") {
      const reason = sanitizeErrorCode(result.reason);
      await options.store.markUnknown(instruction.instructionId, reason, now().toISOString());
      return { instructionId, status: "unknown", outcome: "unknown", errorCode: reason };
    }
    const reason = sanitizeErrorCode(result.errorCode);
    await options.store.markFailed(instruction.instructionId, reason, now().toISOString());
    return { instructionId, status: "failed", outcome: "failed", errorCode: reason };
  }

  async function confirm(instructionId: string): Promise<SettlementRunResult> {
    const instruction = await options.store.getInstruction(instructionId);
    if (!instruction) {
      return { instructionId, status: "unsigned", outcome: "skipped", errorCode: "instruction_not_found" };
    }
    if (instruction.status !== "submitted") {
      return { instructionId, status: instruction.status, outcome: "skipped" };
    }
    if (!instruction.txHash) {
      return { instructionId, status: instruction.status, outcome: "pending" };
    }
    const receiptResult = await options.adapter.getSettlementReceipt({
      chainId: instruction.chainId,
      escrowAddress: instruction.escrowAddress,
      txHash: instruction.txHash
    });
    if (receiptResult.kind === "not_found" || receiptResult.kind === "pending") {
      return { instructionId, status: instruction.status, outcome: "pending" };
    }
    if (receiptResult.kind === "reverted") {
      const reason = sanitizeErrorCode(receiptResult.errorCode);
      await options.store.markFailed(instruction.instructionId, reason, now().toISOString());
      return { instructionId, status: "failed", outcome: "failed", errorCode: reason };
    }
    const receipt = receiptResult.receipt;
    if (receipt.instructionRef !== instruction.instructionRef || receipt.txHash !== instruction.txHash) {
      return fail(instruction, "receipt_instruction_ref_mismatch");
    }
    if (
      receipt.payerAmount !== instruction.payerAmount ||
      receipt.payeeAmount !== instruction.payeeAmount
    ) {
      return fail(instruction, "receipt_amount_mismatch");
    }
    const stored: SettlementReceiptRecord = {
      receiptId: idFactory(),
      instructionId: instruction.instructionId,
      chainId: instruction.chainId,
      escrowAddress: instruction.escrowAddress,
      orderId: instruction.orderId,
      stageId: instruction.stageId,
      trancheId: instruction.trancheId,
      payerAmount: receipt.payerAmount,
      payeeAmount: receipt.payeeAmount,
      feeAmount: receipt.feeAmount,
      instructionRef: receipt.instructionRef,
      txHash: receipt.txHash,
      blockNumber: receipt.blockNumber,
      logIndex: receipt.logIndex,
      confirmedAt: now().toISOString()
    };
    const confirmed = await options.store.markConfirmed(instruction.instructionId, stored);
    return {
      instructionId,
      status: confirmed
        ? "confirmed"
        : (await options.store.getInstruction(instructionId))?.status ?? instruction.status,
      outcome: confirmed ? "confirmed" : "skipped"
    };
  }

  return {
    async process(instructionId) {
      const instruction = await options.store.getInstruction(instructionId);
      if (!instruction) {
        return { instructionId, status: "unsigned", outcome: "skipped", errorCode: "instruction_not_found" };
      }
      return instruction.status === "submitted" ? confirm(instructionId) : relay(instructionId);
    },

    async runOnce(input = {}) {
      const relayLimit = input.relayLimit ?? DEFAULT_LIMIT;
      const confirmLimit = input.confirmLimit ?? DEFAULT_LIMIT;
      const ready = [
        ...(await options.store.listByStatus("ready", relayLimit)),
        ...(await options.store.listByStatus("execute_ready", relayLimit))
      ];
      const submitted = await options.store.listByStatus("submitted", confirmLimit);
      let confirmed = 0;
      let failed = 0;
      let unknown = 0;
      let pending = 0;
      for (const instruction of ready) {
        const result = await relay(instruction.instructionId);
        if (result.status === "submitted") continue;
        if (result.status === "failed") failed += 1;
        else if (result.status === "unknown") unknown += 1;
        else pending += 1;
      }
      for (const instruction of submitted) {
        const result = await confirm(instruction.instructionId);
        if (result.status === "confirmed") confirmed += 1;
        else if (result.status === "failed") failed += 1;
        else pending += 1;
      }
      return { ready: ready.length, submitted: ready.length, confirmed, failed, unknown, pending };
    }
  };
}

async function verifyRequiredSignatures(
  instruction: SettlementInstructionRecord
): Promise<string | undefined> {
  const byRole = new Map(instruction.signatures.map((entry) => [entry.role, entry]));
  for (const role of instruction.requiredSigners) {
    if (!byRole.has(role)) {
      return `missing_${role}_signature`;
    }
  }
  const expected: Record<"payer" | "payee" | "verifier", string | undefined> = {
    payer: instruction.payer,
    payee: instruction.payee,
    verifier: instruction.verifier
  };
  const typedData = buildSettleInstructionTypedData({
    chainId: instruction.chainId,
    escrowAddress: instruction.escrowAddress,
    trancheId: instruction.trancheId,
    orderId: instruction.orderId,
    stageId: instruction.stageId,
    kind: instruction.kind,
    payerAmount: instruction.payerAmount,
    payeeAmount: instruction.payeeAmount,
    instructionRef: instruction.instructionRef,
    nonce: instruction.nonce,
    deadline: instruction.deadline
  });
  for (const role of instruction.requiredSigners) {
    const entry = byRole.get(role);
    if (!entry) continue;
    const wallet = expected[role];
    if (!wallet || wallet !== entry.signer) {
      return `${role}_sig_signer_mismatch`;
    }
    const recovered = await recoverSettlementSigner(typedData, entry.signature);
    if (recovered !== wallet) {
      return `${role}_signature_not_${role}`;
    }
  }
  return undefined;
}

async function trancheHasDispute(
  store: SettlementStore,
  instruction: SettlementInstructionRecord
): Promise<boolean> {
  const siblings = await store.listByTranche(instruction.chainId, instruction.escrowAddress, instruction.trancheId);
  return siblings.some(
    (sibling) =>
      (sibling.kind === "dispute" || sibling.kind === "resolve_dispute") &&
      ["ready", "submitted", "confirmed"].includes(sibling.status)
  );
}

function sanitizeErrorCode(value: string): string {
  const trimmed = value.trim();
  return /^[A-Za-z0-9_]{1,80}$/.test(trimmed) ? trimmed : "settlement_error";
}
