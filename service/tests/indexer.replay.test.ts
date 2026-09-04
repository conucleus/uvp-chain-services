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
import type { Hex } from "../src/shared/types.js";
import { SqliteProjectionStore } from "../src/storage/sqlite-projection-store.js";
import { buildActiveChainEventReplaySummary, sortChainEvents, type ChainEvent } from "../src/indexer/events.js";
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
  it("orders same-block events by EVM transaction index before log index", () => {
    const ordered = sortChainEvents([
      chainEvent(10n, 0, "SecondTransaction", {}, contractAddress, {
        transactionHash: bytes32Hex("b1"),
        transactionIndex: 2,
      }),
      chainEvent(10n, 0, "FirstTransaction", {}, contractAddress, {
        transactionHash: bytes32Hex("a1"),
        transactionIndex: 1,
      }),
    ]);

    expect(ordered.map((event) => event.eventName)).toEqual([
      "FirstTransaction",
      "SecondTransaction",
    ]);
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
    expect(order?.status).toBe("registered");
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
      chainEvent(3n, 0, "SignalCapabilityRegistered", {
        planId,
        stageId,
        targetSourceId: stageId,
        signalId: hookName,
        targetOrderRelation: 0
      }),
      chainEvent(4n, 0, "SignalSubmitterAuthorized", {
        orderId: stateMachineOrderId,
        sourceId: stageId,
        signalId: hookName,
        submitter: signer,
        role: bytes32Text("executor"),
        metadataHash: emptyHash
      }),
      chainEvent(5n, 0, "HookReady", {
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

  it("marks HookReady tasks submitted from explicit plan signal capabilities", () => {
    const events: readonly ChainEvent[] = [
      chainEvent(1n, 0, "PlanRegistered", {
        planId,
        planHash,
        hookCount: 1n
      }),
      chainEvent(2n, 0, "SignalCapabilityRegistered", {
        planId,
        stageId,
        targetSourceId: sourceId,
        signalId,
        targetOrderRelation: 0
      }),
      chainEvent(3n, 0, "OrderRegistered", {
        orderId: stateMachineOrderId,
        planId
      }),
      chainEvent(4n, 0, "HookReady", {
        orderId: stateMachineOrderId,
        hookId,
        stageId,
        hookName
      }),
      chainEvent(5n, 0, "SignalSubmitted", {
        orderId: stateMachineOrderId,
        sourceId,
        signalId,
        payloadHash,
        idempotencyKey,
        submitter: signer
      })
    ];

    const snapshot = rebuildOrderProjections(events);
    const task = snapshot.stateMachineTasks[`${contractAddress}:${stateMachineOrderId}:${hookId}`];

    expect(task).toMatchObject({
      status: "submitted",
      submitSignals: [
        {
          sourceId,
          signalId,
          source: "plan_capability"
        }
      ],
      proof: expect.objectContaining({
        eventName: "SignalSubmitted",
        transactionHash: chainEvent(5n, 0, "SignalSubmitted", {}).transactionHash
      })
    });
  });

  it("backfills submitted status when a matching signal is projected before HookReady creates the task", () => {
    const events: readonly ChainEvent[] = [
      chainEvent(1n, 0, "PlanRegistered", {
        planId,
        planHash,
        hookCount: 1n
      }),
      chainEvent(2n, 0, "SignalCapabilityRegistered", {
        planId,
        stageId,
        targetSourceId: sourceId,
        signalId,
        targetOrderRelation: 0
      }),
      chainEvent(3n, 0, "OrderRegistered", {
        orderId: stateMachineOrderId,
        planId
      }),
      chainEvent(4n, 0, "SignalSubmitted", {
        orderId: stateMachineOrderId,
        sourceId,
        signalId,
        payloadHash,
        idempotencyKey,
        submitter: signer
      }),
      chainEvent(5n, 0, "HookReady", {
        orderId: stateMachineOrderId,
        hookId,
        stageId,
        hookName
      })
    ];

    const snapshot = rebuildOrderProjections(events);
    const order = snapshot.stateMachineOrders[stateMachineScopedKey(31337, contractAddress, stateMachineOrderId)];
    const task = snapshot.stateMachineTasks[`${contractAddress}:${stateMachineOrderId}:${hookId}`];

    expect(order?.status).toBe("registered");
    expect(task).toMatchObject({
      status: "submitted",
      proof: expect.objectContaining({
        eventName: "SignalSubmitted",
        transactionHash: chainEvent(4n, 0, "SignalSubmitted", {}).transactionHash
      })
    });
  });

  it("matches task authorization only against declared submit signals", () => {
    const events: readonly ChainEvent[] = [
      chainEvent(1n, 0, "PlanRegistered", {
        planId,
        planHash,
        hookCount: 1n
      }),
      chainEvent(2n, 0, "SignalCapabilityRegistered", {
        planId,
        stageId,
        targetSourceId: sourceId,
        signalId,
        targetOrderRelation: 0
      }),
      chainEvent(3n, 0, "OrderRegistered", {
        orderId: stateMachineOrderId,
        planId
      }),
      chainEvent(4n, 0, "SignalSubmitterAuthorized", {
        orderId: stateMachineOrderId,
        sourceId: stageId,
        signalId: hookName,
        submitter: signer,
        role: bytes32Text("unrelated"),
        metadataHash: emptyHash
      }),
      chainEvent(5n, 0, "HookReady", {
        orderId: stateMachineOrderId,
        hookId,
        stageId,
        hookName
      })
    ];

    const snapshot = rebuildOrderProjections(events);
    const task = snapshot.stateMachineTasks[`${contractAddress}:${stateMachineOrderId}:${hookId}`];

    expect(task).toMatchObject({
      assigneeRole: "unknown",
      submitSignals: [
        {
          sourceId,
          signalId,
          source: "plan_capability"
        }
      ]
    });
    expect(task?.assigneeWallet).toBeUndefined();
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
        patchNonce: 1n,
        metadataURI: "ipfs://stage-executor-patch/1"
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

  it("projects module-level derived signal provenance on the target order", () => {
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
      chainEvent(3n, 0, "DerivedSignalSubmitted", {
        fromOrderId: bytes32Hex("7101"),
        fromStageId: selectorStageId,
        targetOrderId: stateMachineOrderId,
        targetSourceId: sourceId,
        signalId,
        payloadHash,
        idempotencyKey,
        submitter: signer
      })
    ];

    const snapshot = rebuildOrderProjections(events);
    const order = snapshot.stateMachineOrders[stateMachineScopedKey(31337, contractAddress, stateMachineOrderId)];

    expect(order?.proof).toContainEqual(expect.objectContaining({
      eventName: "DerivedSignalSubmitted",
      submitter: signer
    }));
    expect(order?.timeline.map((event) => event.eventName)).toContain("DerivedSignalSubmitted");
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

  it("revives a log re-emitted at the same position after its removed tombstone", () => {
    // removed 墓碑只过滤“曾 removed 且此后未复活”的窗口：reorg 后 canonical
    // 链在同一 (block,txHash,logIndex) 重新出现的非 removed 事件必须被处理，
    // 而不是被墓碑永久跳过。
    const registered = chainEvent(2n, 0, "OrderRegistered", {
      orderId: stateMachineOrderId,
      planId
    });

    const summary = buildActiveChainEventReplaySummary([
      { ...registered, removed: true },
      chainEvent(1n, 0, "PlanRegistered", {
        planId,
        planHash,
        hookCount: 1n
      }),
      registered
    ]);

    expect(summary).toMatchObject({
      activeEventCount: 2,
      removedEventCount: 1,
      removedLogsFiltered: true
    });
    expect(summary.activeEvents.map((event) => event.eventName)).toEqual([
      "PlanRegistered",
      "OrderRegistered"
    ]);

    const snapshot = rebuildOrderProjections([
      { ...registered, removed: true },
      chainEvent(1n, 0, "PlanRegistered", {
        planId,
        planHash,
        hookCount: 1n
      }),
      registered
    ]);
    expect(snapshot.stateMachineOrders[stateMachineScopedKey(31337, contractAddress, stateMachineOrderId)]).toBeDefined();
    expect(snapshot.eventCount).toBe(2);
  });

  it("still filters removed logs that were never revived", () => {
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
    const router = createApiRouter(store, { submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111" });
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

  it("projects state-machine module and plan publisher provenance", () => {
    const moduleId = bytes32Text("uvp.module.docking.v1") as `0x${string}`;
    const moduleAddress = "0x6666666666666666666666666666666666666666";
    const previousModule = "0x7777777777777777777777777777777777777777";
    const events: readonly ChainEvent[] = [
      chainEvent(1n, 0, "PlanRegistered", {
        planId,
        planHash,
        hookCount: 1n
      }),
      chainEvent(1n, 1, "PlanPublisherRecorded", {
        planId,
        publisher: signer
      }),
      chainEvent(2n, 0, "OrderRegistered", {
        orderId: stateMachineOrderId,
        planId
      }),
      chainEvent(3n, 0, "StateMachineModuleSet", {
        moduleId,
        previousModule,
        newModule: moduleAddress
      })
    ];

    const snapshot = rebuildOrderProjections(events);
    const plan = snapshot.stateMachinePlans[stateMachineScopedKey(31337, contractAddress, planId)];
    const order = snapshot.stateMachineOrders[stateMachineScopedKey(31337, contractAddress, stateMachineOrderId)];
    const module = snapshot.stateMachineModules[stateMachineScopedKey(31337, contractAddress, moduleId)];

    expect(plan).toMatchObject({
      publisher: signer,
      publisherProof: expect.objectContaining({ eventName: "PlanPublisherRecorded" })
    });
    expect(order).toMatchObject({
      status: "registered"
    });
    expect(order?.proof.every((entry) => entry.eventName !== "OrderRegistrarRecorded")).toBe(true);
    expect(module).toMatchObject({
      stateMachineAddress: contractAddress,
      moduleId,
      previousModule,
      moduleAddress,
      proof: expect.objectContaining({ eventName: "StateMachineModuleSet" })
    });
  });

  it("routes module-emitted order events to the owning state-machine order instead of phantom module buckets", () => {
    // P0 幻影订单：7 类订单维度事件由模块合约发出（event.contractAddress =
    // 模块地址）。归一化后必须落到所属状态机的订单桶，且不得在模块地址下
    // 产生 planId=0 的 unknown 幻影订单。
    const moduleId = bytes32Text("uvp.module.stage-patch.v1");
    const moduleAddress = "0x6666666666666666666666666666666666666666";
    const dockInstanceId = bytes32Hex("900");
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
      chainEvent(3n, 0, "StateMachineModuleSet", {
        moduleId,
        previousModule: "0x0000000000000000000000000000000000000000",
        newModule: moduleAddress
      }),
      chainEvent(4n, 0, "StageExecutorPatchApplied", {
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
      }, moduleAddress),
      chainEvent(5n, 0, "DockOpened", {
        dockInstanceId: dockInstanceId,
        localOrderId: stateMachineOrderId,
        linkedOrderId: bytes32Hex("303"),
        localPlanId: planId,
        targetPlanId: bytes32Hex("404"),
        routeId: bytes32Hex("505"),
        routeHash: patchHash,
        depth: 1n,
        opener: signer
      }, moduleAddress),
      chainEvent(6n, 0, "DockInputSubmitted", {
        dockInstanceId: dockInstanceId,
        linkedOrderId: bytes32Hex("303"),
        inputBindingHash: bytes32Hex("606"),
        localPlanId: planId,
        localOrderId: stateMachineOrderId,
        targetPlanId: bytes32Hex("404"),
        targetSignalId: signalId,
        payloadHash,
        submitter: signer
      }, moduleAddress),
      chainEvent(7n, 0, "DerivedSignalSubmitted", {
        fromOrderId: stateMachineOrderId,
        targetOrderId: stateMachineOrderId,
        signalId,
        fromStageId: stageId,
        targetSourceId: sourceId,
        payloadHash,
        idempotencyKey,
        submitter: signer
      }, moduleAddress)
    ];

    const snapshot = rebuildOrderProjections(events);
    const orderKey = stateMachineScopedKey(31337, contractAddress, stateMachineOrderId);
    const order = snapshot.stateMachineOrders[orderKey];

    // 模块事件全部落到真实订单桶。
    expect(order).toBeDefined();
    expect(order?.stageExecutorOverlays[stageId]).toMatchObject({
      activeExecutorWallet: overlayExecutor,
      proof: expect.objectContaining({ eventName: "StageExecutorPatchApplied" })
    });
    expect(order?.proof.map((proof) => proof.eventName)).toEqual(expect.arrayContaining([
      "StageExecutorPatchApplied",
      "DockOpened",
      "DockInputSubmitted",
      "DerivedSignalSubmitted"
    ]));
    const dockKey = stateMachineScopedKey(31337, contractAddress, dockInstanceId);
    expect(snapshot.stateMachineDocks[dockKey]).toMatchObject({
      localOrderId: stateMachineOrderId,
      linkedOrderId: bytes32Hex("303"),
      targetPlanId: bytes32Hex("404"),
      status: "open"
    });
    expect(Object.keys(snapshot.stateMachineDocks[dockKey]?.inputDeliveries ?? {})).toEqual([
      bytes32Hex("606")
    ]);
    // 不产生以模块地址为桶的幻影订单；父订单与 dock 创建的子订单都归属状态机地址。
    const linkedOrderKey = stateMachineScopedKey(31337, contractAddress, bytes32Hex("303"));
    expect(Object.keys(snapshot.stateMachineOrders).sort()).toEqual([orderKey, linkedOrderKey].sort());
    expect(Object.values(snapshot.stateMachineOrders).every((entry) => entry.contractAddress === contractAddress)).toBe(true);
    expect(snapshot.stateMachineDocks[dockKey]?.stateMachineAddress).toBe(contractAddress);
    expect(snapshot.unresolvedModuleOrderEventCount).toBe(0);
  });

  it("counts module order events that cannot be attributed to a state machine instead of silently bucketing", () => {
    // 模块地址未（尚未）通过 StateMachineModuleSet 登记：事件保持现状建桶，
    // 但必须计入显式诊断计数，不允许静默。
    const unregisteredModuleAddress = "0x7777777777777777777777777777777777777777";
    const events: readonly ChainEvent[] = [
      chainEvent(1n, 0, "StageExecutorPatchApplied", {
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
      }, unregisteredModuleAddress)
    ];

    const snapshot = rebuildOrderProjections(events);

    expect(snapshot.unresolvedModuleOrderEventCount).toBe(1);
    expect(Object.keys(snapshot.stateMachineOrders)).toEqual([
      stateMachineScopedKey(31337, unregisteredModuleAddress, stateMachineOrderId)
    ]);
  });

  it("resolves plan events from module addresses when the same planId exists across deployments", () => {
    // 同 planId 双部署 + plan 维度事件（SignalCapabilityRegistered）由模块
    // 合约发出：归一化后必须精确命中所属状态机的 plan，不再走歧义回退抛
    // ProjectionError 把索引器打进永久 degraded。
    const planMetadataModuleAddress = "0xaaaa111111111111111111111111111111111111";
    const events: readonly ChainEvent[] = [
      chainEvent(1n, 0, "PlanRegistered", {
        planId,
        planHash,
        hookCount: 1n
      }, contractAddress),
      chainEvent(2n, 0, "PlanRegistered", {
        planId,
        planHash,
        hookCount: 1n
      }, contractAddressV2),
      chainEvent(3n, 0, "StateMachineModuleSet", {
        moduleId: bytes32Text("uvp.module.plan-metadata.v1"),
        previousModule: "0x0000000000000000000000000000000000000000",
        newModule: planMetadataModuleAddress
      }, contractAddressV2),
      chainEvent(4n, 0, "SignalCapabilityRegistered", {
        planId,
        stageId,
        targetSourceId: sourceId,
        signalId,
        targetOrderRelation: 0
      }, planMetadataModuleAddress)
    ];

    const snapshot = rebuildOrderProjections(events);

    const planV2 = snapshot.stateMachinePlans[stateMachineScopedKey(31337, contractAddressV2, planId)];
    expect(planV2?.signalCapabilities).toHaveLength(1);
    expect(planV2?.signalCapabilities[0]).toMatchObject({ stageId, signalId });
    const planV1 = snapshot.stateMachinePlans[stateMachineScopedKey(31337, contractAddress, planId)];
    expect(planV1?.signalCapabilities).toHaveLength(0);
  });

  it("binds plans and orders to the active deployment for reused state-machine addresses", () => {
    const events: readonly ChainEvent[] = [
      chainEvent(1n, 0, "DeploymentRegistered", {
        deploymentId: deploymentIdV1,
        stateMachine: contractAddress,
        artifactHash: planHash,
        abiHash,
        deploymentBlock: 1n,
        metadataURI: "uvp-eth://deployments/reused-v1"
      }, deploymentRegistryAddress),
      chainEvent(2n, 0, "DeploymentActivated", {
        previousDeploymentId: emptyHash,
        newDeploymentId: deploymentIdV1,
        evidenceHash,
        evidenceURI: "uvp-eth://evidence/reused-v1"
      }, deploymentRegistryAddress),
      chainEvent(3n, 0, "DeploymentRegistered", {
        deploymentId: deploymentIdV2,
        stateMachine: contractAddress,
        artifactHash: planHash,
        abiHash,
        deploymentBlock: 3n,
        metadataURI: "uvp-eth://deployments/reused-v2"
      }, deploymentRegistryAddress),
      chainEvent(4n, 0, "DeploymentActivated", {
        previousDeploymentId: deploymentIdV1,
        newDeploymentId: deploymentIdV2,
        evidenceHash,
        evidenceURI: "uvp-eth://evidence/reused-v2"
      }, deploymentRegistryAddress),
      chainEvent(5n, 0, "PlanRegistered", {
        planId,
        planHash,
        hookCount: 1n
      }),
      chainEvent(6n, 0, "OrderRegistered", {
        orderId: stateMachineOrderId,
        planId
      })
    ];

    const snapshot = rebuildOrderProjections(events);
    const plan = snapshot.stateMachinePlans[stateMachineScopedKey(31337, contractAddress, planId)];
    const order = snapshot.stateMachineOrders[stateMachineScopedKey(31337, contractAddress, stateMachineOrderId)];

    expect(snapshot.stateMachineDeployments[`${31337}:${deploymentRegistryAddress}:${deploymentIdV1}`]?.status).toBe("deprecated");
    expect(snapshot.stateMachineDeployments[`${31337}:${deploymentRegistryAddress}:${deploymentIdV2}`]?.status).toBe("active");
    expect(plan?.deploymentId).toBe(deploymentIdV2);
    expect(order?.deploymentId).toBe(deploymentIdV2);
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
      deploymentBlock: "0",
      fromBlock: "0",
      toBlock: "9",
      eventCount: 9,
      activeEventCount: 9,
      removedEventCount: 0,
      removedLogsFiltered: false,
      projectionRebuilt: true,
      stateMachineOrderCount: 1,
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
      rebuild: expect.objectContaining({
        status: "completed",
        deploymentBlock: 0n,
        activeEventCount: 9,
        removedEventCount: 0,
        removedLogsFiltered: false,
        projectionRebuilt: true
      })
    });
  });

  it("reports removed-log filtering evidence in rebuild summaries", async () => {
    const store = new MemoryProjectionStore();
    const registered = chainEvent(2n, 0, "OrderRegistered", {
      orderId: stateMachineOrderId,
      planId
    });
    const events: readonly ChainEvent[] = [
      chainEvent(1n, 0, "PlanRegistered", {
        planId,
        planHash,
        hookCount: 1n
      }),
      registered,
      { ...registered, removed: true }
    ];
    const eventSource: ChainEventSource = {
      async getFinalizedBlock() {
        return 5n;
      },
      async readEvents() {
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
      deploymentBlock: "0",
      fromBlock: "0",
      toBlock: "5",
      eventCount: 1,
      activeEventCount: 1,
      removedEventCount: 1,
      removedLogsFiltered: true,
      projectionRebuilt: true,
      stateMachineOrderCount: 0
    });
    expect(result.snapshot.stateMachineOrders[stateMachineScopedKey(31337, contractAddress, stateMachineOrderId)])
      .toBeUndefined();
    expect(syncState?.rebuild).toMatchObject({
      status: "completed",
      deploymentBlock: 0n,
      fromBlock: 0n,
      toBlock: 5n,
      eventCount: 1,
      activeEventCount: 1,
      removedEventCount: 1,
      removedLogsFiltered: true,
      projectionRebuilt: true
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

  it("rolls back stored events and replays the canonical fork when a reorg breaks cursor hash continuity", async () => {
    // ETH-02：模拟 fork——block 3 之后链被替换。cursor 哈希校验发现断链，
    // 共同祖先定位到 block 2，删除 block 3 的旧事件，从 fork 链重放。
    const tempDir = mkdtempSync(join(tmpdir(), "uvp-indexer-reorg-"));
    const store = new SqliteProjectionStore({
      databaseUrl: `sqlite://${join(tempDir, "projection.sqlite3")}`,
      chainId: 31337,
      migrations: {
        autoRun: true,
        directory: resolve(__dirname, "../migrations")
      }
    });
    try {
      // block 1..2 两链一致；block 3 起分叉（不同哈希、不同事件）。
      const canonicalEvents: readonly ChainEvent[] = [
        chainEvent(1n, 0, "PlanRegistered", { planId, planHash, hookCount: 1n }),
        chainEvent(2n, 0, "OrderRegistered", { orderId: stateMachineOrderId, planId })
      ];
      const staleBlock3Event = {
        ...chainEvent(3n, 0, "SignalSubmitted", {
          orderId: stateMachineOrderId,
          sourceId,
          signalId,
          payloadHash,
          idempotencyKey,
          submitter: signer
        }),
        blockHash: blockHashHex("block-3-stale")
      };
      const originalEvents = [
        ...canonicalEvents.map((event, index) => ({ ...event, blockHash: blockHashHex(`block-${index + 1}`) })),
        staleBlock3Event
      ];
      const forkedBlock3Event = {
        ...chainEvent(3n, 0, "SignalSubmitted", {
          orderId: stateMachineOrderId,
          sourceId,
          signalId,
          payloadHash: bytes32Hex("feed"),
          idempotencyKey: bytes32Hex("9002"),
          submitter: signer
        }),
        blockHash: blockHashHex("block-3-fork")
      };
      const forkedBlock4Event = {
        ...chainEvent(4n, 0, "HookReady", {
          orderId: stateMachineOrderId,
          hookId,
          stageId,
          hookName
        }),
        blockHash: blockHashHex("block-4-fork")
      };
      let canonicalBlocks = new Map<bigint, Hex>([
        [1n, blockHashHex("block-1")],
        [2n, blockHashHex("block-2")],
        [3n, blockHashHex("block-3-stale")]
      ]);
      let readableEvents: readonly ChainEvent[] = originalEvents;
      let finalizedBlock = 3n;
      const eventSource: ChainEventSource = {
        async getFinalizedBlock() {
          return finalizedBlock;
        },
        async readEvents(range) {
          return readableEvents.filter((event) => event.blockNumber >= range.fromBlock && event.blockNumber <= range.toBlock);
        },
        async getBlockHash(blockNumber) {
          return canonicalBlocks.get(blockNumber) ?? zeroBlockHash();
        }
      };
      const indexer = new IndexerService({
        config: testConfig(),
        eventSource,
        store
      });

      await indexer.rebuildFromDeploymentBlockWithSummary();
      await expect(store.listEvents({ chainId: 31337 })).resolves.toHaveLength(3);

      // fork 生效：block 3 哈希改变并出现 block 4 的新事件。
      canonicalBlocks = new Map<bigint, Hex>([
        [1n, blockHashHex("block-1")],
        [2n, blockHashHex("block-2")],
        [3n, blockHashHex("block-3-fork")],
        [4n, blockHashHex("block-4-fork")]
      ]);
      readableEvents = [...canonicalEvents.map((event, index) => ({ ...event, blockHash: blockHashHex(`block-${index + 1}`) })), forkedBlock3Event, forkedBlock4Event];
      finalizedBlock = 4n;

      const result = await indexer.refreshFromCursorWithSummary();

      // 旧 block-3 事件被删除，fork 链事件无重复地重放。
      const storedEvents = await store.listEvents({ chainId: 31337 });
      expect(storedEvents).toHaveLength(4);
      expect(storedEvents.filter((event) => event.blockNumber === 3n)).toHaveLength(1);
      expect(storedEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({ blockNumber: 3n, blockHash: blockHashHex("block-3-fork") }),
        expect.objectContaining({ blockNumber: 4n, blockHash: blockHashHex("block-4-fork") })
      ]));
      expect(result.summary).toMatchObject({
        fromBlock: "3",
        toBlock: "4",
        syncStatus: "indexed",
        finalizedBlock: "4",
        mismatchCount: 0
      });
      await expect(store.getCursor({ chainId: 31337, contractAddress: "0x0000000000000000000000000000000000000000" }))
        .resolves.toMatchObject({ nextBlock: 5n, finalizedBlock: 4n, blockHash: blockHashHex("block-4-fork") });
    } finally {
      await store.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("fails with a full-rebuild demand when a reorg erases every known block hash", async () => {
    // ETH-02：整条已知链都被替换时，回溯窗口内找不到共同祖先 → 报错。
    const tempDir = mkdtempSync(join(tmpdir(), "uvp-indexer-reorg-deep-"));
    const store = new SqliteProjectionStore({
      databaseUrl: `sqlite://${join(tempDir, "projection.sqlite3")}`,
      chainId: 31337,
      migrations: {
        autoRun: true,
        directory: resolve(__dirname, "../migrations")
      }
    });
    try {
      const originalEvents = stateMachineEvents().map((event) => ({
        ...event,
        blockHash: blockHashHex(`orig-${event.blockNumber}`)
      }));
      let canonicalBlocks = new Map<bigint, Hex>(
        [1n, 2n, 3n, 4n, 5n, 6n, 7n].map((block) => [block, blockHashHex(`orig-${block}`)])
      );
      let finalizedBlock = 7n;
      const eventSource: ChainEventSource = {
        async getFinalizedBlock() {
          return finalizedBlock;
        },
        async readEvents(range) {
          return originalEvents.filter((event) => event.blockNumber >= range.fromBlock && event.blockNumber <= range.toBlock);
        },
        async getBlockHash(blockNumber) {
          return canonicalBlocks.get(blockNumber) ?? zeroBlockHash();
        }
      };
      const indexer = new IndexerService({
        config: testConfig(),
        eventSource,
        store
      });
      await indexer.rebuildFromDeploymentBlockWithSummary();

      // 整链替换：所有已知块的 canonical 哈希都变了。
      canonicalBlocks = new Map<bigint, Hex>(
        [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n].map((block) => [block, blockHashHex(`fork-${block}`)])
      );
      finalizedBlock = 8n;

      await expect(indexer.refreshFromCursorWithSummary()).rejects.toThrow(
        /reorg deeper than the 1000-block rollback window; full projection rebuild is required/
      );
    } finally {
      await store.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("reports real replay anomalies in rebuild mismatchCount instead of a hardcoded zero", async () => {
    // ETH-09：同一事件键作为活跃事件重复投递（矛盾投递）必须计入
    // mismatchCount；正常流保持 0。
    const events = stateMachineEvents();
    const duplicated = [...events, events[2]!];
    const store = new MemoryProjectionStore();
    const eventSource: ChainEventSource = {
      async getFinalizedBlock() {
        return 9n;
      },
      async readEvents() {
        return duplicated;
      }
    };
    const indexer = new IndexerService({
      config: testConfig(),
      eventSource,
      store
    });

    const result = await indexer.rebuildFromDeploymentBlockWithSummary();

    expect(result.summary.mismatchCount).toBe(1);
    expect(result.summary.eventCount).toBe(9);

    const degradedStore = new MemoryProjectionStore();
    // 投影 apply 失败（未知 plan 引用）同样计入并进入 degraded。
    const corruptSource: ChainEventSource = {
      async getFinalizedBlock() {
        return 5n;
      },
      async readEvents() {
        return [
          chainEvent(1n, 0, "SignalCapabilityRegistered", {
            planId,
            stageId,
            targetSourceId: sourceId,
            signalId,
            targetOrderRelation: 0
          })
        ];
      }
    };
    const corruptIndexer = new IndexerService({
      config: testConfig(),
      eventSource: corruptSource,
      store: degradedStore
    });
    await expect(corruptIndexer.rebuildFromDeploymentBlockWithSummary()).rejects.toThrow(/unknown plan/);
    await expect(degradedStore.getSyncState()).resolves.toMatchObject({
      syncStatus: "degraded",
      rebuild: expect.objectContaining({ status: "failed", mismatchCount: 1 })
    });
  });

  it("serves state-machine projection through Product API endpoints", async () => {
    const store = new MemoryProjectionStore();
    await store.resetFromEvents({ deploymentBlock: 0n, events: stateMachineEvents() });
    const router = createApiRouter(store, { submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111" });
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
        chainStatus: "registered",
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

    const router = createApiRouter(store, { submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111" });
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

    const router = createApiRouter(store, { submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111" });
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
    await expect(store.getSyncState()).resolves.toMatchObject({
      syncStatus: "degraded",
      degradedReason: "connection refused"
    });

    indexer.refreshIfIdle();
    await new Promise((r) => setTimeout(r, 50));

    expect(callCount).toBe(2);
    expect(secondCallSucceeded).toBe(true);
    await expect(store.getSyncState()).resolves.toMatchObject({
      syncStatus: "indexed"
    });
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
      registrationAdapter: "memory-trigger",
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
    dockAutomation: {
      enabled: false,
      pollIntervalMs: 5_000,
      maxCandidatesPerRun: 4,
      maxGasPerTx: 500_000n,
      waitForReceipt: true
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

function blockHashHex(label: string): Hex {
  return `0x${Buffer.from(label, "utf8").toString("hex").padStart(64, "0").slice(0, 64)}` as Hex;
}

function zeroBlockHash(): Hex {
  return `0x${"0".repeat(64)}` as Hex;
}

function bytes32Hex(value: string): `0x${string}` {
  return `0x${value.padStart(64, "0")}`;
}

function chainEvent(
  blockNumber: bigint,
  logIndex: number,
  eventName: string,
  args: Record<string, unknown>,
  eventContractAddress = contractAddress,
  overrides: Partial<Pick<ChainEvent, "transactionHash" | "transactionIndex">> = {}
): ChainEvent {
  return {
    chainId: 31337,
    contractAddress: eventContractAddress as ChainEvent["contractAddress"],
    blockNumber,
    transactionHash: `0x${blockNumber.toString(16).padStart(64, "0")}`,
    logIndex,
    eventName,
    args,
    ...overrides
  };
}
