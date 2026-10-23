import type { Address } from "../../shared/types.js";
import { runSqliteMigrations } from "../../storage/migrations.js";
import {
  openSqliteDatabase,
  runSqliteWrite,
  type SqliteDatabase,
  type SqliteValue
} from "../../storage/sqlite.js";
import {
  optionalStringColumn,
  rowObject,
  stringColumn
} from "../../storage/sqlite-rows.js";
import type {
  StoreEntityRegistrationRecord,
  StoreEntityRegistrationStatus,
  StoreEntityRegistrationStore
} from "./types.js";

export interface SqliteStoreEntityRegistrationStoreOptions {
  readonly databaseUrl?: string;
  readonly database?: SqliteDatabase;
  readonly migrations?: {
    readonly autoRun?: boolean;
    readonly directory?: string;
  };
}

/**
 * sqlite 驱动的实体登记 store。schema 见 migrations/0028；account_address
 * 唯一索引保证单账号单活跃记录。
 */
export class SqliteStoreEntityRegistrationStore implements StoreEntityRegistrationStore {
  readonly #database: SqliteDatabase;
  readonly #ownsDatabase: boolean;

  constructor(options: SqliteStoreEntityRegistrationStoreOptions) {
    if (!options.database && !options.databaseUrl) {
      throw new Error("SqliteStoreEntityRegistrationStore requires database or databaseUrl");
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

  async upsertRegistration(record: StoreEntityRegistrationRecord): Promise<StoreEntityRegistrationRecord> {
    runSqliteWrite(() => {
      this.#database.prepare(
        `INSERT INTO store_entity_registration (
           registration_id, account_address, account_id,
           legal_name, registration_number, contact_name,
           status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_address)
         DO UPDATE SET
           account_id = excluded.account_id,
           legal_name = excluded.legal_name,
           registration_number = excluded.registration_number,
           contact_name = excluded.contact_name,
           status = excluded.status,
           updated_at = excluded.updated_at`
      ).run(...registrationValues(record));
    });
    // 冲突分支不覆盖 registration_id/created_at：读回的是首次登记身份与
    // 最新申报字段（并发双提交的败者同样读回赢家行）。
    const persisted = await this.getRegistrationByAccount(record.accountAddress);
    if (!persisted) {
      throw new Error("store_entity_registration upsert returned no row");
    }
    return persisted;
  }

  async getRegistrationByAccount(accountAddress: Address): Promise<StoreEntityRegistrationRecord | undefined> {
    const row = this.#database.prepare(
      `SELECT * FROM store_entity_registration WHERE account_address = ?`
    ).get(accountAddress.toLowerCase());
    return row ? registrationRow(row) : undefined;
  }
}

function registrationValues(record: StoreEntityRegistrationRecord): readonly SqliteValue[] {
  return [
    record.registrationId,
    record.accountAddress.toLowerCase(),
    record.accountId ?? null,
    record.legalName,
    record.registrationNumber,
    record.contactName,
    record.status,
    record.createdAt,
    record.updatedAt
  ];
}

function registrationRow(row: unknown): StoreEntityRegistrationRecord {
  const record = rowObject(row, "store_entity_registration query");
  const accountId = optionalStringColumn(record, "account_id");
  const status = stringColumn(record, "status");
  if (status !== "self_declared" && status !== "pending_review") {
    throw new Error(`store_entity_registration.status holds unsupported value ${status}`);
  }
  return {
    registrationId: stringColumn(record, "registration_id"),
    accountAddress: stringColumn(record, "account_address") as Address,
    ...(accountId !== undefined ? { accountId } : {}),
    legalName: stringColumn(record, "legal_name"),
    registrationNumber: stringColumn(record, "registration_number"),
    contactName: stringColumn(record, "contact_name"),
    status: status satisfies StoreEntityRegistrationStatus,
    createdAt: stringColumn(record, "created_at"),
    updatedAt: stringColumn(record, "updated_at")
  };
}
