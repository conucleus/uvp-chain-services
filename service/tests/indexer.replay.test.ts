import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createApiRouter } from "../src/api/routes.js";
import type { ChainServicesConfig } from "../src/config/index.js";
import { IndexerService, type ChainEventSource } from "../src/indexer/service.js";
import { rebuildOrderProjections, stateMachineScopedKey } from "../src/indexer/projections.js";
import { MemoryProjectionStore } from "../src/storage/projection-store.js";
import { SqliteProjectionStore } from "../src/storage/sqlite-projection-store.js";
import type { ChainEvent } from "../src/indexer/events.js";
import { EXECUTOR_PATCH_MODE_ASSIGN } from "../src/stage-patches/typed-data.js";

const contractAddress = "0x1111111111111111111111111111111111111111";
const contractAddressV2 = "0x9999999999999999999999999999999999999999";
const deploymentRegistryAddress = "0x8888888888888888888888888888888888888888";
const buyer = "0x2222222222222222222222222222222222222222";
const seller = "0x3333333333333333333333333333333333333333";
const signer = "0x4444444444444444444444444444444444444444";
const overlayExecutor = "0x5555555555555555555555555555555555555555";
const emptyHash = "0x0000000000000000000000000000000000000000000000000000000000000000";
const evidenceHash = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const planId = "0x0000000000000000000000000000000000000000000000000000000000000101";
const stateMachineOrderId = "0x0000000000000000000000000000000000000000000000000000000000000202";
const planHash = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const hookId = "0x0000000000000000000000000000000000000000000000000000000000000303";
const stageId = bytes32Text("stage-customs");
const selectorStageId = bytes32Text("stage-selector");
const hookName = bytes32Text("customs-review");
const selectorHookName = bytes32Text("select-executor");
const sourceId = "0x0000000000000000000000000000000000000000000000000000000000000404";
const signalId = "0x0000000000000000000000000000000000000000000000000000000000000505";
const payloadHash = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const idempotencyKey = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const patchHash = "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
const manifestHash = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const policyHash = "0x1212121212121212121212121212121212121212121212121212121212121212";
const resourceKey = bytes32Text("invoice-resource");
const deploymentIdV1 = "0x0000000000000000000000000000000000000000000000000000000000000d01";
const deploymentIdV2 = "0x0000000000000000000000000000000000000000000000000000000000000d02";
const abiHash = "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const __dirname = dirname(fileURLToPath(import.meta.url));

describe("indexer projection replay", () => {
  it("ignores removed escrow-shaped events in product projections", () => {
    const events: readonly ChainEvent[] = [
      chainEvent(2n, 0, "OrderFunded", { orderId: "order-1" }),
      chainEvent(1n, 0, "OrderCreated", {
        orderId: "order-1",
        buyer,
        seller,
        zhixuHash: emptyHash,
        metadataHash: emptyHash
      }),
      chainEvent(3n, 0, "StageApproved", {
        orderId: "order-1",
        stageId: "stage-1",
        signer,
        signal: "approve",
        evidenceHash
      })
    ];

    const snapshot = rebuildOrderProjections(events);

    expect(snapshot.rebuildable).toBe(true);
    expect(snapshot.eventCount).toBe(3);
    expect(snapshot.orders).toEqual({});
    expect(snapshot.stateMachineOrders).toEqual({});
  });

  it("can wipe and rebuild the in-memory projection store without restoring removed escrow projections", async () => {
    const events: readonly ChainEvent[] = [
      chainEvent(1n, 0, "OrderCreated", { orderId: "order-2", buyer, seller }),
      chainEvent(2n, 0, "StageReleased", { orderId: "order-2", stageId: "stage-1" })
    ];

    const store = new MemoryProjectionStore();
    const first = await store.resetFromEvents({ deploymentBlock: 0n, events });
    await store.resetFromEvents({ deploymentBlock: 0n, events: [] });
    const rebuilt = await store.resetFromEvents({ deploymentBlock: 0n, events });

    expect(rebuilt.orders).toEqual(first.orders);
    expect(await store.getOrder("order-2")).toBeUndefined();
  });

  it("rebuilds state-machine orders, tasks, timeline, and proof from chain events", () => {
    const events = stateMachineEvents();

    const snapshot = rebuildOrderProjections(events);
    const orderKey = stateMachineScopedKey(31337, contractAddress, stateMachineOrderId);
    const planKey = stateMachineScopedKey(31337, contractAddress, planId);
    const order = snapshot.stateMachineOrders[orderKey];
    const taskId = `${contractAddress}:${stateMachineOrderId}:${hookId}`;

    expect(snapshot.rebuildable).toBe(true);
    expect(snapshot.stateMachinePlans[planKey]?.planHash).toBe(planHash);
    expect(order?.status).toBe("action_required");
    expect(order?.planId).toBe(planId);
    expect(order?.planHash).toBe(planHash);
    expect(order?.currentStage).toBe(stageId);
    expect(order?.signals[`${sourceId}:${signalId}`]?.payloadHash).toBe(payloadHash);
    expect(order?.hooks[hookId]?.status).toBe("ready");
    expect(order?.tasks[taskId]?.status).toBe("ready");
    expect(order?.timeline.map((event) => event.eventName)).toContain("SignalSubmitted");
    expect(order?.timeline.map((event) => event.eventName)).toEqual(expect.arrayContaining([
      "OrderMaterialized",
      "StageMaterialized"
    ]));
    expect(order?.proof.map((proof) => proof.eventName)).toEqual(expect.arrayContaining([
      "OrderMaterialized",
      "StageMaterialized"
    ]));
    expect(order?.proof.some((proof) => proof.eventName === "HookReady" && proof.transactionHash)).toBe(true);
  });

  it("replays order-level signal submitter authorizations and assigns matching HookReady tasks", async () => {
    const events: readonly ChainEvent[] = [
      chainEvent(1n, 0, "PlanRegistered", {
        planId,
        planHash,
        hookCount: 1n
      }),
      chainEvent(2n, 0, "OrderRegistered", {
        orderId: stateMachineOrderId,
        planId
      }),
      chainEvent(3n, 0, "SignalSubmitterAuthorized", {
        orderId: stateMachineOrderId,
        sourceId: stageId,
        signalId: hookName,
        submitter: signer,
        role: bytes32Text("executor"),
        metadataHash: emptyHash
      }),
      chainEvent(4n, 0, "HookReady", {
        orderId: stateMachineOrderId,
        hookId,
        stageId,
        hookName
      })
    ];
    const store = new MemoryProjectionStore();
    const first = await store.resetFromEvents({ deploymentBlock: 0n, events });
    await store.resetFromEvents({ deploymentBlock: 0n, events: [] });
    const rebuilt = await store.resetFromEvents({ deploymentBlock: 0n, events });
    const order = rebuilt.stateMachineOrders[stateMachineScopedKey(31337, contractAddress, stateMachineOrderId)];
    const task = rebuilt.stateMachineTasks[`${contractAddress}:${stateMachineOrderId}:${hookId}`];

    expect(rebuilt.stateMachineOrders).toEqual(first.stateMachineOrders);
    expect(Object.values(order?.authorizations ?? {})).toContainEqual(expect.objectContaining({
      orderId: stateMachineOrderId,
      sourceId: stageId,
      signalId: hookName,
      submitter: signer
    }));
    expect(task).toMatchObject({
      assigneeRole: "authorized_submitter",
      assigneeWallet: signer,
      assigneeRoleHash: bytes32Text("executor"),
      authorizationMetadataHash: emptyHash
    });
  });

  it("rebuilds stage overlays from patch events and prefers the active overlay executor for target tasks", () => {
    const selectorHookId = "0x0000000000000000000000000000000000000000000000000000000000000606";
    const events: readonly ChainEvent[] = [
      chainEvent(1n, 0, "PlanRegistered", {
        planId,
        planHash,
        hookCount: 2n
      }),
      chainEvent(1n, 1, "StageSelectorBindingRegistered", {
        planId,
        selectorStageId,
        targetStageId: stageId
      }),
      chainEvent(2n, 0, "OrderRegistered", {
        orderId: stateMachineOrderId,
        planId
      }),
      chainEvent(3n, 0, "StageExecutorPatchApplied", {
        orderId: stateMachineOrderId,
        selectorStageId,
        targetStageId: stageId,
        selector: signer,
        executor: overlayExecutor,
        role: bytes32Text("overlay-role"),
        executorMetadataHash: bytes32Hex("8001"),
        mode: EXECUTOR_PATCH_MODE_ASSIGN,
        patchHash,
        patchNonce: 1n,
        metadataURI: "ipfs://stage-executor-patch/1"
      }),
      chainEvent(4n, 0, "StageExecutorActivated", {
        orderId: stateMachineOrderId,
        targetStageId: stageId,
        executor: overlayExecutor,
        role: bytes32Text("overlay-role"),
        metadataHash: bytes32Hex("8001"),
        patchNonce: 1n
      }),
      chainEvent(5n, 0, "StageResourcePatchApplied", {
        orderId: stateMachineOrderId,
        selectorStageId,
        targetStageId: stageId,
        resourceKey,
        selector: signer,
        manifestHash,
        policyHash,
        patchHash: bytes32Hex("9001"),
        patchNonce: 1n,
        manifestURI: "ipfs://resource-manifests/invoice-v1"
      }),
      chainEvent(6n, 0, "SignalSubmitterAuthorized", {
        orderId: stateMachineOrderId,
        sourceId: stageId,
        signalId: hookName,
        submitter: signer,
        role: bytes32Text("static"),
        metadataHash: emptyHash
      }),
      chainEvent(7n, 0, "HookReady", {
        orderId: stateMachineOrderId,
        hookId,
        stageId,
        hookName
      }),
      chainEvent(8n, 0, "HookReady", {
        orderId: stateMachineOrderId,
        hookId: selectorHookId,
        stageId: selectorStageId,
        hookName: selectorHookName
      })
    ];

    const snapshot = rebuildOrderProjections(events);
    const order = snapshot.stateMachineOrders[stateMachineScopedKey(31337, contractAddress, stateMachineOrderId)];
    const targetTask = snapshot.stateMachineTasks[`${contractAddress}:${stateMachineOrderId}:${hookId}`];

    expect(order?.stageExecutorOverlays[stageId]).toMatchObject({
      orderId: stateMachineOrderId,
      selectorStageId,
      targetStageId: stageId,
      selectorWallet: signer,
      activeExecutorWallet: overlayExecutor,
      mode: "assign",
      modeHash: EXECUTOR_PATCH_MODE_ASSIGN,
      patchHash,
      patchNonce: "1",
      metadataURI: "ipfs://stage-executor-patch/1",
      proof: expect.objectContaining({ eventName: "StageExecutorPatchApplied" }),
      activationProof: expect.objectContaining({ eventName: "StageExecutorActivated" })
    });
    expect(order?.stageResourceOverlays[`${stageId}:${resourceKey}`]).toMatchObject({
      orderId: stateMachineOrderId,
      selectorStageId,
      targetStageId: stageId,
      resourceKey,
      selectorWallet: signer,
      manifestHash,
      policyHash,
      patchNonce: "1",
      manifestURI: "ipfs://resource-manifests/invoice-v1",
      proof: expect.objectContaining({ eventName: "StageResourcePatchApplied" })
    });
    expect(targetTask).toMatchObject({
      assigneeRole: "stage_overlay_executor",
      assigneeWallet: overlayExecutor,
      assigneeRoleHash: bytes32Text("overlay-role"),
      authorizationMetadataHash: bytes32Hex("8001")
    });
    expect(order?.proof.map((proof) => proof.eventName)).toEqual(expect.arrayContaining([
      "StageExecutorPatchApplied",
      "StageResourcePatchApplied",
      "StageExecutorActivated",
      "HookReady"
    ]));
    expect(order?.timeline.map((event) => event.eventName)).toContain("StageExecutorPatchApplied");
    expect(order?.timeline.map((event) => event.eventName)).toContain("StageResourcePatchApplied");
  });

  it("removes logs from deterministic replay when a removed reorg log is present", () => {
    const registered = chainEvent(2n, 0, "OrderRegistered", {
      orderId: stateMachineOrderId,
      planId
    });

    const snapshot = rebuildOrderProjections([
      chainEvent(1n, 0, "PlanRegistered", {
        planId,
        planHash,
        hookCount: 1n
      }),
      registered,
      { ...registered, removed: true }
    ]);

    expect(snapshot.stateMachineOrders[stateMachineScopedKey(31337, contractAddress, stateMachineOrderId)]).toBeUndefined();
    expect(snapshot.eventCount).toBe(1);
  });

  it("projects registry deployments and scopes identical order ids by state machine", async () => {
    const events = [
      ...deploymentRegistryEvents(),
      ...stateMachineEvents(contractAddress, stateMachineOrderId),
      ...stateMachineEvents(contractAddressV2, stateMachineOrderId, 10n)
    ];

    const snapshot = rebuildOrderProjections(events);
    const v1Key = stateMachineScopedKey(31337, contractAddress, stateMachineOrderId);
    const v2Key = stateMachineScopedKey(31337, contractAddressV2, stateMachineOrderId);

    expect(snapshot.activeStateMachineDeploymentId).toBe(deploymentIdV2);
    expect(snapshot.stateMachineOrders[v1Key]?.deploymentId).toBe(deploymentIdV1);
    expect(snapshot.stateMachineOrders[v2Key]?.deploymentId).toBe(deploymentIdV2);
    expect(Object.keys(snapshot.stateMachineOrders)).toEqual(expect.arrayContaining([v1Key, v2Key]));
    expect(Object.values(snapshot.stateMachineDeployments)).toEqual(expect.arrayContaining([
      expect.objectContaining({ deploymentId: deploymentIdV1, status: "deprecated" }),
      expect.objectContaining({ deploymentId: deploymentIdV2, status: "active" })
    ]));

    const store = new MemoryProjectionStore();
    await store.resetFromEvents({ deploymentBlock: 0n, events });
    const router = createApiRouter(store);
    const response = await router.handle({ method: "GET", pathname: `/product/orders/${stateMachineOrderId}` });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      error: "ambiguous_order_id",
      details: {
        candidates: expect.arrayContaining([
          expect.objectContaining({ stateMachineAddress: contractAddress }),
          expect.objectContaining({ stateMachineAddress: contractAddressV2 })
        ])
      }
    });
  });

  it("writes finality and rebuild sync metadata during indexer rebuild", async () => {
    const store = new MemoryProjectionStore();
    const events = stateMachineEvents();
    const eventSource: ChainEventSource = {
      async getFinalizedBlock() {
        return 9n;
      },
      async readEvents(range) {
        expect(range.fromBlock).toBe(0n);
        expect(range.toBlock).toBe(9n);
        return events;
      }
    };
    const indexer = new IndexerService({
      config: testConfig(),
      eventSource,
      store
    });

    const result = await indexer.rebuildFromDeploymentBlockWithSummary();
    const syncState = await store.getSyncState();

    expect(result.summary).toMatchObject({
      chainId: 31337,
      fromBlock: "0",
      toBlock: "9",
      eventCount: 9,
      stateMachineOrderCount: 1,
      trustPlanCount: 0,
      mismatchCount: 0,
      syncStatus: "indexed",
      finalizedBlock: "9",
      confirmationDepth: 2,
      lastEventName: "HookReady"
    });
    expect(syncState).toMatchObject({
      syncStatus: "indexed",
      latestIndexedBlock: 7n,
      finalizedBlock: 9n,
      confirmationDepth: 2,
      eventCount: 9,
      rebuild: expect.objectContaining({ status: "completed" })
    });
  });

  it("refreshes durable stores incrementally from the saved cursor", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "uvp-indexer-incremental-"));
    const store = new SqliteProjectionStore({
      databaseUrl: `sqlite://${join(tempDir, "projection.sqlite3")}`,
      chainId: 31337,
      migrations: {
        autoRun: true,
        directory: resolve(__dirname, "../migrations")
      }
    });
    try {
      const events = stateMachineEvents();
      const ranges: Array<{ readonly fromBlock: bigint; readonly toBlock: bigint }> = [];
      let finalizedBlock = 3n;
      const eventSource: ChainEventSource = {
        async getFinalizedBlock() {
          return finalizedBlock;
        },
        async readEvents(range) {
          ranges.push({ fromBlock: range.fromBlock, toBlock: range.toBlock });
          return events.filter((event) => event.blockNumber >= range.fromBlock && event.blockNumber <= range.toBlock);
        }
      };
      const indexer = new IndexerService({
        config: testConfig(),
        eventSource,
        store
      });

      await indexer.rebuildFromDeploymentBlockWithSummary();
      finalizedBlock = 7n;
      const result = await indexer.refreshFromCursorWithSummary();

      expect(ranges).toEqual([
        { fromBlock: 0n, toBlock: 3n },
        { fromBlock: 4n, toBlock: 7n }
      ]);
      expect(result.summary).toMatchObject({
        fromBlock: "4",
        toBlock: "7",
        eventCount: 9,
        stateMachineOrderCount: 1,
        syncStatus: "indexed",
        finalizedBlock: "7"
      });
      await expect(store.listEvents({ chainId: 31337 })).resolves.toHaveLength(9);
      await expect(store.getCursor({ chainId: 31337, contractAddress: "0x0000000000000000000000000000000000000000" }))
        .resolves.toMatchObject({ nextBlock: 8n, finalizedBlock: 7n });
    } finally {
      await store.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("serves state-machine projection through Product API endpoints", async () => {
    const store = new MemoryProjectionStore();
    await store.resetFromEvents({ deploymentBlock: 0n, events: stateMachineEvents() });
    const router = createApiRouter(store);
    const taskId = `${contractAddress}:${stateMachineOrderId}:${hookId}`;

    const ordersResponse = await router.handle({ method: "GET", pathname: "/product/orders" });
    const orderResponse = await router.handle({ method: "GET", pathname: `/product/orders/${stateMachineOrderId}` });
    const timelineResponse = await router.handle({
      method: "GET",
      pathname: `/product/orders/${stateMachineOrderId}/timeline`
    });
    const proofResponse = await router.handle({
      method: "GET",
      pathname: `/product/orders/${stateMachineOrderId}/proof`
    });
    const tasksResponse = await router.handle({
      method: "GET",
      pathname: "/product/tasks",
      query: { orderId: stateMachineOrderId }
    });
    const taskResponse = await router.handle({ method: "GET", pathname: `/product/tasks/${taskId}` });

    expect(ordersResponse.status).toBe(200);
    expect((ordersResponse.body as { orders: Array<{ orderId: string }> }).orders[0]?.orderId).toBe(stateMachineOrderId);
    expect(orderResponse.status).toBe(200);
    expect((orderResponse.body as { order: { planId: string; chainStatus: string; tasks: unknown[]; confirmations: unknown[] } }).order)
      .toMatchObject({
        planId,
        stateMachineAddress: contractAddress,
        chainStatus: "action_required",
        projection: expect.objectContaining({
          syncStatus: "indexed",
          eventCount: 9,
          lastEventName: "HookReady"
        })
      });
    expect((orderResponse.body as { order: { tasks: unknown[]; confirmations: unknown[] } }).order.tasks).toHaveLength(1);
    expect((orderResponse.body as { order: { tasks: unknown[]; confirmations: unknown[] } }).order.confirmations).toHaveLength(1);
    expect(timelineResponse.status).toBe(200);
    expect((timelineResponse.body as { timeline: Array<{ eventName: string }> }).timeline.map((event) => event.eventName))
      .toContain("SignalSubmitted");
    expect(proofResponse.status).toBe(200);
    expect((proofResponse.body as { proof: Array<{ eventName: string; blockNumber: string }> }).proof)
      .toContainEqual(expect.objectContaining({ eventName: "HookReady", blockNumber: "7" }));
    expect(tasksResponse.status).toBe(200);
    expect((tasksResponse.body as { tasks: Array<{ taskId: string; status: string }> }).tasks)
      .toContainEqual(expect.objectContaining({
        taskId,
        status: "blocked",
        chainStatus: "ready",
        capabilityPlugin: expect.objectContaining({ source: "missing" })
      }));
    expect(taskResponse.status).toBe(200);
    expect((taskResponse.body as { task: { taskId: string } }).task.taskId).toBe(taskId);
  });

  it("refreshIfIdle queues one follow-up rebuild when one is already in progress", async () => {
    const store = new MemoryProjectionStore();
    await store.resetFromEvents({ deploymentBlock: 0n, events: [] });

    let readCount = 0;
    let unblock: (() => void) | undefined;
    const blocker = new Promise<void>((resolve) => { unblock = resolve; });

    const eventSource: ChainEventSource = {
      async getFinalizedBlock() {
        await blocker;
        return 10n;
      },
      async readEvents(_range) {
        readCount++;
        return [];
      }
    };

    const indexer = new IndexerService({ config: testConfig(), eventSource, store });

    indexer.refreshIfIdle();
    indexer.refreshIfIdle();

    unblock!();
    await waitForCondition(() => readCount === 2);

    expect(readCount).toBe(2);
  });

  it("queued projection refresh includes the final submit signal in Product proof", async () => {
    const store = new MemoryProjectionStore();
    await store.resetFromEvents({ deploymentBlock: 0n, events: [] });

    const baseEvents = stateMachineEvents();
    const finalSubmit = chainEvent(8n, 0, "SignalSubmitted", {
      orderId: stateMachineOrderId,
      sourceId: bytes32Text("final-submit-source"),
      signalId: bytes32Text("final-submit-signal"),
      payloadHash: bytes32Hex("feed"),
      idempotencyKey: bytes32Hex("9001"),
      submitter: signer
    });
    let readCount = 0;
    let unblock: (() => void) | undefined;
    const blocker = new Promise<void>((resolve) => { unblock = resolve; });
    const eventSource: ChainEventSource = {
      async getFinalizedBlock() {
        return 10n;
      },
      async readEvents(_range) {
        readCount++;
        if (readCount === 1) {
          await blocker;
          return baseEvents;
        }
        return [...baseEvents, finalSubmit];
      }
    };

    const indexer = new IndexerService({ config: testConfig(), eventSource, store });

    indexer.refreshIfIdle();
    indexer.refreshIfIdle();
    unblock!();
    await waitForCondition(() => readCount === 2);

    const router = createApiRouter(store);
    const proofResponse = await router.handle({
      method: "GET",
      pathname: `/product/orders/${stateMachineOrderId}/proof`
    });

    expect(proofResponse.status).toBe(200);
    expect((proofResponse.body as { proof: Array<{ eventName: string; transactionHash: string }> }).proof)
      .toContainEqual(expect.objectContaining({
        eventName: "SignalSubmitted",
        transactionHash: finalSubmit.transactionHash
      }));
  });

  it("passes finalized SignalSubmitted events to the notification processor after projection commit", async () => {
    const store = new MemoryProjectionStore();
    const events = stateMachineEvents();
    const processedEvents: Array<readonly ChainEvent[]> = [];
    const eventSource: ChainEventSource = {
      async getFinalizedBlock() {
        return 10n;
      },
      async readEvents() {
        return events;
      }
    };
    const indexer = new IndexerService({
      config: testConfig(),
      eventSource,
      store,
      notificationProcessor: {
        async processSignalSubmittedEvents(input) {
          processedEvents.push(input);
        }
      }
    });

    await indexer.rebuildFromDeploymentBlockWithSummary();

    expect(await store.getStateMachineOrder(stateMachineOrderId)).toMatchObject({ orderId: stateMachineOrderId });
    expect(processedEvents).toHaveLength(1);
    expect(processedEvents[0]).toContainEqual(expect.objectContaining({
      eventName: "SignalSubmitted",
      args: expect.objectContaining({ orderId: stateMachineOrderId })
    }));
  });

  it("queued projection refresh includes a tx-backed OrderRegistered proof", async () => {
    const store = new MemoryProjectionStore();
    await store.resetFromEvents({ deploymentBlock: 0n, events: [] });

    const queuedOrderId = bytes32Hex("b501");
    const registerTxHash = bytes32Hex("a501") as ChainEvent["transactionHash"];
    const baseEvents = [
      chainEvent(1n, 0, "PlanRegistered", {
        planId,
        planHash,
        hookCount: 1n
      })
    ];
    const registered = {
      ...chainEvent(2n, 0, "OrderRegistered", {
        orderId: queuedOrderId,
        planId
      }),
      transactionHash: registerTxHash
    };
    let readCount = 0;
    let unblock: (() => void) | undefined;
    const blocker = new Promise<void>((resolve) => { unblock = resolve; });
    const eventSource: ChainEventSource = {
      async getFinalizedBlock() {
        return 10n;
      },
      async readEvents(_range) {
        readCount++;
        if (readCount === 1) {
          await blocker;
          return baseEvents;
        }
        return [...baseEvents, registered];
      }
    };

    const indexer = new IndexerService({ config: testConfig(), eventSource, store });

    indexer.refreshIfIdle();
    indexer.refreshIfIdle();
    unblock!();
    await waitForCondition(() => readCount === 2);

    const router = createApiRouter(store);
    const proofResponse = await router.handle({
      method: "GET",
      pathname: `/product/orders/${queuedOrderId}/proof`
    });

    expect(proofResponse.status).toBe(200);
    expect((proofResponse.body as { proof: Array<{ eventName: string; transactionHash: string }> }).proof)
      .toContainEqual(expect.objectContaining({
        eventName: "OrderRegistered",
        transactionHash: registerTxHash
      }));
  });

  it("refreshIfIdle resets rebuilding flag after error so next call can proceed", async () => {
    const store = new MemoryProjectionStore();
    await store.resetFromEvents({ deploymentBlock: 0n, events: [] });

    let callCount = 0;
    let secondCallSucceeded = false;

    const eventSource: ChainEventSource = {
      async getFinalizedBlock() {
        callCount++;
        if (callCount === 1) throw new Error("connection refused");
        secondCallSucceeded = true;
        return 10n;
      },
      async readEvents(_range) {
        return [];
      }
    };

    const indexer = new IndexerService({ config: testConfig(), eventSource, store });

    indexer.refreshIfIdle();
    await new Promise((r) => setTimeout(r, 50));

    indexer.refreshIfIdle();
    await new Promise((r) => setTimeout(r, 50));

    expect(callCount).toBe(2);
    expect(secondCallSucceeded).toBe(true);
  });
});

function deploymentRegistryEvents(): readonly ChainEvent[] {
  return [
    chainEvent(1n, 0, "DeploymentRegistered", {
      deploymentId: deploymentIdV1,
      stateMachine: contractAddress,
      artifactHash: planHash,
      abiHash,
      deploymentBlock: 1n,
      metadataURI: "uvp-eth://deployments/v1"
    }, deploymentRegistryAddress),
    chainEvent(2n, 0, "DeploymentCanaryMarked", {
      deploymentId: deploymentIdV1,
      evidenceHash,
      evidenceURI: "uvp-eth://evidence/v1"
    }, deploymentRegistryAddress),
    chainEvent(3n, 0, "DeploymentActivated", {
      previousDeploymentId: emptyHash,
      newDeploymentId: deploymentIdV1,
      evidenceHash,
      evidenceURI: "uvp-eth://evidence/v1"
    }, deploymentRegistryAddress),
    chainEvent(8n, 0, "DeploymentRegistered", {
      deploymentId: deploymentIdV2,
      stateMachine: contractAddressV2,
      artifactHash: planHash,
      abiHash,
      deploymentBlock: 8n,
      metadataURI: "uvp-eth://deployments/v2"
    }, deploymentRegistryAddress),
    chainEvent(9n, 0, "DeploymentCanaryMarked", {
      deploymentId: deploymentIdV2,
      evidenceHash,
      evidenceURI: "uvp-eth://evidence/v2"
    }, deploymentRegistryAddress),
    chainEvent(10n, 0, "DeploymentActivated", {
      previousDeploymentId: deploymentIdV1,
      newDeploymentId: deploymentIdV2,
      evidenceHash,
      evidenceURI: "uvp-eth://evidence/v2"
    }, deploymentRegistryAddress)
  ];
}

function stateMachineEvents(
  stateMachineAddress = contractAddress,
  orderId = stateMachineOrderId,
  blockOffset = 0n
): readonly ChainEvent[] {
  return [
    chainEvent(blockOffset + 1n, 0, "PlanRegistered", {
      planId,
      planHash,
      hookCount: 1n
    }, stateMachineAddress),
    chainEvent(blockOffset + 2n, 0, "OrderRegistered", {
      orderId,
      planId
    }, stateMachineAddress),
    chainEvent(blockOffset + 3n, 0, "SignalSubmitted", {
      orderId,
      sourceId,
      signalId,
      payloadHash,
      idempotencyKey,
      submitter: signer
    }, stateMachineAddress),
    chainEvent(blockOffset + 3n, 1, "OrderMaterialized", {
      orderId,
      planId,
      stageId
    }, stateMachineAddress),
    chainEvent(blockOffset + 3n, 2, "StageMaterialized", {
      orderId,
      stageId,
      triggerHookId: hookId,
      sourceId,
      signalId
    }, stateMachineAddress),
    chainEvent(blockOffset + 4n, 0, "HookStatusChanged", {
      orderId,
      hookId,
      previousStatus: 0,
      newStatus: 1,
      dueAt: 123n
    }, stateMachineAddress),
    chainEvent(blockOffset + 5n, 0, "TimerPoked", {
      orderId,
      hookId,
      dueAt: 123n
    }, stateMachineAddress),
    chainEvent(blockOffset + 6n, 0, "HookStatusChanged", {
      orderId,
      hookId,
      previousStatus: 1,
      newStatus: 2,
      dueAt: 0n
    }, stateMachineAddress),
    chainEvent(blockOffset + 7n, 0, "HookReady", {
      orderId,
      hookId,
      stageId,
      hookName
    }, stateMachineAddress)
  ];
}

function testConfig(): ChainServicesConfig {
  return {
    network: {
      chainId: 31337,
      rpcUrl: "http://127.0.0.1:8545",
      deploymentBlock: 0n,
      finalityConfirmations: 2,
      reorgBufferBlocks: 8,
      contracts: {}
    },
    database: {
      driver: "memory",
      url: "memory://projection-store",
      migrationsAutoRun: false
    },
    api: {
      host: "127.0.0.1",
      port: 0,
      indexerPollIntervalMs: 0
    },
    relayer: {
      businessSigning: "forbidden",
      broadcastEnabled: false,
      stateMachinePrivateKeyEnv: "UVP_STATE_MACHINE_RELAYER_PRIVATE_KEY",
      maxRetries: 0
    },
    governance: {
      broadcastEnabled: false,
      rpcUrl: "http://127.0.0.1:8545",
      chainId: 31337,
      txConfirmations: 1,
      allowedOperators: []
    },
    productBff: {
      registrationAdapter: "memory",
      registrarPrivateKeyEnv: "UVP_PRODUCT_BFF_REGISTRAR_PRIVATE_KEY",
      waitForReceipt: false
    },
    operatorRoles: {
      deployerPrivateKeyEnv: "UVP_ETH_DEPLOYER_PRIVATE_KEY",
      participantWallets: [],
      adminReviewers: []
    },
    reconcile: {
      enabled: false,
      pollIntervalMs: 50,
      txTimeoutMs: 60_000
    },
    evidenceStorage: {
      adapter: "local",
      objectNamespace: "uvp-rehearsal"
    },
    security: {
      environment: "local",
      preflightStrict: false,
      logRedactionEnabled: true,
      broadcastMaxInFlightPerOrder: 1,
      broadcastMaxRetry: 0,
      broadcastRetryBaseMs: 250,
      broadcastRetryMaxMs: 5_000,
      broadcastReceiptTimeoutMs: 0
    }
  };
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition was not met before timeout");
}

function bytes32Text(value: string): string {
  return `0x${Buffer.from(value, "utf8").toString("hex").padEnd(64, "0")}`;
}

function bytes32Hex(value: string): string {
  return `0x${value.padStart(64, "0")}`;
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
