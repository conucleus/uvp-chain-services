import { createHash, randomUUID } from "node:crypto";
import {
  ORDER_INITIAL_TRIGGER_PERMISSION_ID,
  type StoreZhixuVersionSummaryDTO,
  type ZhixuDetailDTO
} from "@uvp-eth/product-dto";
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
  MemoryProductOrderTriggerAdapter,
  MemoryProductOrderRegistrationAdapter,
  productSignalId,
  productSignalSourceId,
  type ProductOrderRegistrationAdapter,
  type ProductOrderTriggerAdapter,
  type ProductOrderTriggerResult,
  type ProductRegistrationAdapterResult
} from "./registration.js";
import { MemoryProductBffStore, type ProductBffStore, type ProductOrderStartPatch } from "./store.js";
import type {
  AcceptProductInviteInput,
  CreateProductInviteInput,
  CreateProductOrderDraftInput,
  DraftParticipantDTO,
  ParticipantPermissionDTO,
  PreviewProductInviteInput,
  ProductInviteAcceptanceDTO,
  ProductInviteDTO,
  ProductInvitePreviewResponse,
  ProductInviteRolePreviewDTO,
  ProductInviteWalletBindingDTO,
  ProductOrderDraftDTO,
  ProductOrderDraftStatus,
  ProductOrderRegistrationDTO,
  ProductOrderRegistrationRecord,
  ProductOrderStartDTO,
  ProductParticipantAssignmentDTO,
  RejectProductInviteInput,
  StartProductOrderRegistrationResult,
  SubmitProductOrderDraftResult,
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
  readonly registrationAdapter?: ProductOrderRegistrationAdapter;
  readonly triggerAdapter?: ProductOrderTriggerAdapter;
  readonly authorizationBuilder?: ProductAuthorizationBuilder;
  readonly supplierTrustResolver?: ProductBffSupplierTrustResolver;
  readonly versionResolver?: ProductDraftVersionResolver;
  readonly registrationCreatorAddress?: Address;
  readonly registrarAddress?: Address;
  readonly now?: () => Date;
}

export type ProductBffSupplierTrust = Pick<
  SupplierTrustProjection,
  "domainId" | "supplierSubjectId" | "wallet" | "status" | "revoked" | "updatedAt"
>;

export type ProductBffSupplierTrustResolver = (wallet: Address) => Promise<ProductBffSupplierTrust | undefined>;

export interface ProductDraftVersionResolver {
  resolveActiveVersion(zhixuId: string): Promise<StoreZhixuVersionSummaryDTO | undefined>;
}

export interface ProductBffService {
  createDraft(input: CreateProductOrderDraftInput): Promise<DraftWithParticipants>;
  getDraft(draftId: string): Promise<DraftWithParticipants>;
  updateDraft(draftId: string, input: UpdateProductOrderDraftInput): Promise<ProductOrderDraftDTO>;
  submitDraft(draftId: string): Promise<SubmitProductOrderDraftResult>;
  getRegistration(registrationId: string): Promise<ProductOrderRegistrationDTO>;
  retryRegistration(registrationId: string): Promise<SubmitProductOrderDraftResult>;
  startRegistration(registrationId: string): Promise<StartProductOrderRegistrationResult>;
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
  const registrationAdapter = options.registrationAdapter ?? new MemoryProductOrderRegistrationAdapter();
  const authorizationBuilder = options.authorizationBuilder ?? new ProductAuthorizationBuilder();
  const registrarAddress = normalizeAddress(
    options.registrarAddress ?? options.triggerAdapter?.registrarAddress ?? registrationAdapter.registrarAddress ?? DEFAULT_PRODUCT_REGISTRAR_ADDRESS,
    "registrarAddress"
  );
  const triggerAdapter = options.triggerAdapter ??
    matchingTriggerAdapterFromRegistrationAdapter(registrationAdapter, registrarAddress) ??
    new MemoryProductOrderTriggerAdapter({ registrarAddress });
  const registrationCreatorAddress = options.registrationCreatorAddress
    ? normalizeAddress(options.registrationCreatorAddress, "registrationCreatorAddress")
    : undefined;
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

    async submitDraft(draftId) {
      const draft = await requireDraft(store, draftId);
      const participants = await store.listParticipants(draftId);
      const existingRegistration = await store.getRegistrationByDraft(draftId);
      if (existingRegistration) {
        return submitResultFromRegistration(draft, participants, existingRegistration);
      }

      requireAcceptedRequiredParticipants(participants);
      if (draft.status !== "ready_to_register") {
        throw new ProductBffError(409, "draft_not_ready", "order draft is not ready to register", {
          status: draft.status
        });
      }

      const zhixu = await requireActiveZhixu(options.productService, draft.zhixuId, options.versionResolver);
      assertDraftUsesActiveZhixuVersion(draft, zhixu);
      const activeDeployment = await options.productService.getActiveStateMachineDeployment();
      const orderId = stableOrderId(draft);
      const creator = creatorForDraft(draft, registrationCreatorAddress ?? registrarAddress);
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
      const createdAt = now().toISOString();
      const registration: ProductOrderRegistrationRecord = {
        registrationId: nextId("registration", idScope, sequence++),
        draftId,
        orderId,
        ...(activeDeployment ? {
          stateMachineAddress: normalizeAddress(activeDeployment.stateMachineAddress, "activeStateMachineAddress"),
          deploymentId: normalizeBytes32(activeDeployment.deploymentId, "activeDeploymentId")
        } : {}),
        planId: draft.planId,
        planHash: draft.planHash,
        status: "pending",
        retryable: false,
        createdAt,
        updatedAt: createdAt,
        creator,
        authorizations: builtAuthorization.authorizations,
        permissions: builtAuthorization.permissions
      };
      const registering: ProductOrderDraftDTO = {
        ...draft,
        status: "registering",
        updatedAt: createdAt
      };
      await withProductStoreTransaction(store, async () => {
        await store.createRegistration(registration);
        await store.updateDraft(registering);
      });
      const broadcasted = await broadcastRegistration({
        registrationAdapter,
        store,
        draft: registering,
        registration,
        now
      });
      return submitResultFromRegistration(broadcasted.draft, participants, broadcasted.registration);
    },

    async getRegistration(registrationId) {
      return registrationDtoFromRecord(await requireRegistration(store, registrationId));
    },

    async retryRegistration(registrationId) {
      const current = await requireRegistration(store, registrationId);
      if (current.status !== "failed" || !current.retryable) {
        throw new ProductBffError(409, "registration_not_retryable", "registration is not retryable", {
          status: current.status,
          retryable: current.retryable
        });
      }
      const draft = await requireDraft(store, current.draftId);
      const participants = await store.listParticipants(current.draftId);
      requireAcceptedRequiredParticipants(participants);
      const zhixu = await requireActiveZhixu(options.productService, draft.zhixuId, options.versionResolver);
      assertDraftUsesActiveZhixuVersion(draft, zhixu);
      await rejectRevokedSupplierParticipants(participants, options.supplierTrustResolver);

      const updatedAt = now().toISOString();
      const pending: ProductOrderRegistrationRecord = {
        registrationId: current.registrationId,
        draftId: current.draftId,
        orderId: current.orderId,
        planId: current.planId,
        planHash: current.planHash,
        ...(current.stateMachineAddress ? { stateMachineAddress: current.stateMachineAddress } : {}),
        ...(current.deploymentId ? { deploymentId: current.deploymentId } : {}),
        status: "pending",
        retryable: false,
        createdAt: current.createdAt,
        updatedAt,
        creator: current.creator,
        authorizations: current.authorizations,
        permissions: current.permissions
      };
      const registering: ProductOrderDraftDTO = {
        ...draft,
        status: "registering",
        updatedAt
      };
      await withProductStoreTransaction(store, async () => {
        await store.updateRegistration(pending);
        await store.updateDraft(registering);
      });
      const broadcasted = await broadcastRegistration({
        registrationAdapter,
        store,
        draft: registering,
        registration: pending,
        now
      });
      return submitResultFromRegistration(broadcasted.draft, participants, broadcasted.registration);
    },

    async startRegistration(registrationId) {
      const registration = await requireRegistration(store, registrationId);
      if (registration.status !== "confirmed") {
        throw new ProductBffError(409, "registration_not_confirmed", "order registration must be confirmed before start", {
          status: registration.status
        });
      }
      if (!registration.orderId) {
        throw new ProductBffError(409, "order_id_missing", "order registration has no orderId");
      }

      const existing = await store.getOrderStartByRegistrationId(registrationId);
      if (existing) {
        if (existing.status !== "failed") {
          return {
            registration: registrationDtoFromRecord(registration),
            start: startDtoFromRecord(existing)
          };
        }
        if (!existing.retryable) {
          throw new ProductBffError(409, "start_not_retryable", "order start is not retryable", {
            status: existing.status,
            retryable: existing.retryable
          });
        }
        const retried = await broadcastOrderStart({
          triggerAdapter,
          store,
          start: existing,
          registration,
          now
        });
        return startResultOrThrow(registration, retried);
      }

      const createdAt = now().toISOString();
      const start: ProductOrderStartDTO = {
        startId: nextId("start", idScope, sequence++),
        registrationId,
        draftId: registration.draftId,
        orderId: registration.orderId,
        ...(registration.stateMachineAddress ? { stateMachineAddress: registration.stateMachineAddress } : {}),
        ...(registration.deploymentId ? { deploymentId: registration.deploymentId } : {}),
        status: "pending",
        retryable: false,
        createdAt,
        updatedAt: createdAt
      };
      await store.createOrderStart(start);
      const broadcasted = await broadcastOrderStart({
        triggerAdapter,
        store,
        start,
        registration,
        now
      });
      return startResultOrThrow(registration, broadcasted);
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
          ...(registration ? { registration: registrationDtoFromRecord(registration) } : {}),
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
  registrationId: string
): Promise<ProductOrderRegistrationRecord> {
  const registration = await store.getRegistration(registrationId);
  if (!registration) {
    throw new ProductBffError(404, "registration_not_found", "order registration not found");
  }
  return registration;
}

async function refreshDraftStatus(
  store: ProductBffStore,
  draft: ProductOrderDraftDTO,
  now: () => Date
): Promise<ProductOrderDraftDTO> {
  if (draft.status === "registered" || draft.status === "cancelled") {
    return draft;
  }
  const participants = await store.listParticipants(draft.draftId);
  const required = participants.filter((participant) => participant.required);
  const status: ProductOrderDraftStatus = required.length > 0 && required.every((participant) => participant.status === "accepted")
    ? "ready_to_register"
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

function stableOrderId(draft: ProductOrderDraftDTO): Hex {
  return hashHex(`uvp:product-bff:order:v1:${draft.draftId}:${draft.planId}`);
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
        domainId: supplierTrust.domainId,
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

async function broadcastRegistration(input: {
  readonly registrationAdapter: ProductOrderRegistrationAdapter;
  readonly store: ProductBffStore;
  readonly draft: ProductOrderDraftDTO;
  readonly registration: ProductOrderRegistrationRecord;
  readonly now: () => Date;
}): Promise<{ readonly draft: ProductOrderDraftDTO; readonly registration: ProductOrderRegistrationRecord }> {
  const broadcast = await safeRegisterOrder(input.registrationAdapter, input.registration);
  const updatedAt = input.now().toISOString();
  const registration: ProductOrderRegistrationRecord = {
    registrationId: input.registration.registrationId,
    draftId: input.registration.draftId,
    orderId: input.registration.orderId,
    ...(input.registration.stateMachineAddress ? { stateMachineAddress: input.registration.stateMachineAddress } : {}),
    ...(input.registration.deploymentId ? { deploymentId: input.registration.deploymentId } : {}),
    planId: input.registration.planId,
    planHash: input.registration.planHash,
    status: broadcast.status,
    ...(broadcast.txHash ? { txHash: broadcast.txHash } : {}),
    ...(broadcast.blockNumber ? { blockNumber: broadcast.blockNumber } : {}),
    ...(broadcast.errorCode ? { errorCode: broadcast.errorCode } : {}),
    ...(broadcast.errorMessage ? { errorMessage: broadcast.errorMessage } : {}),
    retryable: broadcast.retryable,
    createdAt: input.registration.createdAt,
    updatedAt,
    creator: input.registration.creator,
    authorizations: input.registration.authorizations,
    permissions: input.registration.permissions
  };
  const draft = draftFromRegistration(input.draft, registration, updatedAt);
  await withProductStoreTransaction(input.store, async () => {
    await input.store.updateRegistration(registration);
    await input.store.updateDraft(draft);
  });
  return { draft, registration };
}

async function broadcastOrderStart(input: {
  readonly triggerAdapter: ProductOrderTriggerAdapter;
  readonly store: ProductBffStore;
  readonly start: ProductOrderStartDTO;
  readonly registration: ProductOrderRegistrationRecord;
  readonly now: () => Date;
}): Promise<ProductOrderStartDTO> {
  const pending = pendingOrderStart(input.start, input.now().toISOString());
  if (input.start.status !== "pending" || input.start.retryable || input.start.txHash || input.start.errorCode) {
    await input.store.updateOrderStart(pending.startId, orderStartPatchFromRecord(pending));
  }

  const broadcast = await safeSubmitInitialTrigger(input.triggerAdapter, pending, input.registration);
  const updatedAt = input.now().toISOString();
  const start = orderStartFromTriggerResult(pending, broadcast, updatedAt);
  return await input.store.updateOrderStart(start.startId, orderStartPatchFromRecord(start)) ?? start;
}

async function withProductStoreTransaction<T>(
  store: ProductBffStore,
  operation: () => Promise<T>
): Promise<T> {
  return store.withTransaction ? store.withTransaction(operation) : operation();
}

async function safeRegisterOrder(
  registrationAdapter: ProductOrderRegistrationAdapter,
  registration: ProductOrderRegistrationRecord
): Promise<ProductRegistrationAdapterResult> {
  try {
    return await registrationAdapter.registerOrder({
      registrationId: registration.registrationId,
      draftId: registration.draftId,
      orderId: registration.orderId,
      ...(registration.stateMachineAddress ? { stateMachineAddress: registration.stateMachineAddress } : {}),
      ...(registration.deploymentId ? { deploymentId: registration.deploymentId } : {}),
      planId: registration.planId,
      creator: registration.creator,
      authorizations: registration.authorizations
    });
  } catch (error) {
    return {
      status: "failed",
      errorCode: "register_order_adapter_failed",
      errorMessage: error instanceof Error ? error.message : "registerOrder adapter failed",
      retryable: true
    };
  }
}

async function safeSubmitInitialTrigger(
  triggerAdapter: ProductOrderTriggerAdapter,
  start: ProductOrderStartDTO,
  registration: ProductOrderRegistrationRecord
): Promise<ProductOrderTriggerResult> {
  try {
    const signal = initialTriggerSignalForRegistration(registration);
    return await triggerAdapter.submitInitialTrigger({
      startId: start.startId,
      registrationId: start.registrationId,
      orderId: start.orderId,
      sourceId: signal.sourceId,
      signalId: signal.signalId,
      ...(start.stateMachineAddress ? { stateMachineAddress: start.stateMachineAddress } : {}),
      ...(start.deploymentId ? { deploymentId: start.deploymentId } : {}),
      ...(registration.txHash ? { registrationTxHash: registration.txHash } : {}),
      ...(registration.blockNumber ? { registrationBlockNumber: registration.blockNumber } : {}),
      payloadHash: initialTriggerPayloadHash(start),
      idempotencyKey: initialTriggerIdempotencyKey(start)
    });
  } catch (error) {
    return {
      status: "failed",
      errorCode: "submit_initial_trigger_adapter_failed",
      errorMessage: error instanceof Error ? error.message : "submitInitialTrigger adapter failed",
      retryable: true
    };
  }
}

function initialTriggerSignalForRegistration(
  registration: ProductOrderRegistrationRecord
): { readonly sourceId: Hex; readonly signalId: Hex } {
  const permission = registration.permissions.find((item) => item.permissionId === ORDER_INITIAL_TRIGGER_PERMISSION_ID);
  if (!permission) {
    throw new Error(`registration ${registration.registrationId} is missing ${ORDER_INITIAL_TRIGGER_PERMISSION_ID}`);
  }
  return {
    sourceId: productSignalSourceId(permission.source),
    signalId: productSignalId(permission.signalName)
  };
}

function draftFromRegistration(
  draft: ProductOrderDraftDTO,
  registration: ProductOrderRegistrationRecord,
  updatedAt: string
): ProductOrderDraftDTO {
  if (registration.status === "confirmed") {
    return {
      ...draft,
      status: "registered",
      registeredOrderId: registration.orderId,
      ...(registration.txHash ? { registrationTxHash: registration.txHash } : {}),
      updatedAt
    };
  }

  return {
    ...draft,
    status: registration.status === "failed" && registration.retryable ? "ready_to_register" : "registering",
    updatedAt
  };
}

function submitResultFromRegistration(
  draft: ProductOrderDraftDTO,
  participants: readonly DraftParticipantDTO[],
  registration: ProductOrderRegistrationRecord
): SubmitProductOrderDraftResult {
  return {
    draft,
    participants,
    permissions: registration.permissions,
    registration: registrationDtoFromRecord(registration)
  };
}

function startResultOrThrow(
  registration: ProductOrderRegistrationRecord,
  start: ProductOrderStartDTO
): StartProductOrderRegistrationResult {
  const result = {
    registration: registrationDtoFromRecord(registration),
    start: startDtoFromRecord(start)
  };
  if (start.status === "failed") {
    throw new ProductBffError(
      502,
      start.errorCode ?? "order_start_failed",
      start.errorMessage ?? "order start transaction failed",
      result
    );
  }
  return result;
}

function registrationDtoFromRecord(registration: ProductOrderRegistrationRecord): ProductOrderRegistrationDTO {
  const {
    creator: _creator,
    authorizations: _authorizations,
    permissions: _permissions,
    ...dto
  } = registration;
  return {
    ...defaultRegistrationReconcileFields(registration),
    ...dto
  };
}

function startDtoFromRecord(start: ProductOrderStartDTO): ProductOrderStartDTO {
  return {
    ...defaultStartReconcileFields(start),
    ...start
  };
}

function defaultRegistrationReconcileFields(registration: ProductOrderRegistrationRecord): TxReconcileFields {
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
  return {
    reconcileStatus: registration.txHash ? "submitted" : "broadcasting",
    receiptStatus: "not_checked",
    projectionStatus: "not_checked"
  };
}

function defaultStartReconcileFields(start: ProductOrderStartDTO): TxReconcileFields {
  if (start.reconcileStatus || start.receiptStatus || start.projectionStatus) {
    return {};
  }
  if (start.status === "confirmed") {
    return {
      reconcileStatus: "confirmed",
      receiptStatus: start.txHash ? "success" : "not_checked",
      projectionStatus: "present"
    };
  }
  if (start.status === "failed") {
    return {
      reconcileStatus: "failed",
      receiptStatus: start.txHash ? "failed" : "not_checked",
      projectionStatus: "not_checked"
    };
  }
  if (start.status === "indexing") {
    return {
      reconcileStatus: "indexing",
      receiptStatus: "success",
      projectionStatus: "missing"
    };
  }
  return {
    reconcileStatus: start.txHash ? "submitted" : "broadcasting",
    receiptStatus: "not_checked",
    projectionStatus: "not_checked"
  };
}

function pendingOrderStart(start: ProductOrderStartDTO, updatedAt: string): ProductOrderStartDTO {
  return {
    startId: start.startId,
    registrationId: start.registrationId,
    draftId: start.draftId,
    orderId: start.orderId,
    ...(start.stateMachineAddress ? { stateMachineAddress: start.stateMachineAddress } : {}),
    ...(start.deploymentId ? { deploymentId: start.deploymentId } : {}),
    status: "pending",
    retryable: false,
    createdAt: start.createdAt,
    updatedAt
  };
}

function orderStartFromTriggerResult(
  start: ProductOrderStartDTO,
  result: ProductOrderTriggerResult,
  updatedAt: string
): ProductOrderStartDTO {
  return {
    startId: start.startId,
    registrationId: start.registrationId,
    draftId: start.draftId,
    orderId: start.orderId,
    ...(start.stateMachineAddress ? { stateMachineAddress: start.stateMachineAddress } : {}),
    ...(start.deploymentId ? { deploymentId: start.deploymentId } : {}),
    status: result.status,
    ...(result.txHash ? { txHash: result.txHash } : {}),
    ...(result.blockNumber ? { blockNumber: result.blockNumber } : {}),
    ...(result.errorCode ? { errorCode: result.errorCode } : {}),
    ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
    retryable: result.retryable,
    createdAt: start.createdAt,
    updatedAt
  };
}

function orderStartPatchFromRecord(start: ProductOrderStartDTO): ProductOrderStartPatch {
  return {
    status: start.status,
    txHash: start.txHash ?? null,
    blockNumber: start.blockNumber ?? null,
    errorCode: start.errorCode ?? null,
    errorMessage: start.errorMessage ?? null,
    retryable: start.retryable,
    reconcileStatus: start.reconcileStatus ?? null,
    lastCheckedAt: start.lastCheckedAt ?? null,
    receiptStatus: start.receiptStatus ?? null,
    projectionStatus: start.projectionStatus ?? null,
    updatedAt: start.updatedAt
  };
}

function initialTriggerPayloadHash(start: ProductOrderStartDTO): Hex {
  return hashHex(`uvp:product-bff:start:payload:v1:${start.registrationId}:${start.orderId}`);
}

function initialTriggerIdempotencyKey(start: ProductOrderStartDTO): Hex {
  return hashHex(`uvp:product-bff:start:idempotency:v1:${start.registrationId}:${start.orderId}`);
}

function matchingTriggerAdapterFromRegistrationAdapter(
  registrationAdapter: ProductOrderRegistrationAdapter,
  registrarAddress: Address
): ProductOrderTriggerAdapter | undefined {
  if (
    "submitInitialTrigger" in registrationAdapter &&
    typeof registrationAdapter.submitInitialTrigger === "function"
  ) {
    const triggerAdapter = registrationAdapter as ProductOrderRegistrationAdapter & ProductOrderTriggerAdapter;
    if (!triggerAdapter.registrarAddress || triggerAdapter.registrarAddress === registrarAddress) {
      return triggerAdapter;
    }
  }
  return undefined;
}
