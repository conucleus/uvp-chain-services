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
} from "../src/product/bff/authorization.js";
import {
  crossBorderSchemaResolver,
  crossBorderStoreProductSchema,
} from "./cross-border-schema.js";
import { MemoryProductOrderTriggerBroadcastAdapter } from "../src/product/bff/trigger.js";
import type {
  ProductBroadcastOutsideTriggerInput,
  ProductOrderTriggerBroadcastAdapter,
  ProductOrderTriggerBroadcastResult,
} from "../src/product/bff/trigger.js";
import { MemoryStoreZhixuVersionMetadataStore } from "../src/store-console/version.js";
import { MemoryProjectionStore } from "../src/storage/projection-store.js";
import { MemoryProductBffStore } from "../src/product/bff/store.js";
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
} from "../src/product/bff/types.js";
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
    // KEEP（草稿/邀请面鉴权收口）：
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
      // 簇 C 修正：接受方的钱包声明来自 header/query/会话，不再读 body。
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
      method: "GET",
      pathname: `/product/invites/${fundsInvite.invite.inviteId}`,
      headers: { "x-uvp-wallet-address": acceptedWallet },
    });
    expect(previewResponse.status).toBe(200);
    expect(
      (previewResponse.body as { invite: Record<string, unknown> }).invite,
    ).not.toHaveProperty("tokenHash");
    expect(previewResponse.body).toMatchObject({
      invite: { inviteId: fundsInvite.invite.inviteId, status: "active" },
      participant: { roleSlotId: "funds" },
      acceptance: { canAccept: true, status: "can_accept" },
      walletBinding: {
        walletAddress: acceptedWallet,
        alreadyBound: false,
        canAccept: true,
      },
    });

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
        source: "accepted_participant",
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
      method: "GET",
      pathname: `/product/invites/${expiredInvite.invite.inviteId}`,
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
      method: "GET",
      pathname: `/product/invites/${invite.invite.inviteId}`
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
    expect(prepared.trigger.triggerId).toMatch(/^trigger_/);
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
    });
    expect(registrationResponse.status).toBe(200);
    expect(
      (registrationResponse.body as { trigger: ProductOrderTriggerDTO })
        .trigger,
    ).toEqual(prepared.trigger);
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
    expect(wrongExecutorResponse.body).toMatchObject({
      error: "trigger_submitter_not_authorized",
      details: {
        roleSlotId: "funds",
        expectedWalletAddress: testWallet(0),
        walletAddress: testWallet(1),
      },
    });

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

  it("serializes concurrent trigger submissions per order so the broadcast fires exactly once", async () => {
    // 簇 N（BFF 建单触发 per-order 互斥）：triggerOrder 的状态检查与
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
});

interface DraftResponse {
  readonly draft: ProductOrderDraftDTO;
  readonly participants: readonly DraftParticipantDTO[];
}

interface InviteResponse {
  readonly invite: ProductInviteDTO;
  readonly participant: DraftParticipantDTO;
  readonly draft: ProductOrderDraftDTO;
  /** 簇 D 修正：createInvite 一次性下发的 invite token。 */
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
  const account = privateKeyToAccount(
    testPrivateKey(walletAddressIndex(walletAddress)),
  );
  const signature = await account.signTypedData(
    prepared.prepared.typedData as Parameters<typeof account.signTypedData>[0],
  );
  const response = await router.handle({
    method: "POST",
    pathname: `/product/order-drafts/${draftId}/trigger`,
    body: {
      prepareId: prepared.prepared.prepareId,
      walletAddress,
      signature,
    },
  });
  expect(response.status).toBe(200);
  return response.body as SubmitProductOrderDraftResult;
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
