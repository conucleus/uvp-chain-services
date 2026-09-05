import { parseStorageJson, stringifyStorageJson } from "../storage/json.js";
import { runSqliteMigrations } from "../storage/migrations.js";
import {
  openSqliteDatabase,
  runSqliteWrite,
  type SqliteDatabase,
  type SqliteValue
} from "../storage/sqlite.js";
import {
  nullableStringColumn,
  numberColumn,
  rowObject,
  stringColumn
} from "../storage/sqlite-rows.js";
import type { Address, Hex } from "../shared/types.js";
import type {
  NotificationDeliveryQuery,
  NotificationDeliveryRecord,
  NotificationDeliveryStore,
  NotificationDeliveryStatus,
  ParticipantNotificationReadState,
  ParticipantNotificationReadStateStore
} from "./service.js";

export interface SqliteNotificationStateStoreOptions {
  readonly databaseUrl?: string;
  readonly database?: SqliteDatabase;
  readonly migrations?: {
    readonly autoRun?: boolean;
    readonly directory?: string;
  };
}

interface OpenedDatabase {
  readonly database: SqliteDatabase;
  readonly ownsDatabase: boolean;
}

function openNotificationStateDatabase(
  options: SqliteNotificationStateStoreOptions,
  label: string
): OpenedDatabase {
  if (options.database) {
    if (options.migrations?.autoRun === true) {
      runSqliteMigrations({
        database: options.database,
        ...(options.migrations.directory ? { migrationsDirectory: options.migrations.directory } : {})
      });
    }
    return { database: options.database, ownsDatabase: false };
  }
  if (!options.databaseUrl) {
    throw new Error(`${label} requires databaseUrl or a shared SqliteDatabase`);
  }
  const database = openSqliteDatabase(options.databaseUrl);
  if (options.migrations?.autoRun === true) {
    runSqliteMigrations({
      database,
      ...(options.migrations.directory ? { migrationsDirectory: options.migrations.directory } : {})
    });
  }
  return { database, ownsDatabase: true };
}

/**
 * 通知 delivery / participant read 状态落 sqlite，进程重启后不丢失。
 */
export class SqliteNotificationStateStore implements NotificationDeliveryStore, ParticipantNotificationReadStateStore {
  readonly #database: SqliteDatabase;
  readonly #ownsDatabase: boolean;

  constructor(options: SqliteNotificationStateStoreOptions) {
    const opened = openNotificationStateDatabase(options, "SqliteNotificationStateStore");
    this.#database = opened.database;
    this.#ownsDatabase = opened.ownsDatabase;
  }

  async close(): Promise<void> {
    if (this.#ownsDatabase) {
      this.#database.close();
    }
  }

  async getDelivery(deliveryId: Hex): Promise<NotificationDeliveryRecord | undefined> {
    const row = this.#database
      .prepare("SELECT * FROM notification_delivery WHERE delivery_id = ?")
      .get(deliveryId.toLowerCase());
    return row ? deliveryRow(row) : undefined;
  }

  async saveDelivery(record: NotificationDeliveryRecord): Promise<NotificationDeliveryRecord> {
    runSqliteWrite(() => {
      this.#database
        .prepare(
          `INSERT INTO notification_delivery (
           delivery_id, kind, status, task_id, order_id, receiver_hook_id, receiver_stage_id,
           source_id, signal_id, payload_hash, idempotency_key, chain_id, state_machine_address,
           submitter, supplier_subject_id, supplier_wallet, transport_type, activation_status,
           external_receipt_ref, reason, payload_json, attempts, last_error, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(delivery_id) DO UPDATE SET
           kind = excluded.kind,
           status = excluded.status,
           task_id = excluded.task_id,
           order_id = excluded.order_id,
           receiver_hook_id = excluded.receiver_hook_id,
           receiver_stage_id = excluded.receiver_stage_id,
           source_id = excluded.source_id,
           signal_id = excluded.signal_id,
           payload_hash = excluded.payload_hash,
           idempotency_key = excluded.idempotency_key,
           chain_id = excluded.chain_id,
           state_machine_address = excluded.state_machine_address,
           submitter = excluded.submitter,
           supplier_subject_id = excluded.supplier_subject_id,
           supplier_wallet = excluded.supplier_wallet,
           transport_type = excluded.transport_type,
           activation_status = excluded.activation_status,
           external_receipt_ref = excluded.external_receipt_ref,
           reason = excluded.reason,
           payload_json = excluded.payload_json,
           attempts = excluded.attempts,
           last_error = excluded.last_error,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at`
        )
        .run(...deliveryValues(record));
    });
    return record;
  }

  async listDeliveries(query: NotificationDeliveryQuery = {}): Promise<readonly NotificationDeliveryRecord[]> {
    const filters: string[] = [];
    const values: SqliteValue[] = [];
    if (query.orderId) {
      filters.push("order_id = ?");
      values.push(query.orderId.toLowerCase());
    }
    if (query.taskId) {
      filters.push("task_id = ?");
      values.push(query.taskId);
    }
    if (query.supplier) {
      filters.push("(supplier_wallet = ? OR supplier_subject_id = ?)");
      values.push(query.supplier.toLowerCase(), query.supplier.toLowerCase());
    }
    if (query.status) {
      filters.push("status = ?");
      values.push(query.status);
    }
    const rows = this.#database
      .prepare(
        `SELECT * FROM notification_delivery
         ${filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : ""}
         ORDER BY created_at ASC, delivery_id ASC`
      )
      .all(...values);
    return rows.map((row) => deliveryRow(row));
  }

  async getReadState(
    participantKey: string,
    notificationId: Hex
  ): Promise<ParticipantNotificationReadState | undefined> {
    const row = this.#database
      .prepare("SELECT * FROM notification_read_state WHERE participant_key = ? AND notification_id = ?")
      .get(participantKey, notificationId.toLowerCase());
    if (!row) {
      return undefined;
    }
    const record = rowObject(row);
    return {
      participantKey: stringColumn(record, "participant_key"),
      notificationId: stringColumn(record, "notification_id") as Hex,
      readAt: stringColumn(record, "read_at")
    };
  }

  async markRead(state: ParticipantNotificationReadState): Promise<ParticipantNotificationReadState> {
    runSqliteWrite(() => {
      this.#database
        .prepare(
          `INSERT INTO notification_read_state (participant_key, notification_id, read_at)
           VALUES (?, ?, ?)
           ON CONFLICT(participant_key, notification_id) DO UPDATE SET
             read_at = excluded.read_at`
        )
        .run(state.participantKey, state.notificationId.toLowerCase(), state.readAt);
    });
    return state;
  }
}

function deliveryValues(record: NotificationDeliveryRecord): readonly SqliteValue[] {
  return [
    record.deliveryId.toLowerCase(),
    record.kind,
    record.status,
    record.taskId ?? null,
    record.orderId.toLowerCase(),
    record.receiverHookId?.toLowerCase() ?? null,
    record.receiverStageId?.toLowerCase() ?? null,
    record.sourceId?.toLowerCase() ?? null,
    record.signalId?.toLowerCase() ?? null,
    record.payloadHash?.toLowerCase() ?? null,
    record.idempotencyKey?.toLowerCase() ?? null,
    record.chainId,
    record.stateMachineAddress.toLowerCase(),
    record.submitter?.toLowerCase() ?? null,
    record.supplierSubjectId?.toLowerCase() ?? null,
    record.supplierWallet?.toLowerCase() ?? null,
    record.transportType ?? null,
    record.activationStatus ?? null,
    record.externalReceiptRef ?? null,
    record.reason ?? null,
    stringifyStorageJson(record.payload),
    record.attempts,
    record.lastError ?? null,
    record.createdAt,
    record.updatedAt
  ];
}

function deliveryRow(row: unknown): NotificationDeliveryRecord {
  const record = rowObject(row);
  const taskId = optionalString(record, "task_id");
  const receiverHookId = optionalString(record, "receiver_hook_id");
  const receiverStageId = optionalString(record, "receiver_stage_id");
  const sourceId = optionalString(record, "source_id");
  const signalId = optionalString(record, "signal_id");
  const payloadHash = optionalString(record, "payload_hash");
  const idempotencyKey = optionalString(record, "idempotency_key");
  const submitter = optionalString(record, "submitter");
  const supplierSubjectId = optionalString(record, "supplier_subject_id");
  const supplierWallet = optionalString(record, "supplier_wallet");
  const transportType = optionalString(record, "transport_type");
  const activationStatus = optionalString(record, "activation_status");
  const externalReceiptRef = optionalString(record, "external_receipt_ref");
  const reason = optionalString(record, "reason");
  const lastError = optionalString(record, "last_error");
  const statusValue = stringColumn(record, "status");
  return {
    deliveryId: stringColumn(record, "delivery_id") as Hex,
    kind: stringColumn(record, "kind") as NotificationDeliveryRecord["kind"],
    status: statusValue as NotificationDeliveryStatus,
    ...(taskId !== undefined ? { taskId } : {}),
    orderId: stringColumn(record, "order_id") as Hex,
    ...(receiverHookId !== undefined ? { receiverHookId: receiverHookId as Hex } : {}),
    ...(receiverStageId !== undefined ? { receiverStageId: receiverStageId as Hex } : {}),
    ...(sourceId !== undefined ? { sourceId: sourceId as Hex } : {}),
    ...(signalId !== undefined ? { signalId: signalId as Hex } : {}),
    ...(payloadHash !== undefined ? { payloadHash: payloadHash as Hex } : {}),
    ...(idempotencyKey !== undefined ? { idempotencyKey: idempotencyKey as Hex } : {}),
    chainId: numberColumn(record, "chain_id"),
    stateMachineAddress: stringColumn(record, "state_machine_address") as NotificationDeliveryRecord["stateMachineAddress"],
    ...(submitter !== undefined ? { submitter: submitter as Hex } : {}),
    ...(supplierSubjectId !== undefined ? { supplierSubjectId: supplierSubjectId as Hex } : {}),
    ...(supplierWallet !== undefined ? { supplierWallet: supplierWallet as Address } : {}),
    ...(transportType !== undefined ? { transportType } : {}),
    ...(activationStatus !== undefined
      ? { activationStatus: activationStatus as NonNullable<NotificationDeliveryRecord["activationStatus"]> }
      : {}),
    ...(externalReceiptRef !== undefined ? { externalReceiptRef } : {}),
    ...(reason !== undefined ? { reason } : {}),
    payload: parseStorageJson<NotificationDeliveryRecord["payload"]>(stringColumn(record, "payload_json")),
    attempts: numberColumn(record, "attempts"),
    ...(lastError !== undefined ? { lastError } : {}),
    createdAt: stringColumn(record, "created_at"),
    updatedAt: stringColumn(record, "updated_at")
  };
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = nullableStringColumn(record, key);
  return value === null ? undefined : value;
}
