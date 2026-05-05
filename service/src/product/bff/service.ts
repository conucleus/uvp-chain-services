import { createHash, randomUUID } from "node:crypto";
import {
  type StoreZhixuVersionSummaryDTO,
  type ZhixuDetailDTO
} from "@uvp-eth/product-dto";
import {
  buildTriggerOrderFromOutsideTypedData,
  recoverTriggerOrderFromOutsideSigner,
  type TriggerOrderFromOutsideTypedData
} from "@uvp-eth/protocol-bindings";
import { ConfigError, normalizeAddress, normalizeBytes32, type Address, type Hex } from "../../shared/types.js";
import type { SupplierTrustProjection } from "../../indexer/trust-projections.js";
import type { TxReconcileFields } from "../../reconcile/status.js";
import type { ProductService } from "../service.js";
import {
  ProductAuthorizationBuilder,
  ProductAuthorizationBuilderError
} from "./authorization.js";
import {
  DEFAULT_PRODUCT_REGISTRAR_ADDRESS,
  MemoryProductOrderTriggerBroadcastAdapter,
  productSignalId,
  productSignalSourceId,
  type ProductOrderTriggerBroadcastAdapter,
  type ProductOrderTriggerBroadcastResult
} from "./trigger.js";
import { MemoryProductBffStore, type ProductBffStore } from "./store.js";
import type {
  AcceptProductInviteInput,
  CreateProductInviteInput,
  CreateProductOrderDraftInput,
  DraftParticipantDTO,
  ParticipantPermissionDTO,
  PrepareProductOrderTriggerInput,
  PrepareProductOrderTriggerResult,
  PreparedProductOrderTriggerDTO,
  PreviewProductInviteInput,
  ProductInviteAcceptanceDTO,
  ProductInviteDTO,
  ProductInvitePreviewResponse,
  ProductInviteRolePreviewDTO,
  ProductInviteWalletBindingDTO,
  ProductOrderDraftDTO,
  ProductOrderDraftStatus,
  ProductOrderTriggerDTO,
  ProductOrderTriggerRecord,
  ProductParticipantAssignmentDTO,
  RejectProductInviteInput,
  SubmitProductOrderDraftResult,
  TriggerProductOrderInput,
  TriggerProductOrderResult,
  UpdateProductOrderDraftInput
} from "./types.js";

export class ProductBffError extends Error {
  override readonly name = "ProductBffError";

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
  }
}

export interface ProductBffServiceOptions {
  readonly productService: ProductService;
  readonly store?: ProductBffStore;
  readonly registrationAdapter?: ProductOrderTriggerBroadcastAdapter;
  readonly triggerAdapter?: ProductOrderTriggerBroadcastAdapter;
  readonly authorizationBuilder?: ProductAuthorizationBuilder;
  readonly supplierTrustResolver?: ProductBffSupplierTrustResolver;
  readonly versionResolver?: ProductDraftVersionResolver;
  readonly registrationCreatorAddress?: Address;
  readonly registrarAddress?: Address;
  readonly triggerChainId?: number;
  readonly now?: () => Date;
}

export type ProductBffSupplierTrust = Pick<
  SupplierTrustProjection,
  "registryAddress" | "supplierSubjectId" | "wallet" | "status" | "revoked" | "updatedAt"
>;

export type ProductBffSupplierTrustResolver = (wallet: Address) => Promise<ProductBffSupplierTrust | undefined>;

export interface ProductDraftVersionResolver {
  resolveActiveVersion(zhixuId: string): Promise<StoreZhixuVersionSummaryDTO | undefined>;
}

export interface ProductBffService {
  createDraft(input: CreateProductOrderDraftInput): Promise<DraftWithParticipants>;
  getDraft(draftId: string): Promise<DraftWithParticipants>;
  updateDraft(draftId: string, input: UpdateProductOrderDraftInput): Promise<ProductOrderDraftDTO>;
  prepareOrderTrigger(draftId: string, input: PrepareProductOrderTriggerInput): Promise<PrepareProductOrderTriggerResult>;
  triggerOrder(draftId: string, input: TriggerProductOrderInput): Promise<TriggerProductOrderResult>;
  getRegistration(triggerId: string): Promise<ProductOrderTriggerDTO>;
  createInvite(draftId: string, input: CreateProductInviteInput): Promise<InviteWithDraft>;
  getInvite(inviteId: string, input?: PreviewProductInviteInput): Promise<ProductInvitePreviewResponse>;
  acceptInvite(inviteId: string, input: AcceptProductInviteInput): Promise<InviteWithDraft>;
  rejectInvite(inviteId: string, input: RejectProductInviteInput): Promise<InviteWithDraft>;
  listParticipants(draftId: string): Promise<readonly DraftParticipantDTO[]>;
  listParticipantAssignments(walletAddress: string): Promise<readonly ProductParticipantAssignmentDTO[]>;
}

export interface DraftWithParticipants {
  readonly draft: ProductOrderDraftDTO;
  readonly participants: readonly DraftParticipantDTO[];
}

export interface InviteWithDraft {
  readonly invite: ProductInviteDTO;
  readonly participant: DraftParticipantDTO;
  readonly draft: ProductOrderDraftDTO;
}

export function createProductBffService(options: ProductBffServiceOptions): ProductBffService {
  const store = options.store ?? new MemoryProductBffStore();
  const triggerAdapter = options.triggerAdapter ?? options.registrationAdapter ?? new MemoryProductOrderTriggerBroadcastAdapter();
  const authorizationBuilder = options.authorizationBuilder ?? new ProductAuthorizationBuilder();
  const registrarAddress = normalizeAddress(
    options.registrarAddress ?? triggerAdapter.registrarAddress ?? DEFAULT_PRODUCT_REGISTRAR_ADDRESS,
    "registrarAddress"
  );
  const registrationCreatorAddress = options.registrationCreatorAddress
    ? normalizeAddress(options.registrationCreatorAddress, "registrationCreatorAddress")
    : undefined;
  const triggerChainId = options.triggerChainId ?? 31337;
  const now = options.now ?? (() => new Date());
  const idScope = randomUUID().replaceAll("-", "").slice(0, 8);
  let sequence = 1;

  return {
    async createDraft(input) {
      const zhixu = await requireActiveZhixu(options.productService, input.zhixuId, options.versionResolver);
      const createdAt = now().toISOString();
      const draft: ProductOrderDraftDTO = {
        draftId: nextId("draft", idScope, sequence++),
        zhixuId: zhixu.zhixuId,
        planId: normalizeBytes32(zhixu.chainAttestation.planId, "planId"),
        planHash: normalizeBytes32(zhixu.chainAttestation.planHash, "planHash"),
        title: input.title,
        businessType: input.businessType,
        goods: input.goods ?? [],
        totalAmount: input.totalAmount,
        currency: input.currency,
        ...(input.exportRegion ? { exportRegion: input.exportRegion } : {}),
        ...(input.destinationRegion ? { destinationRegion: input.destinationRegion } : {}),
        ...(input.expectedCompletionDate ? { expectedCompletionDate: input.expectedCompletionDate } : {}),
        ...(input.notes ? { notes: input.notes } : {}),
        status: "draft",
        createdBy: input.createdBy ?? "anonymous",
        createdAt,
        updatedAt: createdAt
      };
      const participants = zhixu.roleSlots.map((slot, index) => ({
        participantId: nextId("participant", idScope, sequence + index),
        draftId: draft.draftId,
        roleSlotId: slot.slotId,
        roleLabel: slot.label,
        displayName: slot.title,
        contact: "",
        status: "missing" as const,
        required: slot.required
      }));
      sequence += participants.length;
      await store.createDraft(draft, participants);
      return { draft, participants };
    },

    async getDraft(draftId) {
      const draft = await requireDraft(store, draftId);
      return { draft, participants: await store.listParticipants(draftId) };
    },

    async updateDraft(draftId, input) {
      const current = await requireDraft(store, draftId);
      const draft: ProductOrderDraftDTO = {
        ...current,
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.businessType !== undefined ? { businessType: input.businessType } : {}),
        ...(input.goods !== undefined ? { goods: input.goods } : {}),
        ...(input.totalAmount !== undefined ? { totalAmount: input.totalAmount } : {}),
        ...(input.currency !== undefined ? { currency: input.currency } : {}),
        ...(input.exportRegion !== undefined ? { exportRegion: input.exportRegion } : {}),
        ...(input.destinationRegion !== undefined ? { destinationRegion: input.destinationRegion } : {}),
        ...(input.expectedCompletionDate !== undefined ? { expectedCompletionDate: input.expectedCompletionDate } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        updatedAt: now().toISOString()
      };
      await store.updateDraft(draft);
      return draft;
    },

    async prepareOrderTrigger(draftId, input) {
      const draft = await requireDraft(store, draftId);
      const participants = await store.listParticipants(draftId);
      const existingRegistration = await store.getRegistrationByDraft(draftId);
      const walletAddress = normalizeAddress(input.walletAddress, "walletAddress");
      const prepareNow = now();
      if (existingRegistration) {
        const expiredPreparedTrigger = existingRegistration.status === "prepared" &&
          existingRegistration.submitter === walletAddress &&
          isPrepareExpired(existingRegistration, prepareNow);
        if (existingRegistration.status === "prepared" && existingRegistration.submitter === walletAddress && !expiredPreparedTrigger) {
          return prepareResultFromRegistration(draft, participants, existingRegistration);
        }
        if (!expiredPreparedTrigger && (existingRegistration.status !== "failed" || !existingRegistration.retryable)) {
          throw new ProductBffError(409, "trigger_already_exists", "order draft already has a trigger record", {
            triggerId: existingRegistration.triggerId,
            status: existingRegistration.status
          });
        }
      }

      requireAcceptedRequiredParticipants(participants);
      const retryingFailedTrigger = existingRegistration?.status === "failed" && existingRegistration.retryable;
      if (draft.status !== "ready_to_trigger" && !(draft.status === "failed" && retryingFailedTrigger)) {
        throw new ProductBffError(409, "draft_not_ready", "order draft is not ready to trigger", {
          status: draft.status
        });
      }

      const zhixu = await requireActiveZhixu(options.productService, draft.zhixuId, options.versionResolver);
      assertDraftUsesActiveZhixuVersion(draft, zhixu);
      const activeDeployment = await requireActiveStateMachineDeployment(options.productService);
      const orderId = randomOrderId(draft, idScope, sequence);
      const creator = creatorForDraft(draft, registrationCreatorAddress ?? registrarAddress);
      const submitter = requireTriggerSubmitter(draft, participants, walletAddress, creator);
      await rejectRevokedSupplierParticipants(participants, options.supplierTrustResolver);
      const builtAuthorization = buildAuthorizations(() =>
        authorizationBuilder.build({
          zhixu,
          draft,
          participants,
          orderId,
          registrarAddress
        })
      );
      const createOrderTrigger = requireCreateOrderTrigger(zhixu);
      const stateMachineAddress = normalizeAddress(activeDeployment.stateMachineAddress, "activeStateMachineAddress");
      const deploymentId = normalizeBytes32(activeDeployment.deploymentId, "activeDeploymentId");
      const createdAt = prepareNow.toISOString();
      const deadline = Math.floor(prepareNow.getTime() / 1000 + 3600).toString();
      const triggerId = existingRegistration?.triggerId ?? nextId("trigger", idScope, sequence++);
      const prepareId = nextId("prepare", idScope, sequence++);
      const sourceId = productSignalSourceId(createOrderTrigger.source);
      const signalId = productSignalId(createOrderTrigger.signalName);
      const payloadHash = hashHex(`uvp:product-bff:trigger:payload:v2:${draftId}:${orderId}:${submitter}:${prepareId}`);
      const idempotencyKey = hashHex(`uvp:product-bff:trigger:idempotency:v2:${draftId}:${orderId}:${prepareId}`);
      const triggerHookId = normalizeBytes32(createOrderTrigger.triggerHookId, "createOrderTrigger.triggerHookId");
      const triggerStageId = normalizeBytes32(createOrderTrigger.triggerStageId, "createOrderTrigger.triggerStageId");
      const typedData = buildTriggerOrderFromOutsideTypedData({
        chainId: triggerChainId,
        verifyingContract: stateMachineAddress,
        orderId,
        planId: draft.planId,
        creator,
        triggerHookId,
        triggerStageId,
        sourceId,
        signalId,
        payloadHash,
        idempotencyKey,
        authorizations: builtAuthorization.authorizations,
        submitter,
        deadline
      });
      const registration: ProductOrderTriggerRecord = {
        triggerId,
        prepareId,
        draftId,
        orderId,
        stateMachineAddress,
        deploymentId,
        planId: draft.planId,
        planHash: draft.planHash,
        status: "prepared",
        retryable: false,
        submitter,
        sourceId,
        signalId,
        triggerHookId,
        triggerStageId,
        payloadHash,
        idempotencyKey,
        deadline,
        typedData,
        createdAt: existingRegistration?.createdAt ?? createdAt,
        updatedAt: createdAt,
        creator,
        authorizations: builtAuthorization.authorizations,
        permissions: builtAuthorization.permissions
      };
      const readyDraft: ProductOrderDraftDTO = {
        ...draft,
        status: "ready_to_trigger",
        updatedAt: createdAt
      };
      await withProductStoreTransaction(store, async () => {
        if (existingRegistration) {
          await store.updateRegistration(registration);
        } else {
          await store.createRegistration(registration);
        }
        await store.updateDraft(readyDraft);
      });
      return prepareResultFromRegistration(readyDraft, participants, registration);
    },

    async getRegistration(triggerId) {
      return registrationDtoFromRecord(await requireRegistration(store, triggerId));
    },

    async triggerOrder(draftId, input) {
      const draft = await requireDraft(store, draftId);
      const participants = await store.listParticipants(draftId);
      const registration = await requireRegistrationByDraft(store, draftId);
      if (registration.prepareId !== input.prepareId) {
        throw new ProductBffError(409, "prepare_id_mismatch", "trigger prepareId does not match the latest prepared trigger", {
          expectedPrepareId: registration.prepareId
        });
      }
      if (registration.status !== "prepared" && !(registration.status === "failed" && registration.retryable)) {
        throw new ProductBffError(409, "trigger_not_prepared", "order trigger is not in prepared state", {
          status: registration.status
        });
      }
      const submitter = normalizeAddress(input.walletAddress, "walletAddress");
      if (!registration.submitter || submitter !== registration.submitter) {
        throw new ProductBffError(403, "wrong_wallet", "connected wallet does not match trigger submitter", {
          submitter: registration.submitter,
          walletAddress: submitter
        });
      }
      assertPrepareNotExpired(registration, now());
      const recovered = await recoverTriggerSigner(registration.typedData, input.signature);
      if (recovered !== registration.submitter) {
        throw new ProductBffError(403, "invalid_trigger_signature", "trigger signature was not produced by the prepared submitter", {
          recovered,
          submitter: registration.submitter
        });
      }
      const signature = normalizeHexSignature(input.signature);
      const updatedAt = now().toISOString();
      const submitting: ProductOrderTriggerRecord = {
        ...registration,
        status: "submitted",
        signature,
        retryable: false,
        updatedAt
      };
      await withProductStoreTransaction(store, async () => {
        await store.updateRegistration(submitting);
        await store.updateDraft({ ...draft, status: "triggering", updatedAt });
      });
      const broadcasted = await broadcastOutsideTrigger({
        triggerAdapter,
        store,
        draft,
        registration: submitting,
        now
      });
      return submitResultFromRegistration(broadcasted.draft, participants, broadcasted.registration);
    },

    async createInvite(draftId, input) {
      const draft = await requireDraft(store, draftId);
      const participant = await requireRoleParticipant(store, draftId, input.roleSlotId);
      if (participant.status === "accepted") {
        throw new ProductBffError(409, "role_already_filled", "participant role is already accepted", {
          participantId: participant.participantId,
          roleSlotId: participant.roleSlotId
        });
      }
      const existingActiveInvite = (await store.listInvitesByDraft(draftId)).find((invite) =>
        invite.participantId === participant.participantId &&
        invite.status === "active" &&
        !isInviteExpired(invite, now())
      );
      if (existingActiveInvite) {
        throw new ProductBffError(409, "invite_already_active", "participant already has an active invite", {
          inviteId: existingActiveInvite.inviteId,
          participantId: participant.participantId
        });
      }
      if (input.expiresAt !== undefined) {
        requireValidInviteExpiry(input.expiresAt);
      }
      const invited: DraftParticipantDTO = {
        ...participant,
        displayName: input.displayName ?? participant.displayName,
        contact: input.contact,
        status: "invited"
      };
      const invite: ProductInviteDTO = {
        inviteId: nextId("invite", idScope, sequence++),
        draftId,
        participantId: participant.participantId,
        roleSlotId: participant.roleSlotId,
        tokenHash: hashHex(`${draftId}:${participant.participantId}:${input.contact}`),
        status: "active",
        expiresAt: input.expiresAt ?? oneWeekFrom(now()),
        createdAt: now().toISOString()
      };
      return withProductStoreTransaction(store, async () => {
        await store.updateParticipant(invited);
        await store.createInvite(invite);
        const nextDraft = await refreshDraftStatus(store, draft, now);
        return { invite, participant: invited, draft: nextDraft };
      });
    },

    async getInvite(inviteId, input = {}) {
      const invite = await requireInvite(store, inviteId);
      const participant = await requireParticipant(store, invite.participantId);
      const draft = await requireDraft(store, invite.draftId);
      const zhixu = await options.productService.getZhixu(draft.zhixuId);
      const previewInvite = inviteWithCurrentStatus(invite, now());
      const walletAddress = input.walletAddress ? normalizeAddress(input.walletAddress, "walletAddress") : undefined;
      const walletBinding = walletAddress
        ? await inviteWalletBinding(store, previewInvite, participant, walletAddress)
        : undefined;
      return {
        invite: previewInvite,
        participant,
        draft,
        role: inviteRolePreview(zhixu, participant),
        acceptance: inviteAcceptance(previewInvite, participant, walletBinding),
        ...(walletBinding ? { walletBinding } : {})
      };
    },

    async acceptInvite(inviteId, input) {
      const invite = await requireAcceptableInvite(store, inviteId, now);
      const participant = await requireParticipant(store, invite.participantId);
      const acceptedWalletAddress = normalizeAddress(input.walletAddress, "walletAddress");
      if (input.sessionWalletAddress) {
        const sessionWalletAddress = normalizeAddress(input.sessionWalletAddress, "sessionWalletAddress");
        if (sessionWalletAddress !== acceptedWalletAddress) {
          throw new ProductBffError(403, "wrong_wallet", "connected wallet does not match invite acceptance wallet", {
            connectedWalletAddress: sessionWalletAddress,
            walletAddress: acceptedWalletAddress
          });
        }
      }
      await assertWalletCanAcceptInvite(store, invite, participant, acceptedWalletAddress);
      const accepted: DraftParticipantDTO = {
        ...participant,
        displayName: input.displayName,
        contact: input.contact,
        walletAddress: acceptedWalletAddress,
        status: "accepted",
        acceptedAt: now().toISOString()
      };
      const acceptedInvite: ProductInviteDTO = {
        ...invite,
        status: "accepted",
        acceptedWalletAddress
      };
      return withProductStoreTransaction(store, async () => {
        await store.updateParticipant(accepted);
        await store.updateInvite(acceptedInvite);
        const draft = await refreshDraftStatus(store, await requireDraft(store, invite.draftId), now);
        return { invite: acceptedInvite, participant: accepted, draft };
      });
    },

    async rejectInvite(inviteId, input) {
      const invite = await requireAcceptableInvite(store, inviteId, now);
      const participant = await requireParticipant(store, invite.participantId);
      const rejected: DraftParticipantDTO = {
        ...participant,
        ...(input.displayName ? { displayName: input.displayName } : {}),
        ...(input.contact ? { contact: input.contact } : {}),
        status: "rejected",
        rejectedAt: now().toISOString()
      };
      const rejectedInvite: ProductInviteDTO = {
        ...invite,
        status: "rejected"
      };
      return withProductStoreTransaction(store, async () => {
        await store.updateParticipant(rejected);
        await store.updateInvite(rejectedInvite);
        const draft = await refreshDraftStatus(store, await requireDraft(store, invite.draftId), now);
        return { invite: rejectedInvite, participant: rejected, draft };
      });
    },

    async listParticipants(draftId) {
      await requireDraft(store, draftId);
      return store.listParticipants(draftId);
    },

    async listParticipantAssignments(walletAddress) {
      const normalizedWallet = normalizeAddress(walletAddress, "walletAddress");
      const participants = await store.listAcceptedParticipantsByWallet(normalizedWallet);
      const assignments: ProductParticipantAssignmentDTO[] = [];
      for (const participant of participants) {
        const draft = await store.getDraft(participant.draftId);
        if (!draft) {
          continue;
        }
        const registration = await store.getRegistrationByDraft(participant.draftId);
        const permissions = registration
          ? participantPermissionsForWallet(registration.permissions, participant, normalizedWallet)
          : [];
        assignments.push({
          participant,
          draft,
          ...(registration ? { trigger: registrationDtoFromRecord(registration) } : {}),
          permissions
        });
      }
      return assignments;
    }
  };
}

async function requireActiveZhixu(
  productService: ProductService,
  zhixuId: string,
  versionResolver?: ProductDraftVersionResolver
): Promise<ZhixuDetailDTO> {
  const zhixu = await productService.getZhixu(zhixuId, { includeUnattested: true });
  if (!zhixu) {
    throw new ProductBffError(404, "zhixu_not_found", "zhixu not found");
  }
  if (versionResolver) {
    const version = await versionResolver.resolveActiveVersion(zhixuId);
    if (!version) {
      throw new ProductBffError(409, "no_active_version", "zhixu has no active Store version");
    }
    if (version.attestationStatus === "revoked" || version.status === "revoked") {
      throw new ProductBffError(409, "plan_revoked", "zhixu plan has been revoked", {
        versionId: version.versionId,
        planId: version.planId
      });
    }
    if (version.attestationStatus !== "attested") {
      throw new ProductBffError(403, "plan_not_attested", "zhixu plan is not officially attested", {
        versionId: version.versionId,
        planId: version.planId
      });
    }
    if (version.status !== "active") {
      throw new ProductBffError(409, "version_not_active", "zhixu version is not active for new drafts", {
        versionId: version.versionId,
        status: version.status
      });
    }
    assertStoreVersionHasChainAnchoredZhixu(zhixu, version);
    return {
      ...zhixu,
      chainAttestation: {
        ...zhixu.chainAttestation,
        status: "attested",
        label: "已写入链上背书",
        planId: version.planId,
        planHash: version.planHash,
        ...(version.artifactHash ? { artifactHash: version.artifactHash } : {})
      }
    };
  }
  if (zhixu.chainAttestation.status === "revoked") {
    throw new ProductBffError(409, "plan_revoked", "zhixu plan has been revoked");
  }
  if (zhixu.chainAttestation.status !== "attested") {
    throw new ProductBffError(403, "plan_not_attested", "zhixu plan is not officially attested");
  }
  return zhixu;
}

function assertStoreVersionHasChainAnchoredZhixu(
  zhixu: ZhixuDetailDTO,
  version: StoreZhixuVersionSummaryDTO
): void {
  if (zhixu.chainAttestation.status === "revoked") {
    throw new ProductBffError(409, "plan_revoked", "zhixu plan has been revoked", {
      zhixuId: zhixu.zhixuId,
      versionId: version.versionId,
      planId: zhixu.chainAttestation.planId
    });
  }
  if (zhixu.chainAttestation.status !== "attested") {
    throw new ProductBffError(403, "plan_not_attested", "zhixu plan is not officially attested", {
      zhixuId: zhixu.zhixuId,
      versionId: version.versionId,
      planId: zhixu.chainAttestation.planId
    });
  }
}

async function requireDraft(store: ProductBffStore, draftId: string): Promise<ProductOrderDraftDTO> {
  const draft = await store.getDraft(draftId);
  if (!draft) {
    throw new ProductBffError(404, "draft_not_found", "order draft not found");
  }
  return draft;
}

async function requireRoleParticipant(
  store: ProductBffStore,
  draftId: string,
  roleSlotId: string
): Promise<DraftParticipantDTO> {
  const participant = (await store.listParticipants(draftId)).find((item) => item.roleSlotId === roleSlotId);
  if (!participant) {
    throw new ProductBffError(404, "participant_not_found", "participant role not found");
  }
  return participant;
}

async function requireParticipant(store: ProductBffStore, participantId: string): Promise<DraftParticipantDTO> {
  const participant = await store.getParticipant(participantId);
  if (!participant) {
    throw new ProductBffError(404, "participant_not_found", "participant not found");
  }
  return participant;
}

async function requireInvite(store: ProductBffStore, inviteId: string): Promise<ProductInviteDTO> {
  const invite = await store.getInvite(inviteId);
  if (!invite) {
    throw new ProductBffError(404, "invite_not_found", "invite not found");
  }
  return invite;
}

async function requireAcceptableInvite(
  store: ProductBffStore,
  inviteId: string,
  now: () => Date
): Promise<ProductInviteDTO> {
  const invite = await requireInvite(store, inviteId);
  if (invite.status !== "active") {
    throw inactiveInviteError(invite);
  }
  if (isInviteExpired(invite, now())) {
    const expired: ProductInviteDTO = { ...invite, status: "expired" };
    await store.updateInvite(expired);
    throw inactiveInviteError(expired);
  }
  return invite;
}

function inactiveInviteError(invite: ProductInviteDTO): ProductBffError {
  switch (invite.status) {
    case "accepted":
      return new ProductBffError(409, "invite_already_accepted", "invite has already been accepted", {
        inviteId: invite.inviteId,
        acceptedWalletAddress: invite.acceptedWalletAddress
      });
    case "rejected":
      return new ProductBffError(409, "invite_rejected", "invite has been rejected", { inviteId: invite.inviteId });
    case "revoked":
      return new ProductBffError(410, "invite_revoked", "invite has been revoked", { inviteId: invite.inviteId });
    case "expired":
      return new ProductBffError(410, "invite_expired", "invite has expired", {
        inviteId: invite.inviteId,
        expiresAt: invite.expiresAt
      });
    case "active":
      return new ProductBffError(409, "invite_not_active", "invite is not active", { inviteId: invite.inviteId });
  }
}

function inviteWithCurrentStatus(invite: ProductInviteDTO, now: Date): ProductInviteDTO {
  return invite.status === "active" && isInviteExpired(invite, now)
    ? { ...invite, status: "expired" }
    : invite;
}

function isInviteExpired(invite: ProductInviteDTO, now: Date): boolean {
  return Date.parse(invite.expiresAt) <= now.getTime();
}

function requireValidInviteExpiry(expiresAt: string): void {
  if (Number.isNaN(Date.parse(expiresAt))) {
    throw new ProductBffError(400, "invalid_expires_at", "invite expiresAt must be a valid timestamp");
  }
}

async function inviteWalletBinding(
  store: ProductBffStore,
  invite: ProductInviteDTO,
  participant: DraftParticipantDTO,
  walletAddress: Address
): Promise<ProductInviteWalletBindingDTO> {
  const participants = await store.listParticipants(invite.draftId);
  const boundParticipant = participants.find((item) =>
    item.participantId !== participant.participantId &&
    item.status === "accepted" &&
    item.walletAddress?.toLowerCase() === walletAddress.toLowerCase()
  );
  return {
    walletAddress,
    alreadyBound: Boolean(boundParticipant),
    canAccept: !boundParticipant,
    ...(boundParticipant
      ? {
          boundParticipantId: boundParticipant.participantId,
          boundRoleSlotId: boundParticipant.roleSlotId,
          boundRoleLabel: boundParticipant.roleLabel
        }
      : {})
  };
}

function inviteAcceptance(
  invite: ProductInviteDTO,
  participant: DraftParticipantDTO,
  walletBinding: ProductInviteWalletBindingDTO | undefined
): ProductInviteAcceptanceDTO {
  if (invite.status === "expired") {
    return { canAccept: false, status: "expired" };
  }
  if (invite.status === "accepted") {
    return { canAccept: false, status: "already_accepted" };
  }
  if (invite.status === "rejected") {
    return { canAccept: false, status: "rejected" };
  }
  if (invite.status === "revoked") {
    return { canAccept: false, status: "revoked" };
  }
  if (participant.status === "accepted") {
    return { canAccept: false, status: "role_already_filled" };
  }
  if (walletBinding?.alreadyBound) {
    return { canAccept: false, status: "wallet_already_bound" };
  }
  return { canAccept: true, status: "can_accept" };
}

function inviteRolePreview(
  zhixu: ZhixuDetailDTO | undefined,
  participant: DraftParticipantDTO
): ProductInviteRolePreviewDTO {
  const roleSlot = zhixu?.roleSlots.find((slot) => slot.slotId === participant.roleSlotId);
  return {
    roleSlotId: participant.roleSlotId,
    label: roleSlot?.label ?? participant.roleLabel,
    duty: roleSlot?.duty ?? "按订单职责处理待办并提交必要业务凭证。",
    requiredEvidence: roleSlot?.evidence ?? []
  };
}

async function assertWalletCanAcceptInvite(
  store: ProductBffStore,
  invite: ProductInviteDTO,
  participant: DraftParticipantDTO,
  walletAddress: Address
): Promise<void> {
  if (participant.status === "accepted") {
    throw new ProductBffError(409, "role_already_filled", "participant role is already accepted", {
      participantId: participant.participantId,
      roleSlotId: participant.roleSlotId,
      acceptedWalletAddress: participant.walletAddress
    });
  }

  const walletBinding = await inviteWalletBinding(store, invite, participant, walletAddress);
  if (walletBinding.alreadyBound) {
    throw new ProductBffError(409, "wallet_already_bound", "wallet is already bound to another participant in this order", {
      walletAddress,
      participantId: walletBinding.boundParticipantId,
      roleSlotId: walletBinding.boundRoleSlotId
    });
  }
}

function participantPermissionsForWallet(
  permissions: readonly ParticipantPermissionDTO[],
  participant: DraftParticipantDTO,
  walletAddress: Address
): readonly ParticipantPermissionDTO[] {
  return permissions.filter((permission) =>
    permission.participantId === participant.participantId &&
    permission.submitterAddress.toLowerCase() === walletAddress.toLowerCase()
  );
}

async function requireRegistration(
  store: ProductBffStore,
  triggerId: string
): Promise<ProductOrderTriggerRecord> {
  const registration = await store.getRegistration(triggerId);
  if (!registration) {
    throw new ProductBffError(404, "trigger_not_found", "order trigger not found");
  }
  return registration;
}

async function requireRegistrationByDraft(
  store: ProductBffStore,
  draftId: string
): Promise<ProductOrderTriggerRecord> {
  const registration = await store.getRegistrationByDraft(draftId);
  if (!registration) {
    throw new ProductBffError(404, "trigger_not_found", "order draft has no prepared trigger");
  }
  return registration;
}

async function refreshDraftStatus(
  store: ProductBffStore,
  draft: ProductOrderDraftDTO,
  now: () => Date
): Promise<ProductOrderDraftDTO> {
  if (draft.status === "triggering" || draft.status === "triggered" || draft.status === "failed" || draft.status === "cancelled") {
    return draft;
  }
  const participants = await store.listParticipants(draft.draftId);
  const required = participants.filter((participant) => participant.required);
  const status: ProductOrderDraftStatus = required.length > 0 && required.every((participant) => participant.status === "accepted")
    ? "ready_to_trigger"
    : participants.some((participant) => participant.status !== "missing")
      ? "awaiting_participants"
      : "draft";
  const next = { ...draft, status, updatedAt: now().toISOString() };
  await store.updateDraft(next);
  return next;
}

function nextId(prefix: string, idScope: string, sequence: number): string {
  return `${prefix}_${idScope}_${sequence.toString().padStart(6, "0")}`;
}

function oneWeekFrom(now: Date): string {
  return new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
}

function hashHex(value: string): `0x${string}` {
  return `0x${createHash("sha256").update(value).digest("hex")}`;
}

function randomOrderId(draft: ProductOrderDraftDTO, idScope: string, sequence: number): Hex {
  return hashHex(`uvp:product-bff:order:v2:${draft.draftId}:${draft.planId}:${idScope}:${sequence}:${randomUUID()}`);
}

function assertPrepareNotExpired(registration: ProductOrderTriggerRecord, currentTime: Date): void {
  if (!isPrepareExpired(registration, currentTime)) {
    return;
  }
  throw new ProductBffError(409, "trigger_prepare_expired", "prepared trigger typed data has expired", {
    prepareId: registration.prepareId,
    deadline: registration.deadline
  });
}

function isPrepareExpired(registration: ProductOrderTriggerRecord, currentTime: Date): boolean {
  const deadlineSeconds = Number.parseInt(registration.deadline, 10);
  return !Number.isFinite(deadlineSeconds) || deadlineSeconds * 1000 <= currentTime.getTime();
}

function creatorForDraft(draft: ProductOrderDraftDTO, fallback: Address): Address {
  if (!draft.createdBy) {
    return fallback;
  }
  try {
    return normalizeAddress(draft.createdBy, "createdBy");
  } catch (error) {
    if (error instanceof ConfigError) {
      return fallback;
    }
    throw error;
  }
}

async function requireActiveStateMachineDeployment(
  productService: ProductService
): Promise<{ readonly deploymentId: string; readonly stateMachineAddress: string }> {
  const deployment = await productService.getActiveStateMachineDeployment();
  if (!deployment) {
    throw new ProductBffError(409, "state_machine_deployment_missing", "active UVPStateMachine deployment is required for trigger typed data");
  }
  return deployment;
}

function requireCreateOrderTrigger(zhixu: ZhixuDetailDTO): NonNullable<ZhixuDetailDTO["createOrderTrigger"]> {
  if (!zhixu.createOrderTrigger) {
    throw new ProductBffError(409, "create_order_trigger_missing", "zhixu Product schema must declare createOrderTrigger");
  }
  return zhixu.createOrderTrigger;
}

function requireTriggerSubmitter(
  draft: ProductOrderDraftDTO,
  participants: readonly DraftParticipantDTO[],
  walletAddress: string,
  creator: Address
): Address {
  const submitter = normalizeAddress(walletAddress, "walletAddress");
  if (submitter === creator) {
    return submitter;
  }
  const participant = participants.find((item) =>
    item.status === "accepted" &&
    item.walletAddress &&
    normalizeAddress(item.walletAddress, "participant.walletAddress") === submitter
  );
  if (participant) {
    return submitter;
  }
  throw new ProductBffError(403, "trigger_submitter_not_authorized", "trigger submitter must be the draft creator or an accepted participant", {
    draftId: draft.draftId,
    walletAddress: submitter
  });
}

async function recoverTriggerSigner(typedData: unknown, signature: string): Promise<Address> {
  try {
    return await recoverTriggerOrderFromOutsideSigner(typedData as TriggerOrderFromOutsideTypedData, signature);
  } catch (error) {
    throw new ProductBffError(400, "invalid_trigger_signature", error instanceof Error ? error.message : "invalid trigger signature");
  }
}

function normalizeHexSignature(signature: string): Hex {
  if (!/^0x[0-9a-fA-F]+$/.test(signature)) {
    throw new ProductBffError(400, "invalid_trigger_signature", "signature must be a hex string");
  }
  return signature.toLowerCase() as Hex;
}

function requireAcceptedRequiredParticipants(participants: readonly DraftParticipantDTO[]): void {
  const missing = participants.filter((participant) =>
    participant.required && (participant.status !== "accepted" || !participant.walletAddress)
  );
  if (missing.length > 0) {
    throw new ProductBffError(409, "required_participant_missing", "all required participants must accept before submit", {
      roleSlotIds: missing.map((participant) => participant.roleSlotId)
    });
  }

  for (const participant of participants) {
    if (participant.status !== "accepted" || !participant.walletAddress) {
      continue;
    }
    try {
      normalizeAddress(participant.walletAddress, "walletAddress");
    } catch (error) {
      if (error instanceof ConfigError) {
        throw new ProductBffError(400, "invalid_wallet", "participant walletAddress must be a valid EVM address", {
          participantId: participant.participantId,
          roleSlotId: participant.roleSlotId
        });
      }
      throw error;
    }
  }
}

async function rejectRevokedSupplierParticipants(
  participants: readonly DraftParticipantDTO[],
  supplierTrustResolver: ProductBffSupplierTrustResolver | undefined
): Promise<void> {
  if (!supplierTrustResolver) {
    return;
  }

  for (const participant of participants) {
    if (participant.status !== "accepted" || !participant.walletAddress) {
      continue;
    }
    const wallet = normalizeAddress(participant.walletAddress, "walletAddress");
    const supplierTrust = await supplierTrustResolver(wallet);
    if (!supplierTrust?.revoked) {
      continue;
    }
    throw new ProductBffError(
      409,
      "supplier_revoked_for_future_authorization",
      "revoked supplier wallets cannot be used for new order signal authorization",
      {
        participantId: participant.participantId,
        roleSlotId: participant.roleSlotId,
        walletAddress: wallet,
        supplierSubjectId: supplierTrust.supplierSubjectId,
        registryAddress: supplierTrust.registryAddress,
        updatedAtBlock: supplierTrust.updatedAt.blockNumber.toString()
      }
    );
  }
}

function assertDraftUsesActiveZhixuVersion(draft: ProductOrderDraftDTO, zhixu: ZhixuDetailDTO): void {
  const activePlanId = normalizeBytes32(zhixu.chainAttestation.planId, "planId");
  const activePlanHash = normalizeBytes32(zhixu.chainAttestation.planHash, "planHash");
  if (draft.planId === activePlanId && draft.planHash === activePlanHash) {
    return;
  }
  throw new ProductBffError(409, "version_not_active", "order draft plan is no longer active for new registration", {
    draftId: draft.draftId,
    draftPlanId: draft.planId,
    activePlanId
  });
}

function buildAuthorizations<T>(build: () => T): T {
  try {
    return build();
  } catch (error) {
    if (error instanceof ProductAuthorizationBuilderError) {
      throw new ProductBffError(error.status, error.code, error.message, error.details);
    }
    throw error;
  }
}

async function withProductStoreTransaction<T>(
  store: ProductBffStore,
  operation: () => Promise<T>
): Promise<T> {
  return store.withTransaction ? store.withTransaction(operation) : operation();
}

async function broadcastOutsideTrigger(input: {
  readonly triggerAdapter: ProductOrderTriggerBroadcastAdapter;
  readonly store: ProductBffStore;
  readonly draft: ProductOrderDraftDTO;
  readonly registration: ProductOrderTriggerRecord;
  readonly now: () => Date;
}): Promise<{ readonly draft: ProductOrderDraftDTO; readonly registration: ProductOrderTriggerRecord }> {
  const broadcast = await safeBroadcastOutsideTrigger(input.triggerAdapter, input.registration);
  const updatedAt = input.now().toISOString();
  const registration: ProductOrderTriggerRecord = {
    ...input.registration,
    status: broadcast.status,
    ...(broadcast.txHash ? { txHash: broadcast.txHash } : {}),
    ...(broadcast.blockNumber ? { blockNumber: broadcast.blockNumber } : {}),
    ...(broadcast.errorCode ? { errorCode: broadcast.errorCode } : {}),
    ...(broadcast.errorMessage ? { errorMessage: broadcast.errorMessage } : {}),
    retryable: broadcast.retryable,
    updatedAt
  };
  const draft = draftFromTriggerBroadcast(input.draft, registration, updatedAt);
  await withProductStoreTransaction(input.store, async () => {
    await input.store.updateRegistration(registration);
    await input.store.updateDraft(draft);
  });
  if (registration.status === "failed") {
    throw new ProductBffError(
      502,
      registration.errorCode ?? "trigger_order_failed",
      registration.errorMessage ?? "trigger order transaction failed",
      submitResultFromRegistration(draft, await input.store.listParticipants(draft.draftId), registration)
    );
  }
  return { draft, registration };
}

async function safeBroadcastOutsideTrigger(
  triggerAdapter: ProductOrderTriggerBroadcastAdapter,
  registration: ProductOrderTriggerRecord
): Promise<ProductOrderTriggerBroadcastResult> {
  try {
    if (!registration.signature) {
      throw new ProductBffError(400, "trigger_signature_missing", "business wallet signature is required");
    }
    if (
      !registration.submitter ||
      !registration.sourceId ||
      !registration.signalId ||
      !registration.triggerHookId ||
      !registration.triggerStageId ||
      !registration.payloadHash ||
      !registration.idempotencyKey ||
      !registration.deadline
    ) {
      throw new ProductBffError(409, "trigger_record_incomplete", "prepared trigger record is incomplete");
    }
    return await triggerAdapter.broadcastOutsideTrigger({
      triggerId: registration.triggerId,
      draftId: registration.draftId,
      orderId: registration.orderId,
      planId: registration.planId,
      creator: registration.creator,
      triggerHookId: registration.triggerHookId,
      triggerStageId: registration.triggerStageId,
      sourceId: registration.sourceId,
      signalId: registration.signalId,
      payloadHash: registration.payloadHash,
      idempotencyKey: registration.idempotencyKey,
      submitter: registration.submitter,
      deadline: registration.deadline,
      signature: registration.signature,
      ...(registration.stateMachineAddress ? { stateMachineAddress: registration.stateMachineAddress } : {}),
      ...(registration.deploymentId ? { deploymentId: registration.deploymentId } : {}),
      authorizations: registration.authorizations
    });
  } catch (error) {
    return {
      status: "failed",
      errorCode: error instanceof ProductBffError ? error.code : "trigger_order_adapter_failed",
      errorMessage: error instanceof Error ? error.message : "trigger order adapter failed",
      retryable: true
    };
  }
}

function draftFromTriggerBroadcast(
  draft: ProductOrderDraftDTO,
  registration: ProductOrderTriggerRecord,
  updatedAt: string
): ProductOrderDraftDTO {
  if (registration.status === "confirmed") {
    return {
      ...draft,
      status: "triggered",
      triggeredOrderId: registration.orderId,
      ...(registration.txHash ? { triggerTxHash: registration.txHash } : {}),
      updatedAt
    };
  }
  if (registration.status === "failed") {
    return {
      ...draft,
      status: "failed",
      updatedAt
    };
  }
  return {
    ...draft,
    status: "triggering",
    updatedAt
  };
}

function prepareResultFromRegistration(
  draft: ProductOrderDraftDTO,
  participants: readonly DraftParticipantDTO[],
  registration: ProductOrderTriggerRecord
): PrepareProductOrderTriggerResult {
  return {
    draft,
    participants,
    permissions: registration.permissions,
    trigger: registrationDtoFromRecord(registration),
    prepared: preparedTriggerFromRegistration(registration, draft)
  };
}

function preparedTriggerFromRegistration(
  registration: ProductOrderTriggerRecord,
  draft: ProductOrderDraftDTO
): PreparedProductOrderTriggerDTO {
  if (
    !registration.prepareId ||
    !registration.submitter ||
    !registration.sourceId ||
    !registration.signalId ||
    !registration.triggerHookId ||
    !registration.triggerStageId ||
    !registration.deadline ||
    !registration.typedData
  ) {
    throw new ProductBffError(409, "trigger_record_incomplete", "prepared trigger record is incomplete");
  }
  return {
    prepareId: registration.prepareId,
    triggerId: registration.triggerId,
    draftId: registration.draftId,
    orderId: registration.orderId,
    expiresAt: new Date(Number.parseInt(registration.deadline, 10) * 1000).toISOString(),
    submitter: registration.submitter,
    typedData: registration.typedData,
    summary: {
      orderTitle: draft.title,
      planId: registration.planId,
      sourceId: registration.sourceId,
      signalId: registration.signalId,
      triggerHookId: registration.triggerHookId,
      triggerStageId: registration.triggerStageId,
      walletAddress: registration.submitter
    }
  };
}

function submitResultFromRegistration(
  draft: ProductOrderDraftDTO,
  participants: readonly DraftParticipantDTO[],
  registration: ProductOrderTriggerRecord
): SubmitProductOrderDraftResult {
  return {
    draft,
    participants,
    permissions: registration.permissions,
    trigger: registrationDtoFromRecord(registration)
  };
}

function registrationDtoFromRecord(registration: ProductOrderTriggerRecord): ProductOrderTriggerDTO {
  const {
    creator: _creator,
    payloadHash: _payloadHash,
    idempotencyKey: _idempotencyKey,
    deadline: _deadline,
    typedData: _typedData,
    signature: _signature,
    authorizations: _authorizations,
    permissions: _permissions,
    ...dto
  } = registration;
  return {
    ...defaultRegistrationReconcileFields(registration),
    ...dto
  };
}

function defaultRegistrationReconcileFields(registration: ProductOrderTriggerRecord): TxReconcileFields {
  if (registration.reconcileStatus || registration.receiptStatus || registration.projectionStatus) {
    return {};
  }
  if (registration.status === "confirmed") {
    return {
      reconcileStatus: "confirmed",
      receiptStatus: registration.txHash ? "success" : "not_checked",
      projectionStatus: "present"
    };
  }
  if (registration.status === "failed") {
    return {
      reconcileStatus: "failed",
      receiptStatus: registration.txHash ? "failed" : "not_checked",
      projectionStatus: "not_checked"
    };
  }
  if (registration.status === "indexing") {
    return {
      reconcileStatus: "indexing",
      receiptStatus: "success",
      projectionStatus: "missing"
    };
  }
  if (registration.status === "prepared" || registration.status === "expired") {
    return {
      receiptStatus: "not_checked",
      projectionStatus: "not_checked"
    };
  }
  return {
    reconcileStatus: registration.txHash ? "submitted" : "broadcasting",
    receiptStatus: "not_checked",
    projectionStatus: "not_checked"
  };
}
