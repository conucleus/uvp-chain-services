// V3 订单域 sqlite 持久化（迁移 0032_order_domain_v3.sql）：与内存/Postgres
// 同语义——配置按 (configId,version) 唯一、邀请 active 单活、条件状态迁移。

import type { OrderConfigStatusV3 } from "@uvp-eth/product-dto";
import { parseStorageJson, stringifyStorageJson } from "../../storage/json.js";
import { runSqliteMigrations } from "../../storage/migrations.js";
import { rowObject, stringColumn } from "../../storage/sqlite-rows.js";
import {
  openSqliteDatabase,
  runSqliteWrite,
  withSqliteTransaction,
  type SqliteDatabase,
} from "../../storage/sqlite.js";
import type { Address, Hex } from "../../shared/types.js";
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
import {
  configRecord,
  draftRecord,
  idempotencyRecord,
  inviteRecord,
  orderRecord,
  slotRecord,
  stageRecord,
} from "./rows.js";

export interface SqliteOrderV3StoreOptions {
  readonly databaseUrl?: string;
  readonly database?: SqliteDatabase;
  readonly migrations?: {
    readonly autoRun?: boolean;
    readonly directory?: string;
  };
}

export class SqliteOrderV3Store implements OrderV3Store {
  readonly #database: SqliteDatabase;
  readonly #ownsDatabase: boolean;

  constructor(options: SqliteOrderV3StoreOptions) {
    if (!options.database && !options.databaseUrl) {
      throw new Error("SqliteOrderV3Store requires database or databaseUrl");
    }
    this.#database = options.database ?? openSqliteDatabase(options.databaseUrl!);
    this.#ownsDatabase = !options.database;
    if (options.migrations?.autoRun === true) {
      runSqliteMigrations({
        database: this.#database,
        ...(options.migrations.directory ? { migrationsDirectory: options.migrations.directory } : {}),
      });
    }
  }

  async close(): Promise<void> {
    if (this.#ownsDatabase) {
      this.#database.close();
    }
  }

  async getConfig(configId: string, version: string): Promise<ConfigVersionRecord | undefined> {
    const row = this.#database
      .prepare(`SELECT * FROM order_config_v3 WHERE config_id = ? AND version = ?`)
      .get(configId, version);
    return row ? configRecord(row) : undefined;
  }

  async saveConfig(record: ConfigVersionRecord): Promise<void> {
    await withSqliteTransaction(this.#database, async () => {
      runSqliteWrite(() => {
        this.#database
          .prepare(
            `INSERT INTO order_config_v3 (
               config_id, version, status, config_hash, plan_id, plan_hash,
               birth_json, bundle_json, created_by, created_at, published_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(config_id, version) DO UPDATE SET
               status = excluded.status,
               config_hash = excluded.config_hash,
               plan_id = excluded.plan_id,
               plan_hash = excluded.plan_hash,
               birth_json = excluded.birth_json,
               bundle_json = excluded.bundle_json,
               published_at = excluded.published_at,
               updated_at = excluded.updated_at`,
          )
          .run(
            record.configId,
            record.version,
            record.status,
            record.configHash,
            record.planId ?? null,
            record.planHash ?? null,
            record.birth ? stringifyStorageJson(record.birth) : null,
            stringifyStorageJson(record.bundle),
            record.createdBy,
            record.createdAt,
            record.publishedAt ?? null,
            record.updatedAt,
          );
      });
    });
  }

  async setConfigStatus(
    configId: string,
    version: string,
    status: OrderConfigStatusV3,
    updatedAt: string,
    publishedAt?: string,
  ): Promise<boolean> {
    let changed = false;
    await withSqliteTransaction(this.#database, async () => {
      runSqliteWrite(() => {
        const result = this.#database
          .prepare(
            `UPDATE order_config_v3
             SET status = ?,
                 published_at = COALESCE(?, published_at),
                 updated_at = ?,
                 bundle_json = ?
             WHERE config_id = ? AND version = ?`,
          )
          .run(
            status,
            publishedAt ?? null,
            updatedAt,
            this.#bundleWithStatus(configId, version, status),
            configId,
            version,
          );
        changed = result.changes > 0;
      });
    });
    return changed;
  }

  #bundleWithStatus(configId: string, version: string, status: OrderConfigStatusV3): string {
    const row = this.#database
      .prepare(`SELECT bundle_json FROM order_config_v3 WHERE config_id = ? AND version = ?`)
      .get(configId, version);
    if (!row) {
      return "{}";
    }
    const bundle = parseStorageJson<Record<string, unknown>>(stringColumn(rowObject(row), "bundle_json"));
    return stringifyStorageJson({ ...bundle, status });
  }

  async createDraft(record: OrderDraftRecord): Promise<void> {
    await withSqliteTransaction(this.#database, async () => {
      runSqliteWrite(() => {
        this.#database
          .prepare(
            `INSERT INTO order_draft_v3 (
               draft_id, config_id, config_version, config_hash, buyer_wallet,
               chain_id, state_machine, title, currency, stage_subset_json,
               status, terms_hash, finalize_nonce, finalize_deadline,
               order_id, plan_id, created_at, updated_at, frozen_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
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
          );
      });
    });
  }

  async getDraft(draftId: string): Promise<OrderDraftRecord | undefined> {
    const row = this.#database.prepare(`SELECT * FROM order_draft_v3 WHERE draft_id = ?`).get(draftId);
    return row ? draftRecord(row) : undefined;
  }

  async saveDraft(record: OrderDraftRecord): Promise<void> {
    await withSqliteTransaction(this.#database, async () => {
      runSqliteWrite(() => {
        const result = this.#database
          .prepare(
            `UPDATE order_draft_v3 SET
               title = ?, currency = ?, stage_subset_json = ?, status = ?,
               terms_hash = ?, finalize_nonce = ?, finalize_deadline = ?,
               order_id = ?, plan_id = ?, updated_at = ?, frozen_at = ?
             WHERE draft_id = ?`,
          )
          .run(
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
          );
        if (result.changes === 0) {
          throw new Error(`draft ${record.draftId} does not exist`);
        }
      });
    });
  }

  async createStages(records: readonly OrderStageRecord[]): Promise<void> {
    await withSqliteTransaction(this.#database, async () => {
      runSqliteWrite(() => {
        for (const record of records) {
          this.#database
            .prepare(
              `INSERT INTO order_stage_v3 (
                 draft_id, stage_key, stage_id, stage_index, amount, fee_bps,
                 fee_recipient, acceptance_mode, verifier_mode, payer_slot, payee_slot,
                 verifier_slot, verifier_wallet, standard_json, final_standard_hash,
                 invite_deadline, work_deadline, terms_hash,
                 status, created_at, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(...stageParams(record));
        }
      });
    });
  }

  async listStages(draftId: string): Promise<readonly OrderStageRecord[]> {
    return this.#database
      .prepare(`SELECT * FROM order_stage_v3 WHERE draft_id = ? ORDER BY stage_index ASC, stage_key ASC`)
      .all(draftId)
      .map((row) => stageRecord(row));
  }

  async getStage(draftId: string, stageKey: string): Promise<OrderStageRecord | undefined> {
    const row = this.#database
      .prepare(`SELECT * FROM order_stage_v3 WHERE draft_id = ? AND stage_key = ?`)
      .get(draftId, stageKey);
    return row ? stageRecord(row) : undefined;
  }

  async saveStage(record: OrderStageRecord): Promise<void> {
    await withSqliteTransaction(this.#database, async () => {
      runSqliteWrite(() => {
        const result = this.#database
          .prepare(
            `UPDATE order_stage_v3 SET
               stage_id = ?, stage_index = ?, amount = ?, fee_bps = ?, fee_recipient = ?,
               acceptance_mode = ?, verifier_mode = ?, payer_slot = ?, payee_slot = ?, verifier_slot = ?,
               verifier_wallet = ?, standard_json = ?, final_standard_hash = ?,
               invite_deadline = ?, work_deadline = ?,
               terms_hash = ?, status = ?, updated_at = ?
             WHERE draft_id = ? AND stage_key = ?`,
          )
          .run(
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
          );
        if (result.changes === 0) {
          throw new Error(`stage ${record.stageKey} does not exist on draft ${record.draftId}`);
        }
      });
    });
  }

  async replaceStageSlots(
    draftId: string,
    stageKey: string,
    records: readonly OrderStageSlotRecord[],
  ): Promise<void> {
    await withSqliteTransaction(this.#database, async () => {
      runSqliteWrite(() => {
        this.#database
          .prepare(`DELETE FROM order_stage_slot_v3 WHERE draft_id = ? AND stage_key = ?`)
          .run(draftId, stageKey);
        for (const record of records) {
          this.#database.prepare(slotInsertSql).run(...slotParams(record));
        }
      });
    });
  }

  async listSlots(draftId: string): Promise<readonly OrderStageSlotRecord[]> {
    return this.#database
      .prepare(`SELECT * FROM order_stage_slot_v3 WHERE draft_id = ? ORDER BY stage_key ASC, slot_key ASC`)
      .all(draftId)
      .map((row) => slotRecord(row));
  }

  async getSlot(
    draftId: string,
    stageKey: string,
    slotKey: string,
  ): Promise<OrderStageSlotRecord | undefined> {
    const row = this.#database
      .prepare(`SELECT * FROM order_stage_slot_v3 WHERE draft_id = ? AND stage_key = ? AND slot_key = ?`)
      .get(draftId, stageKey, slotKey);
    return row ? slotRecord(row) : undefined;
  }

  async saveSlot(record: OrderStageSlotRecord): Promise<void> {
    await withSqliteTransaction(this.#database, async () => {
      runSqliteWrite(() => {
        this.#database.prepare(slotInsertSql).run(...slotParams(record));
      });
    });
  }

  async createInvite(record: OrderInviteRecord): Promise<void> {
    await withSqliteTransaction(this.#database, async () => {
      runSqliteWrite(() => {
        this.#database.prepare(inviteInsertSql).run(...inviteParams(record));
      });
    });
  }

  async getInvite(inviteId: string): Promise<OrderInviteRecord | undefined> {
    const row = this.#database.prepare(`SELECT * FROM order_invite_v3 WHERE invite_id = ?`).get(inviteId);
    return row ? inviteRecord(row) : undefined;
  }

  async findActiveInvite(
    draftId: string,
    stageKey: string,
    slotKey: string,
  ): Promise<OrderInviteRecord | undefined> {
    const row = this.#database
      .prepare(
        `SELECT * FROM order_invite_v3
         WHERE draft_id = ? AND stage_key = ? AND slot_key = ? AND status = 'active'`,
      )
      .get(draftId, stageKey, slotKey);
    return row ? inviteRecord(row) : undefined;
  }

  async saveInvite(record: OrderInviteRecord): Promise<void> {
    await withSqliteTransaction(this.#database, async () => {
      runSqliteWrite(() => {
        const result = this.#database
          .prepare(
            `UPDATE order_invite_v3 SET
               status = ?, expires_at = ?, accepted_by = ?, accepted_at = ?, updated_at = ?
             WHERE invite_id = ?`,
          )
          .run(record.status, record.expiresAt, record.acceptedBy ?? null, record.acceptedAt ?? null, record.updatedAt, record.inviteId);
        if (result.changes === 0) {
          throw new Error(`invite ${record.inviteId} does not exist`);
        }
      });
    });
  }

  async transitionInvite(
    inviteId: string,
    from: OrderInviteRecord["status"],
    to: OrderInviteRecord["status"],
    patch: { readonly acceptedBy?: Address; readonly acceptedAt?: string; readonly updatedAt: string },
  ): Promise<boolean> {
    let changed = false;
    await withSqliteTransaction(this.#database, async () => {
      runSqliteWrite(() => {
        const result = this.#database
          .prepare(
            `UPDATE order_invite_v3 SET
               status = ?,
               accepted_by = COALESCE(?, accepted_by),
               accepted_at = COALESCE(?, accepted_at),
               updated_at = ?
             WHERE invite_id = ? AND status = ?`,
          )
          .run(to, patch.acceptedBy ?? null, patch.acceptedAt ?? null, patch.updatedAt, inviteId, from);
        changed = result.changes > 0;
      });
    });
    return changed;
  }

  async createOrder(record: OrderRecord): Promise<void> {
    await withSqliteTransaction(this.#database, async () => {
      runSqliteWrite(() => {
        this.#database
          .prepare(
            `INSERT INTO order_v3 (
               order_id, draft_id, plan_id, state_machine, chain_id, buyer_wallet,
               terms_hash, status, tx_hash, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
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
          );
      });
    });
  }

  async getOrder(orderId: string): Promise<OrderRecord | undefined> {
    const row = this.#database.prepare(`SELECT * FROM order_v3 WHERE order_id = ?`).get(orderId);
    return row ? orderRecord(row) : undefined;
  }

  async getIdempotency(
    principalWallet: Address,
    operation: string,
    idemKey: string,
  ): Promise<IdempotencyRecord | undefined> {
    const row = this.#database
      .prepare(
        `SELECT * FROM order_idempotency_v3
         WHERE principal_wallet = ? AND operation = ? AND idem_key = ?`,
      )
      .get(principalWallet, operation, idemKey);
    return row ? idempotencyRecord(row) : undefined;
  }

  async saveIdempotency(record: IdempotencyRecord): Promise<void> {
    await withSqliteTransaction(this.#database, async () => {
      runSqliteWrite(() => {
        this.#database
          .prepare(
            `INSERT INTO order_idempotency_v3 (
               principal_wallet, operation, idem_key, request_hash, resource_id,
               response_json, status, created_at, expires_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(principal_wallet, operation, idem_key) DO NOTHING`,
          )
          .run(
            record.principalWallet,
            record.operation,
            record.idemKey,
            record.requestHash,
            record.resourceId ?? null,
            record.responseJson,
            record.status,
            record.createdAt,
            record.expiresAt,
          );
      });
    });
  }
}

const slotInsertSql = `INSERT INTO order_stage_slot_v3 (
  draft_id, stage_key, slot_key, required, subject_label, contact_ref, wallet,
  status, invite_id, accepted_terms_hash, accepted_at, signature, created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

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

