import type { Hex } from "../../shared/types.js";
import type { StoreListingPrecondition, StoreListingRecord, StoreListingStore, StoreListingStatus } from "./types.js";

export class InMemoryStoreListingStore implements StoreListingStore {
  readonly #listings = new Map<string, StoreListingRecord>();

  async putListing(
    record: StoreListingRecord,
    expect?: StoreListingPrecondition
  ): Promise<{ applied: boolean; record: StoreListingRecord }> {
    const current = this.#listings.get(record.listingId);
    if (!current) {
      // 与持久驱动 UNIQUE(plan_id) 同口径：一 plan 一 listing。查判与
      // 写入之间无 await，单线程事件循环内原子。
      const conflictingPlan = [...this.#listings.values()].some((existing) =>
        existing.planId.toLowerCase() === record.planId.toLowerCase()
      );
      if (conflictingPlan) {
        return { applied: false, record: await this.findListingByPlanId(record.planId) ?? record };
      }
      this.#listings.set(record.listingId, record);
      return { applied: true, record };
    }
    if (!expect || current.status !== expect.status) {
      return { applied: false, record: current };
    }
    this.#listings.set(record.listingId, record);
    return { applied: true, record };
  }

  async getListing(listingId: string): Promise<StoreListingRecord | undefined> {
    return this.#listings.get(listingId);
  }

  async findListingByPlanId(planId: Hex): Promise<StoreListingRecord | undefined> {
    const normalized = planId.toLowerCase();
    // 与 sqlite 驱动同择条：imported_at 升序取首条——同 plan 多条时取
    // 最早导入的一条（唯一约束生效时同 plan 仅一条，此择条不会命中）。
    return [...this.#listings.values()]
      .filter((record) => record.planId.toLowerCase() === normalized)
      .sort((left, right) => left.importedAt.localeCompare(right.importedAt))[0];
  }

  async listListings(status?: StoreListingStatus): Promise<readonly StoreListingRecord[]> {
    return [...this.#listings.values()]
      .filter((record) => !status || record.status === status)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.listingId.localeCompare(right.listingId));
  }
}
