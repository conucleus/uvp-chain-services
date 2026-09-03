import { parseStorageJson, stringifyStorageJson } from "../storage/json.js";
import { PostgresDatabase } from "../storage/postgres-client.js";
import {
  numberColumn,
  optionalStringColumn,
  rowObject,
  stringColumn
} from "../storage/postgres-rows.js";
import type { Address, Hex } from "../shared/types.js";
import type {
  NotificationDeliveryQuery,
  NotificationDeliveryRecord,
  NotificationDeliveryStore,
  NotificationDeliveryStatus,
  ParticipantNotificationReadState,
  ParticipantNotificationReadStateStore
} from "./service.js";

export interface PostgresNotificationStateStoreOptions {
  readonly databaseUrl?: string;
  readonly database?: PostgresDatabase;
  readonly migrations?: {
    readonly autoRun?: boolean;
    readonly directory?: string;
  };
}

/**
 * ETH-04(b)：通知 delivery / participant read 状态落 postgres（表结构见
 * migrations/postgres/0013_notification_broadcast_state.sql）。生产拓扑
 * （postgres 驱动）此前完全没有持久化通知状态，装配静默退化为 undefined。
 */
export class PostgresNotificationStateStore implements NotificationDeliveryStore, ParticipantNotificationReadStateStore {
  readonly #database: PostgresDatabase;
  readonly #ownsDatabase: boolean;

  constructor(options: PostgresNotificationStateStoreOptions) {
    if (!options.database && !options.databaseUrl) {
      throw new Error("PostgresNotificationStateStore requires database or databaseUrl");
    }
    this.#database = options.database ?? new PostgresDatabase({
      databaseUrl: options.databaseUrl!,
      ...(options.migrations ? { migrations: options.migrations } : {})
    });
    this.#ownsDatabase = !options.database;
  }

  async close(): Promise<void> {
    if (this.#ownsDatabase) {
      await this.#database.close();
    }
  }

  async getDelivery(deliveryId: Hex): Promise<NotificationDeliveryRecord | undefined> {
    const result = await this.#database.query(
      "SELECT * FROM notification_delivery WHERE delivery_id = $1",
      [deliveryId.toLowerCase()]
    );
    return result.rows[0] ? deliveryRow(result.rows[0]) : undefined;
  }

  async saveDelivery(record: NotificationDeliveryRecord): Promise<NotificationDeliveryRecord> {
    await this.#database.query(
      `INSERT INTO notification_delivery (
        delivery_id, kind, status, task_id, order_id, receiver_hook_id, receiver_stage_id,
        source_id, signal_id, payload_hash, idempotency_key, chain_id, state_machine_address,
        submitter, supplier_subject_id, supplier_wallet, transport_type, activation_status,
        external_receipt_ref, reason, payload_json, attempts, last_error, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25)
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
        updated_at = excluded.updated_at`,
      deliveryValues(record)
    );
    return record;
  }

  async listDeliveries(query: NotificationDeliveryQuery = {}): Promise<readonly NotificationDeliveryRecord[]> {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (query.orderId) {
      values.push(query.orderId.toLowerCase());
      clauses.push(`order_id = $${values.length}`);
    }
    if (query.taskId) {
      values.push(query.taskId);
      clauses.push(`task_id = $${values.length}`);
    }
    if (query.supplier) {
      values.push(query.supplier.toLowerCase(), query.supplier.toLowerCase());
      clauses.push(`(supplier_wallet = $${values.length - 1} OR supplier_subject_id = $${values.length})`);
    }
    if (query.status) {
      values.push(query.status);
      clauses.push(`status = $${values.length}`);
    }
    const result = await this.#database.query(
      `SELECT * FROM notification_delivery
       ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
       ORDER BY created_at ASC, delivery_id ASC`,
      values
    );
    return result.rows.map((row) => deliveryRow(row));
  }

  async getReadState(
    participantKey: string,
    notificationId: Hex
  ): Promise<ParticipantNotificationReadState | undefined> {
    const result = await this.#database.query(
      "SELECT * FROM notification_read_state WHERE participant_key = $1 AND notification_id = $2",
      [participantKey, notificationId.toLowerCase()]
    );
    const row = result.rows[0];
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
    await this.#database.query(
      `INSERT INTO notification_read_state (participant_key, notification_id, read_at)
       VALUES ($1, $2, $3)
       ON CONFLICT(participant_key, notification_id) DO UPDATE SET
         read_at = excluded.read_at`,
      [state.participantKey, state.notificationId.toLowerCase(), state.readAt]
    );
    return state;
  }
}

function deliveryValues(record: NotificationDeliveryRecord): readonly unknown[] {
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
  const taskId = optionalStringColumn(record, "task_id");
  const receiverHookId = optionalStringColumn(record, "receiver_hook_id");
  const receiverStageId = optionalStringColumn(record, "receiver_stage_id");
  const sourceId = optionalStringColumn(record, "source_id");
  const signalId = optionalStringColumn(record, "signal_id");
  const payloadHash = optionalStringColumn(record, "payload_hash");
  const idempotencyKey = optionalStringColumn(record, "idempotency_key");
  const submitter = optionalStringColumn(record, "submitter");
  const supplierSubjectId = optionalStringColumn(record, "supplier_subject_id");
  const supplierWallet = optionalStringColumn(record, "supplier_wallet");
  const transportType = optionalStringColumn(record, "transport_type");
  const activationStatus = optionalStringColumn(record, "activation_status");
  const externalReceiptRef = optionalStringColumn(record, "external_receipt_ref");
  const reason = optionalStringColumn(record, "reason");
  const lastError = optionalStringColumn(record, "last_error");
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
    ...(submitter !== undefined ? { submitter: submitter as Address } : {}),
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
