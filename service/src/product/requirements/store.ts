// 订单要求包持久化口 + 内存实现（与 sqlite/postgres 同语义：声明 upsert 时
// 同事务清掉 hash 已不匹配的旧合意）。

import type {
  OrderRequirementBundleRecord,
  OrderRequirementConsentRecord,
  OrderRequirementsStore,
} from "./types.js";

export class MemoryOrderRequirementsStore implements OrderRequirementsStore {
  readonly #bundles = new Map<string, OrderRequirementBundleRecord>();
  readonly #consents = new Map<string, OrderRequirementConsentRecord>();

  async getBundle(
    draftId: string,
  ): Promise<OrderRequirementBundleRecord | undefined> {
    return this.#bundles.get(draftId);
  }

  async saveBundle(record: OrderRequirementBundleRecord): Promise<void> {
    this.#bundles.set(record.draftId, record);
    for (const [consentId, consent] of this.#consents) {
      if (
        consent.draftId === record.draftId &&
        consent.requirementsHash !== record.requirementsHash
      ) {
        this.#consents.delete(consentId);
      }
    }
  }

  async listConsents(
    draftId: string,
  ): Promise<readonly OrderRequirementConsentRecord[]> {
    return [...this.#consents.values()]
      .filter((consent) => consent.draftId === draftId)
      .sort((left, right) =>
        left.createdAt === right.createdAt
          ? left.walletAddress.localeCompare(right.walletAddress)
          : left.createdAt.localeCompare(right.createdAt),
      );
  }

  async saveConsent(record: OrderRequirementConsentRecord): Promise<void> {
    for (const [consentId, existing] of this.#consents) {
      if (
        existing.draftId === record.draftId &&
        existing.walletAddress === record.walletAddress
      ) {
        this.#consents.delete(consentId);
      }
    }
    this.#consents.set(record.consentId, record);
  }
}
