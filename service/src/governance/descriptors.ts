import { randomUUID } from "node:crypto";
import { canonicalStringify } from "@uvp-eth/compiler";
import { runSqliteMigrations } from "../storage/migrations.js";
import {
  openSqliteDatabase,
  runSqliteWrite,
  type SqliteDatabase,
  type SqliteValue
} from "../storage/sqlite.js";
import {
  optionalStringColumn,
  rowObject,
  stringColumn
} from "../storage/sqlite-rows.js";
import { normalizeBytes32, type Hex } from "../shared/types.js";
import { hashIdentityDescriptor, type IdentityDescriptorHashInput } from "./hashing.js";

/**
 * PRD89 身份配对的 descriptor 托管：
 *
 * - 审核通过的供应商/凝结核档案在 registerIdentity 时以"被哈希的原文"
 *   形式追加为 append-only 快照（subjectId + descriptorHash 唯一）。
 * - descriptorURI 指向 Store 托管端点（GET /identity/descriptors/...），
 *   内容按 descriptorHash 锁定：任何人可重算 keccak256(canonicalJson)
 *   验证快照未被篡改。
 * - 改档案（新 review / 新 account / 新 metadata）→ 新 descriptorHash →
 *   新版本快照；旧版本保留。
 */

export interface StoreIdentityDescriptorSnapshotRecord {
  readonly snapshotId: string;
  readonly subjectId: Hex;
  readonly descriptorHash: Hex;
  /** 被哈希的原文（结构化对象，canonical JSON 重建后哈希必须一致）。 */
  readonly descriptorDocument: unknown;
  readonly source: string;
  readonly createdBy: string;
  readonly createdAt: string;
}

export interface StoreIdentityDescriptorSnapshotStore {
  appendSnapshot(record: StoreIdentityDescriptorSnapshotRecord): Promise<void>;
  findSnapshot(subjectId: Hex, descriptorHash: Hex): Promise<StoreIdentityDescriptorSnapshotRecord | undefined>;
  listSnapshots(subjectId: Hex): Promise<readonly StoreIdentityDescriptorSnapshotRecord[]>;
}

export class InMemoryStoreIdentityDescriptorSnapshotStore implements StoreIdentityDescriptorSnapshotStore {
  readonly #snapshots: StoreIdentityDescriptorSnapshotRecord[] = [];

  async appendSnapshot(record: StoreIdentityDescriptorSnapshotRecord): Promise<void> {
    const exists = await this.findSnapshot(record.subjectId, record.descriptorHash);
    if (exists) {
      return;
    }
    this.#snapshots.push(record);
  }

  async findSnapshot(subjectId: Hex, descriptorHash: Hex): Promise<StoreIdentityDescriptorSnapshotRecord | undefined> {
    return this.#snapshots.find((snapshot) =>
      snapshot.subjectId.toLowerCase() === subjectId.toLowerCase() &&
      snapshot.descriptorHash.toLowerCase() === descriptorHash.toLowerCase()
    );
  }

  async listSnapshots(subjectId: Hex): Promise<readonly StoreIdentityDescriptorSnapshotRecord[]> {
    return this.#snapshots
      .filter((snapshot) => snapshot.subjectId.toLowerCase() === subjectId.toLowerCase())
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.snapshotId.localeCompare(right.snapshotId));
  }
}

export class SqliteStoreIdentityDescriptorSnapshotStore implements StoreIdentityDescriptorSnapshotStore {
  readonly #database: SqliteDatabase;
  readonly #ownsDatabase: boolean;

  constructor(options: { readonly databaseUrl?: string; readonly database?: SqliteDatabase; readonly migrations?: { readonly autoRun?: boolean; readonly directory?: string } }) {
    if (!options.database && !options.databaseUrl) {
      throw new Error("SqliteStoreIdentityDescriptorSnapshotStore requires database or databaseUrl");
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

  close(): void {
    if (this.#ownsDatabase) {
      this.#database.close();
    }
  }

  async appendSnapshot(record: StoreIdentityDescriptorSnapshotRecord): Promise<void> {
    runSqliteWrite(() => {
      this.#database.prepare(
        `INSERT OR IGNORE INTO store_identity_descriptor_snapshot
           (snapshot_id, subject_id, descriptor_hash, descriptor_json, source, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(...snapshotValues(record));
    });
  }

  async findSnapshot(subjectId: Hex, descriptorHash: Hex): Promise<StoreIdentityDescriptorSnapshotRecord | undefined> {
    const row = this.#database.prepare(
      `SELECT * FROM store_identity_descriptor_snapshot
       WHERE subject_id = ? AND descriptor_hash = ?`
    ).get(subjectId.toLowerCase(), descriptorHash.toLowerCase());
    return row ? snapshotRow(row) : undefined;
  }

  async listSnapshots(subjectId: Hex): Promise<readonly StoreIdentityDescriptorSnapshotRecord[]> {
    return this.#database.prepare(
      `SELECT * FROM store_identity_descriptor_snapshot
       WHERE subject_id = ?
       ORDER BY created_at ASC, snapshot_id ASC`
    ).all(subjectId.toLowerCase()).map((row) => snapshotRow(row));
  }
}

export interface IdentityDescriptorSnapshotDTO {
  readonly subjectId: Hex;
  readonly descriptorHash: Hex;
  readonly hashScheme: "keccak256-canonical-json:identityDescriptor:v1";
  readonly descriptor: unknown;
  readonly descriptorJson: string;
  readonly verification: {
    readonly recomputedDescriptorHash: Hex;
    readonly matches: boolean;
  };
  readonly source: string;
  readonly createdAt: string;
}

export interface IdentityDescriptorSnapshotSummaryDTO {
  readonly subjectId: Hex;
  readonly descriptorHash: Hex;
  readonly source: string;
  readonly createdAt: string;
}

export class GovernanceDescriptorError extends Error {
  override readonly name = "GovernanceDescriptorError";

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
  }
}

/** registerIdentity 落链前调用：追加（幂等）descriptor 快照。 */
export async function persistIdentityDescriptorSnapshot(options: {
  readonly store: StoreIdentityDescriptorSnapshotStore;
  readonly subjectId: Hex;
  readonly descriptorInput: IdentityDescriptorHashInput;
  readonly descriptorHash: Hex;
  readonly createdBy: string;
  readonly now: () => Date;
}): Promise<StoreIdentityDescriptorSnapshotRecord> {
  const existing = await options.store.findSnapshot(options.subjectId, options.descriptorHash);
  if (existing) {
    return existing;
  }
  const record: StoreIdentityDescriptorSnapshotRecord = {
    snapshotId: `desc_${randomUUID()}`,
    subjectId: options.subjectId,
    descriptorHash: options.descriptorHash,
    descriptorDocument: options.descriptorInput,
    source: "register_identity",
    createdBy: options.createdBy,
    createdAt: options.now().toISOString()
  };
  await options.store.appendSnapshot(record);
  return record;
}

export function buildDescriptorPublicUri(publicBaseUrl: string, subjectId: Hex, descriptorHash: Hex): string {
  const base = publicBaseUrl.replace(/\/+$/, "");
  return `${base}/identity/descriptors/${subjectId}/${descriptorHash}`;
}

export async function readIdentityDescriptorSnapshot(
  store: StoreIdentityDescriptorSnapshotStore,
  subjectIdRaw: string,
  descriptorHashRaw: string
): Promise<IdentityDescriptorSnapshotDTO> {
  const subjectId = normalizeDescriptorId(subjectIdRaw, "subjectId");
  const descriptorHash = normalizeDescriptorId(descriptorHashRaw, "descriptorHash");
  const snapshot = await store.findSnapshot(subjectId, descriptorHash);
  if (!snapshot) {
    throw new GovernanceDescriptorError(404, "descriptor_snapshot_not_found", "no descriptor snapshot matches this subject and hash");
  }
  const descriptorJson = canonicalStringify(snapshot.descriptorDocument);
  const recomputedDescriptorHash = hashIdentityDescriptor(snapshot.descriptorDocument as IdentityDescriptorHashInput);
  return {
    subjectId: snapshot.subjectId,
    descriptorHash: snapshot.descriptorHash,
    hashScheme: "keccak256-canonical-json:identityDescriptor:v1",
    descriptor: snapshot.descriptorDocument,
    descriptorJson,
    verification: {
      recomputedDescriptorHash,
      matches: recomputedDescriptorHash.toLowerCase() === snapshot.descriptorHash.toLowerCase()
    },
    source: snapshot.source,
    createdAt: snapshot.createdAt
  };
}

export async function listIdentityDescriptorSnapshots(
  store: StoreIdentityDescriptorSnapshotStore,
  subjectIdRaw: string
): Promise<{ readonly subjectId: Hex; readonly snapshots: readonly IdentityDescriptorSnapshotSummaryDTO[] }> {
  const subjectId = normalizeDescriptorId(subjectIdRaw, "subjectId");
  const snapshots = await store.listSnapshots(subjectId);
  return {
    subjectId,
    snapshots: snapshots.map((snapshot) => ({
      subjectId: snapshot.subjectId,
      descriptorHash: snapshot.descriptorHash,
      source: snapshot.source,
      createdAt: snapshot.createdAt
    }))
  };
}

function normalizeDescriptorId(value: string, field: string): Hex {
  try {
    return normalizeBytes32(value, field);
  } catch (error) {
    throw new GovernanceDescriptorError(400, "invalid_descriptor_id", `${field} must be a bytes32 hex value`);
  }
}

function snapshotValues(record: StoreIdentityDescriptorSnapshotRecord): readonly SqliteValue[] {
  return [
    record.snapshotId,
    record.subjectId.toLowerCase(),
    record.descriptorHash.toLowerCase(),
    canonicalStringify(record.descriptorDocument),
    record.source,
    record.createdBy,
    record.createdAt
  ];
}

function snapshotRow(row: unknown): StoreIdentityDescriptorSnapshotRecord {
  const record = rowObject(row);
  return {
    snapshotId: stringColumn(record, "snapshot_id"),
    subjectId: asHex(stringColumn(record, "subject_id")),
    descriptorHash: asHex(stringColumn(record, "descriptor_hash")),
    descriptorDocument: JSON.parse(stringColumn(record, "descriptor_json")) as unknown,
    source: stringColumn(record, "source"),
    createdBy: stringColumn(record, "created_by"),
    createdAt: stringColumn(record, "created_at"),
  };
}

/** 库内 hex 列在写入时已 normalize（小写 0x…）；读出时恢复模板类型。 */
function asHex(value: string): Hex {
  return value as Hex;
}
