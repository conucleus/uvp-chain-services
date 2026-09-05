import { parseStorageJson, stringifyStorageJson } from "../storage/json.js";
import { runSqliteMigrations } from "../storage/migrations.js";
import {
  openSqliteDatabase,
  runSqliteWrite,
  type SqliteDatabase
} from "../storage/sqlite.js";
import type { SubmissionBroadcastResult } from "./types.js";

/**
 * safe broadcast adapter 的去重状态（按 prepared idempotency key
 * 与 txHash 归属）持久化契约：重启后去重状态不得丢失，否则可能重复提交。
 * 语义与内存 Map 完全一致：键为 idempotencyKey / txHash。
 */
export interface BroadcastDedupeState {
  readonly attempts: number;
  readonly lastResult: SubmissionBroadcastResult;
}

export interface BroadcastDedupeStore {
  load(idempotencyKey: string): Promise<BroadcastDedupeState | undefined>;
  save(idempotencyKey: string, state: BroadcastDedupeState): Promise<void>;
  /** 返回该 txHash 的现有归属 idempotencyKey；无归属则记录并返回 undefined。 */
  claimTxHash(txHash: string, idempotencyKey: string): Promise<string | undefined>;
}

export interface SqliteBroadcastDedupeStoreOptions {
  readonly databaseUrl?: string;
  readonly database?: SqliteDatabase;
  readonly migrations?: {
    readonly autoRun?: boolean;
    readonly directory?: string;
  };
  readonly now?: () => Date;
}

export class SqliteBroadcastDedupeStore implements BroadcastDedupeStore {
  readonly #database: SqliteDatabase;
  readonly #ownsDatabase: boolean;
  readonly #now: () => Date;

  constructor(options: SqliteBroadcastDedupeStoreOptions) {
    const opened = openDedupeDatabase(options);
    this.#database = opened.database;
    this.#ownsDatabase = opened.ownsDatabase;
    this.#now = options.now ?? (() => new Date());
  }

  async close(): Promise<void> {
    if (this.#ownsDatabase) {
      this.#database.close();
    }
  }

  async load(idempotencyKey: string): Promise<BroadcastDedupeState | undefined> {
    const row = this.#database
      .prepare("SELECT attempts, last_result_json FROM broadcast_dedupe_state WHERE idempotency_key = ?")
      .get(idempotencyKey);
    if (!row || typeof row !== "object") {
      return undefined;
    }
    const record = row as Record<string, unknown>;
    if (typeof record.attempts !== "number" || typeof record.last_result_json !== "string") {
      return undefined;
    }
    return {
      attempts: record.attempts,
      lastResult: parseStorageJson<SubmissionBroadcastResult>(record.last_result_json)
    };
  }

  async save(idempotencyKey: string, state: BroadcastDedupeState): Promise<void> {
    runSqliteWrite(() => {
      this.#database
        .prepare(
          `INSERT INTO broadcast_dedupe_state (idempotency_key, attempts, last_result_json, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(idempotency_key) DO UPDATE SET
             attempts = excluded.attempts,
             last_result_json = excluded.last_result_json,
             updated_at = excluded.updated_at`
        )
        .run(idempotencyKey, state.attempts, stringifyStorageJson(state.lastResult), this.#now().toISOString());
    });
  }

  async claimTxHash(txHash: string, idempotencyKey: string): Promise<string | undefined> {
    const normalizedTxHash = txHash.toLowerCase();
    const existing = this.#database
      .prepare("SELECT idempotency_key FROM broadcast_dedupe_tx_owner WHERE tx_hash = ?")
      .get(normalizedTxHash);
    if (existing && typeof existing === "object" && typeof (existing as Record<string, unknown>).idempotency_key === "string") {
      return (existing as Record<string, unknown>).idempotency_key as string;
    }
    runSqliteWrite(() => {
      this.#database
        .prepare(
          `INSERT INTO broadcast_dedupe_tx_owner (tx_hash, idempotency_key, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(tx_hash) DO NOTHING`
        )
        .run(normalizedTxHash, idempotencyKey, this.#now().toISOString());
    });
    return undefined;
  }
}

function openDedupeDatabase(options: SqliteBroadcastDedupeStoreOptions): { readonly database: SqliteDatabase; readonly ownsDatabase: boolean } {
  if (options.database) {
    if (options.migrations?.autoRun === true) {
      runSqliteMigrations({
        database: options.database,
        ...(options.migrations.directory ? { migrationsDirectory: options.migrations.directory } : {})
      });
    }
    return { database: options.database, ownsDatabase: false };
  }
  if (!options.databaseUrl) {
    throw new Error("SqliteBroadcastDedupeStore requires databaseUrl or a shared SqliteDatabase");
  }
  const database = openSqliteDatabase(options.databaseUrl);
  if (options.migrations?.autoRun === true) {
    runSqliteMigrations({
      database,
      ...(options.migrations.directory ? { migrationsDirectory: options.migrations.directory } : {})
    });
  }
  return { database, ownsDatabase: true };
}
