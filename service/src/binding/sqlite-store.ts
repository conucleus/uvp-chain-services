// SQLite persistence for V3 binding rows (migration
// 0033_binding_settlement_runtime.sql). Same semantics as MemoryBindingStore:
// one cursor/anomaly stream per escrow instance, unique tranche/stage bindings,
// one active intent per stage, and re-projectable rows cleared on rebuild.

import { runSqliteMigrations } from "../storage/migrations.js";
import {
  numberColumn,
  optionalNumberColumn,
  optionalStringColumn,
  rowObject,
  stringColumn
} from "../storage/sqlite-rows.js";
import { openSqliteDatabase, runSqliteWrite, withSqliteTransaction, type SqliteDatabase } from "../storage/sqlite.js";
import type { Address, Hex } from "../shared/types.js";
import type { BindingStore } from "./store.js";
import {
  TRANCHE_BINDING_STATES,
  DEPOSIT_INTENT_STATUSES,
  type BindingEventAnomaly,
  type BindingIndexCursor,
  type DepositIntentRecord,
  type DepositIntentStatus,
  type DepositTypedData,
  type EscrowInstanceRecord,
  type TrancheBindingRecord,
  type TrancheBindingState
} from "./types.js";

export interface SqliteBindingStoreOptions {
  readonly databaseUrl?: string;
  readonly database?: SqliteDatabase;
  readonly migrations?: {
    readonly autoRun?: boolean;
    readonly directory?: string;
  };
}

export class SqliteBindingStore implements BindingStore {
  readonly #database: SqliteDatabase;
  readonly #ownsDatabase: boolean;

  constructor(options: SqliteBindingStoreOptions) {
    if (!options.database && !options.databaseUrl) {
      throw new Error("SqliteBindingStore requires database or databaseUrl");
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

  async saveEscrowInstance(record: EscrowInstanceRecord): Promise<void> {
    runSqliteWrite(() => {
      this.#database
        .prepare(
          `INSERT INTO escrow_instance (
             chain_id, escrow_address, token_address, contract_version, uvp_address,
             uvp_executor_address, deployment_block, start_block, status, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(chain_id, escrow_address) DO UPDATE SET
             token_address = excluded.token_address,
             contract_version = excluded.contract_version,
             uvp_address = excluded.uvp_address,
             uvp_executor_address = excluded.uvp_executor_address,
             deployment_block = excluded.deployment_block,
             start_block = excluded.start_block,
             status = excluded.status,
             updated_at = excluded.updated_at`
        )
        .run(
          record.chainId,
          record.escrowAddress.toLowerCase(),
          record.tokenAddress?.toLowerCase() ?? null,
          record.contractVersion,
          record.uvpAddress?.toLowerCase() ?? null,
          record.uvpExecutorAddress?.toLowerCase() ?? null,
          record.deploymentBlock ?? null,
          record.startBlock,
          record.status,
          record.createdAt,
          record.updatedAt
        );
    });
  }

  async getEscrowInstance(chainId: number, escrowAddress: Address): Promise<EscrowInstanceRecord | undefined> {
    const row = this.#database
      .prepare("SELECT * FROM escrow_instance WHERE chain_id = ? AND escrow_address = ?")
      .get(chainId, escrowAddress.toLowerCase());
    return row ? escrowInstanceRow(row) : undefined;
  }

  async listEscrowInstances(): Promise<readonly EscrowInstanceRecord[]> {
    return this.#database
      .prepare("SELECT * FROM escrow_instance ORDER BY chain_id, escrow_address")
      .all()
      .map(escrowInstanceRow);
  }

  async saveDepositIntent(record: DepositIntentRecord): Promise<void> {
    runSqliteWrite(() => {
      this.#database
        .prepare(
          `INSERT INTO binding_deposit_intent (
             intent_id, chain_id, escrow_address, order_id, stage_key, stage_id, tranche_id,
             payer, payee, verifier, amount, fee_bps, fee_recipient, terms_hash, nonce, deadline,
             status, idempotency_key, typed_data_json, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          record.intentId,
          record.chainId,
          record.escrowAddress.toLowerCase(),
          record.orderId,
          record.stageKey,
          record.stageId,
          record.trancheId,
          record.payer,
          record.payee,
          record.verifier ?? null,
          record.amount,
          record.feeBps,
          record.feeRecipient,
          record.termsHash,
          record.nonce,
          record.deadline,
          record.status,
          record.idempotencyKey,
          JSON.stringify(record.typedData),
          record.createdAt,
          record.updatedAt
        );
    });
  }

  async updateDepositIntent(record: DepositIntentRecord): Promise<void> {
    runSqliteWrite(() => {
      this.#database
        .prepare(
          `UPDATE binding_deposit_intent
           SET status = ?, typed_data_json = ?, updated_at = ?
           WHERE intent_id = ?`
        )
        .run(record.status, JSON.stringify(record.typedData), record.updatedAt, record.intentId);
    });
  }

  async getDepositIntent(intentId: string): Promise<DepositIntentRecord | undefined> {
    const row = this.#database
      .prepare("SELECT * FROM binding_deposit_intent WHERE intent_id = ?")
      .get(intentId);
    return row ? depositIntentRow(row) : undefined;
  }

  async findDepositIntentByStage(
    chainId: number,
    escrowAddress: Address,
    orderId: string,
    stageId: string,
    statuses?: readonly DepositIntentStatus[]
  ): Promise<DepositIntentRecord | undefined> {
    const rows = this.#database
      .prepare(
        `SELECT * FROM binding_deposit_intent
         WHERE chain_id = ? AND escrow_address = ? AND order_id = ? AND stage_id = ?
         ORDER BY created_at DESC`
      )
      .all(chainId, escrowAddress.toLowerCase(), orderId.toLowerCase(), stageId.toLowerCase());
    const wanted = statuses ? new Set(statuses) : undefined;
    for (const row of rows) {
      const intent = depositIntentRow(row);
      if (wanted === undefined || wanted.has(intent.status)) {
        return intent;
      }
    }
    return undefined;
  }

  async findDepositIntentByIdempotencyKey(key: string): Promise<DepositIntentRecord | undefined> {
    const row = this.#database
      .prepare("SELECT * FROM binding_deposit_intent WHERE idempotency_key = ?")
      .get(key);
    return row ? depositIntentRow(row) : undefined;
  }

  async saveTrancheBinding(record: TrancheBindingRecord): Promise<void> {
    runSqliteWrite(() => {
      this.#database
        .prepare(
          `INSERT INTO tranche_binding (
             binding_id, chain_id, escrow_address, order_id, stage_key, stage_id, tranche_id,
             payer, payee, verifier, amount, fee_bps, fee_recipient, state, origin, terms_hash,
             deposit_tx_hash, deposit_block, deposit_log_index, payer_amount, payee_amount,
             fee_amount, settled_tx_hash, settled_block, instruction_ref, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(binding_id) DO UPDATE SET
             state = excluded.state,
             origin = excluded.origin,
             terms_hash = excluded.terms_hash,
             deposit_tx_hash = excluded.deposit_tx_hash,
             deposit_block = excluded.deposit_block,
             deposit_log_index = excluded.deposit_log_index,
             payer_amount = excluded.payer_amount,
             payee_amount = excluded.payee_amount,
             fee_amount = excluded.fee_amount,
             settled_tx_hash = excluded.settled_tx_hash,
             settled_block = excluded.settled_block,
             instruction_ref = excluded.instruction_ref,
             updated_at = excluded.updated_at`
        )
        .run(
          record.bindingId,
          record.chainId,
          record.escrowAddress.toLowerCase(),
          record.orderId,
          record.stageKey,
          record.stageId,
          record.trancheId,
          record.payer,
          record.payee,
          record.verifier ?? null,
          record.amount,
          record.feeBps,
          record.feeRecipient,
          record.state,
          record.origin,
          record.termsHash ?? null,
          record.depositTxHash ?? null,
          record.depositBlock ?? null,
          record.depositLogIndex ?? null,
          record.payerAmount ?? null,
          record.payeeAmount ?? null,
          record.feeAmount ?? null,
          record.settledTxHash ?? null,
          record.settledBlock ?? null,
          record.instructionRef ?? null,
          record.createdAt,
          record.updatedAt
        );
    });
  }

  async getTrancheBinding(
    chainId: number,
    escrowAddress: Address,
    trancheId: string
  ): Promise<TrancheBindingRecord | undefined> {
    const row = this.#database
      .prepare("SELECT * FROM tranche_binding WHERE chain_id = ? AND escrow_address = ? AND tranche_id = ?")
      .get(chainId, escrowAddress.toLowerCase(), trancheId.toLowerCase());
    return row ? trancheBindingRow(row) : undefined;
  }

  async getTrancheBindingByStage(
    chainId: number,
    escrowAddress: Address,
    orderId: string,
    stageId: string,
    payer: string
  ): Promise<TrancheBindingRecord | undefined> {
    const row = this.#database
      .prepare(
        `SELECT * FROM tranche_binding
         WHERE chain_id = ? AND escrow_address = ? AND order_id = ? AND stage_id = ? AND payer = ?`
      )
      .get(
        chainId,
        escrowAddress.toLowerCase(),
        orderId.toLowerCase(),
        stageId.toLowerCase(),
        payer.toLowerCase()
      );
    return row ? trancheBindingRow(row) : undefined;
  }

  async findCanonicalBindingByStage(
    chainId: number,
    escrowAddress: Address,
    orderId: string,
    stageId: string
  ): Promise<TrancheBindingRecord | undefined> {
    const row = this.#database
      .prepare(
        `SELECT * FROM tranche_binding
         WHERE chain_id = ? AND escrow_address = ? AND order_id = ? AND stage_id = ?
           AND state <> 'foreign'
         ORDER BY updated_at DESC
         LIMIT 1`
      )
      .get(chainId, escrowAddress.toLowerCase(), orderId.toLowerCase(), stageId.toLowerCase());
    return row ? trancheBindingRow(row) : undefined;
  }

  async listTrancheBindingsByOrder(orderId: string): Promise<readonly TrancheBindingRecord[]> {
    return this.#database
      .prepare("SELECT * FROM tranche_binding WHERE order_id = ? ORDER BY stage_id ASC")
      .all(orderId.toLowerCase())
      .map(trancheBindingRow);
  }

  async listTrancheBindings(chainId: number, escrowAddress: Address): Promise<readonly TrancheBindingRecord[]> {
    return this.#database
      .prepare("SELECT * FROM tranche_binding WHERE chain_id = ? AND escrow_address = ? ORDER BY stage_id ASC")
      .all(chainId, escrowAddress.toLowerCase())
      .map(trancheBindingRow);
  }

  async recordAnomaly(record: BindingEventAnomaly): Promise<void> {
    runSqliteWrite(() => {
      this.#database
        .prepare(
          `INSERT INTO binding_event_anomaly (
             anomaly_id, chain_id, escrow_address, block_number, log_index, tx_hash, reason, details_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(chain_id, escrow_address, block_number, log_index, reason) DO NOTHING`
        )
        .run(
          record.anomalyId,
          record.chainId,
          record.escrowAddress.toLowerCase(),
          record.blockNumber,
          record.logIndex,
          record.txHash,
          record.reason,
          record.details === undefined ? null : JSON.stringify(record.details),
          record.createdAt
        );
    });
  }

  async listAnomalies(chainId: number, escrowAddress: Address): Promise<readonly BindingEventAnomaly[]> {
    return this.#database
      .prepare(
        `SELECT * FROM binding_event_anomaly
         WHERE chain_id = ? AND escrow_address = ?
         ORDER BY block_number ASC, log_index ASC`
      )
      .all(chainId, escrowAddress.toLowerCase())
      .map(anomalyRow);
  }

  async getCursor(chainId: number, escrowAddress: Address): Promise<BindingIndexCursor | undefined> {
    const row = this.#database
      .prepare("SELECT * FROM binding_index_cursor WHERE chain_id = ? AND escrow_address = ?")
      .get(chainId, escrowAddress.toLowerCase());
    return row ? cursorRow(row) : undefined;
  }

  async saveCursor(cursor: BindingIndexCursor): Promise<void> {
    runSqliteWrite(() => {
      this.#database
        .prepare(
          `INSERT INTO binding_index_cursor (
             chain_id, escrow_address, start_block, next_block, last_block, last_block_hash, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(chain_id, escrow_address) DO UPDATE SET
             start_block = excluded.start_block,
             next_block = excluded.next_block,
             last_block = excluded.last_block,
             last_block_hash = excluded.last_block_hash,
             updated_at = excluded.updated_at`
        )
        .run(
          cursor.chainId,
          cursor.escrowAddress.toLowerCase(),
          cursor.startBlock,
          cursor.nextBlock,
          cursor.lastBlock ?? null,
          cursor.lastBlockHash ?? null,
          cursor.updatedAt
        );
    });
  }

  async resetProjection(chainId: number, escrowAddress: Address): Promise<void> {
    await withSqliteTransaction(this.#database, async () => {
      const address = escrowAddress.toLowerCase();
      this.#database.prepare("DELETE FROM tranche_binding WHERE chain_id = ? AND escrow_address = ?").run(chainId, address);
      this.#database.prepare("DELETE FROM binding_event_anomaly WHERE chain_id = ? AND escrow_address = ?").run(chainId, address);
      this.#database
        .prepare(
          `UPDATE binding_deposit_intent SET status = 'active'
           WHERE chain_id = ? AND escrow_address = ? AND status IN ('deposited', 'submitted')`
        )
        .run(chainId, address);
    });
  }
}

function escrowInstanceRow(value: unknown): EscrowInstanceRecord {
  const row = rowObject(value);
  const tokenAddress = optionalStringColumn(row, "token_address");
  const uvpAddress = optionalStringColumn(row, "uvp_address");
  const uvpExecutorAddress = optionalStringColumn(row, "uvp_executor_address");
  const deploymentBlock = optionalStringColumn(row, "deployment_block");
  return {
    chainId: numberColumn(row, "chain_id"),
    escrowAddress: stringColumn(row, "escrow_address") as Address,
    ...(tokenAddress !== undefined ? { tokenAddress: tokenAddress as Address } : {}),
    contractVersion: "v3",
    ...(uvpAddress !== undefined ? { uvpAddress: uvpAddress as Address } : {}),
    ...(uvpExecutorAddress !== undefined
      ? { uvpExecutorAddress: uvpExecutorAddress as Address }
      : {}),
    ...(deploymentBlock !== undefined ? { deploymentBlock } : {}),
    startBlock: stringColumn(row, "start_block"),
    status: stringColumn(row, "status") === "disabled" ? "disabled" : "active",
    createdAt: stringColumn(row, "created_at"),
    updatedAt: stringColumn(row, "updated_at")
  };
}

function depositIntentRow(value: unknown): DepositIntentRecord {
  const row = rowObject(value);
  return {
    intentId: stringColumn(row, "intent_id"),
    chainId: numberColumn(row, "chain_id"),
    escrowAddress: stringColumn(row, "escrow_address") as Address,
    orderId: stringColumn(row, "order_id") as Hex,
    stageKey: stringColumn(row, "stage_key"),
    stageId: stringColumn(row, "stage_id") as Hex,
    trancheId: stringColumn(row, "tranche_id") as Hex,
    payer: stringColumn(row, "payer") as Address,
    payee: stringColumn(row, "payee") as Address,
    verifier: stringColumn(row, "verifier") as Address,
    amount: stringColumn(row, "amount"),
    feeBps: numberColumn(row, "fee_bps"),
    feeRecipient: stringColumn(row, "fee_recipient") as Address,
    termsHash: stringColumn(row, "terms_hash") as Hex,
    nonce: stringColumn(row, "nonce"),
    deadline: stringColumn(row, "deadline"),
    status: depositIntentStatus(stringColumn(row, "status")),
    idempotencyKey: stringColumn(row, "idempotency_key"),
    typedData: JSON.parse(stringColumn(row, "typed_data_json")) as DepositTypedData,
    createdAt: stringColumn(row, "created_at"),
    updatedAt: stringColumn(row, "updated_at")
  };
}

function trancheBindingRow(value: unknown): TrancheBindingRecord {
  const row = rowObject(value);
  const termsHash = optionalStringColumn(row, "terms_hash");
  const depositTxHash = optionalStringColumn(row, "deposit_tx_hash");
  const depositBlock = optionalStringColumn(row, "deposit_block");
  const depositLogIndex = optionalNumberColumn(row, "deposit_log_index");
  const payerAmount = optionalStringColumn(row, "payer_amount");
  const payeeAmount = optionalStringColumn(row, "payee_amount");
  const feeAmount = optionalStringColumn(row, "fee_amount");
  const settledTxHash = optionalStringColumn(row, "settled_tx_hash");
  const settledBlock = optionalStringColumn(row, "settled_block");
  const instructionRef = optionalStringColumn(row, "instruction_ref");
  return {
    bindingId: stringColumn(row, "binding_id"),
    chainId: numberColumn(row, "chain_id"),
    escrowAddress: stringColumn(row, "escrow_address") as Address,
    orderId: stringColumn(row, "order_id") as Hex,
    stageKey: stringColumn(row, "stage_key"),
    stageId: stringColumn(row, "stage_id") as Hex,
    trancheId: stringColumn(row, "tranche_id") as Hex,
    payer: stringColumn(row, "payer") as Address,
    payee: stringColumn(row, "payee") as Address,
    ...(optionalStringColumn(row, "verifier") !== undefined
      ? { verifier: optionalStringColumn(row, "verifier") as Address }
      : {}),
    amount: stringColumn(row, "amount"),
    feeBps: numberColumn(row, "fee_bps"),
    feeRecipient: stringColumn(row, "fee_recipient") as Address,
    state: trancheBindingState(stringColumn(row, "state")),
    origin: stringColumn(row, "origin") === "event_only" ? "event_only" : "intent",
    ...(termsHash !== undefined ? { termsHash: termsHash as Hex } : {}),
    ...(depositTxHash !== undefined ? { depositTxHash: depositTxHash as Hex } : {}),
    ...(depositBlock !== undefined ? { depositBlock } : {}),
    ...(depositLogIndex !== undefined ? { depositLogIndex } : {}),
    ...(payerAmount !== undefined ? { payerAmount } : {}),
    ...(payeeAmount !== undefined ? { payeeAmount } : {}),
    ...(feeAmount !== undefined ? { feeAmount } : {}),
    ...(settledTxHash !== undefined ? { settledTxHash: settledTxHash as Hex } : {}),
    ...(settledBlock !== undefined ? { settledBlock } : {}),
    ...(instructionRef !== undefined ? { instructionRef: instructionRef as Hex } : {}),
    createdAt: stringColumn(row, "created_at"),
    updatedAt: stringColumn(row, "updated_at")
  };
}

function anomalyRow(value: unknown): BindingEventAnomaly {
  const row = rowObject(value);
  const details = optionalStringColumn(row, "details_json");
  return {
    anomalyId: stringColumn(row, "anomaly_id"),
    chainId: numberColumn(row, "chain_id"),
    escrowAddress: stringColumn(row, "escrow_address") as Address,
    blockNumber: stringColumn(row, "block_number"),
    logIndex: numberColumn(row, "log_index"),
    txHash: stringColumn(row, "tx_hash") as Hex,
    reason: stringColumn(row, "reason") as BindingEventAnomaly["reason"],
    ...(details !== undefined ? { details: JSON.parse(details) as unknown } : {}),
    createdAt: stringColumn(row, "created_at")
  };
}

function cursorRow(value: unknown): BindingIndexCursor {
  const row = rowObject(value);
  const lastBlock = optionalStringColumn(row, "last_block");
  const lastBlockHash = optionalStringColumn(row, "last_block_hash");
  return {
    chainId: numberColumn(row, "chain_id"),
    escrowAddress: stringColumn(row, "escrow_address") as Address,
    startBlock: stringColumn(row, "start_block"),
    nextBlock: stringColumn(row, "next_block"),
    ...(lastBlock !== undefined ? { lastBlock } : {}),
    ...(lastBlockHash !== undefined ? { lastBlockHash: lastBlockHash as Hex } : {}),
    updatedAt: stringColumn(row, "updated_at")
  };
}

function trancheBindingState(value: string): TrancheBindingState {
  if (!(TRANCHE_BINDING_STATES as readonly string[]).includes(value)) {
    throw new Error(`unknown tranche binding state in storage: ${value}`);
  }
  return value as TrancheBindingState;
}

function depositIntentStatus(value: string): DepositIntentStatus {
  if (!(DEPOSIT_INTENT_STATUSES as readonly string[]).includes(value)) {
    throw new Error(`unknown deposit intent status in storage: ${value}`);
  }
  return value as DepositIntentStatus;
}
