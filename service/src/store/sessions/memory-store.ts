import type { Address } from "../../shared/types.js";
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

  async putChallengeWithinAddressQuota(
    record: StoreAuthChallengeRecord,
    options: { readonly maxLivePerAddress: number; readonly maxLivePerRequester: number; readonly now: string }
  ): Promise<boolean> {
    // challenge 入口未鉴权：内存驱动必须有独立硬上限，否则即使有每地址
    // 配额，攻击者换地址循环打仍会无界增长（OOM）。到达上限时先清过期
    // 行（它们已无任何判定价值），仍满则按签发序淘汰最旧行——服务层
    // 的每地址配额保证正常流量到不了这里，这是最后防线而非常规路径。
    if (this.#challenges.size >= MEMORY_CHALLENGE_HARD_LIMIT) {
      await this.deleteExpiredChallenges(options.now);
      while (this.#challenges.size >= MEMORY_CHALLENGE_HARD_LIMIT) {
        const oldest = [...this.#challenges.values()]
          .sort((left, right) => left.issuedAt.localeCompare(right.issuedAt))[0];
        if (!oldest) {
          break;
        }
        this.#challenges.delete(oldest.nonce);
      }
    }
    // 配额判定与写入同步完成（无 await 间隙）：JS 单线程事件循环即原子边界。
    const address = record.address.toLowerCase();
    const requesterKey = record.requesterKey;
    let liveForAddress = 0;
    let liveForRequester = 0;
    for (const challenge of this.#challenges.values()) {
      if (challenge.consumedAt || challenge.expiresAt < options.now) {
        continue;
      }
      if (challenge.address.toLowerCase() === address) {
        liveForAddress += 1;
      }
      if (challenge.requesterKey === requesterKey) {
        liveForRequester += 1;
      }
    }
    if (liveForAddress >= options.maxLivePerAddress || liveForRequester >= options.maxLivePerRequester) {
      return false;
    }
    this.#challenges.set(record.nonce, record);
    return true;
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

  async deleteExpiredChallenges(expiresBefore: string): Promise<number> {
    let deleted = 0;
    for (const [nonce, challenge] of this.#challenges) {
      if (challenge.expiresAt < expiresBefore) {
        this.#challenges.delete(nonce);
        deleted += 1;
      }
    }
    return deleted;
  }

  async consumeChallenge(nonce: string, consumedAt: string): Promise<StoreAuthChallengeRecord | undefined> {
    // 条件占位——只有未消费的挑战才能被置为已消费。
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

/** memory 驱动的挑战表硬上限（未鉴权入口的最后防线，见 putChallenge）。 */
export const MEMORY_CHALLENGE_HARD_LIMIT = 10_000;
