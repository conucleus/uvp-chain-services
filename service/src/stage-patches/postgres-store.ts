import { StorageConstraintError } from "../storage/errors.js";
import { parseStorageJson, stringifyStorageJson } from "../storage/json.js";
import { PostgresDatabase } from "../storage/postgres-client.js";
import type {
  PreparedPatchRecordBase,
  ProductStagePatchStore,
  StagePatchSubmissionBase,
  StagePatchSubmissionScanCursor
} from "./types.js";

export interface PostgresProductStagePatchStoreOptions {
  readonly databaseUrl?: string;
  readonly database?: PostgresDatabase;
  readonly migrations?: {
    readonly autoRun?: boolean;
    readonly directory?: string;
  };
}

export class PostgresProductStagePatchStore<
    TPrepared extends PreparedPatchRecordBase & { readonly deadline: string },
    TSubmission extends StagePatchSubmissionBase
  >
  implements ProductStagePatchStore<TPrepared, TSubmission>
{
  readonly #database: PostgresDatabase;
  readonly #ownsDatabase: boolean;
  readonly #patchKind: "executor" | "resource";

  constructor(options: PostgresProductStagePatchStoreOptions & { readonly patchKind: "executor" | "resource" }) {
    if (!options.database && !options.databaseUrl) {
      throw new Error("PostgresProductStagePatchStore requires database or databaseUrl");
    }
    this.#database = options.database ?? new PostgresDatabase({
      databaseUrl: options.databaseUrl!,
      ...(options.migrations ? { migrations: options.migrations } : {})
    });
    this.#ownsDatabase = !options.database;
    this.#patchKind = options.patchKind;
  }

  async close(): Promise<void> {
    if (this.#ownsDatabase) {
      await this.#database.close();
    }
  }

  async putPrepared(record: TPrepared): Promise<void> {
    const now = new Date().toISOString();
    await this.#database.query(
      `INSERT INTO stage_patch_prepared (prepare_id, patch_kind, record_json, deadline_seconds, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $5)
       ON CONFLICT(prepare_id) DO UPDATE SET
         patch_kind = excluded.patch_kind,
         record_json = excluded.record_json,
         deadline_seconds = excluded.deadline_seconds,
         updated_at = excluded.updated_at`,
      [record.prepareId, this.#patchKind, stringifyStorageJson(record), deadlineSecondsOf(record.deadline), now]
    );
  }

  async deleteExpiredPrepared(deadlineBeforeSeconds: string): Promise<number> {
    const result = await this.#database.query(
      `DELETE FROM stage_patch_prepared
       WHERE deadline_seconds < $1::bigint`,
      [deadlineSecondsOf(deadlineBeforeSeconds)]
    );
    return result.rowCount ?? 0;
  }

  async getPrepared(prepareId: string): Promise<TPrepared | undefined> {
    const result = await this.#database.query(
      "SELECT record_json AS \"recordJson\" FROM stage_patch_prepared WHERE prepare_id = $1",
      [prepareId]
    );
    const row = result.rows[0] as { readonly recordJson?: string } | undefined;
    return row?.recordJson ? parseStorageJson<TPrepared>(row.recordJson) : undefined;
  }

  async markPreparedUsed(prepareId: string, submissionId: string, usedAt: string): Promise<void> {
    const existing = await this.getPrepared(prepareId);
    if (!existing) {
      return;
    }
    await this.#database.query(
      `UPDATE stage_patch_prepared
       SET record_json = $1, updated_at = $2
       WHERE prepare_id = $3`,
      [stringifyStorageJson({ ...existing, submissionId, usedAt }), usedAt, prepareId]
    );
  }

  async withTransaction<T>(operation: () => Promise<T>): Promise<T> {
    return this.#database.withTransaction(operation);
  }

  async reserveNonce(key: string, options?: { readonly staleBefore?: string }): Promise<boolean> {
    const reservedAt = new Date().toISOString();
    try {
      await this.#database.query(
        `INSERT INTO stage_patch_nonce (nonce_key, created_at)
         VALUES ($1, $2)`,
        [key, reservedAt]
      );
      return true;
    } catch (error) {
      if (!(error instanceof StorageConstraintError)) {
        throw error;
      }
    }
    const staleBefore = options?.staleBefore;
    if (!staleBefore) {
      return false;
    }
    const result = await this.#database.query(
      `UPDATE stage_patch_nonce
       SET created_at = $1
       WHERE nonce_key = $2 AND created_at < $3`,
      [reservedAt, key, staleBefore]
    );
    return (result.rowCount ?? 0) === 1;
  }

  async releaseNonce(key: string): Promise<void> {
    await this.#database.query(
      "DELETE FROM stage_patch_nonce WHERE nonce_key = $1",
      [key]
    );
  }

  async putSubmission(submission: TSubmission): Promise<void> {
    const now = new Date().toISOString();
    await this.#database.query(
      `INSERT INTO stage_patch_submission (submission_id, patch_kind, record_json, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $4)
       ON CONFLICT(submission_id) DO UPDATE SET
         patch_kind = excluded.patch_kind,
         record_json = excluded.record_json,
         updated_at = excluded.updated_at`,
      [submission.submissionId, this.#patchKind, stringifyStorageJson(submission), now]
    );
  }

  async getSubmission(submissionId: string): Promise<TSubmission | undefined> {
    const result = await this.#database.query(
      "SELECT record_json::text AS \"recordJson\" FROM stage_patch_submission WHERE submission_id = $1",
      [submissionId]
    );
    const row = result.rows[0] as { readonly recordJson?: string } | undefined;
    return row?.recordJson ? parseStorageJson<TSubmission>(row.recordJson) : undefined;
  }

  async listOpenSubmissionsPage(
    after: StagePatchSubmissionScanCursor | undefined,
    limit: number
  ): Promise<readonly TSubmission[]> {
    const result = await this.#database.query(
      `SELECT record_json::text AS "recordJson" FROM stage_patch_submission
       WHERE (record_json::jsonb->>'status' IN ('broadcasting', 'submitted')
              OR (record_json::jsonb->>'status' = 'failed'
                  AND record_json::jsonb->>'txHash' IS NOT NULL))
         AND ($1::text IS NULL
              OR created_at > $1
              OR (created_at = $1 AND submission_id > $2))
       ORDER BY created_at ASC, submission_id ASC
       LIMIT $3`,
      [after?.createdAt ?? null, after?.submissionId ?? null, limit]
    );
    return (result.rows as { readonly recordJson?: string }[])
      .filter((row) => Boolean(row.recordJson))
      .map((row) => parseStorageJson<TSubmission>(row.recordJson!));
  }
}

function deadlineSecondsOf(deadline: string): number {
  const parsed = Number(deadline);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`stage patch prepare deadline must be a unix-seconds string, got: ${deadline}`);
  }
  return Math.floor(parsed);
}
