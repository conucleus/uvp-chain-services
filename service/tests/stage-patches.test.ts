import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { StoreProductSchemaDTO } from "@uvp-eth/product-dto";
import {
  capabilitiesRootOf,
  ONCHAIN_HOOK_PLAN_SCHEMA_VERSION,
  onchainSignalId,
  onchainSourceId,
} from "@uvp-eth/compiler";
import type { PlanCapabilityTablesInput } from "../src/indexer/projections/plan.js";
import {
  hashResourceManifest as hashProtocolResourceManifest,
  hashSignalAuthorizations,
  type ResourceManifestV1
} from "@uvp-eth/protocol-bindings";
import {
  executorCandidateProofFor,
  executorCandidatesRootOf
} from "../src/submissions/capability-proofs.js";
import { privateKeyToAccount } from "viem/accounts";
import { createApiRouter, type ApiRouter } from "../src/api/routes.js";
import type { ChainServicesRuntimeEnv } from "../src/config/index.js";
import type { ChainEvent } from "../src/indexer/events.js";
import {
  MemoryProductBffStore,
  type ProductBffStore,
} from "../src/product/query/bff/store.js";
import {
  createProductStageExecutorPatchService,
  createProductStageResourcePatchService,
  createStateMachineStageExecutorPatchBroadcastAdapter,
  hashResourceManifest,
  InMemoryProductStagePatchStore,
  type PreparedStageExecutorPatchDTO,
  type PreparedStageExecutorPatchRecord,
  type PreparedStageResourcePatchDTO,
  type PreparedStageResourcePatchRecord,
  type ProductStageExecutorPatchStore,
  type ProductStageResourcePatchStore,
  type StageExecutorPatchBroadcastAdapter,
  type StageExecutorPatchSubmissionDTO,
  type StagePatchBroadcastResult,
  type StageResourcePatchBroadcastAdapter,
  type StageResourcePatchSubmissionDTO,
  PostgresProductStagePatchStore,
} from "../src/stage-patches/index.js";
import { createChainServicesStores, type ChainServicesStores } from "../src/storage/factory.js";
import type { ProjectionStore } from "../src/storage/projection-store.js";
import { createPostgresTestDatabase } from "./postgres.js";

let stores: ChainServicesStores;
let stagePatchDatabaseUrl: string;

beforeAll(async () => {
  stagePatchDatabaseUrl = await createPostgresTestDatabase();
  stores = createChainServicesStores({
    database: { url: stagePatchDatabaseUrl, migrationsAutoRun: true },
    chainId: 31337
  });
});

afterAll(async () => {
  await stores.close();
});

function requiredRouterStores() {
  return {
    storeWalletSessionStore: stores.storeWalletSessionStore,
    identityDescriptorSnapshots: stores.identityDescriptorSnapshots,
    productBffStore: stores.productBffStore,
    orderStore: stores.orderStore,
    orderRequirementsStore: stores.orderRequirementsStore,
    evidenceMetadataStore: stores.evidenceMetadataStore,
    submissionStore: stores.submissionStore,
    governanceStore: stores.governanceStore,
    stageExecutorPatchStore: stores.stageExecutorPatchStore,
    stageResourcePatchStore: stores.stageResourcePatchStore,
  };
}
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
const canonicalPlanHash =
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
const selectorRoleSlotId = "slot-a-selector";
const resourceControllerRoleSlotId = "slot-a-resource-controller";
const executorPatchSignalId =
  "0xbbb1770c9313f4029a89e03f4719037cdad52864ab4da5f623bc7c8a0c489e97" as Hex;
const resourcePatchSignalId =
  "0x6dff331f2bb7b785cbcd99a911e6d30dc8714f43b3b9ba80c658215445ddd0ba" as Hex;
const roleHash = bytes32Text("target.executor");
const executorMetadataHash = bytes32Hex("404");
const executorPatchHash = bytes32Hex("505");
const resourcePatchHash = bytes32Hex("606");
const txHash = bytes32Hex("707");
const manifestHash = bytes32Hex("a11");
const policyHash = bytes32Hex("b22");
const resourceKey = "doc-1";
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
const baseChainClock = { latestBlockTimestampSeconds: async () => Math.floor(baseNow.getTime() / 1000) } as const;

describe("stage executor/resource patch Product API", () => {
  it("hashes resource manifests deterministically with the protocol canonical hash", () => {
    const manifest: ResourceManifestV1 = {
      schemaVersion: "uvp-resource-manifest-v1",
      orderId,
      targetStageId: targetStageOnchainId,
      resourceKey: bytes32Text(resourceKey),
      visibility: "protected",
      ciphertextHash: bytes32Hex("808"),
      storageCID: "ipfs://bafy-resource-ciphertext",
      policyHash,
      recipientEnvelopeRoot: bytes32Hex("909"),
      createdBy: selectorWallet,
      createdAt: "2026-04-30T00:00:00.000Z"
    };
    const reordered: ResourceManifestV1 = {
      createdAt: "2026-04-30T00:00:00.000Z",
      createdBy: selectorWallet,
      recipientEnvelopeRoot: bytes32Hex("909"),
      policyHash,
      storageCID: "ipfs://bafy-resource-ciphertext",
      ciphertextHash: bytes32Hex("808"),
      visibility: "protected",
      resourceKey: bytes32Text(resourceKey),
      targetStageId: targetStageOnchainId,
      orderId,
      schemaVersion: "uvp-resource-manifest-v1"
    };

    const left = hashResourceManifest(manifest);
    expect(left).toBe(hashResourceManifest(reordered));
    expect(left).toBe(hashProtocolResourceManifest(manifest));
  });

  it("accepts reordered prepared envelopes when comparing canonical typed data", async () => {
    const broadcast: StageExecutorPatchBroadcastAdapter = {
      broadcast: async (): Promise<StagePatchBroadcastResult> => ({
        status: "submitted",
        txHash,
      }),
    };
    const { router } = await routerFixture({ executorBroadcastAdapter: broadcast });
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
        expect(request.candidateProof).toEqual(
          executorCandidateProofFor(
            [{ stageId: targetStageId, executor: executorWallet }],
            targetStageId,
            executorWallet,
          ),
        );
        expect(request.executorAuthorizations).toBe(
          request.prepared.executorAuthorizations,
        );
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
          version: "0.2",
          chainId,
          verifyingContract: contractAddress,
        },
        primaryType: "UVPStagePatchModuleStageExecutorPatch",
      },
    });
    expect(prepared.typedData.message).toMatchObject({
      mode: prepared.modeHash,
      previousExecutor: "0x0000000000000000000000000000000000000000",
      authorizationsHash: prepared.authorizationsHash,
    });
    expect(prepared.authorizationsHash).toBe(
      hashSignalAuthorizations(prepared.executorAuthorizations),
    );
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

  it("rejects a previous-executor signature attached to a non-handoff patch before broadcasting", async () => {
    const broadcast = vi.fn(async (): Promise<StagePatchBroadcastResult> => ({
      status: "submitted",
      txHash,
    }));
    const broadcastAdapter: StageExecutorPatchBroadcastAdapter = { broadcast };
    const { router } = await routerFixture({ executorBroadcastAdapter: broadcastAdapter });
    const prepared = await prepareStageExecutorPatch(router);
    const response = await router.handle({
      method: "POST",
      pathname: `/product/tasks/${selectorTaskId()}/submit-stage-executor-patch`,
      body: {
        prepareId: prepared.prepareId,
        selectorWallet,
        typedData: prepared.typedData,
        patch: prepared,
        signature: await signExecutorPrepared(prepared),
        previousExecutorSignature: await signExecutorPrepared(prepared),
      },
    });
    expect(response).toMatchObject({
      status: 400,
      body: { error: "previous_executor_signature_not_allowed" },
    });
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("mirrors the on-chain birth-stage rejection before broadcasting an executor patch", async () => {
    const broadcast = vi.fn(async (): Promise<StagePatchBroadcastResult> => ({
      status: "submitted",
      txHash,
    }));
    const broadcastAdapter: StageExecutorPatchBroadcastAdapter = { broadcast };
    const birthStageSchema = (triggerKind: string): StoreProductSchemaDTO => ({
      ...productSchemaFixture(),
      onchainHookPlanArtifact: {
        schemaVersion: ONCHAIN_HOOK_PLAN_SCHEMA_VERSION,
        compiledHooks: [
          { stageId: targetStageOnchainId, stageIdentifier: "target.stage", orderTriggerKind: triggerKind }
        ]
      } as StoreProductSchemaDTO["onchainHookPlanArtifact"],
    });
    const mintRouter = (await routerFixture({
      executorBroadcastAdapter: broadcastAdapter,
      productSchema: birthStageSchema("mint"),
    })).router;
    const mintPrepared = await prepareStageExecutorPatch(mintRouter);
    const mintResponse = await mintRouter.handle({
      method: "POST",
      pathname: `/product/tasks/${selectorTaskId()}/submit-stage-executor-patch`,
      body: {
        prepareId: mintPrepared.prepareId,
        selectorWallet,
        typedData: mintPrepared.typedData,
        patch: mintPrepared,
        signature: await signExecutorPrepared(mintPrepared),
      },
    });
    expect(mintResponse).toMatchObject({
      status: 409,
      body: { error: "executor_patch_forbidden_on_birth_stage" },
    });
    const dockRouter = (await routerFixture({
      executorBroadcastAdapter: broadcastAdapter,
      productSchema: birthStageSchema("dock"),
    })).router;
    const dockPrepared = await prepareStageExecutorPatch(dockRouter);
    const dockResponse = await dockRouter.handle({
      method: "POST",
      pathname: `/product/tasks/${selectorTaskId()}/submit-stage-executor-patch`,
      body: {
        prepareId: dockPrepared.prepareId,
        selectorWallet,
        typedData: dockPrepared.typedData,
        patch: dockPrepared,
        signature: await signExecutorPrepared(dockPrepared),
      },
    });
    expect(dockResponse).toMatchObject({
      status: 409,
      body: { error: "executor_patch_forbidden_on_birth_stage" },
    });
    const plainRouter = (await routerFixture({
      executorBroadcastAdapter: broadcastAdapter,
      productSchema: birthStageSchema("none"),
    })).router;
    const plainPrepared = await prepareStageExecutorPatch(plainRouter);
    const plainResponse = await plainRouter.handle({
      method: "POST",
      pathname: `/product/tasks/${selectorTaskId()}/submit-stage-executor-patch`,
      body: {
        prepareId: plainPrepared.prepareId,
        selectorWallet,
        typedData: plainPrepared.typedData,
        patch: plainPrepared,
        signature: await signExecutorPrepared(plainPrepared),
      },
    });
    expect(plainResponse.status).toBe(200);
    expect(broadcast).toHaveBeenCalledOnce();
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

  it("rejects executor patch modes outside the assign/handoff vocabulary", async () => {
    const { router } = await routerFixture({
      events: [...baseEvents(), targetSignalSubmittedEvent(5n)],
    });
    await expect(router.handle({
      method: "POST",
      pathname: `/product/tasks/${selectorTaskId()}/prepare-stage-executor-patch`,
      body: prepareExecutorBody({ mode: "rotate", previousExecutorWallet }),
    })).resolves.toMatchObject({
      status: 400,
      body: { error: "invalid_executor_patch_mode" },
    });
  });

  it("fails closed on executor patches when the plan candidate list is unavailable", async () => {
    const emptyCandidates = registerPlanVocabulary({
      selectorBindings: [{ selectorStageId, targetStageId }],
      signalCapabilities: [{
        stageId: selectorStageId,
        targetSourceId: selectorStageId,
        signalId: selectorHookName,
        targetOrderRelation: 0,
      }],
      executorCandidates: [],
    });
    const { router } = await routerFixture({
      events: baseEvents({ vocabulary: emptyCandidates }),
    });
    await expect(router.handle({
      method: "POST",
      pathname: `/product/tasks/${selectorTaskId()}/prepare-stage-executor-patch`,
      body: prepareExecutorBody(),
    })).resolves.toMatchObject({
      status: 409,
      body: { error: "executor_candidate_set_unavailable" },
    });
  });

  it("fails closed when the executor is outside the plan candidate set for the target stage", async () => {
    const strangerCandidates = registerPlanVocabulary({
      selectorBindings: [{ selectorStageId, targetStageId }],
      signalCapabilities: [{
        stageId: selectorStageId,
        targetSourceId: selectorStageId,
        signalId: selectorHookName,
        targetOrderRelation: 0,
      }],
      executorCandidates: [{ stageId: targetStageId, executor: wrongWallet }],
    });
    const { router } = await routerFixture({
      events: baseEvents({ vocabulary: strangerCandidates }),
    });
    await expect(router.handle({
      method: "POST",
      pathname: `/product/tasks/${selectorTaskId()}/prepare-stage-executor-patch`,
      body: prepareExecutorBody(),
    })).resolves.toMatchObject({
      status: 409,
      body: { error: "executor_not_in_candidate_set" },
    });
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
      manifestURI: "ipfs://resource-manifests/doc-1",
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

  it("records a persist_failed fallback with the txHash on the resource patch path when the store write fails after broadcast", async () => {
    const innerBroadcast: StageResourcePatchBroadcastAdapter = {
      broadcast: async (): Promise<StagePatchBroadcastResult> => ({
        status: "submitted",
        txHash,
      }),
    };
    const inner = new InMemoryProductStagePatchStore<
      PreparedStageResourcePatchRecord,
      StageResourcePatchSubmissionDTO
    >();
    let putSubmissionCalls = 0;
    const flakyStore: ProductStageResourcePatchStore = {
      withTransaction: (operation) => operation(),
      putPrepared: (record) => inner.putPrepared(record),
      getPrepared: (prepareId) => inner.getPrepared(prepareId),
      markPreparedUsed: (prepareId, submissionId, usedAt) => inner.markPreparedUsed(prepareId, submissionId, usedAt),
      reserveNonce: (key, options) => inner.reserveNonce(key, options),
      releaseNonce: (key) => inner.releaseNonce(key),
      putSubmission: async (submission) => {
        putSubmissionCalls += 1;
        if (putSubmissionCalls === 1) {
          throw new Error("simulated durable resource patch store outage");
        }
        return inner.putSubmission(submission);
      },
      getSubmission: (submissionId) => inner.getSubmission(submissionId),
    };
    const store = stores.projectionStore;
    await store.resetFromEvents({
      deploymentBlock: 0n,
      events: baseEvents(),
      planCapabilityTables: planCapabilityTablesFor(baseEvents()),
    });
    const failingService = createProductStageResourcePatchService({
      store,
      chainId,
      stagePatchModuleAddress: contractAddress,
      now: () => baseNow,
      chainClock: baseChainClock,
      prepareIdFactory: () => "prep_1",
      submissionIdFactory: () => "sub_1",
      stageResourcePatchStore: flakyStore,
      broadcastAdapter: innerBroadcast,
    });
    const router = createApiRouter(store, { ...requiredRouterStores(),
      productRuntimeEnvironment: "local",
      submissionChainId: 84532,
      submissionVerifyingContract:
        "0x1111111111111111111111111111111111111111",
      productStageResourcePatchService: failingService,
    });
    const prepareResponse = await router.handle({
      method: "POST",
      pathname: `/product/tasks/${selectorTaskId()}/prepare-stage-resource-patch`,
      body: prepareResourceBody(),
    });
    expect(prepareResponse.status).toBe(201);
    const prepared = prepareResponse.body as PreparedStageResourcePatchDTO;
    const submitBody = {
      prepareId: prepared.prepareId,
      selectorWallet,
      signature: await signResourcePrepared(prepared),
    };

    await expect(router.handle({
      method: "POST",
      pathname: `/product/tasks/${selectorTaskId()}/submit-stage-resource-patch`,
      body: submitBody,
    })).rejects.toThrow("simulated durable resource patch store outage");

    expect(putSubmissionCalls).toBe(2);
    await expect(inner.getSubmission("sub_1")).resolves.toMatchObject({
      status: "failed",
      txHash,
      errorCode: "persist_failed",
      retryable: false,
    });

    const retried = await router.handle({
      method: "POST",
      pathname: `/product/tasks/${selectorTaskId()}/submit-stage-resource-patch`,
      body: submitBody,
    });
    expect(retried).toMatchObject({
      status: 409,
      body: { error: "duplicate_stage_resource_patch_nonce" },
    });
  });

  it("requires content-addressed resource manifest references in production", async () => {
    const { router } = await routerFixture({
      runtimeEnvironment: "production",
    });
    for (const manifestURI of [
      "https://files.example/doc-1.pdf",
      "doc-1-manifest.json",
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
    const staleEvents = [...baseEvents(), stageExecutorPatchAppliedEvent(5n, 1n)];
    await stale.store.resetFromEvents({
      deploymentBlock: 0n,
      events: staleEvents,
      planCapabilityTables: planCapabilityTablesFor(staleEvents),
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

    const duplicate = await routerFixture({
      executorBroadcastAdapter: {
        broadcast: async (): Promise<StagePatchBroadcastResult> => ({
          status: "submitted",
          txHash,
        }),
      },
    });
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

  it("ties the selector wallet to the session-anchored address and rejects mismatched claims", async () => {
    const { router } = await routerFixture({ devAnchoredAuth: true });
    const anchoredHeaders = { "x-uvp-store-dev-anchored-address": selectorWallet };
    const aligned = await router.handle({
      method: "POST",
      pathname: `/product/tasks/${selectorTaskId()}/prepare-stage-executor-patch`,
      headers: anchoredHeaders,
      body: prepareExecutorBody(),
    });
    expect(aligned.status).toBe(201);

    await expect(router.handle({
      method: "POST",
      pathname: `/product/tasks/${selectorTaskId()}/prepare-stage-executor-patch`,
      headers: anchoredHeaders,
      body: prepareExecutorBody({ selectorWallet: executorWallet }),
    })).resolves.toMatchObject({
      status: 403,
      body: { error: "wrong_wallet" },
    });
  });

  it("fails loudly with a reusable prepare when the resource patch relayer is disabled", async () => {
    let broadcastCalls = 0;
    const broadcast: StageResourcePatchBroadcastAdapter = {
      broadcast: async (): Promise<StagePatchBroadcastResult> => {
        broadcastCalls += 1;
        return broadcastCalls === 1
          ? {
              status: "not_attempted",
              errorCode: "broadcast_disabled",
              reason: "relayer broadcast is not configured",
            }
          : { status: "submitted", txHash };
      },
    };
    const { router } = await routerFixture({
      resourceBroadcastAdapter: broadcast,
    });
    const prepared = await prepareStageResourcePatch(router);
    const submitBody = {
      prepareId: prepared.prepareId,
      selectorWallet,
      signature: await signResourcePrepared(prepared),
    };

    await expect(router.handle({
      method: "POST",
      pathname: `/product/tasks/${selectorTaskId()}/submit-stage-resource-patch`,
      body: submitBody,
    })).resolves.toMatchObject({
      status: 503,
      body: {
        error: "broadcast_disabled",
        details: { retryable: true },
      },
    });

    const retried = await router.handle({
      method: "POST",
      pathname: `/product/tasks/${selectorTaskId()}/submit-stage-resource-patch`,
      body: submitBody,
    });

    expect(retried).toMatchObject({
      status: 200,
      body: { status: "submitted", txHash },
    });
    expect(broadcastCalls).toBe(2);
  });

  it("fails loudly with a reusable prepare when the executor patch relayer is disabled", async () => {
    let broadcastCalls = 0;
    const broadcast: StageExecutorPatchBroadcastAdapter = {
      broadcast: async (): Promise<StagePatchBroadcastResult> => {
        broadcastCalls += 1;
        return broadcastCalls === 1
          ? {
              status: "not_attempted",
              errorCode: "broadcast_disabled",
              reason: "relayer broadcast is not configured",
            }
          : { status: "submitted", txHash };
      },
    };
    const { router } = await routerFixture({
      executorBroadcastAdapter: broadcast,
    });
    const prepared = await prepareStageExecutorPatch(router);
    const submitBody = {
      prepareId: prepared.prepareId,
      selectorWallet,
      signature: await signExecutorPrepared(prepared),
    };

    await expect(router.handle({
      method: "POST",
      pathname: `/product/tasks/${selectorTaskId()}/submit-stage-executor-patch`,
      body: submitBody,
    })).resolves.toMatchObject({
      status: 503,
      body: {
        error: "broadcast_disabled",
        details: { retryable: true },
      },
    });

    const retried = await router.handle({
      method: "POST",
      pathname: `/product/tasks/${selectorTaskId()}/submit-stage-executor-patch`,
      body: submitBody,
    });

    expect(retried).toMatchObject({
      status: 200,
      body: { status: "submitted", txHash },
    });
    expect(broadcastCalls).toBe(2);
  });

  it("releases the reserved patch nonce when broadcast throws so the same prepareId stays retryable", async () => {
    let broadcastCalls = 0;
    const broadcast: StageExecutorPatchBroadcastAdapter = {
      broadcast: async (): Promise<StagePatchBroadcastResult> => {
        broadcastCalls += 1;
        if (broadcastCalls === 1) {
          throw new Error("rpc connection reset before writeContract");
        }
        return { status: "submitted", txHash };
      },
    };
    const { router } = await routerFixture({
      executorBroadcastAdapter: broadcast,
    });
    const prepared = await prepareStageExecutorPatch(router);
    const signature = await signExecutorPrepared(prepared);
    const submitBody = {
      prepareId: prepared.prepareId,
      selectorWallet,
      signature,
    };

    await expect(router.handle({
      method: "POST",
      pathname: `/product/tasks/${selectorTaskId()}/submit-stage-executor-patch`,
      body: submitBody,
    })).rejects.toThrow("rpc connection reset before writeContract");

    const retried = await router.handle({
      method: "POST",
      pathname: `/product/tasks/${selectorTaskId()}/submit-stage-executor-patch`,
      body: submitBody,
    });

    expect(retried).toMatchObject({ status: 200 });
    expect(broadcastCalls).toBe(2);
  });

  it("reopens the same prepare after a retryable broadcast result without txHash", async () => {
    let broadcastCalls = 0;
    const broadcast: StageExecutorPatchBroadcastAdapter = {
      broadcast: async (): Promise<StagePatchBroadcastResult> => {
        broadcastCalls += 1;
        return broadcastCalls === 1
          ? {
              status: "failed",
              errorCode: "rpc_timeout",
              message: "RPC request timed out",
              retryable: true,
            }
          : { status: "submitted", txHash };
      },
    };
    const { router } = await routerFixture({
      executorBroadcastAdapter: broadcast,
    });
    const prepared = await prepareStageExecutorPatch(router);
    const submitBody = {
      prepareId: prepared.prepareId,
      selectorWallet,
      signature: await signExecutorPrepared(prepared),
    };

    await expect(router.handle({
      method: "POST",
      pathname: `/product/tasks/${selectorTaskId()}/submit-stage-executor-patch`,
      body: submitBody,
    })).resolves.toMatchObject({
      status: 200,
      body: {
        status: "failed",
        retryable: true,
      },
    });

    await expect(router.handle({
      method: "POST",
      pathname: `/product/tasks/${selectorTaskId()}/submit-stage-executor-patch`,
      body: submitBody,
    })).resolves.toMatchObject({
      status: 200,
      body: {
        status: "submitted",
        txHash,
      },
    });
    expect(broadcastCalls).toBe(2);
  });

  it("resolves a duplicate-transaction broadcast through the shared receipt probe", async () => {
    const duplicateTx = bytes32Hex("e0e");
    const receipts = new Map<string, { status?: "success" | "reverted" | string; blockNumber?: bigint }>();
    const writeContract = vi.fn(async () => {
      const error = new Error("already known") as Error & { txHash?: string };
      error.txHash = duplicateTx;
      throw error;
    });
    const adapter = createStateMachineStageExecutorPatchBroadcastAdapter({
      stateMachineAddress,
      chainId,
      publicClient: {
        getChainId: async () => chainId,
        getTransactionReceipt: async ({ hash }: { hash: Hex }) => receipts.get(hash)
      },
      walletClient: {
        account: { address: "0x9999999999999999999999999999999999999999" },
        writeContract
      },
      waitForReceipt: true,
      now: () => baseNow
    });
    const { router } = await routerFixture({ executorBroadcastAdapter: adapter });
    const prepared = await prepareStageExecutorPatch(router);
    const submitBody = {
      prepareId: prepared.prepareId,
      selectorWallet,
      signature: await signExecutorPrepared(prepared),
    };

    await expect(router.handle({
      method: "POST",
      pathname: `/product/tasks/${selectorTaskId()}/submit-stage-executor-patch`,
      body: submitBody,
    })).resolves.toMatchObject({
      status: 200,
      body: {
        status: "failed",
        errorCode: "transaction_receipt_unknown",
        retryable: true,
        txHash: duplicateTx
      }
    });

    receipts.set(duplicateTx, { status: "success", blockNumber: 61n });
    const healedPrepared = await prepareStageExecutorPatch(router, {
      metadataURI: "ipfs://stage-executor-patches/2"
    });
    await expect(adapter.broadcast({
      prepared: healedPrepared,
      signature: await signExecutorPrepared(healedPrepared),
      recoveredSelector: selectorWallet,
      bindingProof: { selectorStageId: healedPrepared.selectorStageId, proof: [] },
      candidateProof: [],
      executorAuthorizations: healedPrepared.executorAuthorizations
    })).resolves.toMatchObject({
      status: "submitted",
      txHash: duplicateTx,
      blockNumber: "61"
    });
    expect(writeContract).toHaveBeenCalledTimes(2);
  });

  const compiledTargetStageIdentifier = "target.stage";
  const compiledFactSource = "origin.stage";
  const compiledFactSignalName = "origin.handoff-proof";
  const compiledTieFactSignalName = "origin.handoff-proof-2";

  function compiledPlanEvents(
    extraSignals: readonly ChainEvent[],
  ): readonly ChainEvent[] {
    const vocabulary = registerPlanVocabulary({
      selectorBindings: [{ selectorStageId, targetStageId: targetStageOnchainId }],
      signalCapabilities: [
        {
          stageId: selectorStageId,
          targetSourceId: selectorStageId,
          signalId: selectorHookName,
          targetOrderRelation: 0,
        },
        {
          stageId: targetStageOnchainId,
          targetSourceId: onchainSourceId(compiledFactSource),
          signalId: onchainSignalId(compiledFactSignalName),
          targetOrderRelation: 0,
        },
        {
          stageId: targetStageOnchainId,
          targetSourceId: onchainSourceId(compiledFactSource),
          signalId: onchainSignalId(compiledTieFactSignalName),
          targetOrderRelation: 0,
        },
      ],
    });
    return [
      ...baseEvents({ targetStageId: targetStageOnchainId, vocabulary }),
      ...extraSignals,
    ];
  }

  function compiledFactSignalEvent(
    blockNumber: bigint,
    submitter: Address,
    signalName = compiledFactSignalName,
    logIndex = 0,
  ): ChainEvent {
    return chainEvent(
      blockNumber,
      "SignalSubmitted",
      {
        orderId,
        sourceId: onchainSourceId(compiledFactSource),
        signalId: onchainSignalId(signalName),
        payloadHash: bytes32Hex("525"),
        idempotencyKey: bytes32Hex("626"),
        submitter,
      },
      logIndex,
    );
  }

  it("gates assign on compiled-plan capability fact keys whose source differs from the stage id", async () => {
    const { router } = await routerFixture({
      events: compiledPlanEvents([
        compiledFactSignalEvent(5n, previousExecutorWallet),
      ]),
    });
    await expect(router.handle({
      method: "POST",
      pathname: `/product/tasks/${selectorTaskId()}/prepare-stage-executor-patch`,
      body: prepareExecutorBody({
        targetStageId: compiledTargetStageIdentifier,
        mode: "assign",
      }),
    })).resolves.toMatchObject({
      status: 409,
      body: { error: "target_stage_started_assign_rejected" },
    });
  });

  it("lets the first handoff through on compiled-plan fact keys (previously a spurious 409)", async () => {
    const { router } = await routerFixture({
      events: compiledPlanEvents([
        compiledFactSignalEvent(5n, previousExecutorWallet),
      ]),
    });
    const response = await router.handle({
      method: "POST",
      pathname: `/product/tasks/${selectorTaskId()}/prepare-stage-executor-patch`,
      body: prepareExecutorBody({
        targetStageId: compiledTargetStageIdentifier,
        mode: "handoff",
        previousExecutorWallet,
      }),
    });
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      mode: "handoff",
      previousExecutor: previousExecutorWallet,
    });
  });

  it("locks resource patches on compiled-plan capability fact keys too", async () => {
    const { router } = await routerFixture({
      events: compiledPlanEvents([
        compiledFactSignalEvent(5n, previousExecutorWallet),
      ]),
    });
    await expect(router.handle({
      method: "POST",
      pathname: `/product/tasks/${selectorTaskId()}/prepare-stage-resource-patch`,
      body: prepareResourceBody({
        targetStageId: compiledTargetStageIdentifier,
      }),
    })).resolves.toMatchObject({
      status: 409,
      body: { error: "target_stage_locked" },
    });
  });

  it("keeps the fallback form working alongside compiled-plan facts with one latest submitter", async () => {
    const { router } = await routerFixture({
      events: compiledPlanEvents([
        compiledFactSignalEvent(5n, previousExecutorWallet),
        chainEvent(6n, "SignalSubmitted", {
          orderId,
          sourceId: targetStageOnchainId,
          signalId: onchainSignalId("target-started"),
          payloadHash: bytes32Hex("535"),
          idempotencyKey: bytes32Hex("636"),
          submitter: previousExecutorWallet,
        }),
      ]),
    });
    const response = await router.handle({
      method: "POST",
      pathname: `/product/tasks/${selectorTaskId()}/prepare-stage-executor-patch`,
      body: prepareExecutorBody({
        targetStageId: compiledTargetStageIdentifier,
        mode: "handoff",
        previousExecutorWallet,
      }),
    });
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ previousExecutor: previousExecutorWallet });
  });

  it("fails closed when the two fact flows disagree on the latest submitter (previous_executor_ambiguous)", async () => {
    const { router } = await routerFixture({
      events: compiledPlanEvents([
        compiledFactSignalEvent(5n, previousExecutorWallet),
        chainEvent(6n, "SignalSubmitted", {
          orderId,
          sourceId: targetStageOnchainId,
          signalId: onchainSignalId("target-started"),
          payloadHash: bytes32Hex("535"),
          idempotencyKey: bytes32Hex("636"),
          submitter: selectorWallet,
        }),
      ]),
    });
    await expect(router.handle({
      method: "POST",
      pathname: `/product/tasks/${selectorTaskId()}/prepare-stage-executor-patch`,
      body: prepareExecutorBody({
        targetStageId: compiledTargetStageIdentifier,
        mode: "handoff",
        previousExecutorWallet,
      }),
    })).resolves.toMatchObject({
      status: 409,
      body: {
        error: "previous_executor_ambiguous",
        details: { targetStageId: targetStageOnchainId },
      },
    });
  });

  it("fails closed on a same-block tie between different submitters within the capability flow", async () => {
    const { router } = await routerFixture({
      events: compiledPlanEvents([
        compiledFactSignalEvent(5n, previousExecutorWallet, compiledFactSignalName, 0),
        compiledFactSignalEvent(5n, selectorWallet, compiledTieFactSignalName, 1),
      ]),
    });
    await expect(router.handle({
      method: "POST",
      pathname: `/product/tasks/${selectorTaskId()}/prepare-stage-executor-patch`,
      body: prepareExecutorBody({
        targetStageId: compiledTargetStageIdentifier,
        mode: "handoff",
        previousExecutorWallet,
      }),
    })).resolves.toMatchObject({
      status: 409,
      body: {
        error: "previous_executor_ambiguous",
        details: { tieBlockNumber: "5" },
      },
    });
  });

  it("treats a same-block tie with a single submitter as unambiguous", async () => {
    const { router } = await routerFixture({
      events: compiledPlanEvents([
        compiledFactSignalEvent(5n, previousExecutorWallet, compiledFactSignalName, 0),
        compiledFactSignalEvent(5n, previousExecutorWallet, compiledTieFactSignalName, 1),
      ]),
    });
    const response = await router.handle({
      method: "POST",
      pathname: `/product/tasks/${selectorTaskId()}/prepare-stage-executor-patch`,
      body: prepareExecutorBody({
        targetStageId: compiledTargetStageIdentifier,
        mode: "handoff",
        previousExecutorWallet,
      }),
    });
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ previousExecutor: previousExecutorWallet });
  });

  it("keeps the applied overlay executor authoritative over an ambiguous signal history", async () => {
    const { router } = await routerFixture({
      events: [
        ...compiledPlanEvents([
          compiledFactSignalEvent(5n, previousExecutorWallet),
        ]),
        chainEvent(6n, "StageExecutorPatchApplied", {
          orderId,
          selectorStageId,
          targetStageId: targetStageOnchainId,
          selector: selectorWallet,
          executor: executorWallet,
          role: roleHash,
          executorMetadataHash,
          patchHash: executorPatchHash,
          patchNonce: 1n,
          metadataURI: "ipfs://stage-executor-patches/1",
        }),
      ],
    });
    const response = await router.handle({
      method: "POST",
      pathname: `/product/tasks/${selectorTaskId()}/prepare-stage-executor-patch`,
      body: prepareExecutorBody({
        targetStageId: compiledTargetStageIdentifier,
        mode: "handoff",
        previousExecutorWallet: executorWallet,
      }),
    });
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ previousExecutor: executorWallet });
  });

  it("records a persist_failed fallback with the txHash and keeps the nonce consumed when the store write fails after broadcast", async () => {
    const innerBroadcast: StageExecutorPatchBroadcastAdapter = {
      broadcast: async (): Promise<StagePatchBroadcastResult> => ({
        status: "submitted",
        txHash,
      }),
    };
    const inner = new InMemoryProductStagePatchStore<
      PreparedStageExecutorPatchRecord,
      StageExecutorPatchSubmissionDTO
    >();
    let putSubmissionCalls = 0;
    const flakyStore: ProductStageExecutorPatchStore = {
      withTransaction: (operation) => operation(),
      putPrepared: (record) => inner.putPrepared(record),
      getPrepared: (prepareId) => inner.getPrepared(prepareId),
      markPreparedUsed: (prepareId, submissionId, usedAt) => inner.markPreparedUsed(prepareId, submissionId, usedAt),
      reserveNonce: (key, options) => inner.reserveNonce(key, options),
      releaseNonce: (key) => inner.releaseNonce(key),
      putSubmission: async (submission) => {
        putSubmissionCalls += 1;
        if (putSubmissionCalls === 1) {
          throw new Error("simulated durable patch store outage");
        }
        return inner.putSubmission(submission);
      },
      getSubmission: (submissionId) => inner.getSubmission(submissionId),
    };
    const store = stores.projectionStore;
    await store.resetFromEvents({
      deploymentBlock: 0n,
      events: baseEvents(),
      planCapabilityTables: planCapabilityTablesFor(baseEvents()),
    });
    const failingService = createProductStageExecutorPatchService({
      store,
      chainId,
      stagePatchModuleAddress: contractAddress,
      now: () => baseNow,
      chainClock: baseChainClock,
      prepareIdFactory: () => "prep_1",
      submissionIdFactory: () => "sub_1",
      stageExecutorPatchStore: flakyStore,
      broadcastAdapter: innerBroadcast,
    });
    const router = createApiRouter(store, { ...requiredRouterStores(),  productRuntimeEnvironment: "local",

      submissionChainId: 84532,
      submissionVerifyingContract:
        "0x1111111111111111111111111111111111111111",
      productStageExecutorPatchService: failingService,
    });
    const prepareResponse = await router.handle({
      method: "POST",
      pathname: `/product/tasks/${selectorTaskId()}/prepare-stage-executor-patch`,
      body: prepareExecutorBody(),
    });
    expect(prepareResponse.status).toBe(201);
    const prepared = prepareResponse.body as PreparedStageExecutorPatchDTO;
    const signature = await signExecutorPrepared(prepared);
    const submitBody = {
      prepareId: prepared.prepareId,
      selectorWallet,
      signature,
    };

    await expect(router.handle({
      method: "POST",
      pathname: `/product/tasks/${selectorTaskId()}/submit-stage-executor-patch`,
      body: submitBody,
    })).rejects.toThrow("simulated durable patch store outage");

    expect(putSubmissionCalls).toBe(2);
    await expect(inner.getSubmission("sub_1")).resolves.toMatchObject({
      status: "failed",
      broadcastStatus: "failed",
      txHash,
      errorCode: "persist_failed",
      retryable: false,
    });

    const retried = await router.handle({
      method: "POST",
      pathname: `/product/tasks/${selectorTaskId()}/submit-stage-executor-patch`,
      body: submitBody,
    });

    expect(retried).toMatchObject({
      status: 409,
      body: { error: "duplicate_stage_executor_patch_nonce" },
    });
  });

  it("releases the reserved patch nonce when the broadcast throws before producing a txHash so the same prepareId stays retryable", async () => {
    const broadcastCalls = { count: 0 };
    const innerBroadcast: StageExecutorPatchBroadcastAdapter = {
      broadcast: async (): Promise<StagePatchBroadcastResult> => {
        broadcastCalls.count += 1;
        if (broadcastCalls.count === 1) {
          throw new Error("simulated RPC outage before broadcast");
        }
        return { status: "submitted", txHash };
      },
    };
    const store = stores.projectionStore;
    await store.resetFromEvents({
      deploymentBlock: 0n,
      events: baseEvents(),
      planCapabilityTables: planCapabilityTablesFor(baseEvents()),
    });
    const service = createProductStageExecutorPatchService({
      store,
      chainId,
      stagePatchModuleAddress: contractAddress,
      now: () => baseNow,
      chainClock: baseChainClock,
      prepareIdFactory: () => "prep_1",
      submissionIdFactory: () => "sub_1",
      stageExecutorPatchStore: new InMemoryProductStagePatchStore<
        PreparedStageExecutorPatchRecord,
        StageExecutorPatchSubmissionDTO
      >(),
      broadcastAdapter: innerBroadcast,
    });
    const router = createApiRouter(store, { ...requiredRouterStores(),  productRuntimeEnvironment: "local",

      submissionChainId: 84532,
      submissionVerifyingContract:
        "0x1111111111111111111111111111111111111111",
      productStageExecutorPatchService: service,
    });
    const prepareResponse = await router.handle({
      method: "POST",
      pathname: `/product/tasks/${selectorTaskId()}/prepare-stage-executor-patch`,
      body: prepareExecutorBody(),
    });
    expect(prepareResponse.status).toBe(201);
    const prepared = prepareResponse.body as PreparedStageExecutorPatchDTO;
    const signature = await signExecutorPrepared(prepared);
    const submitBody = {
      prepareId: prepared.prepareId,
      selectorWallet,
      signature,
    };

    await expect(router.handle({
      method: "POST",
      pathname: `/product/tasks/${selectorTaskId()}/submit-stage-executor-patch`,
      body: submitBody,
    })).rejects.toThrow("simulated RPC outage before broadcast");

    const retried = await router.handle({
      method: "POST",
      pathname: `/product/tasks/${selectorTaskId()}/submit-stage-executor-patch`,
      body: submitBody,
    });

    expect(retried).toMatchObject({
      status: 200,
      body: { status: "submitted", txHash },
    });
    expect(broadcastCalls.count).toBe(2);
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
    readonly explicitModuleAddresses?: boolean;
    readonly devAnchoredAuth?: boolean;
  } = {},
): Promise<{
  readonly router: ApiRouter;
  readonly store: ProjectionStore;
}> {
  const store = stores.projectionStore;
  const events = options.events ?? baseEvents();
  await store.resetFromEvents({
    deploymentBlock: 0n,
    events,
    planCapabilityTables: planCapabilityTablesFor(events),
  });
  const productSchemaResolver = options.productSchema
    ? {
        getProductSchemaByPlan: async (
          requestedPlanId: string,
          requestedPlanHash: string,
        ) =>
          requestedPlanId === options.productSchema!.planId &&
          requestedPlanHash === options.productSchema!.artifactHash
            ? options.productSchema
            : undefined,
      }
    : undefined;
  let prepareCount = 0;
  let submissionCount = 0;
  const explicitModuleAddresses = options.explicitModuleAddresses ?? true;
  const commonOptions = {
    store,
    ...(productSchemaResolver ? { productSchemaResolver } : {}),
    ...(options.productBffStore
      ? { productBffStore: options.productBffStore }
      : {}),
    chainId,
    ...(explicitModuleAddresses
      ? {
          stagePatchModuleAddress: contractAddress,
          dockingModuleAddress: contractAddress,
        }
      : {}),
    stageExecutorPatchStore: new InMemoryProductStagePatchStore<
      PreparedStageExecutorPatchRecord,
      StageExecutorPatchSubmissionDTO
    >(),
    stageResourcePatchStore: new InMemoryProductStagePatchStore<
      PreparedStageResourcePatchRecord,
      StageResourcePatchSubmissionDTO
    >(),
    now: () => baseNow,
    chainClock: baseChainClock,
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
  return {
    store,
    router: createApiRouter(store, { ...requiredRouterStores(), productRuntimeEnvironment: "local", submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111",
      productStageExecutorPatchService: executorService,
      productStageResourcePatchService: resourceService,
      ...(options.devAnchoredAuth
        ? {
            storeAuthConfig: {
              mode: "dev_headers" as const,
              roleClaim: "roles",
              principalClaim: "sub",
              clockToleranceSeconds: 60,
              walletSession: {
                enabled: true,
                operatorWallets: [],
                adminWallets: [],
                sessionTtlSeconds: 43200,
                challengeTtlSeconds: 300,
                devAnchoredAddressHeaderEnabled: true
              }
            }
          }
        : {})
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
    manifestURI: "ipfs://resource-manifests/doc-1",
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
      currency: "tok-1",
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
  await store.createRegistrationIfNoneForDraft({
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
    planHash: canonicalPlanHash,
    artifactHash: planHash,
    roleSlots: [
      {
        slotId: selectorRoleSlotId,
        title: "Slot-a selector",
        label: "Slot-a selector",
        duty: "Select executor",
        evidence: [],
        status: "required",
        tone: "info",
        required: true,
      },
      {
        slotId: resourceControllerRoleSlotId,
        title: "Slot-a resource controller",
        label: "Slot-a resource controller",
        duty: "Control resources",
        evidence: [],
        status: "required",
        tone: "info",
        required: true,
      },
    ],

    businessPersonaLabels: ["slot-a"],
    stages: [
      {
        stageId: "selector.stage",
        index: 1,
        name: "Selector",
        evidence: [],
        ownerRole: "slot-a",
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

const vocabularyRegistry = new Map<string, PlanCapabilityTablesInput>();

interface VocabularyFixture extends PlanCapabilityTablesInput {
  readonly capabilitiesRoot: Hex;
  readonly executorCandidatesRoot: Hex;
}

function registerPlanVocabulary(tables: {
  readonly selectorBindings: readonly { readonly selectorStageId: Hex; readonly targetStageId: Hex }[];
  readonly signalCapabilities?: readonly {
    readonly stageId: Hex;
    readonly targetSourceId: Hex;
    readonly signalId: Hex;
    readonly targetOrderRelation: 0 | 1;
  }[];
  readonly executorCandidates?: readonly { readonly stageId: Hex; readonly executor: Address }[];
}): VocabularyFixture {
  const signalCapabilities = tables.signalCapabilities ?? [];
  const executorCandidates = tables.executorCandidates ?? tables.selectorBindings.map(
    (binding) => ({ stageId: binding.targetStageId, executor: executorWallet }),
  );
  const capabilitiesRoot = capabilitiesRootOf(tables.selectorBindings, signalCapabilities);
  const executorCandidatesRoot = executorCandidatesRootOf(executorCandidates);
  vocabularyRegistry.set(capabilitiesRoot, {
    planId,
    planHash,
    selectorBindings: tables.selectorBindings,
    signalCapabilities,
    executorCandidates,
  });
  return {
    planId,
    planHash,
    selectorBindings: tables.selectorBindings,
    signalCapabilities,
    executorCandidates,
    capabilitiesRoot,
    executorCandidatesRoot,
  };
}

function planCapabilityTablesFor(events: readonly ChainEvent[]): readonly PlanCapabilityTablesInput[] {
  const roots = new Set(events
    .filter((event) => event.eventName === "PlanCommitted" || event.eventName === "PlanFinalized")
    .map((event) => String(event.args["capabilitiesRoot"] ?? "").toLowerCase()));
  return [...vocabularyRegistry.entries()]
    .filter(([root]) => roots.has(root))
    .map(([, tables]) => tables);
}

function baseEvents(
  options: {
    readonly includePatchAuthorizations?: boolean;
    readonly includeSelectorTaskAuthorization?: boolean;
    readonly selectorStageId?: Hex;
    readonly targetStageId?: Hex;
    readonly vocabulary?: VocabularyFixture;
  } = {},
): readonly ChainEvent[] {
  const includePatchAuthorizations = options.includePatchAuthorizations ?? true;
  const includeSelectorTaskAuthorization =
    options.includeSelectorTaskAuthorization ?? true;
  const eventSelectorStageId = options.selectorStageId ?? selectorStageId;
  const eventTargetStageId = options.targetStageId ?? targetStageId;
  const vocabulary = options.vocabulary ?? registerPlanVocabulary({
    selectorBindings: [{ selectorStageId: eventSelectorStageId, targetStageId: eventTargetStageId }],
    signalCapabilities: [{
      stageId: eventSelectorStageId,
      targetSourceId: eventSelectorStageId,
      signalId: selectorHookName,
      targetOrderRelation: 0
    }]
  });
  return [
    chainEvent(1n, "PlanCommitted", {
      planId,
      planHash,
      publisher: selectorWallet,
      hooksHash: bytes32Hex("806"),
      capabilitiesRoot: vocabulary.capabilitiesRoot,
      hookCount: 1n,
      dockRoutesRoot: bytes32Hex("807"),
      dockInterfaceRoot: bytes32Hex("808"),
      executorCandidatesRoot: vocabulary.executorCandidatesRoot,
    }),
    chainEvent(1n, "PlanPublisherRecorded", {
      planId,
      publisher: selectorWallet,
    }, 1),
    chainEvent(1n, "PlanFinalized", {
      planId,
      planHash,
      capabilitiesRoot: vocabulary.capabilitiesRoot,
    }, 2),
    chainEvent(1n, "PlanRegistered", {
      planId,
      planHash,
      hookCount: 1n,
    }, 3),
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

describe("stage patch prepare table bounds", () => {
  it("sweeps expired prepares on write and keeps a hard cap on the in-memory table", async () => {
    const { InMemoryProductStagePatchStore, MEMORY_PREPARED_PATCH_HARD_LIMIT } = await import("../src/stage-patches/index.js");
    let current = new Date("2026-04-30T00:00:00Z");
    const store = new InMemoryProductStagePatchStore<PreparedStageExecutorPatchRecord, StageExecutorPatchSubmissionDTO>({
      now: () => current
    });
    const preparedAt = (index: number, deadlineSeconds: string) => ({
      prepareId: `prep_${index}`,
      nonceKey: `nonce_${index}`,
      taskId: "task_1",
      patchHash: "0x" + "11".repeat(32),
      status: "prepared",
      deadline: deadlineSeconds
    }) as unknown as PreparedStageExecutorPatchRecord;

    await store.putPrepared(preparedAt(0, "1"));
    await store.putPrepared(preparedAt(1, String(Math.floor(current.getTime() / 1000) + 600)));
    await expect(store.deleteExpiredPrepared(String(Math.floor(current.getTime() / 1000)))).resolves.toBe(1);
    await expect(store.getPrepared("prep_0")).resolves.toBeUndefined();
    await expect(store.getPrepared("prep_1")).resolves.toBeDefined();

    for (let index = 2; index < MEMORY_PREPARED_PATCH_HARD_LIMIT + 2; index += 1) {
      await store.putPrepared(preparedAt(index, String(Math.floor(current.getTime() / 1000) + 600)));
    }
    await expect(store.getPrepared("prep_1")).resolves.toBeUndefined();
    await expect(store.getPrepared(`prep_${MEMORY_PREPARED_PATCH_HARD_LIMIT + 1}`)).resolves.toBeDefined();
  });
});

describe("stage patch durable store (postgres)", () => {
  function openStore() {
    return new PostgresProductStagePatchStore<
      PreparedStageExecutorPatchRecord,
      StageExecutorPatchSubmissionDTO
    >({
      databaseUrl: stagePatchDatabaseUrl,
      patchKind: "executor"
    });
  }

  it("persists prepared/submission/nonce state across restarts and reserves nonces cross-instance", async () => {
    const first = openStore();
    const prepared: PreparedStageExecutorPatchRecord = {
      prepareId: "prep_restart_1",
      nonceKey: "executor:31337:0xabc:1",
      taskId: "task_1",
      patchHash: "0x" + "11".repeat(32),
      deadline: String(Math.floor(baseNow.getTime() / 1000) + 600),
      status: "prepared"
    } as unknown as PreparedStageExecutorPatchRecord;
    await first.putPrepared(prepared);
    expect(await first.reserveNonce(prepared.nonceKey)).toBe(true);
    expect(await first.reserveNonce(prepared.nonceKey)).toBe(false);
    await first.putSubmission({
      submissionId: "sub_restart_1",
      status: "signature_received"
    } as unknown as StageExecutorPatchSubmissionDTO);
    await first.markPreparedUsed(prepared.prepareId, "sub_restart_1", "2026-09-08T00:00:00Z");
    await first.close();

    const second = openStore();
    try {
      const restored = await second.getPrepared("prep_restart_1");
      expect(restored).toMatchObject({
        prepareId: "prep_restart_1",
        submissionId: "sub_restart_1",
        usedAt: "2026-09-08T00:00:00Z"
      });
      await expect(second.getSubmission("sub_restart_1")).resolves.toMatchObject({
        submissionId: "sub_restart_1"
      });
      await expect(second.reserveNonce("executor:31337:0xabc:1")).resolves.toBe(false);
      await second.releaseNonce("executor:31337:0xabc:1");
      await expect(second.reserveNonce("executor:31337:0xabc:1")).resolves.toBe(true);

      await second.putPrepared({
        ...prepared,
        prepareId: "prep_restart_expired",
        nonceKey: "executor:31337:0xabc:2",
        deadline: String(Math.floor(baseNow.getTime() / 1000) - 1)
      } as unknown as PreparedStageExecutorPatchRecord);
      await expect(
        second.deleteExpiredPrepared(String(Math.floor(baseNow.getTime() / 1000)))
      ).resolves.toBe(1);
      await expect(second.getPrepared("prep_restart_expired")).resolves.toBeUndefined();
      await expect(second.getPrepared("prep_restart_1")).resolves.toBeDefined();
    } finally {
      await second.close();
    }
  });
});
