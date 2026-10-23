import type { Address } from "../../shared/types.js";
import type { StoreEntityRegistrationRecord, StoreEntityRegistrationStore } from "./types.js";

/**
 * memory 驱动（本地/测试）的实体登记 store。
 *
 * 单实例内存后端没有并发写者，判定与写入同处一个同步临界区；语义与
 * sqlite/postgres 的 account_address 唯一 upsert 一致：重复提交更新既有
 * 行，保留首次 registrationId/createdAt。
 */
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
