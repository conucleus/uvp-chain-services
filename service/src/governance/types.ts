import type { TxReconcileFields } from "../reconcile/status.js";
import type { Address, Hex } from "../shared/types.js";

export type GovernanceSubjectType = "zhixu" | "supplier";

export type GovernanceReviewStatus =
  | "draft"
  | "submitted"
  | "approved_for_broadcast"
  | "approved"
  | "restricted"
  | "rejected"
  | "revoked";

export type GovernanceTxLogStatus = "pending" | "broadcasting" | "indexing" | "confirmed" | "failed";

export type GovernanceBroadcastStatus = "simulated_tx" | "broadcasting" | "submitted" | "confirmed" | "failed";

export type GovernanceTxAction = "register_identity" | "revoke_identity";

export interface GovernancePrincipal {
  readonly adminId: string;
  readonly role: string;
}

export interface GovernanceReviewDTO {
  readonly reviewId: string;
  readonly subjectType: GovernanceSubjectType;
  readonly subjectId: string;
  readonly status: GovernanceReviewStatus;
  readonly riskLevel: string;
  readonly riskTags: readonly string[];
  readonly publicSummary: string;
  readonly internalNotes: string;
  readonly policyHash: Hex;
  readonly metadataHash: Hex;
  readonly metadataURI: string;
  readonly reviewer: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /**
   * 哈希材料原文（metadata/policy）随 review 记录
   * 持久化：registerIdentity 重建 descriptor 哈希时必须有原文可用，
   * 缺失会按 null 参与哈希，造成同一 review 两处哈希口径分叉。
   */
  readonly metadataDocument?: unknown;
  readonly policyDocument?: unknown;
}

export type PublicGovernanceReviewDTO = Omit<GovernanceReviewDTO, "internalNotes" | "reviewer">;

export interface ReviewInput {
  readonly reviewId?: string;
  readonly subjectId: string;
  readonly status: GovernanceReviewStatus;
  readonly riskLevel?: string;
  readonly riskTags?: readonly string[];
  readonly publicSummary?: string;
  readonly internalNotes?: string;
  readonly metadataURI?: string;
  readonly metadata?: unknown;
  readonly policy?: unknown;
}

export interface IdentityRegistrationRequestDTO {
  readonly kind: "registerIdentity";
  readonly subjectId: Hex;
  readonly account: Address;
  readonly descriptorHash: Hex;
  readonly descriptorURI: string;
  readonly reviewId?: string;
}

export interface IdentityRevocationRequestDTO {
  readonly kind: "revokeIdentity";
  readonly bindingId: Hex;
  readonly subjectId: Hex;
  readonly reasonHash: Hex;
  readonly reasonURI: string;
  readonly reviewId?: string;
}

export type GovernanceChainRequestDTO =
  | IdentityRegistrationRequestDTO
  | IdentityRevocationRequestDTO;

export interface GovernanceBroadcastResultDTO {
  readonly status: GovernanceBroadcastStatus;
  readonly txHash?: Hex;
  readonly blockNumber?: string;
  readonly signer?: Address;
  readonly errorCode?: string;
  readonly message?: string;
  readonly retryable: boolean;
  readonly simulated: boolean;
}

export interface IdentityTxLogDTO extends TxReconcileFields {
  readonly logId: string;
  readonly txLogId: string;
  readonly action: "register_identity" | "revoke_identity";
  readonly subjectId: Hex;
  readonly account?: Address;
  readonly bindingId?: Hex;
  readonly descriptorHash?: Hex;
  readonly descriptorURI?: string;
  readonly reasonHash?: Hex;
  readonly reasonURI?: string;
  readonly txHash?: Hex;
  readonly blockNumber?: string;
  readonly signer?: Address;
  readonly requester: string;
  readonly status: GovernanceTxLogStatus;
  readonly broadcastStatus: GovernanceBroadcastStatus;
  /** Explicit marker for how the entry was produced; "simulated" entries never hit chain and are skipped by reconciliation. */
  readonly executionMode?: "simulated" | "on_chain";
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly retryable: boolean;
  readonly request: IdentityRegistrationRequestDTO | IdentityRevocationRequestDTO;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type GovernanceTxLogDTO = IdentityTxLogDTO;

export interface GovernanceReviewResultDTO {
  readonly review: GovernanceReviewDTO;
  readonly publicReview: PublicGovernanceReviewDTO;
}

export interface GovernanceIdentityRegistrationResultDTO {
  readonly request: IdentityRegistrationRequestDTO;
  readonly broadcast: GovernanceBroadcastResultDTO;
  readonly log: IdentityTxLogDTO;
}

export interface GovernanceIdentityRevocationResultDTO {
  readonly request: IdentityRevocationRequestDTO;
  readonly broadcast: GovernanceBroadcastResultDTO;
  readonly log: IdentityTxLogDTO;
}
