// V3 订单域服务面类型：配置版本/订单草稿/阶段/slot/邀请/订单记录、
// 持久化口与错误码。标识/派生规则（stageId、termsHash、configHash）在
// canonical.ts 单源；本模块不做行业解释。

import type {
  ConfigBundleV3,
  OrderConfigStatusV3,
  OrderDraftStatusV3,
  StageInviteStatusV3,
  StageSlotStatusV3,
  StageStandardRefV3,
} from "@uvp-eth/product-dto";
import type { Address, Hex } from "../../shared/types.js";

export type OrderV3ErrorCode =
  | "invalid_request"
  | "invalid_address"
  | "invalid_amount"
  | "invalid_deadline"
  | "invalid_window_value"
  | "window_override_forbidden"
  | "invalid_stage_subset"
  | "invalid_stage_terms"
  | "invalid_final_standard_hash"
  | "invalid_invite_token"
  | "invalid_invite_signature"
  | "stage_terms_mismatch"
  | "invite_nonce_mismatch"
  | "wallet_identity_required"
  | "wrong_wallet"
  | "config_not_found"
  | "config_not_published"
  | "config_publish_forbidden"
  | "config_hash_mismatch"
  | "config_version_exists"
  | "config_version_not_draft"
  | "config_already_published"
  | "config_already_deprecated"
  | "order_draft_not_found"
  | "order_not_found"
  | "stage_not_found"
  | "slot_not_found"
  | "invite_not_found"
  | "invite_expired"
  | "invite_not_active"
  | "invite_already_active"
  | "invite_already_accepted"
  | "slot_already_accepted"
  | "stage_already_accepted"
  | "stage_subset_immutable"
  | "draft_frozen"
  | "order_already_triggered"
  | "required_slots_incomplete"
  | "order_anchor_unavailable"
  | "idempotency_key_reuse"
  | "stage_scope_forbidden"
  | "wallet_scope_forbidden"
  | "visibility_denied"
  | "escrow_unavailable"
  | "projection_unavailable"
  | "instruction_projection_unavailable"
  | "handle_not_found"
  | "resource_forbidden"
  | "resource_parse_failed"
  | "resource_unavailable"
  | "resolver_unavailable"
  | "signal_not_allowed"
  | "signal_capability_missing"
  | "plan_capability_unavailable"
  | "birth_transport_unavailable"
  | "birth_route_missing"
  | "birth_attribution_missing"
  | "birth_attribution_mismatch"
  | "birth_signer_unavailable"
  | "birth_signer_mismatch"
  | "birth_broadcast_failed"
  | "finalize_signature_required"
  | "finalize_not_prepared"
  | "finalize_authorization_expired"
  | "finalize_authorization_mismatch"
  | "stage_skipped"
  | "published_plan_missing"
  | "published_plan_invalid"
  | "published_plan_mismatch"
  | "registration_plan_required"
  | "registration_plan_mismatch"
  | "published_plan_unavailable"
  | "trigger_transport_unavailable"
  | "trigger_result_invalid";

export class OrderV3Error extends Error {
  override readonly name = "OrderV3Error";

  constructor(
    readonly status: number,
    readonly code: OrderV3ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export interface ConfigBirthProof {
  readonly sourceId: Hex;
  readonly signalId: Hex;
  readonly stageId: Hex;
  readonly capabilityProof: readonly Hex[];
}

export interface ConfigBirthAuthorization {
  readonly sourceId: Hex;
  readonly signalId: Hex;
  readonly submitter: Address;
  readonly role: Hex;
  readonly metadataHash: Hex;
}

export interface ConfigBirthRecord {
  readonly triggerHookId: Hex;
  readonly triggerStageId: Hex;
  readonly sourceId: Hex;
  readonly signalId: Hex;
  readonly birthAuthorizer: Address;
  /** Capability 词表计划的出生事实属主自证；缺省即 fail-closed。 */
  readonly attribution: ConfigBirthProof;
  /** outside-trigger 的 SignalAuthorization 集（与 typed data 的 authorizationsHash 绑定）。 */
  readonly authorizations?: readonly ConfigBirthAuthorization[];
}

export interface ConfigVersionRecord {
  readonly configId: string;
  readonly version: string;
  readonly status: OrderConfigStatusV3;
  readonly configHash: Hex;
  readonly planId?: Hex;
  readonly planHash?: Hex;
  readonly birth?: ConfigBirthRecord;
  readonly bundle: ConfigBundleV3;
  readonly createdBy: Address;
  readonly createdAt: string;
  readonly publishedAt?: string;
  readonly updatedAt: string;
}

export interface OrderDraftRecord {
  readonly draftId: string;
  readonly configId: string;
  readonly configVersion: string;
  readonly configHash: Hex;
  readonly buyerWallet: Address;
  readonly chainId: number;
  readonly stateMachine: Address;
  readonly title: string;
  readonly currency: string;
  readonly stageSubset: readonly string[];
  readonly status: OrderDraftStatusV3;
  readonly termsHash?: Hex;
  readonly finalizeNonce?: string;
  readonly finalizeDeadline?: string;
  readonly orderId?: string;
  readonly planId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly frozenAt?: string;
}

export interface OrderStageRecord {
  readonly draftId: string;
  readonly stageKey: string;
  readonly stageId: Hex;
  readonly stageIndex: number;
  readonly amount: string;
  readonly slots: Readonly<Record<string, Address>>;
  readonly profileRef?: string;
  readonly standard?: StageStandardRefV3;
  readonly finalStandardHash: Hex;
  readonly inviteDeadline: string;
  readonly workDeadline: string;
  readonly termsHash: Hex;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface OrderStageSlotRecord {
  readonly draftId: string;
  readonly stageKey: string;
  readonly slotKey: string;
  readonly required: boolean;
  readonly subjectLabel?: string;
  readonly contactRef?: string;
  readonly wallet?: Address;
  readonly status: StageSlotStatusV3;
  readonly inviteId?: string;
  readonly acceptedTermsHash?: Hex;
  readonly acceptedAt?: string;
  readonly signature?: Hex;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface OrderInviteRecord {
  readonly inviteId: string;
  readonly draftId: string;
  readonly stageKey: string;
  readonly stageId: Hex;
  readonly slotKey: string;
  readonly subjectLabel: string;
  readonly contactRef?: string;
  readonly wallet?: Address;
  readonly tokenHash: string;
  readonly nonce: string;
  readonly status: StageInviteStatusV3;
  readonly expiresAt: string;
  readonly createdBy: Address;
  readonly acceptedBy?: Address;
  readonly acceptedAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface OrderRecord {
  readonly orderId: string;
  readonly draftId: string;
  readonly planId: string;
  readonly stateMachine: Address;
  readonly chainId: number;
  readonly buyerWallet: Address;
  readonly termsHash: Hex;
  readonly status: string;
  readonly txHash?: Hex;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface IdempotencyRecord {
  readonly principalWallet: Address;
  readonly operation: string;
  readonly idemKey: string;
  readonly requestHash: Hex;
  readonly resourceId?: string;
  readonly responseJson: string;
  readonly status: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface OrderV3Store {
  getConfig(configId: string, version: string): Promise<ConfigVersionRecord | undefined>;
  saveConfig(record: ConfigVersionRecord): Promise<void>;
  setConfigStatus(
    configId: string,
    version: string,
    status: OrderConfigStatusV3,
    updatedAt: string,
    publishedAt?: string,
  ): Promise<boolean>;

  createDraft(record: OrderDraftRecord): Promise<void>;
  getDraft(draftId: string): Promise<OrderDraftRecord | undefined>;
  saveDraft(record: OrderDraftRecord): Promise<void>;

  createStages(records: readonly OrderStageRecord[]): Promise<void>;
  listStages(draftId: string): Promise<readonly OrderStageRecord[]>;
  getStage(draftId: string, stageKey: string): Promise<OrderStageRecord | undefined>;
  saveStage(record: OrderStageRecord): Promise<void>;

  replaceStageSlots(
    draftId: string,
    stageKey: string,
    records: readonly OrderStageSlotRecord[],
  ): Promise<void>;
  listSlots(draftId: string): Promise<readonly OrderStageSlotRecord[]>;
  getSlot(
    draftId: string,
    stageKey: string,
    slotKey: string,
  ): Promise<OrderStageSlotRecord | undefined>;
  saveSlot(record: OrderStageSlotRecord): Promise<void>;

  createInvite(record: OrderInviteRecord): Promise<void>;
  getInvite(inviteId: string): Promise<OrderInviteRecord | undefined>;
  findActiveInvite(
    draftId: string,
    stageKey: string,
    slotKey: string,
  ): Promise<OrderInviteRecord | undefined>;
  saveInvite(record: OrderInviteRecord): Promise<void>;
  /** 条件迁移：仅当当前状态等于 from 时写入 to 与附加字段，返回是否生效。 */
  transitionInvite(
    inviteId: string,
    from: StageInviteStatusV3,
    to: StageInviteStatusV3,
    patch: {
      readonly acceptedBy?: Address;
      readonly acceptedAt?: string;
      readonly updatedAt: string;
    },
  ): Promise<boolean>;

  createOrder(record: OrderRecord): Promise<void>;
  getOrder(orderId: string): Promise<OrderRecord | undefined>;

  getIdempotency(
    principalWallet: Address,
    operation: string,
    idemKey: string,
  ): Promise<IdempotencyRecord | undefined>;
  saveIdempotency(record: IdempotencyRecord): Promise<void>;
}
