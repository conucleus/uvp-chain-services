import { parseStorageJson, stringifyStorageJson } from "../storage/json.js";
import { runSqliteMigrations } from "../storage/migrations.js";
import {
  openSqliteDatabase,
  runSqliteWrite,
  type SqliteDatabase,
  type SqliteValue
} from "../storage/sqlite.js";
import {
  nullableStringColumn,
  rowObject,
  stringColumn
} from "../storage/sqlite-rows.js";
import type {
  StoreSupplierAuditRecord,
  StoreSupplierMetadataRecord,
  StoreSupplierMetadataStore
} from "./types.js";

export interface SqliteStoreSupplierMetadataStoreOptions {
  readonly databaseUrl?: string;
  readonly database?: SqliteDatabase;
  readonly migrations?: {
    readonly autoRun?: boolean;
    readonly directory?: string;
  };
}

export class SqliteStoreSupplierMetadataStore implements StoreSupplierMetadataStore {
  readonly #database: SqliteDatabase;
  readonly #ownsDatabase: boolean;

  constructor(options: SqliteStoreSupplierMetadataStoreOptions) {
    if (!options.database && !options.databaseUrl) {
      throw new Error("SqliteStoreSupplierMetadataStore requires database or databaseUrl");
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

  async close(): Promise<void> {
    if (this.#ownsDatabase) {
      this.#database.close();
    }
  }

  async getSupplier(supplierId: string): Promise<StoreSupplierMetadataRecord | undefined> {
    const row = this.#database.prepare(
      `SELECT *
       FROM store_supplier_metadata
       WHERE supplier_id = ?`
    ).get(supplierId);
    return row ? supplierRow(row) : undefined;
  }

  async findSupplierBySubjectId(supplierSubjectId: StoreSupplierMetadataRecord["supplierSubjectId"]): Promise<StoreSupplierMetadataRecord | undefined> {
    const row = this.#database.prepare(
      `SELECT *
       FROM store_supplier_metadata
       WHERE supplier_subject_id = ?`
    ).get(supplierSubjectId);
    return row ? supplierRow(row) : undefined;
  }

  async listSuppliers(): Promise<readonly StoreSupplierMetadataRecord[]> {
    return this.#database.prepare(
      `SELECT *
       FROM store_supplier_metadata
       ORDER BY updated_at DESC, supplier_id ASC`
    ).all().map((row) => supplierRow(row));
  }

  async putSupplier(record: StoreSupplierMetadataRecord): Promise<void> {
    runSqliteWrite(() => {
      this.#database.prepare(
        `INSERT INTO store_supplier_metadata (
           supplier_id, supplier_subject_id, display_name, wallet,
           capability_tags_json, supported_role_slot_ids_json,
           supported_stage_ids_json, registry_addresses_json, review_status, metadata_uri,
           notification_profile_json, notification_profile_hash, notification_updated_at,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(supplier_id)
         DO UPDATE SET
           supplier_subject_id = excluded.supplier_subject_id,
           display_name = excluded.display_name,
           wallet = excluded.wallet,
           capability_tags_json = excluded.capability_tags_json,
           supported_role_slot_ids_json = excluded.supported_role_slot_ids_json,
           supported_stage_ids_json = excluded.supported_stage_ids_json,
           registry_addresses_json = excluded.registry_addresses_json,
           review_status = excluded.review_status,
           metadata_uri = excluded.metadata_uri,
           notification_profile_json = excluded.notification_profile_json,
           notification_profile_hash = excluded.notification_profile_hash,
           notification_updated_at = excluded.notification_updated_at,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at`
      ).run(...supplierValues(record));
    });
  }

  async appendAudit(record: StoreSupplierAuditRecord): Promise<void> {
    runSqliteWrite(() => {
      this.#database.prepare(
        `INSERT INTO store_supplier_audit (
           audit_id, supplier_id, supplier_subject_id, action, actor,
           before_tags_json, after_tags_json,
           before_supported_role_slot_ids_json, after_supported_role_slot_ids_json,
           before_supported_stage_ids_json, after_supported_stage_ids_json,
           review_status, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(...auditValues(record));
    });
  }

  async listAudits(supplierId?: string): Promise<readonly StoreSupplierAuditRecord[]> {
    const rows = supplierId
      ? this.#database.prepare(
          `SELECT *
           FROM store_supplier_audit
           WHERE supplier_id = ?
           ORDER BY created_at DESC, audit_id DESC, row_id DESC`
        ).all(supplierId)
      : this.#database.prepare(
          `SELECT *
           FROM store_supplier_audit
           ORDER BY created_at DESC, audit_id DESC, row_id DESC`
        ).all();
    return rows.map((row) => auditRow(row));
  }
}

function supplierValues(record: StoreSupplierMetadataRecord): readonly SqliteValue[] {
  return [
    record.supplierId,
    record.supplierSubjectId,
    record.displayName,
    record.wallet ?? null,
    stringifyStorageJson(record.capabilityTags),
    stringifyStorageJson(record.supportedRoleSlotIds),
    stringifyStorageJson(record.supportedStageIds),
    stringifyStorageJson(record.registryAddresses),
    record.reviewStatus,
    record.metadataURI ?? null,
    record.notificationProfile ? stringifyStorageJson(record.notificationProfile) : null,
    record.notificationProfileHash ?? null,
    record.notificationUpdatedAt ?? null,
    record.createdAt,
    record.updatedAt
  ];
}

function supplierRow(row: unknown): StoreSupplierMetadataRecord {
  const record = rowObject(row, "store_supplier_metadata query");
  const wallet = optionalString(record, "wallet") as StoreSupplierMetadataRecord["wallet"];
  const metadataURI = optionalString(record, "metadata_uri");
  const notificationProfile = optionalJson<StoreSupplierMetadataRecord["notificationProfile"]>(record, "notification_profile_json");
  const notificationProfileHash = optionalString(record, "notification_profile_hash") as StoreSupplierMetadataRecord["notificationProfileHash"];
  const notificationUpdatedAt = optionalString(record, "notification_updated_at");
  return {
    supplierId: stringColumn(record, "supplier_id"),
    supplierSubjectId: stringColumn(record, "supplier_subject_id") as StoreSupplierMetadataRecord["supplierSubjectId"],
    displayName: stringColumn(record, "display_name"),
    ...(wallet !== undefined ? { wallet } : {}),
    ...(notificationProfile !== undefined ? { notificationProfile } : {}),
    ...(notificationProfileHash !== undefined ? { notificationProfileHash } : {}),
    ...(notificationUpdatedAt !== undefined ? { notificationUpdatedAt } : {}),
    capabilityTags: parseStorageJson<readonly string[]>(stringColumn(record, "capability_tags_json")),
    supportedRoleSlotIds: parseStorageJson<readonly string[]>(stringColumn(record, "supported_role_slot_ids_json")),
    supportedStageIds: parseStorageJson<readonly string[]>(stringColumn(record, "supported_stage_ids_json")),
    registryAddresses: parseStorageJson<StoreSupplierMetadataRecord["registryAddresses"]>(stringColumn(record, "registry_addresses_json")),
    reviewStatus: stringColumn(record, "review_status") as StoreSupplierMetadataRecord["reviewStatus"],
    ...(metadataURI !== undefined ? { metadataURI } : {}),
    createdAt: stringColumn(record, "created_at"),
    updatedAt: stringColumn(record, "updated_at")
  };
}

function auditValues(record: StoreSupplierAuditRecord): readonly SqliteValue[] {
  return [
    record.auditId,
    record.supplierId,
    record.supplierSubjectId,
    record.action,
    record.actor,
    record.beforeTags ? stringifyStorageJson(record.beforeTags) : null,
    record.afterTags ? stringifyStorageJson(record.afterTags) : null,
    record.beforeSupportedRoleSlotIds ? stringifyStorageJson(record.beforeSupportedRoleSlotIds) : null,
    record.afterSupportedRoleSlotIds ? stringifyStorageJson(record.afterSupportedRoleSlotIds) : null,
    record.beforeSupportedStageIds ? stringifyStorageJson(record.beforeSupportedStageIds) : null,
    record.afterSupportedStageIds ? stringifyStorageJson(record.afterSupportedStageIds) : null,
    record.reviewStatus ?? null,
    record.createdAt
  ];
}

function auditRow(row: unknown): StoreSupplierAuditRecord {
  const record = rowObject(row, "store_supplier_audit query");
  const beforeTags = optionalJson<readonly string[]>(record, "before_tags_json");
  const afterTags = optionalJson<readonly string[]>(record, "after_tags_json");
  const beforeSupportedRoleSlotIds = optionalJson<readonly string[]>(record, "before_supported_role_slot_ids_json");
  const afterSupportedRoleSlotIds = optionalJson<readonly string[]>(record, "after_supported_role_slot_ids_json");
  const beforeSupportedStageIds = optionalJson<readonly string[]>(record, "before_supported_stage_ids_json");
  const afterSupportedStageIds = optionalJson<readonly string[]>(record, "after_supported_stage_ids_json");
  const reviewStatus = optionalString(record, "review_status") as StoreSupplierAuditRecord["reviewStatus"];
  return {
    auditId: stringColumn(record, "audit_id"),
    supplierId: stringColumn(record, "supplier_id"),
    supplierSubjectId: stringColumn(record, "supplier_subject_id") as StoreSupplierAuditRecord["supplierSubjectId"],
    action: stringColumn(record, "action") as StoreSupplierAuditRecord["action"],
    actor: stringColumn(record, "actor"),
    ...(beforeTags !== undefined ? { beforeTags } : {}),
    ...(afterTags !== undefined ? { afterTags } : {}),
    ...(beforeSupportedRoleSlotIds !== undefined ? { beforeSupportedRoleSlotIds } : {}),
    ...(afterSupportedRoleSlotIds !== undefined ? { afterSupportedRoleSlotIds } : {}),
    ...(beforeSupportedStageIds !== undefined ? { beforeSupportedStageIds } : {}),
    ...(afterSupportedStageIds !== undefined ? { afterSupportedStageIds } : {}),
    ...(reviewStatus !== undefined ? { reviewStatus } : {}),
    createdAt: stringColumn(record, "created_at")
  };
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = nullableStringColumn(record, key);
  return value === null ? undefined : value;
}

function optionalJson<TValue>(record: Record<string, unknown>, key: string): TValue | undefined {
  const value = nullableStringColumn(record, key);
  return value === null ? undefined : parseStorageJson<TValue>(value);
}
