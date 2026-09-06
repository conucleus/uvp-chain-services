import type { Hex } from "../shared/types.js";
import type { StoreListingRecord, StoreListingStore, StoreListingStatus } from "./types.js";

export class InMemoryStoreListingStore implements StoreListingStore {
  readonly #listings = new Map<string, StoreListingRecord>();

  async putListing(record: StoreListingRecord): Promise<void> {
    this.#listings.set(record.listingId, record);
  }

  async getListing(listingId: string): Promise<StoreListingRecord | undefined> {
    return this.#listings.get(listingId);
  }

  async findListingByPlanId(planId: Hex): Promise<StoreListingRecord | undefined> {
    const normalized = planId.toLowerCase();
    return [...this.#listings.values()]
      .filter((record) => record.planId.toLowerCase() === normalized)
      .sort((left, right) => left.importedAt.localeCompare(right.importedAt))
      .pop();
  }

  async listListings(status?: StoreListingStatus): Promise<readonly StoreListingRecord[]> {
    return [...this.#listings.values()]
      .filter((record) => !status || record.status === status)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.listingId.localeCompare(right.listingId));
  }
}
