import { parseStorageJson, stringifyStorageJson } from "../storage/json.js";
import { runSqliteMigrations } from "../storage/migrations.js";
import {
  openSqliteDatabase,
  runSqliteWrite,
  withSqliteTransaction,
  type SqliteDatabase
} from "../storage/sqlite.js";
import {
  numberColumn,
  optionalStringColumn,
  rowObject,
  stringColumn
} from "../storage/sqlite-rows.js";
import type {
  BindEvidenceRequestDTO,
  EvidenceAccessPolicyDTO,
  EvidenceJsonObject,
  EvidenceMetadataDTO,
  EvidenceObjectDTO
} from "./types.js";
import type {
  EvidenceAdminReadAuditDTO,
  EvidenceMetadataRecord,
  EvidenceMetadataStore
} from "./store.js";

export interface SqliteEvidenceStoreOptions {
  readonly databaseUrl?: string;
  readonly database?: SqliteDatabase;
  readonly migrations?: {
    readonly autoRun?: boolean;
    readonly directory?: string;
  };
}

export class SqliteEvidenceStore implements EvidenceMetadataStore {
  readonly #database: SqliteDatabase;
  readonly #ownsDatabase: boolean;

  constructor(options: SqliteEvidenceStoreOptions) {
    if (!options.database && !options.databaseUrl) {
      throw new Error("SqliteEvidenceStore requires database or databaseUrl");
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

  async close(): Promise<void> {
    if (this.#ownsDatabase) {
      this.#database.close();
    }
  }

  async withTransaction<T>(operation: () => Promise<T>): Promise<T> {
    return withSqliteTransaction(this.#database, operation);
  }

  async put(record: EvidenceMetadataRecord): Promise<void> {
    await this.withTransaction(async () => {
      runSqliteWrite(() => {
        this.#database.prepare(
          `INSERT INTO evidence_object (
             evidence_id, order_id, draft_id, task_id, stage_identifier, owner_participant_id,
             file_name, mime_type, size, storage_uri, content_hash, metadata_hash, payload_hash,
             payload_ref, status, created_at, bound_signal_tx_hash, bound_submission_id,
             bound_onchain_order_id, bound_source_id, bound_signal_id, bound_at,
             metadata_json, canonical_metadata_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(evidence_id)
           DO UPDATE SET
             order_id = excluded.order_id,
             draft_id = excluded.draft_id,
             task_id = excluded.task_id,
             stage_identifier = excluded.stage_identifier,
             owner_participant_id = excluded.owner_participant_id,
             file_name = excluded.file_name,
             mime_type = excluded.mime_type,
             size = excluded.size,
             storage_uri = excluded.storage_uri,
             content_hash = excluded.content_hash,
             metadata_hash = excluded.metadata_hash,
             payload_hash = excluded.payload_hash,
             payload_ref = excluded.payload_ref,
             status = excluded.status,
             created_at = excluded.created_at,
             bound_signal_tx_hash = excluded.bound_signal_tx_hash,
             bound_submission_id = excluded.bound_submission_id,
             bound_onchain_order_id = excluded.bound_onchain_order_id,
             bound_source_id = excluded.bound_source_id,
             bound_signal_id = excluded.bound_signal_id,
             bound_at = excluded.bound_at,
             metadata_json = excluded.metadata_json,
             canonical_metadata_json = excluded.canonical_metadata_json`
        ).run(...evidenceValues(record));

        this.#database.prepare(
          `INSERT INTO evidence_access_policy (
             evidence_id, order_id, readers_json, writers_json, admin_readers_json, dispute_readers_json
           ) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(evidence_id)
           DO UPDATE SET
             order_id = excluded.order_id,
             readers_json = excluded.readers_json,
             writers_json = excluded.writers_json,
             admin_readers_json = excluded.admin_readers_json,
             dispute_readers_json = excluded.dispute_readers_json`
        ).run(
          record.accessPolicy.evidenceId,
          record.accessPolicy.orderId ?? null,
          stringifyStorageJson(record.accessPolicy.readers),
          stringifyStorageJson(record.accessPolicy.writers),
          stringifyStorageJson(record.accessPolicy.adminReaders),
          stringifyStorageJson(record.accessPolicy.disputeReaders)
        );
      });
    });
  }

  async get(evidenceId: string): Promise<EvidenceMetadataRecord | undefined> {
    const row = this.#database.prepare(
      `SELECT
         object.*,
         policy.order_id AS policy_order_id,
         policy.readers_json,
         policy.writers_json,
         policy.admin_readers_json,
         policy.dispute_readers_json
       FROM evidence_object object
       JOIN evidence_access_policy policy ON policy.evidence_id = object.evidence_id
       WHERE object.evidence_id = ?`
    ).get(evidenceId);
    return row ? evidenceRow(row) : undefined;
  }

  async markBound(input: BindEvidenceRequestDTO): Promise<EvidenceMetadataRecord | undefined> {
    const current = await this.get(input.evidenceId);
    if (!current) {
      return undefined;
    }
    const updated: EvidenceMetadataRecord = {
      ...current,
      evidence: {
        ...current.evidence,
        status: "bound",
        boundSignalTxHash: input.txHash,
        ...(input.submissionId ? { boundSubmissionId: input.submissionId } : {}),
        boundOnchainOrderId: input.onchainOrderId,
        boundSourceId: input.sourceId,
        boundSignalId: input.signalId,
        ...(input.boundAt ? { boundAt: input.boundAt } : {})
      }
    };
    await this.put(updated);
    return updated;
  }

  async recordAdminRead(entry: EvidenceAdminReadAuditDTO): Promise<void> {
    runSqliteWrite(() => {
      this.#database.prepare(
        `INSERT INTO evidence_admin_read_audit (evidence_id, principal_id, accessed_at, route)
         VALUES (?, ?, ?, ?)`
      ).run(entry.evidenceId, entry.principalId, entry.accessedAt, entry.route);
    });
  }

  async listAdminReads(): Promise<readonly EvidenceAdminReadAuditDTO[]> {
    return this.#database.prepare(
      `SELECT evidence_id AS evidenceId, principal_id AS principalId, accessed_at AS accessedAt, route
       FROM evidence_admin_read_audit
       ORDER BY accessed_at ASC, audit_id ASC`
    ).all().map((row) => adminReadRow(row));
  }
}

function evidenceValues(record: EvidenceMetadataRecord) {
  const evidence = record.evidence;
  return [
    evidence.evidenceId,
    evidence.orderId ?? null,
    evidence.draftId ?? null,
    evidence.taskId ?? null,
    evidence.stageIdentifier,
    evidence.ownerParticipantId,
    evidence.fileName,
    evidence.mimeType,
    evidence.size,
    evidence.storageURI,
    evidence.contentHash,
    evidence.metadataHash,
    evidence.payloadHash,
    evidence.payloadRef,
    evidence.status,
    evidence.createdAt,
    evidence.boundSignalTxHash ?? null,
    evidence.boundSubmissionId ?? null,
    evidence.boundOnchainOrderId ?? null,
    evidence.boundSourceId ?? null,
    evidence.boundSignalId ?? null,
    evidence.boundAt ?? null,
    stringifyStorageJson(record.metadata),
    stringifyStorageJson(record.canonicalMetadata)
  ] as const;
}

function evidenceRow(row: unknown): EvidenceMetadataRecord {
  const record = rowObject(row, "evidence query");
  const orderId = optionalStringColumn(record, "order_id");
  const draftId = optionalStringColumn(record, "draft_id");
  const taskId = optionalStringColumn(record, "task_id");
  const boundSignalTxHash = optionalStringColumn(record, "bound_signal_tx_hash");
  const boundSubmissionId = optionalStringColumn(record, "bound_submission_id");
  const boundOnchainOrderId = optionalStringColumn(record, "bound_onchain_order_id");
  const boundSourceId = optionalStringColumn(record, "bound_source_id");
  const boundSignalId = optionalStringColumn(record, "bound_signal_id");
  const boundAt = optionalStringColumn(record, "bound_at");
  const policyOrderId = optionalStringColumn(record, "policy_order_id");

  const evidence: EvidenceObjectDTO = {
    evidenceId: stringColumn(record, "evidence_id"),
    ...(orderId !== undefined ? { orderId } : {}),
    ...(draftId !== undefined ? { draftId } : {}),
    ...(taskId !== undefined ? { taskId } : {}),
    stageIdentifier: stringColumn(record, "stage_identifier"),
    ownerParticipantId: stringColumn(record, "owner_participant_id"),
    fileName: stringColumn(record, "file_name"),
    mimeType: stringColumn(record, "mime_type"),
    size: numberColumn(record, "size"),
    storageURI: stringColumn(record, "storage_uri"),
    contentHash: stringColumn(record, "content_hash") as EvidenceObjectDTO["contentHash"],
    metadataHash: stringColumn(record, "metadata_hash") as EvidenceObjectDTO["metadataHash"],
    payloadHash: stringColumn(record, "payload_hash") as EvidenceObjectDTO["payloadHash"],
    payloadRef: stringColumn(record, "payload_ref"),
    status: stringColumn(record, "status") as EvidenceObjectDTO["status"],
    createdAt: stringColumn(record, "created_at"),
    ...(boundSignalTxHash !== undefined
      ? { boundSignalTxHash: boundSignalTxHash as NonNullable<EvidenceObjectDTO["boundSignalTxHash"]> }
      : {}),
    ...(boundSubmissionId !== undefined ? { boundSubmissionId } : {}),
    ...(boundOnchainOrderId !== undefined
      ? { boundOnchainOrderId: boundOnchainOrderId as NonNullable<EvidenceObjectDTO["boundOnchainOrderId"]> }
      : {}),
    ...(boundSourceId !== undefined ? { boundSourceId: boundSourceId as NonNullable<EvidenceObjectDTO["boundSourceId"]> } : {}),
    ...(boundSignalId !== undefined ? { boundSignalId: boundSignalId as NonNullable<EvidenceObjectDTO["boundSignalId"]> } : {}),
    ...(boundAt !== undefined ? { boundAt } : {})
  };
  const metadata = parseStorageJson<EvidenceMetadataDTO>(stringColumn(record, "metadata_json"));
  const accessPolicy: EvidenceAccessPolicyDTO = {
    evidenceId: evidence.evidenceId,
    ...(policyOrderId !== undefined ? { orderId: policyOrderId } : {}),
    readers: parseStorageJson<readonly string[]>(stringColumn(record, "readers_json")),
    writers: parseStorageJson<readonly string[]>(stringColumn(record, "writers_json")),
    adminReaders: parseStorageJson<readonly string[]>(stringColumn(record, "admin_readers_json")),
    disputeReaders: parseStorageJson<readonly string[]>(stringColumn(record, "dispute_readers_json"))
  };
  return {
    evidence,
    metadata,
    accessPolicy,
    canonicalMetadata: parseStorageJson<EvidenceJsonObject>(stringColumn(record, "canonical_metadata_json"))
  };
}

function adminReadRow(row: unknown): EvidenceAdminReadAuditDTO {
  const record = rowObject(row, "evidence_admin_read_audit query");
  return {
    evidenceId: stringColumn(record, "evidenceId"),
    principalId: stringColumn(record, "principalId"),
    accessedAt: stringColumn(record, "accessedAt"),
    route: stringColumn(record, "route") as EvidenceAdminReadAuditDTO["route"]
  };
}
