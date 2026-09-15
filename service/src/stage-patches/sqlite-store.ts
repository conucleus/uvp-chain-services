import { StorageConstraintError } from "../storage/errors.js";
import { parseStorageJson, stringifyStorageJson } from "../storage/json.js";
import { runSqliteMigrations } from "../storage/migrations.js";
import {
  openSqliteDatabase,
  runSqliteWrite,
  withSqliteTransaction,
  type SqliteDatabase
} from "../storage/sqlite.js";
import { rowObject, stringColumn } from "../storage/sqlite-rows.js";
import type {
  PreparedPatchRecordBase,
  ProductStagePatchStore,
  StagePatchSubmissionBase
} from "./types.js";

export interface SqliteProductStagePatchStoreOptions {
  readonly databaseUrl?: string;
  readonly database?: SqliteDatabase;
  /** 行别（executor/resource）：诊断与按类过滤用，不参与身份。 */
  readonly patchKind: "executor" | "resource";
  readonly migrations?: {
    readonly autoRun?: boolean;
    readonly directory?: string;
  };
}

/**
 * stage-patch 状态的 sqlite 持久化：prepared 记录与 submission
 * 台账按 JSON 记录整行存取（DTO 面宽、只按 id 点查），nonce 预留靠
 * stage_patch_nonce 主键的 INSERT ON CONFLICT DO NOTHING 提供跨实例
 * CAS——重启不丢已签名 prepare，多实例不双播同一 nonce。
 */
export class SqliteProductStagePatchStore<
    TPrepared extends PreparedPatchRecordBase & { readonly deadline: string },
    TSubmission extends StagePatchSubmissionBase
  >
  implements ProductStagePatchStore<TPrepared, TSubmission>
{
  readonly #database: SqliteDatabase;
  readonly #ownsDatabase: boolean;
  readonly #patchKind: "executor" | "resource";

  constructor(options: SqliteProductStagePatchStoreOptions) {
    if (options.database) {
      if (options.migrations?.autoRun === true) {
        runSqliteMigrations({
          database: options.database,
          ...(options.migrations.directory
            ? { migrationsDirectory: options.migrations.directory }
            : {})
        });
      }
      this.#database = options.database;
      this.#ownsDatabase = false;
    } else {
      if (!options.databaseUrl) {
        throw new Error(
          "SqliteProductStagePatchStore requires databaseUrl or a shared SqliteDatabase"
        );
      }
      const database = openSqliteDatabase(options.databaseUrl);
      if (options.migrations?.autoRun === true) {
        runSqliteMigrations({
          database,
          ...(options.migrations.directory
            ? { migrationsDirectory: options.migrations.directory }
            : {})
        });
      }
      this.#database = database;
      this.#ownsDatabase = true;
    }
    this.#patchKind = options.patchKind;
  }

  async close(): Promise<void> {
    if (this.#ownsDatabase) {
      this.#database.close();
    }
  }

  async putPrepared(record: TPrepared): Promise<void> {
    const now = new Date().toISOString();
    runSqliteWrite(() => {
      this.#database
        .prepare(
          `INSERT INTO stage_patch_prepared (prepare_id, patch_kind, record_json, deadline_seconds, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(prepare_id) DO UPDATE SET
             patch_kind = excluded.patch_kind,
             record_json = excluded.record_json,
             deadline_seconds = excluded.deadline_seconds,
             updated_at = excluded.updated_at`
        )
        .run(
          record.prepareId,
          this.#patchKind,
          stringifyStorageJson(record),
          deadlineSecondsOf(record.deadline),
          now,
          now
        );
    });
  }

  async deleteExpiredPrepared(deadlineBeforeSeconds: string): Promise<number> {
    // deadline 列随行写入（putPrepared），清扫不解析 record_json；持久表
    // 此前只进不出，prepare 入口无配额会让表无界堆叠。
    return runSqliteWrite(() =>
      this.#database
        .prepare(
          `DELETE FROM stage_patch_prepared
           WHERE deadline_seconds < ?`
        )
        .run(deadlineSecondsOf(deadlineBeforeSeconds)).changes
    );
  }

  async getPrepared(prepareId: string): Promise<TPrepared | undefined> {
    const row = this.#database
      .prepare("SELECT record_json AS recordJson FROM stage_patch_prepared WHERE prepare_id = ?")
      .get(prepareId);
    return row ? parseStorageJson<TPrepared>(stringColumn(rowObject(row), "recordJson")) : undefined;
  }

  async markPreparedUsed(prepareId: string, submissionId: string, usedAt: string): Promise<void> {
    runSqliteWrite(() => {
      const row = this.#database
        .prepare("SELECT record_json AS recordJson FROM stage_patch_prepared WHERE prepare_id = ?")
        .get(prepareId);
      if (!row) {
        return;
      }
      const current = parseStorageJson<TPrepared>(
        stringColumn(rowObject(row), "recordJson")
      );
      this.#database
        .prepare(
          `UPDATE stage_patch_prepared
           SET record_json = ?, updated_at = ?
           WHERE prepare_id = ?`
        )
        .run(
          stringifyStorageJson({ ...current, submissionId, usedAt }),
          usedAt,
          prepareId
        );
    });
  }

  async withTransaction<T>(operation: () => Promise<T>): Promise<T> {
    return withSqliteTransaction(this.#database, operation);
  }

  async reserveNonce(key: string, options?: { readonly staleBefore?: string }): Promise<boolean> {
    const reservedAt = new Date().toISOString();
    try {
      runSqliteWrite(() => {
        this.#database
          .prepare(
            `INSERT INTO stage_patch_nonce (nonce_key, created_at)
             VALUES (?, ?)`
          )
          .run(key, reservedAt);
      });
      return true;
    } catch (error) {
      if (!(error instanceof StorageConstraintError)) {
        throw error;
      }
    }
    // 条件 UPDATE 原子接管（对齐 submissions/sqlite-store 手法）：年龄判定
    // 在 WHERE 内完成，并发重试同 key 只有一个赢家。created_at 统一
    // toISOString 落库，字典序即时间序。
    const staleBefore = options?.staleBefore;
    if (!staleBefore) {
      return false;
    }
    const updated = runSqliteWrite(() =>
      this.#database
        .prepare(
          `UPDATE stage_patch_nonce
           SET created_at = ?
           WHERE nonce_key = ? AND created_at < ?`
        )
        .run(reservedAt, key, staleBefore)
    );
    return updated.changes === 1;
  }

  async releaseNonce(key: string): Promise<void> {
    runSqliteWrite(() => {
      this.#database
        .prepare("DELETE FROM stage_patch_nonce WHERE nonce_key = ?")
        .run(key);
    });
  }

  async putSubmission(submission: TSubmission): Promise<void> {
    const now = new Date().toISOString();
    runSqliteWrite(() => {
      this.#database
        .prepare(
          `INSERT INTO stage_patch_submission (submission_id, patch_kind, record_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(submission_id) DO UPDATE SET
             patch_kind = excluded.patch_kind,
             record_json = excluded.record_json,
             updated_at = excluded.updated_at`
        )
        .run(
          submission.submissionId,
          this.#patchKind,
          stringifyStorageJson(submission),
          now,
          now
        );
    });
  }

  async getSubmission(submissionId: string): Promise<TSubmission | undefined> {
    const row = this.#database
      .prepare("SELECT record_json AS recordJson FROM stage_patch_submission WHERE submission_id = ?")
      .get(submissionId);
    return row ? parseStorageJson<TSubmission>(stringColumn(rowObject(row), "recordJson")) : undefined;
  }
}

/** prepare 截止（unix 秒字符串）→ 数值列；非数值 deadline 是数据损坏，响亮失败。 */
function deadlineSecondsOf(deadline: string): number {
  const parsed = Number(deadline);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`stage patch prepare deadline must be a unix-seconds string, got: ${deadline}`);
  }
  return Math.floor(parsed);
}
