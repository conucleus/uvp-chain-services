import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { StoreProductSchemaDTO } from "@uvp-eth/product-dto";
import {
  capabilitiesRootOf,
  onchainSignalId,
  onchainSourceId,
} from "@uvp-eth/compiler";
import type { PlanCapabilityTablesInput } from "../src/indexer/projections/plan.js";
import { hashSignalAuthorizations } from "@uvp-eth/protocol-bindings";
import {
  executorCandidateProofFor,
  executorCandidatesRootOf,
} from "../src/submissions/capability-proofs.js";
import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createApiRouter, type ApiRouter } from "../src/api/routes.js";
import { createNotificationService, createSupplierNotificationProfileConfigService, MemorySupplierNotificationProfileConfigStore } from "../src/notifications/index.js";
import type { ChainEvent } from "../src/indexer/events.js";
import {
  createProductStageExecutorPatchService,
  InMemoryProductStagePatchStore,
  type PreparedStageExecutorPatchDTO,
  type PreparedStageExecutorPatchRecord,
  type StageExecutorPatchBroadcastAdapter,
  type StageExecutorPatchBroadcastRequest,
  type StageExecutorPatchSubmissionDTO,
  type StagePatchBroadcastResult,
} from "../src/stage-patches/index.js";
import { createChainServicesStores, type ChainServicesStores } from "../src/storage/factory.js";
import type { ProjectionStore } from "../src/storage/projection-store.js";
import { createPostgresTestDatabase } from "./postgres.js";

let stores: ChainServicesStores;

beforeAll(async () => {
  stores = createChainServicesStores({
    database: { url: await createPostgresTestDatabase(), migrationsAutoRun: true },
    chainId: 31337
  });
});

afterAll(async () => {
  await stores.close();
});

function requiredRouterStores() {
  return {
    storeSupplierMetadataStore: stores.storeSupplierMetadataStore,
    storeEntityRegistrationStore: stores.storeEntityRegistrationStore,
    storeWalletSessionStore: stores.storeWalletSessionStore,
    storeDecorationStore: stores.storeDecorationStore,
    storePublisherDelegationStore: stores.storePublisherDelegationStore,
    identityDescriptorSnapshots: stores.identityDescriptorSnapshots,
    storeListingStore: stores.storeListingStore,
    storeJoinApplicationStore: stores.storeJoinApplicationStore,
    productBffStore: stores.productBffStore,
    orderStore: stores.orderStore,
    orderRequirementsStore: stores.orderRequirementsStore,
    evidenceMetadataStore: stores.evidenceMetadataStore,
    submissionStore: stores.submissionStore,
    governanceStore: stores.governanceStore,
    stageExecutorPatchStore: stores.stageExecutorPatchStore,
    stageResourcePatchStore: stores.stageResourcePatchStore,
    storeZhixuDraftStore: stores.storeZhixuDraftStore,
    storeZhixuVersionMetadataStore: stores.storeZhixuVersionMetadataStore,
    storeDockingSessionStore: stores.storeDockingSessionStore,
    storeAuditStore: stores.storeAuditStore,
    notificationService: createNotificationService({
      store: stores.projectionStore,
      supplierMetadataStore: stores.storeSupplierMetadataStore,
      deliveryStore: stores.notificationStateStore,
      participantReadStateStore: stores.notificationStateStore
    }),
    supplierNotificationConfigService: createSupplierNotificationProfileConfigService({
      store: new MemorySupplierNotificationProfileConfigStore()
    })
  };
}
import {
  normalizeAddress,
  type Address,
  type Hex,
} from "../src/shared/types.js";

const chainId = 31337;
const contractAddress = "0x1111111111111111111111111111111111111111" as Address;
const planId = bytes32Hex("101");
const planHash =
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex;
const orderId = bytes32Hex("202");
const selectorStageId = bytes32Text("selector.stage");
const selectorHookId = bytes32Hex("303");
const selectorHookName = bytes32Text("select-executor");
const targetStageId = bytes32Text("target.stage");
const executorPatchSignalId =
  "0xbbb1770c9313f4029a89e03f4719037cdad52864ab4da5f623bc7c8a0c489e97" as Hex;
const resourcePatchSignalId =
  "0x6dff331f2bb7b785cbcd99a911e6d30dc8714f43b3b9ba80c658215445ddd0ba" as Hex;
const roleHash = bytes32Text("target.executor");
const executorMetadataHash = bytes32Hex("404");
const executorPatchHash = bytes32Hex("505");
const txHash = bytes32Hex("707");
const ZERO_BYTES32 =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as const;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
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
const outsiderWallet = "0x9999999999999999999999999999999999999999" as Address;
const executorWallet = "0x3333333333333333333333333333333333333333" as Address;
const baseNow = new Date("2026-04-30T00:00:00Z");
const baseChainClock = { latestBlockTimestampSeconds: async () => Math.floor(baseNow.getTime() / 1000) } as const;

describe("stage-patches black-box adversarial", () => {
  it("rejects executor patch modes outside the assign/handoff vocabulary verbatim", async () => {
    const { router } = await routerFixture();
    for (const mode of [
      "REPLACEMENT",
      "replace",
      "replacement",
      "replacement ",
      " forkorder",
      "forkOrder",
      "rotate",
      "transfer",
      "reassign",
    ]) {
      await expect(
        router.handle({
          method: "POST",
          pathname: `/product/tasks/${selectorTaskId()}/prepare-stage-executor-patch`,
          body: prepareExecutorBody({ mode }),
        }),
      ).resolves.toMatchObject({
        status: 400,
        body: { error: "invalid_executor_patch_mode" },
      });
    }
  });

  it("accepts assign mode case-insensitively (documents lenient normalization)", async () => {
    const { router } = await routerFixture();
    for (const mode of ["ASSIGN", " Assign ", "assign"]) {
      const response = await router.handle({
        method: "POST",
        pathname: `/product/tasks/${selectorTaskId()}/prepare-stage-executor-patch`,
        body: prepareExecutorBody({ mode }),
      });
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({ mode: "assign" });
    }
  });

  it("rejects an explicitly provided non-string or blank mode as out-of-vocabulary", async () => {
    const { router } = await routerFixture();
    for (const mode of ["", 5, null, {}, true]) {
      const response = await router.handle({
        method: "POST",
        pathname: `/product/tasks/${selectorTaskId()}/prepare-stage-executor-patch`,
        body: prepareExecutorBody({ mode: mode as unknown as string }),
      });
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ error: "invalid_executor_patch_mode" });
    }
  });

  it("rejects a non-zero previousExecutorWallet on assign mode but accepts the zero address", async () => {
    const { router } = await routerFixture();
    await expect(
      router.handle({
        method: "POST",
        pathname: `/product/tasks/${selectorTaskId()}/prepare-stage-executor-patch`,
        body: prepareExecutorBody({ previousExecutorWallet: outsiderWallet }),
      }),
    ).resolves.toMatchObject({
      status: 400,
      body: { error: "previous_executor_not_allowed" },
    });

    const response = await router.handle({
      method: "POST",
      pathname: `/product/tasks/${selectorTaskId()}/prepare-stage-executor-patch`,
      body: prepareExecutorBody({ previousExecutorWallet: ZERO_ADDRESS }),
    });
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ mode: "assign" });
    expect((response.body as PreparedStageExecutorPatchDTO).previousExecutor).toBeUndefined();
  });

  it("rejects handoff prepare when the claimed previous executor mismatches the last submitter", async () => {
    const { router } = await routerFixture({
      events: [...baseEvents(), targetSignalSubmittedEvent(5n)],
    });
    await expect(
      router.handle({
        method: "POST",
        pathname: `/product/tasks/${selectorTaskId()}/prepare-stage-executor-patch`,
        body: prepareExecutorBody({
          mode: "handoff",
          previousExecutorWallet: outsiderWallet,
        }),
      }),
    ).resolves.toMatchObject({
      status: 409,
      body: { error: "previous_executor_mismatch" },
    });
  });

  it("gives concurrent prepares the same nonce and lets exactly one submit win", async () => {
    let broadcastCalls = 0;
    const { router } = await routerFixture({
      executorBroadcastAdapter: {
        broadcast: async (): Promise<StagePatchBroadcastResult> => {
          broadcastCalls += 1;
          return { status: "submitted", txHash };
        },
      },
    });
    const first = await prepareStageExecutorPatch(router);
    const second = await prepareStageExecutorPatch(router, {
      metadataURI: "ipfs://stage-executor-patches/race",
    });
    expect(first.patchNonce).toBe("1");
    expect(second.patchNonce).toBe("1");

    const firstSubmit = await router.handle({
      method: "POST",
      pathname: `/product/tasks/${selectorTaskId()}/submit-stage-executor-patch`,
      body: {
        prepareId: first.prepareId,
        selectorWallet,
        signature: await signExecutorPrepared(first),
      },
    });
    expect(firstSubmit.status).toBe(200);

    await expect(
      router.handle({
        method: "POST",
        pathname: `/product/tasks/${selectorTaskId()}/submit-stage-executor-patch`,
        body: {
          prepareId: second.prepareId,
          selectorWallet,
          signature: await signExecutorPrepared(second),
        },
      }),
    ).resolves.toMatchObject({
      status: 409,
      body: { error: "duplicate_stage_executor_patch_nonce" },
    });
    expect(broadcastCalls).toBe(1);
  });

  it("keeps replaying the consumed nonce fail-closed when the chain projection has not caught up", async () => {
    let broadcastCalls = 0;
    const { router, store } = await routerFixture({
      executorBroadcastAdapter: {
        broadcast: async (): Promise<StagePatchBroadcastResult> => {
          broadcastCalls += 1;
          return { status: "submitted", txHash };
        },
      },
    });
    const first = await prepareStageExecutorPatch(router);
    const firstSubmit = await router.handle({
      method: "POST",
      pathname: `/product/tasks/${selectorTaskId()}/submit-stage-executor-patch`,
      body: {
        prepareId: first.prepareId,
        selectorWallet,
        signature: await signExecutorPrepared(first),
      },
    });
    expect(firstSubmit.status).toBe(200);

    await store.resetFromEvents({
      deploymentBlock: 0n,
      events: baseEvents(),
      planCapabilityTables: planCapabilityTablesFor(baseEvents()),
    });
    const replayed = await prepareStageExecutorPatch(router, {
      metadataURI: "ipfs://stage-executor-patches/replay",
    });
    expect(replayed.patchNonce).toBe("1");

    await expect(
      router.handle({
        method: "POST",
        pathname: `/product/tasks/${selectorTaskId()}/submit-stage-executor-patch`,
        body: {
          prepareId: replayed.prepareId,
          selectorWallet,
          signature: await signExecutorPrepared(replayed),
        },
      }),
    ).resolves.toMatchObject({
      status: 409,
      body: { error: "duplicate_stage_executor_patch_nonce" },
    });
    expect(broadcastCalls).toBe(1);
  });

  it("allocates a strictly increasing nonce once the applied patch lands in the projection", async () => {
    let broadcastCalls = 0;
    const events = [
      ...baseEvents(),
      stageExecutorPatchAppliedEvent(5n, 1n),
    ];
    const { router } = await routerFixture({
      events,
      executorBroadcastAdapter: {
        broadcast: async (): Promise<StagePatchBroadcastResult> => {
          broadcastCalls += 1;
          return { status: "submitted", txHash };
        },
      },
    });
    const prepared = await prepareStageExecutorPatch(router, {
      metadataURI: "ipfs://stage-executor-patches/2",
    });
    expect(prepared.patchNonce).toBe("2");

    const response = await router.handle({
      method: "POST",
      pathname: `/product/tasks/${selectorTaskId()}/submit-stage-executor-patch`,
      body: {
        prepareId: prepared.prepareId,
        selectorWallet,
        signature: await signExecutorPrepared(prepared),
      },
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ patchNonce: "2" });
    expect(broadcastCalls).toBe(1);
  });

  it("broadcasts the authorization set frozen at prepare even when the plan projection gains facts before submit", async () => {
    const vocabBefore = registerPlanVocabulary({
      selectorBindings: [{ selectorStageId, targetStageId }],
      signalCapabilities: [
        {
          stageId: selectorStageId,
          targetSourceId: selectorStageId,
          signalId: selectorHookName,
          targetOrderRelation: 0,
        },
        {
          stageId: targetStageId,
          targetSourceId: onchainSourceId("origin.a"),
          signalId: onchainSignalId("a.action"),
          targetOrderRelation: 0,
        },
      ],
    });
    const vocabAfter = registerPlanVocabulary({
      selectorBindings: [{ selectorStageId, targetStageId }],
      signalCapabilities: [
        {
          stageId: selectorStageId,
          targetSourceId: selectorStageId,
          signalId: selectorHookName,
          targetOrderRelation: 0,
        },
        {
          stageId: targetStageId,
          targetSourceId: onchainSourceId("origin.a"),
          signalId: onchainSignalId("a.action"),
          targetOrderRelation: 0,
        },
        {
          stageId: targetStageId,
          targetSourceId: onchainSourceId("origin.b"),
          signalId: onchainSignalId("b.action"),
          targetOrderRelation: 0,
        },
      ],
    });
    const broadcast = vi.fn(
      async (
        request: StageExecutorPatchBroadcastRequest,
      ): Promise<StagePatchBroadcastResult> => ({
        status: "submitted",
        txHash,
      }),
    );
    const { router, store } = await routerFixture({
      events: baseEvents({ vocabulary: vocabBefore }),
      executorBroadcastAdapter: { broadcast },
    });
    const prepared = await prepareStageExecutorPatch(router);
    expect(prepared.executorAuthorizations).toHaveLength(1);
    const frozenAuthorizations = prepared.executorAuthorizations;

    await store.resetFromEvents({
      deploymentBlock: 0n,
      events: baseEvents({ vocabulary: vocabAfter }),
      planCapabilityTables: planCapabilityTablesFor(
        baseEvents({ vocabulary: vocabAfter }),
      ),
    });

    const response = await router.handle({
      method: "POST",
      pathname: `/product/tasks/${selectorTaskId()}/submit-stage-executor-patch`,
      body: {
        prepareId: prepared.prepareId,
        selectorWallet,
        signature: await signExecutorPrepared(prepared),
      },
    });
    expect(response.status).toBe(200);
    expect(broadcast).toHaveBeenCalledOnce();
    const request = broadcast.mock.calls[0]![0];
    expect(request.executorAuthorizations).toEqual(frozenAuthorizations);
    expect(request.prepared.authorizationsHash).toBe(
      prepared.authorizationsHash,
    );
    expect(request.executorAuthorizations).toHaveLength(1);
  });

  it("derives an empty authorization set for plans without target-stage capability facts and still submits", async () => {
    const broadcast = vi.fn(
      async (
        _request: StageExecutorPatchBroadcastRequest,
      ): Promise<StagePatchBroadcastResult> => ({
        status: "submitted",
        txHash,
      }),
    );
    const { router } = await routerFixture({
      executorBroadcastAdapter: { broadcast },
    });
    const prepared = await prepareStageExecutorPatch(router);
    expect(prepared.executorAuthorizations).toEqual([]);
    expect(prepared.authorizationsHash).toBe(hashSignalAuthorizations([]));

    const response = await router.handle({
      method: "POST",
      pathname: `/product/tasks/${selectorTaskId()}/submit-stage-executor-patch`,
      body: {
        prepareId: prepared.prepareId,
        selectorWallet,
        signature: await signExecutorPrepared(prepared),
      },
    });
    expect(response.status).toBe(200);
    const request = broadcast.mock.calls[0]![0];
    expect(request.executorAuthorizations).toEqual([]);
  });

  it("maps target-stage capability facts to the new executor with the patch role and metadata commitments", async () => {
    const factA = {
      stageId: targetStageId,
      targetSourceId: onchainSourceId("origin.a"),
      signalId: onchainSignalId("a.action"),
      targetOrderRelation: 0 as const,
    };
    const factB = {
      stageId: targetStageId,
      targetSourceId: onchainSourceId("origin.b"),
      signalId: onchainSignalId("b.action"),
      targetOrderRelation: 0 as const,
    };
    const vocabulary = registerPlanVocabulary({
      selectorBindings: [{ selectorStageId, targetStageId }],
      signalCapabilities: [
        {
          stageId: selectorStageId,
          targetSourceId: selectorStageId,
          signalId: selectorHookName,
          targetOrderRelation: 0,
        },
        factA,
        factB,
      ],
    });
    const { router } = await routerFixture({
      events: baseEvents({ vocabulary }),
    });
    const prepared = await prepareStageExecutorPatch(router);
    expect(prepared.executorAuthorizations).toEqual([
      {
        sourceId: factA.targetSourceId,
        signalId: factA.signalId,
        submitter: executorWallet,
        role: roleHash,
        metadataHash: executorMetadataHash,
      },
      {
        sourceId: factB.targetSourceId,
        signalId: factB.signalId,
        submitter: executorWallet,
        role: roleHash,
        metadataHash: executorMetadataHash,
      },
    ]);
    expect(prepared.authorizationsHash).toBe(
      hashSignalAuthorizations(prepared.executorAuthorizations),
    );
    expect(prepared.typedData.message.authorizationsHash).toBe(
      prepared.authorizationsHash,
    );
  });

  it("rejects a submitted patch envelope whose authorizationsHash diverges from the archive", async () => {
    const broadcast = vi.fn(async (): Promise<StagePatchBroadcastResult> => ({
      status: "submitted",
      txHash,
    }));
    const { router } = await routerFixture({
      executorBroadcastAdapter: { broadcast },
    });
    const prepared = await prepareStageExecutorPatch(router);
    const tampered = {
      ...prepared,
      authorizationsHash: bytes32Hex("fff"),
    };
    await expect(
      router.handle({
        method: "POST",
        pathname: `/product/tasks/${selectorTaskId()}/submit-stage-executor-patch`,
        body: {
          prepareId: prepared.prepareId,
          selectorWallet,
          patch: tampered,
          signature: await signExecutorPrepared(prepared),
        },
      }),
    ).resolves.toMatchObject({
      status: 400,
      body: { error: "prepared_patch_mismatch" },
    });
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("rejects a submitted typedData envelope whose digest diverges from the prepared one", async () => {
    const broadcast = vi.fn(async (): Promise<StagePatchBroadcastResult> => ({
      status: "submitted",
      txHash,
    }));
    const { router } = await routerFixture({
      executorBroadcastAdapter: { broadcast },
    });
    const prepared = await prepareStageExecutorPatch(router);
    const tamperedTypedData = {
      ...prepared.typedData,
      message: {
        ...prepared.typedData.message,
        authorizationsHash: bytes32Hex("ffe"),
      },
    };
    await expect(
      router.handle({
        method: "POST",
        pathname: `/product/tasks/${selectorTaskId()}/submit-stage-executor-patch`,
        body: {
          prepareId: prepared.prepareId,
          selectorWallet,
          typedData: tamperedTypedData,
          signature: await signExecutorPrepared(prepared),
        },
      }),
    ).resolves.toMatchObject({
      status: 400,
      body: { error: "typed_data_mismatch" },
    });
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("rejects a signature produced over a tampered digest even without envelopes", async () => {
    const broadcast = vi.fn(async (): Promise<StagePatchBroadcastResult> => ({
      status: "submitted",
      txHash,
    }));
    const { router } = await routerFixture({
      executorBroadcastAdapter: { broadcast },
    });
    const prepared = await prepareStageExecutorPatch(router);
    const tamperedTypedData = {
      ...prepared.typedData,
      message: {
        ...prepared.typedData.message,
        authorizationsHash: bytes32Hex("ffd"),
      },
    };
    await expect(
      router.handle({
        method: "POST",
        pathname: `/product/tasks/${selectorTaskId()}/submit-stage-executor-patch`,
        body: {
          prepareId: prepared.prepareId,
          selectorWallet,
          signature: await selectorAccount.signTypedData(
            tamperedTypedData as unknown as Parameters<
              typeof selectorAccount.signTypedData
            >[0],
          ),
        },
      }),
    ).resolves.toMatchObject({
      status: 400,
      body: { error: "invalid_signature" },
    });
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("fails closed at submit when the re-projected plan lost the candidate list", async () => {
    const broadcast = vi.fn(async (): Promise<StagePatchBroadcastResult> => ({
      status: "submitted",
      txHash,
    }));
    const { router, store } = await routerFixture({
      executorBroadcastAdapter: { broadcast },
    });
    const prepared = await prepareStageExecutorPatch(router);

    const emptyCandidates = registerPlanVocabulary({
      selectorBindings: [{ selectorStageId, targetStageId }],
      signalCapabilities: [
        {
          stageId: selectorStageId,
          targetSourceId: selectorStageId,
          signalId: selectorHookName,
          targetOrderRelation: 0,
        },
        {
          stageId: selectorStageId,
          targetSourceId: onchainSourceId("origin.note"),
          signalId: onchainSignalId("selector.note"),
          targetOrderRelation: 0,
        },
      ],
      executorCandidates: [],
    });

    await store.resetFromEvents({
      deploymentBlock: 0n,
      events: baseEvents({ vocabulary: emptyCandidates }),
      planCapabilityTables: planCapabilityTablesFor(
        baseEvents({ vocabulary: emptyCandidates }),
      ),
    });

    await expect(
      router.handle({
        method: "POST",
        pathname: `/product/tasks/${selectorTaskId()}/submit-stage-executor-patch`,
        body: {
          prepareId: prepared.prepareId,
          selectorWallet,
          signature: await signExecutorPrepared(prepared),
        },
      }),
    ).resolves.toMatchObject({
      status: 409,
      body: { error: "executor_candidate_set_unavailable" },
    });
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("fails closed at submit when the executor was removed from the candidate set", async () => {
    const broadcast = vi.fn(async (): Promise<StagePatchBroadcastResult> => ({
      status: "submitted",
      txHash,
    }));
    const { router, store } = await routerFixture({
      executorBroadcastAdapter: { broadcast },
    });
    const prepared = await prepareStageExecutorPatch(router);

    const evicted = registerPlanVocabulary({
      selectorBindings: [{ selectorStageId, targetStageId }],
      signalCapabilities: [
        {
          stageId: selectorStageId,
          targetSourceId: selectorStageId,
          signalId: selectorHookName,
          targetOrderRelation: 0,
        },
        {
          stageId: selectorStageId,
          targetSourceId: onchainSourceId("origin.note"),
          signalId: onchainSignalId("selector.note"),
          targetOrderRelation: 0,
        },
      ],
      executorCandidates: [
        { stageId: targetStageId, executor: outsiderWallet },
      ],
    });

    await store.resetFromEvents({
      deploymentBlock: 0n,
      events: baseEvents({ vocabulary: evicted }),
      planCapabilityTables: planCapabilityTablesFor(
        baseEvents({ vocabulary: evicted }),
      ),
    });

    await expect(
      router.handle({
        method: "POST",
        pathname: `/product/tasks/${selectorTaskId()}/submit-stage-executor-patch`,
        body: {
          prepareId: prepared.prepareId,
          selectorWallet,
          signature: await signExecutorPrepared(prepared),
        },
      }),
    ).resolves.toMatchObject({
      status: 409,
      body: { error: "executor_not_in_candidate_set" },
    });
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("builds the candidate proof through case-insensitive address normalization", async () => {
    const letteredExecutor =
      "0xabc000000000000000000000000000000000de01" as Address;
    const checksummedExecutor = getAddress(letteredExecutor);
    expect(checksummedExecutor).not.toBe(letteredExecutor);
    const checksummedCandidates = [
      { stageId: targetStageId, executor: checksummedExecutor },
    ];
    const vocabulary = registerPlanVocabulary({
      selectorBindings: [{ selectorStageId, targetStageId }],
      signalCapabilities: [
        {
          stageId: selectorStageId,
          targetSourceId: selectorStageId,
          signalId: selectorHookName,
          targetOrderRelation: 0,
        },
      ],
      executorCandidates: checksummedCandidates,
    });
    const broadcast = vi.fn(
      async (
        _request: StageExecutorPatchBroadcastRequest,
      ): Promise<StagePatchBroadcastResult> => ({
        status: "submitted",
        txHash,
      }),
    );
    const { router } = await routerFixture({
      events: baseEvents({ vocabulary }),
      executorBroadcastAdapter: { broadcast },
    });
    const prepared = await prepareStageExecutorPatch(router, {
      executorWallet: checksummedExecutor.toUpperCase().replace(/^0X/, "0x"),
    });
    expect(prepared.executorWallet).toBe(letteredExecutor);
    expect(prepared.status).toBe("prepared");

    const response = await router.handle({
      method: "POST",
      pathname: `/product/tasks/${selectorTaskId()}/submit-stage-executor-patch`,
      body: {
        prepareId: prepared.prepareId,
        selectorWallet,
        signature: await signExecutorPrepared(prepared),
      },
    });
    expect(response.status).toBe(200);
    const request = broadcast.mock.calls[0]![0];
    expect(request.candidateProof).toEqual(
      executorCandidateProofFor(
        [{ stageId: targetStageId, executor: letteredExecutor }],
        targetStageId,
        letteredExecutor,
      ),
    );
  });

  it("rejects zero-valued roleHash, executorMetadataHash, and executorWallet", async () => {
    const { router } = await routerFixture();
    for (const overrides of [
      { roleHash: ZERO_BYTES32 },
      { executorMetadataHash: ZERO_BYTES32 },
      { executorWallet: ZERO_ADDRESS },
    ]) {
      await expect(
        router.handle({
          method: "POST",
          pathname: `/product/tasks/${selectorTaskId()}/prepare-stage-executor-patch`,
          body: prepareExecutorBody(overrides),
        }),
      ).resolves.toMatchObject({
        status: 400,
        body: { error: "invalid_body" },
      });
    }
  });

  it("accepts an oversized metadataURI (documents the absent length cap)", async () => {
    const oversizedURI = `ipfs://stage-executor-patches/${"x".repeat(100_000)}`;
    const { router } = await routerFixture();
    const response = await router.handle({
      method: "POST",
      pathname: `/product/tasks/${selectorTaskId()}/prepare-stage-executor-patch`,
      body: prepareExecutorBody({ metadataURI: oversizedURI }),
    });
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      metadataURI: oversizedURI,
      status: "prepared",
    });
  });

  it("rejects unknown prepare fields outright instead of silently ignoring them", async () => {
    const { router } = await routerFixture();
    const response = await router.handle({
      method: "POST",
      pathname: `/product/tasks/${selectorTaskId()}/prepare-stage-executor-patch`,
      body: {
        ...prepareExecutorBody(),
        executorPatchStrategy: "force-replace",
        replacementExecutor: outsiderWallet,
        forkOrder: true,
        nonCooperative: { eject: outsiderWallet },
        previousExecutorSignature: "0xdeadbeef",
      },
    });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: "invalid_body" });
    const message = JSON.stringify(response.body);
    for (const field of ["executorPatchStrategy", "replacementExecutor", "forkOrder", "nonCooperative"]) {
      expect(message).toContain(field);
    }
  });

  it("rejects unknown fields on the submit body with the same closed key set", async () => {
    const { router } = await routerFixture();
    const response = await router.handle({
      method: "POST",
      pathname: `/product/tasks/${selectorTaskId()}/submit-stage-executor-patch`,
      body: {
        selectorWallet,
        signature: "0xdeadbeef",
        typedData: { domain: {}, types: {}, message: {} },
        strategyHint: "bypass",
      },
    });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: "invalid_body" });
    expect(JSON.stringify(response.body)).toContain("strategyHint");
  });

  it("keeps stage resource patches blocked once the target stage started (non-executor lane stays closed)", async () => {
    const { router } = await routerFixture({
      events: [...baseEvents(), targetSignalSubmittedEvent(5n)],
    });
    await expect(
      router.handle({
        method: "POST",
        pathname: `/product/tasks/${selectorTaskId()}/prepare-stage-resource-patch`,
        body: prepareResourceBody(),
      }),
    ).resolves.toMatchObject({
      status: 409,
      body: { error: "target_stage_locked" },
    });
  });
});

async function routerFixture(
  options: {
    readonly executorBroadcastAdapter?: StageExecutorPatchBroadcastAdapter;
    readonly events?: readonly ChainEvent[];
    readonly productSchema?: StoreProductSchemaDTO;
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
  const commonOptions = {
    store,
    ...(productSchemaResolver ? { productSchemaResolver } : {}),
    chainId,
    stagePatchModuleAddress: contractAddress,
    dockingModuleAddress: contractAddress,
    stageExecutorPatchStore: new InMemoryProductStagePatchStore<
      PreparedStageExecutorPatchRecord,
      StageExecutorPatchSubmissionDTO
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
  return {
    store,
    router: createApiRouter(store, { ...requiredRouterStores(),
      productRuntimeEnvironment: "local",
      submissionChainId: 84532,
      submissionVerifyingContract:
        "0x1111111111111111111111111111111111111111",
      productStageExecutorPatchService: executorService,
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
    resourceKey: "doc-1-pdf",
    manifestHash: bytes32Hex("a11"),
    policyHash: bytes32Hex("b22"),
    manifestURI: "ipfs://resource-manifests/doc-1-v1",
    ...overrides,
  };
}

async function signExecutorPrepared(
  prepared: PreparedStageExecutorPatchDTO,
): Promise<Hex> {
  return await selectorAccount.signTypedData(
    prepared.typedData as unknown as Parameters<
      typeof selectorAccount.signTypedData
    >[0],
  );
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
    readonly vocabulary?: VocabularyFixture;
  } = {},
): readonly ChainEvent[] {
  const vocabulary = options.vocabulary ?? registerPlanVocabulary({
    selectorBindings: [{ selectorStageId, targetStageId }],
    signalCapabilities: [{
      stageId: selectorStageId,
      targetSourceId: selectorStageId,
      signalId: selectorHookName,
      targetOrderRelation: 0,
    }],
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
    chainEvent(3n, "SignalSubmitterAuthorized", {
      orderId,
      sourceId: selectorStageId,
      signalId: selectorHookName,
      submitter: selectorWallet,
      role: bytes32Text("selector"),
      metadataHash: bytes32Hex("909"),
    }),
    chainEvent(3n, "SignalSubmitterAuthorized", {
      orderId,
      sourceId: selectorStageId,
      signalId: executorPatchSignalId,
      submitter: selectorWallet,
      role: bytes32Text("selector"),
      metadataHash: bytes32Hex("90a"),
    }, 1),
    chainEvent(3n, "SignalSubmitterAuthorized", {
      orderId,
      sourceId: selectorStageId,
      signalId: resourcePatchSignalId,
      submitter: selectorWallet,
      role: bytes32Text("selector"),
      metadataHash: bytes32Hex("90b"),
    }, 2),
    chainEvent(4n, "HookReady", {
      orderId,
      hookId: selectorHookId,
      stageId: selectorStageId,
      hookName: selectorHookName,
    }),
  ];
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
