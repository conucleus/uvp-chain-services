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

export type GovernanceAttestationLogStatus = "pending" | "confirmed" | "failed";

export type GovernanceTxLogStatus = "pending" | "broadcasting" | "indexing" | "confirmed" | "failed";

export type GovernanceBroadcastStatus = "simulated_tx" | "broadcasting" | "submitted" | "confirmed" | "failed";

export type GovernanceTxAction =
  | "attest_plan"
  | "revoke_plan"
  | "attest_supplier"
  | "revoke_supplier";

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

export interface PlanAttestationRequestDTO {
  readonly kind: "attestPlan";
  readonly planId: Hex;
  readonly planHash: Hex;
  readonly artifactHash: Hex;
  readonly policyHash: Hex;
  readonly metadataHash: Hex;
  readonly metadataURI: string;
  readonly reviewId?: string;
}

export interface PlanRevocationRequestDTO {
  readonly kind: "revokePlan";
  readonly planId: Hex;
  readonly reasonHash: Hex;
  readonly reasonURI: string;
  readonly reviewId?: string;
}

export interface SupplierAttestationRequestDTO {
  readonly kind: "attestSupplier";
  readonly supplierSubjectId: Hex;
  readonly wallet: Address;
  readonly profileHash: Hex;
  readonly capabilityHash: Hex;
  readonly reputationHash: Hex;
  readonly metadataHash: Hex;
  readonly metadataURI: string;
  readonly reviewId?: string;
}

export interface SupplierRevocationRequestDTO {
  readonly kind: "revokeSupplier";
  readonly supplierSubjectId: Hex;
  readonly reasonHash: Hex;
  readonly reasonURI: string;
  readonly reviewId?: string;
}

export type GovernanceChainRequestDTO =
  | PlanAttestationRequestDTO
  | PlanRevocationRequestDTO
  | SupplierAttestationRequestDTO
  | SupplierRevocationRequestDTO;

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

export interface PlanAttestationLogDTO extends TxReconcileFields {
  readonly logId: string;
  readonly txLogId: string;
  readonly action: "attest_plan" | "revoke_plan";
  readonly subjectId: Hex;
  readonly planId: Hex;
  readonly planHash?: Hex;
  readonly artifactHash?: Hex;
  readonly policyHash?: Hex;
  readonly metadataHash?: Hex;
  readonly metadataURI?: string;
  readonly reasonHash?: Hex;
  readonly reasonURI?: string;
  readonly txHash?: Hex;
  readonly blockNumber?: string;
  readonly signer?: Address;
  readonly requester: string;
  readonly status: GovernanceTxLogStatus;
  readonly broadcastStatus: GovernanceBroadcastStatus;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly retryable: boolean;
  readonly request: PlanAttestationRequestDTO | PlanRevocationRequestDTO;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SupplierAttestationLogDTO extends TxReconcileFields {
  readonly logId: string;
  readonly txLogId: string;
  readonly action: "attest_supplier" | "revoke_supplier";
  readonly subjectId: Hex;
  readonly supplierSubjectId: Hex;
  readonly wallet?: Address;
  readonly profileHash?: Hex;
  readonly capabilityHash?: Hex;
  readonly reputationHash?: Hex;
  readonly metadataHash?: Hex;
  readonly metadataURI?: string;
  readonly reasonHash?: Hex;
  readonly reasonURI?: string;
  readonly txHash?: Hex;
  readonly blockNumber?: string;
  readonly signer?: Address;
  readonly requester: string;
  readonly status: GovernanceTxLogStatus;
  readonly broadcastStatus: GovernanceBroadcastStatus;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly retryable: boolean;
  readonly request: SupplierAttestationRequestDTO | SupplierRevocationRequestDTO;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type GovernanceTxLogDTO = PlanAttestationLogDTO | SupplierAttestationLogDTO;

export interface GovernanceReviewResultDTO {
  readonly review: GovernanceReviewDTO;
  readonly publicReview: PublicGovernanceReviewDTO;
}

export interface GovernancePlanAttestationResultDTO {
  readonly request: PlanAttestationRequestDTO;
  readonly broadcast: GovernanceBroadcastResultDTO;
  readonly log: PlanAttestationLogDTO;
}

export interface GovernancePlanRevocationResultDTO {
  readonly request: PlanRevocationRequestDTO;
  readonly broadcast: GovernanceBroadcastResultDTO;
  readonly log: PlanAttestationLogDTO;
}

export interface GovernanceSupplierAttestationResultDTO {
  readonly request: SupplierAttestationRequestDTO;
  readonly broadcast: GovernanceBroadcastResultDTO;
  readonly log: SupplierAttestationLogDTO;
}

export interface GovernanceSupplierRevocationResultDTO {
  readonly request: SupplierRevocationRequestDTO;
  readonly broadcast: GovernanceBroadcastResultDTO;
  readonly log: SupplierAttestationLogDTO;
}
