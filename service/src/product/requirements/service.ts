// 订单要求包服务：声明（PUT）、读取（GET）、相对方合意（POST）。草稿状态与
// 参与者名单只读 v0 BFF 台账；requirementsHash 只由本服务对 canonical JSON
// 计算，合意消息格式单源在 @uvp-eth/product-dto。

import { randomUUID } from "node:crypto";
import { verifyMessage } from "viem";
import {
  orderRequirementsConsentMessage,
  type OrderRequirementsBundleDTO,
  type OrderRequirementsConsentDTO,
  type OrderRequirementsTriggerAnchorDTO,
} from "@uvp-eth/product-dto";
import { normalizeAddress, type Address, type Hex } from "../../shared/types.js";
import type { ProductBffStore } from "../query/bff/store.js";
import type {
  ProductOrderDraftDTO,
  ProductOrderDraftStatus,
} from "../query/bff/types.js";
import {
  OrderRequirementsError,
  type OrderRequirementBundleRecord,
  type OrderRequirementConsentRecord,
  type OrderRequirementsConsentInput,
  type OrderRequirementsConsentResult,
  type OrderRequirementsDeclarationResult,
  type OrderRequirementsService,
  type OrderRequirementsStore,
} from "./types.js";
import {
  parseOrderRequirementsDeclaration,
  requirementsHashOf,
} from "./validate.js";

const EDITABLE_DRAFT_STATUSES: ReadonlySet<ProductOrderDraftStatus> = new Set([
  "draft",
  "awaiting_participants",
  "ready_to_trigger",
  "failed",
]);

const BYTES32_PATTERN = /^0x[0-9a-fA-F]{64}$/;

export interface CreateOrderRequirementsServiceOptions {
  readonly bffStore: ProductBffStore;
  readonly store: OrderRequirementsStore;
  readonly now?: () => Date;
  readonly verifyConsentSignature?: (input: {
    readonly address: Address;
    readonly message: string;
    readonly signature: Hex;
  }) => Promise<boolean>;
}

export function createOrderRequirementsService(
  options: CreateOrderRequirementsServiceOptions,
): OrderRequirementsService {
  const drafts = options.bffStore;
  const store = options.store;
  const now = options.now ?? (() => new Date());
  const verifySignature =
    options.verifyConsentSignature ?? defaultVerifyConsentSignature;

  async function requireDraft(draftId: string): Promise<ProductOrderDraftDTO> {
    const draft = await drafts.getDraft(draftId);
    if (!draft) {
      throw new OrderRequirementsError(
        404,
        "draft_not_found",
        "the order draft was not found",
        { draftId },
      );
    }
    return draft;
  }

  async function readBundle(
    draftId: string,
  ): Promise<OrderRequirementsBundleDTO> {
    const record = await store.getBundle(draftId);
    if (!record) {
      throw new OrderRequirementsError(
        404,
        "requirements_not_found",
        "the order draft has no declared requirement bundle",
        { draftId },
      );
    }
    const consents = await store.listConsents(draftId);
    return {
      ...record.declaration,
      declaredBy: record.declaredBy,
      requirementsHash: record.requirementsHash,
      ...(consents.length > 0
        ? { consents: consents.map(consentView) }
        : {}),
    };
  }

  return {
    async declare(draftId, actorWallet, body) {
      const draft = await requireDraft(draftId);
      const actor = normalizeAddress(actorWallet, "wallet");
      if (!draft.createdBy || draft.createdBy.toLowerCase() !== actor) {
        throw new OrderRequirementsError(
          403,
          "draft_access_denied",
          "only the draft creator can declare the requirement bundle",
          { draftId },
        );
      }
      if (!isEditable(draft)) {
        throw new OrderRequirementsError(
          409,
          "draft_not_editable",
          "the order draft has entered the trigger lifecycle; its requirement bundle can no longer change",
          { draftId, status: draft.status },
        );
      }
      const declaration = parseOrderRequirementsDeclaration(body);
      const requirementsHash = requirementsHashOf(declaration);
      const timestamp = now().toISOString();
      const existing = await store.getBundle(draftId);
      const record: OrderRequirementBundleRecord = {
        draftId,
        declaration,
        requirementsHash,
        declaredBy: actor,
        declaredAt: existing?.declaredAt ?? timestamp,
        updatedAt: timestamp,
      };
      await store.saveBundle(record);
      const bundle = await readBundle(draftId);
      return declarationResult(draft, bundle);
    },

    async get(draftId, actorWallet) {
      const draft = await requireDraft(draftId);
      const actor = normalizeAddress(actorWallet, "wallet");
      const participants = await drafts.listParticipants(draftId);
      const isCreator =
        draft.createdBy !== undefined &&
        draft.createdBy.toLowerCase() === actor;
      const isParticipant = participants.some(
        (participant) =>
          participant.status === "accepted" &&
          participant.walletAddress?.toLowerCase() === actor,
      );
      if (!isCreator && !isParticipant) {
        throw new OrderRequirementsError(
          403,
          "draft_access_denied",
          "only the draft creator or an accepted participant can read the requirement bundle",
          { draftId },
        );
      }
      const bundle = await readBundle(draftId);
      return declarationResult(draft, bundle);
    },

    async consent(draftId, actorWallet, input) {
      const draft = await requireDraft(draftId);
      const actor = normalizeAddress(actorWallet, "wallet");
      const record = await store.getBundle(draftId);
      if (!record) {
        throw new OrderRequirementsError(
          404,
          "requirements_not_found",
          "the order draft has no declared requirement bundle",
          { draftId },
        );
      }
      const receivedHash = requireConsentHash(input.requirementsHash);
      if (receivedHash.toLowerCase() !== record.requirementsHash.toLowerCase()) {
        throw new OrderRequirementsError(
          409,
          "requirements_hash_mismatch",
          "the consent was signed for a different requirement bundle hash",
          {
            requirementsHash: record.requirementsHash,
            receivedHash,
          },
        );
      }
      if (draft.createdBy?.toLowerCase() === actor) {
        throw new OrderRequirementsError(
          403,
          "not_a_counterparty",
          "the declarer cannot consent to their own requirement bundle",
          { draftId },
        );
      }
      const participants = await drafts.listParticipants(draftId);
      const counterparty = participants.find(
        (participant) =>
          participant.status === "accepted" &&
          participant.walletAddress?.toLowerCase() === actor,
      );
      if (!counterparty) {
        throw new OrderRequirementsError(
          403,
          "not_a_counterparty",
          "only an accepted counterparty participant can consent to the requirement bundle",
          { draftId },
        );
      }
      const message = orderRequirementsConsentMessage(
        draftId,
        record.requirementsHash,
      );
      const signatureValid = await verifySignature({
        address: actor,
        message,
        signature: input.signature,
      });
      if (!signatureValid) {
        throw new OrderRequirementsError(
          400,
          "consent_signature_invalid",
          "the consent signature does not recover to the session wallet over this requirement bundle",
          { draftId },
        );
      }
      const timestamp = now().toISOString();
      const consent: OrderRequirementConsentRecord = {
        consentId: randomUUID(),
        draftId,
        walletAddress: actor,
        requirementsHash: record.requirementsHash,
        signature: input.signature,
        signedAt: timestamp,
        createdAt: timestamp,
      };
      await store.saveConsent(consent);
      const bundle = await readBundle(draftId);
      return {
        consent: consentView(consent),
        consents: bundle.consents ?? [],
        triggerAnchor: anchorOf(draftId, bundle),
      } satisfies OrderRequirementsConsentResult;
    },
  };
}

function declarationResult(
  draft: ProductOrderDraftDTO,
  bundle: OrderRequirementsBundleDTO,
): OrderRequirementsDeclarationResult {
  return {
    draft: { ...draft, requirementsHash: bundle.requirementsHash as Hex },
    bundle,
    consentMessage: orderRequirementsConsentMessage(
      draft.draftId,
      bundle.requirementsHash,
    ),
    triggerAnchor: anchorOf(draft.draftId, bundle),
    editable: isEditable(draft),
  };
}

function anchorOf(
  draftId: string,
  bundle: OrderRequirementsBundleDTO,
): OrderRequirementsTriggerAnchorDTO {
  return {
    draftId,
    schemaVersion: bundle.schemaVersion,
    requirementsHash: bundle.requirementsHash,
    declaredBy: bundle.declaredBy,
    consentedWallets: (bundle.consents ?? []).map(
      (consent) => consent.walletAddress,
    ),
  };
}

function consentView(
  record: OrderRequirementConsentRecord,
): OrderRequirementsConsentDTO {
  return {
    walletAddress: record.walletAddress,
    requirementsHash: record.requirementsHash,
    signature: record.signature,
    signedAt: record.signedAt,
  };
}

function isEditable(draft: ProductOrderDraftDTO): boolean {
  return EDITABLE_DRAFT_STATUSES.has(draft.status);
}

function requireConsentHash(value: string): Hex {
  if (!BYTES32_PATTERN.test(value)) {
    throw new OrderRequirementsError(
      400,
      "invalid_body",
      "requirementsHash must be a 0x-prefixed 32-byte hex digest",
    );
  }
  return value as Hex;
}

async function defaultVerifyConsentSignature(input: {
  readonly address: Address;
  readonly message: string;
  readonly signature: Hex;
}): Promise<boolean> {
  try {
    return await verifyMessage({
      address: input.address,
      message: input.message,
      signature: input.signature,
    });
  } catch {
    return false;
  }
}
