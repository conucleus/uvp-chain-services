import type { Address, Hex } from "../shared/types.js";

/**
 * PRD89 — Store 身份与会话。
 *
 * 会话配对：Store 登录会话 ↔ 责任主体钱包地址。签名证明（SIWE 式
 * personal_sign challenge）建立"该会话控制该地址"的事实；服务端只保存
 * token 哈希与挑战记录，不接触私钥。
 *
 * 一个账号（account）可关联多个地址（凝结核团队成员）；敏感操作要求
 * 会话已锚定地址（见 route 层 requireAnchoredStoreAddress）。
 */

export type StoreAccountAddressStatus = "active" | "revoked";

export interface StoreAuthChallengeRecord {
  /** 单次使用的随机 nonce（32 字符 hex）。 */
  readonly nonce: string;
  readonly address: Address;
  /** 会话意图：登录或为既有账号锚定新地址。 */
  readonly intent: "login" | "anchor_address";
  /** anchor_address 意图下的目标账号。 */
  readonly accountId?: string;
  readonly message: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly consumedAt?: string;
}

export interface StoreWalletSessionRecord {
  readonly sessionId: string;
  /** token 的 SHA-256；原始 token 只下发一次，不落库。 */
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
  putChallenge(record: StoreAuthChallengeRecord): Promise<void>;
  getChallenge(nonce: string): Promise<StoreAuthChallengeRecord | undefined>;
  listChallengesForAddress(address: Address): Promise<readonly StoreAuthChallengeRecord[]>;
  updateChallenge(record: StoreAuthChallengeRecord): Promise<void>;

  putSession(record: StoreWalletSessionRecord): Promise<void>;
  findSessionByTokenHash(tokenHash: string): Promise<StoreWalletSessionRecord | undefined>;
  updateSession(record: StoreWalletSessionRecord): Promise<void>;

  putAccountAddress(record: StoreAccountAddressRecord): Promise<void>;
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
