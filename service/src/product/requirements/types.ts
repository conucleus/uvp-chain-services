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

export interface OrderRequirementBundleRecord {
  readonly draftId: string;
  readonly declaration: OrderRequirementsDeclarationDTO;
  readonly requirementsHash: Hex;
  readonly declaredBy: Address;
  readonly declaredAt: string;
  readonly updatedAt: string;
}

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
  saveBundle(record: OrderRequirementBundleRecord): Promise<void>;
  listConsents(
    draftId: string,
  ): Promise<readonly OrderRequirementConsentRecord[]>;
  saveConsent(record: OrderRequirementConsentRecord): Promise<void>;
}

export interface OrderRequirementsDraftPort {
  getDraft(draftId: string): Promise<ProductOrderDraftDTO | undefined>;
  listParticipants(
    draftId: string,
  ): Promise<readonly DraftParticipantDTO[]>;
}

export interface OrderRequirementsDeclarationResult {
  readonly draft: ProductOrderDraftDTO;
  readonly bundle: OrderRequirementsBundleDTO;
  readonly consentMessage?: string;
  readonly triggerAnchor: OrderRequirementsTriggerAnchorDTO;
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
