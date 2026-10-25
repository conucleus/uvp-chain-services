// V3 订单域内存持久化：与 sqlite/postgres 同语义（配置按 (configId,version)
// 唯一、邀请 active 单活、条件状态迁移）。仅用于 memory 驱动与测试。

import type { Address } from "../../shared/types.js";
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

export class MemoryOrderV3Store implements OrderV3Store {
  readonly #configs = new Map<string, ConfigVersionRecord>();
  readonly #drafts = new Map<string, OrderDraftRecord>();
  readonly #stages = new Map<string, OrderStageRecord>();
  readonly #slots = new Map<string, OrderStageSlotRecord>();
  readonly #invites = new Map<string, OrderInviteRecord>();
  readonly #orders = new Map<string, OrderRecord>();
  readonly #idempotency = new Map<string, IdempotencyRecord>();

  async getConfig(configId: string, version: string): Promise<ConfigVersionRecord | undefined> {
    return this.#configs.get(configKey(configId, version));
  }

  async saveConfig(record: ConfigVersionRecord): Promise<void> {
    this.#configs.set(configKey(record.configId, record.version), record);
  }

  async setConfigStatus(
    configId: string,
    version: string,
    status: ConfigVersionRecord["status"],
    updatedAt: string,
    publishedAt?: string,
  ): Promise<boolean> {
    const key = configKey(configId, version);
    const existing = this.#configs.get(key);
    if (!existing) {
      return false;
    }
    this.#configs.set(key, {
      ...existing,
      status,
      updatedAt,
      ...(publishedAt !== undefined ? { publishedAt } : {}),
    });
    return true;
  }

  async createDraft(record: OrderDraftRecord): Promise<void> {
    if (this.#drafts.has(record.draftId)) {
      throw new Error(`draft ${record.draftId} already exists`);
    }
    this.#drafts.set(record.draftId, record);
  }

  async getDraft(draftId: string): Promise<OrderDraftRecord | undefined> {
    return this.#drafts.get(draftId);
  }

  async saveDraft(record: OrderDraftRecord): Promise<void> {
    this.#drafts.set(record.draftId, record);
  }

  async createStages(records: readonly OrderStageRecord[]): Promise<void> {
    for (const record of records) {
      const key = stageKeyOf(record.draftId, record.stageKey);
      if (this.#stages.has(key)) {
        throw new Error(`stage ${record.stageKey} already exists on draft ${record.draftId}`);
      }
      this.#stages.set(key, record);
    }
  }

  async listStages(draftId: string): Promise<readonly OrderStageRecord[]> {
    return [...this.#stages.values()]
      .filter((record) => record.draftId === draftId)
      .sort((left, right) => left.stageIndex - right.stageIndex || left.stageKey.localeCompare(right.stageKey));
  }

  async getStage(draftId: string, stageKey: string): Promise<OrderStageRecord | undefined> {
    return this.#stages.get(stageKeyOf(draftId, stageKey));
  }

  async saveStage(record: OrderStageRecord): Promise<void> {
    this.#stages.set(stageKeyOf(record.draftId, record.stageKey), record);
  }

  async replaceStageSlots(
    draftId: string,
    stageKey: string,
    records: readonly OrderStageSlotRecord[],
  ): Promise<void> {
    for (const [key, slot] of this.#slots) {
      if (slot.draftId === draftId && slot.stageKey === stageKey) {
        this.#slots.delete(key);
      }
    }
    for (const record of records) {
      this.#slots.set(slotKeyOf(record.draftId, record.stageKey, record.slotKey), record);
    }
  }

  async listSlots(draftId: string): Promise<readonly OrderStageSlotRecord[]> {
    return [...this.#slots.values()]
      .filter((record) => record.draftId === draftId)
      .sort((left, right) =>
        left.stageKey === right.stageKey
          ? left.slotKey.localeCompare(right.slotKey)
          : left.stageKey.localeCompare(right.stageKey),
      );
  }

  async getSlot(
    draftId: string,
    stageKey: string,
    slotKey: string,
  ): Promise<OrderStageSlotRecord | undefined> {
    return this.#slots.get(slotKeyOf(draftId, stageKey, slotKey));
  }

  async saveSlot(record: OrderStageSlotRecord): Promise<void> {
    this.#slots.set(slotKeyOf(record.draftId, record.stageKey, record.slotKey), record);
  }

  async createInvite(record: OrderInviteRecord): Promise<void> {
    if (this.#invites.has(record.inviteId)) {
      throw new Error(`invite ${record.inviteId} already exists`);
    }
    for (const existing of this.#invites.values()) {
      if (
        existing.status === "active" &&
        existing.draftId === record.draftId &&
        existing.stageKey === record.stageKey &&
        existing.slotKey === record.slotKey
      ) {
        throw new Error("active invite already exists for slot");
      }
    }
    this.#invites.set(record.inviteId, record);
  }

  async getInvite(inviteId: string): Promise<OrderInviteRecord | undefined> {
    return this.#invites.get(inviteId);
  }

  async findActiveInvite(
    draftId: string,
    stageKey: string,
    slotKey: string,
  ): Promise<OrderInviteRecord | undefined> {
    return [...this.#invites.values()].find(
      (record) =>
        record.status === "active" &&
        record.draftId === draftId &&
        record.stageKey === stageKey &&
        record.slotKey === slotKey,
    );
  }

  async saveInvite(record: OrderInviteRecord): Promise<void> {
    this.#invites.set(record.inviteId, record);
  }

  async transitionInvite(
    inviteId: string,
    from: OrderInviteRecord["status"],
    to: OrderInviteRecord["status"],
    patch: { readonly acceptedBy?: Address; readonly acceptedAt?: string; readonly updatedAt: string },
  ): Promise<boolean> {
    const existing = this.#invites.get(inviteId);
    if (!existing || existing.status !== from) {
      return false;
    }
    this.#invites.set(inviteId, {
      ...existing,
      status: to,
      updatedAt: patch.updatedAt,
      ...(patch.acceptedBy !== undefined ? { acceptedBy: patch.acceptedBy } : {}),
      ...(patch.acceptedAt !== undefined ? { acceptedAt: patch.acceptedAt } : {}),
    });
    return true;
  }

  async createOrder(record: OrderRecord): Promise<void> {
    if (this.#orders.has(record.orderId)) {
      throw new Error(`order ${record.orderId} already exists`);
    }
    this.#orders.set(record.orderId, record);
  }

  async getOrder(orderId: string): Promise<OrderRecord | undefined> {
    return this.#orders.get(orderId);
  }

  async getIdempotency(
    principalWallet: string,
    operation: string,
    idemKey: string,
  ): Promise<IdempotencyRecord | undefined> {
    return this.#idempotency.get(idempotencyKeyOf(principalWallet, operation, idemKey));
  }

  async saveIdempotency(record: IdempotencyRecord): Promise<void> {
    this.#idempotency.set(
      idempotencyKeyOf(record.principalWallet, record.operation, record.idemKey),
      record,
    );
  }
}

function configKey(configId: string, version: string): string {
  return `${configId}\u0000${version}`;
}

function stageKeyOf(draftId: string, stageKey: string): string {
  return `${draftId}\u0000${stageKey}`;
}

function slotKeyOf(draftId: string, stageKey: string, slotKey: string): string {
  return `${draftId}\u0000${stageKey}\u0000${slotKey}`;
}

function idempotencyKeyOf(principalWallet: string, operation: string, idemKey: string): string {
  return `${principalWallet}\u0000${operation}\u0000${idemKey}`;
}
