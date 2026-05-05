import { parseStorageJson, stringifyStorageJson } from "../storage/json.js";
import { PostgresDatabase } from "../storage/postgres-client.js";
import {
  rowObject,
  stringColumn
} from "../storage/postgres-rows.js";
import type {
  GovernanceReviewDTO,
  GovernanceSubjectType,
  GovernanceTxLogDTO,
  PlanAttestationLogDTO,
  SupplierAttestationLogDTO
} from "./types.js";
import type { GovernanceReviewQuery, GovernanceStore } from "./store.js";

export interface PostgresGovernanceStoreOptions {
  readonly databaseUrl?: string;
  readonly database?: PostgresDatabase;
  readonly migrations?: {
    readonly autoRun?: boolean;
    readonly directory?: string;
  };
}

export class PostgresGovernanceStore implements GovernanceStore {
  readonly driver = "postgres" as const;

  readonly #database: PostgresDatabase;
  readonly #ownsDatabase: boolean;

  constructor(options: PostgresGovernanceStoreOptions) {
    if (!options.database && !options.databaseUrl) {
      throw new Error("PostgresGovernanceStore requires database or databaseUrl");
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

  async withTransaction<T>(operation: () => Promise<T>): Promise<T> {
    return this.#database.withTransaction(operation);
  }

  async listReviews(query: GovernanceReviewQuery = {}): Promise<readonly GovernanceReviewDTO[]> {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (query.subjectType) {
      values.push(query.subjectType);
      clauses.push(`subject_type = $${values.length}`);
    }
    if (query.subjectId) {
      values.push(query.subjectId);
      clauses.push(`subject_id = $${values.length}`);
    }
    if (query.status) {
      values.push(query.status);
      clauses.push(`status = $${values.length}`);
    }

    const result = await this.#database.query(
      `SELECT *, risk_tags_json::text AS risk_tags_json
       FROM governance_review
       ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
       ORDER BY updated_at DESC, review_id DESC`,
      values
    );
    return result.rows.map((row) => reviewRow(row));
  }

  async getReview(reviewId: string): Promise<GovernanceReviewDTO | undefined> {
    const result = await this.#database.query(
      `SELECT *, risk_tags_json::text AS risk_tags_json
       FROM governance_review
       WHERE review_id = $1`,
      [reviewId]
    );
    return result.rows[0] ? reviewRow(result.rows[0]) : undefined;
  }

  async putReview(review: GovernanceReviewDTO): Promise<void> {
    await this.#database.query(
      `INSERT INTO governance_review (
         review_id, subject_type, subject_id, status, risk_level, risk_tags_json,
         public_summary, internal_notes, policy_hash, metadata_hash, metadata_uri,
         reviewer, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, $14)
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
         updated_at = excluded.updated_at`,
      [
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
      ]
    );
  }

  async findLatestReview(
    subjectType: GovernanceSubjectType,
    subjectId: string
  ): Promise<GovernanceReviewDTO | undefined> {
    return (await this.listReviews({ subjectType, subjectId }))[0];
  }

  async listPlanAttestationLogs(): Promise<readonly PlanAttestationLogDTO[]> {
    const result = await this.#database.query(
      `SELECT log_json::text AS log_json
       FROM governance_tx_log
       WHERE log_kind = 'plan'
       ORDER BY created_at DESC, log_id DESC`
    );
    return result.rows.map((row) => parseTxLogRow(row) as PlanAttestationLogDTO);
  }

  async appendPlanAttestationLog(log: PlanAttestationLogDTO): Promise<void> {
    await this.#upsertTxLog("plan", log);
  }

  async listSupplierAttestationLogs(): Promise<readonly SupplierAttestationLogDTO[]> {
    const result = await this.#database.query(
      `SELECT log_json::text AS log_json
       FROM governance_tx_log
       WHERE log_kind = 'supplier'
       ORDER BY created_at DESC, log_id DESC`
    );
    return result.rows.map((row) => parseTxLogRow(row) as SupplierAttestationLogDTO);
  }

  async appendSupplierAttestationLog(log: SupplierAttestationLogDTO): Promise<void> {
    await this.#upsertTxLog("supplier", log);
  }

  async getTxLog(txLogId: string): Promise<GovernanceTxLogDTO | undefined> {
    const result = await this.#database.query(
      `SELECT log_json::text AS log_json
       FROM governance_tx_log
       WHERE tx_log_id = $1 OR log_id = $2`,
      [txLogId, txLogId]
    );
    return result.rows[0] ? parseTxLogRow(result.rows[0]) : undefined;
  }

  async updateTxLog(log: GovernanceTxLogDTO): Promise<void> {
    const kind = log.action === "attest_plan" || log.action === "revoke_plan" ? "plan" : "supplier";
    await this.#upsertTxLog(kind, log);
  }

  async #upsertTxLog(kind: "plan" | "supplier", log: PlanAttestationLogDTO | SupplierAttestationLogDTO): Promise<void> {
    const planLog = kind === "plan" ? log as PlanAttestationLogDTO : undefined;
    const supplierLog = kind === "supplier" ? log as SupplierAttestationLogDTO : undefined;
    await this.#database.query(
      `INSERT INTO governance_tx_log (
         log_id, tx_log_id, log_kind, action, subject_id, plan_id,
         supplier_subject_id, wallet, plan_hash, artifact_hash, policy_hash,
         metadata_hash, metadata_uri, reason_hash, reason_uri, tx_hash,
         block_number, signer, requester, status, broadcast_status, error_code,
         error_message, retryable, request_json, log_json, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25::jsonb, $26::jsonb, $27, $28)
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
         updated_at = excluded.updated_at`,
      [
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
        log.retryable,
        stringifyStorageJson(log.request),
        stringifyStorageJson(log),
        log.createdAt,
        log.updatedAt
      ]
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
