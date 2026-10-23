import type { Address } from "../../shared/types.js";
import { PostgresDatabase } from "../../storage/postgres-client.js";
import {
  optionalStringColumn,
  rowObject,
  stringColumn
} from "../../storage/postgres-rows.js";
import type {
  StoreEntityRegistrationRecord,
  StoreEntityRegistrationStatus,
  StoreEntityRegistrationStore
} from "./types.js";

export interface PostgresStoreEntityRegistrationStoreOptions {
  readonly databaseUrl?: string;
  readonly database?: PostgresDatabase;
  readonly migrations?: {
    readonly autoRun?: boolean;
    readonly directory?: string;
  };
}

export class PostgresStoreEntityRegistrationStore implements StoreEntityRegistrationStore {
  readonly driver = "postgres" as const;

  readonly #database: PostgresDatabase;
  readonly #ownsDatabase: boolean;

  constructor(options: PostgresStoreEntityRegistrationStoreOptions) {
    if (!options.database && !options.databaseUrl) {
      throw new Error("PostgresStoreEntityRegistrationStore requires database or databaseUrl");
    }
    this.#database = options.database ?? new PostgresDatabase({
      databaseUrl: options.databaseUrl!,
      ...(options.migrations ? { migrations: options.migrations } : {})
    });
    this.#ownsDatabase = !options.database;
  }

  async close(): Promise<void> {
    if (this.#ownsDatabase) {
      await this.#database.close();
    }
  }

  async upsertRegistration(record: StoreEntityRegistrationRecord): Promise<StoreEntityRegistrationRecord> {
    const result = await this.#database.query(
      `INSERT INTO store_entity_registration (
         registration_id, account_address, account_id,
         legal_name, registration_number, contact_name,
         status, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT(account_address)
       DO UPDATE SET
         account_id = EXCLUDED.account_id,
         legal_name = EXCLUDED.legal_name,
         registration_number = EXCLUDED.registration_number,
         contact_name = EXCLUDED.contact_name,
         status = EXCLUDED.status,
         updated_at = EXCLUDED.updated_at
       RETURNING *`,
      registrationValues(record)
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error("store_entity_registration upsert returned no row");
    }
    return registrationRow(row);
  }

  async getRegistrationByAccount(accountAddress: Address): Promise<StoreEntityRegistrationRecord | undefined> {
    const result = await this.#database.query(
      `SELECT * FROM store_entity_registration WHERE account_address = $1`,
      [accountAddress.toLowerCase()]
    );
    return result.rows[0] ? registrationRow(result.rows[0]) : undefined;
  }
}

function registrationValues(record: StoreEntityRegistrationRecord): readonly unknown[] {
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
