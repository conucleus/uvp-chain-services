import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { capabilitiesRootOf } from "@uvp-eth/compiler";
import { createApiRouter } from "../src/api/routes.js";
import type { ChainServicesConfig } from "../src/config/index.js";
import { IndexerService, type ChainEventSource } from "../src/indexer/service.js";
import { rebuildOrderProjections } from "../src/indexer/replay.js";
import type { PlanCapabilityTablesInput } from "../src/indexer/projections/plan.js";
import { stateMachineScopedKey, stateMachineTaskProjectionKey } from "../src/indexer/projections/index.js";
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
    // 授权 (sourceId=stageId, signalId=hookName) 通过词表事实键挂到任务：
    // 词表两表经产物富集进入 plan 投影。
    const vocabulary = planVocabulary({
      signalCapabilities: [{ stageId, targetSourceId: stageId, signalId: hookName, targetOrderRelation: 0 }]
    });
    const events: readonly ChainEvent[] = [
      ...planPublishEvents(vocabulary),
      chainEvent(3n, 0, "OrderRegistered", {
        orderId: stateMachineOrderId,
        planId
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
    const first = await store.resetFromEvents({ deploymentBlock: 0n, events, planCapabilityTables: [vocabulary] });
    await store.resetFromEvents({ deploymentBlock: 0n, events: [] });
    const rebuilt = await store.resetFromEvents({ deploymentBlock: 0n, events, planCapabilityTables: [vocabulary] });
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
    // 词表 Merkle 化：两表不再来自链上注册事件，而是 planId 锚定的编译
    // 产物富集（applyPlanFinalized 时填进投影并断言 capabilitiesRoot）。
    const vocabulary = planVocabulary({
      signalCapabilities: [{ stageId, targetSourceId: sourceId, signalId, targetOrderRelation: 0 }]
    });
    const events: readonly ChainEvent[] = [
      ...planPublishEvents(vocabulary),
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

    const snapshot = rebuildOrderProjections(events, { planCapabilityTables: [vocabulary] });
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
    const vocabulary = planVocabulary({
      signalCapabilities: [{ stageId, targetSourceId: sourceId, signalId, targetOrderRelation: 0 }]
    });
    const events: readonly ChainEvent[] = [
      ...planPublishEvents(vocabulary),
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

    const snapshot = rebuildOrderProjections(events, { planCapabilityTables: [vocabulary] });
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
    // 任务 submitted 是首个完成事实——后到的匹配信号不得覆盖
    // 任务的完成证明与 updatedAt（与创建路径取最早证明同口径）。
    const vocabulary = planVocabulary({
      signalCapabilities: [{ stageId, targetSourceId: sourceId, signalId, targetOrderRelation: 0 }]
    });
    const base: readonly ChainEvent[] = [
      ...planPublishEvents(vocabulary),
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
    ], { planCapabilityTables: [vocabulary] });
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
    const vocabulary = planVocabulary({
      signalCapabilities: [{ stageId, targetSourceId: sourceId, signalId, targetOrderRelation: 0 }]
    });
    const events: readonly ChainEvent[] = [
      ...planPublishEvents(vocabulary),
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

    const snapshot = rebuildOrderProjections(events, { planCapabilityTables: [vocabulary] });
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
      // 墓碑被复活抵消：活跃集没有实际丢失，removedLogsFiltered 如实为
      // false（removedEventCount 仍记录见过的墓碑数）。
      removedLogsFiltered: false
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

  it("keeps a cancelled task cancelled when a loose fallback-key signal arrives afterwards", () => {
    // HookStatusChanged(cancelled) 是链上终态；taskMatchesSubmittedSignal 的
    // 宽松回退键（hookId === sourceId/signalId）命中的无关信号不得把已
    // 撤销任务复活成 submitted。
    const snapshot = rebuildOrderProjections([
      chainEvent(1n, 0, "PlanRegistered", { planId, planHash, hookCount: 1n }),
      chainEvent(2n, 0, "OrderRegistered", { orderId: stateMachineOrderId, planId }),
      chainEvent(3n, 0, "HookReady", { orderId: stateMachineOrderId, hookId, stageId, hookName }),
      chainEvent(4n, 0, "HookStatusChanged", {
        orderId: stateMachineOrderId,
        hookId,
        previousStatus: 2,
        newStatus: 3,
        dueAt: 0n
      }),
      chainEvent(5n, 0, "SignalSubmitted", {
        orderId: stateMachineOrderId,
        planId,
        sourceId: hookId,
        signalId,
        payloadHash,
        idempotencyKey,
        submitter: signer
      })
    ]);

    const order = snapshot.stateMachineOrders[stateMachineScopedKey(31337, contractAddress, planId, stateMachineOrderId)];
    const taskKey = `${contractAddress}:${stateMachineOrderId}:${hookId}`;
    expect(order?.hooks[hookId]?.status).toBe("cancelled");
    expect(order?.tasks[taskKey]?.status).toBe("cancelled");
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
    const router = createApiRouter(store, { submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111", productRuntimeEnvironment: "local" as const });
    // 订单读有身份门（匿名 401 先于歧义判定）；歧义判定对已认证参与者仍 409。
    const response = await router.handle({
      method: "GET",
      pathname: `/product/orders/${stateMachineOrderId}`,
      headers: { "x-uvp-wallet-address": "0x3333333333333333333333333333333333333333" }
    });

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
    // 幻影订单：7 类订单维度事件由模块合约发出（event.contractAddress =
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
        interfaceNameId: bytes32Text("production_service"),
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
      interfaceNameId: bytes32Text("production_service")
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

  it("projects DockAttached births under the N:1 target-order index with multiple parents", () => {
    // existing 模式挂接：多个父单可挂同一既有目标单（链上 dockByTargetOrder
    // 是 new 模式子单出生键——单值、existing 不写——目标侧"谁挂了我"只能由
    // DockAttached 事件按 (targetPlanId, linkedOrderId) 复合键聚合成集合）。
    const moduleAddress = "0x6666666666666666666666666666666666666666";
    const parentOrderIdA = bytes32Hex("901");
    const parentOrderIdB = bytes32Hex("902");
    const dockInstanceA = bytes32Hex("911");
    const dockInstanceB = bytes32Hex("912");
    const linkedOrderId = bytes32Hex("903");
    const targetPlan = bytes32Hex("904");
    const dockKeyA = stateMachineScopedKey(31337, contractAddress, dockInstanceA);
    const dockKeyB = stateMachineScopedKey(31337, contractAddress, dockInstanceB);
    const targetOrderKey = stateMachineScopedKey(31337, contractAddress, targetPlan, linkedOrderId);
    const events: readonly ChainEvent[] = [
      chainEvent(1n, 0, "PlanRegistered", { planId, planHash, hookCount: 1n }),
      chainEvent(2n, 0, "PlanRegistered", { planId: targetPlan, planHash: bytes32Hex("905"), hookCount: 1n }),
      chainEvent(3n, 0, "OrderRegistered", { orderId: parentOrderIdA, planId }),
      chainEvent(4n, 0, "OrderRegistered", { orderId: parentOrderIdB, planId }),
      chainEvent(5n, 0, "OrderRegistered", { orderId: linkedOrderId, planId: targetPlan }),
      chainEvent(6n, 0, "StateMachineModuleSet", {
        moduleId: bytes32Text("uvp.module.docking.v1"),
        previousModule: "0x0000000000000000000000000000000000000000",
        newModule: moduleAddress
      }),
      chainEvent(7n, 0, "DockAttached", {
        dockInstanceId: dockInstanceA,
        localOrderId: parentOrderIdA,
        linkedOrderId,
        interfaceNameId: bytes32Text("production_service"),
        localPlanId: planId,
        targetPlanId: targetPlan,
        routeId: bytes32Hex("906"),
        routeHash: planHash,
        depth: 1n,
        attacher: signer
      }, moduleAddress),
      chainEvent(8n, 0, "DockAttached", {
        dockInstanceId: dockInstanceB,
        localOrderId: parentOrderIdB,
        linkedOrderId,
        interfaceNameId: bytes32Text("production_service"),
        localPlanId: planId,
        targetPlanId: targetPlan,
        routeId: bytes32Hex("908"),
        routeHash: planHash,
        depth: 2n,
        attacher: overlayExecutor
      }, moduleAddress),
      chainEvent(9n, 0, "DockOutputSubmitted", {
        dockInstanceId: dockInstanceA,
        linkedOrderId,
        outputBindingHash: bytes32Hex("907"),
        localPlanId: planId,
        localOrderId: parentOrderIdA,
        targetPlanId: targetPlan,
        targetSignalId: signalId,
        localSignalId: signalId,
        payloadHash,
        submitter: signer
      }, moduleAddress)
    ];

    const snapshot = rebuildOrderProjections(events);

    expect(snapshot.stateMachineDocks[dockKeyA]).toMatchObject({
      mode: "existing",
      attacher: signer,
      depth: 1,
      localOrderId: parentOrderIdA,
      targetPlanId: targetPlan,
      linkedOrderId,
      stateMachineAddress: contractAddress
    });
    expect(snapshot.stateMachineDocks[dockKeyB]).toMatchObject({
      mode: "existing",
      attacher: overlayExecutor,
      depth: 2
    });
    // N:1 聚合：两父同键成集合；索引键与目标单订单桶同形。
    expect(snapshot.stateMachineDocksByTargetOrder[targetOrderKey]).toEqual([dockKeyA, dockKeyB]);
    expect(snapshot.stateMachineOrders[targetOrderKey]).toBeDefined();
    // 挂接后的交付事件照常落入 dock 台账（dockInstanceId 唯一定位）。
    expect(Object.keys(snapshot.stateMachineDocks[dockKeyA]?.outputDeliveries ?? {})).toEqual([
      bytes32Hex("907")
    ]);
    // 目标单时间线同时承载两次挂接（谁挂了我）。
    expect(
      snapshot.stateMachineOrders[targetOrderKey]?.timeline.filter((item) => item.eventName === "DockAttached")
    ).toHaveLength(2);
    expect(snapshot.unresolvedDockEventCount).toBe(0);
    expect(snapshot.unresolvedDockTargetDeploymentCount).toBe(0);
  });

  it("indexes new-mode dock births under their own target-order key alongside attached docks", () => {
    // 索引对两种出生事件统一：new 模式的子单由 dock 创建，其目标键下聚合
    // 恰一条；与 existing 的 N:1 共用同一复合键形态。
    const moduleAddress = "0x6666666666666666666666666666666666666666";
    const dockInstanceId = bytes32Hex("921");
    const childOrderId = bytes32Hex("923");
    const childPlan = bytes32Hex("924");
    const childOrderKey = stateMachineScopedKey(31337, contractAddress, childPlan, childOrderId);
    const events: readonly ChainEvent[] = [
      chainEvent(1n, 0, "PlanRegistered", { planId, planHash, hookCount: 1n }),
      chainEvent(2n, 0, "PlanRegistered", { planId: childPlan, planHash: bytes32Hex("925"), hookCount: 1n }),
      chainEvent(3n, 0, "OrderRegistered", { orderId: stateMachineOrderId, planId }),
      chainEvent(4n, 0, "StateMachineModuleSet", {
        moduleId: bytes32Text("uvp.module.docking.v1"),
        previousModule: "0x0000000000000000000000000000000000000000",
        newModule: moduleAddress
      }),
      chainEvent(5n, 0, "DockOpened", {
        dockInstanceId,
        localOrderId: stateMachineOrderId,
        linkedOrderId: childOrderId,
        interfaceNameId: bytes32Text("production_service"),
        localPlanId: planId,
        targetPlanId: childPlan,
        routeId: bytes32Hex("926"),
        routeHash: planHash,
        depth: 1n,
        opener: signer
      }, moduleAddress)
    ];

    const snapshot = rebuildOrderProjections(events);

    const dockKey = stateMachineScopedKey(31337, contractAddress, dockInstanceId);
    expect(snapshot.stateMachineDocks[dockKey]).toMatchObject({ mode: "new", opener: signer });
    expect(snapshot.stateMachineDocksByTargetOrder[childOrderKey]).toEqual([dockKey]);
  });

  it("drops an attached dock and its target-order index entry when the birth log is reorged away", () => {
    const moduleAddress = "0x6666666666666666666666666666666666666666";
    const dockInstanceId = bytes32Hex("931");
    const linkedOrderId = bytes32Hex("933");
    const targetPlan = bytes32Hex("934");
    const attach = chainEvent(6n, 0, "DockAttached", {
      dockInstanceId,
      localOrderId: stateMachineOrderId,
      linkedOrderId,
      interfaceNameId: bytes32Text("production_service"),
      localPlanId: planId,
      targetPlanId: targetPlan,
      routeId: bytes32Hex("936"),
      routeHash: planHash,
      depth: 1n,
      attacher: signer
    }, moduleAddress);
    const base: readonly ChainEvent[] = [
      chainEvent(1n, 0, "PlanRegistered", { planId: targetPlan, planHash: bytes32Hex("935"), hookCount: 1n }),
      chainEvent(2n, 0, "PlanRegistered", { planId, planHash, hookCount: 1n }),
      chainEvent(3n, 0, "OrderRegistered", { orderId: stateMachineOrderId, planId }),
      chainEvent(4n, 0, "OrderRegistered", { orderId: linkedOrderId, planId: targetPlan }),
      chainEvent(5n, 0, "StateMachineModuleSet", {
        moduleId: bytes32Text("uvp.module.docking.v1"),
        previousModule: "0x0000000000000000000000000000000000000000",
        newModule: moduleAddress
      })
    ];

    const withAttach = rebuildOrderProjections([...base, attach]);
    const dockKey = stateMachineScopedKey(31337, contractAddress, dockInstanceId);
    const targetOrderKey = stateMachineScopedKey(31337, contractAddress, targetPlan, linkedOrderId);
    expect(withAttach.stateMachineDocks[dockKey]).toBeDefined();
    expect(withAttach.stateMachineDocksByTargetOrder[targetOrderKey]).toEqual([dockKey]);

    // reorg 墓碑：出生事件被逐出活跃集后，dock 桶与目标侧索引条目同时消失
    //——索引是重放产物而非独立事实源，不残留孤儿键。
    const rolled = rebuildOrderProjections([...base, attach, { ...attach, removed: true }]);
    expect(rolled.stateMachineDocks[dockKey]).toBeUndefined();
    expect(rolled.stateMachineDocksByTargetOrder[targetOrderKey]).toBeUndefined();
    expect(rolled.eventCount).toBe(base.length);
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

  it("counts genuinely unknown events instead of silently skipping them", () => {
    // 新合约事件上线而投影未跟进：default 分支不得静默穿过——真未知事件
    // 计入 unknownEventCount。已收口家族不计入：零投影分支
    // （OwnershipTransferred/StateMachineModulesFrozen）与其他重放遍处理的
    // 部署注册表族/身份注册表族。
    const events: readonly ChainEvent[] = [
      chainEvent(1n, 0, "PlanRegistered", { planId, planHash, hookCount: 1n }),
      chainEvent(2n, 0, "OwnershipTransferred", {
        previousOwner: "0x0000000000000000000000000000000000000000",
        newOwner: signer
      }),
      chainEvent(3n, 0, "StateMachineModulesFrozen", { moduleSetHash: patchHash }),
      chainEvent(4n, 0, "DeploymentDeprecated", {
        deploymentId: deploymentIdV1,
        reasonHash: patchHash,
        reasonURI: "ipfs://deployment-reason"
      }),
      chainEvent(5n, 0, "IdentityBindingRevoked", {
        bindingId: bytes32Hex("7001"),
        reasonHash: patchHash,
        reasonURI: "",
        revoker: signer
      }),
      chainEvent(6n, 0, "SomeFutureEvent", { planId })
    ];

    const snapshot = rebuildOrderProjections(events);

    expect(snapshot.unknownEventCount).toBe(1);
    expect(snapshot.eventCount).toBe(6);
    // 零投影分支不产生订单/模块投影（PlanRegistered 只建 plan 桶）。
    expect(Object.keys(snapshot.stateMachineOrders)).toEqual([]);
    expect(Object.keys(snapshot.stateMachineModules)).toEqual([]);
  });

  it("projects the OrderLinked originPlanId onto the child order trigger link", () => {
    // OrderLinked 携带 originPlanId（触发源单的 plan 维度）：triggerLink
    // 投影不得丢弃该字段——跨 plan 链接触发时，源单定位必须带 plan 维度，
    // 裸 triggerOriginOrderId 在同号订单跨 plan 复用时定位不了源单。
    const orderLinkModuleAddress = "0x6666666666666666666666666666666666666666";
    const originPlanId = bytes32Hex("707");
    const originOrderId = bytes32Hex("808");
    const triggeredOrderId = bytes32Hex("909");
    const events: readonly ChainEvent[] = [
      chainEvent(1n, 0, "StateMachineModuleSet", {
        moduleId: bytes32Text("uvp.module.order-link.v1"),
        previousModule: "0x0000000000000000000000000000000000000000",
        newModule: orderLinkModuleAddress
      }),
      chainEvent(2n, 0, "OrderLinked", {
        triggeredOrderId,
        triggerOriginOrderId: originOrderId,
        triggerStageId: stageId,
        planId,
        originPlanId,
        originSourceId: sourceId,
        originSignalId: signalId
      }, orderLinkModuleAddress)
    ];

    const snapshot = rebuildOrderProjections(events);
    const childOrder = snapshot.stateMachineOrders[
      stateMachineScopedKey(31337, contractAddress, planId, triggeredOrderId)
    ];

    expect(childOrder?.triggerLink).toMatchObject({
      triggeredOrderId,
      triggerOriginOrderId: originOrderId,
      triggerStageId: stageId,
      originPlanId,
      originSourceId: sourceId,
      originSignalId: signalId
    });
    // 模块已登记：归一化命中，无未归因诊断。
    expect(snapshot.unresolvedModuleOrderEventCount).toBe(0);
  });

  it("enriches the same planId on every deployment from the artifact vocabulary (content-scoped, not address-scoped)", () => {
    // 词表两表按 planId 从编译产物富集：planId 由 planHash 派生
    // （同 planId = 同 plan 内容），跨部署复用同 planId 时每个部署的 plan 桶
    // 都富集到同一份词表——词表维度按 plan 内容（而非 emitting 地址）区分。
    const vocabulary = planVocabulary({
      signalCapabilities: [{ stageId, targetSourceId: sourceId, signalId, targetOrderRelation: 0 }]
    });
    const events: readonly ChainEvent[] = [
      ...planPublishEvents(vocabulary, contractAddress),
      ...planPublishEvents(vocabulary, contractAddressV2)
    ];

    const snapshot = rebuildOrderProjections(events, { planCapabilityTables: [vocabulary] });

    const planV2 = snapshot.stateMachinePlans[stateMachineScopedKey(31337, contractAddressV2, planId)];
    expect(planV2?.signalCapabilities).toHaveLength(1);
    expect(planV2?.signalCapabilities[0]).toMatchObject({ stageId, signalId });
    const planV1 = snapshot.stateMachinePlans[stateMachineScopedKey(31337, contractAddress, planId)];
    expect(planV1?.signalCapabilities).toHaveLength(1);
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

  it("keeps enriched plan capability tables across a restart and an incremental refresh without new plan events", async () => {
    // 回归：增量轮的富集锚点若只收本轮新读事件，重启后（进程内缓存为空）
    // 一轮无新 plan 事件的增量刷新会让全历史重放拿到空富集源，已富集
    // plan 的两表被静默清空并随快照持久化。锚点必须与重放集同源。
    const tempDir = mkdtempSync(join(tmpdir(), "uvp-indexer-enrichment-restart-"));
    const store = new SqliteProjectionStore({
      databaseUrl: `sqlite://${join(tempDir, "projection.sqlite3")}`,
      chainId: 31337,
      migrations: {
        autoRun: true,
        directory: resolve(__dirname, "../migrations")
      }
    });
    try {
      const vocabulary = planVocabulary({
        selectorBindings: [{ selectorStageId, targetStageId: stageId }],
        signalCapabilities: [{ stageId, targetSourceId: sourceId, signalId, targetOrderRelation: 0 }]
      });
      const planEvents = planPublishEvents(vocabulary);
      const orderEvent = chainEvent(3n, 0, "OrderRegistered", {
        orderId: stateMachineOrderId,
        planId
      });
      let finalizedBlock = 3n;
      const eventSource: ChainEventSource = {
        async getFinalizedBlock() {
          return finalizedBlock;
        },
        async readEvents(range) {
          return [...planEvents, orderEvent].filter(
            (event) => event.blockNumber >= range.fromBlock && event.blockNumber <= range.toBlock
          );
        }
      };
      const resolver = async (anchorPlanId: Hex, anchorPlanHash: Hex): Promise<PlanCapabilityTablesInput | undefined> =>
        anchorPlanId.toLowerCase() === planId.toLowerCase() && anchorPlanHash.toLowerCase() === planHash.toLowerCase()
          ? vocabulary
          : undefined;

      const firstIndexer = new IndexerService({
        config: testConfig(),
        eventSource,
        store,
        resolvePlanCapabilityTables: resolver
      });
      const rebuilt = await firstIndexer.rebuildFromDeploymentBlockWithSummary();
      const planKey = stateMachineScopedKey(31337, contractAddress, planId);
      const enrichedPlan = rebuilt.snapshot.stateMachinePlans[planKey];
      expect(enrichedPlan?.selectorBindings).toHaveLength(1);
      expect(enrichedPlan?.signalCapabilities).toHaveLength(1);

      // 重启：新实例（富集缓存为空）+ 本轮无新 plan 事件（只有新订单事件）。
      finalizedBlock = 4n;
      const laterOrderEvent = chainEvent(4n, 0, "OrderRegistered", {
        orderId: "0x0000000000000000000000000000000000000000000000000000000000000304",
        planId
      });
      eventSource.readEvents = async (range) => [laterOrderEvent].filter(
        (event) => event.blockNumber >= range.fromBlock && event.blockNumber <= range.toBlock
      );
      const restartedIndexer = new IndexerService({
        config: testConfig(),
        eventSource,
        store,
        resolvePlanCapabilityTables: resolver
      });
      const refreshed = await restartedIndexer.refreshFromCursorWithSummary();

      const refreshedPlan = refreshed.snapshot.stateMachinePlans[planKey];
      expect(refreshedPlan?.selectorBindings).toHaveLength(1);
      expect(refreshedPlan?.signalCapabilities).toHaveLength(1);
      const persisted = await store.getOrderSnapshot();
      expect(persisted.stateMachinePlans[planKey]?.selectorBindings).toHaveLength(1);
      expect(persisted.stateMachinePlans[planKey]?.signalCapabilities).toHaveLength(1);
      expect(refreshed.snapshot.capabilityEnrichmentMismatchCount ?? 0).toBe(0);
    } finally {
      await store.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("persists the failed enrichment marker on resolver-failure rounds and recovers once the resolver is healthy", async () => {
    // 回归（解析故障 ≠ 无词表）：resolver 故障轮的快照必须带 failed
    // 富集态持久化——否则提交/触发车道无法与"外部发布 plan 的合法空词表"
    // 区分，全零造证会把必拒的 InvalidSignalCapability 留到链上 revert。
    // 故障不进富集缓存，恢复后的下一轮增量重放自动回到 enriched。
    const tempDir = mkdtempSync(join(tmpdir(), "uvp-indexer-enrichment-failed-"));
    const store = new SqliteProjectionStore({
      databaseUrl: `sqlite://${join(tempDir, "projection.sqlite3")}`,
      chainId: 31337,
      migrations: {
        autoRun: true,
        directory: resolve(__dirname, "../migrations")
      }
    });
    try {
      const vocabulary = planVocabulary({
        selectorBindings: [{ selectorStageId, targetStageId: stageId }],
        signalCapabilities: [{ stageId, targetSourceId: sourceId, signalId, targetOrderRelation: 0 }]
      });
      const planEvents = planPublishEvents(vocabulary);
      const orderEvent = chainEvent(3n, 0, "OrderRegistered", {
        orderId: stateMachineOrderId,
        planId
      });
      let finalizedBlock = 3n;
      const eventSource: ChainEventSource = {
        async getFinalizedBlock() {
          return finalizedBlock;
        },
        async readEvents(range) {
          return [...planEvents, orderEvent].filter(
            (event) => event.blockNumber >= range.fromBlock && event.blockNumber <= range.toBlock
          );
        }
      };
      const healthyResolver = async (anchorPlanId: Hex, anchorPlanHash: Hex): Promise<PlanCapabilityTablesInput | undefined> =>
        anchorPlanId.toLowerCase() === planId.toLowerCase() && anchorPlanHash.toLowerCase() === planHash.toLowerCase()
          ? vocabulary
          : undefined;

      const failingIndexer = new IndexerService({
        config: testConfig(),
        eventSource,
        store,
        resolvePlanCapabilityTables: async () => {
          throw new Error("draft store unreadable");
        }
      });
      const failed = await failingIndexer.rebuildFromDeploymentBlockWithSummary();
      const planKey = stateMachineScopedKey(31337, contractAddress, planId);
      expect(failed.snapshot.stateMachinePlans[planKey]?.capabilityEnrichment).toBe("failed");
      expect(failed.snapshot.stateMachinePlans[planKey]?.signalCapabilities).toHaveLength(0);
      const persisted = await store.getOrderSnapshot();
      expect(persisted.stateMachinePlans[planKey]?.capabilityEnrichment).toBe("failed");
      expect(persisted.stateMachinePlans[planKey]?.signalCapabilities).toHaveLength(0);

      // 恢复：重启（富集缓存为空）+ resolver 正常，一轮增量刷新后同一
      // plan 自动回到 enriched 可用态。
      finalizedBlock = 4n;
      const laterOrderEvent = chainEvent(4n, 0, "OrderRegistered", {
        orderId: "0x0000000000000000000000000000000000000000000000000000000000000305",
        planId
      });
      eventSource.readEvents = async (range) => [laterOrderEvent].filter(
        (event) => event.blockNumber >= range.fromBlock && event.blockNumber <= range.toBlock
      );
      const recoveredIndexer = new IndexerService({
        config: testConfig(),
        eventSource,
        store,
        resolvePlanCapabilityTables: healthyResolver
      });
      const refreshed = await recoveredIndexer.refreshFromCursorWithSummary();

      expect(refreshed.snapshot.stateMachinePlans[planKey]?.capabilityEnrichment).toBe("enriched");
      expect(refreshed.snapshot.stateMachinePlans[planKey]?.signalCapabilities).toHaveLength(1);
      const recovered = await store.getOrderSnapshot();
      expect(recovered.stateMachinePlans[planKey]?.capabilityEnrichment).toBe("enriched");
      expect(recovered.stateMachinePlans[planKey]?.selectorBindings).toHaveLength(1);
    } finally {
      await store.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("re-enriches the plan vocabulary from surviving events when a restarted indexer rolls back after a reorg", async () => {
    // 回归：回滚路径的词表富集若只靠进程内缓存，重启后（缓存为空）回滚
    // 事务会持久化无词表快照；随后 finalized 落后于回退游标时本轮不再
    // 重放事件，无词表快照成为最终状态。锚点必须与主刷新同口径，从
    // 回滚后仍将重放的事件集收集。
    const tempDir = mkdtempSync(join(tmpdir(), "uvp-indexer-enrichment-reorg-"));
    const store = new SqliteProjectionStore({
      databaseUrl: `sqlite://${join(tempDir, "projection.sqlite3")}`,
      chainId: 31337,
      migrations: {
        autoRun: true,
        directory: resolve(__dirname, "../migrations")
      }
    });
    try {
      const vocabulary = planVocabulary({
        selectorBindings: [{ selectorStageId, targetStageId: stageId }],
        signalCapabilities: [{ stageId, targetSourceId: sourceId, signalId, targetOrderRelation: 0 }]
      });
      const planEvents = planPublishEvents(vocabulary).map((event) => ({
        ...event,
        blockHash: blockHashHex(`stable-${event.blockNumber}`)
      }));
      const staleBlock3Event = {
        ...chainEvent(3n, 0, "OrderRegistered", {
          orderId: stateMachineOrderId,
          planId
        }),
        blockHash: blockHashHex("block-3-stale")
      };
      let canonicalBlocks = new Map<bigint, Hex>([
        [1n, blockHashHex("stable-1")],
        [2n, blockHashHex("stable-2")],
        [3n, blockHashHex("block-3-stale")]
      ]);
      let finalizedBlock = 3n;
      const eventSource: ChainEventSource = {
        async getFinalizedBlock() {
          return finalizedBlock;
        },
        async readEvents(range) {
          return [...planEvents, staleBlock3Event].filter(
            (event) => event.blockNumber >= range.fromBlock && event.blockNumber <= range.toBlock
          );
        },
        async getBlockHash(blockNumber) {
          return canonicalBlocks.get(blockNumber) ?? zeroBlockHash();
        }
      };
      let resolverCalls = 0;
      const resolver = async (anchorPlanId: Hex, anchorPlanHash: Hex): Promise<PlanCapabilityTablesInput | undefined> => {
        resolverCalls += 1;
        return anchorPlanId.toLowerCase() === planId.toLowerCase() && anchorPlanHash.toLowerCase() === planHash.toLowerCase()
          ? vocabulary
          : undefined;
      };

      const firstIndexer = new IndexerService({
        config: testConfig(),
        eventSource,
        store,
        resolvePlanCapabilityTables: resolver
      });
      const rebuilt = await firstIndexer.rebuildFromDeploymentBlockWithSummary();
      const planKey = stateMachineScopedKey(31337, contractAddress, planId);
      expect(rebuilt.snapshot.stateMachinePlans[planKey]?.selectorBindings).toHaveLength(1);

      // 重启（富集缓存为空）+ reorg：block 3 被分叉替换，finalized 读数
      // 回落到 2——回滚到 block 2 后本轮无新事件可读，回滚事务写出的快照
      // 就是最终持久状态。
      resolverCalls = 0;
      canonicalBlocks = new Map<bigint, Hex>([
        [1n, blockHashHex("stable-1")],
        [2n, blockHashHex("stable-2")],
        [3n, blockHashHex("block-3-fork")]
      ]);
      finalizedBlock = 2n;
      const restartedIndexer = new IndexerService({
        config: testConfig(),
        eventSource,
        store,
        resolvePlanCapabilityTables: resolver
      });
      await restartedIndexer.refreshFromCursorWithSummary();

      const persisted = await store.getOrderSnapshot();
      expect(persisted.stateMachinePlans[planKey]?.selectorBindings).toHaveLength(1);
      expect(persisted.stateMachinePlans[planKey]?.signalCapabilities).toHaveLength(1);
      expect(persisted.capabilityEnrichmentMismatchCount ?? 0).toBe(0);
      // 词表来自回滚路径对存活事件锚点的解析，不是首个实例的进程内缓存。
      expect(resolverCalls).toBeGreaterThan(0);
      await expect(store.listEvents({ chainId: 31337 })).resolves.toHaveLength(planEvents.length);
    } finally {
      await store.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("re-resolves the corrected artifact on the next round in the same process after a mismatch", async () => {
    // 回归：断言不过（mismatch）的缓存源必须摘除——缓存若保留陈旧源，
    // 产物库修正后活进程每轮仍重放同一份源，failed 粘滞到重启才解除。
    // 零新事件轮同样要走重放：failed 摘缓存打破了早退的覆盖前提。
    const tempDir = mkdtempSync(join(tmpdir(), "uvp-indexer-enrichment-evict-"));
    const store = new SqliteProjectionStore({
      databaseUrl: `sqlite://${join(tempDir, "projection.sqlite3")}`,
      chainId: 31337,
      migrations: {
        autoRun: true,
        directory: resolve(__dirname, "../migrations")
      }
    });
    try {
      // 链上词表锚定 good 的 root；stale 的两表重算 root 对不上 → mismatch。
      const good = planVocabulary({
        selectorBindings: [{ selectorStageId, targetStageId: stageId }],
        signalCapabilities: [{ stageId, targetSourceId: sourceId, signalId, targetOrderRelation: 0 }]
      });
      const stale = planVocabulary({
        signalCapabilities: [{ stageId, targetSourceId: sourceId, signalId: bytes32Hex("0707"), targetOrderRelation: 0 }]
      });
      const planEvents = planPublishEvents(good);
      const orderEvent = chainEvent(3n, 0, "OrderRegistered", {
        orderId: stateMachineOrderId,
        planId
      });
      let finalizedBlock = 3n;
      const eventSource: ChainEventSource = {
        async getFinalizedBlock() {
          return finalizedBlock;
        },
        async readEvents(range) {
          return [...planEvents, orderEvent].filter(
            (event) => event.blockNumber >= range.fromBlock && event.blockNumber <= range.toBlock
          );
        }
      };
      let servingStale = true;
      let resolverCalls = 0;
      const resolver = async (anchorPlanId: Hex, anchorPlanHash: Hex): Promise<PlanCapabilityTablesInput | undefined> => {
        resolverCalls += 1;
        if (anchorPlanId.toLowerCase() !== planId.toLowerCase() || anchorPlanHash.toLowerCase() !== planHash.toLowerCase()) {
          return undefined;
        }
        return servingStale ? stale : good;
      };
      const warnings: { readonly message: string; readonly context?: Record<string, unknown> }[] = [];
      const capturingLogger = {
        debug: () => undefined,
        info: () => undefined,
        warn: (message: string, context?: Record<string, unknown>) => {
          warnings.push({ message, ...(context ? { context } : {}) });
        },
        error: () => undefined
      };

      const indexer = new IndexerService({
        config: testConfig(),
        eventSource,
        store,
        resolvePlanCapabilityTables: resolver,
        logger: capturingLogger
      });
      const mismatched = await indexer.rebuildFromDeploymentBlockWithSummary();
      const planKey = stateMachineScopedKey(31337, contractAddress, planId);
      expect(mismatched.snapshot.stateMachinePlans[planKey]?.capabilityEnrichment).toBe("failed");
      expect(mismatched.snapshot.capabilityEnrichmentMismatchCount).toBe(1);
      expect(resolverCalls).toBe(1);
      expect(warnings.some((entry) =>
        entry.message.includes("plan capability tables failed the on-chain anchor assertion") &&
        entry.context?.planIds
      )).toBe(true);

      // 产物修正 + 链静止推进（无新事件）：同一进程下一轮必须重解析而非
      // 复用进程内缓存的陈旧源。
      servingStale = false;
      finalizedBlock = 4n;
      eventSource.readEvents = async () => [];
      const refreshed = await indexer.refreshFromCursorWithSummary();

      expect(resolverCalls).toBe(2);
      expect(refreshed.snapshot.stateMachinePlans[planKey]?.capabilityEnrichment).toBe("enriched");
      expect(refreshed.snapshot.stateMachinePlans[planKey]?.selectorBindings).toHaveLength(1);
      const recovered = await store.getOrderSnapshot();
      expect(recovered.stateMachinePlans[planKey]?.capabilityEnrichment).toBe("enriched");
      expect(recovered.stateMachinePlans[planKey]?.signalCapabilities).toHaveLength(1);
    } finally {
      await store.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("skips the full replay on a no-new-events round once the enrichment cache covers every stored plan", async () => {
    // 静止但 finalized 前进的轮：事件集不变、缓存覆盖全部锚点时，全量
    // 重放必然复现已持久化快照——只推进游标，resolver 不再被调用。
    const tempDir = mkdtempSync(join(tmpdir(), "uvp-indexer-enrichment-idle-"));
    const store = new SqliteProjectionStore({
      databaseUrl: `sqlite://${join(tempDir, "projection.sqlite3")}`,
      chainId: 31337,
      migrations: {
        autoRun: true,
        directory: resolve(__dirname, "../migrations")
      }
    });
    try {
      const vocabulary = planVocabulary({
        selectorBindings: [{ selectorStageId, targetStageId: stageId }],
        signalCapabilities: [{ stageId, targetSourceId: sourceId, signalId, targetOrderRelation: 0 }]
      });
      const planEvents = planPublishEvents(vocabulary);
      const orderEvent = chainEvent(3n, 0, "OrderRegistered", {
        orderId: stateMachineOrderId,
        planId
      });
      let finalizedBlock = 3n;
      const eventSource: ChainEventSource = {
        async getFinalizedBlock() {
          return finalizedBlock;
        },
        async readEvents(range) {
          return [...planEvents, orderEvent].filter(
            (event) => event.blockNumber >= range.fromBlock && event.blockNumber <= range.toBlock
          );
        }
      };
      let resolverCalls = 0;
      const resolver = async (anchorPlanId: Hex, anchorPlanHash: Hex): Promise<PlanCapabilityTablesInput | undefined> => {
        resolverCalls += 1;
        return anchorPlanId.toLowerCase() === planId.toLowerCase() && anchorPlanHash.toLowerCase() === planHash.toLowerCase()
          ? vocabulary
          : undefined;
      };

      const indexer = new IndexerService({
        config: testConfig(),
        eventSource,
        store,
        resolvePlanCapabilityTables: resolver
      });
      const rebuilt = await indexer.rebuildFromDeploymentBlockWithSummary();
      const planKey = stateMachineScopedKey(31337, contractAddress, planId);
      expect(rebuilt.snapshot.stateMachinePlans[planKey]?.capabilityEnrichment).toBe("enriched");
      expect(resolverCalls).toBe(1);

      finalizedBlock = 4n;
      eventSource.readEvents = async () => [];
      const refreshed = await indexer.refreshFromCursorWithSummary();

      expect(resolverCalls).toBe(1);
      expect(refreshed.snapshot.stateMachinePlans[planKey]?.capabilityEnrichment).toBe("enriched");
      expect(refreshed.snapshot.stateMachinePlans[planKey]?.selectorBindings).toHaveLength(1);
      expect(refreshed.summary.eventCount).toBe(rebuilt.summary.eventCount);
      expect(indexer.cursor?.nextBlock).toBe(5n);
      const persisted = await store.getOrderSnapshot();
      expect(persisted.stateMachinePlans[planKey]?.selectorBindings).toHaveLength(1);
      const syncState = await store.getSyncState();
      expect(syncState?.finalizedBlock).toBe(4n);
    } finally {
      await store.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("declines the zero-event early exit on crash-window residue and converges through the full path", async () => {
    // 回归（早退让位分支 ①）：零新事件轮的早退事务内清扫出崩溃窗口
    // 残留行（事件已落库、游标未推进）时必须整体回滚让位——残留行的投影
    // 只有全路径事务内的清扫+重放能清，早退只推游标会把幽灵行永久留在
    // 事件表里逐轮投进投影。
    const tempDir = mkdtempSync(join(tmpdir(), "uvp-indexer-early-exit-residue-"));
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
      let finalizedBlock = 7n;
      const eventSource: ChainEventSource = {
        async getFinalizedBlock() {
          return finalizedBlock;
        },
        async readEvents(range) {
          return events.filter(
            (event) => event.blockNumber >= range.fromBlock && event.blockNumber <= range.toBlock
          );
        }
      };
      const infos: string[] = [];
      const warns: string[] = [];
      const logger = {
        debug: () => undefined,
        info: (message: string) => infos.push(message),
        warn: (message: string) => warns.push(message),
        error: () => undefined
      };
      const indexer = new IndexerService({ config: testConfig(), eventSource, store, logger });
      await indexer.rebuildFromDeploymentBlockWithSummary();
      await expect(store.listEvents({ chainId: 31337 })).resolves.toHaveLength(9);

      // 崩溃窗口残留：块 8 的行已落库而游标仍停在 8（单写者不变量下
      // 只可能来自本进程上一轮的崩溃窗口）；canonical 链 [8,9] 无事件。
      const ghostOrderId = "0x000000000000000000000000000000000000000000000000000000000000e101";
      await store.appendEvent(chainEvent(8n, 0, "OrderRegistered", { orderId: ghostOrderId, planId }));

      finalizedBlock = 9n;
      const refreshed = await indexer.refreshFromCursorWithSummary();

      // 早退让位：走的是全路径（清扫+重放），不是早退汇总。
      expect(infos.some((message) => message.includes("indexer incrementally refreshed projections"))).toBe(true);
      expect(infos.some((message) => message.includes("indexer skipped the full replay"))).toBe(false);
      expect(warns.some((message) => message.includes("swept committed-but-unadvanced event rows"))).toBe(true);

      // 收敛：残留行被清扫，重放只含 canonical 事件，幽灵订单不入投影。
      await expect(store.listEvents({ chainId: 31337 })).resolves.toHaveLength(9);
      expect(refreshed.summary.eventCount).toBe(9);
      const persisted = await store.getOrderSnapshot();
      expect(Object.values(persisted.stateMachineOrders).some((order) => order.orderId === ghostOrderId)).toBe(false);
      await expect(store.getCursor({ chainId: 31337, contractAddress: "0x0000000000000000000000000000000000000000" }))
        .resolves.toMatchObject({ nextBlock: 10n, finalizedBlock: 9n });
    } finally {
      await store.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("declines the zero-event early exit when the durable cursor moves concurrently and defers through the full path", async () => {
    // 回归（早退让位分支 ②）：早退的游标写入带 CAS（expectNextBlock =
    // 本轮 fromBlock）——读窗口内另一写者移动持久游标时 CAS 失败让位，
    // 照走全路径（清扫+重放+汇总），推进按 #saveCursorAdvancingFrom 的
    // CAS 语义递延到持久值，不越过事件表覆盖区间。
    const tempDir = mkdtempSync(join(tmpdir(), "uvp-indexer-early-exit-cas-"));
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
      let finalizedBlock = 7n;
      const scope = { chainId: 31337, contractAddress: "0x0000000000000000000000000000000000000000" as Hex };
      const eventSource: ChainEventSource = {
        async getFinalizedBlock() {
          return finalizedBlock;
        },
        async readEvents(range) {
          if (range.fromBlock > 7n) {
            // 零新事件轮的读窗口内，"另一进程"移动持久游标。
            await store.saveCursor({ ...scope, deploymentBlock: 0n, nextBlock: 50n, finalizedBlock: 9n });
          }
          return events.filter(
            (event) => event.blockNumber >= range.fromBlock && event.blockNumber <= range.toBlock
          );
        }
      };
      const infos: string[] = [];
      const warns: string[] = [];
      const logger = {
        debug: () => undefined,
        info: (message: string) => infos.push(message),
        warn: (message: string) => warns.push(message),
        error: () => undefined
      };
      const indexer = new IndexerService({ config: testConfig(), eventSource, store, logger });
      await indexer.rebuildFromDeploymentBlockWithSummary();

      finalizedBlock = 9n;
      await indexer.refreshFromCursorWithSummary();

      // CAS 让位后照走全路径，不是早退汇总。
      expect(infos.some((message) => message.includes("indexer incrementally refreshed projections"))).toBe(true);
      expect(infos.some((message) => message.includes("indexer skipped the full replay"))).toBe(false);
      // 推进被 CAS 递延：内存游标收敛回持久值，让位告警可见。
      expect(indexer.cursor?.nextBlock).toBe(50n);
      expect(warns.some((message) => message.includes("cursor moved by another writer during refresh"))).toBe(true);
      // 事件表未被越过：仍是重建时的 9 条。
      await expect(store.listEvents({ chainId: 31337 })).resolves.toHaveLength(9);
    } finally {
      await store.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("replays the full path on the first zero-new-events round after a restart broke the enrichment cache coverage", async () => {
    // 回归（覆盖打破 → 全路径）：重启后富集缓存为空，零新事件轮的覆盖
    // 前提不成立——照走全路径重放，resolver 重解析后富集态持久化保持。
    const tempDir = mkdtempSync(join(tmpdir(), "uvp-indexer-early-exit-cold-"));
    const store = new SqliteProjectionStore({
      databaseUrl: `sqlite://${join(tempDir, "projection.sqlite3")}`,
      chainId: 31337,
      migrations: {
        autoRun: true,
        directory: resolve(__dirname, "../migrations")
      }
    });
    try {
      const vocabulary = planVocabulary({
        selectorBindings: [{ selectorStageId, targetStageId: stageId }],
        signalCapabilities: [{ stageId, targetSourceId: sourceId, signalId, targetOrderRelation: 0 }]
      });
      const planEvents = planPublishEvents(vocabulary);
      const orderEvent = chainEvent(3n, 0, "OrderRegistered", {
        orderId: stateMachineOrderId,
        planId
      });
      let finalizedBlock = 3n;
      const eventSource: ChainEventSource = {
        async getFinalizedBlock() {
          return finalizedBlock;
        },
        async readEvents(range) {
          return [...planEvents, orderEvent].filter(
            (event) => event.blockNumber >= range.fromBlock && event.blockNumber <= range.toBlock
          );
        }
      };
      let resolverCalls = 0;
      const resolver = async (anchorPlanId: Hex, anchorPlanHash: Hex): Promise<PlanCapabilityTablesInput | undefined> => {
        resolverCalls += 1;
        return anchorPlanId.toLowerCase() === planId.toLowerCase() && anchorPlanHash.toLowerCase() === planHash.toLowerCase()
          ? vocabulary
          : undefined;
      };
      const infos: string[] = [];
      const logger = {
        debug: () => undefined,
        info: (message: string) => infos.push(message),
        warn: () => undefined,
        error: () => undefined
      };

      const firstIndexer = new IndexerService({
        config: testConfig(),
        eventSource,
        store,
        resolvePlanCapabilityTables: resolver
      });
      await firstIndexer.rebuildFromDeploymentBlockWithSummary();
      expect(resolverCalls).toBe(1);

      // 重启（富集缓存为空）+ 零新事件轮：覆盖不成立，照走全路径。
      finalizedBlock = 4n;
      eventSource.readEvents = async () => [];
      const restartedIndexer = new IndexerService({
        config: testConfig(),
        eventSource,
        store,
        resolvePlanCapabilityTables: resolver,
        logger
      });
      const refreshed = await restartedIndexer.refreshFromCursorWithSummary();

      expect(resolverCalls).toBe(2);
      expect(infos.some((message) => message.includes("indexer incrementally refreshed projections"))).toBe(true);
      expect(infos.some((message) => message.includes("indexer skipped the full replay"))).toBe(false);
      const planKey = stateMachineScopedKey(31337, contractAddress, planId);
      expect(refreshed.snapshot.stateMachinePlans[planKey]?.capabilityEnrichment).toBe("enriched");
      expect(refreshed.snapshot.stateMachinePlans[planKey]?.selectorBindings).toHaveLength(1);
    } finally {
      await store.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rolls back stored events and replays the canonical fork when a reorg breaks cursor hash continuity", async () => {
    // 模拟 fork——block 3 之后链被替换。cursor 哈希校验发现断链，
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

  it("sweeps committed-but-unadvanced ghost rows when a shallow reorg lands inside the crash window", async () => {
    // 崩溃窗口×浅 reorg：事件事务已提交、游标未推进（中间夹通知投递）
    // 时进程崩溃，随后游标高度之上的块发生浅 reorg。游标哈希校验只看
    // 游标高度一处哈希，不会触发回滚；重读追加的 ON CONFLICT DO NOTHING
    // 挡不住不同 txHash 的旧分叉行——增量轮必须先清扫游标之上的残留行，
    // 否则旧分叉事件与 canonical 并存成永久幽灵，每轮重放投进投影。
    const tempDir = mkdtempSync(join(tmpdir(), "uvp-indexer-crash-window-"));
    const store = new SqliteProjectionStore({
      databaseUrl: `sqlite://${join(tempDir, "projection.sqlite3")}`,
      chainId: 31337,
      migrations: {
        autoRun: true,
        directory: resolve(__dirname, "../migrations")
      }
    });
    try {
      const stableEvents: readonly ChainEvent[] = [
        chainEvent(1n, 0, "PlanRegistered", { planId, planHash, hookCount: 1n }),
        chainEvent(2n, 0, "OrderRegistered", { orderId: stateMachineOrderId, planId }),
        chainEvent(3n, 0, "SignalSubmitted", {
          orderId: stateMachineOrderId,
          sourceId,
          signalId,
          payloadHash,
          idempotencyKey,
          submitter: signer
        })
      ].map((event, index) => ({ ...event, blockHash: blockHashHex(`block-${index + 1}`) }));
      // 崩溃窗口残留：旧分叉上 block 4 的事件（不同 txHash）已随事件事务
      // 提交，游标停在 4 未推进。
      const staleForkBlock4Event = {
        ...chainEvent(4n, 0, "SignalSubmitted", {
          orderId: stateMachineOrderId,
          sourceId,
          signalId: bytes32Hex("dead"),
          payloadHash: bytes32Hex("face"),
          idempotencyKey: bytes32Hex("9001"),
          submitter: signer
        }, contractAddress, { transactionHash: bytes32Hex("e1") }),
        blockHash: blockHashHex("block-4-stale")
      };
      const canonicalBlock4Event = {
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
        [3n, blockHashHex("block-3")],
        [4n, blockHashHex("block-4-fork")]
      ]);
      let readableEvents: readonly ChainEvent[] = stableEvents;
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
      await store.appendEvent(staleForkBlock4Event);
      await expect(store.listEvents({ chainId: 31337 })).resolves.toHaveLength(4);

      // 浅 reorg 只动了 block 4（游标高度 3 的哈希不变）。
      finalizedBlock = 4n;
      readableEvents = [...stableEvents, canonicalBlock4Event];

      const result = await indexer.refreshFromCursorWithSummary();

      // 旧分叉行被清扫：block 4 只剩 canonical 事件，无幽灵并存。
      const storedEvents = await store.listEvents({ chainId: 31337 });
      expect(storedEvents).toHaveLength(4);
      expect(storedEvents.filter((event) => event.blockNumber === 4n)).toHaveLength(1);
      expect(storedEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({ blockNumber: 4n, blockHash: blockHashHex("block-4-fork") })
      ]));
      expect(result.summary).toMatchObject({
        fromBlock: "4",
        toBlock: "4",
        syncStatus: "indexed",
        finalizedBlock: "4",
        mismatchCount: 0
      });
      await expect(store.getCursor({ chainId: 31337, contractAddress: "0x0000000000000000000000000000000000000000" }))
        .resolves.toMatchObject({ nextBlock: 5n, finalizedBlock: 4n });
    } finally {
      await store.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("trims pending post-commit notification batches above the reorg ancestor block", async () => {
    // 幽灵通知：pending 批次内高于共同祖先的事件已被回滚删除，等最终性
    // 追平后 sweep 会照常补投。回滚必须把批次修剪到祖先及以下；祖先以下的
    // 事件保持排队等待补投。
    const tempDir = mkdtempSync(join(tmpdir(), "uvp-indexer-reorg-pending-"));
    const store = new SqliteProjectionStore({
      databaseUrl: `sqlite://${join(tempDir, "projection.sqlite3")}`,
      chainId: 31337,
      migrations: {
        autoRun: true,
        directory: resolve(__dirname, "../migrations")
      }
    });
    try {
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
      let canonicalBlocks = new Map<bigint, Hex>([
        [1n, blockHashHex("block-1")],
        [2n, blockHashHex("block-2")],
        [3n, blockHashHex("block-3-stale")]
      ]);
      let readableEvents: readonly ChainEvent[] = [
        ...canonicalEvents.map((event, index) => ({ ...event, blockHash: blockHashHex(`block-${index + 1}`) })),
        staleBlock3Event
      ];
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
      const indexer = new IndexerService({ config: testConfig(), eventSource, store });
      await indexer.rebuildFromDeploymentBlockWithSummary();

      // 混合批次（块1+块3）与纯低块批次（块2）各一条 pending 补投记录。
      await store.savePendingPostCommitStep({
        stepId: "pending_signal_notification_mixed",
        chainId: 31337,
        kind: "signal_notification",
        events: [
          { ...canonicalEvents[0]!, blockHash: blockHashHex("block-1") },
          staleBlock3Event
        ]
      });
      await store.savePendingPostCommitStep({
        stepId: "pending_signal_notification_below",
        chainId: 31337,
        kind: "signal_notification",
        events: [{ ...canonicalEvents[1]!, blockHash: blockHashHex("block-2") }]
      });

      // fork：block 3 被替换，共同祖先为 block 2。
      canonicalBlocks = new Map<bigint, Hex>([
        [1n, blockHashHex("block-1")],
        [2n, blockHashHex("block-2")],
        [3n, blockHashHex("block-3-fork")]
      ]);
      readableEvents = [
        ...canonicalEvents.map((event, index) => ({ ...event, blockHash: blockHashHex(`block-${index + 1}`) })),
        {
          ...chainEvent(3n, 0, "SignalSubmitted", {
            orderId: stateMachineOrderId,
            sourceId,
            signalId,
            payloadHash: bytes32Hex("feed"),
            idempotencyKey: bytes32Hex("9002"),
            submitter: signer
          }),
          blockHash: blockHashHex("block-3-fork")
        }
      ];
      finalizedBlock = 3n;

      await indexer.refreshFromCursorWithSummary();

      const pending = await store.listPendingPostCommitSteps({ chainId: 31337 });
      expect(pending).toHaveLength(2);
      for (const step of pending) {
        expect(step.kind).toBe("signal_notification");
        for (const event of step.events ?? []) {
          // 回滚后队列里不得残留高于祖先块（2）的载荷。
          expect(event.blockNumber).toBeLessThanOrEqual(2n);
        }
      }
      const eventBlocks = pending.flatMap((step) => (step.events ?? []).map((event) => event.blockNumber)).sort();
      expect(eventBlocks).toEqual([1n, 2n]);
    } finally {
      await store.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("fails with a full-rebuild demand when a reorg erases every known block hash", async () => {
    // 整条已知链都被替换时，回溯窗口内找不到共同祖先 → 报错。
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
    // 同一事件键作为活跃事件重复投递（矛盾投递）必须计入
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
    // 链上无词表注册事件；PlanPublisherRecorded 是仍要求 plan 桶存在的
    // 计划族事件，裸投递时撞"unknown plan"。
    const corruptSource: ChainEventSource = {
      async getFinalizedBlock() {
        return 5n;
      },
      async readEvents() {
        return [
          chainEvent(1n, 0, "PlanPublisherRecorded", {
            planId,
            publisher: signer
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
    const router = createApiRouter(store, { submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111", productRuntimeEnvironment: "local" as const });
    const taskId = `${contractAddress}:${stateMachineOrderId}:${hookId}`;

    const orderHeaders = { "x-uvp-wallet-address": "0x3333333333333333333333333333333333333333" };
    const ordersResponse = await router.handle({ method: "GET", pathname: "/product/orders", headers: orderHeaders });
    const orderResponse = await router.handle({ method: "GET", pathname: `/product/orders/${stateMachineOrderId}`, headers: orderHeaders });
    const timelineResponse = await router.handle({
      method: "GET",
      pathname: `/product/orders/${stateMachineOrderId}/timeline`,
      headers: orderHeaders
    });
    const proofResponse = await router.handle({
      method: "GET",
      pathname: `/product/orders/${stateMachineOrderId}/proof`,
      headers: orderHeaders
    });
    // 任务读取收口：已认证参与者（锚定钱包）读取任务；该任务未指派
    // 受理人，纯链上事实对已认证参与者开放。
    const tasksResponse = await router.handle({
      method: "GET",
      pathname: "/product/tasks",
      query: { orderId: stateMachineOrderId },
      headers: { "x-uvp-wallet-address": "0x3333333333333333333333333333333333333333" }
    });
    const taskResponse = await router.handle({ method: "GET", pathname: `/product/tasks/${taskId}`, headers: { "x-uvp-wallet-address": "0x3333333333333333333333333333333333333333" } });

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

  it("serializes a background incremental refresh with an in-flight full rebuild on the durable store", async () => {
    // 回归：refreshIfIdle 的后台出队曾直调 #refreshFromCursor 绕过
    // #withExclusiveGuard——重建进行中时并发刷新会与整库替换交错（重复
    // 通知补投、SQLITE_BUSY 风暴，配合旧无条件游标写即静默丢事件）。
    const tempDir = mkdtempSync(join(tmpdir(), "uvp-indexer-guard-"));
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
      const readLog: string[] = [];
      let unblockRebuild: (() => void) | undefined;
      const rebuildBlocked = new Promise<void>((resolve) => { unblockRebuild = resolve; });
      const eventSource: ChainEventSource = {
        async getFinalizedBlock() {
          return 7n;
        },
        async readEvents(range) {
          readLog.push(`${range.fromBlock}-${range.toBlock}`);
          if (range.fromBlock === 0n) {
            // 全量重建悬停在事件读取处，模拟 admin 重建进行中。
            await rebuildBlocked;
          }
          return events.filter(
            (event) => event.blockNumber >= range.fromBlock && event.blockNumber <= range.toBlock
          );
        }
      };
      const indexer = new IndexerService({ config: testConfig(), eventSource, store });

      const rebuildPromise = indexer.rebuildFromDeploymentBlockWithSummary();
      await waitForCondition(() => readLog.length === 1);

      indexer.refreshIfIdle();
      // 重建未结束：后台刷新必须仍在守卫队列中等待，不得并发发起读取。
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(readLog).toEqual(["0-7"]);

      unblockRebuild!();
      const { summary } = await rebuildPromise;
      expect(summary.syncStatus).toBe("indexed");

      // 重建提交后队列里的刷新出队：游标已到 8（finalized 7），空批次
      // 收敛，不越过事件表覆盖区间。
      await waitForCondition(() => indexer.cursor !== undefined);
      await expect(store.listEvents({ chainId: 31337 })).resolves.toHaveLength(9);
      await expect(store.getCursor({ chainId: 31337, contractAddress: "0x0000000000000000000000000000000000000000" }))
        .resolves.toMatchObject({ nextBlock: 8n, finalizedBlock: 7n });
      expect(readLog).toEqual(["0-7"]);
    } finally {
      await store.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("fails closed after the durable cursor is repeatedly moved by another writer", async () => {
    // 所有触发路径已过互斥守卫后，持久游标连续 CAS 失败只能来自
    // 第二个索引器进程——按多实例部署错误显式失败，而不是无限顶替。
    const tempDir = mkdtempSync(join(tmpdir(), "uvp-indexer-cas-"));
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
      const eventSource: ChainEventSource = {
        async getFinalizedBlock() {
          return 7n;
        },
        async readEvents(range) {
          // 读事件与游标 CAS 落库之间的窗口里，"另一进程"再次移动持久游标。
          await store.saveCursor({ ...scope, deploymentBlock: 0n, nextBlock: 50n + BigInt(counter) });
          counter += 1;
          return events.filter(
            (event) => event.blockNumber >= range.fromBlock && event.blockNumber <= range.toBlock
          );
        }
      };
      const scope = { chainId: 31337, contractAddress: "0x0000000000000000000000000000000000000000" as Hex };
      let counter = 1;
      const indexer = new IndexerService({ config: testConfig(), eventSource, store });
      await indexer.rebuildFromDeploymentBlockWithSummary();

      // 模拟外部写者连续移动持久游标（守卫内无竞争写者，只能是另一进程）：
      // 前两次 CAS 失败优雅让位，第三次按多实例部署错误显式失败。
      for (let round = 1; round <= 3; round += 1) {
        await store.saveCursor({ ...scope, deploymentBlock: 0n, nextBlock: 4n });
        if (round < 3) {
          await indexer.refreshFromCursorWithSummary();
        } else {
          await expect(indexer.refreshFromCursorWithSummary()).rejects.toThrow(
            /run exactly one indexer process per chain scope/
          );
        }
      }
    } finally {
      await store.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
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

    const router = createApiRouter(store, { submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111", productRuntimeEnvironment: "local" as const });
    const proofResponse = await router.handle({
      method: "GET",
      pathname: `/product/orders/${stateMachineOrderId}/proof`,
      headers: { "x-uvp-wallet-address": "0x3333333333333333333333333333333333333333" }
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

    const router = createApiRouter(store, { submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111", productRuntimeEnvironment: "local" as const });
    const proofResponse = await router.handle({
      method: "GET",
      pathname: `/product/orders/${queuedOrderId}/proof`,
      headers: { "x-uvp-wallet-address": "0x3333333333333333333333333333333333333333" }
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
    // 真实链序 commitPlan 先发 PlanCommitted → PlanPublisherRecorded；
    // finalizePlan 随后发 PlanFinalized + PlanRegistered（词表已 Merkle 化
    // 进 capabilitiesRoot，finalize 交易内不再有 plan metadata 模块事件）。
    // 投影若只认 PlanRegistered 建桶，首次两步发布即在 finalize 交易内撞
    // "unknown plan" → ProjectionError → 索引器永久 degraded。
    // 两表（词表/绑定表）由重放方按 planId 从编译产物富集并断言 root。
    const hooksHash = bytes32Hex("9001");
    const dockRoutesRoot = bytes32Hex("9003");
    const dockInterfaceRoot = bytes32Hex("9004");
    const vocabulary = planVocabulary({
      selectorBindings: [{ selectorStageId, targetStageId: stageId }],
      signalCapabilities: [{ stageId, targetSourceId: sourceId, signalId, targetOrderRelation: 0 }]
    });
    const events: readonly ChainEvent[] = [
      ...planPublishEvents(vocabulary, contractAddress, {
        hooksHash,
        dockRoutesRoot,
        dockInterfaceRoot,
        hookCount: 2n
      })
    ];

    const snapshot = rebuildOrderProjections(events, { planCapabilityTables: [vocabulary] });
    const planKey = stateMachineScopedKey(31337, contractAddress, planId);
    const plan = snapshot.stateMachinePlans[planKey];

    expect(snapshot.rebuildable).toBe(true);
    expect(plan).toMatchObject({
      planId,
      planHash,
      publisher: signer,
      hookCount: "2",
      capabilitiesRoot: vocabulary.capabilitiesRoot,
      hooksHash,
      dockRoutesRoot,
      dockInterfaceRoot
    });
    // 两阶段 provenance：桶在 PlanCommitted 建立，PlanRegistered 覆写注册时点。
    expect(plan?.committedAt).toMatchObject({ blockNumber: 1n, logIndex: 0 });
    expect(plan?.finalizedAt).toMatchObject({ blockNumber: 2n, logIndex: 0 });
    expect(plan?.registeredAt).toMatchObject({ blockNumber: 2n, logIndex: 1 });
    // 两表来自产物富集（词表锚定 PlanFinalized 的 root），不再是链上事件。
    expect(plan?.signalCapabilities).toEqual([
      expect.objectContaining({
        stageId,
        targetSourceId: sourceId,
        signalId,
        registeredAt: expect.objectContaining({ blockNumber: 2n, logIndex: 0 })
      })
    ]);
    expect(plan?.selectorBindings).toEqual([
      expect.objectContaining({ selectorStageId, targetStageId: stageId })
    ]);
    expect(plan?.capabilityEnrichment).toBe("enriched");
  });

  it("keeps the plan vocabulary empty and counts a mismatch when the artifact root diverges from the chain root", () => {
    // fail-closed：产物两表重算 root ≠ 链上 capabilitiesRoot（产物过期/被改
    // 写）时不得填进投影——下游会按错词表造出链上必拒的证明。显式计数，
    // 不 crash indexer。断言不过 = 词表状态未知，富集态标 failed（不是
    // 外部发布 plan 的 empty），提交/触发车道据此拒绝零值造证。
    const chainVocabulary = planVocabulary({
      signalCapabilities: [{ stageId, targetSourceId: sourceId, signalId, targetOrderRelation: 0 }]
    });
    // 产物表多出一条绑定（root 与链上不一致）：模拟产物过期/被改写。
    const staleArtifact = planVocabulary({
      selectorBindings: [{ selectorStageId, targetStageId: stageId }],
      signalCapabilities: [{ stageId, targetSourceId: sourceId, signalId, targetOrderRelation: 0 }]
    });
    const events: readonly ChainEvent[] = [
      ...planPublishEvents(chainVocabulary)
    ];

    const snapshot = rebuildOrderProjections(events, { planCapabilityTables: [staleArtifact] });
    const plan = snapshot.stateMachinePlans[stateMachineScopedKey(31337, contractAddress, planId)];

    expect(plan?.signalCapabilities).toHaveLength(0);
    expect(plan?.selectorBindings).toHaveLength(0);
    expect(snapshot.capabilityEnrichmentMismatchCount).toBe(1);
    expect(plan?.capabilityEnrichment).toBe("failed");
  });

  it("keeps externally published plans on an empty vocabulary without counting a mismatch", () => {
    // 外部发布 plan（store 域无产物）：两表留空是既定取舍而非异常——
    // 词表相关推导对该 plan 不可用，链上词表闸不受影响。富集态 empty 与
    // 故障态 failed 区分：empty 是"确认无产物"的合法全零路径。
    const chainVocabulary = planVocabulary({});
    const events: readonly ChainEvent[] = [
      ...planPublishEvents(chainVocabulary)
    ];

    const snapshot = rebuildOrderProjections(events);
    const plan = snapshot.stateMachinePlans[stateMachineScopedKey(31337, contractAddress, planId)];

    expect(plan?.signalCapabilities).toHaveLength(0);
    expect(plan?.selectorBindings).toHaveLength(0);
    expect(snapshot.capabilityEnrichmentMismatchCount).toBe(0);
    expect(plan?.capabilityEnrichment).toBe("empty");
  });

  it("marks the vocabulary enrichment failed when the resolver threw for the plan this round", () => {
    // 解析故障 ≠ 无词表：resolver 故障轮的空两表必须以 failed 富集态进
    // 快照——与"外部发布 plan 的 empty"区分，提交/触发车道据此拒绝零值
    // 造证（读失败时无法判断事实是否在词表内，全零会把本可预判的
    // InvalidSignalCapability 留到链上 revert 才暴露，白烧代付 gas）。
    const chainVocabulary = planVocabulary({
      selectorBindings: [{ selectorStageId, targetStageId: stageId }],
      signalCapabilities: [{ stageId, targetSourceId: sourceId, signalId, targetOrderRelation: 0 }]
    });
    const events: readonly ChainEvent[] = [
      ...planPublishEvents(chainVocabulary)
    ];

    const snapshot = rebuildOrderProjections(events, {
      planCapabilityResolutionFailures: [planId]
    });
    const plan = snapshot.stateMachinePlans[stateMachineScopedKey(31337, contractAddress, planId)];

    expect(plan?.signalCapabilities).toHaveLength(0);
    expect(plan?.selectorBindings).toHaveLength(0);
    // 故障不是 mismatch（产物没读到，无从断言），也不得混入 empty。
    expect(snapshot.capabilityEnrichmentMismatchCount).toBe(0);
    expect(plan?.capabilityEnrichment).toBe("failed");
  });

  it("recovers from a shallow reorg on a quiet chain whose stored events are far below the backtrack window", async () => {
    // 安静链上浅 reorg——回溯窗口内没有任何已存事件
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
      const rollbackProbe = new ReorgRollbackProbe();
      const indexer = new IndexerService({
        config: testConfig(),
        eventSource,
        store,
        logger: rollbackProbe
      });
      await indexer.rebuildFromDeploymentBlockWithSummary();

      // 安静推进到 2500：无新事件，cursor 走到 2501（哈希 orig-2500）。
      finalizedBlock = 2500n;
      await indexer.refreshFromCursorWithSummary();
      await expect(store.getCursor({ chainId: 31337, contractAddress: "0x0000000000000000000000000000000000000000" }))
        .resolves.toMatchObject({ nextBlock: 2501n, blockHash: blockHashHex("orig-2500") });
      expect(rollbackProbe.rollbackCount).toBe(0);

      // 浅 reorg：必须触及 cursor 高度块 2500（追加前哈希连续性校验的
      // 锚点）才会被发现——只换 tip 块 2600 的哈希时校验在 2500 上照常
      // 通过，回滚路径根本不进入（假绿）。fromBlock=2501 > 1000 窗口，
      // 已存事件（块 1-3）全部在窗口下界之下——不能据此判定"reorg 深于
      // 窗口"要求人工 full rebuild，须回退到全库最新锚点（块 3）核对
      // 一致后继续。
      canonicalBlocks = new Map<bigint, Hex>([
        ...canonicalBlocks,
        [2500n, blockHashHex("fork-2500")],
        [2600n, blockHashHex("fork-2600")]
      ]);
      finalizedBlock = 2600n;
      const result = await indexer.refreshFromCursorWithSummary();

      // 回滚路径必须真实进入（更旧锚点回验）：探测 reorg 回滚警告，
      // 防止"分叉不触及 cursor 高度、校验照常通过"的假绿复现。
      expect(rollbackProbe.rollbackCount).toBe(1);
      expect(result.summary).toMatchObject({ syncStatus: "indexed" });
      await expect(store.getCursor({ chainId: 31337, contractAddress: "0x0000000000000000000000000000000000000000" }))
        .resolves.toMatchObject({ nextBlock: 2601n, blockHash: blockHashHex("fork-2600") });
    } finally {
      await store.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("persists exhausted post-commit notification batches and redelivers them from the durable sweep", async () => {
    // 通知 post-commit 3 次进程内
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

  it("finality waits do not burn the pending sweep budget", async () => {
    // 未达最终性上界的通知批次由 pending 队列推迟补投，而不是被判为
    // 跳过：等待类失败不记 attempts、不触发死信——否则等待最终性的
    // 批次会在若干轮 sweep 后被永久删除（M4）。
    const tempDir = mkdtempSync(join(tmpdir(), "uvp-indexer-finality-wait-"));
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
      const indexer = new IndexerService({
        config: testConfig(),
        eventSource,
        store,
        notificationProcessor: {
          async processSignalSubmittedEvents() {
            // rebuild 期通知正常投递——pending 表里只留我们手工落的
            // 高于最终性上界的批次，避免真实失败混入预算断言。
          }
        }
      });
      await indexer.rebuildFromDeploymentBlockWithSummary();

      // 直接落一行事件块号高于最终性上界的 pending 批次（事件同时写入
      // 事件表——真实失败批次的载荷事件必然已落库，补投的存在性检查
      // 以此为前提）。
      const lateEvent = chainEvent(15n, 0, "SignalSubmitted", {
        orderId: stateMachineOrderId,
        sourceId: bytes32Hex("1606"),
        signalId: bytes32Hex("1707"),
        payloadHash,
        idempotencyKey: bytes32Hex("1bbb"),
        submitter: signer
      });
      await store.appendEvent(lateEvent);
      await store.savePendingPostCommitStep({
        stepId: "pending_signal_notification:finality-wait",
        chainId: 31337,
        kind: "signal_notification",
        events: [lateEvent]
      });

      // 连续多轮 sweep（远超 16 次死信预算）：批次保持排队、attempts 不
      // 增长、以 waitingFinality 计数，绝不被死信删除。
      for (let round = 0; round < 20; round += 1) {
        const summary = await indexer.sweepPendingPostCommitSteps();
        expect(summary).toMatchObject({ swept: 1, delivered: 0, failed: 0, waitingFinality: 1 });
      }
      const queued = await indexer.listPendingPostCommitSteps();
      expect(queued.length).toBe(1);
      expect(queued[0]).toMatchObject({
        stepId: "pending_signal_notification:finality-wait",
        attempts: 0
      });

      // 最终性追上后批次正常补投出队（守卫分支不拦截已达上界的事件）。
      await store.saveSyncState({
        chainId: 31337,
        contractAddress: "0x0000000000000000000000000000000000000000" as Hex,
        syncStatus: "indexed",
        finalizedBlock: 15n,
        confirmationDepth: 1,
        eventCount: 0
      });
      const delivered: (readonly ChainEvent[])[] = [];
      const recovered = new IndexerService({
        config: testConfig(),
        eventSource,
        store,
        notificationProcessor: {
          async processSignalSubmittedEvents(events) {
            delivered.push(events);
          }
        }
      });
      const finalSweep = await recovered.sweepPendingPostCommitSteps();
      expect(finalSweep).toMatchObject({ swept: 1, delivered: 1, failed: 0, waitingFinality: 0 });
      expect(delivered.length).toBe(1);
      await expect(recovered.listPendingPostCommitSteps()).resolves.toEqual([]);
    } finally {
      await store.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("drops pending notification batches whose events vanish from the rebuilt event log on a full rebuild", async () => {
    // resetFromEvents 整库替换事件表后，载荷引用已不存在事件的
    // pending 通知步骤是脏存量——重建必须清理，否则 sweep 会把幽灵
    // 通知投出去。事件仍在本批重建事件集里的步骤保留（含重建预落步骤）。
    const tempDir = mkdtempSync(join(tmpdir(), "uvp-indexer-rebuild-ghost-"));
    const store = new SqliteProjectionStore({
      databaseUrl: `sqlite://${join(tempDir, "projection.sqlite3")}`,
      chainId: 31337,
      migrations: {
        autoRun: true,
        directory: resolve(__dirname, "../migrations")
      }
    });
    try {
      // 第一轮：通知通道故障，重建批次转 pending（事件已落事件表）。
      const failingSource: ChainEventSource = {
        async getFinalizedBlock() {
          return 9n;
        },
        async readEvents(range) {
          return stateMachineEvents().filter((event) => event.blockNumber >= range.fromBlock && event.blockNumber <= range.toBlock);
        }
      };
      const indexer = new IndexerService({
        config: testConfig(),
        eventSource: failingSource,
        store,
        notificationProcessor: {
          async processSignalSubmittedEvents() {
            throw new Error("notification delivery down");
          }
        }
      });
      await indexer.rebuildFromDeploymentBlockWithSummary();
      const pendingBeforeRebuild = await indexer.listPendingPostCommitSteps();
      expect(pendingBeforeRebuild.length).toBe(1);
      const ghostEvent = pendingBeforeRebuild[0]?.events
        ?.find((event) => event.eventName === "SignalSubmitted");
      // chainEvent 助手同块共享 txHash，事件身份用 txHash+logIndex 键。
      const ghostEventKey = ghostEvent && `${ghostEvent.transactionHash}:${ghostEvent.logIndex}`;
      expect(ghostEventKey).toBeDefined();

      // 第二轮：通道恢复，但重建读到的事件集不再包含 pending 批次里的
      // 旧分叉事件（同区间事件被替换）。
      const deliveredBatches: (readonly ChainEvent[])[] = [];
      const recoveringIndexer = new IndexerService({
        config: testConfig(),
        eventSource: {
          async getFinalizedBlock() {
            return 9n;
          },
          async readEvents(range) {
            return stateMachineEvents()
              .filter((event) => event.blockNumber >= range.fromBlock && event.blockNumber <= range.toBlock)
              .filter((event) => event.eventName !== "SignalSubmitted");
          }
        },
        store,
        notificationProcessor: {
          async processSignalSubmittedEvents(events) {
            deliveredBatches.push(events);
          }
        }
      });
      await recoveringIndexer.rebuildFromDeploymentBlockWithSummary();

      // 脏存量被重建清理：不再有可补投的 pending 批次。
      await expect(recoveringIndexer.listPendingPostCommitSteps()).resolves.toEqual([]);
      const sweepSummary = await recoveringIndexer.sweepPendingPostCommitSteps();
      expect(sweepSummary).toMatchObject({ swept: 0, delivered: 0, failed: 0, ghostDropped: 0 });
      // 幽灵批次没有被投出去：投递只发生在重建自己的活跃事件上，且
      // 不含旧分叉事件。
      const deliveredEventKeys = deliveredBatches.flat().map((event) => `${event.transactionHash}:${event.logIndex}`);
      expect(deliveredEventKeys).not.toContain(ghostEventKey);
    } finally {
      await store.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("dead-letters ghost notification batches at sweep time instead of delivering them", async () => {
    // 补投前检查事件存在性——批次已达最终性上界、载荷事件却
    // 不在投影事件表里（任何路径残留的脏存量）时判废出队，不投递、
    // 不消耗重试预算。
    const tempDir = mkdtempSync(join(tmpdir(), "uvp-indexer-sweep-ghost-"));
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
      const deliveredBatches: (readonly ChainEvent[])[] = [];
      const indexer = new IndexerService({
        config: testConfig(),
        eventSource,
        store,
        notificationProcessor: {
          async processSignalSubmittedEvents(events) {
            deliveredBatches.push(events);
          }
        }
      });
      await indexer.rebuildFromDeploymentBlockWithSummary();
      const rebuildDeliveryCount = deliveredBatches.length;

      // 手工落一个"幽灵"批次：事件块号在最终性上界内，但从未进入
      // 投影事件表（重建替换/reorg 后残留的形态）。
      const ghostEvent = chainEvent(5n, 3, "SignalSubmitted", {
        orderId: stateMachineOrderId,
        sourceId: bytes32Hex("2606"),
        signalId: bytes32Hex("2707"),
        payloadHash,
        idempotencyKey: bytes32Hex("2bbb"),
        submitter: signer
      });
      await store.savePendingPostCommitStep({
        stepId: "pending_signal_notification:ghost-batch",
        chainId: 31337,
        kind: "signal_notification",
        events: [ghostEvent]
      });

      const sweepSummary = await indexer.sweepPendingPostCommitSteps();
      expect(sweepSummary).toMatchObject({ swept: 1, delivered: 0, failed: 0, waitingFinality: 0, ghostDropped: 1 });
      expect(deliveredBatches.length).toBe(rebuildDeliveryCount);
      await expect(indexer.listPendingPostCommitSteps()).resolves.toEqual([]);
    } finally {
      await store.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("dead-letters notification batches whose events only survive as reorg tombstones", async () => {
    // reorg 把载荷事件打掉后，事件表里留下的是 removed=1 墓碑行——
    // 存在性检查若把墓碑当"事件仍在"，幽灵批次会被照常补投。sweep
    // 的存在集必须过滤墓碑；投影重放等其他调用方仍依赖含墓碑的全集。
    const tempDir = mkdtempSync(join(tmpdir(), "uvp-indexer-sweep-tombstone-"));
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
      const deliveredBatches: (readonly ChainEvent[])[] = [];
      const indexer = new IndexerService({
        config: testConfig(),
        eventSource,
        store,
        notificationProcessor: {
          async processSignalSubmittedEvents(events) {
            deliveredBatches.push(events);
          }
        }
      });
      await indexer.rebuildFromDeploymentBlockWithSummary();
      const rebuildDeliveryCount = deliveredBatches.length;

      // 载荷事件以 reorg 墓碑形态残留在事件表（removed=true 且无活跃行：
      // appendEvent 的墓碑 UPDATE 不命中时落的就是纯墓碑行）。
      const tombstonedEvent = {
        ...chainEvent(5n, 4, "SignalSubmitted", {
          orderId: stateMachineOrderId,
          sourceId: bytes32Hex("3606"),
          signalId: bytes32Hex("3707"),
          payloadHash,
          idempotencyKey: bytes32Hex("3bbb"),
          submitter: signer
        }),
        removed: true
      };
      await store.appendEvent(tombstonedEvent);
      const storedAfterTombstone = await store.listEvents({ chainId: 31337 });
      expect(
        storedAfterTombstone.some((event) => event.removed === true),
      ).toBe(true);
      await store.savePendingPostCommitStep({
        stepId: "pending_signal_notification:tombstone-batch",
        chainId: 31337,
        kind: "signal_notification",
        events: [tombstonedEvent]
      });

      const sweepSummary = await indexer.sweepPendingPostCommitSteps();
      expect(sweepSummary).toMatchObject({ swept: 1, delivered: 0, failed: 0, waitingFinality: 0, ghostDropped: 1 });
      expect(deliveredBatches.length).toBe(rebuildDeliveryCount);
      await expect(indexer.listPendingPostCommitSteps()).resolves.toEqual([]);
    } finally {
      await store.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("reports projectionRebuilt=false when the chain has not reached the deployment block", async () => {
    // 链未达部署块时重建早退——没有重放任何事件，
    // projectionRebuilt=true 是 fail-open（掩盖未完成态）。
    const store = new MemoryProjectionStore();
    const eventSource: ChainEventSource = {
      async getFinalizedBlock() {
        return 5n;
      },
      async readEvents() {
        throw new Error("readEvents must not be called before the chain reaches the deployment block");
      }
    };
    const indexer = new IndexerService({
      config: {
        ...testConfig(),
        network: { ...testConfig().network, deploymentBlock: 100n }
      },
      eventSource,
      store
    });
    const { summary } = await indexer.rebuildFromDeploymentBlockWithSummary();

    expect(summary.projectionRebuilt).toBe(false);
    expect(summary.syncStatus).toBe("syncing");
    expect(summary.eventCount).toBe(0);
    const syncState = await store.getSyncState();
    expect(syncState?.rebuild?.projectionRebuilt).toBe(false);
  });

  it("reuses one stable pending row for repeated projection automation failures", async () => {
    // 无事件批次的 pending 步骤 id 必须稳定——时间戳
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
    // 投递记录创建先于 cursor 推进——游标先落库的窗口内硬
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
      // 首轮 rebuild：游标与"整库事件替换"同事务收敛，
      // 通知处理发生在事务提交之后——此时持久游标已就位（10n）。重建提
      // 交后、通知前崩溃不再可能留下越过重建覆盖区间的旧游标。
      await indexer.rebuildFromDeploymentBlockWithSummary();
      expect(cursorNextBlockAtNotification).toEqual([10n]);
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
    // 最新已存锚点恰好被 reorg 触及、更旧锚点仍与 canonical 一致
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
      const rollbackProbe = new ReorgRollbackProbe();
      const indexer = new IndexerService({
        config: testConfig(),
        eventSource,
        store,
        logger: rollbackProbe
      });
      await indexer.rebuildFromDeploymentBlockWithSummary();

      finalizedBlock = 2500n;
      await indexer.refreshFromCursorWithSummary();
      expect(rollbackProbe.rollbackCount).toBe(0);

      // reorg 必须触及 cursor 高度块 2500 才会被哈希连续性校验发现（只
      // 换块 3/2600 时校验在 2500 上照常通过，回滚路径不进入——假绿）。
      // 同时触及块 3（最新锚点）：块 2 仍一致 → 回滚到块 2（更旧锚点）。
      canonicalBlocks = new Map<bigint, Hex>([
        ...canonicalBlocks,
        [3n, blockHashHex("fork-3")],
        [2500n, blockHashHex("fork-2500")],
        [2600n, blockHashHex("fork-2600")]
      ]);
      finalizedBlock = 2600n;
      const result = await indexer.refreshFromCursorWithSummary();

      // 更旧锚点回验路径必须真实进入：探测 reorg 回滚警告。
      expect(rollbackProbe.rollbackCount).toBe(1);
      expect(result.summary.syncStatus).toBe("indexed");
      await expect(store.getCursor({ chainId: 31337, contractAddress: "0x0000000000000000000000000000000000000000" }))
        .resolves.toMatchObject({ nextBlock: 2601n, blockHash: blockHashHex("fork-2600") });
    } finally {
      await store.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
  it("resolves state-machine orders by the (planId, orderId) composite key and fails closed on bare-id ambiguity", async () => {
    // 订单身份是 (planId, orderId)。裸
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

  it("projects OrderForked lineage onto the forked order without landing in the unknown-event bucket", () => {
    // UB-39：fork 单号由 forkOrderIdFor 纯函数派生，血缘只读 OrderForked
    // 事件（REPLACEMENT 退役后非协作换人的唯一车道）。显式投影分支必须
    // 存在——静默落 default 会与真未知事件不可区分（unknownEventCount）。
    const forkedOrderId = "0x0000000000000000000000000000000000000000000000000000000000000212";
    const approvalSourceId = bytes32Hex("8101");
    const approvalSignalId = bytes32Hex("8102");
    const initiator = signer;
    const snapshot = rebuildOrderProjections([
      chainEvent(1n, 0, "PlanRegistered", {
        planId,
        planHash,
        hookCount: 1n
      }),
      chainEvent(2n, 0, "OrderRegistered", {
        orderId: stateMachineOrderId,
        planId
      }),
      chainEvent(3n, 0, "OrderForked", {
        planId,
        orderId: forkedOrderId,
        parentOrderId: stateMachineOrderId,
        approvalSourceId,
        approvalSignalId,
        initiator
      })
    ]);
    const orderKey = stateMachineScopedKey(31337, contractAddress, planId, forkedOrderId);
    const fork = snapshot.stateMachineOrders[orderKey];
    expect(fork).toBeDefined();
    expect(fork?.forkLineage).toMatchObject({
      parentOrderId: stateMachineOrderId,
      approvalSourceId,
      approvalSignalId,
      initiator
    });
    // 父单行不回写血缘：血缘是 fork 单的出生属性。
    const parent = snapshot.stateMachineOrders[
      stateMachineScopedKey(31337, contractAddress, planId, stateMachineOrderId)
    ];
    expect(parent?.forkLineage).toBeUndefined();
    // 显式分支不落未知事件桶。
    expect(snapshot.unknownEventCount).toBe(0);
    expect(fork?.timeline.some((item) => item.text === "订单已从父单分叉")).toBe(true);
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

/** 词表产物富集源 fixture：两表 + 按 compiler 权威实现重算的链上 root。 */
interface VocabularyFixture extends PlanCapabilityTablesInput {
  readonly capabilitiesRoot: Hex;
}

function planVocabulary(input: {
  readonly selectorBindings?: readonly { readonly selectorStageId: string; readonly targetStageId: string }[];
  readonly signalCapabilities?: readonly {
    readonly stageId: string;
    readonly targetSourceId: string;
    readonly signalId: string;
    readonly targetOrderRelation: 0 | 1;
  }[];
}): VocabularyFixture {
  // 夹具常量按 string 声明（bytes32Text/裸字面量产物），此处统一收窄为 Hex。
  const selectorBindings = (input.selectorBindings ?? []).map((binding) => ({
    selectorStageId: binding.selectorStageId as Hex,
    targetStageId: binding.targetStageId as Hex
  }));
  const signalCapabilities = (input.signalCapabilities ?? []).map((capability) => ({
    stageId: capability.stageId as Hex,
    targetSourceId: capability.targetSourceId as Hex,
    signalId: capability.signalId as Hex,
    targetOrderRelation: capability.targetOrderRelation
  }));
  return {
    planId: planId as Hex,
    planHash: planHash as Hex,
    selectorBindings,
    signalCapabilities,
    capabilitiesRoot: capabilitiesRootOf(selectorBindings, signalCapabilities)
  };
}

/**
 * 两步发布真实链序（v0.11）：commitPlan 交易 PlanCommitted →
 * PlanPublisherRecorded；finalizePlan 交易 PlanFinalized → PlanRegistered
 * （finalize 交易内无 plan metadata 模块事件）。
 */
function planPublishEvents(
  vocabulary: VocabularyFixture,
  stateMachineAddress = contractAddress,
  overrides: {
    readonly hooksHash?: Hex;
    readonly dockRoutesRoot?: Hex;
    readonly dockInterfaceRoot?: Hex;
    readonly hookCount?: bigint;
  } = {}
): readonly ChainEvent[] {
  const hooksHash = overrides.hooksHash ?? bytes32Hex("9001");
  const dockRoutesRoot = overrides.dockRoutesRoot ?? bytes32Hex("9003");
  const dockInterfaceRoot = overrides.dockInterfaceRoot ?? bytes32Hex("9004");
  const hookCount = overrides.hookCount ?? 1n;
  return [
    chainEvent(1n, 0, "PlanCommitted", {
      planId,
      planHash,
      publisher: signer,
      hooksHash,
      capabilitiesRoot: vocabulary.capabilitiesRoot,
      hookCount,
      dockRoutesRoot,
      dockInterfaceRoot
    }, stateMachineAddress),
    chainEvent(1n, 1, "PlanPublisherRecorded", {
      planId,
      publisher: signer
    }, stateMachineAddress),
    chainEvent(2n, 0, "PlanFinalized", {
      planId,
      planHash,
      capabilitiesRoot: vocabulary.capabilitiesRoot
    }, stateMachineAddress),
    chainEvent(2n, 1, "PlanRegistered", {
      planId,
      planHash,
      hookCount
    }, stateMachineAddress)
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
      finalityAnchor: "confirmations",
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
      signerPrivateKeyEnv: "GOVERNANCE_SIGNER_PRIVATE_KEY",
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

/** reorg 回滚路径探测：捕获 "rolled back projections after chain reorg" 警告。 */
class ReorgRollbackProbe {
  #rollbacks = 0;

  get rollbackCount(): number {
    return this.#rollbacks;
  }

  warn(message: string): void {
    if (message.includes("rolled back projections after chain reorg")) {
      this.#rollbacks += 1;
    }
  }

  info(): void {
  }

  error(): void {
  }

  debug(): void {
  }
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
