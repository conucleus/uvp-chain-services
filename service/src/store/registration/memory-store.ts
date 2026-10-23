import type { Address } from "../../shared/types.js";
import type { StoreEntityRegistrationRecord, StoreEntityRegistrationStore } from "./types.js";

export class InMemoryStoreEntityRegistrationStore implements StoreEntityRegistrationStore {
  readonly #records = new Map<string, StoreEntityRegistrationRecord>();

  async upsertRegistration(record: StoreEntityRegistrationRecord): Promise<StoreEntityRegistrationRecord> {
    const key = record.accountAddress.toLowerCase();
    const existing = this.#records.get(key);
    const persisted: StoreEntityRegistrationRecord = existing
      ? {
          ...record,
          registrationId: existing.registrationId,
          accountAddress: existing.accountAddress,
          createdAt: existing.createdAt
        }
      : { ...record, accountAddress: record.accountAddress.toLowerCase() as Address };
    this.#records.set(key, persisted);
    return persisted;
  }

  async getRegistrationByAccount(accountAddress: Address): Promise<StoreEntityRegistrationRecord | undefined> {
    return this.#records.get(accountAddress.toLowerCase());
  }
}
