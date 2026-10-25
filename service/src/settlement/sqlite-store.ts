// SQLite persistence for settlement instructions and receipts (migration
// 0033_binding_settlement_runtime.sql). Signature columns are write-once CAS
// updates per role; only a `ready` instruction can be relayed; receipt
// insertion is unique per (chain, escrow, tx, log). No executor column exists:
// permissionless relayers carry signatures/facts, while execute_* acceptance is
// an escrow-side UVP-executor check.

import { runSqliteMigrations } from "../storage/migrations.js";
import {
  numberColumn,
  optionalStringColumn,
  rowObject,
  stringColumn
} from "../storage/sqlite-rows.js";
import {
  normalizeSqliteError,
  openSqliteDatabase,
  runSqliteWrite,
  withSqliteTransaction,
  type SqliteDatabase
} from "../storage/sqlite.js";
import type { Address, Hex } from "../shared/types.js";
import type { SettlementStore } from "./store.js";
import {
  SETTLEMENT_INSTRUCTION_KINDS,
  SETTLEMENT_INSTRUCTION_STATUSES,
  type InstructionSignature,
  type InstructionSignerRole,
  type SettlementInstructionKind,
  type SettlementInstructionRecord,
  type SettlementInstructionStatus,
  type SettlementReceiptRecord
} from "./types.js";

export interface SqliteSettlementStoreOptions {
  readonly databaseUrl?: string;
  readonly database?: SqliteDatabase;
  readonly migrations?: {
    readonly autoRun?: boolean;
    readonly directory?: string;
  };
}

export class SqliteSettlementStore implements SettlementStore {
  readonly #database: SqliteDatabase;
  readonly #ownsDatabase: boolean;

  constructor(options: SqliteSettlementStoreOptions) {
    if (!options.database && !options.databaseUrl) {
      throw new Error("SqliteSettlementStore requires database or databaseUrl");
    }
    this.#database = options.database ?? openSqliteDatabase(options.databaseUrl!);
    this.#ownsDatabase = !options.database;
    if (options.migrations?.autoRun === true) {
      runSqliteMigrations({
        database: this.#database,
        ...(options.migrations.directory ? { migrationsDirectory: options.migrations.directory } : {})
      });
    }
  }

  close(): void {
    if (this.#ownsDatabase) {
      this.#database.close();
    }
  }

  async createInstruction(record: SettlementInstructionRecord): Promise<void> {
    runSqliteWrite(() => {
      this.#database
        .prepare(
          `INSERT INTO settlement_instruction (
             instruction_id, idempotency_key, chain_id, escrow_address, order_id, stage_key,
             plan_id, stage_id, tranche_id, kind, payer_amount, payee_amount, source_fact_id,
             payer, payee, verifier, uvp_executor_address, required_signers_json,
             instruction_ref, typed_data_hash, nonce, deadline, status,
             payer_signature, payer_signer, payee_signature, payee_signer,
             verifier_signature, verifier_signer, execute_eligible_at, blocked_by_dispute,
             tx_hash, block_number, error_code, attempts, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          record.instructionId,
          record.idempotencyKey,
          record.chainId,
          record.escrowAddress.toLowerCase(),
          record.orderId,
          record.stageKey,
          record.planId,
          record.stageId,
          record.trancheId,
          record.kind,
          record.payerAmount,
          record.payeeAmount,
          record.sourceFactId,
          record.payer ?? null,
          record.payee ?? null,
          record.verifier ?? null,
          record.uvpExecutorAddress?.toLowerCase() ?? null,
          JSON.stringify(record.requiredSigners),
          record.instructionRef,
          record.typedDataHash,
          record.nonce,
          record.deadline,
          record.status,
          signatureOf(record, "payer")?.signature ?? null,
          signatureOf(record, "payer")?.signer ?? null,
          signatureOf(record, "payee")?.signature ?? null,
          signatureOf(record, "payee")?.signer ?? null,
          signatureOf(record, "verifier")?.signature ?? null,
          signatureOf(record, "verifier")?.signer ?? null,
          record.executeEligibleAt ?? null,
          record.blockedByDispute === true ? 1 : 0,
          record.txHash ?? null,
          record.blockNumber ?? null,
          record.errorCode ?? null,
          record.attempts,
          record.createdAt,
          record.updatedAt
        );
    });
  }

  async getInstruction(instructionId: string): Promise<SettlementInstructionRecord | undefined> {
    const row = this.#database
      .prepare("SELECT * FROM settlement_instruction WHERE instruction_id = ?")
      .get(instructionId);
    return row ? instructionRow(row) : undefined;
  }

  async getInstructionByRef(instructionRef: string): Promise<SettlementInstructionRecord | undefined> {
    const row = this.#database
      .prepare("SELECT * FROM settlement_instruction WHERE instruction_ref = ?")
      .get(instructionRef.toLowerCase());
    return row ? instructionRow(row) : undefined;
  }

  async getInstructionByIdempotencyKey(key: string): Promise<SettlementInstructionRecord | undefined> {
    const row = this.#database
      .prepare("SELECT * FROM settlement_instruction WHERE idempotency_key = ?")
      .get(key);
    return row ? instructionRow(row) : undefined;
  }

  async listByStatus(
    status: SettlementInstructionStatus,
    limit: number
  ): Promise<readonly SettlementInstructionRecord[]> {
    return this.#database
      .prepare(
        `SELECT * FROM settlement_instruction
         WHERE status = ?
         ORDER BY created_at ASC
         LIMIT ?`
      )
      .all(status, limit)
      .map(instructionRow);
  }

  async listByOrder(orderId: string, limit: number): Promise<readonly SettlementInstructionRecord[]> {
    return this.#database
      .prepare(
        `SELECT * FROM settlement_instruction
         WHERE order_id = ?
         ORDER BY created_at ASC
         LIMIT ?`
      )
      .all(orderId.toLowerCase(), limit)
      .map(instructionRow);
  }

  async listByTranche(
    chainId: number,
    escrowAddress: Address,
    trancheId: string
  ): Promise<readonly SettlementInstructionRecord[]> {
    return this.#database
      .prepare(
        `SELECT * FROM settlement_instruction
         WHERE chain_id = ? AND escrow_address = ? AND tranche_id = ?
         ORDER BY created_at ASC`
      )
      .all(chainId, escrowAddress.toLowerCase(), trancheId.toLowerCase())
      .map(instructionRow);
  }

  async setSignature(input: {
    readonly instructionId: string;
    readonly role: InstructionSignerRole;
    readonly signature: Hex;
    readonly signer: Address;
    readonly nextStatus: SettlementInstructionStatus;
    readonly updatedAt: string;
  }): Promise<boolean> {
    const column = signatureColumn(input.role);
    return this.#cas(
      `UPDATE settlement_instruction
       SET ${column.signature} = ?, ${column.signer} = ?, status = ?, updated_at = ?
       WHERE instruction_id = ? AND ${column.signature} IS NULL
         AND status IN ('unsigned', 'partially_signed')`,
      [input.signature, input.signer, input.nextStatus, input.updatedAt, input.instructionId]
    );
  }

  async markBlockedByDispute(instructionId: string, updatedAt: string): Promise<boolean> {
    return this.#cas(
      `UPDATE settlement_instruction
       SET blocked_by_dispute = 1, updated_at = ?
       WHERE instruction_id = ? AND blocked_by_dispute = 0
         AND status NOT IN ('confirmed', 'failed')`,
      [updatedAt, instructionId]
    );
  }

  async markSubmittedFromReady(instructionId: string, attempts: number, updatedAt: string): Promise<boolean> {
    return this.#cas(
      `UPDATE settlement_instruction
       SET status = 'submitted', attempts = ?, updated_at = ?
       WHERE instruction_id = ? AND status IN ('ready', 'execute_ready') AND blocked_by_dispute = 0`,
      [attempts, updatedAt, instructionId]
    );
  }

  async setSubmittedTx(instructionId: string, txHash: Hex, updatedAt: string): Promise<boolean> {
    return this.#cas(
      `UPDATE settlement_instruction
       SET tx_hash = ?, updated_at = ?
       WHERE instruction_id = ? AND status = 'submitted'`,
      [txHash, updatedAt, instructionId]
    );
  }

  async markFailed(instructionId: string, errorCode: string, updatedAt: string): Promise<boolean> {
    return this.#terminal(instructionId, "failed", errorCode, updatedAt);
  }

  async markUnknown(instructionId: string, errorCode: string, updatedAt: string): Promise<boolean> {
    return this.#terminal(instructionId, "unknown", errorCode, updatedAt);
  }

  async markConfirmed(instructionId: string, receipt: SettlementReceiptRecord): Promise<boolean> {
    try {
      return await withSqliteTransaction(this.#database, async () => {
        const inserted = this.#database
          .prepare(
            `INSERT INTO settlement_receipt (
               receipt_id, instruction_id, chain_id, escrow_address, order_id, stage_id, tranche_id,
               payer_amount, payee_amount, fee_amount, instruction_ref, tx_hash, block_number, log_index, confirmed_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(chain_id, escrow_address, tx_hash, log_index) DO NOTHING`
          )
          .run(
            receipt.receiptId,
            receipt.instructionId,
            receipt.chainId,
            receipt.escrowAddress.toLowerCase(),
            receipt.orderId,
            receipt.stageId,
            receipt.trancheId,
            receipt.payerAmount,
            receipt.payeeAmount,
            receipt.feeAmount,
            receipt.instructionRef,
            receipt.txHash,
            receipt.blockNumber,
            receipt.logIndex,
            receipt.confirmedAt
          );
        if (inserted.changes === 0) {
          return false;
        }
        const updated = this.#cas(
          `UPDATE settlement_instruction
           SET status = 'confirmed', tx_hash = ?, block_number = ?, updated_at = ?
           WHERE instruction_id = ? AND status = 'submitted'`,
          [receipt.txHash, receipt.blockNumber, receipt.confirmedAt, instructionId]
        );
        if (!updated) {
          throw new Error("confirmed receipt inserted for an instruction that was not submitted");
        }
        return true;
      });
    } catch (error) {
      throw normalizeSqliteError(error);
    }
  }

  async getReceipt(instructionId: string): Promise<SettlementReceiptRecord | undefined> {
    const row = this.#database
      .prepare("SELECT * FROM settlement_receipt WHERE instruction_id = ?")
      .get(instructionId);
    return row ? receiptRow(row) : undefined;
  }

  #cas(sql: string, values: readonly (string | number | null)[]): boolean {
    return runSqliteWrite(() => {
      const result = this.#database.prepare(sql).run(...values);
      return result.changes === 1;
    });
  }

  #terminal(
    instructionId: string,
    status: "failed" | "unknown",
    errorCode: string,
    updatedAt: string
  ): boolean {
    return this.#cas(
      `UPDATE settlement_instruction
       SET status = ?, error_code = ?, updated_at = ?
       WHERE instruction_id = ?
         AND status NOT IN ('confirmed', 'failed', 'unknown')`,
      [status, errorCode, updatedAt, instructionId]
    );
  }
}

function signatureColumn(role: InstructionSignerRole): { readonly signature: string; readonly signer: string } {
  switch (role) {
    case "payer":
      return { signature: "payer_signature", signer: "payer_signer" };
    case "payee":
      return { signature: "payee_signature", signer: "payee_signer" };
    case "verifier":
      return { signature: "verifier_signature", signer: "verifier_signer" };
  }
}

function signatureOf(
  record: SettlementInstructionRecord,
  role: InstructionSignerRole
): InstructionSignature | undefined {
  return record.signatures.find((signature) => signature.role === role);
}

function instructionRow(value: unknown): SettlementInstructionRecord {
  const row = rowObject(value);
  const signatures: InstructionSignature[] = [];
  for (const role of ["payer", "payee", "verifier"] as const) {
    const columns = signatureColumn(role);
    const signature = optionalStringColumn(row, columns.signature);
    const signer = optionalStringColumn(row, columns.signer);
    if (signature !== undefined && signer !== undefined) {
      signatures.push({ role, signature: signature as Hex, signer: signer as Address });
    }
  }
  const txHash = optionalStringColumn(row, "tx_hash");
  const blockNumber = optionalStringColumn(row, "block_number");
  const errorCode = optionalStringColumn(row, "error_code");
  const payer = optionalStringColumn(row, "payer");
  const payee = optionalStringColumn(row, "payee");
  const verifier = optionalStringColumn(row, "verifier");
  const uvpExecutorAddress = optionalStringColumn(row, "uvp_executor_address");
  const executeEligibleAt = optionalStringColumn(row, "execute_eligible_at");
  return {
    instructionId: stringColumn(row, "instruction_id"),
    idempotencyKey: stringColumn(row, "idempotency_key"),
    chainId: numberColumn(row, "chain_id"),
    escrowAddress: stringColumn(row, "escrow_address") as Address,
    planId: stringColumn(row, "plan_id") as Hex,
    orderId: stringColumn(row, "order_id") as Hex,
    stageKey: stringColumn(row, "stage_key"),
    stageId: stringColumn(row, "stage_id") as Hex,
    trancheId: stringColumn(row, "tranche_id") as Hex,
    kind: instructionKind(stringColumn(row, "kind")),
    payerAmount: stringColumn(row, "payer_amount"),
    payeeAmount: stringColumn(row, "payee_amount"),
    sourceFactId: stringColumn(row, "source_fact_id") as Hex,
    ...(payer !== undefined ? { payer: payer as Address } : {}),
    ...(payee !== undefined ? { payee: payee as Address } : {}),
    ...(verifier !== undefined ? { verifier: verifier as Address } : {}),
    ...(uvpExecutorAddress !== undefined ? { uvpExecutorAddress: uvpExecutorAddress as Address } : {}),
    requiredSigners: JSON.parse(stringColumn(row, "required_signers_json")) as InstructionSignerRole[],
    signatures,
    instructionRef: stringColumn(row, "instruction_ref") as Hex,
    typedDataHash: stringColumn(row, "typed_data_hash") as Hex,
    nonce: stringColumn(row, "nonce"),
    deadline: stringColumn(row, "deadline"),
    status: instructionStatus(stringColumn(row, "status")),
    ...(executeEligibleAt !== undefined ? { executeEligibleAt } : {}),
    blockedByDispute: numberColumn(row, "blocked_by_dispute") === 1,
    ...(txHash !== undefined ? { txHash: txHash as Hex } : {}),
    ...(blockNumber !== undefined ? { blockNumber } : {}),
    ...(errorCode !== undefined ? { errorCode } : {}),
    attempts: numberColumn(row, "attempts"),
    createdAt: stringColumn(row, "created_at"),
    updatedAt: stringColumn(row, "updated_at")
  };
}

function receiptRow(value: unknown): SettlementReceiptRecord {
  const row = rowObject(value);
  return {
    receiptId: stringColumn(row, "receipt_id"),
    instructionId: stringColumn(row, "instruction_id"),
    chainId: numberColumn(row, "chain_id"),
    escrowAddress: stringColumn(row, "escrow_address") as Address,
    orderId: stringColumn(row, "order_id") as Hex,
    stageId: stringColumn(row, "stage_id") as Hex,
    trancheId: stringColumn(row, "tranche_id") as Hex,
    payerAmount: stringColumn(row, "payer_amount"),
    payeeAmount: stringColumn(row, "payee_amount"),
    feeAmount: stringColumn(row, "fee_amount"),
    instructionRef: stringColumn(row, "instruction_ref") as Hex,
    txHash: stringColumn(row, "tx_hash") as Hex,
    blockNumber: stringColumn(row, "block_number"),
    logIndex: numberColumn(row, "log_index"),
    confirmedAt: stringColumn(row, "confirmed_at")
  };
}

function instructionKind(value: string): SettlementInstructionKind {
  if (!(SETTLEMENT_INSTRUCTION_KINDS as readonly string[]).includes(value)) {
    throw new Error(`unknown settlement instruction kind in storage: ${value}`);
  }
  return value as SettlementInstructionKind;
}

function instructionStatus(value: string): SettlementInstructionStatus {
  if (!(SETTLEMENT_INSTRUCTION_STATUSES as readonly string[]).includes(value)) {
    throw new Error(`unknown settlement instruction status in storage: ${value}`);
  }
  return value as SettlementInstructionStatus;
}
