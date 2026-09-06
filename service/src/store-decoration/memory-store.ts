import type { Address, Hex } from "../shared/types.js";
import type {
  StorePublisherDelegationRecord,
  StorePublisherDelegationStore,
  StoreZhixuDecorationStore,
  StoreZhixuDecorationVersionRecord
} from "./types.js";

export class InMemoryStoreZhixuDecorationStore implements StoreZhixuDecorationStore {
  readonly #versions = new Map<string, StoreZhixuDecorationVersionRecord>();

  async appendVersion(record: StoreZhixuDecorationVersionRecord): Promise<void> {
    // 与 sqlite/postgres 的 UNIQUE(plan_id, version) 语义一致：
    // 同 plan 同版本号不可覆盖。
    const key = `${record.planId.toLowerCase()}#${record.version}`;
    if (this.#versions.has(key)) {
      throw new Error(
        `store_zhixu_decoration unique constraint violated: plan ${record.planId.toLowerCase()} version ${record.version} already exists`
      );
    }
    this.#versions.set(key, record);
  }

  async listVersions(planId: Hex): Promise<readonly StoreZhixuDecorationVersionRecord[]> {
    return [...this.#versions.values()]
      .filter((record) => record.planId.toLowerCase() === planId.toLowerCase())
      .sort((left, right) => left.version - right.version);
  }
}

export class InMemoryStorePublisherDelegationStore implements StorePublisherDelegationStore {
  readonly #delegations = new Map<string, StorePublisherDelegationRecord>();

  async appendDelegation(record: StorePublisherDelegationRecord): Promise<void> {
    // 与 sqlite 的 ON CONFLICT(delegation_id) DO UPDATE SET
    // revoked_at/revoked_by_address/reason 语义一致：追加同 id
    // 记录只更新撤销字段，不整体替换。
    const existing = this.#delegations.get(record.delegationId);
    if (existing) {
      const updated: StorePublisherDelegationRecord = {
        ...existing,
        ...(record.revokedAt !== undefined ? { revokedAt: record.revokedAt } : {}),
        ...(record.revokedByAddress !== undefined ? { revokedByAddress: record.revokedByAddress } : {}),
        ...(record.reason !== undefined ? { reason: record.reason } : {})
      };
      this.#delegations.set(record.delegationId, updated);
      return;
    }
    this.#delegations.set(record.delegationId, record);
  }

  async updateDelegation(record: StorePublisherDelegationRecord): Promise<void> {
    await this.appendDelegation(record);
  }

  async findActiveDelegation(publisherAddress: Address, memberAddress: Address): Promise<StorePublisherDelegationRecord | undefined> {
    return [...this.#delegations.values()]
      .filter((record) =>
        record.publisherAddress.toLowerCase() === publisherAddress.toLowerCase() &&
        record.memberAddress.toLowerCase() === memberAddress.toLowerCase() &&
        !record.revokedAt)
      .sort((left, right) =>
        right.grantedAt.localeCompare(left.grantedAt) ||
        right.delegationId.localeCompare(left.delegationId))[0];
  }

  async listDelegations(publisherAddress: Address): Promise<readonly StorePublisherDelegationRecord[]> {
    return [...this.#delegations.values()]
      .filter((record) => record.publisherAddress.toLowerCase() === publisherAddress.toLowerCase())
      .sort((left, right) => left.grantedAt.localeCompare(right.grantedAt) || left.delegationId.localeCompare(right.delegationId));
  }

  async listDelegationsForMember(memberAddress: Address): Promise<readonly StorePublisherDelegationRecord[]> {
    return [...this.#delegations.values()]
      .filter((record) => record.memberAddress.toLowerCase() === memberAddress.toLowerCase())
      .sort((left, right) => left.grantedAt.localeCompare(right.grantedAt) || left.delegationId.localeCompare(right.delegationId));
  }
}
