import { StorageConstraintError } from "../storage/errors.js";
import { parseStorageJson, stringifyStorageJson } from "../storage/json.js";
import { PostgresDatabase } from "../storage/postgres-client.js";
import {
  optionalStringColumn,
  rowObject,
  stringColumn
} from "../storage/postgres-rows.js";
import type {
  PreparedSubmissionRecord,
  ProductSubmissionAttemptDTO,
  ProductSubmissionDTO,
  ProductSubmissionStore
} from "./types.js";

export interface PostgresSubmissionStoreOptions {
  readonly databaseUrl?: string;
  readonly database?: PostgresDatabase;
  readonly migrations?: {
    readonly autoRun?: boolean;
    readonly directory?: string;
  };
}

export class PostgresSubmissionStore implements ProductSubmissionStore {
  readonly driver = "postgres" as const;

  readonly #database: PostgresDatabase;
  readonly #ownsDatabase: boolean;

  constructor(options: PostgresSubmissionStoreOptions) {
    if (!options.database && !options.databaseUrl) {
      throw new Error("PostgresSubmissionStore requires database or databaseUrl");
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

  async putPrepared(record: PreparedSubmissionRecord): Promise<void> {
    const timestamp = new Date().toISOString();
    await this.#database.query(
      `INSERT INTO submission (
         prepare_id, submission_id, task_id, order_id, onchain_order_id, stage_identifier,
         signal_name, source_id, signal_id, intent, payload_hash, payload_ref,
         idempotency_key, submitter, nonce, deadline, status, prepared_json,
         submission_json, used_at, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18::jsonb, $19::jsonb, $20, $21, $22)
       ON CONFLICT(prepare_id)
       DO UPDATE SET
         submission_id = excluded.submission_id,
         task_id = excluded.task_id,
         order_id = excluded.order_id,
         onchain_order_id = excluded.onchain_order_id,
         stage_identifier = excluded.stage_identifier,
         signal_name = excluded.signal_name,
         source_id = excluded.source_id,
         signal_id = excluded.signal_id,
         intent = excluded.intent,
         payload_hash = excluded.payload_hash,
         payload_ref = excluded.payload_ref,
         idempotency_key = excluded.idempotency_key,
         submitter = excluded.submitter,
         nonce = excluded.nonce,
         deadline = excluded.deadline,
         status = excluded.status,
         prepared_json = excluded.prepared_json,
         submission_json = excluded.submission_json,
         used_at = excluded.used_at,
         updated_at = excluded.updated_at`,
      [
        record.prepareId,
        record.submissionId ?? null,
        record.taskId,
        record.orderId,
        record.onchainOrderId,
        record.stageIdentifier,
        record.signalName,
        record.sourceId,
        record.signalId,
        record.intent,
        record.payloadHash,
        record.payloadRef,
        record.idempotencyKey,
        record.submitter,
        record.nonce,
        record.deadline,
        "prepared",
        stringifyStorageJson(record),
        null,
        record.usedAt ?? null,
        timestamp,
        timestamp
      ]
    );
  }

  async getPrepared(prepareId: string): Promise<PreparedSubmissionRecord | undefined> {
    const result = await this.#database.query(
      `SELECT prepared_json::text AS prepared_json, used_at, submission_id
       FROM submission
       WHERE prepare_id = $1`,
      [prepareId]
    );
    if (!result.rows[0]) {
      return undefined;
    }
    const record = rowObject(result.rows[0], "submission prepared query");
    const prepared = parseStorageJson<PreparedSubmissionRecord>(stringColumn(record, "prepared_json"));
    const usedAt = optionalStringColumn(record, "used_at");
    const submissionId = optionalStringColumn(record, "submission_id");
    return {
      ...prepared,
      ...(usedAt !== undefined ? { usedAt } : {}),
      ...(submissionId !== undefined ? { submissionId } : {})
    };
  }

  async markPreparedUsed(prepareId: string, submissionId: string, usedAt: string): Promise<void> {
    await this.#database.query(
      `UPDATE submission
       SET submission_id = $1, used_at = $2, updated_at = $3
       WHERE prepare_id = $4`,
      [submissionId, usedAt, usedAt, prepareId]
    );
  }

  async reserveNonce(key: string): Promise<boolean> {
    try {
      await this.#database.query(
        `INSERT INTO submission_nonce (nonce_key, reserved_at)
         VALUES ($1, $2)`,
        [key.toLowerCase(), new Date().toISOString()]
      );
      return true;
    } catch (error) {
      if (error instanceof StorageConstraintError) {
        return false;
      }
      throw error;
    }
  }

  async releaseNonce(key: string): Promise<void> {
    await this.#database.query(
      `DELETE FROM submission_nonce
       WHERE nonce_key = $1`,
      [key.toLowerCase()]
    );
  }

  async putSubmission(submission: ProductSubmissionDTO): Promise<void> {
    await this.withTransaction(async () => {
      const existing = await this.#database.query(
        `SELECT prepared_json::text AS prepared_json, created_at
         FROM submission
         WHERE prepare_id = $1`,
        [submission.prepareId]
      );
      const existingRecord = existing.rows[0] ? rowObject(existing.rows[0], "submission existing query") : undefined;
      const preparedJson = existingRecord
        ? stringColumn(existingRecord, "prepared_json")
        : stringifyStorageJson(submission);
      const createdAt = existingRecord ? stringColumn(existingRecord, "created_at") : submission.createdAt;

      await this.#database.query(
        `INSERT INTO submission (
           prepare_id, submission_id, task_id, order_id, onchain_order_id, stage_identifier,
           signal_name, source_id, signal_id, intent, payload_hash, payload_ref,
           idempotency_key, submitter, nonce, deadline, status, prepared_json,
           submission_json, used_at, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18::jsonb, $19::jsonb, $20, $21, $22)
         ON CONFLICT(prepare_id)
         DO UPDATE SET
           submission_id = excluded.submission_id,
           task_id = excluded.task_id,
           order_id = excluded.order_id,
           onchain_order_id = excluded.onchain_order_id,
           stage_identifier = excluded.stage_identifier,
           signal_name = excluded.signal_name,
           source_id = excluded.source_id,
           signal_id = excluded.signal_id,
           intent = excluded.intent,
           payload_hash = excluded.payload_hash,
           payload_ref = excluded.payload_ref,
           idempotency_key = excluded.idempotency_key,
           submitter = excluded.submitter,
           nonce = excluded.nonce,
           deadline = excluded.deadline,
           status = excluded.status,
           prepared_json = excluded.prepared_json,
           submission_json = excluded.submission_json,
           used_at = excluded.used_at,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at`,
        [
          submission.prepareId,
          submission.submissionId,
          submission.taskId,
          submission.orderId,
          submission.onchainOrderId,
          submission.stageIdentifier,
          submission.signalName,
          submission.sourceId,
          submission.signalId,
          submission.intent,
          submission.payloadHash,
          submission.payloadRef,
          submission.idempotencyKey,
          submission.submitter,
          submission.nonce,
          submission.deadline,
          submission.status,
          preparedJson,
          stringifyStorageJson(submission),
          submission.updatedAt,
          createdAt,
          submission.updatedAt
        ]
      );

      await this.#database.query(
        `DELETE FROM submission_attempt
         WHERE submission_id = $1`,
        [submission.submissionId]
      );
      for (const attempt of submission.attempts) {
        await this.#database.query(
          `INSERT INTO submission_attempt (
             attempt_id, submission_id, order_id, source_id, signal_id, submitter,
             tx_hash, block_number, status, error_code, error_message, revert_reason,
             gas_payer, attempt_number, retryable, retry_state, dead_letter,
             next_retry_at, attempt_json, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19::jsonb, $20, $21)`,
          [
            attempt.attemptId,
            attempt.submissionId,
            attempt.orderId,
            attempt.sourceId,
            attempt.signalId,
            attempt.submitter,
            attempt.txHash ?? null,
            attempt.blockNumber ?? null,
            attempt.status,
            attempt.errorCode ?? null,
            attempt.errorMessage ?? null,
            attempt.revertReason ?? null,
            attempt.gasPayer ?? null,
            attempt.attemptNumber,
            attempt.retryable,
            attempt.retryState,
            attempt.deadLetter,
            attempt.nextRetryAt ?? null,
            stringifyStorageJson(attempt),
            attempt.createdAt,
            attempt.updatedAt
          ]
        );
      }
    });
  }

  async getSubmission(submissionId: string): Promise<ProductSubmissionDTO | undefined> {
    const result = await this.#database.query(
      `SELECT submission_json::text AS submission_json
       FROM submission
       WHERE submission_id = $1`,
      [submissionId]
    );
    if (!result.rows[0]) {
      return undefined;
    }
    const record = rowObject(result.rows[0], "submission query");
    const stored = parseStorageJson<ProductSubmissionDTO>(stringColumn(record, "submission_json"));
    const attemptResult = await this.#database.query(
      `SELECT attempt_json::text AS attempt_json
       FROM submission_attempt
       WHERE submission_id = $1
       ORDER BY attempt_number ASC, attempt_id ASC`,
      [submissionId]
    );
    const attempts = attemptResult.rows.map((attemptRow) =>
      parseStorageJson<ProductSubmissionAttemptDTO>(
        stringColumn(rowObject(attemptRow, "submission_attempt query"), "attempt_json")
      )
    );
    return {
      ...stored,
      attempts,
      attemptCount: attempts.length
    };
  }

  async listSubmissions(): Promise<readonly ProductSubmissionDTO[]> {
    const result = await this.#database.query(
      `SELECT submission_id, submission_json::text AS submission_json
       FROM submission
       WHERE submission_id IS NOT NULL AND submission_json IS NOT NULL
       ORDER BY created_at ASC, submission_id ASC`
    );
    const submissions = result.rows.map((row) => {
      const record = rowObject(row, "submission list query");
      return {
        submissionId: stringColumn(record, "submission_id"),
        submission: parseStorageJson<ProductSubmissionDTO>(stringColumn(record, "submission_json"))
      };
    });
    if (submissions.length === 0) {
      return [];
    }

    const attemptsBySubmission = new Map<string, ProductSubmissionAttemptDTO[]>();
    const placeholders = submissions.map((_submission, index) => `$${index + 1}`).join(", ");
    const attemptResult = await this.#database.query(
      `SELECT submission_id, attempt_json::text AS attempt_json
       FROM submission_attempt
       WHERE submission_id IN (${placeholders})
       ORDER BY submission_id ASC, attempt_number ASC, attempt_id ASC`,
      submissions.map((submission) => submission.submissionId)
    );
    for (const row of attemptResult.rows) {
      const record = rowObject(row, "submission_attempt list query");
      const submissionId = stringColumn(record, "submission_id");
      const attempts = attemptsBySubmission.get(submissionId) ?? [];
      attempts.push(parseStorageJson<ProductSubmissionAttemptDTO>(stringColumn(record, "attempt_json")));
      attemptsBySubmission.set(submissionId, attempts);
    }

    const hydrated: ProductSubmissionDTO[] = [];
    for (const { submissionId, submission } of submissions) {
      const attempts = attemptsBySubmission.get(submissionId) ?? [];
      hydrated.push({
        ...submission,
        attempts,
        attemptCount: attempts.length
      });
    }
    return hydrated;
  }
}
