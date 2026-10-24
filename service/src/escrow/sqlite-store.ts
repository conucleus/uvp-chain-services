// SQLite persistence for the StageEscrow projection (migration
// 0031_escrow_tranches.sql). One row per (escrow_address, tranche_id); reads
// are scoped to the configured escrow address and ordered by stage id.

import { runSqliteMigrations } from "../storage/migrations.js";
import {
  numberColumn,
  optionalStringColumn,
  rowObject,
  stringColumn
} from "../storage/sqlite-rows.js";
import {
  openSqliteDatabase,
  runSqliteWrite,
  type SqliteDatabase
} from "../storage/sqlite.js";
import type { Address } from "../shared/types.js";
import type {
  EscrowProjectionStore,
  EscrowTrancheRecord,
  EscrowTrancheState
} from "./types.js";
import { ESCROW_TRANCHE_STATES } from "./types.js";

export interface SqliteEscrowStoreOptions {
  readonly databaseUrl?: string;
  readonly database?: SqliteDatabase;
  readonly migrations?: {
    readonly autoRun?: boolean;
    readonly directory?: string;
  };
}

export class SqliteEscrowStore implements EscrowProjectionStore {
  readonly #database: SqliteDatabase;
  readonly #ownsDatabase: boolean;

  constructor(options: SqliteEscrowStoreOptions) {
    if (!options.database && !options.databaseUrl) {
      throw new Error("SqliteEscrowStore requires database or databaseUrl");
    }
    this.#database = options.database ?? openSqliteDatabase(options.databaseUrl!);
    this.#ownsDatabase = !options.database;
    if (options.migrations?.autoRun === true) {
      runSqliteMigrations({
        database: this.#database,
        ...(options.migrations.directory
          ? { migrationsDirectory: options.migrations.directory }
          : {})
      });
    }
  }

  async close(): Promise<void> {
    if (this.#ownsDatabase) {
      this.#database.close();
    }
  }

  async listTranches(
    escrowAddress: Address,
    orderId: string
  ): Promise<readonly EscrowTrancheRecord[]> {
    return this.#database
      .prepare(
        `SELECT *
         FROM escrow_tranches
         WHERE escrow_address = ? AND order_id = ?
         ORDER BY stage_id ASC`
      )
      .all(escrowAddress.toLowerCase(), orderId.toLowerCase())
      .map((row) => trancheRow(row));
  }

  async getTranche(
    escrowAddress: Address,
    orderId: string,
    stageId: string
  ): Promise<EscrowTrancheRecord | undefined> {
    const row = this.#database
      .prepare(
        `SELECT *
         FROM escrow_tranches
         WHERE escrow_address = ? AND order_id = ? AND stage_id = ?`
      )
      .get(escrowAddress.toLowerCase(), orderId.toLowerCase(), stageId.toLowerCase());
    return row ? trancheRow(row) : undefined;
  }

  async getTrancheById(
    escrowAddress: Address,
    trancheId: string
  ): Promise<EscrowTrancheRecord | undefined> {
    const row = this.#database
      .prepare(
        `SELECT *
         FROM escrow_tranches
         WHERE escrow_address = ? AND tranche_id = ?`
      )
      .get(escrowAddress.toLowerCase(), trancheId.toLowerCase());
    return row ? trancheRow(row) : undefined;
  }

  async saveTranche(record: EscrowTrancheRecord): Promise<void> {
    runSqliteWrite(() => {
      this.#database
        .prepare(
          `INSERT INTO escrow_tranches (
             escrow_address, chain_id, tranche_id, order_id, stage_id,
             payer, payee, verifier, amount, observation_days, fee_bps,
             fee_recipient, state, approved_at, rejected_at, suspended_at,
             payer_amount, payee_amount, fee_amount, released_at, refunded_at,
             updated_at, block_number, log_index
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(escrow_address, tranche_id) DO UPDATE SET
             chain_id = excluded.chain_id,
             order_id = excluded.order_id,
             stage_id = excluded.stage_id,
             payer = excluded.payer,
             payee = excluded.payee,
             verifier = excluded.verifier,
             amount = excluded.amount,
             observation_days = excluded.observation_days,
             fee_bps = excluded.fee_bps,
             fee_recipient = excluded.fee_recipient,
             state = excluded.state,
             approved_at = excluded.approved_at,
             rejected_at = excluded.rejected_at,
             suspended_at = excluded.suspended_at,
             payer_amount = excluded.payer_amount,
             payee_amount = excluded.payee_amount,
             fee_amount = excluded.fee_amount,
             released_at = excluded.released_at,
             refunded_at = excluded.refunded_at,
             updated_at = excluded.updated_at,
             block_number = excluded.block_number,
             log_index = excluded.log_index`
        )
        .run(
          record.escrowAddress,
          record.chainId,
          record.trancheId,
          record.orderId,
          record.stageId,
          record.payer,
          record.payee,
          record.verifier,
          record.amount,
          record.observationDays,
          record.feeBps,
          record.feeRecipient,
          record.state,
          record.approvedAt ?? null,
          record.rejectedAt ?? null,
          record.suspendedAt ?? null,
          record.payerAmount ?? null,
          record.payeeAmount ?? null,
          record.feeAmount ?? null,
          record.releasedAt ?? null,
          record.refundedAt ?? null,
          record.updatedAt,
          record.blockNumber,
          record.logIndex
        );
    });
  }

  async clear(escrowAddress: Address): Promise<void> {
    runSqliteWrite(() => {
      this.#database
        .prepare("DELETE FROM escrow_tranches WHERE escrow_address = ?")
        .run(escrowAddress.toLowerCase());
    });
  }
}

function trancheRow(row: unknown): EscrowTrancheRecord {
  const record = rowObject(row, "escrow_tranches query");
  const state = stringColumn(record, "state");
  if (!isEscrowTrancheState(state)) {
    throw new Error(`escrow_tranches row has unknown state ${state}`);
  }
  return {
    escrowAddress: stringColumn(record, "escrow_address") as Address,
    chainId: numberColumn(record, "chain_id"),
    trancheId: stringColumn(record, "tranche_id") as `0x${string}`,
    orderId: stringColumn(record, "order_id") as `0x${string}`,
    stageId: stringColumn(record, "stage_id") as `0x${string}`,
    payer: stringColumn(record, "payer") as Address,
    payee: stringColumn(record, "payee") as Address,
    verifier: stringColumn(record, "verifier") as Address,
    amount: stringColumn(record, "amount"),
    observationDays: numberColumn(record, "observation_days"),
    feeBps: numberColumn(record, "fee_bps"),
    feeRecipient: stringColumn(record, "fee_recipient") as Address,
    state,
    ...optionalTrancheFields(record),
    updatedAt: stringColumn(record, "updated_at"),
    blockNumber: stringColumn(record, "block_number"),
    logIndex: numberColumn(record, "log_index")
  };
}

type OptionalTrancheFields = Partial<
  Pick<
    EscrowTrancheRecord,
    | "approvedAt"
    | "rejectedAt"
    | "suspendedAt"
    | "payerAmount"
    | "payeeAmount"
    | "feeAmount"
    | "releasedAt"
    | "refundedAt"
  >
>;

function optionalTrancheFields(
  record: Readonly<Record<string, unknown>>
): OptionalTrancheFields {
  const approvedAt = optionalStringColumn(record, "approved_at");
  const rejectedAt = optionalStringColumn(record, "rejected_at");
  const suspendedAt = optionalStringColumn(record, "suspended_at");
  const payerAmount = optionalStringColumn(record, "payer_amount");
  const payeeAmount = optionalStringColumn(record, "payee_amount");
  const feeAmount = optionalStringColumn(record, "fee_amount");
  const releasedAt = optionalStringColumn(record, "released_at");
  const refundedAt = optionalStringColumn(record, "refunded_at");
  return {
    ...(approvedAt !== undefined ? { approvedAt } : {}),
    ...(rejectedAt !== undefined ? { rejectedAt } : {}),
    ...(suspendedAt !== undefined ? { suspendedAt } : {}),
    ...(payerAmount !== undefined ? { payerAmount } : {}),
    ...(payeeAmount !== undefined ? { payeeAmount } : {}),
    ...(feeAmount !== undefined ? { feeAmount } : {}),
    ...(releasedAt !== undefined ? { releasedAt } : {}),
    ...(refundedAt !== undefined ? { refundedAt } : {})
  };
}

function isEscrowTrancheState(value: string): value is EscrowTrancheState {
  return (ESCROW_TRANCHE_STATES as readonly string[]).includes(value);
}
