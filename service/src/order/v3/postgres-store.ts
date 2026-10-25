// V3 订单域 postgres 持久化（迁移 postgres/0032_order_domain_v3.sql）：
// 与 sqlite/内存同语义；行映射共用 rows.ts。

import type { OrderConfigStatusV3 } from "@uvp-eth/product-dto";
import { parseStorageJson, stringifyStorageJson } from "../../storage/json.js";
import { PostgresDatabase } from "../../storage/postgres-client.js";
import { rowObject, stringColumn } from "../../storage/postgres-rows.js";
import type { Address, Hex } from "../../shared/types.js";
import {
  configRecord,
  draftRecord,
  idempotencyRecord,
  inviteRecord,
  orderRecord,
  slotRecord,
  stageRecord,
} from "./rows.js";
import type {
  ConfigVersionRecord,
  IdempotencyRecord,
  OrderDraftRecord,
  OrderInviteRecord,
  OrderRecord,
  OrderStageRecord,
  OrderStageSlotRecord,
  OrderV3Store,
} from "./types.js";

export interface PostgresOrderV3StoreOptions {
  readonly databaseUrl?: string;
  readonly database?: PostgresDatabase;
  readonly migrations?: {
    readonly autoRun?: boolean;
    readonly directory?: string;
  };
}

export class PostgresOrderV3Store implements OrderV3Store {
  readonly #database: PostgresDatabase;
  readonly #ownsDatabase: boolean;

  constructor(options: PostgresOrderV3StoreOptions) {
    if (!options.database && !options.databaseUrl) {
      throw new Error("PostgresOrderV3Store requires database or databaseUrl");
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

  async getConfig(configId: string, version: string): Promise<ConfigVersionRecord | undefined> {
    const result = await this.#database.query(
      `SELECT * FROM order_config_v3 WHERE config_id = $1 AND version = $2`,
      [configId, version],
    );
    return result.rows[0] ? configRecord(result.rows[0]) : undefined;
  }

  async saveConfig(record: ConfigVersionRecord): Promise<void> {
    await this.#database.query(
      `INSERT INTO order_config_v3 (
         config_id, version, status, config_hash, plan_id, plan_hash,
         birth_json, executor_profile_json, bundle_json, created_by, created_at, published_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT(config_id, version) DO UPDATE SET
         status = excluded.status,
         config_hash = excluded.config_hash,
         plan_id = excluded.plan_id,
         plan_hash = excluded.plan_hash,
         birth_json = excluded.birth_json,
         executor_profile_json = excluded.executor_profile_json,
         bundle_json = excluded.bundle_json,
         published_at = excluded.published_at,
         updated_at = excluded.updated_at`,
      [
        record.configId,
        record.version,
        record.status,
        record.configHash,
        record.planId ?? null,
        record.planHash ?? null,
        record.birth ? stringifyStorageJson(record.birth) : null,
        record.executorProfile ? stringifyStorageJson(record.executorProfile) : null,
        stringifyStorageJson(record.bundle),
        record.createdBy,
        record.createdAt,
        record.publishedAt ?? null,
        record.updatedAt,
      ],
    );
  }

  async setConfigStatus(
    configId: string,
    version: string,
    status: OrderConfigStatusV3,
    updatedAt: string,
    publishedAt?: string,
  ): Promise<boolean> {
    return this.#database.withTransaction(async () => {
      const existing = await this.#database.query(
        `SELECT bundle_json FROM order_config_v3 WHERE config_id = $1 AND version = $2`,
        [configId, version],
      );
      if (!existing.rows[0]) {
        return false;
      }
      const bundle = parseStorageJson<Record<string, unknown>>(
        stringColumn(rowObject(existing.rows[0]), "bundle_json"),
      );
      const result = await this.#database.query(
        `UPDATE order_config_v3 SET
           status = $1,
           published_at = COALESCE($2, published_at),
           updated_at = $3,
           bundle_json = $4
         WHERE config_id = $5 AND version = $6`,
        [status, publishedAt ?? null, updatedAt, stringifyStorageJson({ ...bundle, status }), configId, version],
      );
      return (result.rowCount ?? 0) > 0;
    });
  }

  async createDraft(record: OrderDraftRecord): Promise<void> {
    await this.#database.query(
      `INSERT INTO order_draft_v3 (
         draft_id, config_id, config_version, config_hash, buyer_wallet,
         chain_id, state_machine, title, currency, stage_subset_json,
         status, terms_hash, finalize_nonce, finalize_deadline,
         order_id, plan_id, created_at, updated_at, frozen_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
      [
        record.draftId,
        record.configId,
        record.configVersion,
        record.configHash,
        record.buyerWallet,
        record.chainId,
        record.stateMachine,
        record.title,
        record.currency,
        stringifyStorageJson(record.stageSubset),
        record.status,
        record.termsHash ?? null,
        record.finalizeNonce ?? null,
        record.finalizeDeadline ?? null,
        record.orderId ?? null,
        record.planId ?? null,
        record.createdAt,
        record.updatedAt,
        record.frozenAt ?? null,
      ],
    );
  }

  async getDraft(draftId: string): Promise<OrderDraftRecord | undefined> {
    const result = await this.#database.query(`SELECT * FROM order_draft_v3 WHERE draft_id = $1`, [draftId]);
    return result.rows[0] ? draftRecord(result.rows[0]) : undefined;
  }

  async saveDraft(record: OrderDraftRecord): Promise<void> {
    const result = await this.#database.query(
      `UPDATE order_draft_v3 SET
         title = $1, currency = $2, stage_subset_json = $3, status = $4,
         terms_hash = $5, finalize_nonce = $6, finalize_deadline = $7,
         order_id = $8, plan_id = $9, updated_at = $10, frozen_at = $11
       WHERE draft_id = $12`,
      [
        record.title,
        record.currency,
        stringifyStorageJson(record.stageSubset),
        record.status,
        record.termsHash ?? null,
        record.finalizeNonce ?? null,
        record.finalizeDeadline ?? null,
        record.orderId ?? null,
        record.planId ?? null,
        record.updatedAt,
        record.frozenAt ?? null,
        record.draftId,
      ],
    );
    if ((result.rowCount ?? 0) === 0) {
      throw new Error(`draft ${record.draftId} does not exist`);
    }
  }

  async createStages(records: readonly OrderStageRecord[]): Promise<void> {
    await this.#database.withTransaction(async () => {
      for (const record of records) {
        await this.#database.query(stageInsertSql, stageParams(record));
      }
    });
  }

  async listStages(draftId: string): Promise<readonly OrderStageRecord[]> {
    const result = await this.#database.query(
      `SELECT * FROM order_stage_v3 WHERE draft_id = $1 ORDER BY stage_index ASC, stage_key ASC`,
      [draftId],
    );
    return result.rows.map((row) => stageRecord(row));
  }

  async getStage(draftId: string, stageKey: string): Promise<OrderStageRecord | undefined> {
    const result = await this.#database.query(
      `SELECT * FROM order_stage_v3 WHERE draft_id = $1 AND stage_key = $2`,
      [draftId, stageKey],
    );
    return result.rows[0] ? stageRecord(result.rows[0]) : undefined;
  }

  async saveStage(record: OrderStageRecord): Promise<void> {
    const result = await this.#database.query(
      `UPDATE order_stage_v3 SET
         stage_id = $1, stage_index = $2, amount = $3, fee_bps = $4, fee_recipient = $5,
         acceptance_mode = $6, verifier_mode = $7, payer_slot = $8, payee_slot = $9,
         verifier_slot = $10, verifier_wallet = $11, standard_json = $12,
         final_standard_hash = $13, invite_deadline = $14, work_deadline = $15,
         terms_hash = $16, status = $17, updated_at = $18
       WHERE draft_id = $19 AND stage_key = $20`,
      [
        record.stageId,
        record.stageIndex,
        record.amount,
        record.feeBps,
        record.feeRecipient ?? null,
        record.acceptanceMode,
        record.verifierMode,
        record.payerSlot,
        record.payeeSlot ?? null,
        record.verifierSlot ?? null,
        record.verifierWallet ?? null,
        record.standard ? stringifyStorageJson(record.standard) : null,
        record.finalStandardHash,
        record.inviteDeadline,
        record.workDeadline,
        record.termsHash,
        record.status,
        record.updatedAt,
        record.draftId,
        record.stageKey,
      ],
    );
    if ((result.rowCount ?? 0) === 0) {
      throw new Error(`stage ${record.stageKey} does not exist on draft ${record.draftId}`);
    }
  }

  async replaceStageSlots(
    draftId: string,
    stageKey: string,
    records: readonly OrderStageSlotRecord[],
  ): Promise<void> {
    await this.#database.withTransaction(async () => {
      await this.#database.query(
        `DELETE FROM order_stage_slot_v3 WHERE draft_id = $1 AND stage_key = $2`,
        [draftId, stageKey],
      );
      for (const record of records) {
        await this.#database.query(slotInsertSql, slotParams(record));
      }
    });
  }

  async listSlots(draftId: string): Promise<readonly OrderStageSlotRecord[]> {
    const result = await this.#database.query(
      `SELECT * FROM order_stage_slot_v3 WHERE draft_id = $1 ORDER BY stage_key ASC, slot_key ASC`,
      [draftId],
    );
    return result.rows.map((row) => slotRecord(row));
  }

  async getSlot(
    draftId: string,
    stageKey: string,
    slotKey: string,
  ): Promise<OrderStageSlotRecord | undefined> {
    const result = await this.#database.query(
      `SELECT * FROM order_stage_slot_v3 WHERE draft_id = $1 AND stage_key = $2 AND slot_key = $3`,
      [draftId, stageKey, slotKey],
    );
    return result.rows[0] ? slotRecord(result.rows[0]) : undefined;
  }

  async saveSlot(record: OrderStageSlotRecord): Promise<void> {
    await this.#database.query(slotInsertSql, slotParams(record));
  }

  async createInvite(record: OrderInviteRecord): Promise<void> {
    await this.#database.query(inviteInsertSql, inviteParams(record));
  }

  async getInvite(inviteId: string): Promise<OrderInviteRecord | undefined> {
    const result = await this.#database.query(
      `SELECT * FROM order_invite_v3 WHERE invite_id = $1`,
      [inviteId],
    );
    return result.rows[0] ? inviteRecord(result.rows[0]) : undefined;
  }

  async findActiveInvite(
    draftId: string,
    stageKey: string,
    slotKey: string,
  ): Promise<OrderInviteRecord | undefined> {
    const result = await this.#database.query(
      `SELECT * FROM order_invite_v3
       WHERE draft_id = $1 AND stage_key = $2 AND slot_key = $3 AND status = 'active'`,
      [draftId, stageKey, slotKey],
    );
    return result.rows[0] ? inviteRecord(result.rows[0]) : undefined;
  }

  async saveInvite(record: OrderInviteRecord): Promise<void> {
    const result = await this.#database.query(
      `UPDATE order_invite_v3 SET
         status = $1, expires_at = $2, accepted_by = $3, accepted_at = $4, updated_at = $5
       WHERE invite_id = $6`,
      [record.status, record.expiresAt, record.acceptedBy ?? null, record.acceptedAt ?? null, record.updatedAt, record.inviteId],
    );
    if ((result.rowCount ?? 0) === 0) {
      throw new Error(`invite ${record.inviteId} does not exist`);
    }
  }

  async transitionInvite(
    inviteId: string,
    from: OrderInviteRecord["status"],
    to: OrderInviteRecord["status"],
    patch: { readonly acceptedBy?: Address; readonly acceptedAt?: string; readonly updatedAt: string },
  ): Promise<boolean> {
    const result = await this.#database.query(
      `UPDATE order_invite_v3 SET
         status = $1,
         accepted_by = COALESCE($2, accepted_by),
         accepted_at = COALESCE($3, accepted_at),
         updated_at = $4
       WHERE invite_id = $5 AND status = $6`,
      [to, patch.acceptedBy ?? null, patch.acceptedAt ?? null, patch.updatedAt, inviteId, from],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async createOrder(record: OrderRecord): Promise<void> {
    await this.#database.query(
      `INSERT INTO order_v3 (
         order_id, draft_id, plan_id, state_machine, chain_id, buyer_wallet,
         terms_hash, status, tx_hash, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        record.orderId,
        record.draftId,
        record.planId,
        record.stateMachine,
        record.chainId,
        record.buyerWallet,
        record.termsHash,
        record.status,
        record.txHash ?? null,
        record.createdAt,
        record.updatedAt,
      ],
    );
  }

  async getOrder(orderId: string): Promise<OrderRecord | undefined> {
    const result = await this.#database.query(`SELECT * FROM order_v3 WHERE order_id = $1`, [orderId]);
    return result.rows[0] ? orderRecord(result.rows[0]) : undefined;
  }

  async getIdempotency(
    principalWallet: Address,
    operation: string,
    idemKey: string,
  ): Promise<IdempotencyRecord | undefined> {
    const result = await this.#database.query(
      `SELECT * FROM order_idempotency_v3
       WHERE principal_wallet = $1 AND operation = $2 AND idem_key = $3`,
      [principalWallet, operation, idemKey],
    );
    return result.rows[0] ? idempotencyRecord(result.rows[0]) : undefined;
  }

  async saveIdempotency(record: IdempotencyRecord): Promise<void> {
    await this.#database.query(
      `INSERT INTO order_idempotency_v3 (
         principal_wallet, operation, idem_key, request_hash, resource_id,
         response_json, status, created_at, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT(principal_wallet, operation, idem_key) DO NOTHING`,
      [
        record.principalWallet,
        record.operation,
        record.idemKey,
        record.requestHash,
        record.resourceId ?? null,
        record.responseJson,
        record.status,
        record.createdAt,
        record.expiresAt,
      ],
    );
  }
}

const stageInsertSql = `INSERT INTO order_stage_v3 (
  draft_id, stage_key, stage_id, stage_index, amount, fee_bps,
  fee_recipient, acceptance_mode, verifier_mode, payer_slot, payee_slot, verifier_slot,
  verifier_wallet, standard_json, final_standard_hash, invite_deadline,
  work_deadline, terms_hash, status, created_at, updated_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)`;

const slotInsertSql = `INSERT INTO order_stage_slot_v3 (
  draft_id, stage_key, slot_key, required, subject_label, contact_ref, wallet,
  status, invite_id, accepted_terms_hash, accepted_at, signature, created_at, updated_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
ON CONFLICT(draft_id, stage_key, slot_key) DO UPDATE SET
  required = excluded.required,
  subject_label = excluded.subject_label,
  contact_ref = excluded.contact_ref,
  wallet = excluded.wallet,
  status = excluded.status,
  invite_id = excluded.invite_id,
  accepted_terms_hash = excluded.accepted_terms_hash,
  accepted_at = excluded.accepted_at,
  signature = excluded.signature,
  updated_at = excluded.updated_at`;

const inviteInsertSql = `INSERT INTO order_invite_v3 (
  invite_id, draft_id, stage_key, stage_id, slot_key, subject_label, contact_ref,
  wallet, token_hash, nonce, status, expires_at, created_by, accepted_by,
  accepted_at, created_at, updated_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`;

function stageParams(record: OrderStageRecord): readonly (string | number | null)[] {
  return [
    record.draftId,
    record.stageKey,
    record.stageId,
    record.stageIndex,
    record.amount,
    record.feeBps,
    record.feeRecipient ?? null,
    record.acceptanceMode,
    record.verifierMode,
    record.payerSlot,
    record.payeeSlot ?? null,
    record.verifierSlot ?? null,
    record.verifierWallet ?? null,
    record.standard ? stringifyStorageJson(record.standard) : null,
    record.finalStandardHash,
    record.inviteDeadline,
    record.workDeadline,
    record.termsHash,
    record.status,
    record.createdAt,
    record.updatedAt,
  ];
}

function slotParams(record: OrderStageSlotRecord): readonly (string | number | null)[] {
  return [
    record.draftId,
    record.stageKey,
    record.slotKey,
    record.required ? 1 : 0,
    record.subjectLabel ?? null,
    record.contactRef ?? null,
    record.wallet ?? null,
    record.status,
    record.inviteId ?? null,
    record.acceptedTermsHash ?? null,
    record.acceptedAt ?? null,
    record.signature ?? null,
    record.createdAt,
    record.updatedAt,
  ];
}

function inviteParams(record: OrderInviteRecord): readonly (string | null)[] {
  return [
    record.inviteId,
    record.draftId,
    record.stageKey,
    record.stageId,
    record.slotKey,
    record.subjectLabel,
    record.contactRef ?? null,
    record.wallet ?? null,
    record.tokenHash,
    record.nonce,
    record.status,
    record.expiresAt,
    record.createdBy,
    record.acceptedBy ?? null,
    record.acceptedAt ?? null,
    record.createdAt,
    record.updatedAt,
  ];
}

export type { Hex };
