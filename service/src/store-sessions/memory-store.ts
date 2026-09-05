import type { Address } from "../shared/types.js";
import type {
  StoreAccountAddressRecord,
  StoreAuthChallengeRecord,
  StoreWalletSessionRecord,
  StoreWalletSessionStore
} from "./types.js";

export class InMemoryStoreWalletSessionStore implements StoreWalletSessionStore {
  readonly #challenges = new Map<string, StoreAuthChallengeRecord>();
  readonly #sessions = new Map<string, StoreWalletSessionRecord>();
  readonly #accountAddresses = new Map<string, StoreAccountAddressRecord>();

  async putChallenge(record: StoreAuthChallengeRecord): Promise<void> {
    this.#challenges.set(record.nonce, record);
  }

  async getChallenge(nonce: string): Promise<StoreAuthChallengeRecord | undefined> {
    return this.#challenges.get(nonce);
  }

  async listChallengesForAddress(address: Address): Promise<readonly StoreAuthChallengeRecord[]> {
    const normalized = address.toLowerCase();
    return [...this.#challenges.values()].filter((challenge) => challenge.address.toLowerCase() === normalized);
  }

  async updateChallenge(record: StoreAuthChallengeRecord): Promise<void> {
    this.#challenges.set(record.nonce, record);
  }

  async consumeChallenge(nonce: string, consumedAt: string): Promise<StoreAuthChallengeRecord | undefined> {
    // 簇 N 修正：条件占位——只有未消费的挑战才能被置为已消费。
    const current = this.#challenges.get(nonce);
    if (!current || current.consumedAt) {
      return undefined;
    }
    const updated: StoreAuthChallengeRecord = { ...current, consumedAt };
    this.#challenges.set(nonce, updated);
    return updated;
  }

  async putSession(record: StoreWalletSessionRecord): Promise<void> {
    this.#sessions.set(record.sessionId, record);
  }

  async findSessionByTokenHash(tokenHash: string): Promise<StoreWalletSessionRecord | undefined> {
    return [...this.#sessions.values()].find((session) => session.tokenHash === tokenHash);
  }

  async updateSession(record: StoreWalletSessionRecord): Promise<void> {
    this.#sessions.set(record.sessionId, record);
  }

  async putAccountAddress(record: StoreAccountAddressRecord): Promise<void> {
    this.#accountAddresses.set(accountAddressKey(record.address), record);
  }

  async listAccountAddresses(accountId: string): Promise<readonly StoreAccountAddressRecord[]> {
    return [...this.#accountAddresses.values()]
      .filter((record) => record.accountId === accountId)
      .sort((left, right) => left.anchoredAt.localeCompare(right.anchoredAt) || left.address.localeCompare(right.address));
  }

  async findActiveAccountAddress(address: Address): Promise<StoreAccountAddressRecord | undefined> {
    const record = this.#accountAddresses.get(accountAddressKey(address));
    return record && record.status === "active" ? record : undefined;
  }

  async listAccountIds(): Promise<readonly string[]> {
    return [...new Set([...this.#accountAddresses.values()].map((record) => record.accountId))];
  }
}

function accountAddressKey(address: Address): string {
  return address.toLowerCase();
}
