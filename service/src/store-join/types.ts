import type { Address, Hex } from "../shared/types.js";

/**
 * PRD90 — 供应商自助加入闭环。
 *
 * 状态机：applied → under_review → authorized（记录链上交易证据）→ active；
 * 任何时点可进入 rejected / revoked（含 binding 撤销联动）。
 *
 * 审计配对（红线）：
 * - 每条进入 authorized 的申请必须记录链上交易证据（tx hash、类型、
 *   planId、slot、被授权地址）。
 * - 冻结合约下加入时（订单尚未产生）唯一可写的链上授权事实是
 *   UVPIdentityRegistry.registerIdentityBinding（PRD89 身份配对）；
 *   signal submitter / stage executor 授权在订单触发/执行者补丁时落地，
 *   本域记录授权意向（grant）并在投影观察到授权事件时落为 active。
 */

export type StoreJoinApplicationStatus =
  | "applied"
  | "under_review"
  | "authorized"
  | "active"
  | "rejected"
  | "revoked";

export type StoreJoinAuthorizationKind = "signal_submitter" | "stage_executor";

export interface StoreJoinTxEvidence {
  readonly kind: "identity_binding" | "signal_submitter" | "stage_executor";
  readonly txHash?: Hex;
  readonly txLogId?: string;
  readonly executionMode?: "simulated" | "on_chain";
  readonly planId: Hex;
  readonly slot: string;
  readonly address: Address;
  readonly status: "recorded" | "materialized";
  readonly recordedAt: string;
  readonly materializedAt?: string;
}

export interface StoreJoinApplicationRecord {
  readonly applicationId: string;
  readonly planId: Hex;
  readonly zhixuId?: string;
  readonly roleSlotId: string;
  readonly authorizationKind: StoreJoinAuthorizationKind;
  readonly stageId?: string;
  readonly applicantAddress: Address;
  readonly applicantAccountId?: string;
  readonly applicantSubjectId: Hex;
  readonly applicantDisplayName?: string;
  readonly statement?: string;
  readonly status: StoreJoinApplicationStatus;
  readonly supplierId?: string;
  readonly txEvidence: readonly StoreJoinTxEvidence[];
  readonly rejectionReason?: string;
  readonly revocationReason?: string;
  readonly decidedByAddress?: Address;
  readonly decidedAt?: string;
  readonly submittedAt: string;
  readonly updatedAt: string;
}

export type StoreJoinApplicationEventType =
  | "submitted"
  | "review_started"
  | "approved"
  | "rejected"
  | "revoked"
  | "authorized"
  | "activated"
  | "binding_revoked";

export interface StoreJoinApplicationEventRecord {
  readonly eventId: string;
  readonly applicationId: string;
  readonly type: StoreJoinApplicationEventType;
  readonly actorAddress?: Address;
  readonly actorAccountId?: string;
  readonly actorAuthMode?: string;
  readonly reason?: string;
  readonly txHash?: Hex;
  readonly createdAt: string;
}

export interface StoreJoinApplicationStore {
  putApplication(record: StoreJoinApplicationRecord): Promise<void>;
  getApplication(applicationId: string): Promise<StoreJoinApplicationRecord | undefined>;
  listApplications(query?: {
    readonly planId?: Hex;
    readonly applicantAddress?: Address;
    readonly status?: StoreJoinApplicationStatus;
  }): Promise<readonly StoreJoinApplicationRecord[]>;
  appendEvent(record: StoreJoinApplicationEventRecord): Promise<void>;
  listEvents(applicationId: string): Promise<readonly StoreJoinApplicationEventRecord[]>;
}

export interface StoreJoinActor {
  readonly anchoredAddress?: Address;
  readonly accountId?: string;
  readonly authMode: string;
  readonly accessLevel: string;
  readonly principalId?: string;
  /**
   * 簇 D 修正（审计三轮）：审批触发链上身份登记（registerIdentity）时
   * 必须持有 governance_admin 权威——与 /store/suppliers/:id/request-
   * identity-registration 路由的能力门禁同口径，publisher 审批不再绕过。
   */
  readonly governanceAdmin?: boolean;
}

export interface StoreJoinApplicationDetailDTO {
  readonly application: StoreJoinApplicationRecord;
  readonly events: readonly StoreJoinApplicationEventRecord[];
  readonly identityPairing: {
    readonly bindingStatus: "active" | "revoked" | "not_found";
    readonly bindingAccount?: Address;
    readonly bindingTxHash?: Hex;
  };
}

export class StoreJoinServiceError extends Error {
  override readonly name = "StoreJoinServiceError";

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
