// 治理身份描述符快照的 postgres 持久化；schema 见 migrations/postgres/0001_schema.sql。

import { canonicalJson } from "@uvp-eth/canonical-json";
import type { PostgresDatabase } from "../storage/postgres-client.js";
import type { Hex } from "../shared/types.js";
import type {
  StoreIdentityDescriptorSnapshotRecord,
  StoreIdentityDescriptorSnapshotStore,
} from "./descriptors.js";

type Row = Record<string, unknown>;

export class PostgresStoreIdentityDescriptorSnapshotStore implements StoreIdentityDescriptorSnapshotStore {
  readonly #database: PostgresDatabase;

  constructor(options: { readonly database: PostgresDatabase }) {
    this.#database = options.database;
  }

  async appendSnapshot(record: StoreIdentityDescriptorSnapshotRecord): Promise<void> {
    await this.#database.query(
      `INSERT INTO store_identity_descriptor_snapshot
         (snapshot_id, subject_id, descriptor_hash, descriptor_json, source, created_by, created_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
       ON CONFLICT (subject_id, descriptor_hash) DO NOTHING`,
      [
        record.snapshotId,
        record.subjectId.toLowerCase(),
        record.descriptorHash.toLowerCase(),
        canonicalJson(record.descriptorDocument),
        record.source,
        record.createdBy,
        record.createdAt
      ]
    );
  }

  async findSnapshot(subjectId: Hex, descriptorHash: Hex): Promise<StoreIdentityDescriptorSnapshotRecord | undefined> {
    const result = await this.#database.query(
      `SELECT * FROM store_identity_descriptor_snapshot WHERE subject_id = $1 AND descriptor_hash = $2`,
      [subjectId.toLowerCase(), descriptorHash.toLowerCase()]
    );
    return result.rows[0] ? descriptorRow(result.rows[0]) : undefined;
  }

  async listSnapshots(subjectId: Hex): Promise<readonly StoreIdentityDescriptorSnapshotRecord[]> {
    const result = await this.#database.query(
      `SELECT * FROM store_identity_descriptor_snapshot WHERE subject_id = $1 ORDER BY created_at ASC, snapshot_id ASC`,
      [subjectId.toLowerCase()]
    );
    return result.rows.map((row) => descriptorRow(row));
  }
}

function descriptorRow(row: Row): StoreIdentityDescriptorSnapshotRecord {
  return {
    snapshotId: String(row.snapshot_id),
    subjectId: String(row.subject_id) as Hex,
    descriptorHash: String(row.descriptor_hash) as Hex,
    descriptorDocument: typeof row.descriptor_json === "string" ? JSON.parse(row.descriptor_json) : row.descriptor_json,
    source: String(row.source),
    createdBy: String(row.created_by),
    createdAt: String(row.created_at)
  };
}
