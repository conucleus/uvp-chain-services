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
import { parseStorageJson, stringifyStorageJson } from "../storage/json.js";
import type { Address, Hex } from "../shared/types.js";
import type {
  StoreJoinApplicationEventRecord,
  StoreJoinApplicationRecord,
  StoreJoinApplicationStore,
  StoreJoinApplicationStatus,
  StoreJoinTxEvidence
} from "./types.js";

export class SqliteStoreJoinApplicationStore implements StoreJoinApplicationStore {
  readonly #database: SqliteDatabase;
  readonly #ownsDatabase: boolean;

  constructor(options: { readonly databaseUrl?: string; readonly database?: SqliteDatabase; readonly migrations?: { readonly autoRun?: boolean; readonly directory?: string } }) {
    if (!options.database && !options.databaseUrl) {
      throw new Error("SqliteStoreJoinApplicationStore requires database or databaseUrl");
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

  async putApplication(record: StoreJoinApplicationRecord): Promise<void> {
    runSqliteWrite(() => {
      this.#database.prepare(
        `INSERT INTO store_join_application
           (application_id, plan_id, zhixu_id, role_slot_id, authorization_kind, stage_id,
            applicant_address, applicant_account_id, applicant_subject_id, applicant_display_name,
            statement, status, supplier_id, tx_evidence_json, rejection_reason, revocation_reason,
            decided_by_address, decided_at, submitted_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(application_id) DO UPDATE SET
           status = excluded.status,
           supplier_id = excluded.supplier_id,
           tx_evidence_json = excluded.tx_evidence_json,
           rejection_reason = excluded.rejection_reason,
           revocation_reason = excluded.revocation_reason,
           decided_by_address = excluded.decided_by_address,
           decided_at = excluded.decided_at,
           updated_at = excluded.updated_at`
      ).run(...applicationValues(record));
    });
  }

  async getApplication(applicationId: string): Promise<StoreJoinApplicationRecord | undefined> {
    const row = this.#database.prepare(
      `SELECT * FROM store_join_application WHERE application_id = ?`
    ).get(applicationId);
    return row ? applicationRow(row) : undefined;
  }

  async listApplications(query?: {
    readonly planId?: Hex;
    readonly applicantAddress?: Address;
    readonly status?: StoreJoinApplicationStatus;
  }): Promise<readonly StoreJoinApplicationRecord[]> {
    const clauses: string[] = [];
    const values: SqliteValue[] = [];
    if (query?.planId) {
      clauses.push("plan_id = ?");
      values.push(query.planId.toLowerCase());
    }
    if (query?.applicantAddress) {
      clauses.push("applicant_address = ?");
      values.push(query.applicantAddress.toLowerCase());
    }
    if (query?.status) {
      clauses.push("status = ?");
      values.push(query.status);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.#database.prepare(
      `SELECT * FROM store_join_application ${where} ORDER BY submitted_at DESC, application_id ASC`
    ).all(...values).map((row) => applicationRow(row));
  }

  async appendEvent(record: StoreJoinApplicationEventRecord): Promise<void> {
    runSqliteWrite(() => {
      this.#database.prepare(
        `INSERT INTO store_join_application_event
           (event_id, application_id, type, actor_address, actor_account_id, actor_auth_mode, reason, tx_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        record.eventId,
        record.applicationId,
        record.type,
        record.actorAddress?.toLowerCase() ?? null,
        record.actorAccountId ?? null,
        record.actorAuthMode ?? null,
        record.reason ?? null,
        record.txHash?.toLowerCase() ?? null,
        record.createdAt
      );
    });
  }

  async listEvents(applicationId: string): Promise<readonly StoreJoinApplicationEventRecord[]> {
    return this.#database.prepare(
      `SELECT * FROM store_join_application_event WHERE application_id = ? ORDER BY created_at ASC, event_id ASC`
    ).all(applicationId).map((row) => eventRow(row));
  }
}

function applicationValues(record: StoreJoinApplicationRecord): readonly SqliteValue[] {
  return [
    record.applicationId,
    record.planId.toLowerCase(),
    record.zhixuId ?? null,
    record.roleSlotId,
    record.authorizationKind,
    record.stageId ?? null,
    record.applicantAddress.toLowerCase(),
    record.applicantAccountId ?? null,
    record.applicantSubjectId.toLowerCase(),
    record.applicantDisplayName ?? null,
    record.statement ?? null,
    record.status,
    record.supplierId ?? null,
    stringifyStorageJson(record.txEvidence),
    record.rejectionReason ?? null,
    record.revocationReason ?? null,
    record.decidedByAddress?.toLowerCase() ?? null,
    record.decidedAt ?? null,
    record.submittedAt,
    record.updatedAt
  ];
}

function applicationRow(row: unknown): StoreJoinApplicationRecord {
  const record = rowObject(row);
  const status = stringColumn(record, "status");
  if (!isJoinStatus(status)) {
    throw new Error(`store_join_application.status holds unsupported value ${status}`);
  }
  const authorizationKind = stringColumn(record, "authorization_kind");
  if (authorizationKind !== "signal_submitter" && authorizationKind !== "stage_executor") {
    throw new Error(`store_join_application.authorization_kind holds unsupported value ${authorizationKind}`);
  }
  return {
    applicationId: stringColumn(record, "application_id"),
    planId: stringColumn(record, "plan_id") as Hex,
    ...(optionalStringColumn(record, "zhixu_id") ? { zhixuId: optionalStringColumn(record, "zhixu_id")! } : {}),
    roleSlotId: stringColumn(record, "role_slot_id"),
    authorizationKind,
    ...(optionalStringColumn(record, "stage_id") ? { stageId: optionalStringColumn(record, "stage_id")! } : {}),
    applicantAddress: stringColumn(record, "applicant_address") as Address,
    ...(optionalStringColumn(record, "applicant_account_id") ? { applicantAccountId: optionalStringColumn(record, "applicant_account_id")! } : {}),
    applicantSubjectId: stringColumn(record, "applicant_subject_id") as Hex,
    ...(optionalStringColumn(record, "applicant_display_name") ? { applicantDisplayName: optionalStringColumn(record, "applicant_display_name")! } : {}),
    ...(optionalStringColumn(record, "statement") ? { statement: optionalStringColumn(record, "statement")! } : {}),
    status,
    ...(optionalStringColumn(record, "supplier_id") ? { supplierId: optionalStringColumn(record, "supplier_id")! } : {}),
    txEvidence: parseStorageJson(stringColumn(record, "tx_evidence_json")) as readonly StoreJoinTxEvidence[],
    ...(optionalStringColumn(record, "rejection_reason") ? { rejectionReason: optionalStringColumn(record, "rejection_reason")! } : {}),
    ...(optionalStringColumn(record, "revocation_reason") ? { revocationReason: optionalStringColumn(record, "revocation_reason")! } : {}),
    ...(optionalStringColumn(record, "decided_by_address") ? { decidedByAddress: optionalStringColumn(record, "decided_by_address")! as Address } : {}),
    ...(optionalStringColumn(record, "decided_at") ? { decidedAt: optionalStringColumn(record, "decided_at")! } : {}),
    submittedAt: stringColumn(record, "submitted_at"),
    updatedAt: stringColumn(record, "updated_at")
  };
}

function eventRow(row: unknown): StoreJoinApplicationEventRecord {
  const record = rowObject(row);
  return {
    eventId: stringColumn(record, "event_id"),
    applicationId: stringColumn(record, "application_id"),
    type: stringColumn(record, "type") as StoreJoinApplicationEventRecord["type"],
    ...(optionalStringColumn(record, "actor_address") ? { actorAddress: optionalStringColumn(record, "actor_address")! as Address } : {}),
    ...(optionalStringColumn(record, "actor_account_id") ? { actorAccountId: optionalStringColumn(record, "actor_account_id")! } : {}),
    ...(optionalStringColumn(record, "actor_auth_mode") ? { actorAuthMode: optionalStringColumn(record, "actor_auth_mode")! } : {}),
    ...(optionalStringColumn(record, "reason") ? { reason: optionalStringColumn(record, "reason")! } : {}),
    ...(optionalStringColumn(record, "tx_hash") ? { txHash: optionalStringColumn(record, "tx_hash")! as Hex } : {}),
    createdAt: stringColumn(record, "created_at")
  };
}

function isJoinStatus(value: string): value is StoreJoinApplicationStatus {
  return value === "applied" || value === "under_review" || value === "authorized" || value === "active" || value === "rejected" || value === "revoked";
}
