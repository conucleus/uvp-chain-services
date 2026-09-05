import { runSqliteMigrations } from "../storage/migrations.js";
import {
  openSqliteDatabase,
  runSqliteWrite,
  type SqliteDatabase,
  type SqliteValue
} from "../storage/sqlite.js";
import {
  optionalStringColumn,
  rowObject,
  stringColumn
} from "../storage/sqlite-rows.js";
import type { Address } from "../shared/types.js";
import type {
  StoreAccountAddressRecord,
  StoreAuthChallengeRecord,
  StoreWalletSessionRecord,
  StoreWalletSessionStore
} from "./types.js";

export interface SqliteStoreWalletSessionStoreOptions {
  readonly databaseUrl?: string;
  readonly database?: SqliteDatabase;
  readonly migrations?: {
    readonly autoRun?: boolean;
    readonly directory?: string;
  };
}

export class SqliteStoreWalletSessionStore implements StoreWalletSessionStore {
  readonly #database: SqliteDatabase;
  readonly #ownsDatabase: boolean;

  constructor(options: SqliteStoreWalletSessionStoreOptions) {
    if (!options.database && !options.databaseUrl) {
      throw new Error("SqliteStoreWalletSessionStore requires database or databaseUrl");
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

  async putChallenge(record: StoreAuthChallengeRecord): Promise<void> {
    runSqliteWrite(() => {
      this.#database.prepare(
        `INSERT INTO store_auth_challenge (nonce, address, intent, account_id, message, issued_at, expires_at, consumed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(nonce) DO UPDATE SET
           consumed_at = excluded.consumed_at`
      ).run(...challengeValues(record));
    });
  }

  async getChallenge(nonce: string): Promise<StoreAuthChallengeRecord | undefined> {
    const row = this.#database.prepare(
      `SELECT * FROM store_auth_challenge WHERE nonce = ?`
    ).get(nonce);
    return row ? challengeRow(row) : undefined;
  }

  async listChallengesForAddress(address: Address): Promise<readonly StoreAuthChallengeRecord[]> {
    return this.#database.prepare(
      `SELECT * FROM store_auth_challenge WHERE address = ? ORDER BY issued_at DESC`
    ).all(address.toLowerCase()).map((row) => challengeRow(row));
  }

  async updateChallenge(record: StoreAuthChallengeRecord): Promise<void> {
    runSqliteWrite(() => {
      this.#database.prepare(
        `UPDATE store_auth_challenge
         SET consumed_at = ?
         WHERE nonce = ?`
      ).run(
        record.consumedAt ?? null,
        record.nonce
      );
    });
  }

  async consumeChallenge(nonce: string, consumedAt: string): Promise<StoreAuthChallengeRecord | undefined> {
    // 条件 UPDATE 原子占位——
    // WHERE consumed_at IS NULL 保证并发重放同一 nonce 只有一个赢家。
    const updated = runSqliteWrite(() =>
      this.#database.prepare(
        `UPDATE store_auth_challenge
         SET consumed_at = ?
         WHERE nonce = ? AND consumed_at IS NULL`
      ).run(consumedAt, nonce)
    );
    if (updated.changes !== 1) {
      return undefined;
    }
    return this.getChallenge(nonce);
  }

  async putSession(record: StoreWalletSessionRecord): Promise<void> {
    runSqliteWrite(() => {
      this.#database.prepare(
        `INSERT INTO store_wallet_session (session_id, token_hash, account_id, anchored_address, created_at, expires_at, last_seen_at, revoked_at, revoked_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           last_seen_at = excluded.last_seen_at,
           revoked_at = excluded.revoked_at,
           revoked_reason = excluded.revoked_reason`
      ).run(...sessionValues(record));
    });
  }

  async findSessionByTokenHash(tokenHash: string): Promise<StoreWalletSessionRecord | undefined> {
    const row = this.#database.prepare(
      `SELECT * FROM store_wallet_session WHERE token_hash = ?`
    ).get(tokenHash);
    return row ? sessionRow(row) : undefined;
  }

  async updateSession(record: StoreWalletSessionRecord): Promise<void> {
    await this.putSession(record);
  }

  async putAccountAddress(record: StoreAccountAddressRecord): Promise<void> {
    runSqliteWrite(() => {
      this.#database.prepare(
        `INSERT INTO store_account_address (address, account_id, status, anchored_at, anchor_session_id, revoked_at, revoked_by_session_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(address) DO UPDATE SET
           account_id = excluded.account_id,
           status = excluded.status,
           anchored_at = excluded.anchored_at,
           anchor_session_id = excluded.anchor_session_id,
           revoked_at = excluded.revoked_at,
           revoked_by_session_id = excluded.revoked_by_session_id`
      ).run(
        record.address.toLowerCase(),
        record.accountId,
        record.status,
        record.anchoredAt,
        record.anchorSessionId ?? null,
        record.revokedAt ?? null,
        record.revokedBySessionId ?? null
      );
    });
  }

  async listAccountAddresses(accountId: string): Promise<readonly StoreAccountAddressRecord[]> {
    return this.#database.prepare(
      `SELECT * FROM store_account_address WHERE account_id = ? ORDER BY anchored_at ASC, address ASC`
    ).all(accountId).map((row) => accountAddressRow(row));
  }

  async findActiveAccountAddress(address: Address): Promise<StoreAccountAddressRecord | undefined> {
    const row = this.#database.prepare(
      `SELECT * FROM store_account_address WHERE address = ? AND status = 'active'`
    ).get(address.toLowerCase());
    return row ? accountAddressRow(row) : undefined;
  }

  async listAccountIds(): Promise<readonly string[]> {
    return this.#database.prepare(
      `SELECT DISTINCT account_id FROM store_account_address ORDER BY account_id ASC`
    ).all().map((row) => stringColumn(rowObject(row), "account_id"));
  }
}

function challengeValues(record: StoreAuthChallengeRecord): readonly SqliteValue[] {
  return [
    record.nonce,
    record.address.toLowerCase(),
    record.intent,
    record.accountId ?? null,
    record.message,
    record.issuedAt,
    record.expiresAt,
    record.consumedAt ?? null
  ];
}

function challengeRow(row: unknown): StoreAuthChallengeRecord {
  const record = rowObject(row);
  return {
    nonce: stringColumn(record, "nonce"),
    address: stringColumn(record, "address") as Address,
    intent: stringColumn(record, "intent") === "anchor_address" ? "anchor_address" : "login",
    ...(optionalStringColumn(record, "account_id") ? { accountId: optionalStringColumn(record, "account_id")! } : {}),
    message: stringColumn(record, "message"),
    issuedAt: stringColumn(record, "issued_at"),
    expiresAt: stringColumn(record, "expires_at"),
    ...(optionalStringColumn(record, "consumed_at") ? { consumedAt: optionalStringColumn(record, "consumed_at")! } : {})
  };
}

function sessionValues(record: StoreWalletSessionRecord): readonly SqliteValue[] {
  return [
    record.sessionId,
    record.tokenHash,
    record.accountId,
    record.anchoredAddress.toLowerCase(),
    record.createdAt,
    record.expiresAt,
    record.lastSeenAt ?? null,
    record.revokedAt ?? null,
    record.revokedReason ?? null
  ];
}

function sessionRow(row: unknown): StoreWalletSessionRecord {
  const record = rowObject(row);
  return {
    sessionId: stringColumn(record, "session_id"),
    tokenHash: stringColumn(record, "token_hash"),
    accountId: stringColumn(record, "account_id"),
    anchoredAddress: stringColumn(record, "anchored_address") as Address,
    createdAt: stringColumn(record, "created_at"),
    expiresAt: stringColumn(record, "expires_at"),
    ...(optionalStringColumn(record, "last_seen_at") ? { lastSeenAt: optionalStringColumn(record, "last_seen_at")! } : {}),
    ...(optionalStringColumn(record, "revoked_at") ? { revokedAt: optionalStringColumn(record, "revoked_at")! } : {}),
    ...(optionalStringColumn(record, "revoked_reason") ? { revokedReason: optionalStringColumn(record, "revoked_reason")! } : {})
  };
}

function accountAddressRow(row: unknown): StoreAccountAddressRecord {
  const record = rowObject(row);
  return {
    accountId: stringColumn(record, "account_id"),
    address: stringColumn(record, "address") as Address,
    status: stringColumn(record, "status") === "revoked" ? "revoked" : "active",
    anchoredAt: stringColumn(record, "anchored_at"),
    ...(optionalStringColumn(record, "anchor_session_id") ? { anchorSessionId: optionalStringColumn(record, "anchor_session_id")! } : {}),
    ...(optionalStringColumn(record, "revoked_at") ? { revokedAt: optionalStringColumn(record, "revoked_at")! } : {}),
    ...(optionalStringColumn(record, "revoked_by_session_id") ? { revokedBySessionId: optionalStringColumn(record, "revoked_by_session_id")! } : {})
  };
}
