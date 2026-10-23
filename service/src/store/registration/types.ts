import type { Address } from "../../shared/types.js";

/**
 * 参与者实体自助登记档案（链下）。
 *
 * 该域只回答"谁以哪个会话锚定地址申报了什么实体信息、当前是否经过人工
 * 核验"；它不是身份源、不是链上登记的替代：
 * - 不写链、不调用治理 register-identity；
 * - 不创建 store 供应商记录；
 * - `verified` 不在记录里，接口层恒返回 false（见 service DTO）。
 */
export type StoreEntityRegistrationStatus = "self_declared" | "pending_review";

export interface StoreEntityRegistrationRecord {
  readonly registrationId: string;
  /** 会话锚定地址（服务端派生，不接受客户端自报）。 */
  readonly accountAddress: Address;
  /** 钱包会话账号 id（可选；同一地址可属一个账号）。 */
  readonly accountId?: string;
  readonly legalName: string;
  readonly registrationNumber: string;
  readonly contactName: string;
  readonly status: StoreEntityRegistrationStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface StoreEntityRegistrationStore {
  /**
   * 单账号单活跃记录 upsert：account_address 唯一索引承担并发裁决。
   * 已存在时保留首次登记的 registrationId 与 createdAt，只更新申报字段与
   * updatedAt；返回值是落库后的真实行（并发败者据此读回赢家）。
   */
  upsertRegistration(record: StoreEntityRegistrationRecord): Promise<StoreEntityRegistrationRecord>;
  getRegistrationByAccount(accountAddress: Address): Promise<StoreEntityRegistrationRecord | undefined>;
}
