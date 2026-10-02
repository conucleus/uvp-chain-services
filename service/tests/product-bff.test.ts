import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { StoreProductSchemaDTO } from "@uvp-eth/product-dto";
import {
  CROSS_BORDER_ZHIXU_ID,
  crossBorderPlanIds,
  demoZhixuDetail,
  customsOnchainHookPlanArtifact,
  customsRoleSlotIds,
  customsStageIds,
  customsStoreProductSchema,
} from "@uvp-eth/product-dto/fixtures";
import { createApiRouter, type ApiRouter } from "../src/api/routes.js";
import type { ChainEvent } from "../src/indexer/events.js";
import {
  ProductAuthorizationBuilder,
  ProductAuthorizationBuilderError,
} from "../src/product/query/bff/authorization.js";
import {
  crossBorderSchemaResolver,
  crossBorderStoreProductSchema,
} from "./cross-border-schema.js";
import { MemoryProductOrderTriggerBroadcastAdapter } from "../src/product/query/bff/trigger.js";
import type {
  ProductBroadcastOutsideTriggerInput,
  ProductOrderTriggerBroadcastAdapter,
  ProductOrderTriggerBroadcastResult,
} from "../src/product/query/bff/trigger.js";
import { MemoryStoreZhixuVersionMetadataStore } from "../src/store/console/version.js";
import { MemoryProjectionStore } from "../src/storage/projection-store.js";
import { StorageConstraintError } from "../src/storage/errors.js";
import { MemoryProductBffStore, type ProductBffStore } from "../src/product/query/bff/store.js";
import {
  STAGE_EXECUTOR_PATCH_SIGNAL_ID,
  STAGE_RESOURCE_PATCH_SIGNAL_ID,
} from "../src/stage-patches/index.js";
import type {
  DraftParticipantDTO,
  ProductOrderTriggerDTO,
  ProductInviteDTO,
  ProductOrderDraftDTO,
  SignalAuthorizationDTO,
  SubmitProductOrderDraftResult,
} from "../src/product/query/bff/types.js";
import type { Hex } from "../src/shared/types.js";
import type { Address } from "../src/shared/types.js";

const contractAddress = "0x1111111111111111111111111111111111111111";
const activeStateMachineAddress = "0x9999999999999999999999999999999999999999";
const deploymentRegistryAddress = "0x8888888888888888888888888888888888888888";
const activeDeploymentId =
  "0x0000000000000000000000000000000000000000000000000000000000000d02";
const metadataHash =
  "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

/**
 * Test-only trigger adapter that records attempts exactly like the
 * memory-trigger adapter but returns an explicitly scripted broadcast outcome.
 * The production memory-trigger adapter can never claim a chain result, so any
 * test that needs a confirmed outcome must assemble this fake itself.
 */
class ScriptedOutcomeTriggerAdapter implements ProductOrderTriggerBroadcastAdapter {
  readonly #memory = new MemoryProductOrderTriggerBroadcastAdapter();
  readonly registrarAddress: Address;
  readonly #outcome: ProductOrderTriggerBroadcastResult;

  constructor(outcome: ProductOrderTriggerBroadcastResult) {
    this.#outcome = outcome;
    this.registrarAddress = this.#memory.registrarAddress;
  }

  listAttempts(): readonly ProductBroadcastOutsideTriggerInput[] {
    return this.#memory.listAttempts();
  }

  async broadcastOutsideTrigger(
    input: ProductBroadcastOutsideTriggerInput,
  ): Promise<ProductOrderTriggerBroadcastResult> {
    await this.#memory.broadcastOutsideTrigger(input);
    return this.#outcome;
  }
}

/**
 * 按调用次序回放脚本化结果的触发适配器：重试流（先失败后成功）需要
 * 同一适配器在不同 attempt 上给出不同结局，attempt 记录语义与
 * ScriptedOutcomeTriggerAdapter 一致。
 */
class SequencedOutcomeTriggerAdapter extends MemoryProductOrderTriggerBroadcastAdapter {
  readonly #outcomes: ProductOrderTriggerBroadcastResult[];

  constructor(outcomes: readonly ProductOrderTriggerBroadcastResult[]) {
    super();
    this.#outcomes = [...outcomes];
  }

  override async broadcastOutsideTrigger(
    input: ProductBroadcastOutsideTriggerInput,
  ): Promise<ProductOrderTriggerBroadcastResult> {
    await super.broadcastOutsideTrigger(input);
    const outcome = this.#outcomes.shift();
    if (!outcome) {
      throw new Error("no scripted outcome left for trigger broadcast");
    }
    return outcome;
  }
}

describe("product BFF order drafts and invites", () => {
  it("creates an order draft from a published plan and exposes draft participants", async () => {
    const { router } = await createRouterFixture([planRegisteredEvent(1n)]);

    const response = await createDraft(router);

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const body = response.body as DraftResponse;
    expect(body.draft).toMatchObject({
      zhixuId: CROSS_BORDER_ZHIXU_ID,
      planId: crossBorderPlanIds.planId,
      planHash: crossBorderPlanIds.planHash,
      title: "A company purchase",
      status: "draft",
    });
    expect(
      body.participants.filter((participant) => participant.required).length,
    ).toBeGreaterThan(0);
    expect(
      body.participants.every(
        (participant) => participant.status === "missing",
      ),
    ).toBe(true);

    const getResponse = await router.handle({
      method: "GET",
      pathname: `/product/order-drafts/${body.draft.draftId}`,
      headers: creatorHeaders(),
    });
    expect(getResponse.status).toBe(200);
    expect((getResponse.body as DraftResponse).participants).toHaveLength(
      body.participants.length,
    );

    // KEEP：非创建者钱包不可修改他人草稿（越权拒绝）。
    const strangerPatch = await router.handle({
      method: "PATCH",
      pathname: `/product/order-drafts/${body.draft.draftId}`,
      headers: { "x-uvp-wallet-address": testWallet(9) },
      body: { title: "Hijacked purchase" },
    });
    expect(strangerPatch).toMatchObject({ status: 403, body: { error: "not_draft_creator" } });

    const patchResponse = await router.handle({
      method: "PATCH",
      pathname: `/product/order-drafts/${body.draft.draftId}`,
      headers: creatorHeaders(),
      body: { title: "Updated purchase", goods: ["vehicles"] },
    });
    expect(patchResponse.status).toBe(200);
    expect(
      (patchResponse.body as { draft: ProductOrderDraftDTO }).draft.title,
    ).toBe("Updated purchase");
  });

  it("restricts draft writes, invites, and participant reads to the anchored creator or accepted participants", async () => {
    // 草稿/邀请面鉴权收口：
    // - PATCH/createInvite 限创建者（建单时会话锚定地址）；
    // - 参与者名单（含联系方式）限创建者或已接受参与者；
    // - 无会话身份的匿名调用一律 401（local 之外同样 fail-closed）。
    const { router } = await createRouterFixture([planRegisteredEvent(1n)]);
    const draft = (
      await createDraft(router).then((response) => response.body as DraftResponse)
    ).draft;
    expect(draft.createdBy).toBe(testWallet(0));

    // 匿名读/写一律 401。
    await expect(router.handle({
      method: "GET",
      pathname: `/product/orders/${draft.draftId}/participants`
    })).resolves.toMatchObject({ status: 401, body: { error: "wallet_identity_required" } });
    await expect(router.handle({
      method: "PATCH",
      pathname: `/product/order-drafts/${draft.draftId}`,
      body: { title: "x" }
    })).resolves.toMatchObject({ status: 401, body: { error: "wallet_identity_required" } });
    await expect(router.handle({
      method: "POST",
      pathname: `/product/orders/${draft.draftId}/invites`,
      body: { roleSlotId: "funds", contact: "x@example.com" }
    })).resolves.toMatchObject({ status: 401, body: { error: "wallet_identity_required" } });

    // 无关钱包（未接受任何角色）不得读名单或发邀请。
    const stranger = { "x-uvp-wallet-address": testWallet(9) };
    await expect(router.handle({
      method: "GET",
      pathname: `/product/orders/${draft.draftId}/participants`,
      headers: stranger
    })).resolves.toMatchObject({ status: 403, body: { error: "draft_access_forbidden" } });
    await expect(router.handle({
      method: "POST",
      pathname: `/product/orders/${draft.draftId}/invites`,
      headers: stranger,
      body: { roleSlotId: "funds", contact: "x@example.com" }
    })).resolves.toMatchObject({ status: 403, body: { error: "not_draft_creator" } });
    await expect(router.handle({
      method: "GET",
      pathname: `/product/order-drafts/${draft.draftId}`,
      headers: stranger
    })).resolves.toMatchObject({ status: 403, body: { error: "draft_access_forbidden" } });

    // 已接受参与者可读名单（invitee 需要看到协同方），但不可发邀请。
    const accepted = await inviteAndAccept(router, draft.draftId, "funds", 1);
    await expect(router.handle({
      method: "GET",
      pathname: `/product/orders/${draft.draftId}/participants`,
      headers: { "x-uvp-wallet-address": accepted.participant.walletAddress ?? testWallet(1) }
    })).resolves.toMatchObject({ status: 200 });
    await expect(router.handle({
      method: "POST",
      pathname: `/product/orders/${draft.draftId}/invites`,
      headers: { "x-uvp-wallet-address": accepted.participant.walletAddress ?? testWallet(1) },
      body: { roleSlotId: "supply", contact: "s@example.com" }
    })).resolves.toMatchObject({ status: 403, body: { error: "not_draft_creator" } });
  });

  it("accepts and rejects participant invites", async () => {
    const { router } = await createRouterFixture([planRegisteredEvent(1n)]);
    const draft = (
      await createDraft(router).then(
        (response) => response.body as DraftResponse,
      )
    ).draft;

    const fundsInvite = await createInvite(
      router,
      draft.draftId,
      "funds",
      "funds@example.com",
    );
    expect(fundsInvite.draft.status).toBe("awaiting_participants");
    expect(fundsInvite.participant.status).toBe("invited");

    const acceptResponse = await router.handle({
      method: "POST",
      pathname: `/product/invites/${fundsInvite.invite.inviteId}/accept`,
      // 接受方的钱包声明来自 header/query/会话，不再读 body。
      headers: { "x-uvp-wallet-address": "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
      body: {
        displayName: "Buyer Finance",
        walletAddress: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        contact: "buyer@example.com",
        token: fundsInvite.inviteToken,
      },
    });
    expect(acceptResponse.status).toBe(200);
    const accepted = acceptResponse.body as InviteResponse;
    expect(accepted.participant).toMatchObject({
      roleSlotId: "funds",
      status: "accepted",
      walletAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    expect(accepted.draft.status).toBe("awaiting_participants");

    const supplyInvite = await createInvite(
      router,
      draft.draftId,
      "supply",
      "supply@example.com",
    );
    const rejectResponse = await router.handle({
      method: "POST",
      pathname: `/product/invites/${supplyInvite.invite.inviteId}/reject`,
      body: { displayName: "Supplier", contact: "supply@example.com", token: supplyInvite.inviteToken },
    });
    expect(rejectResponse.status).toBe(200);
    const rejected = rejectResponse.body as InviteResponse;
    expect(rejected.participant).toMatchObject({
      roleSlotId: "supply",
      status: "rejected",
    });
    expect(rejected.draft.status).toBe("awaiting_participants");
  });

  it("previews invites and blocks wrong-wallet or already accepted recovery states", async () => {
    const { router } = await createRouterFixture([planRegisteredEvent(1n)]);
    const draft = (
      await createDraft(router).then(
        (response) => response.body as DraftResponse,
      )
    ).draft;
    const fundsInvite = await createInvite(
      router,
      draft.draftId,
      "funds",
      "funds@example.com",
    );
    const acceptedWallet = testWallet(0);

    const previewResponse = await router.handle({
      method: "POST",
      pathname: `/product/invites/${fundsInvite.invite.inviteId}`,
      body: { token: fundsInvite.inviteToken! },
      headers: { "x-uvp-wallet-address": acceptedWallet },
    });
    expect(previewResponse.status).toBe(200);
    expect(
      (previewResponse.body as { invite: Record<string, unknown> }).invite,
    ).not.toHaveProperty("tokenHash");
    expect(previewResponse.body).toMatchObject({
      invite: { inviteId: fundsInvite.invite.inviteId, status: "active" },
      // 预览联系方式脱敏，不回传原文/钱包地址。
      participant: { roleSlotId: "funds", maskedContact: "fu***@example.com" },
      acceptance: { canAccept: true, status: "can_accept" },
      walletBinding: {
        walletAddress: acceptedWallet,
        alreadyBound: false,
        canAccept: true,
      },
    });
    const previewParticipant = (previewResponse.body as {
      participant: Record<string, unknown>;
    }).participant;
    expect(previewParticipant).not.toHaveProperty("contact");
    expect(previewParticipant).not.toHaveProperty("walletAddress");
    const previewDraft = (previewResponse.body as {
      draft: Record<string, unknown>;
    }).draft;
    // 金额按可见范围收敛 + 运营字段不进预览
    //（notes/planId/planHash/createdBy/goods 一律不回传）。
    expect(previewDraft).not.toHaveProperty("notes");
    expect(previewDraft).not.toHaveProperty("planId");
    expect(previewDraft).not.toHaveProperty("planHash");
    expect(previewDraft).not.toHaveProperty("createdBy");
    expect(previewDraft).not.toHaveProperty("goods");
    expect(previewDraft).not.toHaveProperty("status");
    // 查看者是建单者（createdBy=testWallet(0)）→ 金额可见。
    expect(previewDraft).toMatchObject({ totalAmount: "10000", currency: "USDC" });

    // 纯 token 持有者（无会话钱包）不在金额可见范围。
    const anonymousPreview = await router.handle({
      method: "POST",
      pathname: `/product/invites/${fundsInvite.invite.inviteId}`,
      body: { token: fundsInvite.inviteToken! },
    });
    expect(anonymousPreview.status).toBe(200);
    expect((anonymousPreview.body as { draft: Record<string, unknown> }).draft)
      .not.toHaveProperty("totalAmount");

    // 无关钱包（未接受参与、非创建者）同样不可见金额。
    const strangerPreview = await router.handle({
      method: "POST",
      pathname: `/product/invites/${fundsInvite.invite.inviteId}`,
      body: { token: fundsInvite.inviteToken! },
      headers: { "x-uvp-wallet-address": testWallet(9) },
    });
    expect(strangerPreview.status).toBe(200);
    expect((strangerPreview.body as { draft: Record<string, unknown> }).draft)
      .not.toHaveProperty("totalAmount");

    const wrongWalletResponse = await router.handle({
      method: "POST",
      pathname: `/product/invites/${fundsInvite.invite.inviteId}/accept`,
      headers: { "x-uvp-wallet-address": testWallet(1) },
      body: {
        displayName: "Buyer Finance",
        walletAddress: acceptedWallet,
        contact: "buyer@example.com",
        token: fundsInvite.inviteToken,
      },
    });
    expect(wrongWalletResponse).toMatchObject({
      status: 403,
      body: { error: "wrong_wallet" },
    });

    const acceptResponse = await router.handle({
      method: "POST",
      pathname: `/product/invites/${fundsInvite.invite.inviteId}/accept`,
      headers: { "x-uvp-wallet-address": acceptedWallet },
      body: {
        displayName: "Buyer Finance",
        walletAddress: acceptedWallet,
        contact: "buyer@example.com",
        token: fundsInvite.inviteToken,
      },
    });
    expect(acceptResponse.status).toBe(200);

    const meResponse = await router.handle({
      method: "GET",
      pathname: "/product/me",
      headers: { "x-uvp-wallet-address": acceptedWallet },
    });
    expect(meResponse.status).toBe(200);
    expect(meResponse.body).toMatchObject({
      participant: {
        participantId: (acceptResponse.body as InviteResponse).participant
          .participantId,
        displayName: "Buyer Finance",
        source: "wallet",
        roleLabels: expect.arrayContaining(["资金方"]),
      },
      summary: {
        orderCount: 0,
        openTaskCount: 0,
      },
    });

    const alreadyAcceptedResponse = await router.handle({
      method: "POST",
      pathname: `/product/invites/${fundsInvite.invite.inviteId}/accept`,
      headers: { "x-uvp-wallet-address": acceptedWallet },
      body: {
        displayName: "Buyer Finance",
        walletAddress: acceptedWallet,
        contact: "buyer@example.com",
        token: fundsInvite.inviteToken,
      },
    });
    expect(alreadyAcceptedResponse).toMatchObject({
      status: 409,
      body: { error: "invite_already_accepted" },
    });
  });

  it("requires the invite token for invite previews", async () => {
    const { router } = await createRouterFixture([planRegisteredEvent(1n)]);
    const draft = (
      await createDraft(router).then(
        (response) => response.body as DraftResponse,
      )
    ).draft;
    const invite = await createInvite(router, draft.draftId, "funds", "funds@example.com");

    // inviteId 是弱凭据：缺 token 的预览与 accept 同为 400（body 必填），
    // 错 token 403——都不泄露受邀人联系方式与草稿金额。token 走 POST
    // body——同权凭据不落 URL/Referer/代理日志。
    const noToken = await router.handle({
      method: "POST",
      pathname: `/product/invites/${invite.invite.inviteId}`,
      body: {}
    });
    expect(noToken).toMatchObject({ status: 400, body: { error: "invalid_body" } });

    const wrongToken = await router.handle({
      method: "POST",
      pathname: `/product/invites/${invite.invite.inviteId}`,
      body: { token: "not-the-invite-token" }
    });
    expect(wrongToken).toMatchObject({ status: 403, body: { error: "invite_token_mismatch" } });
  });

  it("creates at most one active invite per participant even under racing createInvite calls", async () => {
    // createInvite 的前置检查（listInvites 查活跃）是 check-then-act，
    // 并发双双通过会落两条 active；条件插入把判定原子化到存储层
    // （跨进程由单语句承担）。
    const store = new MemoryProductBffStore();
    const base = {
      draftId: "draft_invite_race",
      participantId: "participant_invite_race",
      roleSlotId: "slot_customs",
      tokenHash: "0x" + "11".repeat(32),
      status: "active" as const,
      expiresAt: "2026-02-01T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z"
    };

    await expect(store.createInviteIfNoneActive(
      { ...base, inviteId: "invite_race_a", tokenHash: ("0x" + "21".repeat(32)) as Hex },
      "2026-01-02T00:00:00.000Z"
    )).resolves.toBe(true);
    // 同 participant 的第二条 active（前置检查双双通过的并发方）必须被拒。
    await expect(store.createInviteIfNoneActive(
      { ...base, inviteId: "invite_race_b", tokenHash: ("0x" + "22".repeat(32)) as Hex },
      "2026-01-02T00:00:00.000Z"
    )).resolves.toBe(false);
    // 已过期但未翻档的 active 行同样占用单活索引：裸插入仍被拒——
    // 重邀必须由服务层先把过期档翻 expired（见 invite 过期重邀用例）。
    await expect(store.createInviteIfNoneActive(
      { ...base, inviteId: "invite_race_c", tokenHash: ("0x" + "23".repeat(32)) as Hex, expiresAt: "2026-03-01T00:00:00.000Z" },
      "2026-02-02T00:00:00.000Z"
    )).resolves.toBe(false);
  });

  it("invite status transitions are conditional on status=active", async () => {
    const store = new MemoryProductBffStore();
    const invite: ProductInviteDTO = {
      inviteId: "invite_conditional_1",
      draftId: "draft-1",
      participantId: "participant-1",
      roleSlotId: "funds",
      tokenHash: ("0x" + "a".repeat(64)) as ProductInviteDTO["tokenHash"],
      status: "active",
      expiresAt: "2100-01-01T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z"
    };
    await store.createInviteIfNoneActive(invite, "2026-01-01T00:00:00.000Z");
    await expect(store.updateInviteIfActive({ ...invite, status: "accepted" })).resolves.toBe(true);
    // 已接受的 invite 不再满足 WHERE status='active'：并发方的覆写被拒。
    await expect(store.updateInviteIfActive({ ...invite, status: "rejected" })).resolves.toBe(false);
    const reloaded = await store.getInvite(invite.inviteId);
    expect(reloaded?.status).toBe("accepted");
  });

  it("blocks expired invites and duplicate participant wallet binding", async () => {
    const { router } = await createRouterFixture([planRegisteredEvent(1n)]);
    const draft = (
      await createDraft(router).then(
        (response) => response.body as DraftResponse,
      )
    ).draft;
    await inviteAndAccept(router, draft.draftId, "funds", 0);

    const duplicateInvite = await createInvite(
      router,
      draft.draftId,
      "delivery",
      "delivery@example.com",
    );
    const duplicateAcceptResponse = await router.handle({
      method: "POST",
      pathname: `/product/invites/${duplicateInvite.invite.inviteId}/accept`,
      headers: { "x-uvp-wallet-address": testWallet(0) },
      body: {
        displayName: "Delivery",
        walletAddress: testWallet(0),
        contact: "delivery@example.com",
        token: duplicateInvite.inviteToken,
      },
    });
    expect(duplicateAcceptResponse).toMatchObject({
      status: 409,
      body: { error: "wallet_already_bound" },
    });

    const expiredInvite = await createInvite(
      router,
      draft.draftId,
      "supply",
      "supply@example.com",
      "2000-01-01T00:00:00.000Z",
    );
    const expiredPreviewResponse = await router.handle({
      method: "POST",
      pathname: `/product/invites/${expiredInvite.invite.inviteId}`,
      body: { token: expiredInvite.inviteToken! },
      headers: { "x-uvp-wallet-address": testWallet(2) },
    });
    expect(expiredPreviewResponse).toMatchObject({
      status: 200,
      body: {
        invite: { status: "expired" },
        acceptance: { canAccept: false, status: "expired" },
      },
    });

    const expiredAcceptResponse = await router.handle({
      method: "POST",
      pathname: `/product/invites/${expiredInvite.invite.inviteId}/accept`,
      headers: { "x-uvp-wallet-address": testWallet(2) },
      body: {
        displayName: "Supplier",
        walletAddress: testWallet(2),
        contact: "supply@example.com",
        token: expiredInvite.inviteToken,
      },
    });
    expect(expiredAcceptResponse).toMatchObject({
      status: 410,
      body: { error: "invite_expired" },
    });
  });

  it("re-invites after expiry by persisting the expired flip first", async () => {
    const { router, productStore } = await createRouterFixture([planRegisteredEvent(1n)]);
    const draft = (await createDraft(router).then(
      (response) => response.body as DraftResponse,
    )).draft;
    const expired = await createInvite(
      router,
      draft.draftId,
      "supply",
      "supply@example.com",
      "2000-01-01T00:00:00.000Z",
    );
    // 过期档在库内仍是 status=active：直接重邀会撞单活索引。服务层
    // 先把过期档持久翻成 expired，新邀才能落库。
    const reinvite = await createInvite(
      router,
      draft.draftId,
      "supply",
      "supply@example.com",
    );
    expect(reinvite.invite.inviteId).not.toBe(expired.invite.inviteId);
    const flipped = await productStore.getInvite(expired.invite.inviteId);
    expect(flipped?.status).toBe("expired");
    const active = await productStore.getInvite(reinvite.invite.inviteId);
    expect(active?.status).toBe("active");
  });

  it("binds one accepted wallet to one role slot per draft at the storage layer", async () => {
    const store = new MemoryProductBffStore();
    const wallet = testWallet(3);
    const participant = (draftId: string, participantId: string, roleSlotId: string): DraftParticipantDTO => ({
      participantId,
      draftId,
      roleSlotId,
      roleLabel: roleSlotId,
      displayName: roleSlotId,
      contact: `${roleSlotId}@example.com`,
      status: "invited",
      required: false
    });
    const funds = { ...participant("draft_one", "p_funds", "funds"), status: "accepted" as const, walletAddress: wallet, acceptedAt: "2026-01-01T00:00:00.000Z" };
    await store.updateParticipant(funds);

    // 同 draft 跨槽：同钱包的第二个已接受角色撞一钱包一角色约束。
    const delivery = { ...participant("draft_one", "p_delivery", "delivery"), status: "accepted" as const, walletAddress: wallet, acceptedAt: "2026-01-02T00:00:00.000Z" };
    await expect(store.updateParticipant(delivery)).rejects.toMatchObject({
      name: "StorageConstraintError"
    });
    // 未接受/未绑钱包的行不受限。
    await expect(store.updateParticipant(participant("draft_one", "p_delivery", "delivery"))).resolves.toBeUndefined();
    // 不同 draft 间同钱包多角色合法（键含 draft_id）。
    const otherDraft = { ...participant("draft_two", "p_other_delivery", "delivery"), status: "accepted" as const, walletAddress: wallet, acceptedAt: "2026-01-03T00:00:00.000Z" };
    await expect(store.updateParticipant(otherDraft)).resolves.toBeUndefined();
    // 同一行幂等重写不误伤。
    await expect(store.updateParticipant(funds)).resolves.toBeUndefined();
  });

  it("rejects a cross-slot accept when the storage wallet constraint wins the race", async () => {
    const { router, productStore } = await createRouterFixture([planRegisteredEvent(1n)]);
    const draft = (await createDraft(router).then(
      (response) => response.body as DraftResponse,
    )).draft;
    await inviteAndAccept(router, draft.draftId, "funds", 0);
    const deliveryInvite = await createInvite(
      router,
      draft.draftId,
      "delivery",
      "delivery@example.com",
    );
    // 模拟并发窗口：事务外的钱包前置查重读到旧快照（未见 funds 的已
    // 接受行），判定落到存储层约束——同响应 409，不外泄存储错误。
    const originalList = productStore.listParticipants.bind(productStore);
    let staleSnapshotServed = false;
    productStore.listParticipants = async (draftId: string) => {
      if (!staleSnapshotServed) {
        staleSnapshotServed = true;
        return [];
      }
      return originalList(draftId);
    };
    const racedAccept = await router.handle({
      method: "POST",
      pathname: `/product/invites/${deliveryInvite.invite.inviteId}/accept`,
      headers: { "x-uvp-wallet-address": testWallet(0) },
      body: {
        displayName: "Delivery",
        walletAddress: testWallet(0),
        contact: "delivery@example.com",
        token: deliveryInvite.inviteToken,
      },
    });
    expect(racedAccept).toMatchObject({
      status: 409,
      body: { error: "wallet_already_bound" },
    });
    // 败者不落 accepted、invite 未被消费：换一个钱包仍可接受。
    const deliveryRow = (await originalList(draft.draftId)).find(
      (participant) => participant.roleSlotId === "delivery",
    );
    expect(deliveryRow?.status).toBe("invited");
    const retryAccept = await router.handle({
      method: "POST",
      pathname: `/product/invites/${deliveryInvite.invite.inviteId}/accept`,
      headers: { "x-uvp-wallet-address": testWallet(4) },
      body: {
        displayName: "Delivery",
        walletAddress: testWallet(4),
        contact: "delivery@example.com",
        token: deliveryInvite.inviteToken,
      },
    });
    expect(retryAccept.status).toBe(200);
  });

  it("reads the race loser's wallet binding after the failed postgres transaction rolls back", async () => {
    // postgres 事务内撞 23505 后整个事务已 abort（后续语句 25P02），
    // 事务内的任何回读都会以 InFailedSqlTransaction 失败——竞态败者的
    // 409+占用详情必须在事务回滚后的新读里取得。用模拟该语义的 store
    // 桩钉住：回读一旦被挪回失败事务内，本测试以 500 而非 409 暴露。
    const store = new MemoryProjectionStore();
    const backing = new MemoryProductBffStore();
    const pgLikeStore = postgresAbortSemanticsStore(backing);
    await store.resetFromEvents({ deploymentBlock: 0n, events: [planRegisteredEvent(1n)] });
    const router = createApiRouter(store, {
      productSchemaResolver: crossBorderSchemaResolver(),
      submissionChainId: 84532,
      submissionVerifyingContract: "0x1111111111111111111111111111111111111111",
      productRuntimeEnvironment: "local",
      productRegistrationAdapter: new MemoryProductOrderTriggerBroadcastAdapter(),
      productBffStore: pgLikeStore,
    });
    const draft = (await createDraft(router).then(
      (response) => response.body as DraftResponse,
    )).draft;
    await inviteAndAccept(router, draft.draftId, "funds", 0);
    const deliveryInvite = await createInvite(
      router,
      draft.draftId,
      "delivery",
      "delivery@example.com",
    );
    // 武装竞态窗口：前置查重的下一次 listParticipants 读到旧快照
    // （未见 funds 的已接受行），判定落到存储层约束。
    pgLikeStore.armStaleSnapshotReads(1);
    const racedAccept = await router.handle({
      method: "POST",
      pathname: `/product/invites/${deliveryInvite.invite.inviteId}/accept`,
      headers: { "x-uvp-wallet-address": testWallet(0) },
      body: {
        displayName: "Delivery",
        walletAddress: testWallet(0),
        contact: "delivery@example.com",
        token: deliveryInvite.inviteToken,
      },
    });
    const fundsRow = (await backing.listParticipants(draft.draftId)).find(
      (participant) => participant.roleSlotId === "funds",
    );
    expect(fundsRow?.status).toBe("accepted");
    expect(racedAccept).toMatchObject({
      status: 409,
      body: {
        error: "wallet_already_bound",
        details: {
          participantId: fundsRow?.participantId,
          roleSlotId: "funds",
        },
      },
    });
    // 败者不落 accepted：占用行仍是唯一已接受归属。
    const deliveryRow = (await backing.listParticipants(draft.draftId)).find(
      (participant) => participant.roleSlotId === "delivery",
    );
    expect(deliveryRow?.status).toBe("invited");
  });

  it("carries publisher evidenceSpec into invite previews and prepared permissions (evidenceSpec passthrough)", async () => {
    // schema stage / roleSlot 上发布者携带的 evidenceSpec 不在 protocol DTO
    // 类型上；invite 预览与权限投影必须结构化透传而不是静默丢弃。
    const stageEvidenceSpec = [
      {
        key: "stage-evidence",
        label: "阶段交付凭证",
        inputKind: "file",
        accept: ["application/pdf"],
        required: true
      }
    ];
    const slotEvidenceSpec = [
      { key: "funds-confirmed-at", label: "完成日期", inputKind: "date", required: true }
    ];
    const schemaWithEvidenceSpec = {
      ...crossBorderStoreProductSchema,
      stages: crossBorderStoreProductSchema.stages.map((stage) =>
        stage.stageId === "customs-complete"
          ? { ...stage, evidenceSpec: stageEvidenceSpec }
          : stage
      ),
      roleSlots: crossBorderStoreProductSchema.roleSlots.map((slot) =>
        slot.slotId === "funds"
          ? { ...slot, evidenceSpec: slotEvidenceSpec }
          : slot
      )
    } as unknown as StoreProductSchemaDTO;
    const store = new MemoryProjectionStore();
    const productStore = new MemoryProductBffStore();
    await store.resetFromEvents({
      deploymentBlock: 0n,
      events: [...activeDeploymentEvents(), planRegisteredEvent(11n)]
    });
    const router = createApiRouter(store, {
      productSchemaResolver: {
        async getProductSchemaByPlan(planId) {
          return planId === crossBorderPlanIds.planId ? schemaWithEvidenceSpec : undefined;
        }
      },
      submissionChainId: 84532,
      submissionVerifyingContract: "0x1111111111111111111111111111111111111111",
      productRuntimeEnvironment: "local",
      productRegistrationAdapter: new MemoryProductOrderTriggerBroadcastAdapter(),
      productBffStore: productStore
    });

    // invite role preview：roleSlot 的 evidenceSpec 透传。
    const draft = (
      await createDraft(router).then((response) => response.body as DraftResponse)
    ).draft;
    const invite = await createInvite(router, draft.draftId, "funds", "funds-contact@example");
    const preview = await router.handle({
      method: "POST",
      pathname: `/product/invites/${invite.invite.inviteId}`,
      body: { token: invite.inviteToken! }
    });
    expect(preview.status).toBe(200);
    expect((preview.body as { role: { evidenceSpec?: unknown } }).role.evidenceSpec)
      .toEqual(slotEvidenceSpec);

    // prepared permissions：schema stage 的 evidenceSpec 透传到权限行。
    const readyDraft = await createReadyDraft(router);
    const prepared = await prepareDraftTrigger(
      router,
      readyDraft.draftId,
      testWallet(0)
    );
    const customsPermission = prepared.permissions.find(
      (permission) => permission.stageIdentifier === "customs-complete"
    );
    expect(customsPermission).toBeDefined();
    expect(customsPermission?.evidenceSpec).toEqual(stageEvidenceSpec);
  });

  it("prepares signed trigger typed data after required participants accept", async () => {
    const { router, triggerAdapter } = await createRouterFixture([
      ...activeDeploymentEvents(),
      planRegisteredEvent(11n),
    ]);
    const draft = (
      await createDraft(router).then(
        (response) => response.body as DraftResponse,
      )
    ).draft;
    const participants = await listParticipants(router, draft.draftId);
    const requiredParticipants = participants.filter(
      (participant) => participant.required,
    );

    for (const [index, participant] of requiredParticipants
      .slice(0, -1)
      .entries()) {
      await inviteAndAccept(
        router,
        draft.draftId,
        participant.roleSlotId,
        index,
      );
    }

    const blockedSubmit = await router.handle({
      method: "POST",
      pathname: `/product/order-drafts/${draft.draftId}/prepare-trigger`,
      body: { walletAddress: testWallet(0) },
    });
    expect(blockedSubmit.status).toBe(409);
    expect(blockedSubmit.body).toMatchObject({
      error: "required_participant_missing",
    });

    const lastRequired = requiredParticipants.at(-1);
    expect(lastRequired).toBeDefined();
    await inviteAndAccept(
      router,
      draft.draftId,
      lastRequired!.roleSlotId,
      requiredParticipants.length,
    );

    const readyDraft = await router.handle({
      method: "GET",
      pathname: `/product/order-drafts/${draft.draftId}`,
      headers: creatorHeaders(),
    });
    expect((readyDraft.body as DraftResponse).draft.status).toBe(
      "ready_to_trigger",
    );

    const prepareResponse = await router.handle({
      method: "POST",
      pathname: `/product/order-drafts/${draft.draftId}/prepare-trigger`,
      body: { walletAddress: testWallet(0) },
    });
    expect(prepareResponse.status).toBe(200);
    const prepared = prepareResponse.body as SubmitProductOrderDraftResult & {
      readonly prepared: {
        readonly prepareId: string;
        readonly typedData: Record<string, unknown>;
        readonly submitter: string;
      };
    };
    expect(prepared.draft.status).toBe("ready_to_trigger");
    expect(prepared.trigger).toMatchObject({
      draftId: draft.draftId,
      planId: crossBorderPlanIds.planId,
      planHash: crossBorderPlanIds.planHash,
      status: "prepared",
      retryable: false,
    });
    // triggerId 不可枚举——结构前缀 + 128 位随机熵后缀，
    // 顺序段不可被猜测（会话门之外的第二道收敛）。
    expect(prepared.trigger.triggerId).toMatch(/^trigger_[0-9a-f]{8}_\d{6}_[0-9a-f]{32}$/);
    expect(prepared.trigger.orderId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(prepared.trigger.txHash).toBeUndefined();
    expect(prepared.permissions.length).toBeGreaterThan(0);
    expect(prepared.prepared.prepareId).toMatch(/^prepare_/);
    expect(prepared.prepared.submitter).toBe(testWallet(0));
    expect(prepared.prepared.typedData).toMatchObject({
      domain: expect.objectContaining({
        verifyingContract: activeStateMachineAddress,
      }),
      primaryType: "UVPStateMachineTriggerOrderFromOutside",
    });
    expect(triggerAdapter.listAttempts()).toHaveLength(0);
    const registrationResponse = await router.handle({
      method: "GET",
      pathname: `/product/order-triggers/${prepared.trigger.triggerId}`,
      headers: creatorHeaders(),
    });
    expect(registrationResponse.status).toBe(200);
    expect(
      (registrationResponse.body as { trigger: ProductOrderTriggerDTO })
        .trigger,
    ).toEqual(prepared.trigger);
  });

  it("rejects trigger profile reads from wallets outside the trigger/draft affiliation", async () => {
    // IDOR 归属校验：trigger 档案携带草稿/签名者/授权明细——非归属
    // 钱包拿到 triggerId 也不得读取（会话门之外的属主比对）。
    const { router } = await createRouterFixture([
      ...activeDeploymentEvents(),
      planRegisteredEvent(11n),
    ]);
    const draft = await createReadyDraft(router);
    const prepared = await prepareDraftTrigger(router, draft.draftId, testWallet(0));

    // 属主（trigger 创建者 = 草稿创建者）读取 200。
    await expect(router.handle({
      method: "GET",
      pathname: `/product/order-triggers/${prepared.trigger.triggerId}`,
      headers: creatorHeaders(),
    })).resolves.toMatchObject({ status: 200 });

    // 无关会话钱包 403，不回显档案。
    await expect(router.handle({
      method: "GET",
      pathname: `/product/order-triggers/${prepared.trigger.triggerId}`,
      headers: { "x-uvp-wallet-address": testWallet(9) },
    })).resolves.toMatchObject({
      status: 403,
      body: { error: "trigger_access_forbidden" },
    });
  });

  it("settles concurrent prepare-trigger on one record", async () => {
    // 并发双 prepare：前置检查双双通过后，draft_id 一事一单条件插入
    // 只允许一条落库；败者按赢家记录幂等返回，不得撞 UNIQUE 变 500。
    const { router, productStore } = await createRouterFixture([
      ...activeDeploymentEvents(),
      planRegisteredEvent(11n),
    ]);
    const draft = await createReadyDraft(router);

    const [first, second] = await Promise.all([
      router.handle({
        method: "POST",
        pathname: `/product/order-drafts/${draft.draftId}/prepare-trigger`,
        body: { walletAddress: testWallet(0) }
      }),
      router.handle({
        method: "POST",
        pathname: `/product/order-drafts/${draft.draftId}/prepare-trigger`,
        body: { walletAddress: testWallet(0) }
      })
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstTrigger = (first.body as PreparedTriggerResponse).trigger;
    const secondTrigger = (second.body as PreparedTriggerResponse).trigger;
    expect(secondTrigger.triggerId).toBe(firstTrigger.triggerId);
    await expect(productStore.listRegistrations()).resolves.toHaveLength(1);
  });

  it("issues non-enumerable trigger ids", async () => {    // 会话门已就位，id 熵是残余面：triggerId 必须携带 128 位随机后缀，
    // 相邻草稿的两个 id 之间不存在顺序推导关系。
    const { router } = await createRouterFixture([
      ...activeDeploymentEvents(),
      planRegisteredEvent(11n),
    ]);
    const triggerIds: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      const draft = await createReadyDraft(router);
      const prepareResponse = await router.handle({
        method: "POST",
        pathname: `/product/order-drafts/${draft.draftId}/prepare-trigger`,
        body: { walletAddress: testWallet(0) },
      });
      expect(prepareResponse.status, JSON.stringify(prepareResponse.body)).toBe(200);
      const trigger = (prepareResponse.body as SubmitProductOrderDraftResult).trigger;
      expect(trigger.triggerId).toMatch(/^trigger_[0-9a-f]{8}_\d{6}_[0-9a-f]{32}$/);
      triggerIds.push(trigger.triggerId);
    }
    // 两个 id 的随机后缀互不相同——顺序段（scope 内自增）不可枚举。
    const suffix = (id: string) => id.split("_").at(-1);
    expect(suffix(triggerIds[0]!)).not.toBe(suffix(triggerIds[1]!));
  });

  it("only lets the trigger stage executor prepare outside trigger typed data", async () => {
    const { router } = await createRouterFixture([
      ...activeDeploymentEvents(),
      planRegisteredEvent(11n),
    ]);
    const draft = await createReadyDraft(router);

    const wrongExecutorResponse = await router.handle({
      method: "POST",
      pathname: `/product/order-drafts/${draft.draftId}/prepare-trigger`,
      body: { walletAddress: testWallet(1) },
    });
    expect(wrongExecutorResponse.status).toBe(403);
    // details 不携带 expectedWalletAddress/walletAddress：403 回显执行者
    // 钱包曾是"先打 403 拿地址再冒名重放"的绕过面（钱包身份现由会话锚定）。
    expect(wrongExecutorResponse.body).toMatchObject({
      error: "trigger_submitter_not_authorized",
      details: {
        roleSlotId: "funds",
      },
    });
    const wrongDetails = (wrongExecutorResponse.body as { details: Record<string, unknown> }).details;
    expect(wrongDetails).not.toHaveProperty("expectedWalletAddress");
    expect(wrongDetails).not.toHaveProperty("walletAddress");

    const executorResponse = await router.handle({
      method: "POST",
      pathname: `/product/order-drafts/${draft.draftId}/prepare-trigger`,
      body: { walletAddress: testWallet(0) },
    });
    expect(executorResponse.status).toBe(200);
  });

  it("broadcasts trigger only with a valid prepared wallet signature", async () => {
    const { router, triggerAdapter } = await createRouterFixture([
      ...activeDeploymentEvents(),
      planRegisteredEvent(11n),
    ]);
    const draft = await createReadyDraft(router);
    const prepared = await prepareDraftTrigger(
      router,
      draft.draftId,
      testWallet(0),
    );

    const noSignature = await router.handle({
      method: "POST",
      pathname: `/product/order-drafts/${draft.draftId}/trigger`,
      body: {
        prepareId: prepared.prepared.prepareId,
        walletAddress: testWallet(0),
      },
    });
    expect(noSignature.status).toBe(400);

    const wrongSignature = await router.handle({
      method: "POST",
      pathname: `/product/order-drafts/${draft.draftId}/trigger`,
      body: {
        prepareId: prepared.prepared.prepareId,
        walletAddress: testWallet(0),
        signature: "0x1234",
      },
    });
    expect(wrongSignature.status).toBe(400);
    expect(triggerAdapter.listAttempts()).toHaveLength(0);
  });

  it("triggers the order atomically from signed outside trigger data", async () => {
    const triggerAdapter = new ScriptedOutcomeTriggerAdapter({
      status: "confirmed",
      txHash: "0x4242424242424242424242424242424242424242424242424242424242424242",
      blockNumber: "42",
      retryable: false,
    });
    const { router } = await createRouterFixture(
      [...activeDeploymentEvents(), planRegisteredEvent(11n)],
      triggerAdapter,
    );
    const draft = await createReadyDraft(router);

    const prepared = await prepareDraftTrigger(
      router,
      draft.draftId,
      testWallet(0),
    );
    const trigger = await triggerPreparedDraft(
      router,
      draft.draftId,
      prepared,
      testWallet(0),
    );
    const [attempt] = triggerAdapter.listAttempts();

    expect(trigger.trigger).toMatchObject({
      deploymentId: activeDeploymentId,
      stateMachineAddress: activeStateMachineAddress,
      status: "confirmed",
      blockNumber: "42",
    });
    expect(trigger.draft).toMatchObject({
      status: "triggered",
      triggeredOrderId: trigger.trigger.orderId,
      triggerTxHash: trigger.trigger.txHash,
    });
    expect(attempt).toMatchObject({
      deploymentId: activeDeploymentId,
      stateMachineAddress: activeStateMachineAddress,
      orderId: prepared.trigger.orderId,
      planId: prepared.trigger.planId,
      submitter: testWallet(0),
      signature: expect.stringMatching(/^0x[0-9a-f]+$/),
    });
    expect(attempt!.authorizations).toHaveLength(trigger.permissions.length);
  });

  it("fails the trigger without broadcasting when the plan vocabulary snapshot is marked failed", async () => {
    // 解析故障 ≠ 无词表（trigger 车道贯穿）：resolver 故障轮的 plan 快照
    // 富集态为 failed 时，出生事实属主自证的词表读取抛错，registration 落
    // failed+retryable（capability_tables_unavailable）——不广播必被链上
    // 词表闸拒绝的交易（白烧代付 gas）；恢复轮次快照回到可用态后重试即可。
    const triggerAdapter = new ScriptedOutcomeTriggerAdapter({
      status: "confirmed",
      txHash: "0x4242424242424242424242424242424242424242424242424242424242424242",
      blockNumber: "42",
      retryable: false,
    });
    const { router, store, productStore } = await createRouterFixture(
      [...activeDeploymentEvents(), planRegisteredEvent(11n)],
      triggerAdapter,
    );
    const draft = await createReadyDraft(router);
    const prepared = await prepareDraftTrigger(router, draft.draftId, testWallet(0));

    // 模拟 resolver 故障轮后的投影快照：同一事件集 + failed 富集态。
    await store.resetFromEvents({
      deploymentBlock: 0n,
      events: [...activeDeploymentEvents(), planRegisteredEvent(11n)],
      planCapabilityResolutionFailures: [crossBorderPlanIds.planId],
    });

    const account = privateKeyToAccount(
      testPrivateKey(walletAddressIndex(testWallet(0))),
    );
    const signature = await account.signTypedData(
      prepared.prepared.typedData as Parameters<typeof account.signTypedData>[0],
    );
    const trigger = await router.handle({
      method: "POST",
      pathname: `/product/order-drafts/${draft.draftId}/trigger`,
      body: {
        prepareId: prepared.prepared.prepareId,
        walletAddress: testWallet(0),
        signature,
      },
    });

    // 失败广播以 502 响亮失败（errorCode 透传），registration 落
    // failed+retryable 供恢复后重试——与广播适配器故障同档案面。
    expect(trigger).toMatchObject({
      status: 502,
      body: { error: "capability_tables_unavailable" },
    });
    expect(triggerAdapter.listAttempts()).toHaveLength(0);
    await expect(
      productStore.getRegistration(prepared.trigger.triggerId),
    ).resolves.toMatchObject({
      status: "failed",
      errorCode: "capability_tables_unavailable",
      retryable: true,
    });
  });

  it("retries a retryable tx-less trigger failure by replaying the same identity (one order per draft)", async () => {
    // UB-3「重试=同身份重放」：首触发以 rpc 超时形态失败（retryable、
    // 无 txHash）后，同 draft 的 re-prepare 必须复用既有行的
    // prepareId/payloadHash/orderId——payloadHash 掺新 prepareId 会派生
    // 新 chainOrderId，同一稿两笔链上订单（一事两单）。重开只重置
    // preparedAt 时钟与 deadline，createdAt 保留审计。
    const retryableTimeout: ProductOrderTriggerBroadcastResult = {
      status: "failed",
      errorCode: "rpc_timeout",
      errorMessage: "RPC request timed out while broadcasting the trigger",
      retryable: true,
    };
    const confirmed: ProductOrderTriggerBroadcastResult = {
      status: "confirmed",
      txHash: "0x4242424242424242424242424242424242424242424242424242424242424242",
      blockNumber: "42",
      retryable: false,
    };
    const triggerAdapter = new SequencedOutcomeTriggerAdapter([retryableTimeout, confirmed]);
    const { router, productStore } = await createRouterFixture(
      [...activeDeploymentEvents(), planRegisteredEvent(11n)],
      triggerAdapter,
    );
    const draft = await createReadyDraft(router);
    const first = await prepareDraftTrigger(router, draft.draftId, testWallet(0));
    const firstRegistration = await productStore.getRegistration(
      first.trigger.triggerId,
    );

    const failedTrigger = await triggerPreparedDraftRaw(
      router,
      draft.draftId,
      first,
      testWallet(0),
    );
    expect(failedTrigger).toMatchObject({
      status: 502,
      body: { error: "rpc_timeout" },
    });
    await expect(
      productStore.getRegistration(first.trigger.triggerId),
    ).resolves.toMatchObject({
      status: "failed",
      errorCode: "rpc_timeout",
      retryable: true,
    });
    // 无 txHash 的失败行才可重开：失败档不得携带 txHash。
    const failedRegistration = await productStore.getRegistration(
      first.trigger.triggerId,
    );
    expect(failedRegistration?.txHash).toBeUndefined();

    // 同 draft 重试：同身份重放，不再生 prepareId/payloadHash/orderId。
    const retried = await prepareDraftTrigger(router, draft.draftId, testWallet(0));
    const retriedRegistration = await productStore.getRegistration(
      first.trigger.triggerId,
    );
    expect(retried.prepared.prepareId).toBe(first.prepared.prepareId);
    expect(retried.trigger.triggerId).toBe(first.trigger.triggerId);
    expect(retried.trigger.orderId).toBe(first.trigger.orderId);
    expect(retriedRegistration).toMatchObject({
      status: "prepared",
      prepareId: firstRegistration!.prepareId,
      payloadHash: firstRegistration!.payloadHash,
      idempotencyKey: firstRegistration!.idempotencyKey,
      orderId: firstRegistration!.orderId,
      // createdAt 继承旧行（审计），preparedAt/updatedAt 重置为重开时点。
      createdAt: firstRegistration!.createdAt,
    });
    expect(Date.parse(retriedRegistration!.preparedAt ?? "")).toBeGreaterThanOrEqual(
      Date.parse(firstRegistration!.createdAt),
    );

    // 重放后的触发走同一 prepareId/同一身份，链上收敛为同一订单。
    const triggered = await triggerPreparedDraft(
      router,
      draft.draftId,
      retried,
      testWallet(0),
    );
    expect(triggered.trigger).toMatchObject({
      status: "confirmed",
      orderId: first.trigger.orderId,
      txHash: confirmed.txHash,
    });
    expect(triggerAdapter.listAttempts()).toHaveLength(2);
    expect(
      triggerAdapter.listAttempts().map((attempt) => attempt.orderId),
    ).toEqual([first.trigger.orderId, first.trigger.orderId]);
  });

  it("refuses to reopen a failed trigger that carries a txHash (reconcile owns the record)", async () => {
    // UA-2/UB-3：带 txHash 的失败行永不重开——链上已有可探事实，回执/
    // 投影复核（对账接管）是其唯一收敛车道。re-prepare 与直提重放都被
    // 确定性拒绝，不得再生身份（新 payloadHash → 新 chainOrderId）。
    const triggerAdapter = new ScriptedOutcomeTriggerAdapter({
      status: "failed",
      errorCode: "transaction_receipt_unknown",
      errorMessage: "transaction receipt is missing or has an unknown status",
      txHash: "0x4343434343434343434343434343434343434343434343434343434343434343",
      retryable: true,
    });
    const { router, productStore } = await createRouterFixture(
      [...activeDeploymentEvents(), planRegisteredEvent(11n)],
      triggerAdapter,
    );
    const draft = await createReadyDraft(router);
    const prepared = await prepareDraftTrigger(router, draft.draftId, testWallet(0));
    const failedTrigger = await triggerPreparedDraftRaw(
      router,
      draft.draftId,
      prepared,
      testWallet(0),
    );
    expect(failedTrigger).toMatchObject({
      status: 502,
      body: { error: "transaction_receipt_unknown" },
    });
    await expect(
      productStore.getRegistration(prepared.trigger.triggerId),
    ).resolves.toMatchObject({
      status: "failed",
      retryable: true,
      txHash: "0x4343434343434343434343434343434343434343434343434343434343434343",
    });

    const rePrepare = await router.handle({
      method: "POST",
      pathname: `/product/order-drafts/${draft.draftId}/prepare-trigger`,
      body: { walletAddress: testWallet(0) },
    });
    expect(rePrepare).toMatchObject({
      status: 409,
      body: { error: "trigger_already_exists" },
    });

    const replay = await triggerPreparedDraftRaw(
      router,
      draft.draftId,
      prepared,
      testWallet(0),
    );
    expect(replay).toMatchObject({
      status: 409,
      body: { error: "trigger_not_prepared" },
    });
    // 只有一次真实广播：被拒的重开没有再生任何链上尝试。
    expect(triggerAdapter.listAttempts()).toHaveLength(1);
  });

  it("rejects reusing a failed trigger identity when the retrying wallet is not the original submitter", async () => {
    // payload 变化不是重试：身份键掺 submitter，换了签名钱包的"重试"
    // 只能显式走新意图（新 draft）——复用旧行身份会签出另一份
    // payload/授权面却指向同一 draft 的混乱状态。行内 submitter 漂移
    // （执行者钱包更换等历史形态）时 prepare 必须响亮拒绝。
    const triggerAdapter = new ScriptedOutcomeTriggerAdapter({
      status: "failed",
      errorCode: "rpc_timeout",
      errorMessage: "RPC request timed out while broadcasting the trigger",
      retryable: true,
    });
    const { router, productStore } = await createRouterFixture(
      [...activeDeploymentEvents(), planRegisteredEvent(11n)],
      triggerAdapter,
    );
    const draft = await createReadyDraft(router);
    const prepared = await prepareDraftTrigger(router, draft.draftId, testWallet(0));
    await triggerPreparedDraftRaw(
      router,
      draft.draftId,
      prepared,
      testWallet(0),
    );
    // 模拟执行者钱包更换后的旧行漂移：行内 submitter 已非当前触发
    // 执行者钱包（其余身份字段不变）。
    const drifted = await productStore.getRegistration(prepared.trigger.triggerId);
    await productStore.updateRegistration({
      ...drifted!,
      submitter: testWallet(9) as Address,
    });

    const retry = await router.handle({
      method: "POST",
      pathname: `/product/order-drafts/${draft.draftId}/prepare-trigger`,
      body: { walletAddress: testWallet(0) },
    });
    expect(retry).toMatchObject({
      status: 409,
      body: {
        error: "trigger_retry_payload_changed",
        details: { triggerId: prepared.trigger.triggerId },
      },
    });
  });

  it("refuses edits to a draft that has entered the trigger lifecycle", async () => {
    // 触发负载（payloadHash/授权）在 prepare 时点由草稿快照定形：终态
    //（triggered）与在途（triggering）的稿行是"链上订单从何而来"的档案，
    // 编辑必须确定性拒绝——静默接受会割裂档案与已签名/已广播负载。
    const triggerAdapter = new ScriptedOutcomeTriggerAdapter({
      status: "confirmed",
      txHash: "0x4242424242424242424242424242424242424242424242424242424242424242",
      blockNumber: "42",
      retryable: false,
    });
    const { router, productStore } = await createRouterFixture(
      [...activeDeploymentEvents(), planRegisteredEvent(11n)],
      triggerAdapter,
    );
    const draft = await createReadyDraft(router);
    const prepared = await prepareDraftTrigger(router, draft.draftId, testWallet(0));
    await triggerPreparedDraft(router, draft.draftId, prepared, testWallet(0));

    const edited = await router.handle({
      method: "PATCH",
      pathname: `/product/order-drafts/${draft.draftId}`,
      headers: creatorHeaders(),
      body: { title: "renamed after trigger" },
    });
    expect(edited).toMatchObject({ status: 409, body: { error: "draft_not_editable" } });
    await expect(productStore.getDraft(draft.draftId)).resolves.toMatchObject({
      status: "triggered",
      title: draft.title,
    });

    // 在途（triggering）同口径拒绝：不等 CAS 竞态兜底，静态拒绝先行。
    const inFlight = await createReadyDraft(router);
    const current = await productStore.getDraft(inFlight.draftId);
    await productStore.updateDraft({ ...current!, status: "triggering" });
    const inFlightEdit = await router.handle({
      method: "PATCH",
      pathname: `/product/order-drafts/${inFlight.draftId}`,
      headers: creatorHeaders(),
      body: { title: "renamed while triggering" },
    });
    expect(inFlightEdit).toMatchObject({ status: 409, body: { error: "draft_not_editable" } });
  });

  it("serializes concurrent trigger submissions per order so the broadcast fires exactly once", async () => {
    // triggerOrder 的状态检查与
    // "置 submitted + 广播"之间隔了 await——并发提交同一 draft 会双双通过
    // 检查并各自广播同一触发交易。per-order 互斥串行化后，第二个调用者
    // 在临界区内重读 registration，自然得到 409 trigger_not_prepared。
    let releaseBroadcast: (() => void) | undefined;
    const broadcastCalls: ProductBroadcastOutsideTriggerInput[] = [];
    const gatingAdapter = new (class extends MemoryProductOrderTriggerBroadcastAdapter {
      override async broadcastOutsideTrigger(
        input: ProductBroadcastOutsideTriggerInput,
      ): Promise<ProductOrderTriggerBroadcastResult> {
        broadcastCalls.push(input);
        await new Promise<void>((resolve) => {
          releaseBroadcast = resolve;
        });
        return {
          status: "confirmed",
          txHash:
            "0x4242424242424242424242424242424242424242424242424242424242424242",
          blockNumber: "42",
          retryable: false,
        };
      }
    })();
    const { router } = await createRouterFixture(
      [...activeDeploymentEvents(), planRegisteredEvent(11n)],
      gatingAdapter,
    );
    const draft = await createReadyDraft(router);
    const prepared = await prepareDraftTrigger(router, draft.draftId, testWallet(0));
    const account = privateKeyToAccount(
      testPrivateKey(walletAddressIndex(testWallet(0))),
    );
    const signature = await account.signTypedData(
      prepared.prepared.typedData as Parameters<typeof account.signTypedData>[0],
    );
    const triggerBody = {
      prepareId: prepared.prepared.prepareId,
      walletAddress: testWallet(0),
      signature,
    };

    // 两个并发提交：第一个进入广播并挂起，第二个被互斥挡在临界区外。
    const firstCall = router.handle({
      method: "POST",
      pathname: `/product/order-drafts/${draft.draftId}/trigger`,
      body: triggerBody,
    });
    for (let attempt = 0; attempt < 100 && broadcastCalls.length < 1; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(broadcastCalls).toHaveLength(1);
    const secondCall = router.handle({
      method: "POST",
      pathname: `/product/order-drafts/${draft.draftId}/trigger`,
      body: triggerBody,
    });
    releaseBroadcast?.();

    const [first, second] = await Promise.all([firstCall, secondCall]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ error: "trigger_not_prepared" });
    // 广播只发生一次：没有第二次链上触发交易。
    expect(broadcastCalls).toHaveLength(1);
  });

  it("rejects client-supplied authorization tables in prepare and trigger", async () => {
    const { router, triggerAdapter } = await createRouterFixture([
      ...activeDeploymentEvents(),
      planRegisteredEvent(11n),
    ]);
    const draft = await createReadyDraft(router);

    const prepareResponse = await router.handle({
      method: "POST",
      pathname: `/product/order-drafts/${draft.draftId}/prepare-trigger`,
      body: {
        walletAddress: testWallet(0),
        authorizations: [],
      },
    });
    expect(prepareResponse.status).toBe(400);
    expect(prepareResponse.body).toMatchObject({
      error: "client_authorizations_not_allowed",
    });

    const prepared = await prepareDraftTrigger(
      router,
      draft.draftId,
      testWallet(0),
    );
    const triggerResponse = await router.handle({
      method: "POST",
      pathname: `/product/order-drafts/${draft.draftId}/trigger`,
      body: {
        prepareId: prepared.prepared.prepareId,
        walletAddress: testWallet(0),
        signature: "0x1234",
        permissions: [],
      },
    });
    expect(triggerResponse.status).toBe(400);
    expect(triggerAdapter.listAttempts()).toHaveLength(0);
  });

  it("generates stable server-side signal authorizations", async () => {
    const first = await submitReadyDraft();
    const second = await submitReadyDraft();

    expect(first.authorizations).toEqual(second.authorizations);
    expect(stablePermissionShape(first.permissions)).toEqual(
      stablePermissionShape(second.permissions),
    );
    expect(first.authorizations.length).toBeGreaterThan(0);
    expect(first.permissions).toHaveLength(first.authorizations.length);
    expect(
      first.permissions.every(
        (permission) =>
          permission.draftId.length > 0 &&
          typeof permission.orderId === "string" &&
          /^0x[0-9a-f]{64}$/.test(permission.orderId) &&
          permission.participantId.length > 0,
      ),
    ).toBe(true);
    expect(
      first.authorizations.every(
        (authorization) =>
          /^0x[0-9a-f]{64}$/.test(authorization.sourceId) &&
          /^0x[0-9a-f]{64}$/.test(authorization.signalId) &&
          /^0x[0-9a-f]{40}$/.test(authorization.submitter) &&
          /^0x[0-9a-f]{64}$/.test(authorization.role) &&
          /^0x[0-9a-f]{64}$/.test(authorization.metadataHash),
      ),
    ).toBe(true);
  });

  it("generates explicit stage patch authorizations from add-on actions", () => {
    const input = customsAuthorizationBuildInput();
    const result = new ProductAuthorizationBuilder().build(input);
    const selectorWallet = testWallet(0);
    const resourcePatchWallet = testWallet(1);
    const selectorHook = requiredCustomsHook(
      customsStageIds.buyerSelectCustomsExecutor,
    );
    const resourcePatchHook = requiredCustomsHook(
      customsStageIds.buyerPublishCustomsResources,
    );

    expect(result.authorizations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceId: selectorHook.stageId,
          signalId: STAGE_EXECUTOR_PATCH_SIGNAL_ID,
          submitter: selectorWallet,
        }),
        expect.objectContaining({
          sourceId: resourcePatchHook.stageId,
          signalId: STAGE_RESOURCE_PATCH_SIGNAL_ID,
          submitter: resourcePatchWallet,
        }),
      ]),
    );
    expect(result.permissions).toContainEqual(
      expect.objectContaining({
        permissionId: "customs.executor-patch",
        roleSlotId: customsRoleSlotIds.buyerSelector,
        submitterAddress: selectorWallet,
      }),
    );
    expect(result.permissions).toContainEqual(
      expect.objectContaining({
        permissionId: "customs.resource-patch",
        roleSlotId: customsRoleSlotIds.buyerResourceController,
        submitterAddress: resourcePatchWallet,
      }),
    );
  });

  it("does not derive stage patch authorizations without an explicit add-on action manifest", () => {
    const input = customsAuthorizationBuildInput({
      omitAddOnManifestForRoleSlot: customsRoleSlotIds.buyerSelector,
    });
    const result = new ProductAuthorizationBuilder().build(input);
    const selectorHook = requiredCustomsHook(
      customsStageIds.buyerSelectCustomsExecutor,
    );
    const resourcePatchHook = requiredCustomsHook(
      customsStageIds.buyerPublishCustomsResources,
    );

    expect(result.authorizations).not.toContainEqual(
      expect.objectContaining({
        sourceId: selectorHook.stageId,
        signalId: STAGE_EXECUTOR_PATCH_SIGNAL_ID,
        submitter: testWallet(0),
      }),
    );
    expect(result.authorizations).toContainEqual(
      expect.objectContaining({
        sourceId: resourcePatchHook.stageId,
        signalId: STAGE_RESOURCE_PATCH_SIGNAL_ID,
        submitter: testWallet(1),
      }),
    );
  });

  it("fails authorization when a stage patch role has no accepted participant", () => {
    const input = customsAuthorizationBuildInput();

    expectAuthorizationError(
      {
        ...input,
        participants: input.participants.filter(
          (participant) =>
            participant.roleSlotId !== customsRoleSlotIds.buyerSelector,
        ),
      },
      "required_role_missing",
    );
  });

  it("builds order authorizations from explicit permission rows instead of role text aliases", () => {
    const input = authorizationBuildInput();
    const builder = new ProductAuthorizationBuilder();
    const baseline = builder.build(input);
    const renamedInput = {
      ...input,
      zhixu: {
        ...input.zhixu,
        stages: input.zhixu.stages.map((stage) => ({
          ...stage,
          ownerRole: `unmatched owner ${stage.stageId}`,
        })),
      },
      participants: input.participants.map((participant) => ({
        ...participant,
        roleLabel: `unmatched label ${participant.roleSlotId}`,
        displayName: `unmatched display ${participant.roleSlotId}`,
      })),
    };

    expect(builder.build(renamedInput)).toEqual(baseline);
  });

  it("fails authorization build before submit when explicit permission rows are incomplete", () => {
    const input = authorizationBuildInput();

    expectAuthorizationError(
      {
        ...input,
        zhixu: { ...input.zhixu, orderPermissionTable: [] },
      },
      "permission_table_missing",
    );
    expectAuthorizationError(
      {
        ...input,
        zhixu: {
          ...input.zhixu,
          orderPermissionTable: input.zhixu.orderPermissionTable.map((entry) =>
            entry.permissionId === "stage.order-confirmed.confirm_stage"
              ? { ...entry, roleSlotId: "missing-role" }
              : entry,
          ),
        },
      },
      "permission_role_not_found",
    );
    expectAuthorizationError(
      {
        ...input,
        zhixu: {
          ...input.zhixu,
          orderPermissionTable: input.zhixu.orderPermissionTable.map((entry) =>
            entry.permissionId === "stage.order-confirmed.confirm_stage"
              ? { ...entry, stageId: "missing-stage" }
              : entry,
          ),
        },
      },
      "permission_stage_not_found",
    );
    expectAuthorizationError(
      {
        ...input,
        participants: input.participants.filter(
          (participant) => participant.roleSlotId !== "funds",
        ),
      },
      "required_role_missing",
    );
    expectAuthorizationError(
      {
        ...input,
        zhixu: {
          ...input.zhixu,
          orderPermissionTable: [
            ...input.zhixu.orderPermissionTable,
            {
              ...input.zhixu.orderPermissionTable.find(
                (entry) =>
                  entry.permissionId === "stage.order-confirmed.confirm_stage",
              )!,
              permissionId: "stage.order-confirmed.confirm_stage.duplicate",
            },
          ],
        },
      },
      "permission_authorization_duplicate",
    );
  });

  it("keeps a concurrent trigger transition when the derived draft refresh races it", async () => {
    // 草稿派生状态重算（refreshDraftStatus）读到旧快照后，并发触发车道
    // 把稿翻成 triggering：重算的整行覆盖不得把 triggering 盖回
    // awaiting/ready——条件更新败者回读最新档。
    const backing = new MemoryProductBffStore();
    const projection = new MemoryProjectionStore();
    await projection.resetFromEvents({
      deploymentBlock: 0n,
      events: [...activeDeploymentEvents(), planRegisteredEvent(11n)],
    });
    // listParticipants 是重算读取参与者的必经点：armed 时在委派后同步把
    // 真实行翻 triggering，精确落在"快照已读、覆盖未落"的窗口内。
    let armed = false;
    const racingStore: ProductBffStore = {
      ...delegatingProductBffStore(backing),
      async listParticipants(draftId) {
        const participants = await backing.listParticipants(draftId);
        if (armed) {
          armed = false;
          const draft = await backing.getDraft(draftId);
          if (draft && draft.status !== "triggering") {
            await backing.updateDraft({ ...draft, status: "triggering" });
          }
        }
        return participants;
      },
    };
    const router = createApiRouter(projection, {
      productSchemaResolver: crossBorderSchemaResolver(),
      submissionChainId: 84532,
      submissionVerifyingContract: "0x1111111111111111111111111111111111111111",
      productRuntimeEnvironment: "local",
      productRegistrationAdapter: new MemoryProductOrderTriggerBroadcastAdapter(),
      productBffStore: racingStore,
    });
    const draft = (await createDraft(router).then((r) => r.body as DraftResponse)).draft;
    const [firstParticipant] = await listParticipants(router, draft.draftId);
    const invitation = await createInvite(
      router,
      draft.draftId,
      firstParticipant!.roleSlotId,
      "race@example.com",
    );

    armed = true;
    const accepted = await router.handle({
      method: "POST",
      pathname: `/product/invites/${invitation.invite.inviteId}/accept`,
      headers: { "x-uvp-wallet-address": testWallet(0) },
      body: {
        displayName: "racing participant",
        walletAddress: testWallet(0),
        contact: "race@example.com",
        token: invitation.inviteToken,
      },
    });
    expect(accepted.status).toBe(200);
    expect((accepted.body as InviteResponse).draft.status).toBe("triggering");
    await expect(backing.getDraft(draft.draftId)).resolves.toMatchObject({
      status: "triggering",
    });
  });

  it("refuses a stale full-row draft edit that would clobber a concurrent transition", async () => {
    // 编辑是整行覆盖写：读到快照后稿已被触发车道迁移时，旧快照整行不得
    // 落库——条件更新败者按 409 拒绝，调用方回读重试。
    const backing = new MemoryProductBffStore();
    const projection = new MemoryProjectionStore();
    await projection.resetFromEvents({
      deploymentBlock: 0n,
      events: [...activeDeploymentEvents(), planRegisteredEvent(11n)],
    });
    // 编辑器下一次 getDraft 返回翻转前的旧快照，并在返回的同时把真实行
    // 翻 triggering——精确落在"编辑器已读快照、覆盖未落"的窗口内。
    let staleReadPending = false;
    const racingStore: ProductBffStore = {
      ...delegatingProductBffStore(backing),
      async getDraft(draftId) {
        const draft = await backing.getDraft(draftId);
        if (staleReadPending && draft) {
          staleReadPending = false;
          await backing.updateDraft({ ...draft, status: "triggering" });
        }
        return draft;
      },
    };
    const router = createApiRouter(projection, {
      productSchemaResolver: crossBorderSchemaResolver(),
      submissionChainId: 84532,
      submissionVerifyingContract: "0x1111111111111111111111111111111111111111",
      productRuntimeEnvironment: "local",
      productRegistrationAdapter: new MemoryProductOrderTriggerBroadcastAdapter(),
      productBffStore: racingStore,
    });
    const draft = (await createDraft(router).then((r) => r.body as DraftResponse)).draft;

    staleReadPending = true;
    const edited = await router.handle({
      method: "PATCH",
      pathname: `/product/order-drafts/${draft.draftId}`,
      headers: creatorHeaders(),
      body: { title: "renamed after trigger" },
    });
    expect(edited).toMatchObject({ status: 409, body: { error: "draft_conflict" } });
    await expect(backing.getDraft(draft.draftId)).resolves.toMatchObject({
      status: "triggering",
      title: draft.title,
    });
  });
});

/**
 * postgres 事务 abort 语义桩：事务内任一语句以约束错误失败后，同一事务
 * 的后续语句一律以 25P02 InFailedSqlTransaction 失败，直到事务结束
 * （回滚）；事务外的读写不受影响。armStaleSnapshotReads 让事务外的
 * listParticipants 接下来 n 次返回空快照，模拟并发窗口里前置查重读旧
 * 数据、冲突裁决落到存储层约束的竞态路径（须在构造完测试数据后再武装，
 * 避免误伤建单/邀请的 setup 读）。
 */
function postgresAbortSemanticsStore(
  backing: MemoryProductBffStore,
): ProductBffStore & { armStaleSnapshotReads(count: number): void } {
  let inTransaction = false;
  let aborted = false;
  let staleReadsRemaining = 0;
  const guarded = <Args extends unknown[], Result>(
    method: (...args: Args) => Promise<Result>,
  ) => {
    return async (...args: Args): Promise<Result> => {
      if (inTransaction && aborted) {
        throw new Error(
          "current transaction is aborted, commands ignored until end of transaction block",
        );
      }
      try {
        return await method(...args);
      } catch (error) {
        if (inTransaction && error instanceof StorageConstraintError) {
          aborted = true;
        }
        throw error;
      }
    };
  };
  const listParticipants = async (draftId: string) => {
    if (inTransaction && aborted) {
      throw new Error(
        "current transaction is aborted, commands ignored until end of transaction block",
      );
    }
    if (!inTransaction && staleReadsRemaining > 0) {
      staleReadsRemaining -= 1;
      return [];
    }
    return backing.listParticipants(draftId);
  };
  return {
    armStaleSnapshotReads: (count: number) => {
      staleReadsRemaining = count;
    },
    withTransaction: async <T>(operation: () => Promise<T>): Promise<T> => {
      inTransaction = true;
      aborted = false;
      try {
        return await operation();
      } finally {
        // 事务结束（COMMIT 或 ROLLBACK）：aborted 状态随事务消失，
        // 事务外的新读恢复正常——这是竞态败者回读占用详情的位置。
        inTransaction = false;
        aborted = false;
      }
    },
    createDraft: guarded(backing.createDraft.bind(backing)),
    getDraft: guarded(backing.getDraft.bind(backing)),
    updateDraft: guarded(backing.updateDraft.bind(backing)),
    updateDraftIfStatus: guarded(backing.updateDraftIfStatus.bind(backing)),
    listParticipants,
    listAcceptedParticipantsByWallet: guarded(
      backing.listAcceptedParticipantsByWallet.bind(backing),
    ),
    getParticipant: guarded(backing.getParticipant.bind(backing)),
    updateParticipant: guarded(backing.updateParticipant.bind(backing)),
    createInviteIfNoneActive: guarded(backing.createInviteIfNoneActive.bind(backing)),
    getInvite: guarded(backing.getInvite.bind(backing)),
    updateInvite: guarded(backing.updateInvite.bind(backing)),
    updateInviteIfActive: guarded(backing.updateInviteIfActive.bind(backing)),
    listInvitesByDraft: guarded(backing.listInvitesByDraft.bind(backing)),
    createRegistrationIfNoneForDraft: guarded(
      backing.createRegistrationIfNoneForDraft.bind(backing),
    ),
    getRegistration: guarded(backing.getRegistration.bind(backing)),
    getRegistrationByDraft: guarded(backing.getRegistrationByDraft.bind(backing)),
    listRegistrations: guarded(backing.listRegistrations.bind(backing)),
    updateRegistration: guarded(backing.updateRegistration.bind(backing)),
  };
}

/** 全量委派 backing 的 ProductBffStore 桩（个别方法按测试需要覆盖）。 */
function delegatingProductBffStore(backing: MemoryProductBffStore): ProductBffStore {  return {
    createDraft: (draft, participants) => backing.createDraft(draft, participants),
    getDraft: (draftId) => backing.getDraft(draftId),
    updateDraft: (draft) => backing.updateDraft(draft),
    updateDraftIfStatus: (draft, expected) => backing.updateDraftIfStatus(draft, expected),
    listParticipants: (draftId) => backing.listParticipants(draftId),
    listAcceptedParticipantsByWallet: (walletAddress) => backing.listAcceptedParticipantsByWallet(walletAddress),
    getParticipant: (participantId) => backing.getParticipant(participantId),
    updateParticipant: (participant) => backing.updateParticipant(participant),
    createInviteIfNoneActive: (invite, nowIso) => backing.createInviteIfNoneActive(invite, nowIso),
    getInvite: (inviteId) => backing.getInvite(inviteId),
    updateInvite: (invite) => backing.updateInvite(invite),
    updateInviteIfActive: (invite) => backing.updateInviteIfActive(invite),
    listInvitesByDraft: (draftId) => backing.listInvitesByDraft(draftId),
    createRegistrationIfNoneForDraft: (registration) => backing.createRegistrationIfNoneForDraft(registration),
    getRegistration: (triggerId) => backing.getRegistration(triggerId),
    getRegistrationByDraft: (draftId) => backing.getRegistrationByDraft(draftId),
    listRegistrations: () => backing.listRegistrations(),
    updateRegistration: (registration) => backing.updateRegistration(registration)
  };
}

interface DraftResponse {
  readonly draft: ProductOrderDraftDTO;
  readonly participants: readonly DraftParticipantDTO[];
}

interface InviteResponse {
  readonly invite: ProductInviteDTO;
  readonly participant: DraftParticipantDTO;
  readonly draft: ProductOrderDraftDTO;
  /** createInvite 一次性下发的 invite token。 */
  readonly inviteToken?: string;
}

type RouterFixtureTriggerAdapter =
  | MemoryProductOrderTriggerBroadcastAdapter
  | ScriptedOutcomeTriggerAdapter;

function createRouterFixture(events: readonly ChainEvent[]): Promise<{
  readonly router: ApiRouter;
  readonly store: MemoryProjectionStore;
  readonly productStore: MemoryProductBffStore;
  readonly triggerAdapter: RouterFixtureTriggerAdapter;
}>;

function createRouterFixture(
  events: readonly ChainEvent[],
  triggerAdapter: RouterFixtureTriggerAdapter,
): Promise<{
  readonly router: ApiRouter;
  readonly store: MemoryProjectionStore;
  readonly productStore: MemoryProductBffStore;
  readonly triggerAdapter: RouterFixtureTriggerAdapter;
}>;

async function createRouterFixture(
  events: readonly ChainEvent[],
  triggerAdapter: RouterFixtureTriggerAdapter = new MemoryProductOrderTriggerBroadcastAdapter(),
): Promise<{
  readonly router: ApiRouter;
  readonly store: MemoryProjectionStore;
  readonly productStore: MemoryProductBffStore;
  readonly triggerAdapter: RouterFixtureTriggerAdapter;
}> {
  const store = new MemoryProjectionStore();
  const productStore = new MemoryProductBffStore();
  await store.resetFromEvents({ deploymentBlock: 0n, events });
  return {
    router: createApiRouter(store, { productSchemaResolver: crossBorderSchemaResolver(), submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111",
      // local 显式声明：参与者面 dev 自报头仅在该环境可用（fail-closed）。
      productRuntimeEnvironment: "local",
      productRegistrationAdapter: triggerAdapter,
      productBffStore: productStore,
    }),
    store,
    productStore,
    triggerAdapter,
  };
}

/** 建单者（运营方）的本地 dev 会话头——草稿创建/修改/邀请/名单读取按此锚定。 */
function creatorHeaders(): Record<string, string> {
  return { "x-uvp-wallet-address": testWallet(0) };
}

async function createDraft(router: ApiRouter) {
  return router.handle({
    method: "POST",
    pathname: "/product/order-drafts",
    headers: creatorHeaders(),
    body: {
      zhixuId: CROSS_BORDER_ZHIXU_ID,
      title: "A company purchase",
      businessType: "parallel-export",
      totalAmount: "10000",
      currency: "USDC"
    },
  });
}

async function createReadyDraft(
  router: ApiRouter,
): Promise<ProductOrderDraftDTO> {
  const draft = (
    await createDraft(router).then((response) => response.body as DraftResponse)
  ).draft;
  const participants = await listParticipants(router, draft.draftId);
  const requiredParticipants = participants.filter(
    (participant) => participant.required,
  );
  for (const [index, participant] of requiredParticipants.entries()) {
    await inviteAndAccept(router, draft.draftId, participant.roleSlotId, index);
  }
  const readyResponse = await router.handle({
    method: "GET",
    pathname: `/product/order-drafts/${draft.draftId}`,
    headers: creatorHeaders(),
  });
  expect(readyResponse.status).toBe(200);
  expect((readyResponse.body as DraftResponse).draft.status).toBe(
    "ready_to_trigger",
  );
  return (readyResponse.body as DraftResponse).draft;
}

async function submitReadyDraft(): Promise<{
  readonly authorizations: readonly SignalAuthorizationDTO[];
  readonly permissions: SubmitProductOrderDraftResult["permissions"];
}> {
  const { router, productStore } = await createRouterFixture([
    ...activeDeploymentEvents(),
    planRegisteredEvent(11n),
  ]);
  const draft = await createReadyDraft(router);
  const prepared = await prepareDraftTrigger(
    router,
    draft.draftId,
    testWallet(0),
  );
  const registration = await productStore.getRegistration(
    prepared.trigger.triggerId,
  );
  expect(registration).toBeDefined();
  return {
    authorizations: registration!.authorizations,
    permissions: prepared.permissions,
  };
}

function stablePermissionShape(
  permissions: SubmitProductOrderDraftResult["permissions"],
) {
  return permissions.map((permission) => ({
    payloadPolicy: permission.payloadPolicy,
    permissionId: permission.permissionId,
    roleSlotId: permission.roleSlotId,
    signalName: permission.signalName,
    source: permission.source,
    stageIdentifier: permission.stageIdentifier,
    submitterAddress: permission.submitterAddress,
  }));
}

interface PreparedTriggerResponse extends SubmitProductOrderDraftResult {
  readonly prepared: {
    readonly prepareId: string;
    readonly typedData: Record<string, unknown>;
    readonly submitter: string;
  };
}

async function prepareDraftTrigger(
  router: ApiRouter,
  draftId: string,
  walletAddress: string,
): Promise<PreparedTriggerResponse> {
  const response = await router.handle({
    method: "POST",
    pathname: `/product/order-drafts/${draftId}/prepare-trigger`,
    body: { walletAddress },
  });
  expect(response.status).toBe(200);
  return response.body as PreparedTriggerResponse;
}

async function triggerPreparedDraft(
  router: ApiRouter,
  draftId: string,
  prepared: PreparedTriggerResponse,
  walletAddress: string,
): Promise<SubmitProductOrderDraftResult> {
  const response = await triggerPreparedDraftRaw(router, draftId, prepared, walletAddress);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body as SubmitProductOrderDraftResult;
}

/** 触发失败的响亮路径（502 errorCode 透传）：不断言 200，交由用例核对失败面。 */
async function triggerPreparedDraftRaw(
  router: ApiRouter,
  draftId: string,
  prepared: PreparedTriggerResponse,
  walletAddress: string,
): Promise<{ readonly status: number; readonly body: unknown }> {
  const account = privateKeyToAccount(
    testPrivateKey(walletAddressIndex(walletAddress)),
  );
  const signature = await account.signTypedData(
    prepared.prepared.typedData as Parameters<typeof account.signTypedData>[0],
  );
  return router.handle({
    method: "POST",
    pathname: `/product/order-drafts/${draftId}/trigger`,
    body: {
      prepareId: prepared.prepared.prepareId,
      walletAddress,
      signature,
    },
  });
}

async function createInvite(
  router: ApiRouter,
  draftId: string,
  roleSlotId: string,
  contact: string,
  expiresAt?: string,
): Promise<InviteResponse> {
  const response = await router.handle({
    method: "POST",
    pathname: `/product/orders/${draftId}/invites`,
    headers: creatorHeaders(),
    body: {
      roleSlotId,
      contact,
      ...(expiresAt ? { expiresAt } : {}),
    },
  });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body as InviteResponse;
}

async function inviteAndAccept(
  router: ApiRouter,
  draftId: string,
  roleSlotId: string,
  index: number,
): Promise<InviteResponse> {
  const invitation = await createInvite(
    router,
    draftId,
    roleSlotId,
    `${roleSlotId}@example.com`,
  );
  const response = await router.handle({
    method: "POST",
    pathname: `/product/invites/${invitation.invite.inviteId}/accept`,
    headers: { "x-uvp-wallet-address": testWallet(index) },
    body: {
      displayName: `${roleSlotId} participant`,
      walletAddress: testWallet(index),
      contact: `${roleSlotId}@example.com`,
      token: invitation.inviteToken,
    },
  });
  expect(response.status).toBe(200);
  return response.body as InviteResponse;
}

async function listParticipants(
  router: ApiRouter,
  draftId: string,
): Promise<readonly DraftParticipantDTO[]> {
  const response = await router.handle({
    method: "GET",
    pathname: `/product/orders/${draftId}/participants`,
    headers: creatorHeaders(),
  });
  expect(response.status).toBe(200);
  return (response.body as { participants: readonly DraftParticipantDTO[] })
    .participants;
}

function testWallet(index: number): string {
  return privateKeyToAccount(testPrivateKey(index)).address.toLowerCase();
}

function testPrivateKey(index: number): Hex {
  return `0x${(index + 1).toString(16).padStart(64, "0")}` as Hex;
}

function walletAddressIndex(walletAddress: string): number {
  for (let index = 0; index < 10; index++) {
    if (testWallet(index) === walletAddress.toLowerCase()) {
      return index;
    }
  }
  throw new Error(`unknown test wallet ${walletAddress}`);
}

function authorizationBuildInput() {
  const draft: ProductOrderDraftDTO = {
    draftId: "draft_authorization_unit",
    zhixuId: demoZhixuDetail.zhixuId,
    planId: crossBorderPlanIds.planId,
    planHash: crossBorderPlanIds.planHash,
    title: "Authorization unit",
    businessType: "parallel-export",
    goods: [],
    totalAmount: "10000",
    currency: "USDC",
    status: "ready_to_trigger",
    createdAt: "2026-04-29T00:00:00.000Z",
    updatedAt: "2026-04-29T00:00:00.000Z",
  };
  const participants: readonly DraftParticipantDTO[] =
    demoZhixuDetail.roleSlots.map((slot, index) => ({
      participantId: `participant_${slot.slotId}`,
      draftId: draft.draftId,
      roleSlotId: slot.slotId,
      roleLabel: slot.label,
      displayName: slot.title,
      walletAddress: testWallet(index),
      contact: `${slot.slotId}@example.com`,
      status: "accepted" as const,
      required: slot.required,
      acceptedAt: "2026-04-29T00:00:00.000Z",
    }));
  return {
    zhixu: demoZhixuDetail,
    draft,
    participants,
    orderId:
      "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" as const,
    registrarAddress: "0x000000000000000000000000000000000000bff1" as const,
  };
}

function customsAuthorizationBuildInput(
  options: {
    readonly omitAddOnManifestForRoleSlot?: string;
  } = {},
): Parameters<ProductAuthorizationBuilder["build"]>[0] {
  const draft: ProductOrderDraftDTO = {
    draftId: "draft_customs_authorization_unit",
    zhixuId:
      customsStoreProductSchema.zhixuId ?? "customs-completion",
    planId: customsStoreProductSchema.planId as Hex,
    planHash: customsStoreProductSchema.planHash as Hex,
    title: "Customs authorization unit",
    businessType: "customs",
    goods: [],
    totalAmount: "0",
    currency: "USDC",
    status: "ready_to_trigger",
    createdAt: "2026-05-02T00:00:00.000Z",
    updatedAt: "2026-05-02T00:00:00.000Z",
  };
  const roleSlots = customsStoreProductSchema.roleSlots.map((slot) =>
    slot.slotId === options.omitAddOnManifestForRoleSlot
      ? (({ addOnManifest: _addOnManifest, ...withoutManifest }) =>
          withoutManifest)(slot)
      : slot,
  );
  const participants: readonly DraftParticipantDTO[] = roleSlots.map(
    (slot, index) => ({
      participantId: `participant_${slot.slotId}`,
      draftId: draft.draftId,
      roleSlotId: slot.slotId,
      roleLabel: slot.label,
      displayName: slot.title,
      walletAddress: testWallet(index),
      contact: `${slot.slotId}@example.com`,
      status: "accepted" as const,
      required: slot.required,
      acceptedAt: "2026-05-02T00:00:00.000Z",
    }),
  );
  return {
    zhixu: {
      zhixuId: customsStoreProductSchema.zhixuId,
      roleSlots,
      stages: customsStoreProductSchema.stages,
      orderPermissionTable:
        customsStoreProductSchema.orderPermissionTable,
    } as unknown as Parameters<
      ProductAuthorizationBuilder["build"]
    >[0]["zhixu"],
    draft,
    participants,
    orderId:
      "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as const,
    registrarAddress: "0x000000000000000000000000000000000000bff1" as const,
  };
}

function requiredCustomsHook(
  stageIdentifier: string,
): (typeof customsOnchainHookPlanArtifact.compiledHooks)[number] {
  const hook = customsOnchainHookPlanArtifact.compiledHooks.find(
    (item) => item.stageIdentifier === stageIdentifier,
  );
  if (!hook) {
    throw new Error(`missing customs hook for ${stageIdentifier}`);
  }
  return hook;
}

function expectAuthorizationError(
  input: Parameters<ProductAuthorizationBuilder["build"]>[0],
  code: string,
): void {
  try {
    new ProductAuthorizationBuilder().build(input);
    throw new Error("expected ProductAuthorizationBuilderError");
  } catch (error) {
    expect(error).toBeInstanceOf(ProductAuthorizationBuilderError);
    expect((error as ProductAuthorizationBuilderError).code).toBe(code);
  }
}

function planRegisteredEvent(blockNumber: bigint): ChainEvent {
  return chainEvent(blockNumber, 0, "PlanRegistered", {
    planId: crossBorderPlanIds.planId,
    planHash: crossBorderPlanIds.planHash,
    hookCount: 1n,
  });
}

function activeDeploymentEvents(): readonly ChainEvent[] {
  return [
    chainEvent(
      1n,
      0,
      "DeploymentRegistered",
      {
        deploymentId: activeDeploymentId,
        stateMachine: activeStateMachineAddress,
        artifactHash: crossBorderPlanIds.artifactHash,
        abiHash: metadataHash,
        deploymentBlock: 1n,
        metadataURI: "uvp-eth://deployments/v2",
      },
      deploymentRegistryAddress,
    ),
    chainEvent(
      2n,
      0,
      "DeploymentCanaryMarked",
      {
        deploymentId: activeDeploymentId,
        evidenceHash: metadataHash,
        evidenceURI: "uvp-eth://evidence/v2",
      },
      deploymentRegistryAddress,
    ),
    chainEvent(
      3n,
      0,
      "DeploymentActivated",
      {
        previousDeploymentId:
          "0x0000000000000000000000000000000000000000000000000000000000000000",
        newDeploymentId: activeDeploymentId,
        evidenceHash: metadataHash,
        evidenceURI: "uvp-eth://evidence/v2",
      },
      deploymentRegistryAddress,
    ),
  ];
}

function chainEvent(
  blockNumber: bigint,
  logIndex: number,
  eventName: string,
  args: Record<string, unknown>,
  eventContractAddress = contractAddress,
): ChainEvent {
  return {
    chainId: 31337,
    contractAddress: eventContractAddress as ChainEvent["contractAddress"],
    blockNumber,
    transactionHash: `0x${blockNumber.toString(16).padStart(64, "0")}`,
    logIndex,
    eventName,
    args,
  };
}
