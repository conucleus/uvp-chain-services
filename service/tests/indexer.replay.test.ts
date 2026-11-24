import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  capabilitiesRootOf,
  compileZhixuOnchainHookPlan,
  supplierBindingsRootOf,
  parseZhixuDefinition,
  planIdForPublisher,
  toSolidityRegisterPlanArgs
} from "@uvp-eth/compiler";
import type { ChainServicesConfig } from "../src/config/index.js";
import { IndexerService, type ChainEventSource } from "../src/indexer/service.js";
import { UndecodableChainLogError } from "../src/indexer/viem-event-source.js";
import { rebuildOrderProjections } from "../src/indexer/replay.js";
import type { PlanCapabilityTablesInput } from "../src/indexer/projections/plan.js";
import { stateMachineScopedKey, stateMachineTaskProjectionKey } from "../src/indexer/projections/index.js";
import { createChainServicesStores, type ChainServicesStores } from "../src/storage/factory.js";
import { PostgresProjectionStore } from "../src/storage/postgres.js";
import { PostgresDatabase } from "../src/storage/postgres-client.js";
import { PlanArtifactMissingError, createPlanArtifactResolvers } from "../src/projection/plan-artifacts.js";
import { createPostgresTestDatabase } from "./postgres.js";
import type { Hex } from "@uvp-eth/service-runtime";
import { buildActiveChainEventReplaySummary, sortChainEvents, type ChainEvent } from "../src/indexer/events.js";

let stores: ChainServicesStores;
let projectionDatabaseUrl: string;
let cleanupDatabase: PostgresDatabase;

beforeAll(async () => {
  projectionDatabaseUrl = await createPostgresTestDatabase();
  stores = createChainServicesStores({
    database: { url: projectionDatabaseUrl, migrationsAutoRun: true },
    chainId: 31337
  });
  cleanupDatabase = new PostgresDatabase({ databaseUrl: projectionDatabaseUrl });
});

beforeEach(async () => {
  // 原先每用例各建一个进程内 projection store：同一克隆库内按
  // chainId=31337 清空投影面，等价于每用例的全新空 store。
  await cleanupDatabase.query("DELETE FROM chain_event_log WHERE chain_id = 31337");
  await cleanupDatabase.query("DELETE FROM chain_projection_snapshot WHERE chain_id = 31337");
  await cleanupDatabase.query("DELETE FROM chain_index_cursor WHERE chain_id = 31337");
  await cleanupDatabase.query("DELETE FROM chain_projection_sync_state WHERE chain_id = 31337");
  await cleanupDatabase.query("DELETE FROM indexer_pending_post_commit WHERE chain_id = 31337");
});

afterAll(async () => {
  await cleanupDatabase.close();
  await stores.close();
});


const contractAddress = "0x1111111111111111111111111111111111111111";
const contractAddressV2 = "0x9999999999999999999999999999999999999999";
const deploymentRegistryAddress = "0x8888888888888888888888888888888888888888";
const slotA = "0x2222222222222222222222222222222222222222";
const slotB = "0x3333333333333333333333333333333333333333";
const signer = "0x4444444444444444444444444444444444444444";
const emptyHash = "0x0000000000000000000000000000000000000000000000000000000000000000";
const evidenceHash = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const planId = "0x0000000000000000000000000000000000000000000000000000000000000101";
const stateMachineOrderId = "0x0000000000000000000000000000000000000000000000000000000000000202";
const planHash = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const hookId = "0x0000000000000000000000000000000000000000000000000000000000000303";
const stageId = bytes32Text("stage-example");
const selectorStageId = bytes32Text("stage-selector");
const hookName = bytes32Text("example-review");
const sourceId = "0x0000000000000000000000000000000000000000000000000000000000000404";
const signalId = "0x0000000000000000000000000000000000000000000000000000000000000505";
const payloadHash = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const idempotencyKey = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const patchHash = "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
const identityRegistryAddress = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const stagePatchModuleAddress = "0x6666666666666666666666666666666666666666";
const supplierA = bytes32Hex("5a01");
const supplierB = bytes32Hex("5a02");
const supplierAccountA = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const supplierAccountB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const emptySupplierBindingsRoot = supplierBindingsRootOf([]);
const deploymentIdV1 = "0x0000000000000000000000000000000000000000000000000000000000000d01";
const deploymentIdV2 = "0x0000000000000000000000000000000000000000000000000000000000000d02";
const abiHash = "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

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
    expect(order?.signals[`${sourceId}:${signalId}`]?.submitter).toBe(signer);
    expect(order?.signals[`${sourceId}:${signalId}`]?.relayer).toBe(slotA);
    expect(order?.signals[`${sourceId}:${signalId}`]?.factStageId).toBe(stageId);
    expect(order?.hooks[hookId]?.previousStatus).toBe("waiting");
    expect(order?.stageMaterializations[stageId]).toMatchObject({
      stageId,
      triggerHookId: hookId,
      sourceId,
      signalId
    });
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

  it("rebuilds derived signal params and governance", () => {
    const events: readonly ChainEvent[] = [
      chainEvent(1n, 0, "PlanCommitted", {
        planId,
        planHash,
        publisher: signer,
        hooksHash: bytes32Hex("9001"),
        capabilitiesRoot: emptyHash,
        supplierBindingsRoot: emptySupplierBindingsRoot,
        hookCount: 1n
      }),
      chainEvent(2n, 0, "OrderRegistered", { orderId: stateMachineOrderId, planId }),
      chainEvent(3n, 0, "SignalSubmitted", {
        orderId: stateMachineOrderId,
        sourceId,
        signalId,
        payloadHash,
        idempotencyKey,
        submitter: signer,
        factStageId: stageId
      }),
      chainEvent(4n, 0, "DerivedSignalSubmitted", {
        targetOrderId: stateMachineOrderId,
        targetPlanId: planId,
        fromPlanId: planId,
        fromOrderId: stateMachineOrderId,
        fromStageId: stageId,
        targetSourceId: sourceId,
        signalId,
        payloadHash,
        idempotencyKey,
        submitter: signer,
        relation: 0n
      }),
      chainEvent(5n, 0, "OwnershipTransferred", { previousOwner: signer, newOwner: slotA }),
      chainEvent(6n, 0, "StateMachineModulesFrozen", {
        moduleSetHash: "0x3333333333333333333333333333333333333333333333333333333333333333"
      })
    ];

    const snapshot = rebuildOrderProjections(events);
    const order = snapshot.stateMachineOrders[
      stateMachineScopedKey(31337, contractAddress, planId, stateMachineOrderId)
    ];
    const governanceKey = `31337:${contractAddress}`;

    expect(order?.signals[`${sourceId}:${signalId}`]?.submitter).toBe(signer);
    expect(order?.derivedSignals[`${sourceId}:${signalId}`]).toMatchObject({
      fromPlanId: planId,
      fromOrderId: stateMachineOrderId,
      fromStageId: stageId,
      targetSourceId: sourceId,
      payloadHash,
      relation: "0"
    });
    expect(snapshot.contractGovernance[governanceKey]).toMatchObject({
      owner: slotA,
      modulesFrozen: true
    });
  });

  it("marks HookReady tasks submitted from explicit plan signal capabilities", () => {
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
          signalId
        }
      ],
      proof: expect.objectContaining({
        eventName: "SignalSubmitted",
        transactionHash: chainEvent(5n, 0, "SignalSubmitted", {}).transactionHash
      }),
      updatedAt: {
        chainId: 31337,
        contractAddress,
        blockNumber: 5n,
        transactionHash: chainEvent(5n, 0, "SignalSubmitted", {}).transactionHash,
        logIndex: 0
      }
    });
    expect(task?.updatedAt).not.toHaveProperty("args");
    expect(task?.updatedAt).not.toHaveProperty("eventName");
    expect(task?.proof).not.toEqual(task?.updatedAt);
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

  it("replays stage supplier patches, dock selections, and supplier status changes into supplier accounts and task assignees", () => {
    const dockHookId = bytes32Hex("0606");
    const dockStageId = bytes32Text("stage-dock");
    const dynamicStageId = bytes32Text("stage-dynamic");
    const dockId = bytes32Hex("0d0d");
    const stagePatchModuleId = bytes32Text("uvp.module.stage-patch.v1");
    const vocabulary = planVocabulary({
      signalCapabilities: [{ stageId, targetSourceId: sourceId, signalId, targetOrderRelation: 0 }],
      supplierBindings: [
        { stageId, supplierId: supplierA, kind: 0 },
        { stageId, supplierId: supplierB, kind: 1 }
      ],
      dynamicSupplierStages: [dynamicStageId]
    });
    const events: readonly ChainEvent[] = [
      ...planPublishEvents(vocabulary),
      chainEvent(1n, 2, "StateMachineModuleSet", {
        moduleId: stagePatchModuleId,
        previousModule: "0x0000000000000000000000000000000000000000",
        newModule: stagePatchModuleAddress
      }),
      chainEvent(1n, 3, "SupplierRegistered", {
        supplierId: supplierA,
        account: supplierAccountA
      }, identityRegistryAddress),
      chainEvent(1n, 4, "SupplierRegistered", {
        supplierId: supplierB,
        account: supplierAccountB
      }, identityRegistryAddress),
      chainEvent(1n, 5, "SupplierStatusChanged", {
        supplierId: supplierA,
        previousStatus: 0n,
        newStatus: 1n,
        account: supplierAccountA
      }, identityRegistryAddress),
      chainEvent(1n, 6, "SupplierStatusChanged", {
        supplierId: supplierB,
        previousStatus: 0n,
        newStatus: 1n,
        account: supplierAccountB
      }, identityRegistryAddress),
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
      chainEvent(4n, 1, "HookReady", {
        orderId: stateMachineOrderId,
        hookId: dockHookId,
        stageId: dockStageId,
        hookName
      }),
      chainEvent(5n, 0, "StageSupplierAssigned", {
        planId,
        orderId: stateMachineOrderId,
        targetStageId: stageId,
        supplierId: supplierB,
        patchNonce: 1n
      }),
      chainEvent(5n, 1, "StageSupplierPatchApplied", {
        planId,
        orderId: stateMachineOrderId,
        selectorStageId,
        targetStageId: stageId,
        selector: signer,
        supplierId: supplierB,
        previousSupplierId: supplierA,
        patchNonce: 1n
      }, stagePatchModuleAddress),
      chainEvent(7n, 0, "StageSupplierAssigned", {
        planId,
        orderId: stateMachineOrderId,
        targetStageId: dockStageId,
        supplierId: supplierA,
        patchNonce: 1n
      }),
      chainEvent(7n, 1, "StageDockSupplierSelected", {
        planId,
        orderId: stateMachineOrderId,
        targetStageId: dockStageId,
        dockId,
        supplierId: supplierA,
        patchNonce: 1n
      }, stagePatchModuleAddress)
    ];

    const snapshot = rebuildOrderProjections(events, { planCapabilityTables: [vocabulary] });
    const orderKey = stateMachineScopedKey(31337, contractAddress, planId, stateMachineOrderId);
    const planKey = stateMachineScopedKey(31337, contractAddress, planId);
    const order = snapshot.stateMachineOrders[orderKey];
    const plan = snapshot.stateMachinePlans[planKey];
    const targetTask = snapshot.stateMachineTasks[stateMachineTaskProjectionKey(31337, contractAddress, planId, stateMachineOrderId, hookId)];
    const dockTask = snapshot.stateMachineTasks[stateMachineTaskProjectionKey(31337, contractAddress, planId, stateMachineOrderId, dockHookId)];

    expect(order?.stageSupplierAssignments[stageId]).toMatchObject({
      orderId: stateMachineOrderId,
      selectorStageId,
      targetStageId: stageId,
      selector: signer,
      supplierId: supplierB,
      previousSupplierId: supplierA,
      patchNonce: "1",
      supplierAccount: supplierAccountB,
      activatedAt: expect.objectContaining({ blockNumber: 5n }),
      activationProof: expect.objectContaining({ eventName: "StageSupplierAssigned" }),
      proof: expect.objectContaining({ eventName: "StageSupplierPatchApplied" })
    });
    expect(order?.stageSupplierAssignments[dockStageId]).toMatchObject({
      targetStageId: dockStageId,
      supplierId: supplierA,
      patchNonce: "1",
      dockId,
      supplierAccount: supplierAccountA,
      activationProof: expect.objectContaining({ eventName: "StageSupplierAssigned" })
    });
    expect(order?.stageSupplierAssignments[dockStageId]?.selectorStageId).toBeUndefined();
    expect(plan?.supplierBindings).toEqual([
      { stageId, supplierId: supplierA, kind: "default" },
      { stageId, supplierId: supplierB, kind: "candidate" }
    ]);
    expect(plan?.dynamicSupplierStages).toEqual([dynamicStageId]);
    expect(snapshot.stateMachineSuppliers[supplierA]).toMatchObject({
      supplierId: supplierA,
      account: supplierAccountA,
      status: "active",
      registeredAt: expect.objectContaining({ blockNumber: 1n }),
      proof: expect.objectContaining({ eventName: "SupplierRegistered" }),
      statusChangedAt: expect.objectContaining({ blockNumber: 1n }),
      statusChangedProof: expect.objectContaining({ eventName: "SupplierStatusChanged" })
    });
    expect(snapshot.stateMachineSuppliers[supplierB]).toMatchObject({
      account: supplierAccountB,
      status: "active"
    });
    expect(targetTask).toMatchObject({
      assigneeSupplierId: supplierB,
      assigneeSupplierAccount: supplierAccountB
    });
    expect(dockTask).toMatchObject({
      assigneeSupplierId: supplierA,
      assigneeSupplierAccount: supplierAccountA
    });
    expect(order?.proof.filter((proof) => proof.eventName === "StageSupplierAssigned")).toHaveLength(2);
    expect(order?.timeline.map((event) => event.eventName)).toContain("StageSupplierPatchApplied");
    expect(snapshot.unresolvedModuleOrderEventCount).toBe(0);
    expect(snapshot.unresolvedStageActivationEventCount).toBe(0);

    const revoked = rebuildOrderProjections([
      ...events,
      chainEvent(8n, 0, "SupplierStatusChanged", {
        supplierId: supplierB,
        previousStatus: 1n,
        newStatus: 3n,
        account: supplierAccountB
      }, identityRegistryAddress)
    ], { planCapabilityTables: [vocabulary] });
    const revokedOrder = revoked.stateMachineOrders[orderKey];
    const revokedTask = revoked.stateMachineTasks[stateMachineTaskProjectionKey(31337, contractAddress, planId, stateMachineOrderId, hookId)];

    expect(revoked.stateMachineSuppliers[supplierB]).toMatchObject({
      account: supplierAccountB,
      status: "revoked",
      revokedAt: expect.objectContaining({ blockNumber: 8n }),
      revocationProof: expect.objectContaining({ eventName: "SupplierStatusChanged" })
    });
    expect(revokedOrder?.stageSupplierAssignments[stageId]?.supplierAccount).toBe(supplierAccountB);
    expect(revokedTask?.assigneeSupplierId).toBe(supplierB);
    expect(revokedTask?.assigneeSupplierAccount).toBe(supplierAccountB);
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
        fromPlanId: planId,
        fromStageId: selectorStageId,
        targetOrderId: stateMachineOrderId,
        targetSourceId: sourceId,
        signalId,
        payloadHash,
        idempotencyKey,
        submitter: signer,
        relation: 0n
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
    expect(order?.tasks[taskKey]?.updatedAt).toEqual({
      chainId: 31337,
      contractAddress,
      blockNumber: 4n,
      transactionHash: chainEvent(4n, 0, "HookStatusChanged", {}).transactionHash,
      logIndex: 0
    });
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

    const store = stores.projectionStore;
    await store.resetFromEvents({ deploymentBlock: 0n, events });
    await expect(store.findStateMachineOrdersByOrderId(stateMachineOrderId)).resolves.toHaveLength(2);
  });

  it("projects state-machine module and plan publisher provenance", () => {
    const moduleId = bytes32Text("uvp.module.stage-patch.v1") as `0x${string}`;
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

  it("counts module order events that cannot be attributed to a state machine instead of silently bucketing", () => {
    const unregisteredModuleAddress = "0x7777777777777777777777777777777777777777";
    const events: readonly ChainEvent[] = [
      chainEvent(1n, 0, "StageSupplierPatchApplied", {
        planId,
        orderId: stateMachineOrderId,
        selectorStageId,
        targetStageId: stageId,
        selector: signer,
        supplierId: supplierA,
        previousSupplierId: emptyHash,
        patchNonce: 1n
      }, unregisteredModuleAddress)
    ];

    const snapshot = rebuildOrderProjections(events);

    expect(snapshot.unresolvedModuleOrderEventCount).toBe(1);
    expect(Object.keys(snapshot.stateMachineOrders)).toEqual([
      stateMachineScopedKey(31337, unregisteredModuleAddress, planId, stateMachineOrderId)
    ]);
  });

  it("counts genuinely unknown events instead of silently skipping them", () => {
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
    expect(Object.keys(snapshot.stateMachineOrders)).toEqual([]);
    expect(Object.keys(snapshot.stateMachineModules)).toEqual([]);
  });

  it("enriches the same planId on every deployment from the artifact vocabulary (content-scoped, not address-scoped)", () => {
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
    const store = stores.projectionStore;
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
    const store = new PostgresProjectionStore({
      databaseUrl: projectionDatabaseUrl,
      chainId: 31337
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
    const store = stores.projectionStore;
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
    const store = new PostgresProjectionStore({
      databaseUrl: projectionDatabaseUrl,
      chainId: 31337
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

  it("fails an incremental refresh closed without advancing the cursor or replacing the projection when a log is undecodable", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "uvp-indexer-undecodable-"));
    const store = new PostgresProjectionStore({
      databaseUrl: projectionDatabaseUrl,
      chainId: 31337
    });
    try {
      const events = stateMachineEvents();
      let finalizedBlock = 3n;
      let failReads = false;
      const eventSource: ChainEventSource = {
        async getFinalizedBlock() {
          return finalizedBlock;
        },
        async readEvents(range) {
          if (failReads) {
            throw new UndecodableChainLogError({
              chainId: 31337,
              contract: "UVPStateMachine",
              address: contractAddress,
              blockNumber: 5n,
              transactionHash: bytes32Hex("e1"),
              logIndex: 0
            });
          }
          return events.filter((event) => event.blockNumber >= range.fromBlock && event.blockNumber <= range.toBlock);
        }
      };
      const indexer = new IndexerService({
        config: testConfig(),
        eventSource,
        store
      });

      await indexer.rebuildFromDeploymentBlockWithSummary();
      const scope = { chainId: 31337, contractAddress: "0x0000000000000000000000000000000000000000" as const };
      const cursorBefore = await store.getCursor(scope);
      const snapshotBefore = await store.getOrderSnapshot();
      expect(cursorBefore).toMatchObject({ nextBlock: 4n, finalizedBlock: 3n });

      finalizedBlock = 7n;
      failReads = true;
      await expect(indexer.refreshFromCursorWithSummary()).rejects.toMatchObject({
        name: "UndecodableChainLogError",
        contract: "UVPStateMachine",
        blockNumber: 5n
      });

      await expect(store.getCursor(scope)).resolves.toEqual(cursorBefore);
      await expect(store.getOrderSnapshot()).resolves.toEqual(snapshotBefore);
      await expect(store.getSyncState()).resolves.toMatchObject({
        syncStatus: "degraded",
        rebuild: { status: "failed" }
      });
    } finally {
      await store.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps enriched plan capability tables across a restart and an incremental refresh without new plan events", async () => {    const tempDir = mkdtempSync(join(tmpdir(), "uvp-indexer-enrichment-restart-"));
    const store = new PostgresProjectionStore({
      databaseUrl: projectionDatabaseUrl,
      chainId: 31337
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
      const resolver = vocabularyResolver(vocabulary);

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

  it("aborts the rebuild closed when the plan vocabulary resolver fails and recovers once it resolves", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "uvp-indexer-enrichment-failed-"));
    const store = new PostgresProjectionStore({
      databaseUrl: projectionDatabaseUrl,
      chainId: 31337
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
      const healthyResolver = vocabularyResolver(vocabulary);

      const failingIndexer = new IndexerService({
        config: testConfig(),
        eventSource,
        store,
        resolvePlanCapabilityTables: async () => {
          throw new PlanArtifactMissingError({ chainId: 31337, planId, planHash });
        }
      });
      await expect(failingIndexer.rebuildFromDeploymentBlockWithSummary()).rejects.toThrow(PlanArtifactMissingError);
      await expect(store.getSyncState()).resolves.toMatchObject({
        syncStatus: "degraded",
        rebuild: { status: "failed" }
      });

      finalizedBlock = 4n;
      const laterOrderEvent = chainEvent(4n, 0, "OrderRegistered", {
        orderId: "0x0000000000000000000000000000000000000000000000000000000000000305",
        planId
      });
      eventSource.readEvents = async (range) => [...planEvents, laterOrderEvent].filter(
        (event) => event.blockNumber >= range.fromBlock && event.blockNumber <= range.toBlock
      );
      const recoveredIndexer = new IndexerService({
        config: testConfig(),
        eventSource,
        store,
        resolvePlanCapabilityTables: healthyResolver
      });
      const refreshed = await recoveredIndexer.rebuildFromDeploymentBlockWithSummary();
      const planKey = stateMachineScopedKey(31337, contractAddress, planId);

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

  it("fails the rebuild closed without the recorded plan artifact and enriches from it once recorded", async () => {
    const artifact = compileZhixuOnchainHookPlan(parseZhixuDefinition(planArtifactZhixuYaml, "plan-artifact.yaml"));
    const registerArgs = toSolidityRegisterPlanArgs(artifact);
    const planHash = registerArgs.planHash as Hex;
    const planId = planIdForPublisher(signer, planHash) as Hex;
    const events: readonly ChainEvent[] = [
      chainEvent(1n, 0, "PlanCommitted", {
        planId,
        planHash,
        publisher: signer,
        hooksHash: registerArgs.hooksHash,
        capabilitiesRoot: registerArgs.capabilitiesRoot,
        supplierBindingsRoot: registerArgs.supplierBindingsRoot,
        hookCount: BigInt(artifact.compiledHooks.length)
      }),
      chainEvent(2n, 0, "PlanFinalized", { planId, planHash, capabilitiesRoot: registerArgs.capabilitiesRoot }),
      chainEvent(2n, 1, "PlanRegistered", { planId, planHash, hookCount: BigInt(artifact.compiledHooks.length) })
    ];
    const eventSource: ChainEventSource = {
      async getFinalizedBlock() {
        return 3n;
      },
      async readEvents() {
        return events;
      }
    };
    const resolvers = createPlanArtifactResolvers({
      store: stores.planArtifactStore,
      chainId: 31337
    });
    const missingArtifactIndexer = new IndexerService({
      config: testConfig(),
      eventSource,
      store: stores.projectionStore,
      resolvePlanCapabilityTables: resolvers.resolvePlanCapabilityTables
    });
    await expect(missingArtifactIndexer.rebuildFromDeploymentBlockWithSummary())
      .rejects.toThrow(PlanArtifactMissingError);
    await expect(stores.projectionStore.getSyncState()).resolves.toMatchObject({
      syncStatus: "degraded",
      rebuild: { status: "failed" }
    });

    await stores.planArtifactStore.put({ chainId: 31337, planId, planHash, artifact });

    const indexer = new IndexerService({
      config: testConfig(),
      eventSource,
      store: stores.projectionStore,
      resolvePlanCapabilityTables: resolvers.resolvePlanCapabilityTables
    });
    const rebuilt = await indexer.rebuildFromDeploymentBlockWithSummary();
    const planKey = stateMachineScopedKey(31337, contractAddress, planId);

    expect(rebuilt.snapshot.stateMachinePlans[planKey]?.capabilityEnrichment).toBe("enriched");
    expect(rebuilt.snapshot.stateMachinePlans[planKey]?.signalCapabilities).toHaveLength(
      artifact.signalCapabilities.length
    );
    expect(rebuilt.snapshot.stateMachinePlans[planKey]?.supplierBindingsRoot).toBe(
      registerArgs.supplierBindingsRoot
    );
    expect(
      rebuilt.snapshot.stateMachinePlans[planKey]?.supplierBindings.map((binding) => ({
        stageId: binding.stageId,
        supplierId: binding.supplierId,
        kind: binding.kind
      }))
    ).toEqual(
      registerArgs.supplierBindings.map((binding) => ({
        stageId: binding.stageId,
        supplierId: binding.supplierId,
        kind: binding.kind === 0 ? "default" : "candidate"
      }))
    );
    expect(rebuilt.snapshot.capabilityEnrichmentMismatchCount).toBe(0);
  });

  it("re-enriches the plan vocabulary from surviving events when a restarted indexer rolls back after a reorg", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "uvp-indexer-enrichment-reorg-"));
    const store = new PostgresProjectionStore({
      databaseUrl: projectionDatabaseUrl,
      chainId: 31337
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
      const resolver = vocabularyResolver(vocabulary, () => {
        resolverCalls += 1;
      });

      const firstIndexer = new IndexerService({
        config: testConfig(),
        eventSource,
        store,
        resolvePlanCapabilityTables: resolver
      });
      const rebuilt = await firstIndexer.rebuildFromDeploymentBlockWithSummary();
      const planKey = stateMachineScopedKey(31337, contractAddress, planId);
      expect(rebuilt.snapshot.stateMachinePlans[planKey]?.selectorBindings).toHaveLength(1);

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
      expect(resolverCalls).toBeGreaterThan(0);
      await expect(store.listEvents({ chainId: 31337 })).resolves.toHaveLength(planEvents.length);
    } finally {
      await store.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("re-resolves the corrected artifact on the next round in the same process after a mismatch", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "uvp-indexer-enrichment-evict-"));
    const store = new PostgresProjectionStore({
      databaseUrl: projectionDatabaseUrl,
      chainId: 31337
    });
    try {
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
      const resolver = async (anchorPlanId: Hex, anchorPlanHash: Hex): Promise<PlanCapabilityTablesInput> => {
        resolverCalls += 1;
        if (anchorPlanId.toLowerCase() !== planId.toLowerCase() || anchorPlanHash.toLowerCase() !== planHash.toLowerCase()) {
          throw new Error(`unexpected plan anchor ${anchorPlanId}:${anchorPlanHash}`);
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
        entry.message.includes("plan artifact vocabulary failed the on-chain anchor assertion") &&
        entry.context?.planIds
      )).toBe(true);

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
    const tempDir = mkdtempSync(join(tmpdir(), "uvp-indexer-enrichment-idle-"));
    const store = new PostgresProjectionStore({
      databaseUrl: projectionDatabaseUrl,
      chainId: 31337
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
      const resolver = vocabularyResolver(vocabulary, () => {
        resolverCalls += 1;
      });

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
    const tempDir = mkdtempSync(join(tmpdir(), "uvp-indexer-early-exit-residue-"));
    const store = new PostgresProjectionStore({
      databaseUrl: projectionDatabaseUrl,
      chainId: 31337
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

      const ghostOrderId = "0x000000000000000000000000000000000000000000000000000000000000e101";
      await store.appendEvent(chainEvent(8n, 0, "OrderRegistered", { orderId: ghostOrderId, planId }));

      finalizedBlock = 9n;
      const refreshed = await indexer.refreshFromCursorWithSummary();

      expect(infos.some((message) => message.includes("indexer incrementally refreshed projections"))).toBe(true);
      expect(infos.some((message) => message.includes("indexer skipped the full replay"))).toBe(false);
      expect(warns.some((message) => message.includes("swept committed-but-unadvanced event rows"))).toBe(true);

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
    const tempDir = mkdtempSync(join(tmpdir(), "uvp-indexer-early-exit-cas-"));
    const store = new PostgresProjectionStore({
      databaseUrl: projectionDatabaseUrl,
      chainId: 31337
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

      expect(infos.some((message) => message.includes("indexer incrementally refreshed projections"))).toBe(true);
      expect(infos.some((message) => message.includes("indexer skipped the full replay"))).toBe(false);
      expect(indexer.cursor?.nextBlock).toBe(50n);
      expect(warns.some((message) => message.includes("cursor moved by another writer during refresh"))).toBe(true);
      await expect(store.listEvents({ chainId: 31337 })).resolves.toHaveLength(9);
    } finally {
      await store.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("replays the full path on the first zero-new-events round after a restart broke the enrichment cache coverage", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "uvp-indexer-early-exit-cold-"));
    const store = new PostgresProjectionStore({
      databaseUrl: projectionDatabaseUrl,
      chainId: 31337
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
      const resolver = vocabularyResolver(vocabulary, () => {
        resolverCalls += 1;
      });
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
    const tempDir = mkdtempSync(join(tmpdir(), "uvp-indexer-reorg-"));
    const store = new PostgresProjectionStore({
      databaseUrl: projectionDatabaseUrl,
      chainId: 31337
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

      canonicalBlocks = new Map<bigint, Hex>([
        [1n, blockHashHex("block-1")],
        [2n, blockHashHex("block-2")],
        [3n, blockHashHex("block-3-fork")],
        [4n, blockHashHex("block-4-fork")]
      ]);
      readableEvents = [...canonicalEvents.map((event, index) => ({ ...event, blockHash: blockHashHex(`block-${index + 1}`) })), forkedBlock3Event, forkedBlock4Event];
      finalizedBlock = 4n;

      const result = await indexer.refreshFromCursorWithSummary();

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
    const tempDir = mkdtempSync(join(tmpdir(), "uvp-indexer-crash-window-"));
    const store = new PostgresProjectionStore({
      databaseUrl: projectionDatabaseUrl,
      chainId: 31337
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

      finalizedBlock = 4n;
      readableEvents = [...stableEvents, canonicalBlock4Event];

      const result = await indexer.refreshFromCursorWithSummary();

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
    const tempDir = mkdtempSync(join(tmpdir(), "uvp-indexer-reorg-pending-"));
    const store = new PostgresProjectionStore({
      databaseUrl: projectionDatabaseUrl,
      chainId: 31337
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
    const tempDir = mkdtempSync(join(tmpdir(), "uvp-indexer-reorg-deep-"));
    const store = new PostgresProjectionStore({
      databaseUrl: projectionDatabaseUrl,
      chainId: 31337
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

      canonicalBlocks = new Map<bigint, Hex>(
        [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n].map((block) => [block, blockHashHex(`fork-${block}`)])
      );
      finalizedBlock = 8n;

      await expect(indexer.refreshFromCursorWithSummary()).rejects.toThrow(
        /reorg deeper than the stored projection history; full projection rebuild is required/
      );
    } finally {
      await store.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("reports real replay anomalies in rebuild mismatchCount instead of a hardcoded zero", async () => {
    const events = stateMachineEvents();
    const duplicated = [...events, events[2]!];
    const store = stores.projectionStore;
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

    const degradedStore = stores.projectionStore;
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


  it("refreshIfIdle queues one follow-up rebuild when one is already in progress", async () => {
    const store = stores.projectionStore;
    await store.resetFromEvents({ deploymentBlock: 0n, events: [] });

    let readCount = 0;
    let unblock: (() => void) | undefined;
    const blocker = new Promise<void>((resolve) => { unblock = resolve; });
    // PG 化后首轮 refresh 会把游标推到 finalized+1；队列里的后续 refresh 只有在
    // 链上定稿高度继续前进时才会再读事件。首次 fetch（refresh #1 的
    // #refreshFromCursor 取一次；无游标回落复用该值，不再二次请求）返回 9n，
    // 其后返回 10n，正好让排队的后续 refresh 再读一轮。
    let finalizedCalls = 0;
    const eventSource: ChainEventSource = {
      async getFinalizedBlock() {
        finalizedCalls += 1;
        if (finalizedCalls === 1) {
          await blocker;
        }
        return finalizedCalls <= 1 ? 9n : 10n;
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
    const tempDir = mkdtempSync(join(tmpdir(), "uvp-indexer-guard-"));
    const store = new PostgresProjectionStore({
      databaseUrl: projectionDatabaseUrl,
      chainId: 31337
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
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(readLog).toEqual(["0-7"]);

      unblockRebuild!();
      const { summary } = await rebuildPromise;
      expect(summary.syncStatus).toBe("indexed");

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
    const tempDir = mkdtempSync(join(tmpdir(), "uvp-indexer-cas-"));
    const store = new PostgresProjectionStore({
      databaseUrl: projectionDatabaseUrl,
      chainId: 31337
    });
    try {
      const events = stateMachineEvents();
      const eventSource: ChainEventSource = {
        async getFinalizedBlock() {
          return 7n;
        },
        async readEvents(range) {
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
    const store = stores.projectionStore;
    await store.resetFromEvents({ deploymentBlock: 0n, events: [] });

    const baseEvents = [
      ...stateMachineEvents(),
      chainEvent(2n, 1, "OrderRelayerRecorded", {
        orderId: stateMachineOrderId,
        planId,
        relayer: slotB
      })
    ];
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
    // 同上：首轮 refresh（含无游标回落触发的整段重建）定稿在 9n 并把游标推到
    // 10；后续 refresh 在 10n 定稿高度上再读一轮，才看得到 finalSubmit。
    let finalizedCalls = 0;
    const eventSource: ChainEventSource = {
      async getFinalizedBlock() {
        finalizedCalls += 1;
        return finalizedCalls <= 1 ? 9n : 10n;
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
    // readCount 在第二次 readEvents 入口即自增，增量投影事务可能尚未提交；
    // 等待第二轮 refresh 的同步态（finalizedBlock=10n）落库后再取 proof。
    for (
      let attempt = 0;
      attempt < 50 && (await store.getSyncState())?.finalizedBlock !== 10n;
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const orders = await store.findStateMachineOrdersByOrderId(stateMachineOrderId);
    const signals = orders.flatMap((order) => Object.values(order.signals));
    expect(signals).toContainEqual(expect.objectContaining({
      submittedAt: expect.objectContaining({ transactionHash: finalSubmit.transactionHash })
    }));
  });

  it("passes finalized SignalSubmitted events to the notification processor after projection commit", async () => {
    const store = stores.projectionStore;
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
    const store = stores.projectionStore;
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
    const relayerRecorded = {
      ...chainEvent(2n, 1, "OrderRelayerRecorded", {
        orderId: queuedOrderId,
        planId,
        relayer: slotB
      }),
      transactionHash: registerTxHash
    };
    let readCount = 0;
    let unblock: (() => void) | undefined;
    const blocker = new Promise<void>((resolve) => { unblock = resolve; });
    // 同上：首轮 refresh（含无游标回落触发的整段重建）定稿在 2n 并把游标推到
    // 3；后续 refresh 在 3n 定稿高度上再读一轮，才看得到 registered/relayerRecorded。
    let finalizedCalls = 0;
    const eventSource: ChainEventSource = {
      async getFinalizedBlock() {
        finalizedCalls += 1;
        return finalizedCalls <= 1 ? 2n : 3n;
      },
      async readEvents(_range) {
        readCount++;
        if (readCount === 1) {
          await blocker;
          return baseEvents;
        }
        return [...baseEvents, registered, relayerRecorded];
      }
    };

    const indexer = new IndexerService({ config: testConfig(), eventSource, store });

    indexer.refreshIfIdle();
    indexer.refreshIfIdle();
    unblock!();
    await waitForCondition(() => readCount === 2);
    // 同上：等第二轮 refresh 的同步态（finalizedBlock=3n）落库后再取 proof。
    for (
      let attempt = 0;
      attempt < 50 && (await store.getSyncState())?.finalizedBlock !== 3n;
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const orders = await store.findStateMachineOrdersByOrderId(queuedOrderId);
    expect(orders).toContainEqual(expect.objectContaining({
      registeredAt: expect.objectContaining({ transactionHash: registerTxHash })
    }));
  });

  it("refreshIfIdle resets rebuilding flag after error so next call can proceed", async () => {
    const store = stores.projectionStore;
    await store.resetFromEvents({ deploymentBlock: 0n, events: [] });
    // 无游标时一次 refresh 只取一次 finalizedBlock：#refreshFromCursor 取一次，
    // 回落的 #rebuildFromDeploymentBlock 复用该值，不再二次请求。两次 refresh
    // 合计 callCount 应为 2（第一次抛错转 degraded，第二次走回落重建转 indexed）；
    // 若回落路径恢复双取，callCount 会回到 3，用例即失败。

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
    const hooksHash = bytes32Hex("9001");
    const vocabulary = planVocabulary({
      selectorBindings: [{ selectorStageId, targetStageId: stageId }],
      signalCapabilities: [{ stageId, targetSourceId: sourceId, signalId, targetOrderRelation: 0 }]
    });
    const events: readonly ChainEvent[] = [
      ...planPublishEvents(vocabulary, contractAddress, {
        hooksHash,
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
      supplierBindingsRoot: vocabulary.supplierBindingsRoot,
      hooksHash
    });
    expect(plan?.committedAt).toMatchObject({ blockNumber: 1n, logIndex: 0 });
    expect(plan?.finalizedAt).toMatchObject({ blockNumber: 2n, logIndex: 0 });
    expect(plan?.registeredAt).toMatchObject({ blockNumber: 2n, logIndex: 1 });
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
    expect(plan?.supplierBindings).toEqual([]);
    expect(plan?.dynamicSupplierStages).toBeUndefined();
    expect(plan?.capabilityEnrichment).toBe("enriched");
  });

  it("keeps the plan vocabulary empty and counts a mismatch when the artifact root diverges from the chain root", () => {
    const chainVocabulary = planVocabulary({
      signalCapabilities: [{ stageId, targetSourceId: sourceId, signalId, targetOrderRelation: 0 }]
    });
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

  it("marks the vocabulary failed when no plan artifact table backs the plan instead of claiming an empty vocabulary", () => {
    const chainVocabulary = planVocabulary({});
    const events: readonly ChainEvent[] = [
      ...planPublishEvents(chainVocabulary)
    ];

    const snapshot = rebuildOrderProjections(events);
    const plan = snapshot.stateMachinePlans[stateMachineScopedKey(31337, contractAddress, planId)];

    expect(plan?.signalCapabilities).toHaveLength(0);
    expect(plan?.selectorBindings).toHaveLength(0);
    expect(snapshot.capabilityEnrichmentMismatchCount).toBe(1);
    expect(plan?.capabilityEnrichment).toBe("failed");
  });

  it("recovers from a shallow reorg on a quiet chain whose stored events are far below the backtrack window", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "uvp-indexer-reorg-quiet-"));
    const store = new PostgresProjectionStore({
      databaseUrl: projectionDatabaseUrl,
      chainId: 31337
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
      await expect(store.getCursor({ chainId: 31337, contractAddress: "0x0000000000000000000000000000000000000000" }))
        .resolves.toMatchObject({ nextBlock: 2501n, blockHash: blockHashHex("orig-2500") });
      expect(rollbackProbe.rollbackCount).toBe(0);

      canonicalBlocks = new Map<bigint, Hex>([
        ...canonicalBlocks,
        [2500n, blockHashHex("fork-2500")],
        [2600n, blockHashHex("fork-2600")]
      ]);
      finalizedBlock = 2600n;
      const result = await indexer.refreshFromCursorWithSummary();

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
    const tempDir = mkdtempSync(join(tmpdir(), "uvp-indexer-pending-"));
    const store = new PostgresProjectionStore({
      databaseUrl: projectionDatabaseUrl,
      chainId: 31337
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

      deliveryDown = false;
      const sweepSummary = await indexer.sweepPendingPostCommitSteps();
      expect(sweepSummary).toMatchObject({ swept: 1, delivered: 1, failed: 0 });
      expect(deliveredBatches.length).toBe(1);
      await expect(indexer.listPendingPostCommitSteps()).resolves.toEqual([]);

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
    const tempDir = mkdtempSync(join(tmpdir(), "uvp-indexer-finality-wait-"));
    const store = new PostgresProjectionStore({
      databaseUrl: projectionDatabaseUrl,
      chainId: 31337
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
          }
        }
      });
      await indexer.rebuildFromDeploymentBlockWithSummary();

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
    const tempDir = mkdtempSync(join(tmpdir(), "uvp-indexer-rebuild-ghost-"));
    const store = new PostgresProjectionStore({
      databaseUrl: projectionDatabaseUrl,
      chainId: 31337
    });
    try {
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
      const ghostEventKey = ghostEvent && `${ghostEvent.transactionHash}:${ghostEvent.logIndex}`;
      expect(ghostEventKey).toBeDefined();

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

      await expect(recoveringIndexer.listPendingPostCommitSteps()).resolves.toEqual([]);
      const sweepSummary = await recoveringIndexer.sweepPendingPostCommitSteps();
      expect(sweepSummary).toMatchObject({ swept: 0, delivered: 0, failed: 0, ghostDropped: 0 });
      const deliveredEventKeys = deliveredBatches.flat().map((event) => `${event.transactionHash}:${event.logIndex}`);
      expect(deliveredEventKeys).not.toContain(ghostEventKey);
    } finally {
      await store.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("dead-letters ghost notification batches at sweep time instead of delivering them", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "uvp-indexer-sweep-ghost-"));
    const store = new PostgresProjectionStore({
      databaseUrl: projectionDatabaseUrl,
      chainId: 31337
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
    const tempDir = mkdtempSync(join(tmpdir(), "uvp-indexer-sweep-tombstone-"));
    const store = new PostgresProjectionStore({
      databaseUrl: projectionDatabaseUrl,
      chainId: 31337
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
    const store = stores.projectionStore;
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
    const tempDir = mkdtempSync(join(tmpdir(), "uvp-indexer-automation-pending-"));
    const store = new PostgresProjectionStore({
      databaseUrl: projectionDatabaseUrl,
      chainId: 31337
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
    const tempDir = mkdtempSync(join(tmpdir(), "uvp-indexer-notify-order-"));
    const store = new PostgresProjectionStore({
      databaseUrl: projectionDatabaseUrl,
      chainId: 31337
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
      await indexer.rebuildFromDeploymentBlockWithSummary();
      expect(cursorNextBlockAtNotification).toEqual([10n]);
      await expect(store.getCursor(scope)).resolves.toMatchObject({ nextBlock: 10n });

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
    const tempDir = mkdtempSync(join(tmpdir(), "uvp-indexer-reorg-older-anchor-"));
    const store = new PostgresProjectionStore({
      databaseUrl: projectionDatabaseUrl,
      chainId: 31337
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

      canonicalBlocks = new Map<bigint, Hex>([
        ...canonicalBlocks,
        [3n, blockHashHex("fork-3")],
        [2500n, blockHashHex("fork-2500")],
        [2600n, blockHashHex("fork-2600")]
      ]);
      finalizedBlock = 2600n;
      const result = await indexer.refreshFromCursorWithSummary();

      expect(rollbackProbe.rollbackCount).toBe(1);
      expect(result.summary.syncStatus).toBe("indexed");
      await expect(store.getCursor({ chainId: 31337, contractAddress: "0x0000000000000000000000000000000000000000" }))
        .resolves.toMatchObject({ nextBlock: 2601n, blockHash: blockHashHex("fork-2600") });
    } finally {
      await store.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
  it("rebuilds a missing projection snapshot on a zero-new-events round instead of reporting it current", async () => {
    const store = stores.projectionStore;
    const planEvents: readonly ChainEvent[] = [
      chainEvent(1n, 0, "PlanRegistered", { planId, planHash, hookCount: 0n }),
      chainEvent(2n, 0, "OrderRegistered", { orderId: stateMachineOrderId, planId })
    ];
    const eventSource: ChainEventSource = {
      async getFinalizedBlock() {
        return 2n;
      },
      async readEvents(range) {
        return planEvents.filter(
          (event) => event.blockNumber >= range.fromBlock && event.blockNumber <= range.toBlock
        );
      }
    };
    const indexer = new IndexerService({
      config: testConfig(),
      eventSource,
      store
    });

    await indexer.rebuildFromDeploymentBlockWithSummary();
    await cleanupDatabase.query("DELETE FROM chain_projection_snapshot WHERE chain_id = 31337");
    await expect(store.hasProjectionSnapshot("order")).resolves.toBe(false);
    eventSource.getFinalizedBlock = async () => 3n;
    eventSource.readEvents = async () => [];

    const result = await indexer.refreshFromCursorWithSummary();

    await expect(store.hasProjectionSnapshot("order")).resolves.toBe(true);
    expect(result.summary.syncStatus).toBe("indexed");
    expect(result.snapshot.stateMachineOrders[
      stateMachineScopedKey(31337, contractAddress, planId, stateMachineOrderId)
    ]).toMatchObject({ orderId: stateMachineOrderId, planId });
  });

  it("treats DockOutputDeferred as a known dock event instead of an unknown event", () => {
    const snapshot = rebuildOrderProjections([
      chainEvent(1n, 0, "PlanRegistered", { planId, planHash, hookCount: 0n }),
      chainEvent(2n, 0, "OrderRegistered", { orderId: stateMachineOrderId, planId }),
      chainEvent(3n, 0, "DockOutputDeferred", {
        planId,
        orderId: stateMachineOrderId,
        bindingId: bytes32Hex("0b01"),
        outputIndex: 0n,
        signalId,
        verdict: 1,
        dueAt: 1_700_000_000n
      })
    ]);

    expect(snapshot.unknownEventCount).toBe(0);
    expect(snapshot.eventCount).toBe(3);
  });

  it("replays the canonical chain from the deployment block when a reorg hits a cursor with no stored live events", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "uvp-indexer-empty-history-reorg-"));
    const store = new PostgresProjectionStore({
      databaseUrl: projectionDatabaseUrl,
      chainId: 31337
    });
    try {
      await store.saveCursor({
        chainId: 31337,
        contractAddress: "0x0000000000000000000000000000000000000000",
        deploymentBlock: 0n,
        nextBlock: 3n,
        finalizedBlock: 2n,
        blockHash: blockHashHex("block-2-stale")
      });
      const forkedEvent = {
        ...chainEvent(2n, 0, "OrderRegistered", { orderId: stateMachineOrderId, planId }),
        blockHash: blockHashHex("block-2-fork")
      };
      const ranges: Array<{ readonly fromBlock: bigint; readonly toBlock: bigint }> = [];
      const eventSource: ChainEventSource = {
        async getFinalizedBlock() {
          return 2n;
        },
        async readEvents(range) {
          ranges.push({ fromBlock: range.fromBlock, toBlock: range.toBlock });
          return [forkedEvent].filter(
            (event) => event.blockNumber >= range.fromBlock && event.blockNumber <= range.toBlock
          );
        },
        async getBlockHash(blockNumber) {
          return blockNumber === 2n ? blockHashHex("block-2-fork") : zeroBlockHash();
        }
      };
      const indexer = new IndexerService({
        config: testConfig(),
        eventSource,
        store
      });

      const result = await indexer.refreshFromCursorWithSummary();

      expect(ranges).toEqual([{ fromBlock: 0n, toBlock: 2n }]);
      expect(result.summary).toMatchObject({
        fromBlock: "0",
        toBlock: "2",
        syncStatus: "indexed",
        finalizedBlock: "2"
      });
      await expect(store.getStateMachineOrder(stateMachineOrderId, planId)).resolves.toMatchObject({
        orderId: stateMachineOrderId,
        planId
      });
      await expect(
        store.getCursor({ chainId: 31337, contractAddress: "0x0000000000000000000000000000000000000000" })
      ).resolves.toMatchObject({
        nextBlock: 3n,
        finalizedBlock: 2n,
        blockHash: blockHashHex("block-2-fork")
      });
    } finally {
      await store.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("pins the full-rebuild cursor hash before reading events so a reorg inside that window stays detectable", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "uvp-indexer-rebuild-toctou-"));
    const store = new PostgresProjectionStore({
      databaseUrl: projectionDatabaseUrl,
      chainId: 31337
    });
    try {
      const calls: string[] = [];
      const eventSource: ChainEventSource = {
        async getFinalizedBlock() {
          return 3n;
        },
        async getBlockHash(blockNumber) {
          calls.push(`hash:${blockNumber}`);
          return blockHashHex("block-3-before-read");
        },
        async readEvents() {
          calls.push("read");
          return [{
            ...chainEvent(3n, 0, "OrderRegistered", { orderId: stateMachineOrderId, planId }),
            blockHash: blockHashHex("block-3-after-read")
          }];
        }
      };
      const indexer = new IndexerService({
        config: testConfig(),
        eventSource,
        store
      });

      await indexer.rebuildFromDeploymentBlockWithSummary();

      expect(calls).toEqual(["hash:3", "read"]);
      await expect(
        store.getCursor({ chainId: 31337, contractAddress: "0x0000000000000000000000000000000000000000" })
      ).resolves.toMatchObject({
        nextBlock: 4n,
        finalizedBlock: 3n,
        blockHash: blockHashHex("block-3-before-read")
      });
    } finally {
      await store.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps a degraded sync state degraded on a no-new-events round instead of laundering it into indexed", async () => {
    const store = stores.projectionStore;
    const planEvents: readonly ChainEvent[] = [
      chainEvent(1n, 0, "PlanRegistered", { planId, planHash, hookCount: 0n }),
      chainEvent(2n, 0, "OrderRegistered", { orderId: stateMachineOrderId, planId })
    ];
    const eventSource: ChainEventSource = {
      async getFinalizedBlock() {
        return 2n;
      },
      async readEvents(range) {
        return planEvents.filter(
          (event) => event.blockNumber >= range.fromBlock && event.blockNumber <= range.toBlock
        );
      }
    };
    const indexer = new IndexerService({
      config: testConfig(),
      eventSource,
      store
    });

    await indexer.rebuildFromDeploymentBlockWithSummary();
    await store.saveSyncState({
      chainId: 31337,
      contractAddress: "0x0000000000000000000000000000000000000000",
      syncStatus: "degraded",
      finalizedBlock: 2n,
      confirmationDepth: 2,
      eventCount: 2,
      rebuild: { status: "failed", toBlock: 2n, mismatchCount: 0 },
      degradedReason: "RPC failed at https://rpc.example/v2/secret-key"
    });
    eventSource.readEvents = async () => [];

    const result = await indexer.refreshFromCursorWithSummary();

    expect(result.summary.syncStatus).toBe("degraded");
    const syncState = await store.getSyncState();
    expect(syncState).toMatchObject({
      syncStatus: "degraded"
    });
    expect(syncState?.degradedReason).toContain("RPC failed");
    expect((await store.getOrderSnapshot()).rebuildable).toBe(true);
  });

  it("resolves state-machine orders by the (planId, orderId) composite key and fails closed on bare-id ambiguity", async () => {
    const otherPlanId = bytes32Hex("8101");
    const store = stores.projectionStore;
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

interface VocabularyFixture extends PlanCapabilityTablesInput {
  readonly capabilitiesRoot: Hex;
  readonly supplierBindingsRoot: Hex;
}

function planVocabulary(input: {
  readonly selectorBindings?: readonly { readonly selectorStageId: string; readonly targetStageId: string }[];
  readonly signalCapabilities?: readonly {
    readonly stageId: string;
    readonly targetSourceId: string;
    readonly signalId: string;
    readonly targetOrderRelation: 0;
  }[];
  readonly supplierBindings?: readonly {
    readonly stageId: string;
    readonly supplierId: string;
    readonly kind: 0 | 1;
  }[];
  readonly dynamicSupplierStages?: readonly string[];
}): VocabularyFixture {
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
  const supplierBindings = (input.supplierBindings ?? []).map((binding) => ({
    stageId: binding.stageId as Hex,
    supplierId: binding.supplierId as Hex,
    kind: binding.kind
  }));
  const dynamicSupplierStages = (input.dynamicSupplierStages ?? []).map((stageIdentifier) => stageIdentifier as Hex);
  return {
    planId: planId as Hex,
    planHash: planHash as Hex,
    selectorBindings,
    signalCapabilities,
    supplierBindings,
    ...(dynamicSupplierStages.length > 0 ? { dynamicSupplierStages } : {}),
    capabilitiesRoot: capabilitiesRootOf(selectorBindings, signalCapabilities),
    supplierBindingsRoot: supplierBindingsRootOf(supplierBindings)
  };
}

const planArtifactZhixuYaml = `
apiVersion: uvp/v0
kind: Zhixu
metadata:
  name: plan-artifact-demo
  annotations:
    version: "1"
spec:
  platform:
    type: blockchain
    provider: eth
  nucleation:
    id: plan-artifact
  stages:
    - name: gate
      source: slot-a
      receiveSignals:
        START: "slot-a::gate.seed"
      sendSignals: [{ name: "ready" }, { name: "seed" }]
      executor:
        supplierType: organization
        supplierID: 5f0b1e2a-7c9d-4e1f-9a2b-000000000041
    - name: intake
      source: slot-a
      receiveSignals:
        START: "slot-a::gate.ready"
      sendSignals: [{ name: "cmp" }]
      executor:
        supplierType: organization
        supplierID: 5f0b1e2a-7c9d-4e1f-9a2b-000000000042
`;

function vocabularyResolver(
  vocabulary: PlanCapabilityTablesInput,
  onCall?: () => void
): (anchorPlanId: Hex, anchorPlanHash: Hex) => Promise<PlanCapabilityTablesInput> {
  return async (anchorPlanId, anchorPlanHash) => {
    onCall?.();
    if (
      anchorPlanId.toLowerCase() !== planId.toLowerCase() ||
      anchorPlanHash.toLowerCase() !== planHash.toLowerCase()
    ) {
      throw new Error(`unexpected plan anchor ${anchorPlanId}:${anchorPlanHash}`);
    }
    return vocabulary;
  };
}

function planPublishEvents(
  vocabulary: VocabularyFixture,
  stateMachineAddress = contractAddress,
  overrides: {
    readonly hooksHash?: Hex;
    readonly hookCount?: bigint;
  } = {}
): readonly ChainEvent[] {
  const hooksHash = overrides.hooksHash ?? bytes32Hex("9001");
  const hookCount = overrides.hookCount ?? 1n;
  return [
    chainEvent(1n, 0, "PlanCommitted", {
      planId,
      planHash,
      publisher: signer,
      hooksHash,
      capabilitiesRoot: vocabulary.capabilitiesRoot,
      supplierBindingsRoot: vocabulary.supplierBindingsRoot,
      hookCount
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
      submitter: signer,
      relayer: slotA,
      factStageId: stageId
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
      url: projectionDatabaseUrl,
      migrationsAutoRun: true
    },
    api: {
      host: "127.0.0.1",
      port: 0,
      indexerPollIntervalMs: 0
    },
    operatorRoles: {},
    security: {
      environment: "local",
      preflightStrict: false,
      logRedactionEnabled: true
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
