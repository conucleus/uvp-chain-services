import type { Address, Hex } from "../../shared/types.js";
import type { TxReconcileFields } from "../../reconcile/status.js";

export type ProductOrderDraftStatus =
  | "draft"
  | "awaiting_participants"
  | "ready_to_register"
  | "registering"
  | "registered"
  | "cancelled";

export type DraftParticipantStatus = "missing" | "invited" | "accepted" | "rejected" | "replaced";
export type ProductInviteStatus = "active" | "accepted" | "rejected" | "expired" | "revoked";
export type PermissionPayloadPolicy = "required" | "optional";
export type ProductOrderRegistrationStatus = "pending" | "indexing" | "confirmed" | "failed";
export type ProductOrderStartStatus = "pending" | "submitted" | "indexing" | "confirmed" | "failed";

export interface ProductOrderDraftDTO {
  readonly draftId: string;
  readonly zhixuId: string;
  readonly planId: Hex;
  readonly planHash: Hex;
  readonly title: string;
  readonly businessType: string;
  readonly goods: readonly string[];
  readonly totalAmount: string;
  readonly currency: string;
  readonly exportRegion?: string;
  readonly destinationRegion?: string;
  readonly expectedCompletionDate?: string;
  readonly notes?: string;
  readonly status: ProductOrderDraftStatus;
  readonly createdBy?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly registeredOrderId?: string;
  readonly registrationTxHash?: Hex;
}

export interface DraftParticipantDTO {
  readonly participantId: string;
  readonly draftId: string;
  readonly roleSlotId: string;
  readonly roleLabel: string;
  readonly displayName: string;
  readonly walletAddress?: string;
  readonly contact: string;
  readonly status: DraftParticipantStatus;
  readonly required: boolean;
  readonly acceptedAt?: string;
  readonly rejectedAt?: string;
}

export interface ProductInviteDTO {
  readonly inviteId: string;
  readonly draftId: string;
  readonly participantId: string;
  readonly roleSlotId: string;
  readonly tokenHash: Hex;
  readonly status: ProductInviteStatus;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly acceptedWalletAddress?: string;
}

export interface ParticipantPermissionDTO {
  readonly permissionId: string;
  readonly orderId?: string;
  readonly draftId: string;
  readonly participantId: string;
  readonly roleSlotId: string;
  readonly stageIdentifier: string;
  readonly source: string;
  readonly signalName: string;
  readonly submitterAddress: string;
  readonly payloadPolicy: PermissionPayloadPolicy;
  readonly requiredEvidence: readonly string[];
  readonly deadlinePolicy?: string;
}

export interface SignalAuthorizationDTO {
  readonly sourceId: Hex;
  readonly signalId: Hex;
  readonly submitter: Address;
  readonly role: Hex;
  readonly metadataHash: Hex;
}

export interface ProductOrderRegistrationDTO extends TxReconcileFields {
  readonly registrationId: string;
  readonly draftId: string;
  readonly orderId: Hex;
  readonly stateMachineAddress?: Address;
  readonly deploymentId?: Hex;
  readonly planId: Hex;
  readonly planHash: Hex;
  readonly status: ProductOrderRegistrationStatus;
  readonly txHash?: Hex;
  readonly blockNumber?: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly retryable: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ProductOrderRegistrationRecord extends ProductOrderRegistrationDTO {
  readonly creator: Address;
  readonly authorizations: readonly SignalAuthorizationDTO[];
  readonly permissions: readonly ParticipantPermissionDTO[];
}

export interface ProductOrderStartDTO extends TxReconcileFields {
  readonly startId: string;
  readonly registrationId: string;
  readonly draftId: string;
  readonly orderId: Hex;
  readonly stateMachineAddress?: Address;
  readonly deploymentId?: Hex;
  readonly status: ProductOrderStartStatus;
  readonly txHash?: Hex;
  readonly blockNumber?: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly retryable: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateProductOrderDraftInput {
  readonly zhixuId: string;
  readonly title: string;
  readonly businessType: string;
  readonly goods?: readonly string[];
  readonly totalAmount: string;
  readonly currency: string;
  readonly exportRegion?: string;
  readonly destinationRegion?: string;
  readonly expectedCompletionDate?: string;
  readonly notes?: string;
  readonly createdBy?: string;
  readonly allowDemoPlanFallback?: boolean;
}

export interface UpdateProductOrderDraftInput {
  readonly title?: string;
  readonly businessType?: string;
  readonly goods?: readonly string[];
  readonly totalAmount?: string;
  readonly currency?: string;
  readonly exportRegion?: string;
  readonly destinationRegion?: string;
  readonly expectedCompletionDate?: string;
  readonly notes?: string;
}

export interface CreateProductInviteInput {
  readonly roleSlotId: string;
  readonly contact: string;
  readonly displayName?: string;
  readonly expiresAt?: string;
}

export interface AcceptProductInviteInput {
  readonly displayName: string;
  readonly walletAddress: string;
  readonly contact: string;
  readonly sessionWalletAddress?: string;
}

export interface RejectProductInviteInput {
  readonly displayName?: string;
  readonly contact?: string;
}

export interface PreviewProductInviteInput {
  readonly walletAddress?: string;
}

export interface ProductOrderDraftResponse {
  readonly draft: ProductOrderDraftDTO;
  readonly participants: readonly DraftParticipantDTO[];
}

export interface ProductInviteResponse {
  readonly invite: ProductInviteDTO;
  readonly participant: DraftParticipantDTO;
  readonly draft: ProductOrderDraftDTO;
}

export interface ProductInviteWalletBindingDTO {
  readonly walletAddress: string;
  readonly alreadyBound: boolean;
  readonly canAccept: boolean;
  readonly boundParticipantId?: string;
  readonly boundRoleSlotId?: string;
  readonly boundRoleLabel?: string;
}

export interface ProductInviteAcceptanceDTO {
  readonly canAccept: boolean;
  readonly status:
    | "can_accept"
    | "expired"
    | "already_accepted"
    | "rejected"
    | "revoked"
    | "role_already_filled"
    | "wallet_already_bound";
}

export interface ProductInviteRolePreviewDTO {
  readonly roleSlotId: string;
  readonly label: string;
  readonly duty: string;
  readonly requiredEvidence: readonly string[];
}

export interface ProductInvitePreviewResponse extends ProductInviteResponse {
  readonly acceptance: ProductInviteAcceptanceDTO;
  readonly role: ProductInviteRolePreviewDTO;
  readonly walletBinding?: ProductInviteWalletBindingDTO;
}

export interface ProductParticipantAssignmentDTO {
  readonly participant: DraftParticipantDTO;
  readonly draft: ProductOrderDraftDTO;
  readonly registration?: ProductOrderRegistrationDTO;
  readonly permissions: readonly ParticipantPermissionDTO[];
}

export interface SubmitProductOrderDraftResult {
  readonly draft: ProductOrderDraftDTO;
  readonly participants: readonly DraftParticipantDTO[];
  readonly permissions: readonly ParticipantPermissionDTO[];
  readonly registration: ProductOrderRegistrationDTO;
}

export interface StartProductOrderRegistrationResult {
  readonly registration: ProductOrderRegistrationDTO;
  readonly start: ProductOrderStartDTO;
}
