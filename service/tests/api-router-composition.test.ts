import { readdirSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiRouter } from "../src/api/routes.js";
import { createNotificationService, createSupplierNotificationProfileConfigService, MemorySupplierNotificationProfileConfigStore } from "../src/notifications/index.js";
import { ObjectEvidenceStorage } from "../src/evidence/index.js";
import { createChainServicesStores, type ChainServicesStores } from "../src/storage/factory.js";
import { createPostgresTestDatabase } from "./postgres.js";

let stores: ChainServicesStores;

beforeAll(async () => {
  stores = createChainServicesStores({
    database: { url: await createPostgresTestDatabase(), migrationsAutoRun: true }
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

describe("API router composition", () => {
  it("returns not_found for unknown routes", async () => {
    const router = createApiRouter(stores.projectionStore, { ...requiredRouterStores(), productRuntimeEnvironment: "local", submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111" });

    await expect(router.handle({ method: "GET", pathname: "/unknown-route" }))
      .resolves.toEqual({
        status: 404,
        body: { error: "not_found" }
      });
  });

  it("serves production reads without demo fallback data", async () => {
    const router = createApiRouter(stores.projectionStore, { ...requiredRouterStores(), submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111",
      productRuntimeEnvironment: "production",
      evidenceStorage: productionSafeEvidenceStorage()
    });

    await expect(router.handle({
      method: "GET",
      pathname: "/product/zhixus",
      query: { fallback: "demo" }
    })).resolves.toMatchObject({
      status: 200,
      body: { zhixus: [] }
    });
  });

  it("rejects malformed percent-encoded path parameters with 400 instead of 500", async () => {
    const router = createApiRouter(stores.projectionStore, { ...requiredRouterStores(), submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111", productRuntimeEnvironment: "local" });

    const productOrder = await router.handle({
      method: "GET",
      pathname: "/product/orders/%ZZ",
      headers: { "x-uvp-wallet-address": "0x9999999999999999999999999999999999999999" }
    });
    expect(productOrder).toMatchObject({ status: 400, body: { error: "invalid_path_parameter" } });

    const storeOrder = await router.handle({
      method: "GET",
      pathname: "/store/zhixus/%E0%A4%A/orders",
      headers: { "x-uvp-wallet-address": "0x9999999999999999999999999999999999999999" }
    });
    expect(storeOrder).toMatchObject({ status: 401, body: { error: "store_identity_missing" } });
    const storeOrderOperator = await router.handle({
      method: "GET",
      pathname: "/store/zhixus/%E0%A4%A/orders",
      headers: { "x-uvp-store-user-id": "operator-1", "x-uvp-store-role": "operator" }
    });
    expect(storeOrderOperator).toMatchObject({ status: 400, body: { error: "invalid_path_parameter" } });
  });

  it("store runtime reads and submission reads require session identity", async () => {
    const router = createApiRouter(stores.projectionStore, { ...requiredRouterStores(), submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111", productRuntimeEnvironment: "local" });

    for (const pathname of [
      "/store/runtime/summary",
      "/store/zhixus/zhixu-1/orders"
    ]) {
      const anonymous = await router.handle({ method: "GET", pathname });
      expect(anonymous).toMatchObject({ status: 401, body: { error: "store_identity_missing" } });
    }
    for (const pathname of [
      "/store/orders/0xabc/candidates",
      "/product/submissions/sub_1"
    ]) {
      const anonymous = await router.handle({ method: "GET", pathname });
      expect(anonymous).toMatchObject({ status: 401, body: { error: "wallet_identity_required" } });
    }
  });

  it("active-executor overlay authorization only covers the task's recorded submit signal", async () => {
    const { productBffStoreSubmissionAuthorization } = await import("../src/api/routes.js");
    const { MemoryProductBffStore } = await import("../src/product/query/bff/store.js");
    const authorization = productBffStoreSubmissionAuthorization(new MemoryProductBffStore());
    const executor = "0x8888888888888888888888888888888888888888";
    const targetStageId = "0x" + "1".repeat(64);
    const recordedSignalId = "0x" + "2".repeat(64);
    const derivedSignalId = "0x" + "3".repeat(64);
    const onchainOrderId = "0x" + "4".repeat(64) as `0x${string}`;
    const baseRequest = {
      orderId: "order-1",
      taskId: "task-1",
      stageIdentifier: "stage-1",
      signalName: "confirm_stage",
      onchainOrderId,
      sourceId: targetStageId as `0x${string}`,
      intent: "confirm_stage" as const,
      submitter: executor as `0x${string}`
    };

    const derived = await authorization.authorize({
      ...baseRequest,
      signalId: derivedSignalId as `0x${string}`,
      task: {
        taskId: "task-1",
        stageExecutorOverlay: { targetStageId, activeExecutorWallet: executor }
      } as never
    });
    expect(derived).toMatchObject({
      authorized: false,
      source: "active_stage_executor_overlay"
    });

    const recorded = await authorization.authorize({
      ...baseRequest,
      signalId: recordedSignalId as `0x${string}`,
      task: {
        taskId: "task-1",
        stageExecutorOverlay: { targetStageId, activeExecutorWallet: executor },
        proof: { signalId: recordedSignalId }
      } as never
    });
    expect(recorded).toMatchObject({ authorized: true, source: "active_stage_executor_overlay" });
  });

  it("submission authorization honors on-chain SignalSubmitterAuthorized projections", async () => {
    const { productBffStoreSubmissionAuthorization } = await import("../src/api/routes.js");
    const { MemoryProductBffStore } = await import("../src/product/query/bff/store.js");

    const submitter = "0x7777777777777777777777777777777777777777";
    const onchainOrderId = "0x" + "9".repeat(64);
    const sourceId = "0x" + "a".repeat(64);
    const signalId = "0x" + "b".repeat(64);
    const planId = "0x" + "c".repeat(64);
    const store = stores.projectionStore;
    await store.resetFromEvents({
      deploymentBlock: 0n,
      events: [
        chainEvent(1n, "PlanRegistered", { planId, planHash: "0x" + "d".repeat(64), hookCount: 1n }),
        chainEvent(2n, "OrderRegistered", { orderId: onchainOrderId, planId }),
        chainEvent(3n, "SignalSubmitterAuthorized", {
          orderId: onchainOrderId,
          planId,
          sourceId,
          signalId,
          submitter,
          role: "0x" + "3".repeat(64),
          metadataHash: "0x" + "4".repeat(64)
        })
      ]
    });
    const authorization = productBffStoreSubmissionAuthorization(new MemoryProductBffStore(), store);

    const authorized = await authorization.authorize({
      orderId: "order-1",
      taskId: "task-1",
      stageIdentifier: "stage-1",
      signalName: "confirm_stage",
      onchainOrderId,
      sourceId,
      signalId,
      intent: "confirm_stage",
      submitter
    } as never);
    expect(authorized).toMatchObject({ authorized: true, source: "chain_signal_authorization" });

    const stranger = "0x6666666666666666666666666666666666666666";
    const denied = await authorization.authorize({
      orderId: "order-1",
      taskId: "task-1",
      stageIdentifier: "stage-1",
      signalName: "confirm_stage",
      onchainOrderId,
      sourceId,
      signalId,
      intent: "confirm_stage",
      submitter: stranger
    } as never);
    expect(denied).toMatchObject({
      authorized: false,
      source: "chain_signal_authorization",
      reason: expect.stringContaining("not authorized on chain")
    });
  });


  it("route modules do not cross-import; composition stays in the public factory", () => {
    const apiDir = new URL("../src/api/", import.meta.url);
    const modulesDir = new URL("routes/", apiDir);
    for (const filename of readdirSync(modulesDir).filter((name) => name.endsWith(".ts"))) {
      const source = readFileSync(new URL(filename, modulesDir), "utf8");
      expect(source, filename).not.toMatch(/from\s+["']\.\/[^"']+\.js["']/);
      expect(source, filename).not.toMatch(/from\s+["']\.\.\/routes\//);
    }
  });
});

function productionSafeEvidenceStorage(): ObjectEvidenceStorage {
  return new ObjectEvidenceStorage({
    client: {
      async put(input) {
        return {
          storageURI: `object://evidence/${encodeURIComponent(input.evidenceId)}`,
          size: input.bytes.byteLength
        };
      },
      async get() {
        return undefined;
      },
      async exists() {
        return false;
      }
    }
  });
}

function chainEvent(blockNumber: bigint, eventName: string, args: Record<string, unknown>) {
  return {
    chainId: 31337,
    contractAddress: "0x1111111111111111111111111111111111111111" as `0x${string}`,
    blockNumber,
    transactionHash: `0x${blockNumber.toString(16).padStart(64, "0")}` as `0x${string}`,
    logIndex: 0,
    eventName,
    args
  };
}
