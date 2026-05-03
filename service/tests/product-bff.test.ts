import { describe, expect, it } from "vitest";
import {
  ORDER_INITIAL_TRIGGER_PERMISSION_ID,
  ORDER_INITIAL_TRIGGER_SIGNAL_NAME,
  ORDER_INITIAL_TRIGGER_SOURCE,
  ORDER_REGISTRAR_ROLE_SLOT_ID,
  ORDER_SYSTEM_STAGE_ID
} from "@uvp-eth/product-dto";
import {
  CROSS_BORDER_ZHIXU_ID,
  crossBorderPlanIds,
  demoZhixuDetail,
  phase2CustomsOnchainHookPlanArtifact,
  phase2CustomsRoleSlotIds,
  phase2CustomsStageIds,
  phase2CustomsStoreProductSchema
} from "@uvp-eth/product-dto/fixtures";
import { createApiRouter, type ApiRouter } from "../src/api/routes.js";
import type { ChainEvent } from "../src/indexer/events.js";
import {
  ProductAuthorizationBuilder,
  ProductAuthorizationBuilderError
} from "../src/product/bff/authorization.js";
import {
  MemoryProductOrderRegistrationAdapter,
  PRODUCT_INITIAL_TRIGGER_SIGNAL_ID,
  PRODUCT_INITIAL_TRIGGER_SOURCE_ID
} from "../src/product/bff/registration.js";
import { MemoryStoreZhixuVersionMetadataStore } from "../src/store-console/version.js";
import { MemoryProjectionStore } from "../src/storage/projection-store.js";
import { MemoryProductBffStore } from "../src/product/bff/store.js";
import { TxReconcileWorker } from "../src/reconcile/index.js";
import {
  STAGE_EXECUTOR_PATCH_SIGNAL_ID,
  STAGE_RESOURCE_PATCH_SIGNAL_ID
} from "../src/stage-patches/index.js";
import type {
  DraftParticipantDTO,
  ProductOrderRegistrationDTO,
  ProductInviteDTO,
  ProductOrderDraftDTO,
  SignalAuthorizationDTO,
  StartProductOrderRegistrationResult,
  SubmitProductOrderDraftResult
} from "../src/product/bff/types.js";
import type { Hex } from "../src/shared/types.js";

const contractAddress = "0x1111111111111111111111111111111111111111";
const activeStateMachineAddress = "0x9999999999999999999999999999999999999999";
const deploymentRegistryAddress = "0x8888888888888888888888888888888888888888";
const trustRegistryAddress = "0x7777777777777777777777777777777777777777";
const activeDeploymentId = "0x0000000000000000000000000000000000000000000000000000000000000d02";
const attester = "0x2222222222222222222222222222222222222222";
const metadataHash = "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const policyHash = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const reasonHash = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

describe("product BFF order drafts and invites", () => {
  it("creates an order draft from an attested plan and exposes draft participants", async () => {
    const { router } = await createRouterWithTrust([planAttestedEvent(1n)]);

    const response = await createDraft(router);

    expect(response.status).toBe(201);
    const body = response.body as DraftResponse;
    expect(body.draft).toMatchObject({
      zhixuId: CROSS_BORDER_ZHIXU_ID,
      planId: crossBorderPlanIds.planId,
      planHash: crossBorderPlanIds.planHash,
      title: "A company purchase",
      status: "draft"
    });
    expect(body.participants.filter((participant) => participant.required).length).toBeGreaterThan(0);
    expect(body.participants.every((participant) => participant.status === "missing")).toBe(true);

    const getResponse = await router.handle({
      method: "GET",
      pathname: `/product/order-drafts/${body.draft.draftId}`
    });
    expect(getResponse.status).toBe(200);
    expect((getResponse.body as DraftResponse).participants).toHaveLength(body.participants.length);

    const patchResponse = await router.handle({
      method: "PATCH",
      pathname: `/product/order-drafts/${body.draft.draftId}`,
      body: { title: "Updated purchase", goods: ["vehicles"] }
    });
    expect(patchResponse.status).toBe(200);
    expect((patchResponse.body as { draft: ProductOrderDraftDTO }).draft.title).toBe("Updated purchase");
  });

  it("accepts and rejects participant invites", async () => {
    const { router } = await createRouterWithTrust([planAttestedEvent(1n)]);
    const draft = (await createDraft(router).then((response) => response.body as DraftResponse)).draft;

    const fundsInvite = await createInvite(router, draft.draftId, "funds", "funds@example.com");
    expect(fundsInvite.draft.status).toBe("awaiting_participants");
    expect(fundsInvite.participant.status).toBe("invited");

    const acceptResponse = await router.handle({
      method: "POST",
      pathname: `/product/invites/${fundsInvite.invite.inviteId}/accept`,
      body: {
        displayName: "Buyer Finance",
        walletAddress: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        contact: "buyer@example.com"
      }
    });
    expect(acceptResponse.status).toBe(200);
    const accepted = acceptResponse.body as InviteResponse;
    expect(accepted.participant).toMatchObject({
      roleSlotId: "funds",
      status: "accepted",
      walletAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    });
    expect(accepted.draft.status).toBe("awaiting_participants");

    const supplyInvite = await createInvite(router, draft.draftId, "supply", "supply@example.com");
    const rejectResponse = await router.handle({
      method: "POST",
      pathname: `/product/invites/${supplyInvite.invite.inviteId}/reject`,
      body: { displayName: "Supplier", contact: "supply@example.com" }
    });
    expect(rejectResponse.status).toBe(200);
    const rejected = rejectResponse.body as InviteResponse;
    expect(rejected.participant).toMatchObject({
      roleSlotId: "supply",
      status: "rejected"
    });
    expect(rejected.draft.status).toBe("awaiting_participants");
  });

  it("previews invites and blocks wrong-wallet or already accepted recovery states", async () => {
    const { router } = await createRouterWithTrust([planAttestedEvent(1n)]);
    const draft = (await createDraft(router).then((response) => response.body as DraftResponse)).draft;
    const fundsInvite = await createInvite(router, draft.draftId, "funds", "funds@example.com");
    const acceptedWallet = testWallet(0);

    const previewResponse = await router.handle({
      method: "GET",
      pathname: `/product/invites/${fundsInvite.invite.inviteId}`,
      headers: { "x-uvp-wallet-address": acceptedWallet }
    });
    expect(previewResponse.status).toBe(200);
    expect((previewResponse.body as { invite: Record<string, unknown> }).invite).not.toHaveProperty("tokenHash");
    expect(previewResponse.body).toMatchObject({
      invite: { inviteId: fundsInvite.invite.inviteId, status: "active" },
      participant: { roleSlotId: "funds" },
      acceptance: { canAccept: true, status: "can_accept" },
      walletBinding: { walletAddress: acceptedWallet, alreadyBound: false, canAccept: true }
    });

    const wrongWalletResponse = await router.handle({
      method: "POST",
      pathname: `/product/invites/${fundsInvite.invite.inviteId}/accept`,
      headers: { "x-uvp-wallet-address": testWallet(1) },
      body: {
        displayName: "Buyer Finance",
        walletAddress: acceptedWallet,
        contact: "buyer@example.com"
      }
    });
    expect(wrongWalletResponse).toMatchObject({
      status: 403,
      body: { error: "wrong_wallet" }
    });

    const acceptResponse = await router.handle({
      method: "POST",
      pathname: `/product/invites/${fundsInvite.invite.inviteId}/accept`,
      headers: { "x-uvp-wallet-address": acceptedWallet },
      body: {
        displayName: "Buyer Finance",
        walletAddress: acceptedWallet,
        contact: "buyer@example.com"
      }
    });
    expect(acceptResponse.status).toBe(200);

    const meResponse = await router.handle({
      method: "GET",
      pathname: "/product/me",
      headers: { "x-uvp-wallet-address": acceptedWallet }
    });
    expect(meResponse.status).toBe(200);
    expect(meResponse.body).toMatchObject({
      participant: {
        participantId: (acceptResponse.body as InviteResponse).participant.participantId,
        displayName: "Buyer Finance",
        source: "accepted_participant",
        roleLabels: expect.arrayContaining(["资金方"])
      },
      summary: {
        orderCount: 0,
        openTaskCount: 0
      }
    });

    const alreadyAcceptedResponse = await router.handle({
      method: "POST",
      pathname: `/product/invites/${fundsInvite.invite.inviteId}/accept`,
      headers: { "x-uvp-wallet-address": acceptedWallet },
      body: {
        displayName: "Buyer Finance",
        walletAddress: acceptedWallet,
        contact: "buyer@example.com"
      }
    });
    expect(alreadyAcceptedResponse).toMatchObject({
      status: 409,
      body: { error: "invite_already_accepted" }
    });
  });

  it("blocks expired invites and duplicate participant wallet binding", async () => {
    const { router } = await createRouterWithTrust([planAttestedEvent(1n)]);
    const draft = (await createDraft(router).then((response) => response.body as DraftResponse)).draft;
    await inviteAndAccept(router, draft.draftId, "funds", 0);

    const duplicateInvite = await createInvite(router, draft.draftId, "delivery", "delivery@example.com");
    const duplicateAcceptResponse = await router.handle({
      method: "POST",
      pathname: `/product/invites/${duplicateInvite.invite.inviteId}/accept`,
      headers: { "x-uvp-wallet-address": testWallet(0) },
      body: {
        displayName: "Delivery",
        walletAddress: testWallet(0),
        contact: "delivery@example.com"
      }
    });
    expect(duplicateAcceptResponse).toMatchObject({
      status: 409,
      body: { error: "wallet_already_bound" }
    });

    const expiredInvite = await createInvite(
      router,
      draft.draftId,
      "supply",
      "supply@example.com",
      "2000-01-01T00:00:00.000Z"
    );
    const expiredPreviewResponse = await router.handle({
      method: "GET",
      pathname: `/product/invites/${expiredInvite.invite.inviteId}`,
      headers: { "x-uvp-wallet-address": testWallet(2) }
    });
    expect(expiredPreviewResponse).toMatchObject({
      status: 200,
      body: {
        invite: { status: "expired" },
        acceptance: { canAccept: false, status: "expired" }
      }
    });

    const expiredAcceptResponse = await router.handle({
      method: "POST",
      pathname: `/product/invites/${expiredInvite.invite.inviteId}/accept`,
      headers: { "x-uvp-wallet-address": testWallet(2) },
      body: {
        displayName: "Supplier",
        walletAddress: testWallet(2),
        contact: "supply@example.com"
      }
    });
    expect(expiredAcceptResponse).toMatchObject({
      status: 410,
      body: { error: "invite_expired" }
    });
  });

  it("requires all required participants before submitting order registration", async () => {
    const { router, registrationAdapter } = await createRouterWithTrust([planAttestedEvent(1n)]);
    const draft = (await createDraft(router).then((response) => response.body as DraftResponse)).draft;
    const participants = await listParticipants(router, draft.draftId);
    const requiredParticipants = participants.filter((participant) => participant.required);

    for (const [index, participant] of requiredParticipants.slice(0, -1).entries()) {
      await inviteAndAccept(router, draft.draftId, participant.roleSlotId, index);
    }

    const blockedSubmit = await router.handle({
      method: "POST",
      pathname: `/product/order-drafts/${draft.draftId}/submit`
    });
    expect(blockedSubmit.status).toBe(409);
    expect(blockedSubmit.body).toMatchObject({ error: "required_participant_missing" });

    const lastRequired = requiredParticipants.at(-1);
    expect(lastRequired).toBeDefined();
    await inviteAndAccept(router, draft.draftId, lastRequired!.roleSlotId, requiredParticipants.length);

    const readyDraft = await router.handle({
      method: "GET",
      pathname: `/product/order-drafts/${draft.draftId}`
    });
    expect((readyDraft.body as DraftResponse).draft.status).toBe("ready_to_register");

    const submitResponse = await router.handle({
      method: "POST",
      pathname: `/product/order-drafts/${draft.draftId}/submit`
    });
    expect(submitResponse.status).toBe(200);
    const submit = submitResponse.body as SubmitProductOrderDraftResult;
    expect(submit.draft.status).toBe("registering");
    expect(submit.draft.registeredOrderId).toBeUndefined();
    expect(submit.registration).toMatchObject({
      draftId: draft.draftId,
      planId: crossBorderPlanIds.planId,
      planHash: crossBorderPlanIds.planHash,
      status: "pending",
      retryable: false
    });
    expect(submit.registration.registrationId).toMatch(/^registration_/);
    expect(submit.registration.orderId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(submit.registration.txHash).toBeUndefined();
    expect(submit.permissions.length).toBeGreaterThan(0);
    expect(registrationAdapter.listAttempts()).toHaveLength(1);
    const [attempt] = registrationAdapter.listAttempts();
    expect(attempt).toMatchObject({
      draftId: draft.draftId,
      orderId: submit.registration.orderId,
      planId: crossBorderPlanIds.planId
    });
    expect(attempt!.authorizations).toHaveLength(submit.permissions.length);
    expect(submit.permissions).toContainEqual(expect.objectContaining({
      permissionId: ORDER_INITIAL_TRIGGER_PERMISSION_ID,
      participantId: ORDER_REGISTRAR_ROLE_SLOT_ID,
      roleSlotId: ORDER_REGISTRAR_ROLE_SLOT_ID,
      stageIdentifier: ORDER_SYSTEM_STAGE_ID,
      source: ORDER_INITIAL_TRIGGER_SOURCE,
      signalName: ORDER_INITIAL_TRIGGER_SIGNAL_NAME,
      payloadPolicy: "optional",
      requiredEvidence: []
    }));

    const registrationResponse = await router.handle({
      method: "GET",
      pathname: `/product/order-registrations/${submit.registration.registrationId}`
    });
    expect(registrationResponse.status).toBe(200);
    expect((registrationResponse.body as { registration: ProductOrderRegistrationDTO }).registration).toEqual(submit.registration);
  });

  it("submits new drafts to the active deployment from the on-chain registry projection", async () => {
    const registrationAdapter = new MemoryProductOrderRegistrationAdapter();
    const { router } = await createRouterWithTrust([
      ...activeDeploymentEvents(),
      planAttestedEvent(11n)
    ], registrationAdapter);
    const draft = await createReadyDraft(router);

    const submit = await submitDraft(router, draft.draftId);
    const [attempt] = registrationAdapter.listAttempts();

    expect(submit.registration).toMatchObject({
      deploymentId: activeDeploymentId,
      stateMachineAddress: activeStateMachineAddress
    });
    expect(attempt).toMatchObject({
      deploymentId: activeDeploymentId,
      stateMachineAddress: activeStateMachineAddress
    });
  });

  it("blocks unattested and revoked plans for create and submit", async () => {
    const { router: unattestedRouter } = await createRouterWithTrust([]);
    const unattestedResponse = await createDraft(unattestedRouter);
    expect(unattestedResponse.status).toBe(403);
    expect(unattestedResponse.body).toMatchObject({ error: "plan_not_attested" });

    const { router: revokedRouter } = await createRouterWithTrust([
      planAttestedEvent(1n),
      planRevokedEvent(2n)
    ]);
    const revokedResponse = await createDraft(revokedRouter);
    expect(revokedResponse.status).toBe(409);
    expect(revokedResponse.body).toMatchObject({ error: "plan_revoked" });

    const { router, store } = await createRouterWithTrust([planAttestedEvent(1n)]);
    const draft = (await createDraft(router).then((response) => response.body as DraftResponse)).draft;
    const participants = await listParticipants(router, draft.draftId);
    const requiredParticipants = participants.filter((participant) => participant.required);
    for (const [index, participant] of requiredParticipants.entries()) {
      await inviteAndAccept(router, draft.draftId, participant.roleSlotId, index);
    }

    await store.resetFromEvents({
      deploymentBlock: 0n,
      events: [planAttestedEvent(1n), planRevokedEvent(2n)]
    });
    const submitAfterRevoke = await router.handle({
      method: "POST",
      pathname: `/product/order-drafts/${draft.draftId}/submit`
    });
    expect(submitAfterRevoke.status).toBe(409);
    expect(submitAfterRevoke.body).toMatchObject({ error: "plan_revoked" });
  });

  it("does not let Store version metadata revive a revoked Product chain attestation", async () => {
    const replacementPlanId = "0x0000000000000000000000000000000000000000000000000000000000000f01";
    const replacementPlanHash = "0x0000000000000000000000000000000000000000000000000000000000000f02";
    const replacementArtifactHash = "0x0000000000000000000000000000000000000000000000000000000000000f03";
    const versionStore = new MemoryStoreZhixuVersionMetadataStore();
    await versionStore.upsertVersion({
      versionId: "cross-border-v2",
      zhixuId: CROSS_BORDER_ZHIXU_ID,
      seriesId: CROSS_BORDER_ZHIXU_ID,
      versionLabel: "Cross-border v2",
      status: "active",
      planId: replacementPlanId,
      planHash: replacementPlanHash,
      artifactHash: replacementArtifactHash,
      createdAt: "2026-04-29T00:00:00.000Z",
      cutoverAt: "2026-04-29T00:00:00.000Z",
      cutoverReason: "test metadata must not replace chain truth"
    });
    const store = new MemoryProjectionStore();
    await store.resetFromEvents({
      deploymentBlock: 0n,
      events: [
        planAttestedEvent(1n),
        planRevokedEvent(2n),
        planAttestedEventFor(3n, 2, replacementPlanId, replacementPlanHash, replacementArtifactHash)
      ]
    });
    const router = createApiRouter(store, {
      productRegistrationAdapter: new MemoryProductOrderRegistrationAdapter(),
      storeZhixuVersionMetadataStore: versionStore
    });

    const response = await createDraft(router);

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ error: "plan_revoked" });
  });

  it("generates stable server-side signal authorizations", async () => {
    const first = await submitReadyDraft();
    const second = await submitReadyDraft();

    expect(first.authorizations).toEqual(second.authorizations);
    expect(stablePermissionShape(first.permissions)).toEqual(stablePermissionShape(second.permissions));
    expect(first.authorizations.length).toBeGreaterThan(0);
    expect(first.permissions).toHaveLength(first.authorizations.length);
    expect(first.permissions.every((permission) =>
      permission.draftId.length > 0 &&
      typeof permission.orderId === "string" &&
      /^0x[0-9a-f]{64}$/.test(permission.orderId) &&
      permission.participantId.length > 0
    )).toBe(true);
    expect(first.authorizations.every((authorization) =>
      /^0x[0-9a-f]{64}$/.test(authorization.sourceId) &&
      /^0x[0-9a-f]{64}$/.test(authorization.signalId) &&
      /^0x[0-9a-f]{40}$/.test(authorization.submitter) &&
      /^0x[0-9a-f]{64}$/.test(authorization.role) &&
      /^0x[0-9a-f]{64}$/.test(authorization.metadataHash)
    )).toBe(true);
  });

  it("generates explicit stage patch authorizations from Phase 2 add-on actions", () => {
    const input = phase2AuthorizationBuildInput();
    const result = new ProductAuthorizationBuilder().build(input);
    const selectorWallet = testWallet(0);
    const resourcePatchWallet = testWallet(1);
    const selectorHook = requiredPhase2Hook(phase2CustomsStageIds.buyerSelectCustomsExecutor);
    const resourcePatchHook = requiredPhase2Hook(phase2CustomsStageIds.buyerPublishCustomsResources);

    expect(result.authorizations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceId: selectorHook.stageId,
        signalId: STAGE_EXECUTOR_PATCH_SIGNAL_ID,
        submitter: selectorWallet
      }),
      expect.objectContaining({
        sourceId: resourcePatchHook.stageId,
        signalId: STAGE_RESOURCE_PATCH_SIGNAL_ID,
        submitter: resourcePatchWallet
      })
    ]));
    expect(result.permissions).toContainEqual(expect.objectContaining({
      permissionId: "phase2.customs.executor-patch",
      roleSlotId: phase2CustomsRoleSlotIds.buyerSelector,
      submitterAddress: selectorWallet
    }));
    expect(result.permissions).toContainEqual(expect.objectContaining({
      permissionId: "phase2.customs.resource-patch",
      roleSlotId: phase2CustomsRoleSlotIds.buyerResourceController,
      submitterAddress: resourcePatchWallet
    }));
  });

  it("does not derive stage patch authorizations without an explicit add-on action manifest", () => {
    const input = phase2AuthorizationBuildInput({
      omitAddOnManifestForRoleSlot: phase2CustomsRoleSlotIds.buyerSelector
    });
    const result = new ProductAuthorizationBuilder().build(input);
    const selectorHook = requiredPhase2Hook(phase2CustomsStageIds.buyerSelectCustomsExecutor);
    const resourcePatchHook = requiredPhase2Hook(phase2CustomsStageIds.buyerPublishCustomsResources);

    expect(result.authorizations).not.toContainEqual(expect.objectContaining({
      sourceId: selectorHook.stageId,
      signalId: STAGE_EXECUTOR_PATCH_SIGNAL_ID,
      submitter: testWallet(0)
    }));
    expect(result.authorizations).toContainEqual(expect.objectContaining({
      sourceId: resourcePatchHook.stageId,
      signalId: STAGE_RESOURCE_PATCH_SIGNAL_ID,
      submitter: testWallet(1)
    }));
  });

  it("fails Phase 2 authorization when a stage patch role has no accepted participant", () => {
    const input = phase2AuthorizationBuildInput();

    expectAuthorizationError({
      ...input,
      participants: input.participants.filter((participant) =>
        participant.roleSlotId !== phase2CustomsRoleSlotIds.buyerSelector
      )
    }, "required_role_missing");
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
          ownerRole: `unmatched owner ${stage.stageId}`
        }))
      },
      participants: input.participants.map((participant) => ({
        ...participant,
        roleLabel: `unmatched label ${participant.roleSlotId}`,
        displayName: `unmatched display ${participant.roleSlotId}`
      }))
    };

    expect(builder.build(renamedInput)).toEqual(baseline);
  });

  it("fails authorization build before submit when explicit permission rows are incomplete", () => {
    const input = authorizationBuildInput();

    expectAuthorizationError({
      ...input,
      zhixu: { ...input.zhixu, orderPermissionTable: [] }
    }, "permission_table_missing");
    expectAuthorizationError({
      ...input,
      zhixu: {
        ...input.zhixu,
        orderPermissionTable: input.zhixu.orderPermissionTable.filter((entry) =>
          entry.permissionId !== ORDER_INITIAL_TRIGGER_PERMISSION_ID
        )
      }
    }, "initial_trigger_permission_missing");
    expectAuthorizationError({
      ...input,
      zhixu: {
        ...input.zhixu,
        orderPermissionTable: input.zhixu.orderPermissionTable.map((entry) =>
          entry.permissionId === "stage.order-confirmed.confirm_stage"
            ? { ...entry, roleSlotId: "missing-role" }
            : entry
        )
      }
    }, "permission_role_not_found");
    expectAuthorizationError({
      ...input,
      zhixu: {
        ...input.zhixu,
        orderPermissionTable: input.zhixu.orderPermissionTable.map((entry) =>
          entry.permissionId === "stage.order-confirmed.confirm_stage"
            ? { ...entry, stageId: "missing-stage" }
            : entry
        )
      }
    }, "permission_stage_not_found");
    expectAuthorizationError({
      ...input,
      participants: input.participants.filter((participant) => participant.roleSlotId !== "funds")
    }, "required_role_missing");
    expectAuthorizationError({
      ...input,
      zhixu: {
        ...input.zhixu,
        orderPermissionTable: [
          ...input.zhixu.orderPermissionTable,
          {
            ...input.zhixu.orderPermissionTable.find((entry) => entry.permissionId === "stage.order-confirmed.confirm_stage")!,
            permissionId: "stage.order-confirmed.confirm_stage.duplicate"
          }
        ]
      }
    }, "permission_authorization_duplicate");
  });

  it("keeps duplicate submit idempotent while registration is pending", async () => {
    const { router, registrationAdapter } = await createRouterWithTrust([planAttestedEvent(1n)]);
    const draft = await createReadyDraft(router);

    const firstResponse = await router.handle({
      method: "POST",
      pathname: `/product/order-drafts/${draft.draftId}/submit`
    });
    const secondResponse = await router.handle({
      method: "POST",
      pathname: `/product/order-drafts/${draft.draftId}/submit`
    });

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    const first = firstResponse.body as SubmitProductOrderDraftResult;
    const second = secondResponse.body as SubmitProductOrderDraftResult;
    expect(second.registration).toEqual(first.registration);
    expect(second.draft.status).toBe("registering");
    expect(registrationAdapter.listAttempts()).toHaveLength(1);
  });

  it("rejects client-supplied authorization tables", async () => {
    const { router, registrationAdapter } = await createRouterWithTrust([planAttestedEvent(1n)]);
    const draft = await createReadyDraft(router);

    const response = await router.handle({
      method: "POST",
      pathname: `/product/order-drafts/${draft.draftId}/submit`,
      body: { authorizations: [] }
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: "client_authorizations_not_allowed" });
    expect(registrationAdapter.listAttempts()).toHaveLength(0);
  });

  it("marks draft registered only after registration is confirmed", async () => {
    const registrationAdapter = new MemoryProductOrderRegistrationAdapter({
      status: "confirmed",
      blockNumber: "42",
      retryable: false
    });
    const { router } = await createRouterWithTrust([planAttestedEvent(1n)], registrationAdapter);
    const draft = await createReadyDraft(router);

    const response = await router.handle({
      method: "POST",
      pathname: `/product/order-drafts/${draft.draftId}/submit`
    });

    expect(response.status).toBe(200);
    const submit = response.body as SubmitProductOrderDraftResult;
    expect(submit.registration.status).toBe("confirmed");
    expect(submit.registration.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(submit.registration.blockNumber).toBe("42");
    expect(submit.draft.status).toBe("registered");
    expect(submit.draft.registeredOrderId).toBe(submit.registration.orderId);
    expect(submit.draft.registrationTxHash).toBe(submit.registration.txHash);
  });

  it("starts a confirmed registration and keeps duplicate start idempotent", async () => {
    const registrationAdapter = new MemoryProductOrderRegistrationAdapter({
      status: "confirmed",
      blockNumber: "42",
      retryable: false
    });
    const { router } = await createRouterWithTrust([planAttestedEvent(1n)], registrationAdapter);
    const draft = await createReadyDraft(router);
    const submit = await submitDraft(router, draft.draftId);

    const first = await startRegistration(router, submit.registration.registrationId);
    const second = await startRegistration(router, submit.registration.registrationId);

    expect(first.registration).toEqual(submit.registration);
    expect(first.start).toMatchObject({
      registrationId: submit.registration.registrationId,
      draftId: draft.draftId,
      orderId: submit.registration.orderId,
      status: "confirmed",
      retryable: false,
      reconcileStatus: "confirmed",
      receiptStatus: "success",
      projectionStatus: "present"
    });
    expect(first.start.startId).toMatch(/^start_/);
    expect(first.start.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(second.start).toEqual(first.start);
    expect(registrationAdapter.listInitialTriggerAttempts()).toHaveLength(1);

    const [registrationAttempt] = registrationAdapter.listAttempts();
    expect(registrationAttempt?.authorizations).toContainEqual(expect.objectContaining({
      sourceId: PRODUCT_INITIAL_TRIGGER_SOURCE_ID,
      signalId: PRODUCT_INITIAL_TRIGGER_SIGNAL_ID,
      submitter: registrationAdapter.registrarAddress
    }));
    expect(registrationAdapter.listInitialTriggerAttempts()[0]).toMatchObject({
      registrationId: submit.registration.registrationId,
      orderId: submit.registration.orderId,
      sourceId: PRODUCT_INITIAL_TRIGGER_SOURCE_ID,
      signalId: PRODUCT_INITIAL_TRIGGER_SIGNAL_ID,
      registrationTxHash: submit.registration.txHash,
      registrationBlockNumber: submit.registration.blockNumber,
      payloadHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
      idempotencyKey: expect.stringMatching(/^0x[0-9a-f]{64}$/)
    });
  });

  it("rejects start until registration is confirmed", async () => {
    const { router, registrationAdapter } = await createRouterWithTrust([planAttestedEvent(1n)]);
    const draft = await createReadyDraft(router);
    const submit = await submitDraft(router, draft.draftId);

    const response = await router.handle({
      method: "POST",
      pathname: `/product/order-registrations/${submit.registration.registrationId}/start`,
      body: {}
    });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ error: "registration_not_confirmed" });
    expect(registrationAdapter.listInitialTriggerAttempts()).toHaveLength(0);
  });

  it("retries failed retryable start with the same start id", async () => {
    const registrationAdapter = new MemoryProductOrderRegistrationAdapter({
      status: "confirmed",
      retryable: false
    });
    registrationAdapter.setTriggerResult({
      status: "failed",
      errorCode: "temporary_rpc_error",
      errorMessage: "temporary rpc error",
      retryable: true
    });
    const { router } = await createRouterWithTrust([planAttestedEvent(1n)], registrationAdapter);
    const draft = await createReadyDraft(router);
    const submit = await submitDraft(router, draft.draftId);

    const failedResponse = await router.handle({
      method: "POST",
      pathname: `/product/order-registrations/${submit.registration.registrationId}/start`,
      body: {}
    });
    expect(failedResponse.status).toBe(502);
    expect(failedResponse.body).toMatchObject({
      error: "temporary_rpc_error",
      details: {
        start: {
          status: "failed",
          retryable: true,
          errorCode: "temporary_rpc_error"
        }
      }
    });
    const failedStart = (failedResponse.body as { details: StartProductOrderRegistrationResult }).details.start;

    registrationAdapter.setTriggerResult({ status: "confirmed", retryable: false });
    const retry = await startRegistration(router, submit.registration.registrationId);

    expect(retry.start.startId).toBe(failedStart.startId);
    expect(retry.start.status).toBe("confirmed");
    expect(retry.start.errorCode).toBeUndefined();
    expect(registrationAdapter.listInitialTriggerAttempts()).toHaveLength(2);
  });

  it("retries failed retryable registration with the same order id", async () => {
    const registrationAdapter = new MemoryProductOrderRegistrationAdapter({
      status: "failed",
      errorCode: "temporary_rpc_error",
      errorMessage: "temporary rpc error",
      retryable: true
    });
    const { router } = await createRouterWithTrust([planAttestedEvent(1n)], registrationAdapter);
    const draft = await createReadyDraft(router);

    const failedResponse = await router.handle({
      method: "POST",
      pathname: `/product/order-drafts/${draft.draftId}/submit`
    });
    expect(failedResponse.status).toBe(200);
    const failed = failedResponse.body as SubmitProductOrderDraftResult;
    expect(failed.registration).toMatchObject({
      status: "failed",
      errorCode: "temporary_rpc_error",
      retryable: true
    });
    expect(failed.draft.status).toBe("ready_to_register");

    registrationAdapter.setResult({ status: "pending", retryable: false });
    const retryResponse = await router.handle({
      method: "POST",
      pathname: `/product/order-registrations/${failed.registration.registrationId}/retry`
    });
    expect(retryResponse.status).toBe(200);
    const retried = retryResponse.body as SubmitProductOrderDraftResult;
    expect(retried.registration.registrationId).toBe(failed.registration.registrationId);
    expect(retried.registration.orderId).toBe(failed.registration.orderId);
    expect(retried.registration.status).toBe("pending");
    expect(retried.draft.status).toBe("registering");
    expect(registrationAdapter.listAttempts()).toHaveLength(2);
  });

  it("recovers tx-backed pending registration to startable after OrderRegistered is indexed", async () => {
    const registrationAdapter = new MemoryProductOrderRegistrationAdapter({
      status: "pending",
      txHash: "0xaef8a9941d19ffe10a337568620797c6a770ebb4220cf742a25b3f66ebb6d22b" as Hex,
      blockNumber: "40958055",
      retryable: false
    });
    const store = new MemoryProductBffStore();
    const versionStore = new MemoryStoreZhixuVersionMetadataStore();
    const projectionStore = new MemoryProjectionStore();
    await projectionStore.resetFromEvents({
      deploymentBlock: 0n,
      events: [planAttestedEvent(1n)]
    });
    const router = createApiRouter(projectionStore, {
      productRegistrationAdapter: registrationAdapter,
      productBffStore: store,
      storeZhixuVersionMetadataStore: versionStore
    });

    const draft = await createReadyDraft(router);
    const submit = await submitDraft(router, draft.draftId);
    expect(submit.registration.status).toBe("pending");
    expect(submit.registration.txHash).toBe("0xaef8a9941d19ffe10a337568620797c6a770ebb4220cf742a25b3f66ebb6d22b");
    expect(submit.registration.blockNumber).toBe("40958055");

    // Start API blocked by pending status (staging failure shape)
    const blocked = await router.handle({
      method: "POST",
      pathname: `/product/order-registrations/${submit.registration.registrationId}/start`,
      body: {}
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body).toMatchObject({ error: "registration_not_confirmed" });
    expect((blocked.body as { details?: { status?: string } }).details?.status).toBe("pending");

    await projectionStore.resetFromEvents({
      deploymentBlock: 0n,
      events: [
        planAttestedEvent(1n),
        {
          ...chainEvent(2n, 0, "OrderRegistered", {
            orderId: submit.registration.orderId,
            planId: submit.registration.planId
          }),
          transactionHash: submit.registration.txHash!
        }
      ]
    });
    const worker = new TxReconcileWorker({
      config: { enabled: true, pollIntervalMs: 0, txTimeoutMs: 60_000 },
      receiptClient: { getTransactionReceipt: async () => undefined },
      projectionStore,
      productStore: store,
      now: () => new Date("2026-04-28T00:00:00Z")
    });
    await worker.runOnce();
    await expect(store.getRegistration(submit.registration.registrationId)).resolves.toMatchObject({
      status: "confirmed",
      reconcileStatus: "confirmed",
      receiptStatus: "success",
      projectionStatus: "present"
    });

    const started = await router.handle({
      method: "POST",
      pathname: `/product/order-registrations/${submit.registration.registrationId}/start`,
      body: {}
    });
    expect(started.status).toBe(200);
    const body = started.body as StartProductOrderRegistrationResult;
    expect(body.registration.status).toBe("confirmed");
    expect(body.start).toMatchObject({
      registrationId: submit.registration.registrationId,
      draftId: draft.draftId,
      orderId: submit.registration.orderId,
      status: "confirmed",
      retryable: false,
      reconcileStatus: "confirmed",
      receiptStatus: "success",
      projectionStatus: "present"
    });
    expect(body.start.txHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("fires onTxMined callback after draft submit so projection can refresh promptly", async () => {
    let fired = 0;
    const registrationAdapter = new MemoryProductOrderRegistrationAdapter({
      status: "confirmed"
    });
    const store = new MemoryProductBffStore();
    const versionStore = new MemoryStoreZhixuVersionMetadataStore();
    const projectionStore = new MemoryProjectionStore();
    await projectionStore.resetFromEvents({
      deploymentBlock: 0n,
      events: [planAttestedEvent(1n)]
    });
    const router = createApiRouter(projectionStore, {
      productRegistrationAdapter: registrationAdapter,
      productBffStore: store,
      storeZhixuVersionMetadataStore: versionStore,
      onTxMined: () => { fired++; }
    });

    const draft = await createReadyDraft(router);
    await submitDraft(router, draft.draftId);
    expect(fired).toBe(1);

    const submit2 = await submitDraft(router, (await createReadyDraft(router)).draftId);
    expect(fired).toBe(2);

    await startRegistration(router, submit2.registration.registrationId);
    expect(fired).toBe(3);
  });

  it("consecutive orders both become startable without the second order blocking", async () => {
    const registrationAdapter = new MemoryProductOrderRegistrationAdapter({
      status: "confirmed"
    });
    const store = new MemoryProductBffStore();
    const versionStore = new MemoryStoreZhixuVersionMetadataStore();
    const projectionStore = new MemoryProjectionStore();

    await projectionStore.resetFromEvents({
      deploymentBlock: 0n,
      events: [planAttestedEvent(1n)]
    });
    const router = createApiRouter(projectionStore, {
      productRegistrationAdapter: registrationAdapter,
      productBffStore: store,
      storeZhixuVersionMetadataStore: versionStore
    });

    // First order
    const draft1 = await createReadyDraft(router);
    const submit1 = await submitDraft(router, draft1.draftId);
    expect(submit1.registration.status).toBe("confirmed");
    expect(submit1.registration.orderId).toBeTruthy();

    const start1 = await startRegistration(router, submit1.registration.registrationId);
    expect(start1.start.status).toBe("confirmed");
    expect(start1.start.orderId).toBe(submit1.registration.orderId);

    // Second order — must succeed back-to-back without registration_not_confirmed
    const draft2 = await createReadyDraft(router);
    const submit2 = await submitDraft(router, draft2.draftId);
    expect(submit2.registration.status).toBe("confirmed");
    expect(submit2.registration.orderId).toBeTruthy();
    expect(submit2.registration.orderId).not.toBe(submit1.registration.orderId);

    const start2 = await startRegistration(router, submit2.registration.registrationId);
    expect(start2.start.status).toBe("confirmed");
    expect(start2.start.orderId).toBe(submit2.registration.orderId);

    // Both registrations are independently retrievable
    const reg1 = await store.getRegistration(submit1.registration.registrationId);
    expect(reg1?.status).toBe("confirmed");
    const reg2 = await store.getRegistration(submit2.registration.registrationId);
    expect(reg2?.status).toBe("confirmed");
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
}

function createRouterWithTrust(events: readonly ChainEvent[]): Promise<{
  readonly router: ApiRouter;
  readonly store: MemoryProjectionStore;
  readonly registrationAdapter: MemoryProductOrderRegistrationAdapter;
}>;

function createRouterWithTrust(
  events: readonly ChainEvent[],
  registrationAdapter: MemoryProductOrderRegistrationAdapter
): Promise<{
  readonly router: ApiRouter;
  readonly store: MemoryProjectionStore;
  readonly registrationAdapter: MemoryProductOrderRegistrationAdapter;
}>;

async function createRouterWithTrust(
  events: readonly ChainEvent[],
  registrationAdapter = new MemoryProductOrderRegistrationAdapter()
): Promise<{
  readonly router: ApiRouter;
  readonly store: MemoryProjectionStore;
  readonly registrationAdapter: MemoryProductOrderRegistrationAdapter;
}> {
  const store = new MemoryProjectionStore();
  await store.resetFromEvents({ deploymentBlock: 0n, events });
  return {
    router: createApiRouter(store, { productRegistrationAdapter: registrationAdapter }),
    store,
    registrationAdapter
  };
}

async function createDraft(router: ApiRouter) {
  return router.handle({
    method: "POST",
    pathname: "/product/order-drafts",
    body: {
      zhixuId: CROSS_BORDER_ZHIXU_ID,
      title: "A company purchase",
      businessType: "parallel-export",
      totalAmount: "10000",
      currency: "USDC",
      createdBy: "creator-wallet"
    }
  });
}

async function createReadyDraft(router: ApiRouter): Promise<ProductOrderDraftDTO> {
  const draft = (await createDraft(router).then((response) => response.body as DraftResponse)).draft;
  const participants = await listParticipants(router, draft.draftId);
  const requiredParticipants = participants.filter((participant) => participant.required);
  for (const [index, participant] of requiredParticipants.entries()) {
    await inviteAndAccept(router, draft.draftId, participant.roleSlotId, index);
  }
  const readyResponse = await router.handle({
    method: "GET",
    pathname: `/product/order-drafts/${draft.draftId}`
  });
  expect(readyResponse.status).toBe(200);
  expect((readyResponse.body as DraftResponse).draft.status).toBe("ready_to_register");
  return (readyResponse.body as DraftResponse).draft;
}

async function submitReadyDraft(): Promise<{
  readonly authorizations: readonly SignalAuthorizationDTO[];
  readonly permissions: SubmitProductOrderDraftResult["permissions"];
}> {
  const { router, registrationAdapter } = await createRouterWithTrust([planAttestedEvent(1n)]);
  const draft = await createReadyDraft(router);
  const response = await router.handle({
    method: "POST",
    pathname: `/product/order-drafts/${draft.draftId}/submit`
  });
  expect(response.status).toBe(200);
  const submit = response.body as SubmitProductOrderDraftResult;
  const [attempt] = registrationAdapter.listAttempts();
  expect(attempt).toBeDefined();
  return { authorizations: attempt!.authorizations, permissions: submit.permissions };
}

function stablePermissionShape(permissions: SubmitProductOrderDraftResult["permissions"]) {
  return permissions.map((permission) => ({
    payloadPolicy: permission.payloadPolicy,
    permissionId: permission.permissionId,
    requiredEvidence: permission.requiredEvidence,
    roleSlotId: permission.roleSlotId,
    signalName: permission.signalName,
    source: permission.source,
    stageIdentifier: permission.stageIdentifier,
    submitterAddress: permission.submitterAddress
  }));
}

async function submitDraft(router: ApiRouter, draftId: string): Promise<SubmitProductOrderDraftResult> {
  const response = await router.handle({
    method: "POST",
    pathname: `/product/order-drafts/${draftId}/submit`
  });
  expect(response.status).toBe(200);
  return response.body as SubmitProductOrderDraftResult;
}

async function startRegistration(
  router: ApiRouter,
  registrationId: string
): Promise<StartProductOrderRegistrationResult> {
  const response = await router.handle({
    method: "POST",
    pathname: `/product/order-registrations/${registrationId}/start`,
    body: {}
  });
  expect(response.status).toBe(200);
  return response.body as StartProductOrderRegistrationResult;
}

async function createInvite(
  router: ApiRouter,
  draftId: string,
  roleSlotId: string,
  contact: string,
  expiresAt?: string
): Promise<InviteResponse> {
  const response = await router.handle({
    method: "POST",
    pathname: `/product/orders/${draftId}/invites`,
    body: {
      roleSlotId,
      contact,
      ...(expiresAt ? { expiresAt } : {})
    }
  });
  expect(response.status).toBe(201);
  return response.body as InviteResponse;
}

async function inviteAndAccept(
  router: ApiRouter,
  draftId: string,
  roleSlotId: string,
  index: number
): Promise<InviteResponse> {
  const invitation = await createInvite(router, draftId, roleSlotId, `${roleSlotId}@example.com`);
  const response = await router.handle({
    method: "POST",
    pathname: `/product/invites/${invitation.invite.inviteId}/accept`,
    body: {
      displayName: `${roleSlotId} participant`,
      walletAddress: testWallet(index),
      contact: `${roleSlotId}@example.com`
    }
  });
  expect(response.status).toBe(200);
  return response.body as InviteResponse;
}

async function listParticipants(router: ApiRouter, draftId: string): Promise<readonly DraftParticipantDTO[]> {
  const response = await router.handle({
    method: "GET",
    pathname: `/product/orders/${draftId}/participants`
  });
  expect(response.status).toBe(200);
  return (response.body as { participants: readonly DraftParticipantDTO[] }).participants;
}

function testWallet(index: number): string {
  return `0x${(index + 1).toString(16).padStart(40, "0")}`;
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
    status: "ready_to_register",
    createdAt: "2026-04-29T00:00:00.000Z",
    updatedAt: "2026-04-29T00:00:00.000Z"
  };
  const participants: readonly DraftParticipantDTO[] = demoZhixuDetail.roleSlots.map((slot, index) => ({
    participantId: `participant_${slot.slotId}`,
    draftId: draft.draftId,
    roleSlotId: slot.slotId,
    roleLabel: slot.label,
    displayName: slot.title,
    walletAddress: testWallet(index),
    contact: `${slot.slotId}@example.com`,
    status: "accepted" as const,
    required: slot.required,
    acceptedAt: "2026-04-29T00:00:00.000Z"
  }));
  return {
    zhixu: demoZhixuDetail,
    draft,
    participants,
    orderId: "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" as const,
    registrarAddress: "0x000000000000000000000000000000000000bff1" as const
  };
}

function phase2AuthorizationBuildInput(options: {
  readonly omitAddOnManifestForRoleSlot?: string;
} = {}): Parameters<ProductAuthorizationBuilder["build"]>[0] {
  const draft: ProductOrderDraftDTO = {
    draftId: "draft_phase2_authorization_unit",
    zhixuId: phase2CustomsStoreProductSchema.zhixuId ?? "phase2-customs-completion",
    planId: phase2CustomsStoreProductSchema.planId as Hex,
    planHash: phase2CustomsStoreProductSchema.planHash as Hex,
    title: "Phase 2 authorization unit",
    businessType: "phase2-customs",
    goods: [],
    totalAmount: "0",
    currency: "USDC",
    status: "ready_to_register",
    createdAt: "2026-05-02T00:00:00.000Z",
    updatedAt: "2026-05-02T00:00:00.000Z"
  };
  const roleSlots = phase2CustomsStoreProductSchema.roleSlots.map((slot) =>
    slot.slotId === options.omitAddOnManifestForRoleSlot
      ? (({ addOnManifest: _addOnManifest, ...withoutManifest }) => withoutManifest)(slot)
      : slot
  );
  const participants: readonly DraftParticipantDTO[] = roleSlots.map((slot, index) => ({
    participantId: `participant_${slot.slotId}`,
    draftId: draft.draftId,
    roleSlotId: slot.slotId,
    roleLabel: slot.label,
    displayName: slot.title,
    walletAddress: testWallet(index),
    contact: `${slot.slotId}@example.com`,
    status: "accepted" as const,
    required: slot.required,
    acceptedAt: "2026-05-02T00:00:00.000Z"
  }));
  return {
    zhixu: {
      zhixuId: phase2CustomsStoreProductSchema.zhixuId,
      roleSlots,
      stages: phase2CustomsStoreProductSchema.stages,
      orderPermissionTable: phase2CustomsStoreProductSchema.orderPermissionTable
    } as unknown as Parameters<ProductAuthorizationBuilder["build"]>[0]["zhixu"],
    draft,
    participants,
    orderId: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as const,
    registrarAddress: "0x000000000000000000000000000000000000bff1" as const
  };
}

function requiredPhase2Hook(
  stageIdentifier: string
): (typeof phase2CustomsOnchainHookPlanArtifact.compiledHooks)[number] {
  const hook = phase2CustomsOnchainHookPlanArtifact.compiledHooks.find((item) => item.stageIdentifier === stageIdentifier);
  if (!hook) {
    throw new Error(`missing Phase 2 hook for ${stageIdentifier}`);
  }
  return hook;
}

function expectAuthorizationError(
  input: Parameters<ProductAuthorizationBuilder["build"]>[0],
  code: string
): void {
  try {
    new ProductAuthorizationBuilder().build(input);
    throw new Error("expected ProductAuthorizationBuilderError");
  } catch (error) {
    expect(error).toBeInstanceOf(ProductAuthorizationBuilderError);
    expect((error as ProductAuthorizationBuilderError).code).toBe(code);
  }
}

function planAttestedEvent(blockNumber: bigint): ChainEvent {
  return planAttestedEventFor(
    blockNumber,
    0,
    crossBorderPlanIds.planId,
    crossBorderPlanIds.planHash,
    crossBorderPlanIds.artifactHash
  );
}

function planAttestedEventFor(
  blockNumber: bigint,
  logIndex: number,
  planId: string,
  planHash: string,
  artifactHash: string
): ChainEvent {
  return chainEvent(blockNumber, logIndex, "PlanAttested", {
    domainId: crossBorderPlanIds.domainId,
    planId,
    planHash,
    artifactHash,
    policyHash,
    metadataHash,
    metadataURI: "https://store.example/zhixu/cross-border",
    attester
  });
}

function planRevokedEvent(blockNumber: bigint): ChainEvent {
  return chainEvent(blockNumber, 1, "PlanRevoked", {
    domainId: crossBorderPlanIds.domainId,
    planId: crossBorderPlanIds.planId,
    reasonHash,
    reasonURI: "https://store.example/revocations/cross-border",
    revoker: attester
  });
}

function activeDeploymentEvents(): readonly ChainEvent[] {
  return [
    chainEvent(1n, 0, "DeploymentRegistered", {
      deploymentId: activeDeploymentId,
      stateMachine: activeStateMachineAddress,
      trustRegistry: trustRegistryAddress,
      officialDomainId: crossBorderPlanIds.domainId,
      artifactHash: crossBorderPlanIds.artifactHash,
      abiHash: metadataHash,
      deploymentBlock: 1n,
      metadataURI: "uvp-eth://deployments/v2"
    }, deploymentRegistryAddress),
    chainEvent(2n, 0, "DeploymentCanaryMarked", {
      deploymentId: activeDeploymentId,
      evidenceHash: metadataHash,
      evidenceURI: "uvp-eth://evidence/v2"
    }, deploymentRegistryAddress),
    chainEvent(3n, 0, "DeploymentActivated", {
      previousDeploymentId: "0x0000000000000000000000000000000000000000000000000000000000000000",
      newDeploymentId: activeDeploymentId,
      evidenceHash: metadataHash,
      evidenceURI: "uvp-eth://evidence/v2"
    }, deploymentRegistryAddress)
  ];
}

function chainEvent(
  blockNumber: bigint,
  logIndex: number,
  eventName: string,
  args: Record<string, unknown>,
  eventContractAddress = contractAddress
): ChainEvent {
  return {
    chainId: 31337,
    contractAddress: eventContractAddress as ChainEvent["contractAddress"],
    blockNumber,
    transactionHash: `0x${blockNumber.toString(16).padStart(64, "0")}`,
    logIndex,
    eventName,
    args
  };
}
