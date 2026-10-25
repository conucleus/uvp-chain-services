// Settlement ledger persistence port + in-memory implementation. Transitions
// are compare-and-set and signature columns are write-once: a row becomes
// payer_signed/payee_signed only when the corresponding column was empty, and
// only a `ready` row (both signatures) can be handed to a relayer.

import { StorageConstraintError } from "../storage/errors.js";
import type { Address, Hex } from "../shared/types.js";
import type {
  SettlementInstructionRecord,
  SettlementInstructionStatus,
  SettlementReceiptRecord
} from "./types.js";

export interface SettlementStore {
  createInstruction(record: SettlementInstructionRecord): Promise<void>;
  getInstruction(instructionId: string): Promise<SettlementInstructionRecord | undefined>;
  getInstructionByRef(instructionRef: string): Promise<SettlementInstructionRecord | undefined>;
  getInstructionByIdempotencyKey(key: string): Promise<SettlementInstructionRecord | undefined>;
  listByStatus(status: SettlementInstructionStatus, limit: number): Promise<readonly SettlementInstructionRecord[]>;
  listByOrder(orderId: string, limit: number): Promise<readonly SettlementInstructionRecord[]>;
  listByTranche(
    chainId: number,
    escrowAddress: Address,
    trancheId: string
  ): Promise<readonly SettlementInstructionRecord[]>;

  setSignature(input: {
    readonly instructionId: string;
    readonly role: "payer" | "payee" | "verifier";
    readonly signature: Hex;
    readonly signer: Address;
    readonly nextStatus: SettlementInstructionStatus;
    readonly updatedAt: string;
  }): Promise<boolean>;
  markBlockedByDispute(instructionId: string, updatedAt: string): Promise<boolean>;
  markSubmittedFromReady(instructionId: string, attempts: number, updatedAt: string): Promise<boolean>;
  setSubmittedTx(instructionId: string, txHash: Hex, updatedAt: string): Promise<boolean>;
  markFailed(instructionId: string, errorCode: string, updatedAt: string): Promise<boolean>;
  markUnknown(instructionId: string, errorCode: string, updatedAt: string): Promise<boolean>;
  markConfirmed(instructionId: string, receipt: SettlementReceiptRecord): Promise<boolean>;

  getReceipt(instructionId: string): Promise<SettlementReceiptRecord | undefined>;
}

export class MemorySettlementStore implements SettlementStore {
  readonly #instructions = new Map<string, SettlementInstructionRecord>();
  readonly #receipts = new Map<string, SettlementReceiptRecord>();

  async createInstruction(record: SettlementInstructionRecord): Promise<void> {
    for (const existing of this.#instructions.values()) {
      if (existing.idempotencyKey === record.idempotencyKey) {
        throw new StorageConstraintError("settlement idempotency key already exists");
      }
    }
    this.#instructions.set(record.instructionId, record);
  }

  async getInstruction(instructionId: string): Promise<SettlementInstructionRecord | undefined> {
    return this.#instructions.get(instructionId);
  }

  async getInstructionByRef(instructionRef: string): Promise<SettlementInstructionRecord | undefined> {
    return [...this.#instructions.values()].find(
      (instruction) => instruction.instructionRef === instructionRef.toLowerCase()
    );
  }

  async getInstructionByIdempotencyKey(key: string): Promise<SettlementInstructionRecord | undefined> {
    return [...this.#instructions.values()].find((instruction) => instruction.idempotencyKey === key);
  }

  async listByStatus(
    status: SettlementInstructionStatus,
    limit: number
  ): Promise<readonly SettlementInstructionRecord[]> {
    return [...this.#instructions.values()]
      .filter((instruction) => instruction.status === status)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .slice(0, limit);
  }

  async listByOrder(orderId: string, limit: number): Promise<readonly SettlementInstructionRecord[]> {
    const normalized = orderId.toLowerCase();
    return [...this.#instructions.values()]
      .filter((instruction) => instruction.orderId === normalized)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .slice(0, limit);
  }

  async listByTranche(
    chainId: number,
    escrowAddress: Address,
    trancheId: string
  ): Promise<readonly SettlementInstructionRecord[]> {
    const address = escrowAddress.toLowerCase();
    const normalizedTranche = trancheId.toLowerCase();
    return [...this.#instructions.values()].filter(
      (instruction) =>
        instruction.chainId === chainId &&
        instruction.escrowAddress === address &&
        instruction.trancheId === normalizedTranche
    );
  }

  async setSignature(input: {
    readonly instructionId: string;
    readonly role: "payer" | "payee" | "verifier";
    readonly signature: Hex;
    readonly signer: Address;
    readonly nextStatus: SettlementInstructionStatus;
    readonly updatedAt: string;
  }): Promise<boolean> {
    const instruction = this.#instructions.get(input.instructionId);
    if (!instruction || !["unsigned", "partially_signed"].includes(instruction.status)) {
      return false;
    }
    const signatures = instruction.signatures.filter((entry) => entry.role !== input.role);
    if (signatures.length !== instruction.signatures.length) {
      return false;
    }
    signatures.push({ role: input.role, signer: input.signer, signature: input.signature });
    this.#instructions.set(input.instructionId, {
      ...instruction,
      signatures,
      status: input.nextStatus,
      updatedAt: input.updatedAt
    });
    return true;
  }

  async markBlockedByDispute(instructionId: string, updatedAt: string): Promise<boolean> {
    const instruction = this.#instructions.get(instructionId);
    if (!instruction || instruction.blockedByDispute === true || instruction.status === "confirmed" || instruction.status === "failed") {
      return false;
    }
    this.#instructions.set(instructionId, { ...instruction, blockedByDispute: true, updatedAt });
    return true;
  }

  async markSubmittedFromReady(instructionId: string, attempts: number, updatedAt: string): Promise<boolean> {
    const instruction = this.#instructions.get(instructionId);
    if (!instruction || (instruction.status !== "ready" && instruction.status !== "execute_ready")) {
      return false;
    }
    this.#instructions.set(instructionId, {
      ...instruction,
      status: "submitted",
      attempts,
      updatedAt
    });
    return true;
  }

  async setSubmittedTx(instructionId: string, txHash: Hex, updatedAt: string): Promise<boolean> {
    const instruction = this.#instructions.get(instructionId);
    if (!instruction || instruction.status !== "submitted") {
      return false;
    }
    this.#instructions.set(instructionId, { ...instruction, txHash, updatedAt });
    return true;
  }

  async markFailed(instructionId: string, errorCode: string, updatedAt: string): Promise<boolean> {
    return this.#terminal(instructionId, "failed", errorCode, updatedAt);
  }

  async markUnknown(instructionId: string, errorCode: string, updatedAt: string): Promise<boolean> {
    return this.#terminal(instructionId, "unknown", errorCode, updatedAt);
  }

  async markConfirmed(instructionId: string, receipt: SettlementReceiptRecord): Promise<boolean> {
    const instruction = this.#instructions.get(instructionId);
    if (!instruction || instruction.status !== "submitted") {
      return false;
    }
    for (const existing of this.#receipts.values()) {
      if (
        existing.chainId === receipt.chainId &&
        existing.escrowAddress === receipt.escrowAddress &&
        existing.txHash === receipt.txHash &&
        existing.logIndex === receipt.logIndex
      ) {
        return false;
      }
    }
    this.#receipts.set(instructionId, receipt);
    this.#instructions.set(instructionId, {
      ...instruction,
      status: "confirmed",
      txHash: receipt.txHash,
      blockNumber: receipt.blockNumber,
      updatedAt: receipt.confirmedAt
    });
    return true;
  }

  async getReceipt(instructionId: string): Promise<SettlementReceiptRecord | undefined> {
    return this.#receipts.get(instructionId);
  }

  #terminal(
    instructionId: string,
    status: "failed" | "unknown",
    errorCode: string,
    updatedAt: string
  ): boolean {
    const instruction = this.#instructions.get(instructionId);
    if (
      !instruction ||
      instruction.status === "confirmed" ||
      instruction.status === "failed" ||
      instruction.status === "unknown"
    ) {
      return false;
    }
    this.#instructions.set(instructionId, { ...instruction, status, errorCode, updatedAt });
    return true;
  }
}
