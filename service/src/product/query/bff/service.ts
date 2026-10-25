import { createHash, randomBytes, randomUUID } from "node:crypto";
import { onchainStageId } from "@uvp-eth/compiler";
import {
  type StoreZhixuVersionSummaryDTO,
  type ZhixuDetailDTO,
} from "@uvp-eth/product-dto";
import {
  buildTriggerOrderFromOutsideTypedData,
  deriveTriggerOrderId,
  recoverTriggerOrderFromOutsideSigner,
  type TriggerOrderFromOutsideTypedData,
} from "@uvp-eth/protocol-bindings";
import {
  ConfigError,
  normalizeAddress,
  normalizeBytes32,
  type Address,
  type Hex,
} from "../../../shared/types.js";
import type { TxReconcileFields } from "../../../reconcile/status.js";
import { isReopenableFailedTriggerRecord } from "../../../reconcile/status.js";
import type { ProductService } from "../../application/service.js";
import { redactErrorMessage } from "../../../security/redaction.js";
import { StorageConstraintError } from "../../../storage/errors.js";
import {
  DEFAULT_PRODUCT_REGISTRAR_ADDRESS,
  MemoryProductOrderTriggerBroadcastAdapter,
  productSignalId,
  productSignalSourceId,
  type ProductOrderTriggerBroadcastAdapter,
  type ProductOrderTriggerBroadcastResult,
} from "./trigger.js";
import type { ProductBffStore } from "./store.js";
import {
  factAttributionPayload,
  type PlanCapabilityTables,
} from "../../../submissions/capability-proofs.js";
import type {
  AcceptProductInviteInput,
  CreateProductInviteInput,
  CreateProductOrderDraftInput,
  DraftParticipantDTO,
  ParticipantPermissionDTO,
  PreviewProductInviteInput,
  ProductInviteAcceptanceDTO,
  ProductInviteDTO,
  ProductInvitePreviewDraftDTO,
  ProductInvitePreviewParticipantDTO,
  ProductInvitePreviewResponse,
  ProductInviteRolePreviewDTO,
  ProductInviteWalletBindingDTO,
  ProductOrderDraftDTO,
  ProductOrderDraftStatus,
  ProductOrderTriggerDTO,
  ProductOrderTriggerRecord,
  ProductParticipantAssignmentDTO,
  RejectProductInviteInput,
  UpdateProductOrderDraftInput,
} from "./types.js";

export class ProductBffError extends Error {
  override readonly name = "ProductBffError";

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export interface ProductBffServiceOptions {
  readonly productService: ProductService;
  readonly store: ProductBffStore;
  readonly versionResolver?: ProductDraftVersionResolver;
  readonly resolvePlanCapabilityTables?: (
    planId: Hex
  ) => Promise<PlanCapabilityTables | undefined>;
  readonly now?: () => Date;
}

export interface ProductDraftVersionResolver {
  resolveActiveVersion(
    zhixuId: string,
  ): Promise<StoreZhixuVersionSummaryDTO | undefined>;
}

export interface ProductBffService {
  createDraft(
    input: CreateProductOrderDraftInput,
  ): Promise<DraftWithParticipants>;
  getDraft(
    draftId: string,
    readerWallet: Address,
  ): Promise<DraftWithParticipants>;
  updateDraft(
    draftId: string,
    input: UpdateProductOrderDraftInput,
    actorWallet: Address,
  ): Promise<ProductOrderDraftDTO>;
  createInvite(
    draftId: string,
    input: CreateProductInviteInput,
    actorWallet: Address,
  ): Promise<InviteWithDraft>;
  getInvite(
    inviteId: string,
    input?: PreviewProductInviteInput,
  ): Promise<ProductInvitePreviewResponse>;
  acceptInvite(
    inviteId: string,
    input: AcceptProductInviteInput,
  ): Promise<InviteWithDraft>;
  rejectInvite(
    inviteId: string,
    input: RejectProductInviteInput,
  ): Promise<InviteWithDraft>;
  listParticipants(
    draftId: string,
    readerWallet: Address,
  ): Promise<readonly DraftParticipantDTO[]>;
  listParticipantAssignments(
    walletAddress: string,
  ): Promise<readonly ProductParticipantAssignmentDTO[]>;
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

export function createProductBffService(
  options: ProductBffServiceOptions,
): ProductBffService {
  const store = options.store;
  const now = options.now ?? (() => new Date());
  const idScope = randomUUID().replaceAll("-", "").slice(0, 8);
  let sequence = 1;


  return {
    async createDraft(input) {
      const zhixu = await requireActiveZhixu(
        options.productService,
        input.zhixuId,
        options.versionResolver,
      );
      const createdAt = now().toISOString();
      const draft: ProductOrderDraftDTO = {
        draftId: nextId("draft", idScope, sequence++),
        zhixuId: zhixu.zhixuId,
        planId: normalizeBytes32(zhixu.planPublication.planId, "planId"),
        planHash: normalizeBytes32(zhixu.planPublication.planHash, "planHash"),
        title: input.title,
        businessType: input.businessType,
        goods: input.goods ?? [],
        totalAmount: input.totalAmount,
        currency: input.currency,
        ...(input.exportRegion ? { exportRegion: input.exportRegion } : {}),
        ...(input.destinationRegion
          ? { destinationRegion: input.destinationRegion }
          : {}),
        ...(input.expectedCompletionDate
          ? { expectedCompletionDate: input.expectedCompletionDate }
          : {}),
        ...(input.notes ? { notes: input.notes } : {}),
        status: "draft",
        createdBy: input.createdBy ?? "anonymous",
        createdAt,
        updatedAt: createdAt,
      };
      const participants = zhixu.roleSlots.map((slot, index) => ({
        participantId: nextId("participant", idScope, sequence + index),
        draftId: draft.draftId,
        roleSlotId: slot.slotId,
        roleLabel: slot.label,
        displayName: slot.title,
        contact: "",
        status: "missing" as const,
        required: slot.required,
      }));
      sequence += participants.length;
      await store.createDraft(draft, participants);
      return { draft, participants };
    },

    async getDraft(draftId, readerWallet) {
      const draft = await requireDraft(store, draftId);
      const participants = await store.listParticipants(draftId);
      assertDraftAffiliate(draft, participants, readerWallet);
      return { draft, participants };
    },

    async updateDraft(draftId, input, actorWallet) {
      const current = await requireDraft(store, draftId);
      assertDraftCreator(current, actorWallet);
      if (
        current.status === "triggering" ||
        current.status === "triggered" ||
        current.status === "cancelled"
      ) {
        throw new ProductBffError(
          409,
          "draft_not_editable",
          "the order draft has entered the trigger lifecycle and can no longer be edited",
          { draftId, status: current.status },
        );
      }
      const draft: ProductOrderDraftDTO = {
        ...current,
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.businessType !== undefined
          ? { businessType: input.businessType }
          : {}),
        ...(input.goods !== undefined ? { goods: input.goods } : {}),
        ...(input.totalAmount !== undefined
          ? { totalAmount: input.totalAmount }
          : {}),
        ...(input.currency !== undefined ? { currency: input.currency } : {}),
        ...(input.exportRegion !== undefined
          ? { exportRegion: input.exportRegion }
          : {}),
        ...(input.destinationRegion !== undefined
          ? { destinationRegion: input.destinationRegion }
          : {}),
        ...(input.expectedCompletionDate !== undefined
          ? { expectedCompletionDate: input.expectedCompletionDate }
          : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        updatedAt: now().toISOString(),
      };
      if (!(await store.updateDraftIfStatus(draft, current.status))) {
        throw new ProductBffError(
          409,
          "draft_conflict",
          "the draft changed while the update was being applied; re-read the draft and retry",
          { draftId, currentStatus: (await requireDraft(store, draftId)).status },
        );
      }
      return draft;
    },

    async createInvite(draftId, input, actorWallet) {
      const draft = await requireDraft(store, draftId);
      assertDraftCreator(draft, actorWallet);
      const participant = await requireRoleParticipant(
        store,
        draftId,
        input.roleSlotId,
      );
      if (participant.status === "accepted") {
        throw new ProductBffError(
          409,
          "role_already_filled",
          "participant role is already accepted",
          {
            participantId: participant.participantId,
            roleSlotId: participant.roleSlotId,
          },
        );
      }
      const participantInvites = (await store.listInvitesByDraft(draftId))
        .filter((invite) => invite.participantId === participant.participantId);
      const existingActiveInvite = participantInvites.find(
        (invite) =>
          invite.status === "active" &&
          !isInviteExpired(invite, now()),
      );
      if (existingActiveInvite) {
        throw new ProductBffError(
          409,
          "invite_already_active",
          "participant already has an active invite",
          {
            inviteId: existingActiveInvite.inviteId,
            participantId: participant.participantId,
          },
        );
      }
      if (input.expiresAt !== undefined) {
        requireValidInviteExpiry(input.expiresAt);
      }
      const invited: DraftParticipantDTO = {
        ...participant,
        displayName: input.displayName ?? participant.displayName,
        contact: input.contact,
        status: "invited",
      };
      const inviteToken = randomBytes(32).toString("hex");
      const invite: ProductInviteDTO = {
        inviteId: `${nextId("invite", idScope, sequence++)}_${randomBytes(8).toString("hex")}`,
        draftId,
        participantId: participant.participantId,
        roleSlotId: participant.roleSlotId,
        tokenHash: inviteTokenHash(inviteToken),
        status: "active",
        expiresAt: input.expiresAt ?? oneWeekFrom(now()),
        createdAt: now().toISOString(),
      };
      return withProductStoreTransaction(store, async () => {
        await store.updateParticipant(invited);
        for (const stale of participantInvites) {
          if (stale.status === "active" && isInviteExpired(stale, now())) {
            await store.updateInvite({ ...stale, status: "expired" });
          }
        }
        if (!(await store.createInviteIfNoneActive(invite, now().toISOString()))) {
          throw new ProductBffError(
            409,
            "invite_already_active",
            "participant already has an active invite",
            { participantId: participant.participantId, roleSlotId: participant.roleSlotId },
          );
        }
        const nextDraft = await refreshDraftStatus(store, draft, now);
        return { invite, participant: invited, draft: nextDraft, inviteToken };
      });
    },

    async getInvite(inviteId, input = {}) {
      const invite = await requireInvite(store, inviteId);
      assertInviteToken(invite, input.token);
      const participant = await requireParticipant(store, invite.participantId);
      const draft = await requireDraft(store, invite.draftId);
      const zhixu = await options.productService.getZhixu(draft.zhixuId);
      const previewInvite = inviteWithCurrentStatus(invite, now());
      const walletAddress = input.walletAddress
        ? normalizeAddress(input.walletAddress, "walletAddress")
        : undefined;
      const walletBinding = walletAddress
        ? await inviteWalletBinding(
            store,
            previewInvite,
            participant,
            walletAddress,
          )
        : undefined;
      const amountVisible = walletAddress
        ? await isDraftAmountVisible(store, draft, walletAddress)
        : false;
      return {
        invite: previewInvite,
        participant: invitePreviewParticipant(participant),
        draft: invitePreviewDraft(draft, amountVisible),
        role: inviteRolePreview(zhixu, participant),
        acceptance: inviteAcceptance(previewInvite, participant, walletBinding),
        ...(walletBinding ? { walletBinding } : {}),
      };
    },

    async acceptInvite(inviteId, input) {
      const invite = await requireAcceptableInvite(store, inviteId, now);
      assertInviteToken(invite, input.token);
      const participant = await requireParticipant(store, invite.participantId);
      const acceptedWalletAddress = normalizeAddress(
        input.walletAddress,
        "walletAddress",
      );
      const sessionWalletAddress = normalizeAddress(
        input.sessionWalletAddress,
        "sessionWalletAddress",
      );
      if (sessionWalletAddress !== acceptedWalletAddress) {
        throw new ProductBffError(
          403,
          "wrong_wallet",
          "connected wallet does not match invite acceptance wallet",
          {
            connectedWalletAddress: sessionWalletAddress,
            walletAddress: acceptedWalletAddress,
          },
        );
      }
      await assertWalletCanAcceptInvite(
        store,
        invite,
        participant,
        acceptedWalletAddress,
      );
      const accepted: DraftParticipantDTO = {
        ...participant,
        displayName: input.displayName,
        contact: input.contact,
        walletAddress: acceptedWalletAddress,
        status: "accepted",
        acceptedAt: now().toISOString(),
      };
      const acceptedInvite: ProductInviteDTO = {
        ...invite,
        status: "accepted",
        acceptedWalletAddress,
      };
      try {
        return await withProductStoreTransaction(store, async () => {
          try {
            await store.updateParticipant(accepted);
          } catch (error) {
            if (!(error instanceof StorageConstraintError)) {
              throw error;
            }
            throw new WalletBoundRaceLostError();
          }
          if (!(await store.updateInviteIfActive(acceptedInvite))) {
            throw inactiveInviteError(await requireInvite(store, inviteId));
          }
          const draft = await refreshDraftStatus(
            store,
            await requireDraft(store, invite.draftId),
            now,
          );
          return { invite: acceptedInvite, participant: accepted, draft };
        });
      } catch (error) {
        if (!(error instanceof WalletBoundRaceLostError)) {
          throw error;
        }
        const binding = await inviteWalletBinding(
          store,
          invite,
          participant,
          acceptedWalletAddress,
        );
        throw new ProductBffError(
          409,
          "wallet_already_bound",
          "wallet is already bound to another participant in this order",
          {
            walletAddress: acceptedWalletAddress,
            ...(binding.boundParticipantId
              ? { participantId: binding.boundParticipantId }
              : {}),
            ...(binding.boundRoleSlotId
              ? { roleSlotId: binding.boundRoleSlotId }
              : {}),
          },
        );
      }
    },

    async rejectInvite(inviteId, input) {
      const invite = await requireAcceptableInvite(store, inviteId, now);
      assertInviteToken(invite, input.token);
      const participant = await requireParticipant(store, invite.participantId);
      const rejected: DraftParticipantDTO = {
        ...participant,
        ...(input.displayName ? { displayName: input.displayName } : {}),
        ...(input.contact ? { contact: input.contact } : {}),
        status: "rejected",
        rejectedAt: now().toISOString(),
      };
      const rejectedInvite: ProductInviteDTO = {
        ...invite,
        status: "rejected",
      };
      return withProductStoreTransaction(store, async () => {
        if (!(await store.updateInviteIfActive(rejectedInvite))) {
          throw inactiveInviteError(await requireInvite(store, inviteId));
        }
        await store.updateParticipant(rejected);
        const draft = await refreshDraftStatus(
          store,
          await requireDraft(store, invite.draftId),
          now,
        );
        return { invite: rejectedInvite, participant: rejected, draft };
      });
    },

    async listParticipants(draftId, readerWallet) {
      const draft = await requireDraft(store, draftId);
      const participants = await store.listParticipants(draftId);
      assertDraftAffiliate(draft, participants, readerWallet);
      return participants;
    },

    async listParticipantAssignments(walletAddress) {
      const normalizedWallet = normalizeAddress(walletAddress, "walletAddress");
      const participants =
        await store.listAcceptedParticipantsByWallet(normalizedWallet);
      const assignments: ProductParticipantAssignmentDTO[] = [];
      for (const participant of participants) {
        const draft = await store.getDraft(participant.draftId);
        if (!draft) {
          continue;
        }
        assignments.push({ participant, draft, permissions: [] });
      }
      return assignments;
    },
  };
}

async function requireActiveZhixu(
  productService: ProductService,
  zhixuId: string,
  versionResolver?: ProductDraftVersionResolver,
): Promise<ZhixuDetailDTO> {
  const zhixu = await productService.getZhixu(zhixuId);
  if (!zhixu) {
    throw new ProductBffError(404, "zhixu_not_found", "zhixu not found");
  }
  if (versionResolver) {
    const version = await versionResolver.resolveActiveVersion(zhixuId);
    if (!version) {
      throw new ProductBffError(
        409,
        "no_active_version",
        "zhixu has no active Store version",
      );
    }
    if (version.status !== "active") {
      throw new ProductBffError(
        409,
        "version_not_active",
        "zhixu version is not active for new drafts",
        {
          versionId: version.versionId,
          status: version.status,
        },
      );
    }
    return {
      ...zhixu,
      planPublication: {
        ...zhixu.planPublication,
        planId: version.planId,
        planHash: version.planHash,
        ...(version.artifactHash ? { artifactHash: version.artifactHash } : {}),
      },
    };
  }
  return zhixu;
}

async function requireDraft(
  store: ProductBffStore,
  draftId: string,
): Promise<ProductOrderDraftDTO> {
  const draft = await store.getDraft(draftId);
  if (!draft) {
    throw new ProductBffError(404, "draft_not_found", "order draft not found");
  }
  return draft;
}

function assertDraftCreator(
  draft: ProductOrderDraftDTO,
  actorWallet: Address,
): void {
  if (isDraftCreator(draft, actorWallet)) {
    return;
  }
  throw new ProductBffError(
    403,
    "not_draft_creator",
    "only the wallet that created this order draft (anchored at creation time) may perform this action",
    { draftId: draft.draftId },
  );
}

function assertDraftAffiliate(
  draft: ProductOrderDraftDTO,
  participants: readonly DraftParticipantDTO[],
  readerWallet: Address,
): void {
  if (
    isDraftCreator(draft, readerWallet) ||
    isAcceptedParticipantWallet(participants, readerWallet)
  ) {
    return;
  }
  throw new ProductBffError(
    403,
    "draft_access_forbidden",
    "only the draft creator or an accepted participant may read this draft",
    { draftId: draft.draftId },
  );
}

function isDraftCreator(
  draft: ProductOrderDraftDTO,
  wallet: Address,
): boolean {
  if (!draft.createdBy) {
    return false;
  }
  try {
    return (
      normalizeAddress(draft.createdBy, "createdBy").toLowerCase() ===
      wallet.toLowerCase()
    );
  } catch {
    return false;
  }
}

function isAcceptedParticipantWallet(
  participants: readonly DraftParticipantDTO[],
  wallet: Address,
): boolean {
  return participants.some(
    (participant) =>
      participant.status === "accepted" &&
      participant.walletAddress?.toLowerCase() === wallet.toLowerCase(),
  );
}

async function requireRoleParticipant(
  store: ProductBffStore,
  draftId: string,
  roleSlotId: string,
): Promise<DraftParticipantDTO> {
  const participant = (await store.listParticipants(draftId)).find(
    (item) => item.roleSlotId === roleSlotId,
  );
  if (!participant) {
    throw new ProductBffError(
      404,
      "participant_not_found",
      "participant role not found",
    );
  }
  return participant;
}

async function requireParticipant(
  store: ProductBffStore,
  participantId: string,
): Promise<DraftParticipantDTO> {
  const participant = await store.getParticipant(participantId);
  if (!participant) {
    throw new ProductBffError(
      404,
      "participant_not_found",
      "participant not found",
    );
  }
  return participant;
}

async function requireInvite(
  store: ProductBffStore,
  inviteId: string,
): Promise<ProductInviteDTO> {
  const invite = await store.getInvite(inviteId);
  if (!invite) {
    throw new ProductBffError(404, "invite_not_found", "invite not found");
  }
  return invite;
}

async function requireAcceptableInvite(
  store: ProductBffStore,
  inviteId: string,
  now: () => Date,
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
      return new ProductBffError(
        409,
        "invite_already_accepted",
        "invite has already been accepted",
        {
          inviteId: invite.inviteId,
          acceptedWalletAddress: invite.acceptedWalletAddress,
        },
      );
    case "rejected":
      return new ProductBffError(
        409,
        "invite_rejected",
        "invite has been rejected",
        { inviteId: invite.inviteId },
      );
    case "revoked":
      return new ProductBffError(
        410,
        "invite_revoked",
        "invite has been revoked",
        { inviteId: invite.inviteId },
      );
    case "expired":
      return new ProductBffError(410, "invite_expired", "invite has expired", {
        inviteId: invite.inviteId,
        expiresAt: invite.expiresAt,
      });
    case "active":
      return new ProductBffError(
        409,
        "invite_not_active",
        "invite is not active",
        { inviteId: invite.inviteId },
      );
  }
}

function inviteWithCurrentStatus(
  invite: ProductInviteDTO,
  now: Date,
): ProductInviteDTO {
  return invite.status === "active" && isInviteExpired(invite, now)
    ? { ...invite, status: "expired" }
    : invite;
}

function isInviteExpired(invite: ProductInviteDTO, now: Date): boolean {
  return Date.parse(invite.expiresAt) <= now.getTime();
}

function inviteTokenHash(token: string): `0x${string}` {
  return hashHex(`uvp:product-bff:invite:v2:${token}`);
}

function assertInviteToken(invite: ProductInviteDTO, token: string | undefined): void {
  if (!token || inviteTokenHash(token) !== invite.tokenHash.toLowerCase()) {
    throw new ProductBffError(
      403,
      "invite_token_mismatch",
      "a valid invite token is required (delivered once with the create-invite response)",
      { inviteId: invite.inviteId }
    );
  }
}

function requireValidInviteExpiry(expiresAt: string): void {
  if (Number.isNaN(Date.parse(expiresAt))) {
    throw new ProductBffError(
      400,
      "invalid_expires_at",
      "invite expiresAt must be a valid timestamp",
    );
  }
}

async function inviteWalletBinding(
  store: ProductBffStore,
  invite: ProductInviteDTO,
  participant: DraftParticipantDTO,
  walletAddress: Address,
): Promise<ProductInviteWalletBindingDTO> {
  const participants = await store.listParticipants(invite.draftId);
  const boundParticipant = participants.find(
    (item) =>
      item.participantId !== participant.participantId &&
      item.status === "accepted" &&
      item.walletAddress?.toLowerCase() === walletAddress.toLowerCase(),
  );
  return {
    walletAddress,
    alreadyBound: Boolean(boundParticipant),
    canAccept: !boundParticipant,
    ...(boundParticipant
      ? {
          boundParticipantId: boundParticipant.participantId,
          boundRoleSlotId: boundParticipant.roleSlotId,
          boundRoleLabel: boundParticipant.roleLabel,
        }
      : {}),
  };
}

function inviteAcceptance(
  invite: ProductInviteDTO,
  participant: DraftParticipantDTO,
  walletBinding: ProductInviteWalletBindingDTO | undefined,
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

async function isDraftAmountVisible(
  store: ProductBffStore,
  draft: ProductOrderDraftDTO,
  wallet: Address,
): Promise<boolean> {
  if (isDraftCreator(draft, wallet)) {
    return true;
  }
  return isAcceptedParticipantWallet(
    await store.listParticipants(draft.draftId),
    wallet,
  );
}

function invitePreviewParticipant(
  participant: DraftParticipantDTO,
): ProductInvitePreviewParticipantDTO {
  return {
    participantId: participant.participantId,
    draftId: participant.draftId,
    roleSlotId: participant.roleSlotId,
    roleLabel: participant.roleLabel,
    displayName: participant.displayName,
    ...(participant.contact ? { maskedContact: maskContact(participant.contact) } : {}),
    status: participant.status,
    required: participant.required,
  };
}

function invitePreviewDraft(
  draft: ProductOrderDraftDTO,
  amountVisible: boolean,
): ProductInvitePreviewDraftDTO {
  return {
    draftId: draft.draftId,
    zhixuId: draft.zhixuId,
    title: draft.title,
    businessType: draft.businessType,
    currency: draft.currency,
    ...(draft.exportRegion ? { exportRegion: draft.exportRegion } : {}),
    ...(draft.destinationRegion ? { destinationRegion: draft.destinationRegion } : {}),
    ...(draft.expectedCompletionDate ? { expectedCompletionDate: draft.expectedCompletionDate } : {}),
    ...(amountVisible ? { totalAmount: draft.totalAmount } : {}),
  };
}

function maskContact(contact: string): string {
  const trimmed = contact.trim();
  if (!trimmed) {
    return "***";
  }
  const atIndex = trimmed.lastIndexOf("@");
  if (atIndex > 0 && trimmed.indexOf(".", atIndex) > atIndex) {
    const localPart = trimmed.slice(0, atIndex);
    const domain = trimmed.slice(atIndex);
    return `${localPart.slice(0, 2)}***${domain}`;
  }
  if (trimmed.length >= 7) {
    return `${trimmed.slice(0, 3)}****${trimmed.slice(-2)}`;
  }
  return "***";
}

function inviteRolePreview(
  zhixu: ZhixuDetailDTO | undefined,
  participant: DraftParticipantDTO,
): ProductInviteRolePreviewDTO {
  const roleSlot = zhixu?.roleSlots.find(
    (slot) => slot.slotId === participant.roleSlotId,
  );
  return {
    roleSlotId: participant.roleSlotId,
    label: roleSlot?.label ?? participant.roleLabel,
    duty: roleSlot?.duty ?? "按订单职责处理待办并提交必要业务凭证。",
  };
}

async function assertWalletCanAcceptInvite(
  store: ProductBffStore,
  invite: ProductInviteDTO,
  participant: DraftParticipantDTO,
  walletAddress: Address,
): Promise<void> {
  if (participant.status === "accepted") {
    throw new ProductBffError(
      409,
      "role_already_filled",
      "participant role is already accepted",
      {
        participantId: participant.participantId,
        roleSlotId: participant.roleSlotId,
        acceptedWalletAddress: participant.walletAddress,
      },
    );
  }

  const walletBinding = await inviteWalletBinding(
    store,
    invite,
    participant,
    walletAddress,
  );
  if (walletBinding.alreadyBound) {
    throw new ProductBffError(
      409,
      "wallet_already_bound",
      "wallet is already bound to another participant in this order",
      {
        walletAddress,
        participantId: walletBinding.boundParticipantId,
        roleSlotId: walletBinding.boundRoleSlotId,
      },
    );
  }
}

async function requireRegistration(
  store: ProductBffStore,
  triggerId: string,
): Promise<ProductOrderTriggerRecord> {
  const registration = await store.getRegistration(triggerId);
  if (!registration) {
    throw new ProductBffError(
      404,
      "trigger_not_found",
      "order trigger not found",
    );
  }
  return registration;
}

async function requireRegistrationByDraft(
  store: ProductBffStore,
  draftId: string,
): Promise<ProductOrderTriggerRecord> {
  const registration = await store.getRegistrationByDraft(draftId);
  if (!registration) {
    throw new ProductBffError(
      404,
      "trigger_not_found",
      "order draft has no prepared trigger",
    );
  }
  return registration;
}

async function refreshDraftStatus(
  store: ProductBffStore,
  draft: ProductOrderDraftDTO,
  now: () => Date,
): Promise<ProductOrderDraftDTO> {
  if (
    draft.status === "triggering" ||
    draft.status === "triggered" ||
    draft.status === "failed" ||
    draft.status === "cancelled"
  ) {
    return draft;
  }
  const participants = await store.listParticipants(draft.draftId);
  const required = participants.filter((participant) => participant.required);
  const status: ProductOrderDraftStatus =
    required.length > 0 &&
    required.every((participant) => participant.status === "accepted")
      ? "ready_to_trigger"
      : participants.some((participant) => participant.status !== "missing")
        ? "awaiting_participants"
        : "draft";
  const next = { ...draft, status, updatedAt: now().toISOString() };
  if (await store.updateDraftIfStatus(next, draft.status)) {
    return next;
  }
  const latest = await requireDraft(store, draft.draftId);
  return latest ?? next;
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

async function withProductStoreTransaction<T>(
  store: ProductBffStore,
  operation: () => Promise<T>,
): Promise<T> {
  return store.withTransaction ? store.withTransaction(operation) : operation();
}

class WalletBoundRaceLostError extends Error {}
