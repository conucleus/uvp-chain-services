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
    this.#versions.set(`${record.planId.toLowerCase()}#${record.version}`, record);
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
    this.#delegations.set(record.delegationId, record);
  }

  async updateDelegation(record: StorePublisherDelegationRecord): Promise<void> {
    this.#delegations.set(record.delegationId, record);
  }

  async findActiveDelegation(publisherAddress: Address, memberAddress: Address): Promise<StorePublisherDelegationRecord | undefined> {
    return [...this.#delegations.values()].find((record) =>
      record.publisherAddress.toLowerCase() === publisherAddress.toLowerCase() &&
      record.memberAddress.toLowerCase() === memberAddress.toLowerCase() &&
      !record.revokedAt
    );
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
