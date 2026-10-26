// 订单域服务：订单草稿（配置+阶段子集+每段条款）→ slot/邀请 → EIP-712
// 接受 → finalize（生成 plan + 触发订单）。身份由路由层的会话锚定钱包传入；
// 这里只信任 actor 参数并在每次写操作核验买方/发布者/参与者边界。
// 派生值（stageId、termsHash、配置哈希）一律服务端重算，客户端自报值不用。

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { verifyTypedData } from "viem";
import { buildUVPOrderFinalizeTypedData } from "@uvp-eth/protocol-bindings";
import type {
  AcceptStageInviteInput,
  AcceptStageInviteResult,
  ConfigBundle,
  ConfigStage,
  ConfigVersion,
  CreateStageInviteInput,
  FinalizeOrderDraftPreparation,
  FinalizeOrderDraftResult,
  OrderBirthStatus,
  Invite,
  OrderDraftDetail,
  OrderDraftStatus,
  OrderDraft,
  RejectStageInviteInput,
  StageInviteCreated,
  StageInvitePreview,
  StageSlot,
  StageStandardRef,
  StageTerms,
  UpdateOrderDraftInput,
} from "@uvp-eth/product-dto";
import { hashCanonicalJson } from "@uvp-eth/canonical-json";
import { normalizeAddress, normalizeBytes32, type Address, type Hex } from "../shared/types.js";
import {
  assertNoWindowOverride,
  buildInviteAcceptTypedData,
  canonicalStageId,
  canonicalStageTerms,
  isoToUnixSeconds,
  normalizeAmount,
  normalizeFinalStandardHash,
  normalizeIsoDeadline,
  optionalAddress,
  orderTermsHash,
  requireRecord,
  requireString,
  requiredAddress,
  requiredSlotKeys,
  resolveStageStandard,
  stageByKey,
  stageTermsHash,
  verifyConfigContentHash,
  ZERO_ADDRESS,
} from "./canonical.js";
import { OrderConfigService } from "./config-service.js";
import {
  UnconfiguredOrderBirthPort,
  type OrderBirthPort,
  type OrderBirthRoute,
  type OrderChainProjectionPort,
  type OrderTriggerPort,
  type PublishedPlan,
  type PublishedPlanInput,
  type PublishedPlanProvider,
} from "./ports.js";
import { deriveOrderChainStatus } from "./chain-status.js";
import type {
  ConfigVersionRecord,
  OrderDraftRecord,
  OrderInviteRecord,
  OrderRecord,
  OrderStageRecord,
  OrderStageSlotRecord,
  OrderStore,
} from "./types.js";
import { OrderError } from "./types.js";

const INVITE_DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const FINALIZE_AUTH_TTL_MS = 15 * 60 * 1000;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const INVITE_TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const SIGNATURE_PATTERN = /^0x[0-9a-fA-F]{130}$/;
const BYTES32_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const SLOT_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const ZERO_BYTES32 = `0x${"0".repeat(64)}` as Hex;

export function createOrderService(options: OrderServiceOptions): OrderService {
  return new OrderService(options);
}

export interface OrderVisibilitySnapshot {
  readonly order: OrderRecord;
  readonly draft: OrderDraftRecord;
  readonly config: ConfigBundle;
  readonly stages: readonly OrderStageRecord[];
  readonly slots: readonly OrderStageSlotRecord[];
}

export interface OrderServiceOptions {
  readonly store: OrderStore;
  readonly chainId: number;
  readonly stateMachine?: Address;
  readonly publisherWallets: readonly Address[];
  readonly publishedPlanProvider?: PublishedPlanProvider;
  readonly birthPort?: OrderBirthPort;
  readonly triggerPort?: OrderTriggerPort;
  readonly chainProjection: OrderChainProjectionPort;
  readonly now?: () => Date;
}

export class OrderService {
  readonly config: OrderConfigService;
  readonly #store: OrderStore;
  readonly #chainId: number;
  readonly #stateMachine: Address | undefined;
  readonly #publishedPlanProvider: PublishedPlanProvider | undefined;
  readonly #birthPort: OrderBirthPort;
  readonly #triggerPort: OrderTriggerPort | undefined;
  readonly #chainProjection: OrderChainProjectionPort;
  readonly #now: () => Date;

  constructor(options: OrderServiceOptions) {
    this.#store = options.store;
    this.#chainId = options.chainId;
    this.#stateMachine = options.stateMachine;
    this.#now = options.now ?? (() => new Date());
    this.#publishedPlanProvider = options.publishedPlanProvider;
    this.#birthPort = options.birthPort ?? new UnconfiguredOrderBirthPort();
    this.#triggerPort = options.triggerPort;
    this.#chainProjection = options.chainProjection;
    this.config = new OrderConfigService({
      store: options.store,
      publisherWallets: options.publisherWallets,
      now: this.#now,
    });
  }

  async publishConfig(actor: Address, body: unknown): Promise<ConfigVersion> {
    return this.config.publish(normalizeActor(actor), body);
  }

  async publishConfigVersion(actor: Address, configId: string, version: string): Promise<ConfigVersion> {
    return this.config.publishVersion(normalizeActor(actor), configId, version);
  }

  async deprecateConfig(actor: Address, configId: string, version: string): Promise<ConfigVersion> {
    return this.config.deprecate(normalizeActor(actor), configId, version);
  }

  async getConfig(actor: Address, configId: string, version: string): Promise<ConfigVersion> {
    return this.config.read(normalizeActor(actor), configId, version);
  }

  async createDraft(
    actor: Address,
    body: unknown,
    idempotencyKey?: string,
  ): Promise<OrderDraftDetail> {
    const wallet = normalizeActor(actor);
    return this.#idempotent(wallet, "create_order_draft_v3", idempotencyKey, body, async () => {
      assertNoWindowOverride(body);
      const anchor = this.#requireAnchor();
      const input = requireRecord(body, "body");
      const configId = requireString(input.configId, "configId");
      const configVersion = requireString(input.configVersion ?? input.version, "configVersion");
      const title = requireString(input.title, "title");
      const currency = requireString(input.currency, "currency");
      const config = await this.config.requirePublished(configId, configVersion);
      const stageSubset = parseStageSubset(input, config.bundle);
      const termsByStage = parseStageTermsArray(input.stageTerms);

      const now = this.#now().toISOString();
      const draftId = randomUUID();
      const stages: OrderStageRecord[] = [];
      const slots: OrderStageSlotRecord[][] = [];
      for (const [index, stageKey] of stageSubset.entries()) {
        const stageConfig = stageByKey(config.bundle, stageKey);
        const rawTerm = termsByStage.get(stageKey);
        if (!rawTerm) {
          throw new OrderError(422, "invalid_stage_terms", `stage ${stageKey} is missing terms`);
        }
        const term = parseTerm(stageKey, rawTerm, config.bundle, stageConfig);
        const stage = this.#buildStageRecord({
          draftId,
          index,
          config,
          stageConfig,
          term,
          owner: wallet,
          now,
        });
        stages.push(stage);
        slots.push(
          this.#buildRequiredSlots({
            draftId,
            stage,
            stageConfig,
            config: config.bundle,
            owner: wallet,
            now,
          }),
        );
      }

      const draft: OrderDraftRecord = {
        draftId,
        configId: config.configId,
        configVersion: config.version,
        configHash: config.configHash,
        buyerWallet: wallet,
        chainId: anchor.chainId,
        stateMachine: anchor.stateMachine,
        title,
        currency,
        stageSubset,
        status: "draft",
        createdAt: now,
        updatedAt: now,
      };
      await this.#store.createDraft(draft);
      await this.#store.createStages(stages);
      for (const stageSlots of slots) {
        const stageKey = stageSlots[0]?.stageKey;
        if (stageKey === undefined) {
          continue;
        }
        await this.#store.replaceStageSlots(draftId, stageKey, stageSlots);
      }
      return this.#draftDetail(draft, stages, slots.flat());
    });
  }

  async updateDraft(
    actor: Address,
    draftId: string,
    body: unknown,
    idempotencyKey?: string,
  ): Promise<OrderDraftDetail> {
    const wallet = normalizeActor(actor);
    return this.#idempotent(wallet, "update_order_draft_v3", idempotencyKey, { draftId, body }, async () => {
      assertNoWindowOverride(body);
      const draft = await this.#requireDraft(draftId);
      this.#requireCreator(draft, wallet);
      if (draft.status === "triggered") {
        throw new OrderError(409, "draft_frozen", "a triggered order draft cannot be modified");
      }
      if (draft.status === "cancelled") {
        throw new OrderError(409, "draft_frozen", "a cancelled order draft cannot be modified");
      }
      if (draft.frozenAt !== undefined) {
        throw new OrderError(409, "draft_frozen", "order draft terms were frozen at finalize");
      }
      const input = requireRecord(body, "body");
      if (input.stageSubset !== undefined) {
        const requested = parseStageSubset(input, (await this.#configForDraft(draft)).bundle);
        if (
          requested.length !== draft.stageSubset.length ||
          requested.some((key, index) => key !== draft.stageSubset[index])
        ) {
          throw new OrderError(422, "stage_subset_immutable", "stageSubset is immutable after draft creation");
        }
      }
      const title = input.title !== undefined ? requireString(input.title, "title") : draft.title;
      const currency = input.currency !== undefined ? requireString(input.currency, "currency") : draft.currency;
      const now = this.#now().toISOString();
      const config = await this.#configForDraft(draft);
      const stages = await this.#store.listStages(draft.draftId);
      const allSlots = await this.#store.listSlots(draft.draftId);

      if (input.stageTerms !== undefined) {
        const termsByStage = parseStageTermsArray(input.stageTerms);
        for (const stageKey of termsByStage.keys()) {
          if (!draft.stageSubset.includes(stageKey)) {
            throw new OrderError(422, "invalid_stage_terms", `stage ${stageKey} is not part of the draft stageSubset`);
          }
        }
        for (const [index, stage] of stages.entries()) {
          const rawTerm = termsByStage.get(stage.stageKey);
          if (!rawTerm) {
            continue;
          }
          const stageConfig = stageByKey(config.bundle, stage.stageKey);
          const term = parseTerm(stage.stageKey, rawTerm, config.bundle, stageConfig);
          const updated = this.#buildStageRecord({
            draftId: draft.draftId,
            index,
            config,
            stageConfig,
            term,
            owner: draft.buyerWallet,
            now,
            existing: stage,
          });
          if (updated.termsHash !== stage.termsHash) {
            const accepted = allSlots.some(
              (slot) => slot.stageKey === stage.stageKey && slot.status === "accepted",
            );
            if (accepted) {
              throw new OrderError(
                409,
                "stage_already_accepted",
                `stage ${stage.stageKey} already has an accepted participant; terms cannot change`,
              );
            }
            for (const slot of allSlots.filter(
              (candidate) => candidate.stageKey === stage.stageKey && candidate.inviteId !== undefined,
            )) {
              const invite = await this.#store.getInvite(slot.inviteId!);
              if (invite && invite.status === "active") {
                await this.#store.transitionInvite(invite.inviteId, "active", "revoked", { updatedAt: now });
              }
            }
            await this.#store.saveStage(updated);
            const rebuilt = this.#buildRequiredSlots({
              draftId: draft.draftId,
              stage: updated,
              stageConfig,
              config: config.bundle,
              owner: draft.buyerWallet,
              now,
            });
            await this.#store.replaceStageSlots(draft.draftId, stage.stageKey, rebuilt);
          } else {
            await this.#store.saveStage({ ...stage, updatedAt: now });
          }
        }
      }

      const updatedDraft = await this.#recomputeDraftStatus({
        ...draft,
        title,
        currency,
        updatedAt: now,
      });
      const refreshedStages = await this.#store.listStages(draftId);
      const refreshedSlots = await this.#store.listSlots(draftId);
      return this.#draftDetail(updatedDraft, refreshedStages, refreshedSlots);
    });
  }

  async getDraft(actor: Address, draftId: string): Promise<OrderDraftDetail> {
    const wallet = normalizeActor(actor);
    const draft = await this.#requireDraft(draftId);
    this.#requireCreator(draft, wallet);
    const stages = await this.#store.listStages(draft.draftId);
    const slots = await this.#store.listSlots(draft.draftId);
    return this.#draftDetail(draft, stages, slots);
  }

  async createInvite(
    actor: Address,
    draftId: string,
    body: unknown,
  ): Promise<StageInviteCreated> {
    const wallet = normalizeActor(actor);
    const draft = await this.#requireDraft(draftId);
    this.#requireCreator(draft, wallet);
    if (draft.status === "triggered" || draft.status === "cancelled") {
      throw new OrderError(409, "draft_frozen", "order draft is no longer open for invites");
    }
    const input = parseCreateInviteInput(body);
    const stage = await this.#store.getStage(draft.draftId, input.stageKey);
    if (!stage) {
      throw new OrderError(404, "stage_not_found", "stage was not found on this draft");
    }
    if (stage.status === "skipped" || stage.amount === "0") {
      throw new OrderError(409, "stage_skipped", "zero-amount stages are skipped: no invite and no amount intent");
    }
    const slot = await this.#store.getSlot(draft.draftId, input.stageKey, input.slotKey);
    if (!slot) {
      throw new OrderError(404, "slot_not_found", "slot was not found on this stage");
    }
    if (slot.status === "accepted") {
      throw new OrderError(409, "slot_already_accepted", "slot is already accepted");
    }
    const now = this.#now();
    const nowIso = now.toISOString();
    const active = await this.#store.findActiveInvite(draft.draftId, input.stageKey, input.slotKey);
    if (active) {
      if (Date.parse(active.expiresAt) <= now.getTime()) {
        await this.#store.transitionInvite(active.inviteId, "active", "expired", { updatedAt: nowIso });
        await this.#store.saveSlot({ ...slot, status: "uninvited", updatedAt: nowIso });
      } else {
        throw new OrderError(409, "invite_already_active", "an active invite already exists for this slot");
      }
    }
    const expiresAt = normalizeIsoDeadline(
      input.expiresAt ?? new Date(now.getTime() + INVITE_DEFAULT_TTL_MS).toISOString(),
      "expiresAt",
    );
    if (Date.parse(expiresAt) <= now.getTime()) {
      throw new OrderError(422, "invalid_deadline", "expiresAt must be in the future");
    }
    const inviteToken = randomBytes(32).toString("hex");
    const inviteId = randomUUID();
    const nonce = randomUint256Decimal();
    const invite: OrderInviteRecord = {
      inviteId,
      draftId: draft.draftId,
      stageKey: stage.stageKey,
      stageId: stage.stageId,
      slotKey: slot.slotKey,
      subjectLabel: input.subjectLabel,
      ...(input.contactRef !== undefined ? { contactRef: input.contactRef } : {}),
      ...(input.wallet !== undefined ? { wallet: input.wallet } : {}),
      tokenHash: hashInviteToken(inviteToken),
      nonce,
      status: "active",
      expiresAt,
      createdBy: wallet,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    await this.#store.createInvite(invite);
    await this.#store.saveSlot({
      ...slot,
      subjectLabel: input.subjectLabel,
      ...(input.contactRef !== undefined ? { contactRef: input.contactRef } : {}),
      ...(input.wallet !== undefined ? { wallet: input.wallet } : {}),
      status: "invited",
      inviteId,
      updatedAt: nowIso,
    });
    if (draft.status === "draft") {
      await this.#store.saveDraft({ ...draft, status: "inviting", updatedAt: nowIso });
    }
    return { ...toInviteDto(invite), inviteToken };
  }

  async previewInvite(actor: Address, inviteId: string, body: unknown): Promise<StageInvitePreview> {
    const wallet = normalizeActor(actor);
    const input = requireRecord(body, "body");
    const token = requireInviteToken(input.token);
    const invite = await this.#requireInviteForToken(inviteId, token);
    const now = this.#now();
    if (Date.parse(invite.expiresAt) <= now.getTime()) {
      await this.#expireInvite(invite, now.toISOString());
      throw new OrderError(410, "invite_expired", "invite has expired");
    }
    if (invite.status !== "active") {
      throw new OrderError(409, "invite_not_active", "invite is not active");
    }
    if (invite.wallet !== undefined && invite.wallet !== wallet) {
      throw new OrderError(403, "wrong_wallet", "session wallet does not match the invited wallet");
    }
    const draft = await this.#requireDraft(invite.draftId);
    const stage = await this.#store.getStage(invite.draftId, invite.stageKey);
    if (!stage) {
      throw new OrderError(404, "stage_not_found", "stage was not found on this draft");
    }
    const terms = this.#termsForInvitee(draft, stage, invite, wallet);
    const termsHash = stageTermsHash(terms);
    const typedData = buildInviteAcceptTypedData({
      draftId: draft.draftId,
      configId: draft.configId,
      configVersion: draft.configVersion,
      configHash: draft.configHash,
      chainId: draft.chainId,
      stateMachine: draft.stateMachine,
      stageKey: stage.stageKey,
      stageId: stage.stageId,
      slotKey: invite.slotKey,
      inviteId: invite.inviteId,
      invitee: wallet,
      amount: terms.amount,
      finalStandardHash: terms.finalStandardHash as Hex,
      workDeadline: terms.workDeadline,
      termsHash,
      nonce: invite.nonce,
      deadline: invite.expiresAt,
    });
    return {
      invite: toInviteDto(invite),
      draftId: draft.draftId,
      title: draft.title,
      stageId: stage.stageId,
      terms: { ...terms, termsHash },
      typedData,
      chainId: draft.chainId,
      stateMachineAddress: draft.stateMachine,
      signNonce: invite.nonce,
      termsHash,
    };
  }

  async acceptInvite(
    actor: Address,
    inviteId: string,
    body: unknown,
    idempotencyKey?: string,
  ): Promise<AcceptStageInviteResult> {
    const wallet = normalizeActor(actor);
    return this.#idempotent(wallet, "accept_stage_invite_v3", idempotencyKey, { inviteId, body }, async () => {
      const input = parseAcceptInput(body);
      const invite = await this.#requireInviteForToken(inviteId, input.token);
      const now = this.#now();
      if (Date.parse(invite.expiresAt) <= now.getTime()) {
        await this.#expireInvite(invite, now.toISOString());
        throw new OrderError(410, "invite_expired", "invite has expired");
      }
      if (invite.status !== "active") {
        throw new OrderError(
          invite.status === "accepted" ? 409 : 410,
          invite.status === "accepted" ? "invite_already_accepted" : "invite_not_active",
          "invite is not active",
        );
      }
      if (invite.wallet !== undefined && invite.wallet !== wallet) {
        throw new OrderError(403, "wrong_wallet", "session wallet does not match the invited wallet");
      }
      const draft = await this.#requireDraft(invite.draftId);
      const stage = await this.#store.getStage(invite.draftId, invite.stageKey);
      if (!stage) {
        throw new OrderError(404, "stage_not_found", "stage was not found on this draft");
      }
      const slot = await this.#store.getSlot(invite.draftId, invite.stageKey, invite.slotKey);
      if (!slot) {
        throw new OrderError(404, "slot_not_found", "slot was not found on this stage");
      }
      if (slot.status === "accepted") {
        throw new OrderError(409, "slot_already_accepted", "slot is already accepted");
      }
      const terms = this.#termsForInvitee(draft, stage, invite, wallet);
      const expectedTermsHash = stageTermsHash(terms);
      if (normalizeBytes32OrNull(input.termsHash) !== expectedTermsHash) {
        throw new OrderError(422, "stage_terms_mismatch", "signed termsHash does not match the frozen stage terms");
      }
      if (input.nonce !== invite.nonce) {
        throw new OrderError(422, "invite_nonce_mismatch", "invite nonce does not match the server-issued nonce");
      }
      const typedData = buildInviteAcceptTypedData({
        draftId: draft.draftId,
        configId: draft.configId,
        configVersion: draft.configVersion,
        configHash: draft.configHash,
        chainId: draft.chainId,
        stateMachine: draft.stateMachine,
        stageKey: stage.stageKey,
        stageId: stage.stageId,
        slotKey: invite.slotKey,
        inviteId: invite.inviteId,
        invitee: wallet,
        amount: terms.amount,
        finalStandardHash: terms.finalStandardHash as Hex,
        workDeadline: terms.workDeadline,
        termsHash: expectedTermsHash,
        nonce: invite.nonce,
        deadline: invite.expiresAt,
      });
      const validSignature = await verifyTypedData({
        address: wallet,
        domain: typedData.domain,
        types: typedData.types,
        primaryType: typedData.primaryType,
        message: typedData.message,
        signature: input.signature as Hex,
      }).catch(() => false);
      if (!validSignature) {
        throw new OrderError(403, "invalid_invite_signature", "EIP-712 signature does not recover to the session wallet");
      }
      const nowIso = now.toISOString();
      const transitioned = await this.#store.transitionInvite(invite.inviteId, "active", "accepted", {
        acceptedBy: wallet,
        acceptedAt: nowIso,
        updatedAt: nowIso,
      });
      if (!transitioned) {
        throw new OrderError(409, "invite_already_accepted", "invite was already consumed");
      }
      const acceptedSlot: OrderStageSlotRecord = {
        ...slot,
        status: "accepted",
        wallet,
        acceptedTermsHash: expectedTermsHash,
        acceptedAt: nowIso,
        signature: input.signature as Hex,
        updatedAt: nowIso,
      };
      await this.#store.saveSlot(acceptedSlot);
      const nextSlots = { ...stage.slots, [acceptedSlot.slotKey]: wallet };
      const nextTerms = canonicalStageTerms({
        orderDraftId: draft.draftId,
        configId: draft.configId,
        configVersion: draft.configVersion,
        configHash: draft.configHash,
        stageKey: stage.stageKey,
        stageId: stage.stageId,
        slots: nextSlots,
        amount: stage.amount,
        ...(stage.profileRef !== undefined ? { profileRef: stage.profileRef } : {}),
        ...(stage.standard ? { standard: stage.standard } : {}),
        finalStandardHash: stage.finalStandardHash,
        inviteDeadline: stage.inviteDeadline,
        workDeadline: stage.workDeadline,
      });
      await this.#store.saveStage({ ...stage, slots: nextSlots, termsHash: stageTermsHash(nextTerms), updatedAt: nowIso });
      const updatedDraft = await this.#recomputeDraftStatus(draft);
      return {
        invite: toInviteDto({ ...invite, status: "accepted", acceptedBy: wallet, acceptedAt: nowIso }),
        slot: toSlotDto(acceptedSlot, stage.stageId),
        draftStatus: updatedDraft.status,
        termsHash: expectedTermsHash,
      };
    });
  }

  async rejectInvite(
    actor: Address,
    inviteId: string,
    body: unknown,
    idempotencyKey?: string,
  ): Promise<AcceptStageInviteResult> {
    const wallet = normalizeActor(actor);
    return this.#idempotent(wallet, "reject_stage_invite_v3", idempotencyKey, { inviteId, body }, async () => {
      const input = parseRejectInput(body);
      const invite = await this.#requireInviteForToken(inviteId, input.token);
      const now = this.#now();
      if (Date.parse(invite.expiresAt) <= now.getTime()) {
        await this.#expireInvite(invite, now.toISOString());
        throw new OrderError(410, "invite_expired", "invite has expired");
      }
      if (invite.status !== "active") {
        throw new OrderError(409, "invite_not_active", "invite is not active");
      }
      if (invite.wallet !== undefined && invite.wallet !== wallet) {
        throw new OrderError(403, "wrong_wallet", "session wallet does not match the invited wallet");
      }
      const draft = await this.#requireDraft(invite.draftId);
      const stage = await this.#store.getStage(invite.draftId, invite.stageKey);
      const slot = await this.#store.getSlot(invite.draftId, invite.stageKey, invite.slotKey);
      if (!stage || !slot) {
        throw new OrderError(404, "slot_not_found", "stage or slot was not found");
      }
      const nowIso = now.toISOString();
      const transitioned = await this.#store.transitionInvite(invite.inviteId, "active", "rejected", {
        updatedAt: nowIso,
      });
      if (!transitioned) {
        throw new OrderError(409, "invite_not_active", "invite was already consumed");
      }
      const rejectedSlot: OrderStageSlotRecord = { ...slot, status: "rejected", updatedAt: nowIso };
      await this.#store.saveSlot(rejectedSlot);
      const updatedDraft = await this.#recomputeDraftStatus(draft);
      return {
        invite: toInviteDto({ ...invite, status: "rejected" }),
        slot: toSlotDto(rejectedSlot, stage.stageId),
        draftStatus: updatedDraft.status,
        termsHash: slot.acceptedTermsHash ?? ZERO_BYTES32,
      };
    });
  }

  async revokeInvite(actor: Address, inviteId: string): Promise<Invite> {
    const wallet = normalizeActor(actor);
    const invite = await this.#store.getInvite(inviteId);
    if (!invite) {
      throw new OrderError(404, "invite_not_found", "invite was not found");
    }
    const draft = await this.#requireDraft(invite.draftId);
    this.#requireCreator(draft, wallet);
    if (invite.status !== "active") {
      throw new OrderError(409, "invite_not_active", "only an active invite can be revoked");
    }
    const nowIso = this.#now().toISOString();
    const transitioned = await this.#store.transitionInvite(invite.inviteId, "active", "revoked", {
      updatedAt: nowIso,
    });
    if (!transitioned) {
      throw new OrderError(409, "invite_not_active", "invite was already consumed");
    }
    const slot = await this.#store.getSlot(invite.draftId, invite.stageKey, invite.slotKey);
    if (slot) {
      const { inviteId: _inviteId, subjectLabel: _label, contactRef: _contact, wallet: _wallet, ...rest } = slot;
      await this.#store.saveSlot({
        ...rest,
        status: "uninvited",
        updatedAt: nowIso,
      });
    }
    await this.#recomputeDraftStatus(draft);
    return toInviteDto({ ...invite, status: "revoked" });
  }

  async prepareFinalize(actor: Address, draftId: string): Promise<FinalizeOrderDraftPreparation> {
    const wallet = normalizeActor(actor);
    const draft = await this.#requireDraft(draftId);
    this.#requireCreator(draft, wallet);
    this.#assertFinalizable(draft);
    const context = await this.#finalizeContext(draft);
    await this.#requireBirthRoute(draft);
    const now = this.#now();
    const nonce = randomUint256Decimal();
    const deadline = new Date(now.getTime() + FINALIZE_AUTH_TTL_MS).toISOString();
    const prepared: OrderDraftRecord = {
      ...draft,
      status: "ready",
      termsHash: context.frozenTermsHash,
      frozenAt: draft.frozenAt ?? now.toISOString(),
      finalizeNonce: nonce,
      finalizeDeadline: deadline,
      updatedAt: now.toISOString(),
    };
    await this.#store.saveDraft(prepared);
    return {
      draftId: prepared.draftId,
      planId: context.publishedPlan.planId,
      planHash: context.publishedPlan.planHash,
      termsHash: context.frozenTermsHash,
      payloadHash: context.payloadHash,
      fundedStageKeys: context.fundedStageKeys,
      skippedStageKeys: context.skippedStageKeys,
      nonce,
      deadline,
      typedData: this.#finalizeTypedData(prepared, context.publishedPlan, nonce, deadline),
    };
  }

  async finalizeDraft(
    actor: Address,
    draftId: string,
    idempotencyKey?: string,
    body?: unknown,
  ): Promise<FinalizeOrderDraftResult> {
    const wallet = normalizeActor(actor);
    return this.#idempotent(wallet, "finalize_order_draft_v3", idempotencyKey, { draftId, body }, async () => {
      assertNoWindowOverride(body);
      const draft = await this.#requireDraft(draftId);
      this.#requireCreator(draft, wallet);
      this.#assertFinalizable(draft);
      const input = body === undefined || body === null ? {} : requireRecord(body, "body");
      const signature = input.signature;
      if (signature === undefined) {
        if (!this.#triggerPort) {
          throw new OrderError(
            422,
            "finalize_signature_required",
            "creator EIP-712 finalize authorization signature is required; call finalize/prepare first",
          );
        }
        return this.#finalizeViaTriggerPort(draft, idempotencyKey);
      }
      if (typeof signature !== "string" || !SIGNATURE_PATTERN.test(signature)) {
        throw new OrderError(422, "finalize_signature_required", "signature must be a 65-byte 0x-prefixed hex value");
      }
      if (draft.finalizeNonce === undefined || draft.finalizeDeadline === undefined) {
        throw new OrderError(409, "finalize_not_prepared", "call finalize/prepare before submitting the finalize authorization");
      }
      if (Date.parse(draft.finalizeDeadline) <= this.#now().getTime()) {
        throw new OrderError(410, "finalize_authorization_expired", "finalize authorization has expired; prepare again");
      }
      const context = await this.#finalizeContext(draft);
      if (draft.termsHash !== undefined && context.frozenTermsHash !== draft.termsHash) {
        throw new OrderError(409, "finalize_not_prepared", "order terms changed since prepare; prepare again");
      }
      const typedData = this.#finalizeTypedData(
        draft,
        context.publishedPlan,
        draft.finalizeNonce,
        draft.finalizeDeadline,
      );
      const authorized = await verifyTypedData({
        address: draft.buyerWallet,
        domain: typedData.domain,
        types: typedData.types,
        primaryType: typedData.primaryType,
        message: typedData.message,
        signature: signature as Hex,
      }).catch(() => false);
      if (!authorized) {
        throw new OrderError(403, "finalize_authorization_mismatch", "finalize authorization does not recover to the draft creator");
      }
      const birth = await this.#requireBirthRoute(draft);
      const nowIso = this.#now().toISOString();
      const birthResult = await this.#birthPort.birthOrder({
        draftId: draft.draftId,
        planId: context.publishedPlan.planId,
        planHash: context.publishedPlan.planHash,
        chainId: draft.chainId,
        stateMachine: draft.stateMachine,
        buyerWallet: draft.buyerWallet,
        creator: draft.buyerWallet,
        termsHash: context.frozenTermsHash,
        payloadHash: context.payloadHash,
        idempotencyKey: idempotencyKey ?? hashCanonicalJson({ draftId, frozenTermsHash: context.frozenTermsHash }),
        deadline: draft.finalizeDeadline,
        stageBindings: context.bindings,
        fundedStageKeys: context.fundedStageKeys,
        skippedStageKeys: context.skippedStageKeys,
        birth,
      });
      const orderId = normalizeBytes32OrNull(birthResult.orderId);
      if (birthResult.stateMachine !== undefined && birthResult.stateMachine.toLowerCase() !== draft.stateMachine.toLowerCase()) {
        throw new OrderError(503, "birth_signer_mismatch", "birth adapter returned a different state machine anchor");
      }
      const orderStatus = birthOrderRecordStatus(birthResult.status);
      await this.#store.createOrder({
        orderId,
        draftId: draft.draftId,
        planId: context.publishedPlan.planId,
        stateMachine: draft.stateMachine,
        chainId: draft.chainId,
        buyerWallet: draft.buyerWallet,
        termsHash: context.frozenTermsHash,
        status: orderStatus,
        ...(birthResult.txHash !== undefined ? { txHash: birthResult.txHash } : {}),
        createdAt: nowIso,
        updatedAt: nowIso,
      });
      await this.#store.saveDraft({
        ...draft,
        status: "triggered",
        termsHash: context.frozenTermsHash,
        orderId,
        planId: context.publishedPlan.planId,
        updatedAt: nowIso,
      });
      return {
        draftId: draft.draftId,
        orderId,
        planId: context.publishedPlan.planId,
        planHash: context.publishedPlan.planHash,
        stateMachine: draft.stateMachine,
        status: birthResult.status,
        fundedStageKeys: context.fundedStageKeys,
        skippedStageKeys: context.skippedStageKeys,
        ...(birthResult.txHash !== undefined ? { txHash: birthResult.txHash } : {}),
      };
    });
  }

  #assertFinalizable(draft: OrderDraftRecord): void {
    if (draft.status === "triggered" || draft.orderId !== undefined) {
      throw new OrderError(409, "order_already_triggered", "order draft was already triggered", {
        orderId: draft.orderId,
        planId: draft.planId,
      });
    }
    if (draft.status === "cancelled") {
      throw new OrderError(409, "draft_frozen", "cancelled order draft cannot be finalized");
    }
  }

  async #finalizeContext(draft: OrderDraftRecord): Promise<{
    readonly publishedPlan: PublishedPlan;
    readonly frozenTermsHash: Hex;
    readonly payloadHash: Hex;
    readonly bindings: readonly {
      readonly draftId: string;
      readonly stageKey: string;
      readonly stageId: string;
      readonly slotKey: string;
      readonly wallet: string;
      readonly termsHash: string;
      readonly acceptedAt?: string;
    }[];
    readonly fundedStageKeys: readonly string[];
    readonly skippedStageKeys: readonly string[];
  }> {
    const config = await this.#configForDraft(draft);
    const stages = await this.#store.listStages(draft.draftId);
    const slots = await this.#store.listSlots(draft.draftId);
    const missing = slots
      .filter((slot) => slot.required && slot.status !== "accepted")
      .map((slot) => `${slot.stageKey}/${slot.slotKey}`);
    if (missing.length > 0) {
      throw new OrderError(409, "required_slots_incomplete", "all required slots must be accepted before finalize", {
        missing,
      });
    }
    const finalTerms: StageTerms[] = [];
    const bindings: {
      draftId: string;
      stageKey: string;
      stageId: string;
      slotKey: string;
      wallet: string;
        termsHash: string;
      acceptedAt?: string;
    }[] = [];
    const fundedStageKeys: string[] = [];
    const skippedStageKeys: string[] = [];
    for (const stage of stages) {
      const funded = BigInt(stage.amount) > 0n;
      if (funded) {
        fundedStageKeys.push(stage.stageKey);
      } else {
        skippedStageKeys.push(stage.stageKey);
      }
      const terms = canonicalStageTerms({
        orderDraftId: draft.draftId,
        configId: draft.configId,
        configVersion: draft.configVersion,
        configHash: draft.configHash,
        stageKey: stage.stageKey,
        stageId: stage.stageId,
        slots: stage.slots,
        amount: stage.amount,
        ...(stage.profileRef !== undefined ? { profileRef: stage.profileRef } : {}),
        ...(stage.standard ? { standard: stage.standard } : {}),
        finalStandardHash: stage.finalStandardHash,
        inviteDeadline: stage.inviteDeadline,
        workDeadline: stage.workDeadline,
      });
      const termsHash = stageTermsHash(terms);
      finalTerms.push({ ...terms, termsHash });
      if (!funded) {
        continue;
      }
      bindings.push(
        ...slots
          .filter((slot) => slot.stageKey === stage.stageKey && slot.status === "accepted")
          .map((slot) => ({
            draftId: draft.draftId,
            stageKey: stage.stageKey,
            stageId: stage.stageId,
            slotKey: slot.slotKey,
            wallet: slot.wallet ?? draft.buyerWallet,
            termsHash: slot.acceptedTermsHash ?? termsHash,
            ...(slot.acceptedAt !== undefined ? { acceptedAt: slot.acceptedAt } : {}),
          })),
      );
    }
    const frozenTermsHash = orderTermsHash({
      orderDraftId: draft.draftId,
      configId: draft.configId,
      configVersion: draft.configVersion,
      configHash: draft.configHash,
      stages: finalTerms,
    });
    const payloadHash = hashCanonicalJson(
      { draftId: draft.draftId, termsHash: frozenTermsHash, bindings, fundedStageKeys, skippedStageKeys },
    );
    const publishedPlan = await this.#resolvePublishedPlan({
      configId: draft.configId,
      configVersion: draft.configVersion,
      configHash: draft.configHash,
      chainId: draft.chainId,
    });
    return { publishedPlan, frozenTermsHash, payloadHash, bindings, fundedStageKeys, skippedStageKeys };
  }

  #finalizeTypedData(
    draft: OrderDraftRecord,
    plan: PublishedPlan,
    nonce: string,
    deadline: string,
  ) {
    return buildUVPOrderFinalizeTypedData({
      chainId: draft.chainId,
      verifyingContract: draft.stateMachine,
      draftId: draft.draftId,
      planId: plan.planId,
      configId: draft.configId,
      configVersion: draft.configVersion,
      configHash: draft.configHash,
      buyer: draft.buyerWallet,
      termsHash: draft.termsHash ?? ZERO_BYTES32,
      nonce,
      deadline: Math.floor(Date.parse(deadline) / 1000),
    });
  }

  async #requireBirthRoute(draft: OrderDraftRecord): Promise<OrderBirthRoute> {
    const config = await this.#configForDraft(draft);
    const birth = config.birth;
    if (!birth) {
      throw new OrderError(
        409,
        "birth_route_missing",
        "the bound config version has no outside-trigger birth route (triggerHookId/stageId/sourceId/signalId/birthAuthorizer)",
      );
    }
    return birth;
  }

  async #finalizeViaTriggerPort(
    draft: OrderDraftRecord,
    idempotencyKey: string | undefined,
  ): Promise<FinalizeOrderDraftResult> {
    const context = await this.#finalizeContext(draft);
    const trigger = await this.#triggerOrderOrFail({
      draft,
      planId: context.publishedPlan.planId,
      planHash: context.publishedPlan.planHash,
      termsHash: context.frozenTermsHash,
      bindings: context.bindings,
      idempotencyKey: idempotencyKey ?? hashCanonicalJson({ draftId: draft.draftId, termsHash: context.frozenTermsHash }),
    });
    const nowIso = this.#now().toISOString();
    await this.#store.createOrder({
      orderId: trigger.orderId,
      draftId: draft.draftId,
      planId: context.publishedPlan.planId,
      stateMachine: trigger.stateMachine ?? draft.stateMachine,
      chainId: draft.chainId,
      buyerWallet: draft.buyerWallet,
      termsHash: context.frozenTermsHash,
      status: "submitted",
      ...(trigger.txHash !== undefined ? { txHash: trigger.txHash } : {}),
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    await this.#store.saveDraft({
      ...draft,
      status: "triggered",
      termsHash: context.frozenTermsHash,
      orderId: trigger.orderId,
      planId: context.publishedPlan.planId,
      updatedAt: nowIso,
    });
    return {
      draftId: draft.draftId,
      orderId: trigger.orderId,
      planId: context.publishedPlan.planId,
      planHash: context.publishedPlan.planHash,
      stateMachine: trigger.stateMachine ?? draft.stateMachine,
      status: "submitted",
      fundedStageKeys: context.fundedStageKeys,
      skippedStageKeys: context.skippedStageKeys,
      ...(trigger.txHash !== undefined ? { txHash: trigger.txHash } : {}),
    };
  }

  async loadOrderSnapshotForVisibility(orderId: string): Promise<OrderVisibilitySnapshot> {
    const order = await this.#store.getOrder(requireString(orderId, "orderId"));
    if (!order) {
      throw new OrderError(404, "order_not_found", "order was not found");
    }
    const draft = await this.#store.getDraft(order.draftId);
    if (!draft) {
      throw new OrderError(503, "projection_unavailable", "order draft projection is missing");
    }
    const config = await this.config.requirePublished(draft.configId, draft.configVersion);
    if (config.configHash !== draft.configHash) {
      throw new OrderError(503, "projection_unavailable", "order config hash does not match the draft");
    }
    const chainOrders = await this.#chainProjection.findChainOrders(order.orderId);
    const derived = deriveOrderChainStatus({
      order,
      stages: await this.#store.listStages(draft.draftId),
      chainOrders,
    });
    return {
      order: derived.order,
      draft,
      config: config.bundle,
      stages: derived.stages,
      slots: await this.#store.listSlots(draft.draftId),
    };
  }

  #requireAnchor(): { readonly chainId: number; readonly stateMachine: Address } {
    if (!Number.isSafeInteger(this.#chainId) || this.#chainId <= 0) {
      throw new OrderError(503, "order_anchor_unavailable", "order chainId is not configured");
    }
    if (!this.#stateMachine || this.#stateMachine === ZERO_ADDRESS) {
      throw new OrderError(
        503,
        "order_anchor_unavailable",
        "order state-machine anchor is not configured",
      );
    }
    return { chainId: this.#chainId, stateMachine: this.#stateMachine };
  }

  async #configForDraft(draft: OrderDraftRecord): Promise<ConfigVersionRecord> {
    const config = await this.config.requirePublished(draft.configId, draft.configVersion);
    if (config.configHash !== draft.configHash) {
      throw new OrderError(503, "config_hash_mismatch", "draft config hash does not match the published config version");
    }
    return config;
  }

  async #requireDraft(draftId: string): Promise<OrderDraftRecord> {
    const draft = await this.#store.getDraft(requireString(draftId, "draftId"));
    if (!draft) {
      throw new OrderError(404, "order_draft_not_found", "order draft was not found");
    }
    return draft;
  }

  #requireCreator(draft: OrderDraftRecord, wallet: Address): void {
    if (draft.buyerWallet !== wallet) {
      throw new OrderError(403, "wrong_wallet", "only the draft creator can perform this action");
    }
  }

  async #requireInviteForToken(inviteId: string, token: string): Promise<OrderInviteRecord> {
    const invite = await this.#store.getInvite(requireString(inviteId, "inviteId"));
    if (!invite || !inviteTokenMatches(token, invite.tokenHash)) {
      throw new OrderError(404, "invite_not_found", "invite was not found");
    }
    return invite;
  }

  async #expireInvite(invite: OrderInviteRecord, nowIso: string): Promise<void> {
    await this.#store.transitionInvite(invite.inviteId, "active", "expired", { updatedAt: nowIso });
    const slot = await this.#store.getSlot(invite.draftId, invite.stageKey, invite.slotKey);
    if (slot && slot.status === "invited") {
      await this.#store.saveSlot({ ...slot, status: "uninvited", updatedAt: nowIso });
    }
  }

  #buildStageRecord(input: {
    readonly draftId: string;
    readonly index: number;
    readonly config: ConfigVersionRecord;
    readonly stageConfig: ConfigStage;
    readonly term: ParsedStageTerm;
    readonly owner: Address;
    readonly now: string;
    readonly existing?: OrderStageRecord;
  }): OrderStageRecord {
    if (input.term.standard) {
      canonicalStandardHash(input.term.standard);
    }
    const stageId = input.existing?.stageId ?? canonicalStageId(input.stageConfig.key);
    const termsHash = stageTermsHash(
      canonicalStageTerms({
        orderDraftId: input.draftId,
        configId: input.config.configId,
        configVersion: input.config.version,
        configHash: input.config.configHash,
        stageKey: input.stageConfig.key,
        stageId,
        slots: input.existing?.slots ?? {},
        amount: input.term.amount,
        ...(input.term.profileRef !== undefined ? { profileRef: input.term.profileRef } : {}),
        ...(input.term.standard ? { standard: input.term.standard } : {}),
        finalStandardHash: input.term.finalStandardHash,
        inviteDeadline: input.term.inviteDeadline,
        workDeadline: input.term.workDeadline,
      }),
    );
    return {
      draftId: input.draftId,
      stageKey: input.stageConfig.key,
      stageId,
      stageIndex: input.existing?.stageIndex ?? input.index,
      amount: input.term.amount,
      slots: input.existing?.slots ?? {},
      ...(input.term.profileRef !== undefined ? { profileRef: input.term.profileRef } : {}),
      ...(input.term.standard ? { standard: input.term.standard } : {}),
      finalStandardHash: input.term.finalStandardHash,
      inviteDeadline: input.term.inviteDeadline,
      workDeadline: input.term.workDeadline,
      termsHash,
      status: input.term.amount === "0" ? "skipped" : "draft",
      createdAt: input.existing?.createdAt ?? input.now,
      updatedAt: input.now,
    };
  }

  #buildRequiredSlots(input: {
    readonly draftId: string;
    readonly stage: OrderStageRecord;
    readonly stageConfig: ConfigStage;
    readonly config: ConfigBundle;
    readonly owner: Address;
    readonly now: string;
  }): OrderStageSlotRecord[] {
    const skipped = input.stage.amount === "0";
    const slotKeys = skipped ? [] : requiredSlotKeys({
      config: input.config,
      stage: input.stageConfig,
    });
    const records: OrderStageSlotRecord[] = [];
    for (const slotKey of slotKeys) {
      if (!SLOT_KEY_PATTERN.test(slotKey)) {
        throw new OrderError(422, "invalid_stage_terms", `slot key ${slotKey} is not a valid identifier`);
      }
      records.push({
        draftId: input.draftId,
        stageKey: input.stage.stageKey,
        slotKey,
        required: true,
        status: "uninvited",
        createdAt: input.now,
        updatedAt: input.now,
      });
    }
    return records;
  }

  #termsForInvitee(
    draft: OrderDraftRecord,
    stage: OrderStageRecord,
    invite: OrderInviteRecord,
    wallet: Address,
  ): StageTerms {
    return canonicalStageTerms({
      orderDraftId: draft.draftId,
      configId: draft.configId,
      configVersion: draft.configVersion,
      configHash: draft.configHash,
      stageKey: stage.stageKey,
      stageId: stage.stageId,
      slots: stage.slots,
      amount: stage.amount,
      ...(stage.profileRef !== undefined ? { profileRef: stage.profileRef } : {}),
      ...(stage.standard ? { standard: stage.standard } : {}),
      finalStandardHash: stage.finalStandardHash,
      inviteDeadline: stage.inviteDeadline,
      workDeadline: stage.workDeadline,
    });
  }

  async #recomputeDraftStatus(draft: OrderDraftRecord): Promise<OrderDraftRecord> {
    if (draft.status === "triggered" || draft.status === "cancelled") {
      return draft;
    }
    const slots = await this.#store.listSlots(draft.draftId);
    const required = slots.filter((slot) => slot.required);
    const accepted = required.filter((slot) => slot.status === "accepted");
    const status: OrderDraftStatus =
      required.length > 0 && accepted.length === required.length
        ? "ready"
        : slots.some((slot) => slot.status === "invited" || slot.status === "accepted" || slot.status === "rejected")
          ? "inviting"
          : "draft";
    const updated: OrderDraftRecord = {
      ...draft,
      status,
      updatedAt: this.#now().toISOString(),
    };
    await this.#store.saveDraft(updated);
    return updated;
  }

  #draftDetail(
    draft: OrderDraftRecord,
    stages: readonly OrderStageRecord[],
    slots: readonly OrderStageSlotRecord[],
  ): OrderDraftDetail {
    return {
      draft: {
        draftId: draft.draftId,
        configId: draft.configId,
        configVersion: draft.configVersion,
        configHash: draft.configHash,
        buyerWallet: draft.buyerWallet,
        chainId: draft.chainId,
        stateMachine: draft.stateMachine,
        title: draft.title,
        currency: draft.currency,
        stageSubset: draft.stageSubset,
        stages: stages.map((stage) => {
          const terms = canonicalStageTerms({
            orderDraftId: draft.draftId,
            configId: draft.configId,
            configVersion: draft.configVersion,
            configHash: draft.configHash,
            stageKey: stage.stageKey,
            stageId: stage.stageId,
            slots: stage.slots,
            amount: stage.amount,
            ...(stage.profileRef !== undefined ? { profileRef: stage.profileRef } : {}),
            ...(stage.standard ? { standard: stage.standard } : {}),
            finalStandardHash: stage.finalStandardHash,
            inviteDeadline: stage.inviteDeadline,
            workDeadline: stage.workDeadline,
          });
          return { ...terms, termsHash: stageTermsHash(terms) };
        }),
        status: draft.status,
        termsHash: draft.termsHash ?? null,
        ...(draft.orderId !== undefined ? { orderId: draft.orderId } : {}),
        ...(draft.planId !== undefined ? { planId: draft.planId } : {}),
        createdAt: draft.createdAt,
        updatedAt: draft.updatedAt,
        ...(draft.frozenAt !== undefined ? { frozenAt: draft.frozenAt } : {}),
      },
      slots: slots.map((slot) => {
        const stage = stages.find((candidate) => candidate.stageKey === slot.stageKey);
        return toSlotDto(slot, stage?.stageId ?? ZERO_ADDRESS);
      }),
    };
  }

  async #resolvePublishedPlan(input: PublishedPlanInput): Promise<PublishedPlan> {
    try {
      const plan = this.#publishedPlanProvider
        ? await this.#publishedPlanProvider.resolvePublishedPlan(input)
        : await this.#registryPublishedPlan(input);
      if (!BYTES32_PATTERN.test(plan.planId) || !BYTES32_PATTERN.test(plan.planHash)) {
        throw new OrderError(503, "published_plan_invalid", "published plan returned non-canonical planId/planHash");
      }
      const registered = await this.#store.getConfig(input.configId, input.configVersion);
      if (registered?.planId !== undefined && registered.planId !== plan.planId.toLowerCase()) {
        throw new OrderError(
          503,
          "published_plan_mismatch",
          "published plan does not match the registration planId stored on the config version",
          { registeredPlanId: registered.planId, resolvedPlanId: plan.planId },
        );
      }
      return { planId: plan.planId.toLowerCase() as Hex, planHash: plan.planHash.toLowerCase() as Hex };
    } catch (error) {
      if (error instanceof OrderError) {
        throw error;
      }
      throw new OrderError(503, "published_plan_unavailable", "published-plan lookup failed");
    }
  }

  async #registryPublishedPlan(input: PublishedPlanInput): Promise<PublishedPlan> {
    const record = await this.config.requirePublished(input.configId, input.configVersion);
    if (record.configHash !== input.configHash) {
      throw new OrderError(503, "config_hash_mismatch", "draft config hash does not match the published config version");
    }
    if (record.planId === undefined || record.planHash === undefined) {
      throw new OrderError(
        409,
        "published_plan_missing",
        "the bound config version has no published plan; the curator must publish/register it",
      );
    }
    return { planId: record.planId, planHash: record.planHash };
  }

  async #triggerOrderOrFail(input: {
    readonly draft: OrderDraftRecord;
    readonly planId: Hex;
    readonly planHash: Hex;
    readonly termsHash: Hex;
    readonly bindings: readonly {
      readonly draftId: string;
      readonly stageKey: string;
      readonly stageId: string;
      readonly slotKey: string;
      readonly wallet: string;
      readonly termsHash: string;
      readonly acceptedAt?: string;
    }[];
    readonly idempotencyKey: string;
  }) {
    const triggerPort = this.#triggerPort;
    if (!triggerPort) {
      throw new OrderError(503, "trigger_transport_unavailable", "order trigger port is not configured");
    }
    try {
      const result = await triggerPort.triggerOrder({
        draftId: input.draft.draftId,
        planId: input.planId,
        planHash: input.planHash,
        chainId: input.draft.chainId,
        buyerWallet: input.draft.buyerWallet,
        stateMachine: input.draft.stateMachine,
        termsHash: input.termsHash,
        stageBindings: input.bindings,
        idempotencyKey: input.idempotencyKey,
      });
      if (!BYTES32_PATTERN.test(result.orderId)) {
        throw new OrderError(503, "trigger_result_invalid", "trigger transport returned a non-canonical orderId");
      }
      if (result.stateMachine !== undefined) {
        const anchor = normalizeAddressOrNull(result.stateMachine);
        if (anchor !== input.draft.stateMachine) {
          throw new OrderError(503, "trigger_result_invalid", "trigger transport returned a different state machine anchor");
        }
      }
      return result;
    } catch (error) {
      if (error instanceof OrderError) {
        throw error;
      }
      throw new OrderError(503, "trigger_transport_unavailable", "order trigger transport failed or is not configured");
    }
  }

  async #idempotent<T>(
    principal: Address,
    operation: string,
    idempotencyKey: string | undefined,
    requestBody: unknown,
    execute: () => Promise<T>,
  ): Promise<T> {
    if (idempotencyKey === undefined || idempotencyKey.length === 0) {
      return execute();
    }
    if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
      throw new OrderError(400, "invalid_request", "Idempotency-Key must be 1-128 printable identifier characters");
    }
    const requestHash = hashCanonicalJson(requestBody);
    const existing = await this.#store.getIdempotency(principal, operation, idempotencyKey);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new OrderError(409, "idempotency_key_reuse", "Idempotency-Key was reused with a different request");
      }
      return JSON.parse(existing.responseJson) as T;
    }
    const result = await execute();
    const now = this.#now();
    await this.#store.saveIdempotency({
      principalWallet: principal,
      operation,
      idemKey: idempotencyKey,
      requestHash,
      responseJson: JSON.stringify(result),
      status: "completed",
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS).toISOString(),
    });
    return result;
  }
}

interface ParsedStageTerm {
  readonly stageKey: string;
  readonly amount: string;
  readonly profileRef?: string;
  readonly standard?: StageStandardRef;
  readonly finalStandardHash: Hex;
  readonly inviteDeadline: string;
  readonly workDeadline: string;
}

function parseStageSubset(input: Record<string, unknown>, config: ConfigBundle): readonly string[] {
  if (input.stageSubset === undefined) {
    const subsetName =
      typeof input.stageSubsetName === "string"
        ? input.stageSubsetName
        : typeof input.profileName === "string"
          ? input.profileName
          : config.defaultProfile;
    if (subsetName !== undefined) {
      const subset = config.stageSubsets?.[subsetName] ?? config.stageProfiles?.[subsetName];
      if (!subset) {
        throw new OrderError(422, "invalid_stage_subset", `stage profile ${subsetName} is not declared by the config`);
      }
      return [...subset];
    }
    throw new OrderError(422, "invalid_stage_subset", "stageSubset is required");
  }
  if (!Array.isArray(input.stageSubset) || input.stageSubset.length === 0) {
    throw new OrderError(422, "invalid_stage_subset", "stageSubset must be a non-empty array");
  }
  const keys = input.stageSubset.map((value, index) => requireString(value, `stageSubset[${index}]`));
  if (new Set(keys).size !== keys.length) {
    throw new OrderError(422, "invalid_stage_subset", "stageSubset must not contain duplicates");
  }
  for (const key of keys) {
    if (!config.stages.some((stage) => stage.key === key)) {
      throw new OrderError(404, "stage_not_found", `stage ${key} is not declared by the config`);
    }
  }
  return keys;
}

function parseStageTermsArray(value: unknown): Map<string, Record<string, unknown>> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new OrderError(422, "invalid_stage_terms", "stageTerms must be a non-empty array");
  }
  const byStage = new Map<string, Record<string, unknown>>();
  for (const [index, raw] of value.entries()) {
    const term = requireRecord(raw, `stageTerms[${index}]`);
    const stageKey = requireString(term.stageKey, `stageTerms[${index}].stageKey`);
    if (byStage.has(stageKey)) {
      throw new OrderError(422, "invalid_stage_terms", `duplicate terms for stage ${stageKey}`);
    }
    byStage.set(stageKey, term);
  }
  return byStage;
}

function parseTerm(
  stageKey: string,
  raw: Record<string, unknown>,
  config: ConfigBundle,
  stageConfig: ConfigStage,
): ParsedStageTerm {
  if (raw.stageId !== undefined || raw.stage_id !== undefined) {
    throw new OrderError(422, "invalid_stage_terms", "stageId is derived server-side and must not be supplied");
  }
  const standard = raw.standard !== undefined
    ? parseStandardRef(raw.standard)
    : resolveStageStandard(config, stageConfig);
  const inviteDeadline = normalizeIsoDeadline(requireString(raw.inviteDeadline, "inviteDeadline"), "inviteDeadline");
  const workDeadline = normalizeIsoDeadline(requireString(raw.workDeadline, "workDeadline"), "workDeadline");
  if (Date.parse(workDeadline) <= Date.parse(inviteDeadline)) {
    throw new OrderError(422, "invalid_deadline", "workDeadline must be after inviteDeadline");
  }
  if (raw.windowValues !== undefined) {
    throw new OrderError(
      422,
      "window_override_forbidden",
      "time windows belong to the curator's config version; orders must not supply window overrides",
      { field: "windowValues" },
    );
  }
  return {
    stageKey,
    amount: normalizeAmount(raw.amount ?? "0"),
    ...(optionalString(raw.profileRef, "profileRef") !== undefined
      ? { profileRef: optionalString(raw.profileRef, "profileRef")! }
      : {}),
    ...(standard ? { standard } : {}),
    finalStandardHash: normalizeFinalStandardHash({ finalStandardHash: raw.finalStandardHash, ...(standard ? { standard } : {}) }),
    inviteDeadline,
    workDeadline,
  };
}

function optionalString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  return requireString(value, fieldName);
}

function parseStandardRef(value: unknown): StageStandardRef {
  const record = requireRecord(value, "standard");
  return {
    name: requireString(record.name, "standard.name"),
    ...(record.version !== undefined ? { version: requireString(record.version, "standard.version") } : {}),
    hash: normalizeFinalStandardHash({ finalStandardHash: record.hash }),
    ...(record.ref !== undefined ? { ref: requireString(record.ref, "standard.ref") } : {}),
  };
}

function parseCreateInviteInput(body: unknown): {
  readonly stageKey: string;
  readonly slotKey: string;
  readonly subjectLabel: string;
  readonly contactRef?: string;
  readonly wallet?: Address;
  readonly expiresAt?: string;
} {
  const input = requireRecord(body, "body");
  const subjectLabel = requireString(input.subjectLabel, "subjectLabel");
  if (subjectLabel.length > 128) {
    throw new OrderError(400, "invalid_request", "subjectLabel must be at most 128 characters");
  }
  const contactRef = input.contactRef !== undefined ? requireString(input.contactRef, "contactRef") : undefined;
  if (contactRef !== undefined && contactRef.length > 256) {
    throw new OrderError(400, "invalid_request", "contactRef must be at most 256 characters");
  }
  return {
    stageKey: requireString(input.stageKey, "stageKey"),
    slotKey: requireString(input.slotKey, "slotKey"),
    subjectLabel,
    ...(contactRef !== undefined ? { contactRef } : {}),
    ...(input.wallet !== undefined ? { wallet: requiredAddress(input.wallet, "wallet") } : {}),
    ...(input.expiresAt !== undefined ? { expiresAt: requireString(input.expiresAt, "expiresAt") } : {}),
  };
}

function parseAcceptInput(body: unknown): AcceptStageInviteInput {
  const input = requireRecord(body, "body");
  const signature = requireString(input.signature, "signature");
  if (!SIGNATURE_PATTERN.test(signature)) {
    throw new OrderError(400, "invalid_invite_signature", "signature must be a 65-byte 0x-prefixed hex value");
  }
  return {
    token: requireInviteToken(input.token),
    signature,
    termsHash: normalizeBytes32OrNull(requireString(input.termsHash, "termsHash")),
    nonce: requireString(input.nonce, "nonce"),
  };
}

function parseRejectInput(body: unknown): RejectStageInviteInput {
  const input = requireRecord(body, "body");
  return { token: requireInviteToken(input.token) };
}

function requireInviteToken(value: unknown): string {
  if (typeof value !== "string" || !INVITE_TOKEN_PATTERN.test(value)) {
    throw new OrderError(404, "invite_not_found", "invite was not found");
  }
  return value;
}

function hashInviteToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function inviteTokenMatches(token: string, tokenHash: string): boolean {
  const computed = hashInviteToken(token);
  const left = Buffer.from(computed, "utf8");
  const right = Buffer.from(tokenHash, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function randomUint256Decimal(): string {
  return BigInt(`0x${randomBytes(32).toString("hex")}`).toString(10);
}

function normalizeActor(value: Address): Address {
  const wallet = normalizeAddress(value, "actor").toLowerCase() as Address;
  if (wallet === ZERO_ADDRESS) {
    throw new OrderError(401, "wallet_identity_required", "a non-zero wallet session is required");
  }
  return wallet;
}

function birthOrderRecordStatus(status: OrderBirthStatus): string {
  if (status === "confirmed") {
    return "triggered";
  }
  return status;
}

function normalizeBytes32OrNull(value: string): Hex {
  if (!BYTES32_PATTERN.test(value)) {
    throw new OrderError(422, "invalid_request", "value must be a 32-byte hex string");
  }
  return value.toLowerCase() as Hex;
}

function normalizeAddressOrNull(value: string): Address {
  return normalizeAddress(value, "stateMachine").toLowerCase() as Address;
}

function canonicalStandardHash(standard: StageStandardRef): Hex {
  try {
    return normalizeBytes32(standard.hash, "standard.hash");
  } catch {
    throw new OrderError(422, "invalid_final_standard_hash", "standard.hash must be a 32-byte hex value");
  }
}

function toInviteDto(record: OrderInviteRecord): Invite {
  return {
    inviteId: record.inviteId,
    draftId: record.draftId,
    stageKey: record.stageKey,
    stageId: record.stageId,
    slotKey: record.slotKey,
    subjectLabel: record.subjectLabel,
    ...(record.contactRef !== undefined ? { contactRef: record.contactRef } : {}),
    ...(record.wallet !== undefined ? { wallet: record.wallet } : {}),
    status: record.status,
    expiresAt: record.expiresAt,
    createdAt: record.createdAt,
    ...(record.acceptedBy !== undefined ? { acceptedBy: record.acceptedBy } : {}),
    ...(record.acceptedAt !== undefined ? { acceptedAt: record.acceptedAt } : {}),
  };
}

function toSlotDto(record: OrderStageSlotRecord, stageId: string): StageSlot {
  return {
    draftId: record.draftId,
    stageKey: record.stageKey,
    stageId,
    slotKey: record.slotKey,
    required: record.required,
    ...(record.subjectLabel !== undefined ? { subjectLabel: record.subjectLabel } : {}),
    ...(record.contactRef !== undefined ? { contactRef: record.contactRef } : {}),
    ...(record.wallet !== undefined ? { wallet: record.wallet } : {}),
    status: record.status,
    ...(record.inviteId !== undefined ? { inviteId: record.inviteId } : {}),
    ...(record.acceptedTermsHash !== undefined ? { acceptedTermsHash: record.acceptedTermsHash } : {}),
    ...(record.acceptedAt !== undefined ? { acceptedAt: record.acceptedAt } : {}),
    ...(record.signature !== undefined ? { signature: record.signature } : {}),
  };
}

