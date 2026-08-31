import { describe, expect, it, vi } from "vitest";
import type { StoreProductSchemaDTO } from "@uvp-eth/product-dto";
import { privateKeyToAccount } from "viem/accounts";
import { createApiRouter, type ApiRouter } from "../src/api/routes.js";
import type { ChainServicesRuntimeEnv } from "../src/config/index.js";
import type { ChainEvent } from "../src/indexer/events.js";
import {
  MemoryProductBffStore,
  type ProductBffStore,
} from "../src/product/bff/store.js";
import {
  createProductDockedOrderLinkService,
  createProductStageExecutorPatchService,
  createProductStageResourcePatchService,
  DOCKED_ORDER_LINK_SIGNAL_ID,
  hashResourceManifest,
  type PreparedDockedOrderLinkDTO,
  type PreparedStageExecutorPatchDTO,
  type PreparedStageResourcePatchDTO,
  type StageExecutorPatchBroadcastAdapter,
  type StagePatchBroadcastResult,
  type StageResourcePatchBroadcastAdapter,
} from "../src/stage-patches/index.js";
import { MemoryProjectionStore } from "../src/storage/projection-store.js";
import {
  normalizeAddress,
  type Address,
  type Hex,
} from "../src/shared/types.js";

const chainId = 31337;
const contractAddress = "0x1111111111111111111111111111111111111111" as Address;
const stateMachineAddress =
  "0x4444444444444444444444444444444444444444" as Address;
const planId = bytes32Hex("101");
const planHash =
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex;
const linkedPlanId = bytes32Hex("102");
const linkedPlanHash =
  "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" as Hex;
const artifactHash =
  "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Hex;
const orderId = bytes32Hex("202");
const linkedOrderId = bytes32Hex("203");
const selectorStageId = bytes32Text("selector.stage");
const selectorStageOnchainId =
  "0x31ca11fdde4f72e7368e356f13c363594453a94adc6f834b1a29a03a67319af0" as Hex;
const targetStageId = bytes32Text("target.stage");
const targetStageOnchainId =
  "0x26cc04b18410316cea7364178848d74c4c4cdbec93b7497a57eec8a6f7f49fbc" as Hex;
const selectorHookId = bytes32Hex("303");
const selectorHookName = bytes32Text("select-executor");
const selectorRoleSlotId = "buyer-selector";
const resourceControllerRoleSlotId = "buyer-resource-controller";
const executorPatchSignalId =
  "0xbbb1770c9313f4029a89e03f4719037cdad52864ab4da5f623bc7c8a0c489e97" as Hex;
const resourcePatchSignalId =
  "0x6dff331f2bb7b785cbcd99a911e6d30dc8714f43b3b9ba80c658215445ddd0ba" as Hex;
const approvalSourceId = bytes32Text("approval.stage");
const approvalSignalId = bytes32Text("approve-replacement");
const roleHash = bytes32Text("target.executor");
const executorMetadataHash = bytes32Hex("404");
const executorPatchHash = bytes32Hex("505");
const resourcePatchHash = bytes32Hex("606");
const txHash = bytes32Hex("707");
const manifestHash = bytes32Hex("a11");
const policyHash = bytes32Hex("b22");
const resourceKey = "invoice-pdf";
const selectorAccount = privateKeyToAccount(
  "0x1111111111111111111111111111111111111111111111111111111111111111",
);
const previousExecutorAccount = privateKeyToAccount(
  "0x2222222222222222222222222222222222222222222222222222222222222222",
);
const selectorWallet = normalizeAddress(selectorAccount.address, "selector");
const previousExecutorWallet = normalizeAddress(
  previousExecutorAccount.address,
  "previousExecutor",
);
const wrongWallet = "0x2222222222222222222222222222222222222222" as Address;
const executorWallet = "0x3333333333333333333333333333333333333333" as Address;
const baseNow = new Date("2026-04-30T00:00:00Z");

describe("stage executor/resource patch Product API", () => {
  it("hashes resource manifests deterministically", () => {
    const left = hashResourceManifest({
      schemaVersion: "uvp-resource-manifest-v1",
      resourceKey,
      visibility: "protected",
      storageCID: "bafy-a",
      policyHash,
    });
    const right = hashResourceManifest({
      policyHash,
      storageCID: "bafy-a",
      visibility: "protected",
      resourceKey,
      schemaVersion: "uvp-resource-manifest-v1",
    });

    expect(left).toBe(right);
  });

  it("accepts reordered prepared envelopes when comparing canonical typed data", async () => {
    const { router } = await routerFixture();
    const prepared = await prepareStageExecutorPatch(router);
    const response = await router.handle({
      method: "POST",
      pathname: `/product/tasks/${selectorTaskId()}/submit-stage-executor-patch`,
      body: {
        prepareId: prepared.prepareId,
        selectorWallet,
        typedData: reverseObjectKeys(prepared.typedData),
        patch: reverseObjectKeys(prepared),
        signature: await signExecutorPrepared(prepared),
      },
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      signatureStatus: "signature_verified",
      recoveredSelector: selectorWallet,
    });
  });

  it("prepares and submits a selector-signed stage executor patch through the broadcast adapter", async () => {
    const broadcast: StageExecutorPatchBroadcastAdapter = {
      broadcast: vi.fn(async (request): Promise<StagePatchBroadcastResult> => {
        expect(request.prepared.selectorWallet).toBe(selectorWallet);
        expect(request.prepared.mode).toBe("assign");
        expect(request.recoveredSelector).toBe(selectorWallet);
        expect(request.previousExecutorSignature).toBeUndefined();
        expect(JSON.stringify(request.prepared)).not.toContain("fileResources");
        return {
          status: "submitted",
          txHash,
          blockNumber: "123",
        };
      }),
    };
    const { router } = await routerFixture({
      executorBroadcastAdapter: broadcast,
    });

    const prepared = await prepareStageExecutorPatch(router);
    const signature = await signExecutorPrepared(prepared);
    const submitResponse = await router.handle({
      method: "POST",
      pathname: `/product/tasks/${selectorTaskId()}/submit-stage-executor-patch`,
      body: {
        selectorWallet,
        typedData: prepared.typedData,
        patch: prepared,
        signature,
      },
    });

    expect(prepared).toMatchObject({
      prepareId: "prep_1",
      taskId: selectorTaskId(),
      orderId,
      selectorStageId,
      targetStageId,
      selectorWallet,
      executorWallet,
      mode: "assign",
      roleHash,
      executorMetadataHash,
      patchNonce: "1",
      status: "prepared",
      typedData: {
        domain: {
          name: "UVPStagePatchModule",
          version: "0.1",
          chainId,
          verifyingContract: contractAddress,
        },
        primaryType: "UVPStagePatchModuleStageExecutorPatch",
      },
    });
    expect(prepared.typedData.message).toMatchObject({
      mode: prepared.modeHash,
      previousExecutor: "0x0000000000000000000000000000000000000000",
      approvalSourceId:
        "0x0000000000000000000000000000000000000000000000000000000000000000",
      approvalSignalId:
        "0x0000000000000000000000000000000000000000000000000000000000000000",
    });
    expect(prepared.patchHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(JSON.stringify(prepared)).not.toContain("fileResources");
    expect(submitResponse.status).toBe(200);
    expect(submitResponse.body).toMatchObject({
      submissionId: "sub_1",
      status: "submitted",
      signatureStatus: "signature_verified",
      selectorSignatureStatus: "signature_verified",
      previousExecutorSignatureStatus: "not_required",
      recoveredSelector: selectorWallet,
      broadcastStatus: "submitted",
      txHash,
      blockNumber: "123",
      retryable: false,
    });
    expect(JSON.stringify(submitResponse.body)).not.toContain("fileResources");
    expect(broadcast.broadcast).toHaveBeenCalledOnce();
  });

  it("rejects assign mode after the target stage has submitted a signal", async () => {
    const { router } = await routerFixture({
      events: [...baseEvents(), targetSignalSubmittedEvent(5n)],
    });
    const response = await router.handle({
      method: "POST",
      pathname: `/product/tasks/${selectorTaskId()}/prepare-stage-executor-patch`,
      body: prepareExecutorBody({ mode: "assign" }),
    });

    expect(response).toMatchObject({
      status: 409,
      body: { error: "target_stage_started_assign_rejected" },
    });
  });

  it("requires and verifies the previous executor signature for handoff mode", async () => {
    const broadcast: StageExecutorPatchBroadcastAdapter = {
      broadcast: vi.fn(async (request): Promise<StagePatchBroadcastResult> => {
        expect(request.prepared.mode).toBe("handoff");
        expect(request.prepared.previousExecutor).toBe(previousExecutorWallet);
        expect(request.previousExecutorSignature).toMatch(/^0x[0-9a-f]+$/);
        expect(request.recoveredPreviousExecutor).toBe(previousExecutorWallet);
        return {
          status: "submitted",
          txHash,
        };
      }),
    };
    const { router } = await routerFixture({
      events: [...baseEvents(), targetSignalSubmittedEvent(5n)],
      executorBroadcastAdapter: broadcast,
    });
    const prepared = await prepareStageExecutorPatch(router, {
      mode: "handoff",
      previousExecutorWallet,
    });
    const selectorSignature = await signExecutorPrepared(prepared);

    const missingPrevious = await router.handle({
      method: "POST",
      pathname: `/product/tasks/${selectorTaskId()}/submit-stage-executor-patch`,
      body: {
        prepareId: prepared.prepareId,
        selectorWallet,
        signature: selectorSignature,
      },
    });
    expect(missingPrevious).toMatchObject({
      status: 400,
      body: { error: "previous_executor_signature_required" },
    });

    const wrongPrevious = await routerFixture({
      events: [...baseEvents(), targetSignalSubmittedEvent(5n)],
      executorBroadcastAdapter: broadcast,
    });
    const wrongPrepared = await prepareStageExecutorPatch(
      wrongPrevious.router,
      {
        mode: "handoff",
        previousExecutorWallet,
      },
    );
    const wrongResponse = await wrongPrevious.router.handle({
      method: "POST",
      pathname: `/product/tasks/${selectorTaskId()}/submit-stage-executor-patch`,
      body: {
        prepareId: wrongPrepared.prepareId,
        selectorWallet,
        signature: await signExecutorPrepared(wrongPrepared),
        previousExecutorSignature: await signExecutorPrepared(wrongPrepared),
      },
    });
    expect(wrongResponse).toMatchObject({
      status: 400,
      body: { error: "invalid_previous_executor_signature" },
    });

    const valid = await routerFixture({
      events: [...baseEvents(), targetSignalSubmittedEvent(5n)],
      executorBroadcastAdapter: broadcast,
    });
    const validPrepared = await prepareStageExecutorPatch(valid.router, {
      mode: "handoff",
      previousExecutorWallet,
    });
    const validResponse = await valid.router.handle({
      method: "POST",
      pathname: `/product/tasks/${selectorTaskId()}/submit-stage-executor-patch`,
      body: {
        prepareId: validPrepared.prepareId,
        selectorWallet,
        signature: await signExecutorPrepared(validPrepared),
        previousExecutorSignature: await signExecutorPrepared(
          validPrepared,
          previousExecutorAccount,
        ),
      },
    });

    expect(validResponse).toMatchObject({
      status: 200,
      body: {
        mode: "handoff",
        previousExecutor: previousExecutorWallet,
        selectorSignatureStatus: "signature_verified",
        previousExecutorSignatureStatus: "signature_verified",
        recoveredPreviousExecutor: previousExecutorWallet,
      },
    });
    expect(broadcast.broadcast).toHaveBeenCalledOnce();
  });

  it("requires an existing approval signal for replacement mode", async () => {
    const missing = await routerFixture({
      events: [...baseEvents(), targetSignalSubmittedEvent(5n)],
    });
    const missingResponse = await missing.router.handle({
      method: "POST",
      pathname: `/product/tasks/${selectorTaskId()}/prepare-stage-executor-patch`,
      body: prepareExecutorBody({
        mode: "replace",
        previousExecutorWallet,
        approval: {
          sourceId: approvalSourceId,
          signalId: approvalSignalId,
        },
      }),
    });
    expect(missingResponse).toMatchObject({
      status: 409,
      body: { error: "approval_signal_missing" },
    });

    const broadcast: StageExecutorPatchBroadcastAdapter = {
      broadcast: vi.fn(async (request): Promise<StagePatchBroadcastResult> => {
        expect(request.prepared.mode).toBe("replacement");
        expect(request.prepared.approvalSourceId).toBe(approvalSourceId);
        expect(request.prepared.approvalSignalId).toBe(approvalSignalId);
        expect(request.previousExecutorSignature).toBeUndefined();
        return {
          status: "submitted",
          txHash,
        };
      }),
    };
    const valid = await routerFixture({
      events: [
        ...baseEvents(),
        targetSignalSubmittedEvent(5n),
        approvalSignalSubmittedEvent(6n),
      ],
      executorBroadcastAdapter: broadcast,
    });
    const prepared = await prepareStageExecutorPatch(valid.router, {
      mode: "replace",
      previousExecutorWallet,
      approval: {
        sourceId: approvalSourceId,
        signalId: approvalSignalId,
      },
    });
    const response = await valid.router.handle({
      method: "POST",
      pathname: `/product/tasks/${selectorTaskId()}/submit-stage-executor-patch`,
      body: {
        prepareId: prepared.prepareId,
        selectorWallet,
        signature: await signExecutorPrepared(prepared),
      },
    });

    expect(response).toMatchObject({
      status: 200,
      body: {
        mode: "replacement",
        previousExecutor: previousExecutorWallet,
        approvalSourceId,
        approvalSignalId,
        previousExecutorSignatureStatus: "not_required",
        txHash,
      },
    });
    expect(
      (response.body as { readonly proofRows: readonly unknown[] }).proofRows,
    ).toEqual(
      expect.arrayContaining([
        { label: "Mode", value: "replacement" },
        { label: "Previous executor", value: previousExecutorWallet },
        {
          label: "Approval signal",
          value: `${approvalSourceId}:${approvalSignalId}`,
        },
        { label: "Selector signature", value: "signature_verified" },
        { label: "Previous executor signature", value: "not_required" },
      ]),
    );
    expect(broadcast.broadcast).toHaveBeenCalledOnce();
  });

  it("prepares and submits a selector-signed stage resource patch through the broadcast adapter", async () => {
    const broadcast: StageResourcePatchBroadcastAdapter = {
      broadcast: vi.fn(async (request): Promise<StagePatchBroadcastResult> => {
        expect(request.prepared.selectorWallet).toBe(selectorWallet);
        expect(request.prepared.manifestHash).toBe(manifestHash);
        expect(request.prepared.policyHash).toBe(policyHash);
        expect(request.recoveredSelector).toBe(selectorWallet);
        return {
          status: "confirmed",
          txHash,
          blockNumber: "124",
        };
      }),
    };
    const { router } = await routerFixture({
      resourceBroadcastAdapter: broadcast,
    });

    const prepared = await prepareStageResourcePatch(router);
    const signature = await signResourcePrepared(prepared);
    const submitResponse = await router.handle({
      method: "POST",
      pathname: `/product/tasks/${selectorTaskId()}/submit-stage-resource-patch`,
      body: {
        selectorWallet,
        typedData: prepared.typedData,
        patch: prepared,
        signature,
      },
    });

    expect(prepared).toMatchObject({
      prepareId: "prep_1",
      taskId: selectorTaskId(),
      orderId,
      selectorStageId,
      targetStageId,
      selectorWallet,
      manifestHash,
      policyHash,
      patchNonce: "1",
      manifestURI: "ipfs://resource-manifests/invoice-v1",
      status: "prepared",
      typedData: {
        primaryType: "UVPStagePatchModuleStageResourcePatch",
      },
    });
    expect(prepared.resourceKey).toMatch(/^0x[0-9a-f]{64}$/);
    expect(prepared.patchHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(submitResponse.status).toBe(200);
    expect(submitResponse.body).toMatchObject({
      submissionId: "sub_1",
      status: "confirmed",
      signatureStatus: "signature_verified",
      recoveredSelector: selectorWallet,
      broadcastStatus: "confirmed",
      txHash,
      blockNumber: "124",
      retryable: false,
    });
    expect(broadcast.broadcast).toHaveBeenCalledOnce();
  });

  it("requires content-addressed resource manifest references in production", async () => {
    const { router } = await routerFixture({
      runtimeEnvironment: "production",
    });
    for (const manifestURI of [
      "https://files.example/invoice.pdf",
      "invoice-manifest.json",
    ]) {
      const response = await router.handle({
        method: "POST",
        pathname: `/product/tasks/${selectorTaskId()}/prepare-stage-resource-patch`,
        body: prepareResourceBody({ manifestURI }),
      });
      expect(response).toMatchObject({
        status: 400,
        body: { error: "invalid_manifest_uri" },
      });
    }
  });

  it("rejects selector patch prepares without order-level patch signal authorization", async () => {
    const { router } = await routerFixture({
      events: baseEvents({ includePatchAuthorizations: false }),
    });

    await expect(
      router.handle({
        method: "POST",
        pathname: `/product/tasks/${selectorTaskId()}/prepare-stage-executor-patch`,
        body: prepareExecutorBody(),
      }),
    ).resolves.toMatchObject({
      status: 403,
      body: { error: "order_signal_authorization_missing" },
    });

    await expect(
      router.handle({
        method: "POST",
        pathname: `/product/tasks/${selectorTaskId()}/prepare-stage-resource-patch`,
        body: prepareResourceBody(),
      }),
    ).resolves.toMatchObject({
      status: 403,
      body: { error: "order_signal_authorization_missing" },
    });
  });

  it("rejects a signer wallet that is not assigned to the executor patch task", async () => {
    const { router } = await routerFixture();
    const response = await router.handle({
      method: "POST",
      pathname: `/product/tasks/${selectorTaskId()}/prepare-stage-executor-patch`,
      body: prepareExecutorBody({ selectorWallet: wrongWallet }),
    });

    expect(response).toMatchObject({
      status: 403,
      body: { error: "selector_wallet_not_authorized" },
    });
  });

  it("allows an accepted selector participant when the raw chain task has no assignee wallet", async () => {
    const { router } = await routerFixture({
      events: baseEvents({
        includeSelectorTaskAuthorization: false,
        selectorStageId: selectorStageOnchainId,
        targetStageId: targetStageOnchainId,
      }),
      productBffStore: await productStoreFixture([
        participantFixture(selectorRoleSlotId, selectorWallet),
        participantFixture(resourceControllerRoleSlotId, wrongWallet),
      ]),
      productSchema: productSchemaFixture(),
    });

    const response = await router.handle({
      method: "POST",
      pathname: `/product/tasks/${selectorTaskId()}/prepare-stage-executor-patch`,
      body: prepareExecutorBody({ targetStageId: "target.stage" }),
    });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      selectorStageId: selectorStageOnchainId,
      targetStageId: targetStageOnchainId,
      selectorWallet,
    });
  });

  it("rejects resource controller or other participant wallets for an executor patch task inferred from Product metadata", async () => {
    const { router } = await routerFixture({
      events: baseEvents({
        includeSelectorTaskAuthorization: false,
        selectorStageId: selectorStageOnchainId,
        targetStageId: targetStageOnchainId,
      }),
      productBffStore: await productStoreFixture([
        participantFixture(selectorRoleSlotId, selectorWallet),
        participantFixture(resourceControllerRoleSlotId, wrongWallet),
      ]),
      productSchema: productSchemaFixture(),
    });

    const response = await router.handle({
      method: "POST",
      pathname: `/product/tasks/${selectorTaskId()}/prepare-stage-executor-patch`,
      body: prepareExecutorBody({
        selectorWallet: wrongWallet,
        targetStageId: "target.stage",
      }),
    });

    expect(response).toMatchObject({
      status: 403,
      body: { error: "selector_wallet_not_authorized" },
    });
  });

  it("fails closed when raw task assignment is missing and Product participant context is unavailable", async () => {
    const { router } = await routerFixture({
      events: baseEvents({
        includeSelectorTaskAuthorization: false,
        selectorStageId: selectorStageOnchainId,
        targetStageId: targetStageOnchainId,
      }),
      productSchema: productSchemaFixture(),
    });

    const response = await router.handle({
      method: "POST",
      pathname: `/product/tasks/${selectorTaskId()}/prepare-stage-executor-patch`,
      body: prepareExecutorBody({ targetStageId: "target.stage" }),
    });

    expect(response).toMatchObject({
      status: 403,
      body: { error: "selector_wallet_not_authorized" },
    });
  });

  it("rejects target stages outside the plan selector bindings", async () => {
    const { router } = await routerFixture();
    const response = await router.handle({
      method: "POST",
      pathname: `/product/tasks/${selectorTaskId()}/prepare-stage-resource-patch`,
      body: prepareResourceBody({
        targetStageId: bytes32Text("unknown.stage"),
      }),
    });

    expect(response).toMatchObject({
      status: 400,
      body: { error: "invalid_target_stage" },
    });
  });

  it("rejects stale executor prepared nonces and duplicate prepare reuse", async () => {
    const stale = await routerFixture();
    const stalePrepared = await prepareStageExecutorPatch(stale.router);
    await stale.store.resetFromEvents({
      deploymentBlock: 0n,
      events: [...baseEvents(), stageExecutorPatchAppliedEvent(5n, 1n)],
    });
    const staleResponse = await stale.router.handle({
      method: "POST",
      pathname: `/product/tasks/${selectorTaskId()}/submit-stage-executor-patch`,
      body: {
        prepareId: stalePrepared.prepareId,
        selectorWallet,
        signature: await signExecutorPrepared(stalePrepared),
      },
    });

    expect(staleResponse).toMatchObject({
      status: 409,
      body: { error: "stale_stage_executor_patch_nonce" },
    });

    const duplicate = await routerFixture();
    const duplicatePrepared = await prepareStageExecutorPatch(duplicate.router);
    const duplicateSignature = await signExecutorPrepared(duplicatePrepared);
    const firstSubmit = await duplicate.router.handle({
      method: "POST",
      pathname: `/product/tasks/${selectorTaskId()}/submit-stage-executor-patch`,
      body: {
        prepareId: duplicatePrepared.prepareId,
        selectorWallet,
        signature: duplicateSignature,
      },
    });
    const secondSubmit = await duplicate.router.handle({
      method: "POST",
      pathname: `/product/tasks/${selectorTaskId()}/submit-stage-executor-patch`,
      body: {
        prepareId: duplicatePrepared.prepareId,
        selectorWallet,
        signature: duplicateSignature,
      },
    });

    expect(firstSubmit.status).toBe(200);
    expect(secondSubmit).toMatchObject({
      status: 409,
      body: { error: "prepare_already_used" },
    });
  });

  it("verifies resource patch signatures but does not relay when the relayer is disabled", async () => {
    const { router } = await routerFixture();
    const prepared = await prepareStageResourcePatch(router);
    const response = await router.handle({
      method: "POST",
      pathname: `/product/tasks/${selectorTaskId()}/submit-stage-resource-patch`,
      body: {
        prepareId: prepared.prepareId,
        selectorWallet,
        signature: await signResourcePrepared(prepared),
      },
    });

    expect(response).toMatchObject({
      status: 200,
      body: {
        status: "signature_received",
        signatureStatus: "signature_verified",
        recoveredSelector: selectorWallet,
        broadcastStatus: "not_attempted",
        errorCode: "broadcast_disabled",
        retryable: false,
      },
    });
  });

  it("prepares docked order links after both plans are registered", async () => {
    const { router } = await routerFixture({
      events: [
        ...baseEvents(),
        planRegisteredEvent(5n, planId, planHash),
        ...linkedOrderEvents(6n),
        planRegisteredEvent(8n, linkedPlanId, linkedPlanHash),
      ],
    });

    const prepared = await prepareDockedOrderLink(router);

    expect(prepared).toMatchObject({
      prepareId: "prep_1",
      taskId: selectorTaskId(),
      localOrderId: orderId,
      linkedOrderId,
      linkedPlanId,
      selectorWallet,
      localSourceId: targetStageId,
      status: "prepared",
      typedData: {
        primaryType: "UVPDockingModuleDockedOrderLink",
      },
    });
  });
});

async function routerFixture(
  options: {
    readonly executorBroadcastAdapter?: StageExecutorPatchBroadcastAdapter;
    readonly resourceBroadcastAdapter?: StageResourcePatchBroadcastAdapter;
    readonly runtimeEnvironment?: ChainServicesRuntimeEnv;
    readonly events?: readonly ChainEvent[];
    readonly productBffStore?: ProductBffStore;
    readonly productSchema?: StoreProductSchemaDTO;
  } = {},
): Promise<{
  readonly router: ApiRouter;
  readonly store: MemoryProjectionStore;
}> {
  const store = new MemoryProjectionStore();
  await store.resetFromEvents({
    deploymentBlock: 0n,
    events: options.events ?? baseEvents(),
  });
  const productSchemaResolver = options.productSchema
    ? {
        getProductSchemaByPlan: async (
          requestedPlanId: string,
          requestedPlanHash: string,
        ) =>
          requestedPlanId === options.productSchema!.planId &&
          requestedPlanHash === options.productSchema!.planHash
            ? options.productSchema
            : undefined,
      }
    : undefined;
  let prepareCount = 0;
  let submissionCount = 0;
  const commonOptions = {
    store,
    ...(productSchemaResolver ? { productSchemaResolver } : {}),
    ...(options.productBffStore
      ? { productBffStore: options.productBffStore }
      : {}),
    chainId,
    verifyingContract: contractAddress,
    now: () => baseNow,
    prepareIdFactory: () => `prep_${++prepareCount}`,
    submissionIdFactory: () => `sub_${++submissionCount}`,
  };
  const executorService = createProductStageExecutorPatchService({
    ...commonOptions,
    ...(options.executorBroadcastAdapter
      ? { broadcastAdapter: options.executorBroadcastAdapter }
      : {}),
  });
  const resourceService = createProductStageResourcePatchService({
    ...commonOptions,
    ...(options.resourceBroadcastAdapter
      ? { broadcastAdapter: options.resourceBroadcastAdapter }
      : {}),
    ...(options.runtimeEnvironment
      ? { runtimeEnvironment: options.runtimeEnvironment }
      : {}),
  });
  const dockedOrderLinkService = createProductDockedOrderLinkService({
    ...commonOptions,
  });
  return {
    store,
    router: createApiRouter(store, { submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111",
      productStageExecutorPatchService: executorService,
      productStageResourcePatchService: resourceService,
      productDockedOrderLinkService: dockedOrderLinkService,
    }),
  };
}

async function prepareStageExecutorPatch(
  router: ApiRouter,
  overrides: Record<string, unknown> = {},
): Promise<PreparedStageExecutorPatchDTO> {
  const response = await router.handle({
    method: "POST",
    pathname: `/product/tasks/${selectorTaskId()}/prepare-stage-executor-patch`,
    body: prepareExecutorBody(overrides),
  });
  expect(response.status).toBe(201);
  return response.body as PreparedStageExecutorPatchDTO;
}

async function prepareStageResourcePatch(
  router: ApiRouter,
): Promise<PreparedStageResourcePatchDTO> {
  const response = await router.handle({
    method: "POST",
    pathname: `/product/tasks/${selectorTaskId()}/prepare-stage-resource-patch`,
    body: prepareResourceBody(),
  });
  expect(response.status).toBe(201);
  return response.body as PreparedStageResourcePatchDTO;
}

async function prepareDockedOrderLink(
  router: ApiRouter,
): Promise<PreparedDockedOrderLinkDTO> {
  const response = await router.handle({
    method: "POST",
    pathname: `/product/tasks/${selectorTaskId()}/prepare-docked-order-link`,
    body: prepareDockedBody(),
  });
  expect(response.status).toBe(201);
  return response.body as PreparedDockedOrderLinkDTO;
}

function prepareExecutorBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    selectorWallet,
    targetStageId,
    executorWallet,
    mode: "assign",
    roleHash,
    executorMetadataHash,
    metadataURI: "ipfs://stage-executor-patches/1",
    ...overrides,
  };
}

function prepareResourceBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    selectorWallet,
    targetStageId,
    resourceKey,
    manifestHash,
    policyHash,
    manifestURI: "ipfs://resource-manifests/invoice-v1",
    ...overrides,
  };
}

function prepareDockedBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    selectorWallet,
    localSourceId: targetStageId,
    linkedOrderId,
    linkedPlanId,
    signalBindings: [
      {
        localSourceId: targetStageId,
        localSignalId: bytes32Text("local.done"),
        linkedSourceId: targetStageId,
        linkedSignalId: bytes32Text("linked.done"),
      },
    ],
    metadataURI: "ipfs://docked-order-links/1",
    ...overrides,
  };
}

async function signExecutorPrepared(
  prepared: PreparedStageExecutorPatchDTO,
  account: typeof selectorAccount = selectorAccount,
): Promise<Hex> {
  return await account.signTypedData(
    prepared.typedData as unknown as Parameters<
      typeof account.signTypedData
    >[0],
  );
}

async function signResourcePrepared(
  prepared: PreparedStageResourcePatchDTO,
): Promise<Hex> {
  return await selectorAccount.signTypedData(
    prepared.typedData as unknown as Parameters<
      typeof selectorAccount.signTypedData
    >[0],
  );
}

interface ParticipantFixture {
  readonly roleSlotId: string;
  readonly walletAddress: Address;
}

function participantFixture(
  roleSlotId: string,
  walletAddress: Address,
): ParticipantFixture {
  return { roleSlotId, walletAddress };
}

function reverseObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => reverseObjectKeys(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .reverse()
        .map(([key, nested]) => [key, reverseObjectKeys(nested)]),
    );
  }
  return value;
}

async function productStoreFixture(
  participants: readonly ParticipantFixture[],
): Promise<ProductBffStore> {
  const store = new MemoryProductBffStore();
  await store.createDraft(
    {
      draftId: "draft_stage_patch_1",
      zhixuId: "stage-patch-test",
      planId,
      planHash,
      title: "Stage patch test order",
      businessType: "stage-patch",
      goods: [],
      totalAmount: "0",
      currency: "USDC",
      status: "triggered",
      createdAt: baseNow.toISOString(),
      updatedAt: baseNow.toISOString(),
      triggeredOrderId: orderId,
    },
    participants.map((participant, index) => ({
      participantId: `participant_${index + 1}`,
      draftId: "draft_stage_patch_1",
      roleSlotId: participant.roleSlotId,
      roleLabel: participant.roleSlotId,
      displayName: participant.roleSlotId,
      walletAddress: participant.walletAddress,
      contact: `${participant.roleSlotId}@stage-patch.test`,
      status: "accepted" as const,
      required: true,
      acceptedAt: baseNow.toISOString(),
    })),
  );
  await store.createRegistration({
    triggerId: "registration_stage_patch_1",
    prepareId: "prepare_stage_patch_1",
    draftId: "draft_stage_patch_1",
    orderId,
    stateMachineAddress: contractAddress,
    planId,
    planHash,
    status: "confirmed",
    blockNumber: "2",
    sourceId: bytes32Text("product"),
    signalId: bytes32Text("created"),
    triggerHookId: bytes32Text("create-hook"),
    triggerStageId: bytes32Text("create-stage"),
    submitter: selectorWallet,
    payloadHash: bytes32Hex("aaa"),
    idempotencyKey: bytes32Hex("bbb"),
    deadline: "1770000000",
    typedData: {},
    retryable: false,
    createdAt: baseNow.toISOString(),
    updatedAt: baseNow.toISOString(),
    creator: selectorWallet,
    authorizations: [],
    permissions: [],
  });
  return store;
}

function productSchemaFixture(): StoreProductSchemaDTO {
  const selectorPlugin = {
    pluginKind: "evidence_submission",
    source: "explicit",
    stageIds: ["selector.stage"],
    requiredEvidence: [],
  } as const;
  const resourceControllerPlugin = {
    pluginKind: "evidence_submission",
    source: "explicit",
    stageIds: ["resource-controller.stage"],
    requiredEvidence: [],
  } as const;
  return {
    schemaVersion: "store-product-schema.v1",
    version: 1,
    zhixuId: "stage-patch-test",
    title: "Stage Patch Test",
    maintainer: "test",
    planId,
    planHash,
    artifactHash,
    roleSlots: [
      {
        slotId: selectorRoleSlotId,
        title: "Buyer selector",
        label: "Buyer selector",
        duty: "Select executor",
        evidence: [],
        status: "required",
        tone: "info",
        required: true,
        capabilityPlugins: [selectorPlugin],
      },
      {
        slotId: resourceControllerRoleSlotId,
        title: "Buyer resource controller",
        label: "Buyer resource controller",
        duty: "Control resources",
        evidence: [],
        status: "required",
        tone: "info",
        required: true,
        capabilityPlugins: [resourceControllerPlugin],
      },
    ],
    orderPermissionTable: [
      {
        permissionId: "selector.executor-patch",
        roleSlotId: selectorRoleSlotId,
        stageId: "selector.stage",
        source: "selector",
        signalName: "select-executor",
        payloadPolicy: "required",
        requiredEvidence: [],
      },
      {
        permissionId: "resource-controller.resource-patch",
        roleSlotId: resourceControllerRoleSlotId,
        stageId: "resource-controller.stage",
        source: "resource-controller",
        signalName: "publish-resource",
        payloadPolicy: "required",
        requiredEvidence: [],
      },
    ],
    capabilityPlugins: [selectorPlugin, resourceControllerPlugin],
    businessPersonaLabels: ["buyer"],
    stages: [
      {
        stageId: "selector.stage",
        index: 1,
        name: "Selector",
        evidence: [],
        ownerRole: "buyer",
        status: "done",
        updatedAt: baseNow.toISOString(),
        stageKind: "control",
        executorAssignment: "static",
        staticExecutorRoleSlotId: selectorRoleSlotId,
        selectedStageTargets: ["target.stage"],
        addOnKind: "stage_executor_patch",
      },
    ],
    selectorBindings: [
      {
        selectorStageIdentifier: "selector.stage",
        targetStageIdentifier: "target.stage",
        selectorStageId: selectorStageOnchainId,
        targetStageId: targetStageOnchainId,
        bindingHash: bytes32Hex("919"),
      },
    ],
    schemaHash: bytes32Hex("a1a1"),
    validation: {
      ok: true,
      status: "explicit",
      issues: [],
    },
    createdAt: baseNow.toISOString(),
    updatedAt: baseNow.toISOString(),
  };
}

function baseEvents(
  options: {
    readonly includePatchAuthorizations?: boolean;
    readonly includeSelectorTaskAuthorization?: boolean;
    readonly selectorStageId?: Hex;
    readonly targetStageId?: Hex;
  } = {},
): readonly ChainEvent[] {
  const includePatchAuthorizations = options.includePatchAuthorizations ?? true;
  const includeSelectorTaskAuthorization =
    options.includeSelectorTaskAuthorization ?? true;
  const eventSelectorStageId = options.selectorStageId ?? selectorStageId;
  const eventTargetStageId = options.targetStageId ?? targetStageId;
  return [
    chainEvent(1n, "PlanRegistered", {
      planId,
      planHash,
      hookCount: 1n,
      selectorBindings: [
        {
          selectorStageIdentifier: "selector.stage",
          targetStageIdentifier: "target.stage",
          selectorStageId: eventSelectorStageId,
          targetStageId: eventTargetStageId,
          bindingHash: bytes32Hex("808"),
        },
      ],
    }),
    chainEvent(
      1n,
      "SignalCapabilityRegistered",
      {
        planId,
        stageId: eventSelectorStageId,
        targetSourceId: eventSelectorStageId,
        signalId: selectorHookName,
        targetOrderRelation: 0,
      },
      1,
    ),
    chainEvent(2n, "OrderRegistered", {
      orderId,
      planId,
    }),
    ...(includeSelectorTaskAuthorization
      ? [
          chainEvent(3n, "SignalSubmitterAuthorized", {
            orderId,
            sourceId: eventSelectorStageId,
            signalId: selectorHookName,
            submitter: selectorWallet,
            role: bytes32Text("selector"),
            metadataHash: bytes32Hex("909"),
          }),
        ]
      : []),
    ...(includePatchAuthorizations
      ? [
          chainEvent(
            3n,
            "SignalSubmitterAuthorized",
            {
              orderId,
              sourceId: eventSelectorStageId,
              signalId: executorPatchSignalId,
              submitter: selectorWallet,
              role: bytes32Text("selector"),
              metadataHash: bytes32Hex("90a"),
            },
            1,
          ),
          chainEvent(
            3n,
            "SignalSubmitterAuthorized",
            {
              orderId,
              sourceId: eventSelectorStageId,
              signalId: resourcePatchSignalId,
              submitter: selectorWallet,
              role: bytes32Text("selector"),
              metadataHash: bytes32Hex("90b"),
            },
            2,
          ),
          chainEvent(
            3n,
            "SignalSubmitterAuthorized",
            {
              orderId,
              sourceId: eventSelectorStageId,
              signalId: DOCKED_ORDER_LINK_SIGNAL_ID,
              submitter: selectorWallet,
              role: bytes32Text("selector"),
              metadataHash: bytes32Hex("90c"),
            },
            3,
          ),
        ]
      : []),
    chainEvent(4n, "HookReady", {
      orderId,
      hookId: selectorHookId,
      stageId: eventSelectorStageId,
      hookName: selectorHookName,
    }),
  ];
}

function linkedOrderEvents(blockNumber: bigint): readonly ChainEvent[] {
  return [
    chainEvent(blockNumber, "PlanRegistered", {
      planId: linkedPlanId,
      planHash: linkedPlanHash,
      hookCount: 1n,
      selectorBindings: [],
    }),
    chainEvent(blockNumber + 1n, "OrderRegistered", {
      orderId: linkedOrderId,
      planId: linkedPlanId,
    }),
  ];
}

function planRegisteredEvent(
  blockNumber: bigint,
  publishedPlanId: Hex,
  publishedPlanHash: Hex,
): ChainEvent {
  return {
    chainId,
    contractAddress: stateMachineAddress,
    blockNumber,
    transactionHash: bytes32Hex(`a${blockNumber.toString(16)}`) as Hex,
    logIndex: 0,
    eventName: "PlanRegistered",
    args: {
      planId: publishedPlanId,
      planHash: publishedPlanHash,
      hookCount: 1n,
    },
  };
}

function stageExecutorPatchAppliedEvent(
  blockNumber: bigint,
  patchNonce: bigint,
): ChainEvent {
  return chainEvent(blockNumber, "StageExecutorPatchApplied", {
    orderId,
    selectorStageId,
    targetStageId,
    selector: selectorWallet,
    executor: executorWallet,
    role: roleHash,
    executorMetadataHash,
    patchHash: executorPatchHash,
    patchNonce,
    metadataURI: "ipfs://stage-executor-patches/1",
  });
}

function targetSignalSubmittedEvent(blockNumber: bigint): ChainEvent {
  return chainEvent(blockNumber, "SignalSubmitted", {
    orderId,
    sourceId: targetStageId,
    signalId: bytes32Text("target-started"),
    payloadHash: bytes32Hex("515"),
    idempotencyKey: bytes32Hex("616"),
    submitter: previousExecutorWallet,
  });
}

function approvalSignalSubmittedEvent(blockNumber: bigint): ChainEvent {
  return chainEvent(blockNumber, "SignalSubmitted", {
    orderId,
    sourceId: approvalSourceId,
    signalId: approvalSignalId,
    payloadHash: bytes32Hex("717"),
    idempotencyKey: bytes32Hex("818"),
    submitter: selectorWallet,
  });
}

function selectorTaskId(): string {
  return `${contractAddress}:${orderId}:${selectorHookId}`;
}

function chainEvent(
  blockNumber: bigint,
  eventName: string,
  args: Record<string, unknown>,
  logIndex = 0,
): ChainEvent {
  return {
    chainId,
    contractAddress,
    blockNumber,
    transactionHash: bytes32Hex(blockNumber.toString(16)) as Hex,
    logIndex,
    eventName,
    args,
  };
}

function bytes32Text(value: string): Hex {
  return `0x${Buffer.from(value, "utf8").toString("hex").padEnd(64, "0")}` as Hex;
}

function bytes32Hex(value: string): Hex {
  return `0x${value.padStart(64, "0")}` as Hex;
}
