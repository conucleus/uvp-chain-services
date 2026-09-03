import { parseStorageJson, stringifyStorageJson } from "../storage/json.js";
import { PostgresDatabase } from "../storage/postgres-client.js";
import { rowObject } from "../storage/postgres-rows.js";
import type { BroadcastDedupeState, BroadcastDedupeStore } from "./broadcast-dedupe-sqlite-store.js";
import type { SubmissionBroadcastResult } from "./types.js";

export type { BroadcastDedupeState, BroadcastDedupeStore } from "./broadcast-dedupe-sqlite-store.js";

export interface PostgresBroadcastDedupeStoreOptions {
  readonly databaseUrl?: string;
  readonly database?: PostgresDatabase;
  readonly migrations?: {
    readonly autoRun?: boolean;
    readonly directory?: string;
  };
  readonly now?: () => Date;
}

export class PostgresBroadcastDedupeStore implements BroadcastDedupeStore {
  readonly #database: PostgresDatabase;
  readonly #ownsDatabase: boolean;
  readonly #now: () => Date;

  constructor(options: PostgresBroadcastDedupeStoreOptions) {
    if (!options.database && !options.databaseUrl) {
      throw new Error("PostgresBroadcastDedupeStore requires database or databaseUrl");
    }
    this.#database = options.database ?? new PostgresDatabase({
      databaseUrl: options.databaseUrl!,
      ...(options.migrations ? { migrations: options.migrations } : {})
    });
    this.#ownsDatabase = !options.database;
    this.#now = options.now ?? (() => new Date());
  }

  async close(): Promise<void> {
    if (this.#ownsDatabase) {
      await this.#database.close();
    }
  }

  async load(idempotencyKey: string): Promise<BroadcastDedupeState | undefined> {
    const result = await this.#database.query(
      "SELECT attempts, last_result_json FROM broadcast_dedupe_state WHERE idempotency_key = $1",
      [idempotencyKey]
    );
    const row = result.rows[0];
    if (!row) {
      return undefined;
    }
    const record = rowObject(row);
    const attempts = record.attempts;
    const lastResultJson = record.last_result_json;
    if (typeof attempts !== "number" || typeof lastResultJson !== "string") {
      return undefined;
    }
    return {
      attempts,
      lastResult: parseStorageJson<SubmissionBroadcastResult>(lastResultJson)
    };
  }

  async save(idempotencyKey: string, state: BroadcastDedupeState): Promise<void> {
    await this.#database.query(
      `INSERT INTO broadcast_dedupe_state (idempotency_key, attempts, last_result_json, updated_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT(idempotency_key) DO UPDATE SET
         attempts = excluded.attempts,
         last_result_json = excluded.last_result_json,
         updated_at = excluded.updated_at`,
      [idempotencyKey, state.attempts, stringifyStorageJson(state.lastResult), this.#now().toISOString()]
    );
  }

  async claimTxHash(txHash: string, idempotencyKey: string): Promise<string | undefined> {
    const normalizedTxHash = txHash.toLowerCase();
    const existing = await this.#database.query(
      "SELECT idempotency_key FROM broadcast_dedupe_tx_owner WHERE tx_hash = $1",
      [normalizedTxHash]
    );
    const existingRow = existing.rows[0];
    if (existingRow) {
      const owner = rowObject(existingRow).idempotency_key;
      if (typeof owner === "string") {
        return owner;
      }
    }
    await this.#database.query(
      `INSERT INTO broadcast_dedupe_tx_owner (tx_hash, idempotency_key, updated_at)
       VALUES ($1, $2, $3)
       ON CONFLICT(tx_hash) DO NOTHING`,
      [normalizedTxHash, idempotencyKey, this.#now().toISOString()]
    );
    return undefined;
  }
}
