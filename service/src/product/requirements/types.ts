// V1 订单要求包服务面类型：声明/读取/相对方合意的输入输出、持久化记录与
// 错误码单源；DTO 形状来自 @uvp-eth/product-dto（order-requirements.ts），
// 服务端只派生 declaredBy/requirementsHash/consents 与 signedAt。

import type {
  OrderRequirementsBundleDTO,
  OrderRequirementsConsentDTO,
  OrderRequirementsDeclarationDTO,
  OrderRequirementsTriggerAnchorDTO,
} from "@uvp-eth/product-dto";
import type { Address, Hex } from "../../shared/types.js";
import type {
  DraftParticipantDTO,
  ProductOrderDraftDTO,
} from "../query/bff/types.js";

/**
 * 要求包服务的失败态：status 定 HTTP，code 精确到因（未登录/无权限由路由的
 * 身份门给 401，这里给 403/404/409/400 的具名分支）。
 */
export class OrderRequirementsError extends Error {
  override readonly name = "OrderRequirementsError";

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/** 草稿持久化记录：declaration 是客户端原文（服务端已结构校验/规范化）。 */
export interface OrderRequirementBundleRecord {
  readonly draftId: string;
  readonly declaration: OrderRequirementsDeclarationDTO;
  readonly requirementsHash: Hex;
  readonly declaredBy: Address;
  readonly declaredAt: string;
  readonly updatedAt: string;
}

/** 相对方合意记录：签名覆盖 (draftId, requirementsHash)。 */
export interface OrderRequirementConsentRecord {
  readonly consentId: string;
  readonly draftId: string;
  readonly walletAddress: Address;
  readonly requirementsHash: Hex;
  readonly signature: Hex;
  readonly signedAt: string;
  readonly createdAt: string;
}

export interface OrderRequirementsStore {
  getBundle(
    draftId: string,
  ): Promise<OrderRequirementBundleRecord | undefined>;
  /** 声明 upsert；同事务删掉 hash 已不匹配的旧合意（合意只对当前包有效）。 */
  saveBundle(record: OrderRequirementBundleRecord): Promise<void>;
  listConsents(
    draftId: string,
  ): Promise<readonly OrderRequirementConsentRecord[]>;
  /** 同一钱包重新合意时覆盖旧记录（一个钱包对本包只有一个立场）。 */
  saveConsent(record: OrderRequirementConsentRecord): Promise<void>;
}

/** 要求包服务对草稿/参与者名单的最小读取口（ProductBffStore 直接满足）。 */
export interface OrderRequirementsDraftPort {
  getDraft(draftId: string): Promise<ProductOrderDraftDTO | undefined>;
  listParticipants(
    draftId: string,
  ): Promise<readonly DraftParticipantDTO[]>;
}

export interface OrderRequirementsDeclarationResult {
  readonly draft: ProductOrderDraftDTO;
  readonly bundle: OrderRequirementsBundleDTO;
  /** 相对方合意签名消息（格式单源在 @uvp-eth/product-dto）。 */
  readonly consentMessage?: string;
  readonly triggerAnchor: OrderRequirementsTriggerAnchorDTO;
  /** 当前草稿是否仍允许改要求包（读面展示旗标）。 */
  readonly editable: boolean;
}

export interface OrderRequirementsConsentInput {
  readonly requirementsHash: Hex;
  readonly signature: Hex;
}

export interface OrderRequirementsConsentResult {
  readonly consent: OrderRequirementsConsentDTO;
  readonly consents: readonly OrderRequirementsConsentDTO[];
  readonly triggerAnchor: OrderRequirementsTriggerAnchorDTO;
}

export interface OrderRequirementsService {
  declare(
    draftId: string,
    actorWallet: Address,
    body: unknown,
  ): Promise<OrderRequirementsDeclarationResult>;
  get(
    draftId: string,
    actorWallet: Address,
  ): Promise<OrderRequirementsDeclarationResult>;
  consent(
    draftId: string,
    actorWallet: Address,
    input: OrderRequirementsConsentInput,
  ): Promise<OrderRequirementsConsentResult>;
}
