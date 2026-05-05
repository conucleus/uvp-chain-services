import { parseStorageJson, stringifyStorageJson } from "../storage/json.js";
import { PostgresDatabase } from "../storage/postgres-client.js";
import {
  nullableStringColumn,
  rowObject,
  stringColumn
} from "../storage/postgres-rows.js";
import type {
  StoreSupplierAuditRecord,
  StoreSupplierMetadataRecord,
  StoreSupplierMetadataStore
} from "./types.js";

export interface PostgresStoreSupplierMetadataStoreOptions {
  readonly databaseUrl?: string;
  readonly database?: PostgresDatabase;
  readonly migrations?: {
    readonly autoRun?: boolean;
    readonly directory?: string;
  };
}

export class PostgresStoreSupplierMetadataStore implements StoreSupplierMetadataStore {
  readonly driver = "postgres" as const;

  readonly #database: PostgresDatabase;
  readonly #ownsDatabase: boolean;

  constructor(options: PostgresStoreSupplierMetadataStoreOptions) {
    if (!options.database && !options.databaseUrl) {
      throw new Error("PostgresStoreSupplierMetadataStore requires database or databaseUrl");
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

  async getSupplier(supplierId: string): Promise<StoreSupplierMetadataRecord | undefined> {
    const result = await this.#database.query(
      `SELECT
         *,
         capability_tags_json::text AS capability_tags_json,
         supported_role_slot_ids_json::text AS supported_role_slot_ids_json,
         supported_stage_ids_json::text AS supported_stage_ids_json,
         registry_addresses_json::text AS registry_addresses_json,
         notification_profile_json::text AS notification_profile_json
       FROM store_supplier_metadata
       WHERE supplier_id = $1`,
      [supplierId]
    );
    return result.rows[0] ? supplierRow(result.rows[0]) : undefined;
  }

  async findSupplierBySubjectId(supplierSubjectId: StoreSupplierMetadataRecord["supplierSubjectId"]): Promise<StoreSupplierMetadataRecord | undefined> {
    const result = await this.#database.query(
      `SELECT
         *,
         capability_tags_json::text AS capability_tags_json,
         supported_role_slot_ids_json::text AS supported_role_slot_ids_json,
         supported_stage_ids_json::text AS supported_stage_ids_json,
         registry_addresses_json::text AS registry_addresses_json,
         notification_profile_json::text AS notification_profile_json
       FROM store_supplier_metadata
       WHERE supplier_subject_id = $1`,
      [supplierSubjectId]
    );
    return result.rows[0] ? supplierRow(result.rows[0]) : undefined;
  }

  async listSuppliers(): Promise<readonly StoreSupplierMetadataRecord[]> {
    const result = await this.#database.query(
      `SELECT
         *,
         capability_tags_json::text AS capability_tags_json,
         supported_role_slot_ids_json::text AS supported_role_slot_ids_json,
         supported_stage_ids_json::text AS supported_stage_ids_json,
         registry_addresses_json::text AS registry_addresses_json,
         notification_profile_json::text AS notification_profile_json
       FROM store_supplier_metadata
       ORDER BY updated_at DESC, supplier_id ASC`
    );
    return result.rows.map((row) => supplierRow(row));
  }

  async putSupplier(record: StoreSupplierMetadataRecord): Promise<void> {
    await this.#database.query(
      `INSERT INTO store_supplier_metadata (
         supplier_id, supplier_subject_id, display_name, wallet,
         capability_tags_json, supported_role_slot_ids_json,
         supported_stage_ids_json, registry_addresses_json, review_status, metadata_uri,
         notification_profile_json, notification_profile_hash, notification_updated_at,
         created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10, $11::jsonb, $12, $13, $14, $15)
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
         updated_at = excluded.updated_at`,
      supplierValues(record)
    );
  }

  async appendAudit(record: StoreSupplierAuditRecord): Promise<void> {
    await this.#database.query(
      `INSERT INTO store_supplier_audit (
         audit_id, supplier_id, supplier_subject_id, action, actor,
         before_tags_json, after_tags_json, review_status, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9)`,
      auditValues(record)
    );
  }

  async listAudits(supplierId?: string): Promise<readonly StoreSupplierAuditRecord[]> {
    const result = supplierId
      ? await this.#database.query(
          `SELECT
             *,
             before_tags_json::text AS before_tags_json,
             after_tags_json::text AS after_tags_json
           FROM store_supplier_audit
           WHERE supplier_id = $1
           ORDER BY created_at DESC, audit_id DESC, row_id DESC`,
          [supplierId]
        )
      : await this.#database.query(
          `SELECT
             *,
             before_tags_json::text AS before_tags_json,
             after_tags_json::text AS after_tags_json
           FROM store_supplier_audit
           ORDER BY created_at DESC, audit_id DESC, row_id DESC`
        );
    return result.rows.map((row) => auditRow(row));
  }
}

function supplierValues(record: StoreSupplierMetadataRecord): readonly unknown[] {
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

function auditValues(record: StoreSupplierAuditRecord): readonly unknown[] {
  return [
    record.auditId,
    record.supplierId,
    record.supplierSubjectId,
    record.action,
    record.actor,
    record.beforeTags ? stringifyStorageJson(record.beforeTags) : null,
    record.afterTags ? stringifyStorageJson(record.afterTags) : null,
    record.reviewStatus ?? null,
    record.createdAt
  ];
}

function auditRow(row: unknown): StoreSupplierAuditRecord {
  const record = rowObject(row, "store_supplier_audit query");
  const beforeTags = optionalJson<readonly string[]>(record, "before_tags_json");
  const afterTags = optionalJson<readonly string[]>(record, "after_tags_json");
  const reviewStatus = optionalString(record, "review_status") as StoreSupplierAuditRecord["reviewStatus"];
  return {
    auditId: stringColumn(record, "audit_id"),
    supplierId: stringColumn(record, "supplier_id"),
    supplierSubjectId: stringColumn(record, "supplier_subject_id") as StoreSupplierAuditRecord["supplierSubjectId"],
    action: stringColumn(record, "action") as StoreSupplierAuditRecord["action"],
    actor: stringColumn(record, "actor"),
    ...(beforeTags !== undefined ? { beforeTags } : {}),
    ...(afterTags !== undefined ? { afterTags } : {}),
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
