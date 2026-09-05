import type { Address } from "../shared/types.js";
import type { PostgresDatabase } from "../storage/postgres-client.js";
import type {
  StoreAccountAddressRecord,
  StoreAuthChallengeRecord,
  StoreWalletSessionRecord,
  StoreWalletSessionStore
} from "./types.js";

/** 钱包会话的 postgres 持久化（生产拓扑）。 */
export class PostgresStoreWalletSessionStore implements StoreWalletSessionStore {
  readonly #database: PostgresDatabase;

  constructor(options: { readonly database: PostgresDatabase }) {
    this.#database = options.database;
  }

  async putChallenge(record: StoreAuthChallengeRecord): Promise<void> {
    await this.#database.query(
      `INSERT INTO store_auth_challenge (nonce, address, intent, account_id, message, issued_at, expires_at, consumed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (nonce) DO UPDATE SET consumed_at = EXCLUDED.consumed_at`,
      [record.nonce, record.address.toLowerCase(), record.intent, record.accountId ?? null, record.message, record.issuedAt, record.expiresAt, record.consumedAt ?? null]
    );
  }

  async getChallenge(nonce: string): Promise<StoreAuthChallengeRecord | undefined> {
    const result = await this.#database.query(`SELECT * FROM store_auth_challenge WHERE nonce = $1`, [nonce]);
    return result.rows[0] ? challengeRow(result.rows[0]) : undefined;
  }

  async listChallengesForAddress(address: Address): Promise<readonly StoreAuthChallengeRecord[]> {
    const result = await this.#database.query(
      `SELECT * FROM store_auth_challenge WHERE address = $1 ORDER BY issued_at DESC`,
      [address.toLowerCase()]
    );
    return result.rows.map((row) => challengeRow(row));
  }

  async updateChallenge(record: StoreAuthChallengeRecord): Promise<void> {
    await this.#database.query(
      `UPDATE store_auth_challenge SET consumed_at = $1 WHERE nonce = $2`,
      [record.consumedAt ?? null, record.nonce]
    );
  }

  async consumeChallenge(nonce: string, consumedAt: string): Promise<StoreAuthChallengeRecord | undefined> {
    // 条件 UPDATE 原子占位——
    // WHERE consumed_at IS NULL 保证并发重放同一 nonce 只有一个赢家。
    const result = await this.#database.query(
      `UPDATE store_auth_challenge SET consumed_at = $1 WHERE nonce = $2 AND consumed_at IS NULL`,
      [consumedAt, nonce]
    );
    if ((result.rowCount ?? 0) !== 1) {
      return undefined;
    }
    return this.getChallenge(nonce);
  }

  async putSession(record: StoreWalletSessionRecord): Promise<void> {
    await this.#database.query(
      `INSERT INTO store_wallet_session (session_id, token_hash, account_id, anchored_address, created_at, expires_at, last_seen_at, revoked_at, revoked_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (session_id) DO UPDATE SET
         last_seen_at = EXCLUDED.last_seen_at,
         revoked_at = EXCLUDED.revoked_at,
         revoked_reason = EXCLUDED.revoked_reason`,
      sessionValues(record)
    );
  }

  async findSessionByTokenHash(tokenHash: string): Promise<StoreWalletSessionRecord | undefined> {
    const result = await this.#database.query(`SELECT * FROM store_wallet_session WHERE token_hash = $1`, [tokenHash]);
    return result.rows[0] ? sessionRow(result.rows[0]) : undefined;
  }

  async updateSession(record: StoreWalletSessionRecord): Promise<void> {
    await this.putSession(record);
  }

  async putAccountAddress(record: StoreAccountAddressRecord): Promise<void> {
    await this.#database.query(
      `INSERT INTO store_account_address (address, account_id, status, anchored_at, anchor_session_id, revoked_at, revoked_by_session_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (address) DO UPDATE SET
         account_id = EXCLUDED.account_id,
         status = EXCLUDED.status,
         anchored_at = EXCLUDED.anchored_at,
         anchor_session_id = EXCLUDED.anchor_session_id,
         revoked_at = EXCLUDED.revoked_at,
         revoked_by_session_id = EXCLUDED.revoked_by_session_id`,
      [
        record.address.toLowerCase(),
        record.accountId,
        record.status,
        record.anchoredAt,
        record.anchorSessionId ?? null,
        record.revokedAt ?? null,
        record.revokedBySessionId ?? null
      ]
    );
  }

  async listAccountAddresses(accountId: string): Promise<readonly StoreAccountAddressRecord[]> {
    const result = await this.#database.query(
      `SELECT * FROM store_account_address WHERE account_id = $1 ORDER BY anchored_at ASC, address ASC`,
      [accountId]
    );
    return result.rows.map((row) => accountAddressRow(row));
  }

  async findActiveAccountAddress(address: Address): Promise<StoreAccountAddressRecord | undefined> {
    const result = await this.#database.query(
      `SELECT * FROM store_account_address WHERE address = $1 AND status = 'active'`,
      [address.toLowerCase()]
    );
    return result.rows[0] ? accountAddressRow(result.rows[0]) : undefined;
  }

  async listAccountIds(): Promise<readonly string[]> {
    const result = await this.#database.query(`SELECT DISTINCT account_id FROM store_account_address ORDER BY account_id ASC`);
    return result.rows.map((row) => String(row.account_id));
  }
}

type Row = Record<string, unknown>;

function challengeRow(row: Row): StoreAuthChallengeRecord {
  return {
    nonce: String(row.nonce),
    address: String(row.address) as Address,
    intent: row.intent === "anchor_address" ? "anchor_address" : "login",
    ...(row.account_id ? { accountId: String(row.account_id) } : {}),
    message: String(row.message),
    issuedAt: String(row.issued_at),
    expiresAt: String(row.expires_at),
    ...(row.consumed_at ? { consumedAt: String(row.consumed_at) } : {})
  };
}

function sessionValues(record: StoreWalletSessionRecord): readonly unknown[] {
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

function sessionRow(row: Row): StoreWalletSessionRecord {
  return {
    sessionId: String(row.session_id),
    tokenHash: String(row.token_hash),
    accountId: String(row.account_id),
    anchoredAddress: String(row.anchored_address) as Address,
    createdAt: String(row.created_at),
    expiresAt: String(row.expires_at),
    ...(row.last_seen_at ? { lastSeenAt: String(row.last_seen_at) } : {}),
    ...(row.revoked_at ? { revokedAt: String(row.revoked_at) } : {}),
    ...(row.revoked_reason ? { revokedReason: String(row.revoked_reason) } : {})
  };
}

function accountAddressRow(row: Row): StoreAccountAddressRecord {
  return {
    accountId: String(row.account_id),
    address: String(row.address) as Address,
    status: row.status === "revoked" ? "revoked" : "active",
    anchoredAt: String(row.anchored_at),
    ...(row.anchor_session_id ? { anchorSessionId: String(row.anchor_session_id) } : {}),
    ...(row.revoked_at ? { revokedAt: String(row.revoked_at) } : {}),
    ...(row.revoked_by_session_id ? { revokedBySessionId: String(row.revoked_by_session_id) } : {})
  };
}
