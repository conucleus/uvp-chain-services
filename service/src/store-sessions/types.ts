import type { Address, Hex } from "../shared/types.js";

/**
 * Store 身份与会话。
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
  /**
   * 签发请求方标识（连接对端地址；取不到时为共享兜底桶）。
   * challenge 入口匿名且 address 由调用方自报——若只按目标地址配额，
   * 任何人连发满额即可锁死任意受害地址的 Store 登录；请求方维度配额
   * 把囤积成本留在攻击者自己的请求方桶里。
   */
  readonly requesterKey: string;
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
  /**
   * 原子签发：同一地址的存活挑战（未消费且未过期）达到
   * maxLivePerAddress，或同一请求方（requesterKey）跨全部地址的存活
   * 挑战达到 maxLivePerRequester 时拒绝写入并返回 false。双键都防的是
   * 匿名入口的定向锁死：仅按地址配额时任一请求方可替受害者把配额
   * 占满，仅按请求方配额时协同多方仍可围攻单地址。配额判定与写入
   * 必须处于存储层同一原子边界（内存驱动同步完成 / sqlite 单写连接 /
   * postgres 事务内按地址+请求方咨询锁）——服务层"先数后写"的窗口会被
   * 并发请求整体穿透（配额形同虚设）。返回 true 表示挑战已落库。
   */
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
  /**
   * 挑战一次性占位的条件 UPDATE——
   * `UPDATE ... SET consumed_at = ? WHERE nonce = ? AND consumed_at IS NULL`，
   * 仅当确实占位成功（行数=1）才返回占位后的记录；并发重放同一 nonce
   * 只有一个请求能通过（burn-on-attempt 原子化）。
   */
  consumeChallenge(nonce: string, consumedAt: string): Promise<StoreAuthChallengeRecord | undefined>;
  /**
   * 过期挑战清扫：删除 expires_at < expiresBefore 的行（含已消费的），
   * 返回删除行数。challenge 入口未鉴权且只插不删会把表/内存无界放大
   * （DoS）；由服务层在写入时顺带触发，三种驱动同口径。过期行无论
   * 是否消费都不再参与任何判定（verify 对过期/未知一律拒绝）。
   */
  deleteExpiredChallenges(expiresBefore: string): Promise<number>;

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
