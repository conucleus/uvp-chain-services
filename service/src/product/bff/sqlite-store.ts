import { parseStorageJson, stringifyStorageJson } from "../../storage/json.js";
import { runSqliteMigrations } from "../../storage/migrations.js";
import {
  openSqliteDatabase,
  runSqliteWrite,
  withSqliteTransaction,
  type SqliteDatabase
} from "../../storage/sqlite.js";
import {
  booleanColumn,
  nullableStringColumn,
  numberColumn,
  optionalStringColumn,
  rowObject,
  stringColumn
} from "../../storage/sqlite-rows.js";
import type {
  DraftParticipantDTO,
  ParticipantPermissionDTO,
  ProductInviteDTO,
  ProductOrderDraftDTO,
  ProductOrderTriggerRecord,
  SignalAuthorizationDTO
} from "./types.js";
import type { ProductBffStore } from "./store.js";

const zeroBytes32 = "0x0000000000000000000000000000000000000000000000000000000000000000";

export interface SqliteProductBffStoreOptions {
  readonly databaseUrl?: string;
  readonly database?: SqliteDatabase;
  readonly migrations?: {
    readonly autoRun?: boolean;
    readonly directory?: string;
  };
}

export class SqliteProductBffStore implements ProductBffStore {
  readonly #database: SqliteDatabase;
  readonly #ownsDatabase: boolean;

  constructor(options: SqliteProductBffStoreOptions) {
    if (!options.database && !options.databaseUrl) {
      throw new Error("SqliteProductBffStore requires database or databaseUrl");
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

  async createDraft(draft: ProductOrderDraftDTO, participants: readonly DraftParticipantDTO[]): Promise<void> {
    await this.withTransaction(async () => {
      runSqliteWrite(() => {
        this.#insertDraft(draft);
        for (const participant of participants) {
          this.#upsertParticipant(participant);
        }
      });
    });
  }

  async getDraft(draftId: string): Promise<ProductOrderDraftDTO | undefined> {
    const row = this.#database.prepare(
      `SELECT *
       FROM product_order_draft
       WHERE draft_id = ?`
    ).get(draftId);
    return row ? draftRow(row) : undefined;
  }

  async updateDraft(draft: ProductOrderDraftDTO): Promise<void> {
    runSqliteWrite(() => this.#upsertDraft(draft));
  }

  async listParticipants(draftId: string): Promise<readonly DraftParticipantDTO[]> {
    return this.#database.prepare(
      `SELECT *
       FROM product_participant
       WHERE draft_id = ?
       ORDER BY participant_id ASC`
    ).all(draftId).map((row) => participantRow(row));
  }

  async listAcceptedParticipantsByWallet(walletAddress: string): Promise<readonly DraftParticipantDTO[]> {
    return this.#database.prepare(
      `SELECT *
       FROM product_participant
       WHERE status = 'accepted'
         AND LOWER(wallet_address) = LOWER(?)
       ORDER BY accepted_at ASC, participant_id ASC`
    ).all(walletAddress).map((row) => participantRow(row));
  }

  async getParticipant(participantId: string): Promise<DraftParticipantDTO | undefined> {
    const row = this.#database.prepare(
      `SELECT *
       FROM product_participant
       WHERE participant_id = ?`
    ).get(participantId);
    return row ? participantRow(row) : undefined;
  }

  async updateParticipant(participant: DraftParticipantDTO): Promise<void> {
    runSqliteWrite(() => this.#upsertParticipant(participant));
  }

  async createInvite(invite: ProductInviteDTO): Promise<void> {
    runSqliteWrite(() => this.#insertInvite(invite));
  }

  async getInvite(inviteId: string): Promise<ProductInviteDTO | undefined> {
    const row = this.#database.prepare(
      `SELECT *
       FROM product_invite
       WHERE invite_id = ?`
    ).get(inviteId);
    return row ? inviteRow(row) : undefined;
  }

  async updateInvite(invite: ProductInviteDTO): Promise<void> {
    runSqliteWrite(() => this.#upsertInvite(invite));
  }

  async listInvitesByDraft(draftId: string): Promise<readonly ProductInviteDTO[]> {
    return this.#database.prepare(
      `SELECT *
       FROM product_invite
       WHERE draft_id = ?
       ORDER BY created_at ASC, invite_id ASC`
    ).all(draftId).map((row) => inviteRow(row));
  }

  async createRegistration(registration: ProductOrderTriggerRecord): Promise<void> {
    runSqliteWrite(() => this.#insertRegistration(registration));
  }

  async getRegistration(triggerId: string): Promise<ProductOrderTriggerRecord | undefined> {
    const row = this.#database.prepare(
      `SELECT *
       FROM product_order_trigger
       WHERE trigger_id = ?`
    ).get(triggerId);
    return row ? registrationRow(row) : undefined;
  }

  async getRegistrationByDraft(draftId: string): Promise<ProductOrderTriggerRecord | undefined> {
    const row = this.#database.prepare(
      `SELECT *
       FROM product_order_trigger
       WHERE draft_id = ?`
    ).get(draftId);
    return row ? registrationRow(row) : undefined;
  }

  async listRegistrations(): Promise<readonly ProductOrderTriggerRecord[]> {
    return this.#database.prepare(
      `SELECT *
       FROM product_order_trigger
       ORDER BY created_at ASC, trigger_id ASC`
    ).all().map((row) => registrationRow(row));
  }

  async updateRegistration(registration: ProductOrderTriggerRecord): Promise<void> {
    runSqliteWrite(() => this.#upsertRegistration(registration));
  }

  #insertDraft(draft: ProductOrderDraftDTO): void {
    this.#database.prepare(
      `INSERT INTO product_order_draft (
         draft_id, zhixu_id, plan_id, plan_hash, title, business_type, goods_json,
         total_amount, currency, export_region, destination_region, expected_completion_date,
         notes, status, created_by, created_at, updated_at, triggered_order_id, trigger_tx_hash
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(...draftValues(draft));
  }

  #upsertDraft(draft: ProductOrderDraftDTO): void {
    this.#database.prepare(
      `INSERT INTO product_order_draft (
         draft_id, zhixu_id, plan_id, plan_hash, title, business_type, goods_json,
         total_amount, currency, export_region, destination_region, expected_completion_date,
         notes, status, created_by, created_at, updated_at, triggered_order_id, trigger_tx_hash
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(draft_id)
       DO UPDATE SET
         zhixu_id = excluded.zhixu_id,
         plan_id = excluded.plan_id,
         plan_hash = excluded.plan_hash,
         title = excluded.title,
         business_type = excluded.business_type,
         goods_json = excluded.goods_json,
         total_amount = excluded.total_amount,
         currency = excluded.currency,
         export_region = excluded.export_region,
         destination_region = excluded.destination_region,
         expected_completion_date = excluded.expected_completion_date,
         notes = excluded.notes,
         status = excluded.status,
         created_by = excluded.created_by,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at,
         triggered_order_id = excluded.triggered_order_id,
         trigger_tx_hash = excluded.trigger_tx_hash`
    ).run(...draftValues(draft));
  }

  #upsertParticipant(participant: DraftParticipantDTO): void {
    this.#database.prepare(
      `INSERT INTO product_participant (
         participant_id, draft_id, role_slot_id, role_label, display_name, wallet_address,
         contact, status, required, accepted_at, rejected_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(participant_id)
       DO UPDATE SET
         draft_id = excluded.draft_id,
         role_slot_id = excluded.role_slot_id,
         role_label = excluded.role_label,
         display_name = excluded.display_name,
         wallet_address = excluded.wallet_address,
         contact = excluded.contact,
         status = excluded.status,
         required = excluded.required,
         accepted_at = excluded.accepted_at,
         rejected_at = excluded.rejected_at`
    ).run(
      participant.participantId,
      participant.draftId,
      participant.roleSlotId,
      participant.roleLabel,
      participant.displayName,
      participant.walletAddress ?? null,
      participant.contact,
      participant.status,
      participant.required ? 1 : 0,
      participant.acceptedAt ?? null,
      participant.rejectedAt ?? null
    );
  }

  #insertInvite(invite: ProductInviteDTO): void {
    this.#database.prepare(
      `INSERT INTO product_invite (
         invite_id, draft_id, participant_id, role_slot_id, token_hash, status,
         expires_at, created_at, accepted_wallet_address
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(...inviteValues(invite));
  }

  #upsertInvite(invite: ProductInviteDTO): void {
    this.#database.prepare(
      `INSERT INTO product_invite (
         invite_id, draft_id, participant_id, role_slot_id, token_hash, status,
         expires_at, created_at, accepted_wallet_address
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(invite_id)
       DO UPDATE SET
         draft_id = excluded.draft_id,
         participant_id = excluded.participant_id,
         role_slot_id = excluded.role_slot_id,
         token_hash = excluded.token_hash,
         status = excluded.status,
         expires_at = excluded.expires_at,
         created_at = excluded.created_at,
         accepted_wallet_address = excluded.accepted_wallet_address`
    ).run(...inviteValues(invite));
  }

  #insertRegistration(registration: ProductOrderTriggerRecord): void {
    this.#database.prepare(
      `INSERT INTO product_order_trigger (
         trigger_id, prepare_id, draft_id, order_id, plan_id, plan_hash, status, tx_hash,
         block_number, source_id, signal_id, trigger_hook_id, trigger_stage_id, submitter,
         payload_hash, idempotency_key, deadline, typed_data_json, signature,
         error_code, error_message, retryable, creator, authorizations_json, permissions_json,
         reconcile_status, last_checked_at, receipt_status, projection_status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(...registrationValues(registration));
  }

  #upsertRegistration(registration: ProductOrderTriggerRecord): void {
    this.#database.prepare(
      `INSERT INTO product_order_trigger (
         trigger_id, prepare_id, draft_id, order_id, plan_id, plan_hash, status, tx_hash,
         block_number, source_id, signal_id, trigger_hook_id, trigger_stage_id, submitter,
         payload_hash, idempotency_key, deadline, typed_data_json, signature,
         error_code, error_message, retryable, creator, authorizations_json, permissions_json,
         reconcile_status, last_checked_at, receipt_status, projection_status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(trigger_id)
       DO UPDATE SET
         prepare_id = excluded.prepare_id,
         draft_id = excluded.draft_id,
         order_id = excluded.order_id,
         plan_id = excluded.plan_id,
         plan_hash = excluded.plan_hash,
         status = excluded.status,
         tx_hash = excluded.tx_hash,
         block_number = excluded.block_number,
         source_id = excluded.source_id,
         signal_id = excluded.signal_id,
         trigger_hook_id = excluded.trigger_hook_id,
         trigger_stage_id = excluded.trigger_stage_id,
         submitter = excluded.submitter,
         payload_hash = excluded.payload_hash,
         idempotency_key = excluded.idempotency_key,
         deadline = excluded.deadline,
         typed_data_json = excluded.typed_data_json,
         signature = excluded.signature,
         error_code = excluded.error_code,
         error_message = excluded.error_message,
         retryable = excluded.retryable,
         creator = excluded.creator,
         authorizations_json = excluded.authorizations_json,
         permissions_json = excluded.permissions_json,
         reconcile_status = excluded.reconcile_status,
         last_checked_at = excluded.last_checked_at,
         receipt_status = excluded.receipt_status,
         projection_status = excluded.projection_status,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at`
    ).run(...registrationValues(registration));
  }

}

function draftValues(draft: ProductOrderDraftDTO) {
  return [
    draft.draftId,
    draft.zhixuId,
    draft.planId,
    draft.planHash,
    draft.title,
    draft.businessType,
    stringifyStorageJson(draft.goods),
    draft.totalAmount,
    draft.currency,
    draft.exportRegion ?? null,
    draft.destinationRegion ?? null,
    draft.expectedCompletionDate ?? null,
    draft.notes ?? null,
    draft.status,
    draft.createdBy ?? null,
    draft.createdAt,
    draft.updatedAt,
    draft.triggeredOrderId ?? null,
    draft.triggerTxHash ?? null
  ] as const;
}

function inviteValues(invite: ProductInviteDTO) {
  return [
    invite.inviteId,
    invite.draftId,
    invite.participantId,
    invite.roleSlotId,
    invite.tokenHash,
    invite.status,
    invite.expiresAt,
    invite.createdAt,
    invite.acceptedWalletAddress ?? null
  ] as const;
}

function registrationValues(registration: ProductOrderTriggerRecord) {
  return [
    registration.triggerId,
    registration.prepareId ?? null,
    registration.draftId,
    registration.orderId,
    registration.planId,
    registration.planHash,
    registration.status,
    registration.txHash ?? null,
    registration.blockNumber ?? null,
    registration.sourceId ?? null,
    registration.signalId ?? null,
    registration.triggerHookId ?? null,
    registration.triggerStageId ?? null,
    registration.submitter ?? null,
    registration.payloadHash ?? null,
    registration.idempotencyKey ?? null,
    registration.deadline ?? null,
    stringifyStorageJson(registration.typedData ?? {}),
    registration.signature ?? null,
    registration.errorCode ?? null,
    registration.errorMessage ?? null,
    registration.retryable ? 1 : 0,
    registration.creator,
    stringifyStorageJson(registration.authorizations),
    stringifyStorageJson(registration.permissions),
    registration.reconcileStatus ?? null,
    registration.lastCheckedAt ?? null,
    registration.receiptStatus ?? null,
    registration.projectionStatus ?? null,
    registration.createdAt,
    registration.updatedAt
  ] as const;
}

function draftRow(row: unknown): ProductOrderDraftDTO {
  const record = rowObject(row, "product_order_draft query");
  const exportRegion = optionalStringColumn(record, "export_region");
  const destinationRegion = optionalStringColumn(record, "destination_region");
  const expectedCompletionDate = optionalStringColumn(record, "expected_completion_date");
  const notes = optionalStringColumn(record, "notes");
  const createdBy = optionalStringColumn(record, "created_by");
  const triggeredOrderId = optionalStringColumn(record, "triggered_order_id");
  const triggerTxHash = optionalStringColumn(record, "trigger_tx_hash");
  return {
    draftId: stringColumn(record, "draft_id"),
    zhixuId: stringColumn(record, "zhixu_id"),
    planId: stringColumn(record, "plan_id") as ProductOrderDraftDTO["planId"],
    planHash: stringColumn(record, "plan_hash") as ProductOrderDraftDTO["planHash"],
    title: stringColumn(record, "title"),
    businessType: stringColumn(record, "business_type"),
    goods: parseStorageJson<readonly string[]>(stringColumn(record, "goods_json")),
    totalAmount: stringColumn(record, "total_amount"),
    currency: stringColumn(record, "currency"),
    ...(exportRegion !== undefined ? { exportRegion } : {}),
    ...(destinationRegion !== undefined ? { destinationRegion } : {}),
    ...(expectedCompletionDate !== undefined ? { expectedCompletionDate } : {}),
    ...(notes !== undefined ? { notes } : {}),
    status: stringColumn(record, "status") as ProductOrderDraftDTO["status"],
    ...(createdBy !== undefined ? { createdBy } : {}),
    createdAt: stringColumn(record, "created_at"),
    updatedAt: stringColumn(record, "updated_at"),
    ...(triggeredOrderId !== undefined ? { triggeredOrderId } : {}),
    ...(triggerTxHash !== undefined
      ? { triggerTxHash: triggerTxHash as NonNullable<ProductOrderDraftDTO["triggerTxHash"]> }
      : {})
  };
}

function participantRow(row: unknown): DraftParticipantDTO {
  const record = rowObject(row, "product_participant query");
  const walletAddress = optionalStringColumn(record, "wallet_address");
  const acceptedAt = optionalStringColumn(record, "accepted_at");
  const rejectedAt = optionalStringColumn(record, "rejected_at");
  return {
    participantId: stringColumn(record, "participant_id"),
    draftId: stringColumn(record, "draft_id"),
    roleSlotId: stringColumn(record, "role_slot_id"),
    roleLabel: stringColumn(record, "role_label"),
    displayName: stringColumn(record, "display_name"),
    ...(walletAddress !== undefined ? { walletAddress } : {}),
    contact: stringColumn(record, "contact"),
    status: stringColumn(record, "status") as DraftParticipantDTO["status"],
    required: booleanColumn(record, "required"),
    ...(acceptedAt !== undefined ? { acceptedAt } : {}),
    ...(rejectedAt !== undefined ? { rejectedAt } : {})
  };
}

function inviteRow(row: unknown): ProductInviteDTO {
  const record = rowObject(row, "product_invite query");
  const acceptedWalletAddress = optionalStringColumn(record, "accepted_wallet_address");
  return {
    inviteId: stringColumn(record, "invite_id"),
    draftId: stringColumn(record, "draft_id"),
    participantId: stringColumn(record, "participant_id"),
    roleSlotId: stringColumn(record, "role_slot_id"),
    tokenHash: stringColumn(record, "token_hash") as ProductInviteDTO["tokenHash"],
    status: stringColumn(record, "status") as ProductInviteDTO["status"],
    expiresAt: stringColumn(record, "expires_at"),
    createdAt: stringColumn(record, "created_at"),
    ...(acceptedWalletAddress !== undefined
      ? { acceptedWalletAddress: acceptedWalletAddress as NonNullable<ProductInviteDTO["acceptedWalletAddress"]> }
      : {})
  };
}

function registrationRow(row: unknown): ProductOrderTriggerRecord {
  const record = rowObject(row, "product_order_trigger query");
  const triggerId = stringColumn(record, "trigger_id");
  const prepareId = optionalStringColumn(record, "prepare_id");
  const txHash = optionalStringColumn(record, "tx_hash");
  const blockNumber = optionalStringColumn(record, "block_number");
  const sourceId = optionalStringColumn(record, "source_id");
  const signalId = optionalStringColumn(record, "signal_id");
  const triggerHookId = optionalStringColumn(record, "trigger_hook_id");
  const triggerStageId = optionalStringColumn(record, "trigger_stage_id");
  const submitter = optionalStringColumn(record, "submitter");
  const payloadHash = optionalStringColumn(record, "payload_hash");
  const idempotencyKey = optionalStringColumn(record, "idempotency_key");
  const deadline = optionalStringColumn(record, "deadline");
  const typedDataJson = optionalStringColumn(record, "typed_data_json");
  const signature = optionalStringColumn(record, "signature");
  const errorCode = optionalStringColumn(record, "error_code");
  const errorMessage = optionalStringColumn(record, "error_message");
  const reconcileStatus = optionalStringColumn(record, "reconcile_status");
  const lastCheckedAt = optionalStringColumn(record, "last_checked_at");
  const receiptStatus = optionalStringColumn(record, "receipt_status");
  const projectionStatus = optionalStringColumn(record, "projection_status");
  const authorizations = parseStorageJson<readonly SignalAuthorizationDTO[]>(stringColumn(record, "authorizations_json"));
  const permissions = parseStorageJson<readonly ParticipantPermissionDTO[]>(stringColumn(record, "permissions_json"));
  return {
    triggerId,
    prepareId: prepareId ?? triggerId,
    draftId: stringColumn(record, "draft_id"),
    orderId: stringColumn(record, "order_id") as ProductOrderTriggerRecord["orderId"],
    planId: stringColumn(record, "plan_id") as ProductOrderTriggerRecord["planId"],
    planHash: stringColumn(record, "plan_hash") as ProductOrderTriggerRecord["planHash"],
    status: stringColumn(record, "status") as ProductOrderTriggerRecord["status"],
    ...(txHash !== undefined ? { txHash: txHash as NonNullable<ProductOrderTriggerRecord["txHash"]> } : {}),
    ...(blockNumber !== undefined ? { blockNumber } : {}),
    ...(sourceId !== undefined ? { sourceId: sourceId as NonNullable<ProductOrderTriggerRecord["sourceId"]> } : {}),
    ...(signalId !== undefined ? { signalId: signalId as NonNullable<ProductOrderTriggerRecord["signalId"]> } : {}),
    ...(triggerHookId !== undefined
      ? { triggerHookId: triggerHookId as NonNullable<ProductOrderTriggerRecord["triggerHookId"]> }
      : {}),
    ...(triggerStageId !== undefined
      ? { triggerStageId: triggerStageId as NonNullable<ProductOrderTriggerRecord["triggerStageId"]> }
      : {}),
    ...(submitter !== undefined ? { submitter: submitter as NonNullable<ProductOrderTriggerRecord["submitter"]> } : {}),
    payloadHash: (payloadHash ?? zeroBytes32) as ProductOrderTriggerRecord["orderId"],
    idempotencyKey: (idempotencyKey ?? zeroBytes32) as ProductOrderTriggerRecord["orderId"],
    deadline: deadline ?? "0",
    typedData: typedDataJson ? parseStorageJson<unknown>(typedDataJson) : {},
    ...(signature !== undefined ? { signature: signature as NonNullable<ProductOrderTriggerRecord["signature"]> } : {}),
    ...(errorCode !== undefined ? { errorCode } : {}),
    ...(errorMessage !== undefined ? { errorMessage } : {}),
    retryable: booleanColumn(record, "retryable"),
    createdAt: stringColumn(record, "created_at"),
    updatedAt: stringColumn(record, "updated_at"),
    creator: stringColumn(record, "creator") as ProductOrderTriggerRecord["creator"],
    authorizations,
    permissions,
    ...(reconcileStatus !== undefined
      ? { reconcileStatus: reconcileStatus as NonNullable<ProductOrderTriggerRecord["reconcileStatus"]> }
      : {}),
    ...(lastCheckedAt !== undefined ? { lastCheckedAt } : {}),
    ...(receiptStatus !== undefined
      ? { receiptStatus: receiptStatus as NonNullable<ProductOrderTriggerRecord["receiptStatus"]> }
      : {}),
    ...(projectionStatus !== undefined
      ? { projectionStatus: projectionStatus as NonNullable<ProductOrderTriggerRecord["projectionStatus"]> }
      : {})
  };
}
