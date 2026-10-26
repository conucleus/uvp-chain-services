import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiRouter } from "../src/api/routes.js";
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
    submissionStore: stores.submissionStore,
    stageExecutorPatchStore: stores.stageExecutorPatchStore,
    stageResourcePatchStore: stores.stageResourcePatchStore,
  };
}

function routerOptions(runtimeEnvironment: "local" | "production" = "local") {
  return {
    ...requiredRouterStores(),
    runtimeEnvironment,
    submissionChainId: 84532,
    submissionVerifyingContract: "0x1111111111111111111111111111111111111111" as const
  };
}

describe("API router composition", () => {
  it("returns not_found for unknown routes", async () => {
    const router = createApiRouter(stores.projectionStore, routerOptions());

    await expect(router.handle({ method: "GET", pathname: "/unknown-route" }))
      .resolves.toEqual({
        status: 404,
        body: { error: "not_found" }
      });
  });

  it("retires the V1 order draft/invite/participant/requirements surface with 410", async () => {
    const router = createApiRouter(stores.projectionStore, routerOptions());

    for (const request of [
      { method: "POST", pathname: "/product/order-drafts", body: { title: "gone" } },
      { method: "GET", pathname: "/product/orders/0xabc/participants" },
      { method: "PUT", pathname: "/product/order-drafts/draft-1/requirements", body: {} }
    ]) {
      await expect(router.handle(request)).resolves.toMatchObject({
        status: 410,
        body: { error: "v1_order_surface_removed" }
      });
    }
  });

  it("rejects malformed percent-encoded path parameters with 400 instead of 500", async () => {
    const router = createApiRouter(stores.projectionStore, routerOptions());

    const response = await router.handle({
      method: "GET",
      pathname: "/chain/orders/%ZZ"
    });
    expect(response).toMatchObject({ status: 400, body: { error: "invalid_path_parameter" } });
  });

  it("submission reads require wallet identity", async () => {
    const router = createApiRouter(stores.projectionStore, routerOptions());

    const anonymous = await router.handle({ method: "GET", pathname: "/product/submissions/sub_1" });
    expect(anonymous).toMatchObject({ status: 401, body: { error: "wallet_identity_required" } });
  });

  it("active-executor overlay authorization only covers the task's recorded submit signal", async () => {
    const { projectionSubmissionAuthorization } = await import("../src/api/routes.js");
    const authorization = projectionSubmissionAuthorization(stores.projectionStore);
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
    const { projectionSubmissionAuthorization } = await import("../src/api/routes.js");

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
    const authorization = projectionSubmissionAuthorization(store);

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
});

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
