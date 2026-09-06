import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createApiRouter } from "../src/api/routes.js";
import type { ChainServicesConfig } from "../src/config/index.js";
import { IndexerService, type ChainEventSource } from "../src/indexer/service.js";
import { rebuildOrderProjections, stateMachineScopedKey, stateMachineTaskProjectionKey } from "../src/indexer/projections.js";
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
    const orderKey = stateMachineScopedKey(31337, contractAddress, planId, stateMachineOrderId);
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
    const order = rebuilt.stateMachineOrders[stateMachineScopedKey(31337, contractAddress, planId, stateMachineOrderId)];
    const task = rebuilt.stateMachineTasks[stateMachineTaskProjectionKey(31337, contractAddress, planId, stateMachineOrderId, hookId)];

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
    const task = snapshot.stateMachineTasks[stateMachineTaskProjectionKey(31337, contractAddress, planId, stateMachineOrderId, hookId)];

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
    const order = snapshot.stateMachineOrders[stateMachineScopedKey(31337, contractAddress, planId, stateMachineOrderId)];
    const task = snapshot.stateMachineTasks[stateMachineTaskProjectionKey(31337, contractAddress, planId, stateMachineOrderId, hookId)];

    expect(order?.status).toBe("registered");
    expect(task).toMatchObject({
      status: "submitted",
      proof: expect.objectContaining({
        eventName: "SignalSubmitted",
        transactionHash: chainEvent(4n, 0, "SignalSubmitted", {}).transactionHash
      })
    });
  });

  it("keeps the earliest matching signal as the submitted proof when a later matching signal arrives", () => {
    // L-11：任务 submitted 是首个完成事实——后到的匹配信号不得覆盖
    // 任务的完成证明与 updatedAt（与创建路径取最早证明同口径）。
    const base: readonly ChainEvent[] = [
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
    const snapshot = rebuildOrderProjections([
      ...base,
      chainEvent(6n, 0, "SignalSubmitted", {
        orderId: stateMachineOrderId,
        sourceId,
        signalId,
        payloadHash,
        idempotencyKey: bytes32Hex("0aaa"),
        submitter: signer
      })
    ]);
    const task = snapshot.stateMachineTasks[stateMachineTaskProjectionKey(31337, contractAddress, planId, stateMachineOrderId, hookId)];

    expect(task).toMatchObject({
      status: "submitted",
      proof: expect.objectContaining({
        eventName: "SignalSubmitted",
        transactionHash: chainEvent(5n, 0, "SignalSubmitted", {}).transactionHash
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
    const task = snapshot.stateMachineTasks[stateMachineTaskProjectionKey(31337, contractAddress, planId, stateMachineOrderId, hookId)];

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
    const order = snapshot.stateMachineOrders[stateMachineScopedKey(31337, contractAddress, planId, stateMachineOrderId)];
    const targetTask = snapshot.stateMachineTasks[stateMachineTaskProjectionKey(31337, contractAddress, planId, stateMachineOrderId, hookId)];

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
    const order = snapshot.stateMachineOrders[stateMachineScopedKey(31337, contractAddress, planId, stateMachineOrderId)];

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

    expect(snapshot.stateMachineOrders[stateMachineScopedKey(31337, contractAddress, planId, stateMachineOrderId)]).toBeUndefined();
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
    expect(snapshot.stateMachineOrders[stateMachineScopedKey(31337, contractAddress, planId, stateMachineOrderId)]).toBeDefined();
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

    expect(snapshot.stateMachineOrders[stateMachineScopedKey(31337, contractAddress, planId, stateMachineOrderId)]).toBeUndefined();
    expect(snapshot.eventCount).toBe(1);
  });

  it("projects registry deployments and scopes identical order ids by state machine", async () => {
    const events = [
      ...deploymentRegistryEvents(),
      ...stateMachineEvents(contractAddress, stateMachineOrderId),
      ...stateMachineEvents(contractAddressV2, stateMachineOrderId, 10n)
    ];

    const snapshot = rebuildOrderProjections(events);
    const v1Key = stateMachineScopedKey(31337, contractAddress, planId, stateMachineOrderId);
    const v2Key = stateMachineScopedKey(31337, contractAddressV2, planId, stateMachineOrderId);

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
    const order = snapshot.stateMachineOrders[stateMachineScopedKey(31337, contractAddress, planId, stateMachineOrderId)];
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
    const orderKey = stateMachineScopedKey(31337, contractAddress, planId, stateMachineOrderId);
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
    // 快照枚举只暴露 plan 作用域复合键（裸键兼容别名已按清零裁决移除）。
    const linkedOrderKey = stateMachineScopedKey(31337, contractAddress, bytes32Hex("404"), bytes32Hex("303"));
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
    // 无 planId 的模块订单事件落入 planId=0 的未知桶；键是 plan 作用域复合键。
    expect(Object.keys(snapshot.stateMachineOrders)).toEqual([
      stateMachineScopedKey(31337, unregisteredModuleAddress, emptyHash, stateMachineOrderId)
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
    const order = snapshot.stateMachineOrders[stateMachineScopedKey(31337, contractAddress, planId, stateMachineOrderId)];

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

  it("does not advance the in-memory cursor before durable cursor persistence succeeds", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "uvp-indexer-cursor-failure-"));
    const store = new SqliteProjectionStore({
      databaseUrl: `sqlite://${join(tempDir, "projection.sqlite3")}`,
      chainId: 31337,
      migrations: {
        autoRun: true,
        directory: resolve(__dirname, "../migrations")
      }
    });
    try {
      const originalSaveCursor = store.saveCursor.bind(store);
      let failNextSave = true;
      store.saveCursor = async (cursor) => {
        if (failNextSave) {
          failNextSave = false;
          throw new Error("cursor write failed");
        }
        return originalSaveCursor(cursor);
      };
      const eventSource: ChainEventSource = {
        async getFinalizedBlock() {
          return 1n;
        },
        async readEvents() {
          return [];
        }
      };
      const indexer = new IndexerService({
        config: testConfig(),
        eventSource,
        store
      });

      await expect(indexer.rebuildFromDeploymentBlockWithSummary()).rejects.toThrow("cursor write failed");
      expect(indexer.cursor).toBeUndefined();

      const result = await indexer.rebuildFromDeploymentBlockWithSummary();
      expect(result.summary.syncStatus).toBe("indexed");
      expect(indexer.cursor).toMatchObject({ nextBlock: 2n, finalizedBlock: 1n });
    } finally {
      await store.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
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
    expect(result.snapshot.stateMachineOrders[stateMachineScopedKey(31337, contractAddress, planId, stateMachineOrderId)])
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

      // 全库最新已存事件锚点本身已不在 canonical 链上：reorg 深于全部已投影
      // 数据，仍要求人工 full rebuild。
      await expect(indexer.refreshFromCursorWithSummary()).rejects.toThrow(
        /reorg deeper than the stored projection history; full projection rebuild is required/
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

  it("replays the real two-step plan publish transaction log order without a ProjectionError", () => {
    // 簇 E-1（0620 H-1/0630 C-1）：真实链序 commitPlan 先发 PlanCommitted →
    // PlanPublisherRecorded；finalizePlan 内先调 plan metadata 模块（模块
    // 事件 logIndex 更小），随后才发 PlanFinalized + PlanRegistered。投影
    // 若只认 PlanRegistered 建桶，首次两步发布即在 finalize 交易内撞
    // "unknown plan" → ProjectionError → 索引器永久 degraded。
    const planMetadataModuleId = bytes32Text("uvp.module.plan-metadata.v1");
    const planMetadataModuleAddress = "0x7676767676767676767676767676767676767676";
    const hooksHash = bytes32Hex("9001");
    const metadataHash = bytes32Hex("9002");
    const dockRoutesRoot = bytes32Hex("9003");
    const dockInterfaceRoot = bytes32Hex("9004");
    const publisher = "0x4444444444444444444444444444444444444444";
    const events: readonly ChainEvent[] = [
      // 部署交易：登记 plan metadata 模块。
      chainEvent(1n, 0, "StateMachineModuleSet", {
        moduleId: planMetadataModuleId,
        previousModule: "0x0000000000000000000000000000000000000000",
        newModule: planMetadataModuleAddress
      }),
      // commitPlan 交易：PlanCommitted 先于 PlanPublisherRecorded。
      chainEvent(2n, 0, "PlanCommitted", {
        planId,
        planHash,
        publisher,
        hooksHash,
        metadataHash,
        hookCount: 2n,
        dockRoutesRoot,
        dockInterfaceRoot
      }),
      chainEvent(2n, 1, "PlanPublisherRecorded", {
        planId,
        publisher
      }),
      // finalizePlan 交易：模块事件 logIndex 先于 PlanFinalized/PlanRegistered
      //（合约 finalizePlanMetadata 调用在两个 emit 之前）。
      chainEvent(3n, 0, "SignalCapabilityRegistered", {
        planId,
        stageId,
        targetSourceId: sourceId,
        signalId,
        targetOrderRelation: 0
      }, planMetadataModuleAddress),
      chainEvent(3n, 1, "StageSelectorBindingRegistered", {
        planId,
        selectorStageId,
        targetStageId: stageId
      }, planMetadataModuleAddress),
      chainEvent(3n, 2, "PlanFinalized", {
        planId,
        planHash,
        metadataHash
      }),
      chainEvent(3n, 3, "PlanRegistered", {
        planId,
        planHash,
        hookCount: 2n
      })
    ];

    const snapshot = rebuildOrderProjections(events);
    const planKey = stateMachineScopedKey(31337, contractAddress, planId);
    const plan = snapshot.stateMachinePlans[planKey];

    expect(snapshot.rebuildable).toBe(true);
    expect(plan).toMatchObject({
      planId,
      planHash,
      publisher,
      hookCount: "2",
      metadataHash
    });
    // 两阶段 provenance：桶在 PlanCommitted 建立，PlanRegistered 覆写注册时点。
    expect(plan?.committedAt).toMatchObject({ blockNumber: 2n, logIndex: 0 });
    expect(plan?.finalizedAt).toMatchObject({ blockNumber: 3n, logIndex: 2 });
    expect(plan?.registeredAt).toMatchObject({ blockNumber: 3n, logIndex: 3 });
    // finalize 交易内的模块事件已并入 plan 元数据。
    expect(plan?.signalCapabilities).toEqual([
      expect.objectContaining({ stageId, targetSourceId: sourceId, signalId })
    ]);
    expect(plan?.selectorBindings).toEqual([
      expect.objectContaining({ selectorStageId, targetStageId: stageId })
    ]);
  });

  it("recovers from a shallow reorg on a quiet chain whose stored events are far below the backtrack window", async () => {
    // 簇 E-2（0620 M-6）：安静链上浅 reorg——回溯窗口内没有任何已存事件
    // 锚点不代表 reorg 深于窗口，只代表这段链上本来就没有事件。回退到全库
    // 最新已存事件锚点核对 canonical 哈希，一致即正常继续，不误判要求人工
    // full rebuild。
    const tempDir = mkdtempSync(join(tmpdir(), "uvp-indexer-reorg-quiet-"));
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
      let finalizedBlock = 3n;
      // 安静链：所有高度都是 orig 哈希（没有新事件）。
      let canonicalBlocks = new Map<bigint, Hex>(
        [1n, 2n, 3n, 4n, 2500n, 2600n].map((block) => [block, blockHashHex(`orig-${block}`)])
      );
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

      // 安静推进到 2500：无新事件，cursor 走到 2501（哈希 orig-2500）。
      finalizedBlock = 2500n;
      await indexer.refreshFromCursorWithSummary();
      await expect(store.getCursor({ chainId: 31337, contractAddress: "0x0000000000000000000000000000000000000000" }))
        .resolves.toMatchObject({ nextBlock: 2501n, blockHash: blockHashHex("orig-2500") });

      // 浅 reorg：tip 块 2600 换哈希。fromBlock=2601 > 1000 窗口，已存事件
      //（块 1-3）全部在窗口下界之下——旧逻辑在此误判"reorg 深于窗口"要求
      // 人工 full rebuild；新逻辑回退到全库最新锚点（块 3）核对一致后继续。
      canonicalBlocks = new Map<bigint, Hex>([
        ...canonicalBlocks,
        [2600n, blockHashHex("fork-2600")]
      ]);
      finalizedBlock = 2600n;
      const result = await indexer.refreshFromCursorWithSummary();

      expect(result.summary).toMatchObject({ syncStatus: "indexed" });
      await expect(store.getCursor({ chainId: 31337, contractAddress: "0x0000000000000000000000000000000000000000" }))
        .resolves.toMatchObject({ nextBlock: 2601n, blockHash: blockHashHex("fork-2600") });
    } finally {
      await store.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("persists exhausted post-commit notification batches and redelivers them from the durable sweep", async () => {
    // 簇 E-4（0630 C-8/0632 CS-4/0653 M-10）：通知 post-commit 3 次进程内
    // 重试耗尽且 cursor 已越过——失败批次必须落持久 pending 表（0017）由
    // 后台 sweep 补投，不允许静默丢。
    const tempDir = mkdtempSync(join(tmpdir(), "uvp-indexer-pending-"));
    const store = new SqliteProjectionStore({
      databaseUrl: `sqlite://${join(tempDir, "projection.sqlite3")}`,
      chainId: 31337,
      migrations: {
        autoRun: true,
        directory: resolve(__dirname, "../migrations")
      }
    });
    try {
      let deliveryDown = true;
      const deliveredBatches: (readonly ChainEvent[])[] = [];
      const eventSource: ChainEventSource = {
        async getFinalizedBlock() {
          return 9n;
        },
        async readEvents(range) {
          return stateMachineEvents().filter((event) => event.blockNumber >= range.fromBlock && event.blockNumber <= range.toBlock);
        }
      };
      const indexer = new IndexerService({
        config: testConfig(),
        eventSource,
        store,
        notificationProcessor: {
          async processSignalSubmittedEvents(events) {
            if (deliveryDown) {
              throw new Error("notification delivery outage");
            }
            deliveredBatches.push(events);
          }
        }
      });

      // rebuild 本身成功（投影与 cursor 已落库）；通知失败 3 次后落 pending。
      const { summary } = await indexer.rebuildFromDeploymentBlockWithSummary();
      expect(summary.syncStatus).toBe("indexed");

      const pendingAfterFailure = await indexer.listPendingPostCommitSteps();
      expect(pendingAfterFailure.length).toBe(1);
      expect(pendingAfterFailure[0]).toMatchObject({
        kind: "signal_notification",
        chainId: 31337,
        attempts: 1
      });
      expect(pendingAfterFailure[0]?.events?.length).toBeGreaterThan(0);

      // sweep 在投递通道恢复后补投成功并出队。
      deliveryDown = false;
      const sweepSummary = await indexer.sweepPendingPostCommitSteps();
      expect(sweepSummary).toMatchObject({ swept: 1, delivered: 1, failed: 0 });
      expect(deliveredBatches.length).toBe(1);
      await expect(indexer.listPendingPostCommitSteps()).resolves.toEqual([]);

      // 通道仍故障时 sweep 不丢批次：attempts 累加、批次留存。
      deliveryDown = true;
      const indexer2 = new IndexerService({
        config: testConfig(),
        eventSource,
        store,
        notificationProcessor: {
          async processSignalSubmittedEvents() {
            throw new Error("notification delivery still down");
          }
        }
      });
      const { summary: secondSummary } = await indexer2.rebuildFromDeploymentBlockWithSummary();
      expect(secondSummary.syncStatus).toBe("indexed");
      const stillPending = await indexer2.listPendingPostCommitSteps();
      expect(stillPending.length).toBe(1);
      const failedSweep = await indexer2.sweepPendingPostCommitSteps();
      expect(failedSweep).toMatchObject({ swept: 1, delivered: 0, failed: 1 });
      const queuedAfterFailedSweep = await indexer2.listPendingPostCommitSteps();
      expect(queuedAfterFailedSweep.length).toBe(1);
      expect(queuedAfterFailedSweep[0]?.attempts).toBe(2);
    } finally {
      await store.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("reuses one stable pending row for repeated projection automation failures", async () => {
    // UVP-12/L-9/CS-P3：无事件批次的 pending 步骤 id 必须稳定——时间戳
    // id 会让 ON CONFLICT DO NOTHING 永不命中，每次失败新开一行无限堆积。
    const tempDir = mkdtempSync(join(tmpdir(), "uvp-indexer-automation-pending-"));
    const store = new SqliteProjectionStore({
      databaseUrl: `sqlite://${join(tempDir, "projection.sqlite3")}`,
      chainId: 31337,
      migrations: {
        autoRun: true,
        directory: resolve(__dirname, "../migrations")
      }
    });
    try {
      const eventSource: ChainEventSource = {
        async getFinalizedBlock() {
          return 9n;
        },
        async readEvents(range) {
          return stateMachineEvents().filter((event) => event.blockNumber >= range.fromBlock && event.blockNumber <= range.toBlock);
        }
      };
      const failingAutomation = {
        async processProjection(): Promise<unknown> {
          throw new Error("automation outage");
        }
      };
      const indexer = new IndexerService({
        config: testConfig(),
        eventSource,
        store,
        projectionAutomationProcessor: failingAutomation
      });
      await indexer.rebuildFromDeploymentBlockWithSummary();
      const first = await indexer.listPendingPostCommitSteps();
      expect(first.length).toBe(1);
      expect(first[0]).toMatchObject({ kind: "projection_automation", chainId: 31337, attempts: 1 });

      // 第二轮同类失败命中同一 stepId（幂等复用失败行），不新开行。
      const indexer2 = new IndexerService({
        config: testConfig(),
        eventSource,
        store,
        projectionAutomationProcessor: failingAutomation
      });
      await indexer2.rebuildFromDeploymentBlockWithSummary();
      const second = await indexer2.listPendingPostCommitSteps();
      expect(second.length).toBe(1);
      expect(second[0]?.stepId).toBe(first[0]?.stepId);
      expect(second[0]?.attempts).toBe(2);
    } finally {
      await store.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("creates notification delivery intents before advancing the durable cursor", async () => {
    // G-29/UVP-09：投递记录创建先于 cursor 推进——游标先落库的窗口内硬
    // 崩溃会让该批事件永不再被读取、投递记录无从重建。
    const tempDir = mkdtempSync(join(tmpdir(), "uvp-indexer-notify-order-"));
    const store = new SqliteProjectionStore({
      databaseUrl: `sqlite://${join(tempDir, "projection.sqlite3")}`,
      chainId: 31337,
      migrations: {
        autoRun: true,
        directory: resolve(__dirname, "../migrations")
      }
    });
    const scope = { chainId: 31337, contractAddress: "0x0000000000000000000000000000000000000000" as Hex };
    try {
      const events = stateMachineEvents();
      const lateSignal = chainEvent(10n, 0, "SignalSubmitted", {
        orderId: stateMachineOrderId,
        sourceId: bytes32Hex("0606"),
        signalId: bytes32Hex("0707"),
        payloadHash,
        idempotencyKey: bytes32Hex("0bbb"),
        submitter: signer
      });
      let finalizedBlock = 9n;
      const eventSource: ChainEventSource = {
        async getFinalizedBlock() {
          return finalizedBlock;
        },
        async readEvents(range) {
          return [...events, lateSignal].filter((event) => event.blockNumber >= range.fromBlock && event.blockNumber <= range.toBlock);
        }
      };
      const cursorNextBlockAtNotification: (bigint | undefined)[] = [];
      const indexer = new IndexerService({
        config: testConfig(),
        eventSource,
        store,
        notificationProcessor: {
          async processSignalSubmittedEvents(batch) {
            if (batch.length > 0) {
              cursorNextBlockAtNotification.push((await store.getCursor(scope))?.nextBlock);
            }
          }
        }
      });
      // 首轮 rebuild：通知处理时 cursor 尚未保存（undefined）。
      await indexer.rebuildFromDeploymentBlockWithSummary();
      expect(cursorNextBlockAtNotification).toEqual([undefined]);
      await expect(store.getCursor(scope)).resolves.toMatchObject({ nextBlock: 10n });

      // 增量刷新携带新 SignalSubmitted：通知处理时游标仍停在旧位置 10n，
      // 处理完成后才推进到 12n。
      finalizedBlock = 11n;
      await indexer.refreshFromCursorWithSummary();
      expect(cursorNextBlockAtNotification[1]).toBe(10n);
      await expect(store.getCursor(scope)).resolves.toMatchObject({ nextBlock: 12n });
    } finally {
      await store.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rolls back to an older consistent anchor when the newest below-window anchor was reorged", async () => {
    // 0200#15：最新已存锚点恰好被 reorg 触及、更旧锚点仍与 canonical 一致
    // 时是浅 reorg——回验更旧锚点继续,不得误判要求 full rebuild。
    const tempDir = mkdtempSync(join(tmpdir(), "uvp-indexer-reorg-older-anchor-"));
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
      let finalizedBlock = 3n;
      let canonicalBlocks = new Map<bigint, Hex>(
        [1n, 2n, 3n, 4n, 2500n, 2600n].map((block) => [block, blockHashHex(`orig-${block}`)])
      );
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

      finalizedBlock = 2500n;
      await indexer.refreshFromCursorWithSummary();

      // reorg 同时触及块 3（最新锚点）与 tip：块 2 仍一致 → 回滚到块 2。
      canonicalBlocks = new Map<bigint, Hex>([
        ...canonicalBlocks,
        [3n, blockHashHex("fork-3")],
        [2600n, blockHashHex("fork-2600")]
      ]);
      finalizedBlock = 2600n;
      const result = await indexer.refreshFromCursorWithSummary();

      expect(result.summary.syncStatus).toBe("indexed");
      await expect(store.getCursor({ chainId: 31337, contractAddress: "0x0000000000000000000000000000000000000000" }))
        .resolves.toMatchObject({ nextBlock: 2601n, blockHash: blockHashHex("fork-2600") });
    } finally {
      await store.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("moves a task off ready when an out-of-vocabulary explicit authorization submits on chain", () => {
    // 簇 N（0653 M-8）：合约 _authorizeSignalSubmitter 不校验 plan 能力词表
    // ——显式授权可以落在词表之外。SignalSubmitted 落链后任务匹配必须以
    // 链上事实为准（StageExecutorSignalDelegated 的 targetStageId 阶段归属
    // + hookId===sourceId/signalId 绑定键），否则任务永远停在 ready，与链
    // 不一致。
    const outOfVocabSourceId = bytes32Hex("8101");
    const outOfVocabSignalId = bytes32Hex("8102");
    const delegatedExecutor = "0x5555555555555555555555555555555555555555";
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
      chainEvent(3n, 0, "HookReady", {
        orderId: stateMachineOrderId,
        hookId,
        stageId,
        hookName
      }),
      // 词表外显式授权（plan 词表为空——"超能力"声明）。
      chainEvent(4n, 0, "SignalSubmitterAuthorized", {
        planId,
        orderId: stateMachineOrderId,
        sourceId: outOfVocabSourceId,
        signalId: outOfVocabSignalId,
        submitter: delegatedExecutor,
        role: bytes32Text("delegated-executor"),
        metadataHash: emptyHash
      }),
      // 链上事实：词表外信号已提交。
      chainEvent(5n, 0, "SignalSubmitted", {
        planId,
        orderId: stateMachineOrderId,
        sourceId: outOfVocabSourceId,
        signalId: outOfVocabSignalId,
        payloadHash,
        idempotencyKey,
        submitter: delegatedExecutor
      }),
      // 显式阶段归属：把 (sourceId, signalId) 委派到目标阶段。
      chainEvent(6n, 0, "StageExecutorSignalDelegated", {
        planId,
        orderId: stateMachineOrderId,
        targetStageId: stageId,
        sourceId: outOfVocabSourceId,
        signalId: outOfVocabSignalId,
        executor: delegatedExecutor,
        role: bytes32Text("delegated-executor"),
        metadataHash: emptyHash,
        patchNonce: 1n
      })
    ];

    const snapshot = rebuildOrderProjections(events);
    const order = snapshot.stateMachineOrders[stateMachineScopedKey(31337, contractAddress, planId, stateMachineOrderId)];
    const taskId = `${contractAddress}:${stateMachineOrderId}:${hookId}`;
    const task = order?.tasks[taskId];

    // 任务不再停在 ready：委派阶段归属让已提交的链上事实推进任务。
    expect(task).toMatchObject({
      stageIdentifier: stageId,
      status: "submitted",
      assigneeWallet: delegatedExecutor
    });
    expect(task?.submitSignals).toEqual([
      { sourceId: outOfVocabSourceId, signalId: outOfVocabSignalId, source: "authorization" }
    ]);
  });

  it("resolves state-machine orders by the (planId, orderId) composite key and fails closed on bare-id ambiguity", async () => {
    // 簇 E-3/簇 N（0630 M-5/0632 CS-7）：订单身份是 (planId, orderId)。裸
    // orderId 多命中必须 fail-closed 返回 undefined（绝不取第一个），带
    // planId 的复合键查询必须命中正确的 plan。
    const otherPlanId = bytes32Hex("8101");
    const store = new MemoryProjectionStore();
    await store.resetFromEvents({
      deploymentBlock: 0n,
      events: [
        ...stateMachineEvents(undefined, stateMachineOrderId).map((event) => ({
          ...event,
          args: { ...event.args, planId }
        })),
        ...stateMachineEvents(undefined, stateMachineOrderId, 20n).map((event) => ({
          ...event,
          args: { ...event.args, planId: otherPlanId }
        }))
      ]
    });

    await expect(store.getStateMachineOrder(stateMachineOrderId, otherPlanId))
      .resolves.toMatchObject({ orderId: stateMachineOrderId, planId: otherPlanId });
    await expect(store.getStateMachineOrder(stateMachineOrderId, planId))
      .resolves.toMatchObject({ orderId: stateMachineOrderId, planId });
    // 裸 orderId 同号跨 plan 复用：歧义即拒（undefined），不猜第一个。
    await expect(store.getStateMachineOrder(stateMachineOrderId)).resolves.toBeUndefined();
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
      redeliveryWindowMs: 120_000
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
