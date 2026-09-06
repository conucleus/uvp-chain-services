import { parseStorageJson, stringifyStorageJson } from "../storage/json.js";
import { PostgresDatabase } from "../storage/postgres-client.js";
import {
  optionalStringColumn,
  rowObject,
  stringColumn
} from "../storage/postgres-rows.js";
import type {
  GovernanceReviewDTO,
  GovernanceSubjectType,
  GovernanceTxLogDTO,
  IdentityTxLogDTO
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
      `SELECT *, risk_tags_json::text AS risk_tags_json,
              metadata_document_json::text AS metadata_document_json,
              policy_document_json::text AS policy_document_json
       FROM governance_review
       ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
       ORDER BY updated_at DESC, review_id DESC`,
      values
    );
    return result.rows.map((row) => reviewRow(row));
  }

  async getReview(reviewId: string): Promise<GovernanceReviewDTO | undefined> {
    const result = await this.#database.query(
      `SELECT *, risk_tags_json::text AS risk_tags_json,
              metadata_document_json::text AS metadata_document_json,
              policy_document_json::text AS policy_document_json
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
         reviewer, created_at, updated_at, metadata_document_json, policy_document_json
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16::jsonb)
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
         updated_at = excluded.updated_at,
         metadata_document_json = excluded.metadata_document_json,
         policy_document_json = excluded.policy_document_json`,
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
        review.updatedAt,
        review.metadataDocument !== undefined ? stringifyStorageJson(review.metadataDocument) : null,
        review.policyDocument !== undefined ? stringifyStorageJson(review.policyDocument) : null
      ]
    );
  }

  async findLatestReview(
    subjectType: GovernanceSubjectType,
    subjectId: string
  ): Promise<GovernanceReviewDTO | undefined> {
    return (await this.listReviews({ subjectType, subjectId }))[0];
  }

  async listIdentityTxLogs(): Promise<readonly IdentityTxLogDTO[]> {
    const result = await this.#database.query(
      `SELECT log_json::text AS log_json
       FROM governance_tx_log
       ORDER BY created_at DESC, log_id DESC`
    );
    return result.rows.map((row) => parseTxLogRow(row) as IdentityTxLogDTO);
  }

  async appendIdentityTxLog(log: IdentityTxLogDTO): Promise<void> {
    await this.#upsertTxLog(log);
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
    await this.#upsertTxLog(log);
  }

  async #upsertTxLog(log: IdentityTxLogDTO): Promise<void> {
    await this.#database.query(
      `INSERT INTO governance_tx_log (
         log_id, tx_log_id, action, subject_id, account, descriptor_hash,
         descriptor_uri, binding_id, reason_hash, reason_uri, tx_hash,
         block_number, signer, requester, status, broadcast_status, error_code,
         error_message, retryable, request_json, log_json, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20::jsonb, $21::jsonb, $22, $23)
       ON CONFLICT(log_id)
       DO UPDATE SET
         tx_log_id = excluded.tx_log_id,
         action = excluded.action,
         subject_id = excluded.subject_id,
         account = excluded.account,
         descriptor_hash = excluded.descriptor_hash,
         descriptor_uri = excluded.descriptor_uri,
         binding_id = excluded.binding_id,
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
        log.action,
        log.subjectId,
        log.account ?? null,
        log.descriptorHash ?? null,
        log.descriptorURI ?? null,
        log.bindingId ?? null,
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
  const metadataDocumentJson = optionalStringColumn(record, "metadata_document_json");
  const policyDocumentJson = optionalStringColumn(record, "policy_document_json");
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
    updatedAt: stringColumn(record, "updated_at"),
    ...(metadataDocumentJson !== undefined ? { metadataDocument: parseStorageJson(metadataDocumentJson) } : {}),
    ...(policyDocumentJson !== undefined ? { policyDocument: parseStorageJson(policyDocumentJson) } : {})
  };
}

function parseTxLogRow(row: unknown): GovernanceTxLogDTO {
  const record = rowObject(row, "governance_tx_log query");
  return parseStorageJson<GovernanceTxLogDTO>(stringColumn(record, "log_json"));
}
