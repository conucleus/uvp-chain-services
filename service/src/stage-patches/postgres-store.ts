import { parseStorageJson, stringifyStorageJson } from "../storage/json.js";
import { PostgresDatabase } from "../storage/postgres-client.js";
import type {
  PreparedPatchRecordBase,
  ProductStagePatchStore,
  StagePatchSubmissionBase
} from "./types.js";

export interface PostgresProductStagePatchStoreOptions {
  readonly databaseUrl?: string;
  readonly database?: PostgresDatabase;
  readonly migrations?: {
    readonly autoRun?: boolean;
    readonly directory?: string;
  };
}

/**
 * stage-patch 状态的 postgres 持久化（表结构见
 * migrations/postgres/0019_stage_patch_state.sql）：nonce 预留靠
 * stage_patch_nonce 主键的 ON CONFLICT DO NOTHING 提供跨实例 CAS，
 * 多实例共享库不双播同一 patchNonce。
 */
export class PostgresProductStagePatchStore<
    TPrepared extends PreparedPatchRecordBase,
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
      `INSERT INTO stage_patch_prepared (prepare_id, patch_kind, record_json, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $4)
       ON CONFLICT(prepare_id) DO UPDATE SET
         patch_kind = excluded.patch_kind,
         record_json = excluded.record_json,
         updated_at = excluded.updated_at`,
      [record.prepareId, this.#patchKind, stringifyStorageJson(record), now]
    );
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

  async reserveNonce(key: string): Promise<boolean> {
    const result = await this.#database.query(
      `INSERT INTO stage_patch_nonce (nonce_key, created_at)
       VALUES ($1, $2)
       ON CONFLICT(nonce_key) DO NOTHING`,
      [key, new Date().toISOString()]
    );
    return (result.rowCount ?? 0) > 0;
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
      "SELECT record_json AS \"recordJson\" FROM stage_patch_submission WHERE submission_id = $1",
      [submissionId]
    );
    const row = result.rows[0] as { readonly recordJson?: string } | undefined;
    return row?.recordJson ? parseStorageJson<TSubmission>(row.recordJson) : undefined;
  }
}
