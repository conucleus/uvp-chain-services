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
import type { Address, Hex } from "../shared/types.js";
import type { StoreListingRecord, StoreListingStore, StoreListingStatus } from "./types.js";

export class SqliteStoreListingStore implements StoreListingStore {
  readonly #database: SqliteDatabase;
  readonly #ownsDatabase: boolean;

  constructor(options: { readonly databaseUrl?: string; readonly database?: SqliteDatabase; readonly migrations?: { readonly autoRun?: boolean; readonly directory?: string } }) {
    if (!options.database && !options.databaseUrl) {
      throw new Error("SqliteStoreListingStore requires database or databaseUrl");
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

  async putListing(record: StoreListingRecord): Promise<void> {
    runSqliteWrite(() => {
      this.#database.prepare(
        `INSERT INTO store_zhixu_listing
           (listing_id, plan_id, plan_hash_claimed, deployment_id_claimed, state_machine_address_claimed,
            status, imported_by_address, imported_by_account_id, imported_at,
            reviewed_by_address, reviewed_at, review_note, delist_reason, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(listing_id) DO UPDATE SET
           status = excluded.status,
           reviewed_by_address = excluded.reviewed_by_address,
           reviewed_at = excluded.reviewed_at,
           review_note = excluded.review_note,
           delist_reason = excluded.delist_reason,
           updated_at = excluded.updated_at`
      ).run(...listingValues(record));
    });
  }

  async getListing(listingId: string): Promise<StoreListingRecord | undefined> {
    const row = this.#database.prepare(
      `SELECT * FROM store_zhixu_listing WHERE listing_id = ?`
    ).get(listingId);
    return row ? listingRow(row) : undefined;
  }

  async findListingByPlanId(planId: Hex): Promise<StoreListingRecord | undefined> {
    const row = this.#database.prepare(
      `SELECT * FROM store_zhixu_listing WHERE plan_id = ? ORDER BY imported_at ASC`
    ).get(planId.toLowerCase());
    return row ? listingRow(row) : undefined;
  }

  async listListings(status?: StoreListingStatus): Promise<readonly StoreListingRecord[]> {
    const rows = status
      ? this.#database.prepare(`SELECT * FROM store_zhixu_listing WHERE status = ? ORDER BY updated_at DESC, listing_id ASC`).all(status)
      : this.#database.prepare(`SELECT * FROM store_zhixu_listing ORDER BY updated_at DESC, listing_id ASC`).all();
    return rows.map((row) => listingRow(row));
  }
}

function listingValues(record: StoreListingRecord): readonly SqliteValue[] {
  return [
    record.listingId,
    record.planId.toLowerCase(),
    record.planHashClaimed?.toLowerCase() ?? null,
    record.deploymentIdClaimed?.toLowerCase() ?? null,
    record.stateMachineAddressClaimed?.toLowerCase() ?? null,
    record.status,
    record.importedByAddress?.toLowerCase() ?? null,
    record.importedByAccountId ?? null,
    record.importedAt,
    record.reviewedByAddress?.toLowerCase() ?? null,
    record.reviewedAt ?? null,
    record.reviewNote ?? null,
    record.delistReason ?? null,
    record.updatedAt
  ];
}

function listingRow(row: unknown): StoreListingRecord {
  const record = rowObject(row);
  const status = stringColumn(record, "status");
  if (status !== "imported" && status !== "public" && status !== "rejected" && status !== "delisted") {
    throw new Error(`store_zhixu_listing.status column holds unsupported value ${status}`);
  }
  return {
    listingId: stringColumn(record, "listing_id"),
    planId: stringColumn(record, "plan_id") as Hex,
    ...(optionalStringColumn(record, "plan_hash_claimed") ? { planHashClaimed: optionalStringColumn(record, "plan_hash_claimed")! as Hex } : {}),
    ...(optionalStringColumn(record, "deployment_id_claimed") ? { deploymentIdClaimed: optionalStringColumn(record, "deployment_id_claimed")! as Hex } : {}),
    ...(optionalStringColumn(record, "state_machine_address_claimed") ? { stateMachineAddressClaimed: optionalStringColumn(record, "state_machine_address_claimed")! as Address } : {}),
    status,
    ...(optionalStringColumn(record, "imported_by_address") ? { importedByAddress: optionalStringColumn(record, "imported_by_address")! as Address } : {}),
    ...(optionalStringColumn(record, "imported_by_account_id") ? { importedByAccountId: optionalStringColumn(record, "imported_by_account_id")! } : {}),
    importedAt: stringColumn(record, "imported_at"),
    ...(optionalStringColumn(record, "reviewed_by_address") ? { reviewedByAddress: optionalStringColumn(record, "reviewed_by_address")! as Address } : {}),
    ...(optionalStringColumn(record, "reviewed_at") ? { reviewedAt: optionalStringColumn(record, "reviewed_at")! } : {}),
    ...(optionalStringColumn(record, "review_note") ? { reviewNote: optionalStringColumn(record, "review_note")! } : {}),
    ...(optionalStringColumn(record, "delist_reason") ? { delistReason: optionalStringColumn(record, "delist_reason")! } : {}),
    updatedAt: stringColumn(record, "updated_at")
  };
}
