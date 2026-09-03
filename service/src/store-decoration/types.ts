import type { Address, Hex } from "../shared/types.js";

/**
 * PRD91 — Store 装修权限模型。
 *
 * - 权限根：`UVPStateMachine.planPublisher(planId)`（投影里的 plan.publisher，
 *   来自 PlanPublisherRecorded/PlanCommitted）——不是 Store 账号体系。
 * - 写核验：会话锚定地址 == planPublisher，或出现在该 publisher 的委托表。
 * - 委托表：publisher → 团队成员地址，Store 经营数据，可审计、可撤销、
 *   不进链。委托只传递 Store 侧操作权，不传递链上签名权。
 * - 装修数据：按 planId 键控的纯数据，append-only 版本化。
 */

export interface StoreZhixuDecorationTheme {
  readonly displayName?: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly highlights?: readonly string[];
  readonly heroImageURI?: string;
}

export interface StoreZhixuTaskDeclaration {
  readonly stageId?: string;
  readonly taskId?: string;
  readonly evidenceSpec?: readonly unknown[];
}

export interface StoreZhixuDecorationData {
  readonly schemaVersion: "store-zhixu-decoration.v1";
  readonly theme?: StoreZhixuDecorationTheme;
  readonly taskDeclarations?: readonly StoreZhixuTaskDeclaration[];
}

export interface StoreZhixuDecorationVersionRecord {
  readonly decorationId: string;
  readonly planId: Hex;
  readonly version: number;
  readonly data: StoreZhixuDecorationData;
  readonly authorAddress: Address;
  readonly authorAccountId?: string;
  readonly note?: string;
  readonly createdAt: string;
}

export interface StorePublisherDelegationRecord {
  readonly delegationId: string;
  readonly publisherAddress: Address;
  readonly memberAddress: Address;
  readonly grantedByAddress: Address;
  readonly grantedByAccountId?: string;
  readonly grantedAt: string;
  readonly revokedAt?: string;
  readonly revokedByAddress?: Address;
  readonly reason?: string;
}

export interface StoreZhixuDecorationStore {
  appendVersion(record: StoreZhixuDecorationVersionRecord): Promise<void>;
  listVersions(planId: Hex): Promise<readonly StoreZhixuDecorationVersionRecord[]>;
}

export interface StorePublisherDelegationStore {
  appendDelegation(record: StorePublisherDelegationRecord): Promise<void>;
  updateDelegation(record: StorePublisherDelegationRecord): Promise<void>;
  findActiveDelegation(publisherAddress: Address, memberAddress: Address): Promise<StorePublisherDelegationRecord | undefined>;
  listDelegations(publisherAddress: Address): Promise<readonly StorePublisherDelegationRecord[]>;
  listDelegationsForMember(memberAddress: Address): Promise<readonly StorePublisherDelegationRecord[]>;
}

export interface StoreDecorationActor {
  /** 会话锚定地址（钱包会话或 local 开发头）。 */
  readonly anchoredAddress: Address;
  readonly accountId?: string;
  readonly authMode: string;
}

export class StoreDecorationServiceError extends Error {
  override readonly name = "StoreDecorationServiceError";

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
