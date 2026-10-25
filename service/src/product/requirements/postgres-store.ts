// 订单要求包 postgres 持久化（schema 见 migrations/postgres/0001_schema.sql）：
// 与内存实现同语义，声明 upsert 与旧合意清理在同一事务内完成。

import type { OrderRequirementsDeclarationDTO } from "@uvp-eth/product-dto";
import { parseStorageJson, stringifyStorageJson } from "../../storage/json.js";
import { PostgresDatabase } from "../../storage/postgres-client.js";
import { rowObject, stringColumn } from "../../storage/postgres-rows.js";
import type { Address, Hex } from "../../shared/types.js";
import type {
  OrderRequirementBundleRecord,
  OrderRequirementConsentRecord,
  OrderRequirementsStore,
} from "./types.js";

export interface PostgresOrderRequirementsStoreOptions {
  readonly databaseUrl?: string;
  readonly database?: PostgresDatabase;
  readonly migrations?: {
    readonly autoRun?: boolean;
    readonly directory?: string;
  };
}

export class PostgresOrderRequirementsStore
  implements OrderRequirementsStore
{
  readonly driver = "postgres" as const;

  readonly #database: PostgresDatabase;
  readonly #ownsDatabase: boolean;

  constructor(options: PostgresOrderRequirementsStoreOptions) {
    if (!options.database && !options.databaseUrl) {
      throw new Error(
        "PostgresOrderRequirementsStore requires database or databaseUrl",
      );
    }
    this.#database =
      options.database ??
      new PostgresDatabase({
        databaseUrl: options.databaseUrl!,
        ...(options.migrations ? { migrations: options.migrations } : {}),
      });
    this.#ownsDatabase = !options.database;
  }

  async close(): Promise<void> {
    if (this.#ownsDatabase) {
      await this.#database.close();
    }
  }

  async getBundle(
    draftId: string,
  ): Promise<OrderRequirementBundleRecord | undefined> {
    const result = await this.#database.query(
      `SELECT *
       FROM order_requirement_bundle
       WHERE draft_id = $1`,
      [draftId],
    );
    return result.rows[0] ? bundleRow(result.rows[0]) : undefined;
  }

  async saveBundle(record: OrderRequirementBundleRecord): Promise<void> {
    await this.#database.withTransaction(async () => {
      await this.#database.query(
        `INSERT INTO order_requirement_bundle (
           draft_id, schema_version, declaration_json, requirements_hash,
           declared_by, declared_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT(draft_id) DO UPDATE SET
           schema_version = excluded.schema_version,
           declaration_json = excluded.declaration_json,
           requirements_hash = excluded.requirements_hash,
           declared_by = excluded.declared_by,
           declared_at = excluded.declared_at,
           updated_at = excluded.updated_at`,
        [
          record.draftId,
          record.declaration.schemaVersion,
          stringifyStorageJson(record.declaration),
          record.requirementsHash,
          record.declaredBy,
          record.declaredAt,
          record.updatedAt,
        ],
      );
      await this.#database.query(
        `DELETE FROM order_requirement_consent
         WHERE draft_id = $1 AND requirements_hash <> $2`,
        [record.draftId, record.requirementsHash],
      );
    });
  }

  async listConsents(
    draftId: string,
  ): Promise<readonly OrderRequirementConsentRecord[]> {
    const result = await this.#database.query(
      `SELECT *
       FROM order_requirement_consent
       WHERE draft_id = $1
       ORDER BY created_at ASC, wallet_address ASC`,
      [draftId],
    );
    return result.rows.map((row) => consentRow(row));
  }

  async saveConsent(record: OrderRequirementConsentRecord): Promise<void> {
    await this.#database.query(
      `INSERT INTO order_requirement_consent (
         consent_id, draft_id, wallet_address, requirements_hash,
         signature, signed_at, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT(draft_id, wallet_address) DO UPDATE SET
         consent_id = excluded.consent_id,
         requirements_hash = excluded.requirements_hash,
         signature = excluded.signature,
         signed_at = excluded.signed_at,
         created_at = excluded.created_at`,
      [
        record.consentId,
        record.draftId,
        record.walletAddress,
        record.requirementsHash,
        record.signature,
        record.signedAt,
        record.createdAt,
      ],
    );
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
