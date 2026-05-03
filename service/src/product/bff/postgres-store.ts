import { parseStorageJson, stringifyStorageJson } from "../../storage/json.js";
import { PostgresDatabase } from "../../storage/postgres-client.js";
import {
  booleanColumn,
  optionalStringColumn,
  rowObject,
  stringColumn
} from "../../storage/postgres-rows.js";
import type {
  DraftParticipantDTO,
  ParticipantPermissionDTO,
  ProductInviteDTO,
  ProductOrderDraftDTO,
  ProductOrderRegistrationRecord,
  ProductOrderStartDTO,
  SignalAuthorizationDTO
} from "./types.js";
import {
  applyOrderStartPatch,
  type ProductBffStore,
  type ProductOrderStartListOptions,
  type ProductOrderStartPatch
} from "./store.js";

export interface PostgresProductBffStoreOptions {
  readonly databaseUrl?: string;
  readonly database?: PostgresDatabase;
  readonly migrations?: {
    readonly autoRun?: boolean;
    readonly directory?: string;
  };
}

export class PostgresProductBffStore implements ProductBffStore {
  readonly driver = "postgres" as const;

  readonly #database: PostgresDatabase;
  readonly #ownsDatabase: boolean;

  constructor(options: PostgresProductBffStoreOptions) {
    if (!options.database && !options.databaseUrl) {
      throw new Error("PostgresProductBffStore requires database or databaseUrl");
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

  async withTransaction<T>(operation: () => Promise<T>): Promise<T> {
    return this.#database.withTransaction(operation);
  }

  async createDraft(draft: ProductOrderDraftDTO, participants: readonly DraftParticipantDTO[]): Promise<void> {
    await this.withTransaction(async () => {
      await this.#insertDraft(draft);
      for (const participant of participants) {
        await this.#upsertParticipant(participant);
      }
    });
  }

  async getDraft(draftId: string): Promise<ProductOrderDraftDTO | undefined> {
    const result = await this.#database.query(
      `SELECT *, goods_json::text AS goods_json
       FROM product_order_draft
       WHERE draft_id = $1`,
      [draftId]
    );
    return result.rows[0] ? draftRow(result.rows[0]) : undefined;
  }

  async updateDraft(draft: ProductOrderDraftDTO): Promise<void> {
    await this.#upsertDraft(draft);
  }

  async listParticipants(draftId: string): Promise<readonly DraftParticipantDTO[]> {
    const result = await this.#database.query(
      `SELECT *
       FROM product_participant
       WHERE draft_id = $1
       ORDER BY participant_id ASC`,
      [draftId]
    );
    return result.rows.map((row) => participantRow(row));
  }

  async listAcceptedParticipantsByWallet(walletAddress: string): Promise<readonly DraftParticipantDTO[]> {
    const result = await this.#database.query(
      `SELECT *
       FROM product_participant
       WHERE status = 'accepted'
         AND LOWER(wallet_address) = LOWER($1)
       ORDER BY accepted_at ASC, participant_id ASC`,
      [walletAddress]
    );
    return result.rows.map((row) => participantRow(row));
  }

  async getParticipant(participantId: string): Promise<DraftParticipantDTO | undefined> {
    const result = await this.#database.query(
      `SELECT *
       FROM product_participant
       WHERE participant_id = $1`,
      [participantId]
    );
    return result.rows[0] ? participantRow(result.rows[0]) : undefined;
  }

  async updateParticipant(participant: DraftParticipantDTO): Promise<void> {
    await this.#upsertParticipant(participant);
  }

  async createInvite(invite: ProductInviteDTO): Promise<void> {
    await this.#insertInvite(invite);
  }

  async getInvite(inviteId: string): Promise<ProductInviteDTO | undefined> {
    const result = await this.#database.query(
      `SELECT *
       FROM product_invite
       WHERE invite_id = $1`,
      [inviteId]
    );
    return result.rows[0] ? inviteRow(result.rows[0]) : undefined;
  }

  async updateInvite(invite: ProductInviteDTO): Promise<void> {
    await this.#upsertInvite(invite);
  }

  async listInvitesByDraft(draftId: string): Promise<readonly ProductInviteDTO[]> {
    const result = await this.#database.query(
      `SELECT *
       FROM product_invite
       WHERE draft_id = $1
       ORDER BY created_at ASC, invite_id ASC`,
      [draftId]
    );
    return result.rows.map((row) => inviteRow(row));
  }

  async createRegistration(registration: ProductOrderRegistrationRecord): Promise<void> {
    await this.#insertRegistration(registration);
  }

  async getRegistration(registrationId: string): Promise<ProductOrderRegistrationRecord | undefined> {
    const result = await this.#database.query(
      `SELECT
         *,
         authorizations_json::text AS authorizations_json,
         permissions_json::text AS permissions_json
       FROM product_order_registration
       WHERE registration_id = $1`,
      [registrationId]
    );
    return result.rows[0] ? registrationRow(result.rows[0]) : undefined;
  }

  async getRegistrationByDraft(draftId: string): Promise<ProductOrderRegistrationRecord | undefined> {
    const result = await this.#database.query(
      `SELECT
         *,
         authorizations_json::text AS authorizations_json,
         permissions_json::text AS permissions_json
       FROM product_order_registration
       WHERE draft_id = $1`,
      [draftId]
    );
    return result.rows[0] ? registrationRow(result.rows[0]) : undefined;
  }

  async listRegistrations(): Promise<readonly ProductOrderRegistrationRecord[]> {
    const result = await this.#database.query(
      `SELECT
         *,
         authorizations_json::text AS authorizations_json,
         permissions_json::text AS permissions_json
       FROM product_order_registration
       ORDER BY created_at ASC, registration_id ASC`
    );
    return result.rows.map((row) => registrationRow(row));
  }

  async updateRegistration(registration: ProductOrderRegistrationRecord): Promise<void> {
    await this.#upsertRegistration(registration);
  }

  async createOrderStart(record: ProductOrderStartDTO): Promise<void> {
    await this.#insertOrderStart(record);
  }

  async getOrderStartByRegistrationId(registrationId: string): Promise<ProductOrderStartDTO | undefined> {
    const result = await this.#database.query(
      `SELECT *
       FROM product_order_start
       WHERE registration_id = $1`,
      [registrationId]
    );
    return result.rows[0] ? orderStartRow(result.rows[0]) : undefined;
  }

  async updateOrderStart(startId: string, patch: ProductOrderStartPatch): Promise<ProductOrderStartDTO | undefined> {
    const current = await this.#database.query(
      `SELECT *
       FROM product_order_start
       WHERE start_id = $1`,
      [startId]
    );
    if (!current.rows[0]) {
      return undefined;
    }
    const updated = applyOrderStartPatch(orderStartRow(current.rows[0]), patch);
    await this.#upsertOrderStart(updated);
    return updated;
  }

  async listOrderStartsForReconcile(options: ProductOrderStartListOptions = {}): Promise<readonly ProductOrderStartDTO[]> {
    const result = options.statuses && options.statuses.length > 0
      ? await this.#database.query(
          `SELECT *
           FROM product_order_start
           WHERE status = ANY($1::text[])
           ORDER BY created_at ASC, start_id ASC`,
          [options.statuses]
        )
      : await this.#database.query(
          `SELECT *
           FROM product_order_start
           ORDER BY created_at ASC, start_id ASC`
        );
    return result.rows.map((row) => orderStartRow(row));
  }

  async #insertDraft(draft: ProductOrderDraftDTO): Promise<void> {
    await this.#database.query(
      `INSERT INTO product_order_draft (
         draft_id, zhixu_id, plan_id, plan_hash, title, business_type, goods_json,
         total_amount, currency, export_region, destination_region, expected_completion_date,
         notes, status, created_by, created_at, updated_at, registered_order_id, registration_tx_hash
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
      draftValues(draft)
    );
  }

  async #upsertDraft(draft: ProductOrderDraftDTO): Promise<void> {
    await this.#database.query(
      `INSERT INTO product_order_draft (
         draft_id, zhixu_id, plan_id, plan_hash, title, business_type, goods_json,
         total_amount, currency, export_region, destination_region, expected_completion_date,
         notes, status, created_by, created_at, updated_at, registered_order_id, registration_tx_hash
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
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
         registered_order_id = excluded.registered_order_id,
         registration_tx_hash = excluded.registration_tx_hash`,
      draftValues(draft)
    );
  }

  async #upsertParticipant(participant: DraftParticipantDTO): Promise<void> {
    await this.#database.query(
      `INSERT INTO product_participant (
         participant_id, draft_id, role_slot_id, role_label, display_name, wallet_address,
         contact, status, required, accepted_at, rejected_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
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
         rejected_at = excluded.rejected_at`,
      [
        participant.participantId,
        participant.draftId,
        participant.roleSlotId,
        participant.roleLabel,
        participant.displayName,
        participant.walletAddress ?? null,
        participant.contact,
        participant.status,
        participant.required,
        participant.acceptedAt ?? null,
        participant.rejectedAt ?? null
      ]
    );
  }

  async #insertInvite(invite: ProductInviteDTO): Promise<void> {
    await this.#database.query(
      `INSERT INTO product_invite (
         invite_id, draft_id, participant_id, role_slot_id, token_hash, status,
         expires_at, created_at, accepted_wallet_address
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      inviteValues(invite)
    );
  }

  async #upsertInvite(invite: ProductInviteDTO): Promise<void> {
    await this.#database.query(
      `INSERT INTO product_invite (
         invite_id, draft_id, participant_id, role_slot_id, token_hash, status,
         expires_at, created_at, accepted_wallet_address
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT(invite_id)
       DO UPDATE SET
         draft_id = excluded.draft_id,
         participant_id = excluded.participant_id,
         role_slot_id = excluded.role_slot_id,
         token_hash = excluded.token_hash,
         status = excluded.status,
         expires_at = excluded.expires_at,
         created_at = excluded.created_at,
         accepted_wallet_address = excluded.accepted_wallet_address`,
      inviteValues(invite)
    );
  }

  async #insertRegistration(registration: ProductOrderRegistrationRecord): Promise<void> {
    await this.#database.query(
      `INSERT INTO product_order_registration (
         registration_id, draft_id, order_id, state_machine_address, deployment_id,
         plan_id, plan_hash, status, tx_hash, block_number, error_code, error_message,
         retryable, creator, authorizations_json, permissions_json, reconcile_status,
         last_checked_at, receipt_status, projection_status, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16::jsonb, $17, $18, $19, $20, $21, $22)`,
      registrationValues(registration)
    );
  }

  async #upsertRegistration(registration: ProductOrderRegistrationRecord): Promise<void> {
    await this.#database.query(
      `INSERT INTO product_order_registration (
         registration_id, draft_id, order_id, state_machine_address, deployment_id,
         plan_id, plan_hash, status, tx_hash, block_number, error_code, error_message,
         retryable, creator, authorizations_json, permissions_json, reconcile_status,
         last_checked_at, receipt_status, projection_status, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16::jsonb, $17, $18, $19, $20, $21, $22)
       ON CONFLICT(registration_id)
       DO UPDATE SET
         draft_id = excluded.draft_id,
         order_id = excluded.order_id,
         state_machine_address = excluded.state_machine_address,
         deployment_id = excluded.deployment_id,
         plan_id = excluded.plan_id,
         plan_hash = excluded.plan_hash,
         status = excluded.status,
         tx_hash = excluded.tx_hash,
         block_number = excluded.block_number,
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
         updated_at = excluded.updated_at`,
      registrationValues(registration)
    );
  }

  async #insertOrderStart(start: ProductOrderStartDTO): Promise<void> {
    await this.#database.query(
      `INSERT INTO product_order_start (
         start_id, registration_id, draft_id, order_id, state_machine_address, deployment_id,
         status, tx_hash, block_number, error_code, error_message, retryable, reconcile_status,
         last_checked_at, receipt_status, projection_status, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
      orderStartValues(start)
    );
  }

  async #upsertOrderStart(start: ProductOrderStartDTO): Promise<void> {
    await this.#database.query(
      `INSERT INTO product_order_start (
         start_id, registration_id, draft_id, order_id, state_machine_address, deployment_id,
         status, tx_hash, block_number, error_code, error_message, retryable, reconcile_status,
         last_checked_at, receipt_status, projection_status, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
       ON CONFLICT(start_id)
       DO UPDATE SET
         registration_id = excluded.registration_id,
         draft_id = excluded.draft_id,
         order_id = excluded.order_id,
         state_machine_address = excluded.state_machine_address,
         deployment_id = excluded.deployment_id,
         status = excluded.status,
         tx_hash = excluded.tx_hash,
         block_number = excluded.block_number,
         error_code = excluded.error_code,
         error_message = excluded.error_message,
         retryable = excluded.retryable,
         reconcile_status = excluded.reconcile_status,
         last_checked_at = excluded.last_checked_at,
         receipt_status = excluded.receipt_status,
         projection_status = excluded.projection_status,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at`,
      orderStartValues(start)
    );
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
    draft.registeredOrderId ?? null,
    draft.registrationTxHash ?? null
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

function registrationValues(registration: ProductOrderRegistrationRecord) {
  return [
    registration.registrationId,
    registration.draftId,
    registration.orderId,
    registration.stateMachineAddress ?? null,
    registration.deploymentId ?? null,
    registration.planId,
    registration.planHash,
    registration.status,
    registration.txHash ?? null,
    registration.blockNumber ?? null,
    registration.errorCode ?? null,
    registration.errorMessage ?? null,
    registration.retryable,
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

function orderStartValues(start: ProductOrderStartDTO) {
  return [
    start.startId,
    start.registrationId,
    start.draftId,
    start.orderId,
    start.stateMachineAddress ?? null,
    start.deploymentId ?? null,
    start.status,
    start.txHash ?? null,
    start.blockNumber ?? null,
    start.errorCode ?? null,
    start.errorMessage ?? null,
    start.retryable,
    start.reconcileStatus ?? null,
    start.lastCheckedAt ?? null,
    start.receiptStatus ?? null,
    start.projectionStatus ?? null,
    start.createdAt,
    start.updatedAt
  ] as const;
}

function draftRow(row: unknown): ProductOrderDraftDTO {
  const record = rowObject(row, "product_order_draft query");
  const exportRegion = optionalStringColumn(record, "export_region");
  const destinationRegion = optionalStringColumn(record, "destination_region");
  const expectedCompletionDate = optionalStringColumn(record, "expected_completion_date");
  const notes = optionalStringColumn(record, "notes");
  const createdBy = optionalStringColumn(record, "created_by");
  const registeredOrderId = optionalStringColumn(record, "registered_order_id");
  const registrationTxHash = optionalStringColumn(record, "registration_tx_hash");
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
    ...(registeredOrderId !== undefined ? { registeredOrderId } : {}),
    ...(registrationTxHash !== undefined
      ? { registrationTxHash: registrationTxHash as NonNullable<ProductOrderDraftDTO["registrationTxHash"]> }
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

function registrationRow(row: unknown): ProductOrderRegistrationRecord {
  const record = rowObject(row, "product_order_registration query");
  const stateMachineAddress = optionalStringColumn(record, "state_machine_address");
  const deploymentId = optionalStringColumn(record, "deployment_id");
  const txHash = optionalStringColumn(record, "tx_hash");
  const blockNumber = optionalStringColumn(record, "block_number");
  const errorCode = optionalStringColumn(record, "error_code");
  const errorMessage = optionalStringColumn(record, "error_message");
  const reconcileStatus = optionalStringColumn(record, "reconcile_status");
  const lastCheckedAt = optionalStringColumn(record, "last_checked_at");
  const receiptStatus = optionalStringColumn(record, "receipt_status");
  const projectionStatus = optionalStringColumn(record, "projection_status");
  const authorizations = parseStorageJson<readonly SignalAuthorizationDTO[]>(stringColumn(record, "authorizations_json"));
  const permissions = parseStorageJson<readonly ParticipantPermissionDTO[]>(stringColumn(record, "permissions_json"));
  return {
    registrationId: stringColumn(record, "registration_id"),
    draftId: stringColumn(record, "draft_id"),
    orderId: stringColumn(record, "order_id") as ProductOrderRegistrationRecord["orderId"],
    ...(stateMachineAddress !== undefined
      ? { stateMachineAddress: stateMachineAddress as NonNullable<ProductOrderRegistrationRecord["stateMachineAddress"]> }
      : {}),
    ...(deploymentId !== undefined
      ? { deploymentId: deploymentId as NonNullable<ProductOrderRegistrationRecord["deploymentId"]> }
      : {}),
    planId: stringColumn(record, "plan_id") as ProductOrderRegistrationRecord["planId"],
    planHash: stringColumn(record, "plan_hash") as ProductOrderRegistrationRecord["planHash"],
    status: stringColumn(record, "status") as ProductOrderRegistrationRecord["status"],
    ...(txHash !== undefined ? { txHash: txHash as NonNullable<ProductOrderRegistrationRecord["txHash"]> } : {}),
    ...(blockNumber !== undefined ? { blockNumber } : {}),
    ...(errorCode !== undefined ? { errorCode } : {}),
    ...(errorMessage !== undefined ? { errorMessage } : {}),
    retryable: booleanColumn(record, "retryable"),
    createdAt: stringColumn(record, "created_at"),
    updatedAt: stringColumn(record, "updated_at"),
    creator: stringColumn(record, "creator") as ProductOrderRegistrationRecord["creator"],
    authorizations,
    permissions,
    ...(reconcileStatus !== undefined
      ? { reconcileStatus: reconcileStatus as NonNullable<ProductOrderRegistrationRecord["reconcileStatus"]> }
      : {}),
    ...(lastCheckedAt !== undefined ? { lastCheckedAt } : {}),
    ...(receiptStatus !== undefined
      ? { receiptStatus: receiptStatus as NonNullable<ProductOrderRegistrationRecord["receiptStatus"]> }
      : {}),
    ...(projectionStatus !== undefined
      ? { projectionStatus: projectionStatus as NonNullable<ProductOrderRegistrationRecord["projectionStatus"]> }
      : {})
  };
}

function orderStartRow(row: unknown): ProductOrderStartDTO {
  const record = rowObject(row, "product_order_start query");
  const stateMachineAddress = optionalStringColumn(record, "state_machine_address");
  const deploymentId = optionalStringColumn(record, "deployment_id");
  const txHash = optionalStringColumn(record, "tx_hash");
  const blockNumber = optionalStringColumn(record, "block_number");
  const errorCode = optionalStringColumn(record, "error_code");
  const errorMessage = optionalStringColumn(record, "error_message");
  const reconcileStatus = optionalStringColumn(record, "reconcile_status");
  const lastCheckedAt = optionalStringColumn(record, "last_checked_at");
  const receiptStatus = optionalStringColumn(record, "receipt_status");
  const projectionStatus = optionalStringColumn(record, "projection_status");
  return {
    startId: stringColumn(record, "start_id"),
    registrationId: stringColumn(record, "registration_id"),
    draftId: stringColumn(record, "draft_id"),
    orderId: stringColumn(record, "order_id") as ProductOrderStartDTO["orderId"],
    ...(stateMachineAddress !== undefined
      ? { stateMachineAddress: stateMachineAddress as NonNullable<ProductOrderStartDTO["stateMachineAddress"]> }
      : {}),
    ...(deploymentId !== undefined
      ? { deploymentId: deploymentId as NonNullable<ProductOrderStartDTO["deploymentId"]> }
      : {}),
    status: stringColumn(record, "status") as ProductOrderStartDTO["status"],
    ...(txHash !== undefined ? { txHash: txHash as NonNullable<ProductOrderStartDTO["txHash"]> } : {}),
    ...(blockNumber !== undefined ? { blockNumber } : {}),
    ...(errorCode !== undefined ? { errorCode } : {}),
    ...(errorMessage !== undefined ? { errorMessage } : {}),
    retryable: booleanColumn(record, "retryable"),
    createdAt: stringColumn(record, "created_at"),
    updatedAt: stringColumn(record, "updated_at"),
    ...(reconcileStatus !== undefined
      ? { reconcileStatus: reconcileStatus as NonNullable<ProductOrderStartDTO["reconcileStatus"]> }
      : {}),
    ...(lastCheckedAt !== undefined ? { lastCheckedAt } : {}),
    ...(receiptStatus !== undefined
      ? { receiptStatus: receiptStatus as NonNullable<ProductOrderStartDTO["receiptStatus"]> }
      : {}),
    ...(projectionStatus !== undefined
      ? { projectionStatus: projectionStatus as NonNullable<ProductOrderStartDTO["projectionStatus"]> }
      : {})
  };
}
