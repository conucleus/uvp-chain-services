import { runSqliteMigrations } from "../storage/migrations.js";
import {
  openSqliteDatabase,
  runSqliteWrite,
  type SqliteDatabase,
  type SqliteValue
} from "../storage/sqlite.js";
import {
  numberColumn,
  optionalStringColumn,
  rowObject,
  stringColumn
} from "../storage/sqlite-rows.js";
import { parseStorageJson, stringifyStorageJson } from "../storage/json.js";
import type { Address, Hex } from "../shared/types.js";
import type {
  StorePublisherDelegationRecord,
  StorePublisherDelegationStore,
  StoreZhixuDecorationData,
  StoreZhixuDecorationStore,
  StoreZhixuDecorationVersionRecord
} from "./types.js";

export class SqliteStoreZhixuDecorationStore implements StoreZhixuDecorationStore {
  readonly #database: SqliteDatabase;
  readonly #ownsDatabase: boolean;

  constructor(options: { readonly databaseUrl?: string; readonly database?: SqliteDatabase; readonly migrations?: { readonly autoRun?: boolean; readonly directory?: string } }) {
    if (!options.database && !options.databaseUrl) {
      throw new Error("SqliteStoreZhixuDecorationStore requires database or databaseUrl");
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

  async appendVersion(record: StoreZhixuDecorationVersionRecord): Promise<void> {
    runSqliteWrite(() => {
      this.#database.prepare(
        `INSERT INTO store_zhixu_decoration
           (decoration_id, plan_id, version, data_json, author_address, author_account_id, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        record.decorationId,
        record.planId.toLowerCase(),
        record.version,
        stringifyStorageJson(record.data),
        record.authorAddress.toLowerCase(),
        record.authorAccountId ?? null,
        record.note ?? null,
        record.createdAt
      );
    });
  }

  async listVersions(planId: Hex): Promise<readonly StoreZhixuDecorationVersionRecord[]> {
    return this.#database.prepare(
      `SELECT * FROM store_zhixu_decoration WHERE plan_id = ? ORDER BY version ASC`
    ).all(planId.toLowerCase()).map((row) => decorationRow(row));
  }
}

export class SqliteStorePublisherDelegationStore implements StorePublisherDelegationStore {
  readonly #database: SqliteDatabase;
  readonly #ownsDatabase: boolean;

  constructor(options: { readonly databaseUrl?: string; readonly database?: SqliteDatabase; readonly migrations?: { readonly autoRun?: boolean; readonly directory?: string } }) {
    if (!options.database && !options.databaseUrl) {
      throw new Error("SqliteStorePublisherDelegationStore requires database or databaseUrl");
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

  async appendDelegation(record: StorePublisherDelegationRecord): Promise<void> {
    runSqliteWrite(() => {
      this.#database.prepare(
        `INSERT INTO store_publisher_delegation
           (delegation_id, publisher_address, member_address, granted_by_address, granted_by_account_id, granted_at, revoked_at, revoked_by_address, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(delegation_id) DO UPDATE SET
           revoked_at = excluded.revoked_at,
           revoked_by_address = excluded.revoked_by_address,
           reason = excluded.reason`
      ).run(...delegationValues(record));
    });
  }

  async updateDelegation(record: StorePublisherDelegationRecord): Promise<void> {
    await this.appendDelegation(record);
  }

  async findActiveDelegation(publisherAddress: Address, memberAddress: Address): Promise<StorePublisherDelegationRecord | undefined> {
    const row = this.#database.prepare(
      `SELECT * FROM store_publisher_delegation
       WHERE publisher_address = ? AND member_address = ? AND revoked_at IS NULL
       ORDER BY granted_at DESC LIMIT 1`
    ).get(publisherAddress.toLowerCase(), memberAddress.toLowerCase());
    return row ? delegationRow(row) : undefined;
  }

  async listDelegations(publisherAddress: Address): Promise<readonly StorePublisherDelegationRecord[]> {
    return this.#database.prepare(
      `SELECT * FROM store_publisher_delegation WHERE publisher_address = ? ORDER BY granted_at ASC, delegation_id ASC`
    ).all(publisherAddress.toLowerCase()).map((row) => delegationRow(row));
  }

  async listDelegationsForMember(memberAddress: Address): Promise<readonly StorePublisherDelegationRecord[]> {
    return this.#database.prepare(
      `SELECT * FROM store_publisher_delegation WHERE member_address = ? ORDER BY granted_at ASC, delegation_id ASC`
    ).all(memberAddress.toLowerCase()).map((row) => delegationRow(row));
  }
}

function decorationRow(row: unknown): StoreZhixuDecorationVersionRecord {
  const record = rowObject(row);
  return {
    decorationId: stringColumn(record, "decoration_id"),
    planId: stringColumn(record, "plan_id") as Hex,
    version: numberColumn(record, "version"),
    data: parseStorageJson(stringColumn(record, "data_json")) as StoreZhixuDecorationData,
    authorAddress: stringColumn(record, "author_address") as Address,
    ...(optionalStringColumn(record, "author_account_id") ? { authorAccountId: optionalStringColumn(record, "author_account_id")! } : {}),
    ...(optionalStringColumn(record, "note") ? { note: optionalStringColumn(record, "note")! } : {}),
    createdAt: stringColumn(record, "created_at")
  };
}

function delegationValues(record: StorePublisherDelegationRecord): readonly SqliteValue[] {
  return [
    record.delegationId,
    record.publisherAddress.toLowerCase(),
    record.memberAddress.toLowerCase(),
    record.grantedByAddress.toLowerCase(),
    record.grantedByAccountId ?? null,
    record.grantedAt,
    record.revokedAt ?? null,
    record.revokedByAddress ? record.revokedByAddress.toLowerCase() : null,
    record.reason ?? null
  ];
}

function delegationRow(row: unknown): StorePublisherDelegationRecord {
  const record = rowObject(row);
  return {
    delegationId: stringColumn(record, "delegation_id"),
    publisherAddress: stringColumn(record, "publisher_address") as Address,
    memberAddress: stringColumn(record, "member_address") as Address,
    grantedByAddress: stringColumn(record, "granted_by_address") as Address,
    ...(optionalStringColumn(record, "granted_by_account_id") ? { grantedByAccountId: optionalStringColumn(record, "granted_by_account_id")! } : {}),
    grantedAt: stringColumn(record, "granted_at"),
    ...(optionalStringColumn(record, "revoked_at") ? { revokedAt: optionalStringColumn(record, "revoked_at")! } : {}),
    ...(optionalStringColumn(record, "revoked_by_address") ? { revokedByAddress: optionalStringColumn(record, "revoked_by_address")! as Address } : {}),
    ...(optionalStringColumn(record, "reason") ? { reason: optionalStringColumn(record, "reason")! } : {})
  };
}
