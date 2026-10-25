import type { Address, Hex } from "../../shared/types.js";

// Store 身份与会话：SIWE 式 personal_sign challenge 建立"登录会话控制
// 该钱包地址"的事实，服务端只保存 token 哈希与挑战记录，不接触私钥。

export type StoreAccountAddressStatus = "active" | "revoked";

export interface StoreAuthChallengeRecord {
  readonly nonce: string;
  readonly address: Address;
  readonly requesterKey: string;
  readonly intent: "login" | "anchor_address";
  readonly accountId?: string;
  readonly message: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly consumedAt?: string;
}

export interface StoreWalletSessionRecord {
  readonly sessionId: string;
  readonly tokenHash: string;
  readonly accountId: string;
  readonly anchoredAddress: Address;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly lastSeenAt?: string;
  readonly revokedAt?: string;
  readonly revokedReason?: string;
}

export interface StoreAccountAddressRecord {
  readonly accountId: string;
  readonly address: Address;
  readonly status: StoreAccountAddressStatus;
  readonly anchoredAt: string;
  readonly anchorSessionId?: string;
  readonly revokedAt?: string;
  readonly revokedBySessionId?: string;
}

export interface StoreWalletSessionStore {
  putChallengeWithinAddressQuota(
    record: StoreAuthChallengeRecord,
    options: {
      readonly maxLivePerAddress: number;
      readonly maxLivePerRequester: number;
      readonly now: string;
    }
  ): Promise<boolean>;
  getChallenge(nonce: string): Promise<StoreAuthChallengeRecord | undefined>;
  listChallengesForAddress(address: Address): Promise<readonly StoreAuthChallengeRecord[]>;
  updateChallenge(record: StoreAuthChallengeRecord): Promise<void>;
  consumeChallenge(nonce: string, consumedAt: string): Promise<StoreAuthChallengeRecord | undefined>;
  deleteExpiredChallenges(expiresBefore: string): Promise<number>;
  deleteExpiredSessions(expiresBefore: string): Promise<number>;

  putSession(record: StoreWalletSessionRecord): Promise<void>;
  findSessionByTokenHash(tokenHash: string): Promise<StoreWalletSessionRecord | undefined>;
  touchSession(sessionId: string, lastSeenAt: string): Promise<boolean>;
  revokeSession(sessionId: string, revokedAt: string, revokedReason: string): Promise<boolean>;

  putAccountAddress(record: StoreAccountAddressRecord): Promise<void>;
  claimActiveAccountAddress(record: StoreAccountAddressRecord): Promise<StoreAccountAddressRecord | undefined>;
  revokeActiveAccountAddress(input: {
    readonly address: Address;
    readonly accountId: string;
    readonly revokedAt: string;
    readonly revokedBySessionId?: string;
  }): Promise<boolean>;
  listAccountAddresses(accountId: string): Promise<readonly StoreAccountAddressRecord[]>;
  findActiveAccountAddress(address: Address): Promise<StoreAccountAddressRecord | undefined>;
  listAccountIds(): Promise<readonly string[]>;
}

export interface StoreWalletSessionView {
  readonly sessionId: string;
  readonly accountId: string;
  readonly anchoredAddress: Address;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly addresses: readonly StoreAccountAddressView[];
}

export interface StoreAccountAddressView {
  readonly address: Address;
  readonly status: StoreAccountAddressStatus;
  readonly anchoredAt: string;
}

export interface StoreWalletSessionChallengeDTO {
  readonly nonce: string;
  readonly address: Address;
  readonly message: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface StoreWalletSessionVerifyResult {
  readonly token: string;
  readonly session: StoreWalletSessionView;
  readonly linkedToExistingAccount: boolean;
}

export class StoreSessionServiceError extends Error {
  override readonly name = "StoreSessionServiceError";

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
  }
}

export type { Address, Hex };
