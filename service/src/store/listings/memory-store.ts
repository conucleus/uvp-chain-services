import type { Hex } from "../../shared/types.js";
import type { StoreListingRecord, StoreListingStore, StoreListingStatus } from "./types.js";
import { StoreListingPlanConflictError } from "./types.js";

export class InMemoryStoreListingStore implements StoreListingStore {
  readonly #listings = new Map<string, StoreListingRecord>();

  async putListing(record: StoreListingRecord): Promise<void> {
    // 与持久驱动 UNIQUE(plan_id) 同口径：一 plan 一 listing——查判与
    // 写入之间无 await，单线程事件循环内原子；否则并发双导入的第二条
    // 会落库并被按 planId 检索时择条，delist 抑制等按行状态失效。
    const conflictingPlan = [...this.#listings.values()].some((existing) =>
      existing.listingId !== record.listingId &&
      existing.planId.toLowerCase() === record.planId.toLowerCase()
    );
    if (conflictingPlan) {
      throw new StoreListingPlanConflictError();
    }
    this.#listings.set(record.listingId, record);
  }

  async getListing(listingId: string): Promise<StoreListingRecord | undefined> {
    return this.#listings.get(listingId);
  }

  async findListingByPlanId(planId: Hex): Promise<StoreListingRecord | undefined> {
    const normalized = planId.toLowerCase();
    // 与 sqlite 驱动同择条：imported_at 升序取首条（约束生效时同 plan
    // 仅一条，此择条只为与持久驱动的遗留数据行为一致）。
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
