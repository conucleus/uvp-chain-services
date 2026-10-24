// 订单要求包 sqlite 持久化（迁移 0030_order_requirements.sql）：声明行按
// draftId 唯一，合意按 (draftId, wallet) 唯一；声明 upsert 与旧合意清理在
// 同一事务内完成。

import type { OrderRequirementsDeclarationDTO } from "@uvp-eth/product-dto";
import { parseStorageJson, stringifyStorageJson } from "../../storage/json.js";
import { runSqliteMigrations } from "../../storage/migrations.js";
import { rowObject, stringColumn } from "../../storage/sqlite-rows.js";
import {
  openSqliteDatabase,
  runSqliteWrite,
  withSqliteTransaction,
  type SqliteDatabase,
} from "../../storage/sqlite.js";
import type { Address, Hex } from "../../shared/types.js";
import type {
  OrderRequirementBundleRecord,
  OrderRequirementConsentRecord,
  OrderRequirementsStore,
} from "./types.js";

export interface SqliteOrderRequirementsStoreOptions {
  readonly databaseUrl?: string;
  readonly database?: SqliteDatabase;
  readonly migrations?: {
    readonly autoRun?: boolean;
    readonly directory?: string;
  };
}

export class SqliteOrderRequirementsStore implements OrderRequirementsStore {
  readonly #database: SqliteDatabase;
  readonly #ownsDatabase: boolean;

  constructor(options: SqliteOrderRequirementsStoreOptions) {
    if (!options.database && !options.databaseUrl) {
      throw new Error(
        "SqliteOrderRequirementsStore requires database or databaseUrl",
      );
    }
    this.#database =
      options.database ?? openSqliteDatabase(options.databaseUrl!);
    this.#ownsDatabase = !options.database;
    if (options.migrations?.autoRun === true) {
      runSqliteMigrations({
        database: this.#database,
        ...(options.migrations.directory
          ? { migrationsDirectory: options.migrations.directory }
          : {}),
      });
    }
  }

  async close(): Promise<void> {
    if (this.#ownsDatabase) {
      this.#database.close();
    }
  }

  async getBundle(
    draftId: string,
  ): Promise<OrderRequirementBundleRecord | undefined> {
    const row = this.#database
      .prepare(
        `SELECT *
         FROM order_requirement_bundle
         WHERE draft_id = ?`,
      )
      .get(draftId);
    return row ? bundleRow(row) : undefined;
  }

  async saveBundle(record: OrderRequirementBundleRecord): Promise<void> {
    await withSqliteTransaction(this.#database, async () => {
      runSqliteWrite(() => {
        this.#database
          .prepare(
            `INSERT INTO order_requirement_bundle (
               draft_id, schema_version, declaration_json, requirements_hash,
               declared_by, declared_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(draft_id) DO UPDATE SET
               schema_version = excluded.schema_version,
               declaration_json = excluded.declaration_json,
               requirements_hash = excluded.requirements_hash,
               declared_by = excluded.declared_by,
               declared_at = excluded.declared_at,
               updated_at = excluded.updated_at`,
          )
          .run(
            record.draftId,
            record.declaration.schemaVersion,
            stringifyStorageJson(record.declaration),
            record.requirementsHash,
            record.declaredBy,
            record.declaredAt,
            record.updatedAt,
          );
        // 合意只对签名时的 hash 有效：包内容变了旧合意即作废。
        this.#database
          .prepare(
            `DELETE FROM order_requirement_consent
             WHERE draft_id = ? AND requirements_hash <> ?`,
          )
          .run(record.draftId, record.requirementsHash);
      });
    });
  }

  async listConsents(
    draftId: string,
  ): Promise<readonly OrderRequirementConsentRecord[]> {
    return this.#database
      .prepare(
        `SELECT *
         FROM order_requirement_consent
         WHERE draft_id = ?
         ORDER BY created_at ASC, wallet_address ASC`,
      )
      .all(draftId)
      .map((row) => consentRow(row));
  }

  async saveConsent(record: OrderRequirementConsentRecord): Promise<void> {
    runSqliteWrite(() => {
      this.#database
        .prepare(
          `INSERT INTO order_requirement_consent (
             consent_id, draft_id, wallet_address, requirements_hash,
             signature, signed_at, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(draft_id, wallet_address) DO UPDATE SET
             consent_id = excluded.consent_id,
             requirements_hash = excluded.requirements_hash,
             signature = excluded.signature,
             signed_at = excluded.signed_at,
             created_at = excluded.created_at`,
        )
        .run(
          record.consentId,
          record.draftId,
          record.walletAddress,
          record.requirementsHash,
          record.signature,
          record.signedAt,
          record.createdAt,
        );
    });
  }
}

function bundleRow(row: unknown): OrderRequirementBundleRecord {
  const record = rowObject(row, "order_requirement_bundle query");
  return {
    draftId: stringColumn(record, "draft_id"),
    declaration: parseStorageJson<OrderRequirementsDeclarationDTO>(
      stringColumn(record, "declaration_json"),
    ),
    requirementsHash: stringColumn(record, "requirements_hash") as Hex,
    declaredBy: stringColumn(record, "declared_by") as Address,
    declaredAt: stringColumn(record, "declared_at"),
    updatedAt: stringColumn(record, "updated_at"),
  };
}

function consentRow(row: unknown): OrderRequirementConsentRecord {
  const record = rowObject(row, "order_requirement_consent query");
  return {
    consentId: stringColumn(record, "consent_id"),
    draftId: stringColumn(record, "draft_id"),
    walletAddress: stringColumn(record, "wallet_address") as Address,
    requirementsHash: stringColumn(record, "requirements_hash") as Hex,
    signature: stringColumn(record, "signature") as Hex,
    signedAt: stringColumn(record, "signed_at"),
    createdAt: stringColumn(record, "created_at"),
  };
}
