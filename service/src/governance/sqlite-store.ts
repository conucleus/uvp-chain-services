import { parseStorageJson, stringifyStorageJson } from "../storage/json.js";
import { runSqliteMigrations } from "../storage/migrations.js";
import {
  openSqliteDatabase,
  runSqliteWrite,
  withSqliteTransaction,
  type SqliteDatabase,
  type SqliteValue
} from "../storage/sqlite.js";
import {
  booleanColumn,
  optionalStringColumn,
  rowObject,
  stringColumn
} from "../storage/sqlite-rows.js";
import type {
  GovernanceReviewDTO,
  GovernanceSubjectType,
  GovernanceTxLogDTO,
  PlanAttestationLogDTO,
  SupplierAttestationLogDTO
} from "./types.js";
import type { GovernanceReviewQuery, GovernanceStore } from "./store.js";

export interface SqliteGovernanceStoreOptions {
  readonly databaseUrl?: string;
  readonly database?: SqliteDatabase;
  readonly migrations?: {
    readonly autoRun?: boolean;
    readonly directory?: string;
  };
}

export class SqliteGovernanceStore implements GovernanceStore {
  readonly #database: SqliteDatabase;
  readonly #ownsDatabase: boolean;

  constructor(options: SqliteGovernanceStoreOptions) {
    if (!options.database && !options.databaseUrl) {
      throw new Error("SqliteGovernanceStore requires database or databaseUrl");
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

  async withTransaction<T>(operation: () => Promise<T>): Promise<T> {
    return withSqliteTransaction(this.#database, operation);
  }

  async listReviews(query: GovernanceReviewQuery = {}): Promise<readonly GovernanceReviewDTO[]> {
    const clauses: string[] = [];
    const values: SqliteValue[] = [];
    if (query.subjectType) {
      clauses.push("subject_type = ?");
      values.push(query.subjectType);
    }
    if (query.subjectId) {
      clauses.push("subject_id = ?");
      values.push(query.subjectId);
    }
    if (query.status) {
      clauses.push("status = ?");
      values.push(query.status);
    }

    return this.#database.prepare(
      `SELECT *
       FROM governance_review
       ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
       ORDER BY updated_at DESC, review_id DESC`
    ).all(...values).map((row) => reviewRow(row));
  }

  async getReview(reviewId: string): Promise<GovernanceReviewDTO | undefined> {
    const row = this.#database.prepare(
      `SELECT *
       FROM governance_review
       WHERE review_id = ?`
    ).get(reviewId);
    return row ? reviewRow(row) : undefined;
  }

  async putReview(review: GovernanceReviewDTO): Promise<void> {
    runSqliteWrite(() => {
      this.#database.prepare(
        `INSERT INTO governance_review (
           review_id, subject_type, subject_id, status, risk_level, risk_tags_json,
           public_summary, internal_notes, policy_hash, metadata_hash, metadata_uri,
           reviewer, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(review_id)
         DO UPDATE SET
           subject_type = excluded.subject_type,
           subject_id = excluded.subject_id,
           status = excluded.status,
           risk_level = excluded.risk_level,
           risk_tags_json = excluded.risk_tags_json,
           public_summary = excluded.public_summary,
           internal_notes = excluded.internal_notes,
           policy_hash = excluded.policy_hash,
           metadata_hash = excluded.metadata_hash,
           metadata_uri = excluded.metadata_uri,
           reviewer = excluded.reviewer,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at`
      ).run(
        review.reviewId,
        review.subjectType,
        review.subjectId,
        review.status,
        review.riskLevel,
        stringifyStorageJson(review.riskTags),
        review.publicSummary,
        review.internalNotes,
        review.policyHash,
        review.metadataHash,
        review.metadataURI,
        review.reviewer,
        review.createdAt,
        review.updatedAt
      );
    });
  }

  async findLatestReview(
    subjectType: GovernanceSubjectType,
    subjectId: string
  ): Promise<GovernanceReviewDTO | undefined> {
    return (await this.listReviews({ subjectType, subjectId }))[0];
  }

  async listPlanAttestationLogs(): Promise<readonly PlanAttestationLogDTO[]> {
    return this.#database.prepare(
      `SELECT log_json
       FROM governance_tx_log
       WHERE log_kind = 'plan'
       ORDER BY created_at DESC, log_id DESC`
    ).all().map((row) => parseTxLogRow(row) as PlanAttestationLogDTO);
  }

  async appendPlanAttestationLog(log: PlanAttestationLogDTO): Promise<void> {
    runSqliteWrite(() => this.#upsertTxLog("plan", log));
  }

  async listSupplierAttestationLogs(): Promise<readonly SupplierAttestationLogDTO[]> {
    return this.#database.prepare(
      `SELECT log_json
       FROM governance_tx_log
       WHERE log_kind = 'supplier'
       ORDER BY created_at DESC, log_id DESC`
    ).all().map((row) => parseTxLogRow(row) as SupplierAttestationLogDTO);
  }

  async appendSupplierAttestationLog(log: SupplierAttestationLogDTO): Promise<void> {
    runSqliteWrite(() => this.#upsertTxLog("supplier", log));
  }

  async getTxLog(txLogId: string): Promise<GovernanceTxLogDTO | undefined> {
    const row = this.#database.prepare(
      `SELECT log_json
       FROM governance_tx_log
       WHERE tx_log_id = ? OR log_id = ?`
    ).get(txLogId, txLogId);
    return row ? parseTxLogRow(row) : undefined;
  }

  async updateTxLog(log: GovernanceTxLogDTO): Promise<void> {
    const kind = log.action === "attest_plan" || log.action === "revoke_plan" ? "plan" : "supplier";
    runSqliteWrite(() => this.#upsertTxLog(kind, log));
  }

  #upsertTxLog(kind: "plan" | "supplier", log: PlanAttestationLogDTO | SupplierAttestationLogDTO): void {
    const planLog = kind === "plan" ? log as PlanAttestationLogDTO : undefined;
    const supplierLog = kind === "supplier" ? log as SupplierAttestationLogDTO : undefined;
    this.#database.prepare(
      `INSERT INTO governance_tx_log (
         log_id, tx_log_id, log_kind, action, subject_id, plan_id,
         supplier_subject_id, wallet, plan_hash, artifact_hash, policy_hash,
         metadata_hash, metadata_uri, reason_hash, reason_uri, tx_hash,
         block_number, signer, requester, status, broadcast_status, error_code,
         error_message, retryable, request_json, log_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(log_id)
       DO UPDATE SET
         tx_log_id = excluded.tx_log_id,
         log_kind = excluded.log_kind,
         action = excluded.action,
         subject_id = excluded.subject_id,
         plan_id = excluded.plan_id,
         supplier_subject_id = excluded.supplier_subject_id,
         wallet = excluded.wallet,
         plan_hash = excluded.plan_hash,
         artifact_hash = excluded.artifact_hash,
         policy_hash = excluded.policy_hash,
         metadata_hash = excluded.metadata_hash,
         metadata_uri = excluded.metadata_uri,
         reason_hash = excluded.reason_hash,
         reason_uri = excluded.reason_uri,
         tx_hash = excluded.tx_hash,
         block_number = excluded.block_number,
         signer = excluded.signer,
         requester = excluded.requester,
         status = excluded.status,
         broadcast_status = excluded.broadcast_status,
         error_code = excluded.error_code,
         error_message = excluded.error_message,
         retryable = excluded.retryable,
         request_json = excluded.request_json,
         log_json = excluded.log_json,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at`
    ).run(
      log.logId,
      log.txLogId,
      kind,
      log.action,
      log.subjectId,
      planLog?.planId ?? null,
      supplierLog?.supplierSubjectId ?? null,
      supplierLog?.wallet ?? null,
      planLog?.planHash ?? null,
      planLog?.artifactHash ?? null,
      planLog?.policyHash ?? null,
      log.metadataHash ?? null,
      log.metadataURI ?? null,
      log.reasonHash ?? null,
      log.reasonURI ?? null,
      log.txHash ?? null,
      log.blockNumber ?? null,
      log.signer ?? null,
      log.requester,
      log.status,
      log.broadcastStatus,
      log.errorCode ?? null,
      log.errorMessage ?? null,
      log.retryable ? 1 : 0,
      stringifyStorageJson(log.request),
      stringifyStorageJson(log),
      log.createdAt,
      log.updatedAt
    );
  }
}

function reviewRow(row: unknown): GovernanceReviewDTO {
  const record = rowObject(row, "governance_review query");
  return {
    reviewId: stringColumn(record, "review_id"),
    subjectType: stringColumn(record, "subject_type") as GovernanceReviewDTO["subjectType"],
    subjectId: stringColumn(record, "subject_id"),
    status: stringColumn(record, "status") as GovernanceReviewDTO["status"],
    riskLevel: stringColumn(record, "risk_level"),
    riskTags: parseStorageJson<readonly string[]>(stringColumn(record, "risk_tags_json")),
    publicSummary: stringColumn(record, "public_summary"),
    internalNotes: stringColumn(record, "internal_notes"),
    policyHash: stringColumn(record, "policy_hash") as GovernanceReviewDTO["policyHash"],
    metadataHash: stringColumn(record, "metadata_hash") as GovernanceReviewDTO["metadataHash"],
    metadataURI: stringColumn(record, "metadata_uri"),
    reviewer: stringColumn(record, "reviewer"),
    createdAt: stringColumn(record, "created_at"),
    updatedAt: stringColumn(record, "updated_at")
  };
}

function parseTxLogRow(row: unknown): GovernanceTxLogDTO {
  const record = rowObject(row, "governance_tx_log query");
  return parseStorageJson<GovernanceTxLogDTO>(stringColumn(record, "log_json"));
}
