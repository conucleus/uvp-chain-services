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

export interface SqliteStoreMetadataStoreOptions {
  readonly databaseUrl?: string;
  readonly database?: SqliteDatabase;
  readonly migrations?: {
    readonly autoRun?: boolean;
    readonly directory?: string;
  };
}

export class SqliteStoreAuditStore implements StoreAuditStore {
  readonly #database: SqliteDatabase;
  readonly #ownsDatabase: boolean;

  constructor(options: SqliteStoreMetadataStoreOptions) {
    const opened = openStoreMetadataDatabase(options, "SqliteStoreAuditStore");
    this.#database = opened.database;
    this.#ownsDatabase = opened.ownsDatabase;
  }

  async close(): Promise<void> {
    if (this.#ownsDatabase) {
      this.#database.close();
    }
  }

  async append(record: StoreAuditRecord): Promise<void> {
    runSqliteWrite(() => {
      this.#database.prepare(
        `INSERT INTO store_operator_audit (
           audit_id, created_at, actor, action, outcome, resource_type,
           resource_id, parent_id, access_level, auth_mode, roles_json,
           error_code, request_id, metadata_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(...auditValues(record));
    });
  }

  async query(query: StoreAuditQuery = {}): Promise<readonly StoreAuditRecord[]> {
    const filters: string[] = [];
    const values: SqliteValue[] = [];
    if (query.resourceType) {
      filters.push("resource_type = ?");
      values.push(query.resourceType);
    }
    if (query.resourceId) {
      filters.push("resource_id = ?");
      values.push(query.resourceId);
    }
    if (query.actor) {
      filters.push("actor = ?");
      values.push(query.actor);
    }
    if (query.action) {
      filters.push("action = ?");
      values.push(query.action);
    }
    if (query.outcome) {
      filters.push("outcome = ?");
      values.push(query.outcome);
    }
    values.push(query.limit ?? 100);
    const rows = this.#database.prepare(
      `SELECT *
       FROM store_operator_audit
       ${filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : ""}
       ORDER BY created_at DESC, row_id DESC
       LIMIT ?`
    ).all(...values);
    return rows.map((row) => auditRow(row));
  }
}

export class SqliteStoreZhixuDraftStore implements StoreZhixuDraftStore {
  readonly #database: SqliteDatabase;
  readonly #ownsDatabase: boolean;

  constructor(options: SqliteStoreMetadataStoreOptions) {
    const opened = openStoreMetadataDatabase(options, "SqliteStoreZhixuDraftStore");
    this.#database = opened.database;
    this.#ownsDatabase = opened.ownsDatabase;
  }

  async close(): Promise<void> {
    if (this.#ownsDatabase) {
      this.#database.close();
    }
  }

  async createDraft(draft: StoreZhixuDraftRecord): Promise<void> {
    runSqliteWrite(() => {
      this.#database.prepare(
        `INSERT INTO store_zhixu_draft (
           draft_id, source_kind, content, status, zhixu_id, title, maintainer,
           public_summary, tags_json, compile_preview_json, product_schema_json, review_id,
           governance_tx_log_id, errors_json, review_status,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(...draftValues(draft));
    });
  }

  async getDraft(draftId: string): Promise<StoreZhixuDraftRecord | undefined> {
    const row = this.#database.prepare(
      `SELECT *
       FROM store_zhixu_draft
       WHERE draft_id = ?`
    ).get(draftId);
    return row ? draftRow(row) : undefined;
  }

  async findProductSchemaByPlan(
    planId: string,
    planHash: string,
    artifactHash?: string
  ): Promise<StoreProductSchemaDTO | undefined> {
    const rows = this.#database.prepare(
      `SELECT product_schema_json
       FROM store_zhixu_draft
       WHERE product_schema_json IS NOT NULL
       ORDER BY updated_at DESC, draft_id DESC`
    ).all();
    return productSchemaRowsByPlan(rows, planId, planHash, artifactHash)[0];
  }

  async updateDraft(draft: StoreZhixuDraftRecord): Promise<void> {
    runSqliteWrite(() => {
      this.#database.prepare(
        `INSERT INTO store_zhixu_draft (
           draft_id, source_kind, content, status, zhixu_id, title, maintainer,
           public_summary, tags_json, compile_preview_json, product_schema_json, review_id,
           governance_tx_log_id, errors_json, review_status,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
           updated_at = excluded.updated_at`
      ).run(...draftValues(draft));
    });
  }
}

export class SqliteStoreZhixuVersionMetadataStore implements StoreZhixuVersionMetadataStore {
  readonly #database: SqliteDatabase;
  readonly #ownsDatabase: boolean;

  constructor(options: SqliteStoreMetadataStoreOptions) {
    const opened = openStoreMetadataDatabase(options, "SqliteStoreZhixuVersionMetadataStore");
    this.#database = opened.database;
    this.#ownsDatabase = opened.ownsDatabase;
  }

  async close(): Promise<void> {
    if (this.#ownsDatabase) {
      this.#database.close();
    }
  }

  async listVersions(seriesId: string): Promise<readonly StoreZhixuVersionRecord[]> {
    return this.#database.prepare(
      `SELECT *
       FROM store_zhixu_version_metadata
       WHERE series_id = ?
       ORDER BY created_at ASC, version_id ASC`
    ).all(seriesId).map((row) => versionRow(row));
  }

  async getVersion(seriesId: string, versionId: string): Promise<StoreZhixuVersionRecord | undefined> {
    const row = this.#database.prepare(
      `SELECT *
       FROM store_zhixu_version_metadata
       WHERE series_id = ? AND version_id = ?`
    ).get(seriesId, versionId);
    return row ? versionRow(row) : undefined;
  }

  async upsertVersion(record: StoreZhixuVersionRecord): Promise<void> {
    runSqliteWrite(() => {
      this.#database.prepare(
        `INSERT INTO store_zhixu_version_metadata (
           series_id, version_id, zhixu_id, version_label, status, plan_id,
           plan_hash, artifact_hash, created_at, cutover_at, cutover_reason
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
           cutover_reason = excluded.cutover_reason`
      ).run(...versionValues(record));
    });
  }
}

export class SqliteStoreDockingSessionStore implements StoreDockingSessionStore {
  readonly #database: SqliteDatabase;
  readonly #ownsDatabase: boolean;

  constructor(options: SqliteStoreMetadataStoreOptions) {
    const opened = openStoreMetadataDatabase(options, "SqliteStoreDockingSessionStore");
    this.#database = opened.database;
    this.#ownsDatabase = opened.ownsDatabase;
  }

  async close(): Promise<void> {
    if (this.#ownsDatabase) {
      this.#database.close();
    }
  }

  async createSession(session: StoreDockingSessionDTO): Promise<void> {
    runSqliteWrite(() => {
      this.#database.prepare(
        `INSERT INTO store_docking_session (
           session_id, source_zhixu_id, target_zhixu_id, source_version_id,
           target_version_id, status, draft_signal_map_json, validation_json,
           session_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(...dockingSessionValues(session));
    });
  }

  async getSession(sessionId: string): Promise<StoreDockingSessionDTO | undefined> {
    const row = this.#database.prepare(
      `SELECT session_json
       FROM store_docking_session
       WHERE session_id = ?`
    ).get(sessionId);
    return row ? dockingSessionRow(row) : undefined;
  }

  async updateSession(session: StoreDockingSessionDTO): Promise<void> {
    runSqliteWrite(() => {
      this.#database.prepare(
        `INSERT INTO store_docking_session (
           session_id, source_zhixu_id, target_zhixu_id, source_version_id,
           target_version_id, status, draft_signal_map_json, validation_json,
           session_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
           updated_at = excluded.updated_at`
      ).run(...dockingSessionValues(session));
    });
  }
}

function openStoreMetadataDatabase(
  options: SqliteStoreMetadataStoreOptions,
  label: string
): { readonly database: SqliteDatabase; readonly ownsDatabase: boolean } {
  if (!options.database && !options.databaseUrl) {
    throw new Error(`${label} requires database or databaseUrl`);
  }
  const database = options.database ?? openSqliteDatabase(options.databaseUrl!);
  if (options.migrations?.autoRun === true) {
    runSqliteMigrations({
      database,
      ...(options.migrations.directory ? { migrationsDirectory: options.migrations.directory } : {})
    });
  }
  return { database, ownsDatabase: !options.database };
}

function auditValues(record: StoreAuditRecord): readonly SqliteValue[] {
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

function draftValues(draft: StoreZhixuDraftRecord): readonly SqliteValue[] {
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

function versionValues(record: StoreZhixuVersionRecord): readonly SqliteValue[] {
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

function dockingSessionValues(session: StoreDockingSessionDTO): readonly SqliteValue[] {
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
