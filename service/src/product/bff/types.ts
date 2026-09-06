import type { Address, Hex } from "../../shared/types.js";
import type { TxReconcileFields } from "../../reconcile/status.js";

export type ProductOrderDraftStatus =
  | "draft"
  | "awaiting_participants"
  | "ready_to_trigger"
  | "triggering"
  | "triggered"
  | "failed"
  | "cancelled";

export type DraftParticipantStatus = "missing" | "invited" | "accepted" | "rejected" | "replaced";
export type ProductInviteStatus = "active" | "accepted" | "rejected" | "expired" | "revoked";
export type PermissionPayloadPolicy = "required" | "optional";
export type ProductOrderTriggerStatus =
  | "pending"
  | "prepared"
  | "submitted"
  | "indexing"
  | "confirmed"
  | "failed"
  | "expired";

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
  readonly triggeredOrderId?: string;
  readonly triggerTxHash?: Hex;
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
  /**
   * 发布者携带的结构化证据要求（镜像 productDto.v1 ProductTaskDTO.evidenceSpec，
   * schema 为不透明 JSON，结构化读取；缺省即无凭证槽位）。
   */
  readonly evidenceSpec?: readonly ProductEvidenceSpecDTO[];
  readonly deadlinePolicy?: string;
}

/**
 * evidenceSpec 槽位的局部结构镜像：key/label 必填，其余为发布者可选的
 * 渲染/上传约束。不 import protocol 包，跟随任务 DTO 的内联定义方式。
 */
export interface ProductEvidenceSpecDTO {
  readonly key: string;
  readonly label: string;
  readonly inputKind?: "file" | "text" | "date";
  readonly accept?: readonly string[];
  readonly required?: boolean;
  readonly description?: string;
}

export interface SignalAuthorizationDTO {
  readonly sourceId: Hex;
  readonly signalId: Hex;
  readonly submitter: Address;
  readonly role: Hex;
  readonly metadataHash: Hex;
}

export interface ProductOrderTriggerDTO extends TxReconcileFields {
  readonly triggerId: string;
  readonly prepareId?: string;
  readonly draftId: string;
  readonly orderId: Hex;
  readonly stateMachineAddress?: Address;
  readonly deploymentId?: Hex;
  readonly planId: Hex;
  readonly planHash: Hex;
  readonly status: ProductOrderTriggerStatus;
  readonly txHash?: Hex;
  readonly blockNumber?: string;
  readonly submitter?: Address;
  readonly sourceId?: Hex;
  readonly signalId?: Hex;
  readonly triggerHookId?: Hex;
  readonly triggerStageId?: Hex;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly retryable: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ProductOrderTriggerRecord extends ProductOrderTriggerDTO {
  readonly creator: Address;
  readonly payloadHash: Hex;
  readonly idempotencyKey: Hex;
  readonly deadline: string;
  readonly typedData: unknown;
  readonly signature?: Hex;
  readonly authorizations: readonly SignalAuthorizationDTO[];
  readonly permissions: readonly ParticipantPermissionDTO[];
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
  /**
   * accept/reject 必须携带 invite token——token 只
   * 在 createInvite 响应中出现一次，库中仅存哈希；inviteId 是弱凭据，
   * 不足以占角色槽。
   */
  readonly token: string;
  /** 会话锚定地址（路由层解析；钱包会话签名证明或 local dev 锚定头）。 */
  readonly sessionWalletAddress: string;
}

export interface RejectProductInviteInput {
  /** reject 同样强制携带 token（哈希比对）。 */
  readonly token: string;
  readonly displayName?: string;
  readonly contact?: string;
}

export interface PreviewProductInviteInput {
  readonly walletAddress?: string;
}

export interface PrepareProductOrderTriggerInput {
  readonly walletAddress: string;
}

export interface TriggerProductOrderInput {
  readonly prepareId: string;
  readonly signature: string;
  readonly walletAddress: string;
}

export interface ProductOrderDraftResponse {
  readonly draft: ProductOrderDraftDTO;
  readonly participants: readonly DraftParticipantDTO[];
}

export interface ProductInviteResponse {
  readonly invite: ProductInviteDTO;
  readonly participant: DraftParticipantDTO;
  readonly draft: ProductOrderDraftDTO;
  /**
   * createInvite 的响应额外携带一次性明文 token
   *（库中只存 tokenHash）。后续 accept/reject 必须回呈该 token。
   */
  readonly inviteToken?: string;
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
  /** 发布者携带的结构化证据要求；缺省即无凭证槽位。 */
  readonly evidenceSpec?: readonly ProductEvidenceSpecDTO[];
}

export interface ProductInvitePreviewResponse extends ProductInviteResponse {
  readonly acceptance: ProductInviteAcceptanceDTO;
  readonly role: ProductInviteRolePreviewDTO;
  readonly walletBinding?: ProductInviteWalletBindingDTO;
}

export interface ProductParticipantAssignmentDTO {
  readonly participant: DraftParticipantDTO;
  readonly draft: ProductOrderDraftDTO;
  readonly trigger?: ProductOrderTriggerDTO;
  readonly permissions: readonly ParticipantPermissionDTO[];
}

export interface SubmitProductOrderDraftResult {
  readonly draft: ProductOrderDraftDTO;
  readonly participants: readonly DraftParticipantDTO[];
  readonly permissions: readonly ParticipantPermissionDTO[];
  readonly trigger: ProductOrderTriggerDTO;
}

export interface PreparedProductOrderTriggerDTO {
  readonly prepareId: string;
  readonly triggerId: string;
  readonly draftId: string;
  readonly orderId: Hex;
  readonly expiresAt: string;
  readonly submitter: Address;
  readonly typedData: unknown;
  readonly summary: {
    readonly orderTitle: string;
    readonly planId: Hex;
    readonly sourceId: Hex;
    readonly signalId: Hex;
    readonly triggerHookId: Hex;
    readonly triggerStageId: Hex;
    readonly walletAddress: Address;
  };
}

export interface PrepareProductOrderTriggerResult {
  readonly draft: ProductOrderDraftDTO;
  readonly participants: readonly DraftParticipantDTO[];
  readonly permissions: readonly ParticipantPermissionDTO[];
  readonly trigger: ProductOrderTriggerDTO;
  readonly prepared: PreparedProductOrderTriggerDTO;
}

export type TriggerProductOrderResult = SubmitProductOrderDraftResult;
