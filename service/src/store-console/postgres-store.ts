import { parseStorageJson, stringifyStorageJson } from "../storage/json.js";
import { PostgresDatabase } from "../storage/postgres-client.js";
import {
  nullableStringColumn,
  rowObject,
  stringColumn
} from "../storage/postgres-rows.js";
import type {
  StoreAuditQuery,
  StoreAuditRecord,
  StoreAuditStore
} from "./audit.js";
import type { StoreProductSchemaDTO } from "@uvp-eth/product-dto";
import type {
  StoreDockingSessionDTO,
  StoreDockingSessionStore
} from "./docking.js";
import type {
  StoreCompilePreviewDTO,
  StoreDraftErrorDTO,
  StoreZhixuDraftRecord,
  StoreZhixuDraftSourceKind,
  StoreZhixuDraftStatus,
  StoreZhixuDraftStore
} from "./zhixu-drafts.js";
import type {
  StoreZhixuVersionMetadataStore,
  StoreZhixuVersionRecord
} from "./version.js";

export interface PostgresStoreMetadataStoreOptions {
  readonly databaseUrl?: string;
  readonly database?: PostgresDatabase;
  readonly migrations?: {
    readonly autoRun?: boolean;
    readonly directory?: string;
  };
}

export class PostgresStoreAuditStore implements StoreAuditStore {
  readonly driver = "postgres" as const;

  readonly #database: PostgresDatabase;
  readonly #ownsDatabase: boolean;

  constructor(options: PostgresStoreMetadataStoreOptions) {
    const opened = openStoreMetadataDatabase(options, "PostgresStoreAuditStore");
    this.#database = opened.database;
    this.#ownsDatabase = opened.ownsDatabase;
  }

  async close(): Promise<void> {
    if (this.#ownsDatabase) {
      await this.#database.close();
    }
  }

  async append(record: StoreAuditRecord): Promise<void> {
    await this.#database.query(
      `INSERT INTO store_operator_audit (
         audit_id, created_at, actor, action, outcome, resource_type,
         resource_id, parent_id, access_level, auth_mode, roles_json,
         error_code, request_id, metadata_json
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14::jsonb)`,
      auditValues(record)
    );
  }

  async query(query: StoreAuditQuery = {}): Promise<readonly StoreAuditRecord[]> {
    const filters: string[] = [];
    const values: unknown[] = [];
    addAuditFilter(filters, values, "resource_type", query.resourceType);
    addAuditFilter(filters, values, "resource_id", query.resourceId);
    addAuditFilter(filters, values, "actor", query.actor);
    addAuditFilter(filters, values, "action", query.action);
    addAuditFilter(filters, values, "outcome", query.outcome);
    values.push(query.limit ?? 100);
    const result = await this.#database.query(
      `SELECT
         audit_id, created_at, actor, action, outcome, resource_type,
         resource_id, parent_id, access_level, auth_mode,
         roles_json::text AS roles_json, error_code, request_id,
         metadata_json::text AS metadata_json
       FROM store_operator_audit
       ${filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : ""}
       ORDER BY created_at DESC, row_id DESC
       LIMIT $${values.length}`,
      values
    );
    return result.rows.map((row) => auditRow(row));
  }
}

export class PostgresStoreZhixuDraftStore implements StoreZhixuDraftStore {
  readonly driver = "postgres" as const;

  readonly #database: PostgresDatabase;
  readonly #ownsDatabase: boolean;

  constructor(options: PostgresStoreMetadataStoreOptions) {
    const opened = openStoreMetadataDatabase(options, "PostgresStoreZhixuDraftStore");
    this.#database = opened.database;
    this.#ownsDatabase = opened.ownsDatabase;
  }

  async close(): Promise<void> {
    if (this.#ownsDatabase) {
      await this.#database.close();
    }
  }

  async createDraft(draft: StoreZhixuDraftRecord): Promise<void> {
    await this.#database.query(
      `INSERT INTO store_zhixu_draft (
         draft_id, source_kind, content, status, zhixu_id, title, maintainer,
         public_summary, tags_json, compile_preview_json, product_schema_json, review_id,
         governance_tx_log_id, errors_json, review_status,
         created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12, $13, $14::jsonb, $15, $16, $17)`,
      draftValues(draft)
    );
  }

  async getDraft(draftId: string): Promise<StoreZhixuDraftRecord | undefined> {
    const result = await this.#database.query(
      `SELECT
         *,
         tags_json::text AS tags_json,
         compile_preview_json::text AS compile_preview_json,
         product_schema_json::text AS product_schema_json,
         errors_json::text AS errors_json
       FROM store_zhixu_draft
       WHERE draft_id = $1`,
      [draftId]
    );
    return result.rows[0] ? draftRow(result.rows[0]) : undefined;
  }

  async findProductSchemaByPlan(
    planId: string,
    planHash: string,
    artifactHash?: string
  ): Promise<StoreProductSchemaDTO | undefined> {
    const result = await this.#database.query(
      `SELECT product_schema_json::text AS product_schema_json
       FROM store_zhixu_draft
       WHERE product_schema_json IS NOT NULL
       ORDER BY updated_at DESC, draft_id DESC`
    );
    return productSchemaRowsByPlan(result.rows, planId, planHash, artifactHash)[0];
  }

  async updateDraft(draft: StoreZhixuDraftRecord): Promise<void> {
    await this.#database.query(
      `INSERT INTO store_zhixu_draft (
         draft_id, source_kind, content, status, zhixu_id, title, maintainer,
         public_summary, tags_json, compile_preview_json, product_schema_json, review_id,
         governance_tx_log_id, errors_json, review_status,
         created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12, $13, $14::jsonb, $15, $16, $17)
       ON CONFLICT(draft_id)
       DO UPDATE SET
         source_kind = excluded.source_kind,
         content = excluded.content,
         status = excluded.status,
         zhixu_id = excluded.zhixu_id,
         title = excluded.title,
         maintainer = excluded.maintainer,
         public_summary = excluded.public_summary,
         tags_json = excluded.tags_json,
         compile_preview_json = excluded.compile_preview_json,
         product_schema_json = excluded.product_schema_json,
         review_id = excluded.review_id,
         governance_tx_log_id = excluded.governance_tx_log_id,
         errors_json = excluded.errors_json,
         review_status = excluded.review_status,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at`,
      draftValues(draft)
    );
  }
}

export class PostgresStoreZhixuVersionMetadataStore implements StoreZhixuVersionMetadataStore {
  readonly driver = "postgres" as const;

  readonly #database: PostgresDatabase;
  readonly #ownsDatabase: boolean;

  constructor(options: PostgresStoreMetadataStoreOptions) {
    const opened = openStoreMetadataDatabase(options, "PostgresStoreZhixuVersionMetadataStore");
    this.#database = opened.database;
    this.#ownsDatabase = opened.ownsDatabase;
  }

  async close(): Promise<void> {
    if (this.#ownsDatabase) {
      await this.#database.close();
    }
  }

  async listVersions(seriesId: string): Promise<readonly StoreZhixuVersionRecord[]> {
    const result = await this.#database.query(
      `SELECT *
       FROM store_zhixu_version_metadata
       WHERE series_id = $1
       ORDER BY created_at ASC, version_id ASC`,
      [seriesId]
    );
    return result.rows.map((row) => versionRow(row));
  }

  async getVersion(seriesId: string, versionId: string): Promise<StoreZhixuVersionRecord | undefined> {
    const result = await this.#database.query(
      `SELECT *
       FROM store_zhixu_version_metadata
       WHERE series_id = $1 AND version_id = $2`,
      [seriesId, versionId]
    );
    return result.rows[0] ? versionRow(result.rows[0]) : undefined;
  }

  async upsertVersion(record: StoreZhixuVersionRecord): Promise<void> {
    await this.#database.query(
      `INSERT INTO store_zhixu_version_metadata (
         series_id, version_id, zhixu_id, version_label, status, plan_id,
         plan_hash, artifact_hash, created_at, cutover_at, cutover_reason
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT(series_id, version_id)
       DO UPDATE SET
         zhixu_id = excluded.zhixu_id,
         version_label = excluded.version_label,
         status = excluded.status,
         plan_id = excluded.plan_id,
         plan_hash = excluded.plan_hash,
         artifact_hash = excluded.artifact_hash,
         created_at = excluded.created_at,
         cutover_at = excluded.cutover_at,
         cutover_reason = excluded.cutover_reason`,
      versionValues(record)
    );
  }
}

export class PostgresStoreDockingSessionStore implements StoreDockingSessionStore {
  readonly driver = "postgres" as const;

  readonly #database: PostgresDatabase;
  readonly #ownsDatabase: boolean;

  constructor(options: PostgresStoreMetadataStoreOptions) {
    const opened = openStoreMetadataDatabase(options, "PostgresStoreDockingSessionStore");
    this.#database = opened.database;
    this.#ownsDatabase = opened.ownsDatabase;
  }

  async close(): Promise<void> {
    if (this.#ownsDatabase) {
      await this.#database.close();
    }
  }

  async createSession(session: StoreDockingSessionDTO): Promise<void> {
    await this.#database.query(
      `INSERT INTO store_docking_session (
         session_id, source_zhixu_id, target_zhixu_id, source_version_id,
         target_version_id, status, draft_signal_map_json, validation_json,
         session_json, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11)`,
      dockingSessionValues(session)
    );
  }

  async getSession(sessionId: string): Promise<StoreDockingSessionDTO | undefined> {
    const result = await this.#database.query(
      `SELECT session_json::text AS session_json
       FROM store_docking_session
       WHERE session_id = $1`,
      [sessionId]
    );
    return result.rows[0] ? dockingSessionRow(result.rows[0]) : undefined;
  }

  async updateSession(session: StoreDockingSessionDTO): Promise<void> {
    await this.#database.query(
      `INSERT INTO store_docking_session (
         session_id, source_zhixu_id, target_zhixu_id, source_version_id,
         target_version_id, status, draft_signal_map_json, validation_json,
         session_json, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11)
       ON CONFLICT(session_id)
       DO UPDATE SET
         source_zhixu_id = excluded.source_zhixu_id,
         target_zhixu_id = excluded.target_zhixu_id,
         source_version_id = excluded.source_version_id,
         target_version_id = excluded.target_version_id,
         status = excluded.status,
         draft_signal_map_json = excluded.draft_signal_map_json,
         validation_json = excluded.validation_json,
         session_json = excluded.session_json,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at`,
      dockingSessionValues(session)
    );
  }
}

function openStoreMetadataDatabase(
  options: PostgresStoreMetadataStoreOptions,
  label: string
): { readonly database: PostgresDatabase; readonly ownsDatabase: boolean } {
  if (!options.database && !options.databaseUrl) {
    throw new Error(`${label} requires database or databaseUrl`);
  }
  return {
    database: options.database ?? new PostgresDatabase({
      databaseUrl: options.databaseUrl!,
      ...(options.migrations ? { migrations: options.migrations } : {})
    }),
    ownsDatabase: !options.database
  };
}

function addAuditFilter(filters: string[], values: unknown[], column: string, value: string | undefined): void {
  if (!value) {
    return;
  }
  values.push(value);
  filters.push(`${column} = $${values.length}`);
}

function auditValues(record: StoreAuditRecord): readonly unknown[] {
  return [
    record.auditId,
    record.createdAt,
    record.actor,
    record.action,
    record.outcome,
    record.resourceType,
    record.resourceId ?? null,
    record.parentId ?? null,
    record.accessLevel,
    record.authMode,
    stringifyStorageJson(record.roles),
    record.errorCode ?? null,
    record.requestId ?? null,
    record.metadata ? stringifyStorageJson(record.metadata) : null
  ];
}

function auditRow(row: unknown): StoreAuditRecord {
  const record = rowObject(row, "store_operator_audit query");
  const resourceId = optionalString(record, "resource_id");
  const parentId = optionalString(record, "parent_id");
  const errorCode = optionalString(record, "error_code");
  const requestId = optionalString(record, "request_id");
  const metadata = optionalJson<Readonly<Record<string, unknown>>>(record, "metadata_json");
  return {
    auditId: stringColumn(record, "audit_id"),
    createdAt: stringColumn(record, "created_at"),
    actor: stringColumn(record, "actor"),
    action: stringColumn(record, "action") as StoreAuditRecord["action"],
    outcome: stringColumn(record, "outcome") as StoreAuditRecord["outcome"],
    resourceType: stringColumn(record, "resource_type"),
    ...(resourceId !== undefined ? { resourceId } : {}),
    ...(parentId !== undefined ? { parentId } : {}),
    accessLevel: stringColumn(record, "access_level") as StoreAuditRecord["accessLevel"],
    authMode: stringColumn(record, "auth_mode") as StoreAuditRecord["authMode"],
    roles: parseStorageJson<StoreAuditRecord["roles"]>(stringColumn(record, "roles_json")),
    ...(errorCode !== undefined ? { errorCode } : {}),
    ...(requestId !== undefined ? { requestId } : {}),
    ...(metadata !== undefined ? { metadata } : {})
  };
}

function draftValues(draft: StoreZhixuDraftRecord): readonly unknown[] {
  return [
    draft.draftId,
    draft.sourceKind,
    draft.content,
    draft.status,
    draft.zhixuId ?? null,
    draft.title,
    draft.maintainer,
    draft.publicSummary ?? null,
    stringifyStorageJson(draft.tags),
    draft.compilePreview ? stringifyStorageJson(draft.compilePreview) : null,
    draft.productSchema ? stringifyStorageJson(draft.productSchema) : null,
    draft.reviewId ?? null,
    draft.governanceTxLogId ?? null,
    stringifyStorageJson(draft.errors),
    draft.reviewStatus ?? null,
    draft.createdAt,
    draft.updatedAt
  ];
}

function draftRow(row: unknown): StoreZhixuDraftRecord {
  const record = rowObject(row, "store_zhixu_draft query");
  const zhixuId = optionalString(record, "zhixu_id");
  const publicSummary = optionalString(record, "public_summary");
  const compilePreview = optionalJson<StoreCompilePreviewDTO>(record, "compile_preview_json");
  const productSchema = optionalJson<StoreProductSchemaDTO>(record, "product_schema_json");
  const reviewId = optionalString(record, "review_id");
  const governanceTxLogId = optionalString(record, "governance_tx_log_id");
  const reviewStatus = optionalString(record, "review_status") as StoreZhixuDraftRecord["reviewStatus"];
  return {
    draftId: stringColumn(record, "draft_id"),
    sourceKind: stringColumn(record, "source_kind") as StoreZhixuDraftSourceKind,
    content: stringColumn(record, "content"),
    status: stringColumn(record, "status") as StoreZhixuDraftStatus,
    ...(zhixuId !== undefined ? { zhixuId } : {}),
    title: stringColumn(record, "title"),
    maintainer: stringColumn(record, "maintainer"),
    ...(publicSummary !== undefined ? { publicSummary } : {}),
    tags: parseStorageJson<readonly string[]>(stringColumn(record, "tags_json")),
    ...(compilePreview !== undefined ? { compilePreview } : {}),
    ...(productSchema !== undefined ? { productSchema } : {}),
    ...(reviewId !== undefined ? { reviewId } : {}),
    ...(governanceTxLogId !== undefined ? { governanceTxLogId } : {}),
    errors: parseStorageJson<readonly StoreDraftErrorDTO[]>(stringColumn(record, "errors_json")),
    ...(reviewStatus !== undefined ? { reviewStatus } : {}),
    createdAt: stringColumn(record, "created_at"),
    updatedAt: stringColumn(record, "updated_at")
  };
}

function versionValues(record: StoreZhixuVersionRecord): readonly unknown[] {
  return [
    record.seriesId,
    record.versionId,
    record.zhixuId,
    record.versionLabel,
    record.status,
    record.planId,
    record.planHash,
    record.artifactHash ?? null,
    record.createdAt,
    record.cutoverAt ?? null,
    record.cutoverReason ?? null
  ];
}

function versionRow(row: unknown): StoreZhixuVersionRecord {
  const record = rowObject(row, "store_zhixu_version_metadata query");
  const artifactHash = optionalString(record, "artifact_hash") as StoreZhixuVersionRecord["artifactHash"];
  const cutoverAt = optionalString(record, "cutover_at");
  const cutoverReason = optionalString(record, "cutover_reason");
  return {
    seriesId: stringColumn(record, "series_id"),
    versionId: stringColumn(record, "version_id"),
    zhixuId: stringColumn(record, "zhixu_id"),
    versionLabel: stringColumn(record, "version_label"),
    status: stringColumn(record, "status") as StoreZhixuVersionRecord["status"],
    planId: stringColumn(record, "plan_id") as StoreZhixuVersionRecord["planId"],
    planHash: stringColumn(record, "plan_hash") as StoreZhixuVersionRecord["planHash"],
    ...(artifactHash !== undefined ? { artifactHash } : {}),
    createdAt: stringColumn(record, "created_at"),
    ...(cutoverAt !== undefined ? { cutoverAt } : {}),
    ...(cutoverReason !== undefined ? { cutoverReason } : {})
  };
}

function dockingSessionValues(session: StoreDockingSessionDTO): readonly unknown[] {
  return [
    session.sessionId,
    session.source.zhixuId,
    session.target.zhixuId,
    session.source.versionId ?? null,
    session.target.versionId ?? null,
    session.status,
    stringifyStorageJson(session.draftSignalMap),
    stringifyStorageJson(session.validation),
    stringifyStorageJson(session),
    session.createdAt,
    session.updatedAt
  ];
}

function dockingSessionRow(row: unknown): StoreDockingSessionDTO {
  const record = rowObject(row, "store_docking_session query");
  return parseStorageJson<StoreDockingSessionDTO>(stringColumn(record, "session_json"));
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = nullableStringColumn(record, key);
  return value === null ? undefined : value;
}

function optionalJson<TValue>(record: Record<string, unknown>, key: string): TValue | undefined {
  const value = nullableStringColumn(record, key);
  return value === null ? undefined : parseStorageJson<TValue>(value);
}

function productSchemaRowsByPlan(
  rows: readonly unknown[],
  planId: string,
  planHash: string,
  artifactHash?: string
): readonly StoreProductSchemaDTO[] {
  return rows
    .map((row) => optionalJson<StoreProductSchemaDTO>(
      rowObject(row, "store_zhixu_draft product schema query"),
      "product_schema_json"
    ))
    .filter((schema): schema is StoreProductSchemaDTO => Boolean(schema))
    .filter((schema) =>
      stringEquals(schema.planId, planId) &&
      stringEquals(schema.planHash, planHash) &&
      (artifactHash === undefined || stringEquals(schema.artifactHash, artifactHash))
    );
}

function stringEquals(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}
