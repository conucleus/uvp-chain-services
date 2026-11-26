// Bug prevented: the generic chain read API losing or reshaping projection
// facts, collapsing plan-scoped duplicate order ids, or returning another
// order's tasks. Uses an in-memory ProjectionStore only (no Postgres).
import { describe, expect, it } from "vitest";
import {
  decodeOrderDockLinkWire,
  decodeOrderWire,
} from "@uvp-eth/chain-read-contract";
import type {
  ApiRequest,
  ApiResponse,
  ApiRouteContext,
} from "../src/api/route-context.js";
import { createChainReadRouteModule } from "../src/api/routes/chain-read.js";
import type {
  ProjectionProvenance,
  ProjectionSnapshot,
  StateMachineOrderProjection,
  StateMachineProofProjection,
  StateMachineTaskProjection,
} from "../src/indexer/projections/index.js";
import type {
  ProjectionStore,
  ProjectionSyncState,
} from "../src/storage/projection-store.js";
import { StorageUnavailableError } from "../src/storage/errors.js";

const CHAIN_ID = 31337;
const STATE_MACHINE = "0x1111111111111111111111111111111111111111" as const;
const ORDER_ID = `0x${"a".repeat(64)}` as const;
const PLAN_A = `0x${"b".repeat(64)}` as const;
const PLAN_B = `0x${"c".repeat(64)}` as const;
const PLAN_HASH = `0x${"d".repeat(64)}` as const;
const DEPLOYMENT_ID = `0x${"e".repeat(64)}` as const;
const STAGE_ID = `0x${"f".repeat(64)}` as const;
const HOOK_A = `0x${"1".repeat(64)}` as const;
const HOOK_B = `0x${"2".repeat(64)}` as const;
const SOURCE_ID = `0x${"3".repeat(64)}` as const;
const SIGNAL_ID = `0x${"4".repeat(64)}` as const;
const WALLET = "0x2222222222222222222222222222222222222222" as const;
const ACTOR = "0x3333333333333333333333333333333333333333" as const;
const RELAYER = "0x4444444444444444444444444444444444444444" as const;
const TX_HASH = `0x${"5".repeat(64)}` as const;
const PAYLOAD_HASH = `0x${"7".repeat(64)}` as const;
const SUPPLIER_ID = `0x${"6".repeat(64)}` as const;
const DOCK_ID = `0x${"8".repeat(64)}` as const;

function provenance(blockNumber: bigint): ProjectionProvenance {
  return {
    chainId: CHAIN_ID,
    contractAddress: STATE_MACHINE,
    blockNumber,
    transactionIndex: 0,
    transactionHash: TX_HASH,
    logIndex: 0,
  };
}

function proof(
  blockNumber: bigint,
  args: StateMachineProofProjection["args"],
  eventName = "HookReady",
): StateMachineProofProjection {
  return {
    ...provenance(blockNumber),
    eventId: `event-${blockNumber.toString()}`,
    eventName,
    args,
  };
}

function order(overrides: {
  readonly orderId?: `0x${string}`;
  readonly planId?: `0x${string}`;
} = {}): StateMachineOrderProjection {
  return {
    orderId: overrides.orderId ?? ORDER_ID,
    chainId: CHAIN_ID,
    contractAddress: STATE_MACHINE,
    deploymentId: DEPLOYMENT_ID,
    planId: overrides.planId ?? PLAN_A,
    planHash: PLAN_HASH,
    status: "registered",
    currentStage: STAGE_ID,
    relayer: RELAYER,
    signals: {},
    derivedSignals: {},
    stageMaterializations: {},
    stageSupplierAssignments: {},
    stageFiles: {},
    hooks: {},
    tasks: {},
    timeline: [],
    proof: [proof(11n, { hookId: HOOK_A, attempt: 2 })],
    registeredAt: provenance(10n),
    updatedAt: provenance(12n),
  };
}

function task(
  overrides: {
    readonly taskId: string;
    readonly orderId: `0x${string}`;
    readonly hookId: `0x${string}`;
  },
): StateMachineTaskProjection {
  return {
    taskId: overrides.taskId,
    orderId: overrides.orderId,
    stateMachineAddress: STATE_MACHINE,
    planId: PLAN_A,
    hookId: overrides.hookId,
    stageIdentifier: STAGE_ID,
    hookName: HOOK_A,
    assigneeSupplierId: SUPPLIER_ID,
    assigneeSupplierAccount: WALLET,
    status: "ready",
    submitSignals: [{ sourceId: SOURCE_ID, signalId: SIGNAL_ID }],
    createdAt: provenance(20n),
    updatedAt: provenance(21n),
    proof: proof(21n, { hookId: overrides.hookId }),
  };
}

function projectionSnapshot(): ProjectionSnapshot {
  return {
    rebuildable: true,
    eventCount: 15,
    activeStateMachineDeploymentId: DEPLOYMENT_ID,
    stateMachineDeployments: {
      [DEPLOYMENT_ID]: {
        deploymentId: DEPLOYMENT_ID,
        stateMachineAddress: STATE_MACHINE,
        artifactHash: `0x${"8".repeat(64)}`,
        abiHash: `0x${"9".repeat(64)}`,
        deploymentBlock: "4",
        metadataURI: "ipfs://deployment",
        status: "active",
        registeredAt: provenance(4n),
        updatedAt: provenance(5n),
        proof: proof(4n, {}),
      },
    },
    stateMachineModules: {
      [`${CHAIN_ID}:${STATE_MACHINE}`]: {
        chainId: CHAIN_ID,
        stateMachineAddress: STATE_MACHINE,
        moduleId: `0x${"a".repeat(64)}`,
        previousModule: "0x0000000000000000000000000000000000000000",
        moduleAddress: STATE_MACHINE,
        updatedAt: provenance(6n),
        proof: proof(6n, {}),
      },
    },
    contractGovernance: {
      [`${CHAIN_ID}:${STATE_MACHINE}`]: {
        chainId: CHAIN_ID,
        contractAddress: STATE_MACHINE,
        owner: ACTOR,
        ownerUpdatedAt: provenance(7n),
        ownerProof: proof(7n, {}),
      },
    },
    stateMachinePlans: {
      [`${CHAIN_ID}:${STATE_MACHINE}:${PLAN_A}`]: {
        planId: PLAN_A,
        deploymentId: DEPLOYMENT_ID,
        stateMachineAddress: STATE_MACHINE,
        planHash: PLAN_HASH,
        hookCount: "0",
        selectorBindings: [],
        signalCapabilities: [],
        supplierBindings: [{ stageId: STAGE_ID, supplierId: SUPPLIER_ID, kind: "default" }],
        supplierBindingsRoot: `0x${"a".repeat(64)}`,
        dynamicSupplierStages: [STAGE_ID],
        registeredAt: provenance(8n),
        updatedAt: provenance(8n),
        proof: proof(8n, {}),
        commitProof: proof(8n, {}),
      },
    },
    stateMachineOrders: {
      [ORDER_ID]: {
        ...order(),
        stageSupplierAssignments: {
          [STAGE_ID]: {
            orderId: ORDER_ID,
            selectorStageId: STAGE_ID,
            targetStageId: STAGE_ID,
            selector: ACTOR,
            supplierId: SUPPLIER_ID,
            patchNonce: "2",
            dockId: DOCK_ID,
            supplierAccount: WALLET,
            updatedAt: provenance(14n),
            activatedAt: provenance(14n),
            proof: proof(14n, { supplierId: SUPPLIER_ID }, "StageSupplierPatchApplied"),
            activationProof: proof(14n, { supplierId: SUPPLIER_ID }, "StageSupplierAssigned"),
          },
        },
        signals: {
          [SIGNAL_ID]: {
            orderId: ORDER_ID,
            sourceId: SOURCE_ID,
            signalId: SIGNAL_ID,
            payloadHash: PAYLOAD_HASH,
            idempotencyKey: `0x${"b".repeat(64)}`,
            submitter: WALLET,
            submittedAt: provenance(13n),
            proof: proof(13n, { signalId: SIGNAL_ID }),
          },
        },
      },
    },
    stateMachineTasks: {},
    stateMachineSuppliers: {
      [SUPPLIER_ID]: {
        supplierId: SUPPLIER_ID,
        account: WALLET,
        status: "active",
        registeredAt: provenance(6n),
        updatedAt: provenance(14n),
        proof: proof(6n, { supplierId: SUPPLIER_ID }, "SupplierRegistered"),
        statusChangedAt: provenance(14n),
        statusChangedProof: proof(14n, { supplierId: SUPPLIER_ID }, "SupplierStatusChanged"),
      },
    },
    lastEvent: provenance(15n),
    unresolvedModuleOrderEventCount: 0,
    capabilityEnrichmentMismatchCount: 0,
    unknownEventCount: 0,
  };
}

const READ_NOW = new Date("2026-10-27T00:01:00.000Z");

const INDEXED_SYNC_STATE: ProjectionSyncState = {
  chainId: CHAIN_ID,
  contractAddress: STATE_MACHINE,
  syncStatus: "indexed",
  latestIndexedBlock: 42n,
  finalizedBlock: 42n,
  confirmationDepth: 2,
  eventCount: 7,
  rebuild: {
    status: "completed",
    fromBlock: 0n,
    toBlock: 42n,
    eventCount: 7,
    projectionRebuilt: true,
  },
  updatedAt: READ_NOW.toISOString(),
};

type ReadStore = Pick<
  ProjectionStore,
  | "listStateMachineOrders"
  | "getStateMachineOrder"
  | "findStateMachineOrdersByOrderId"
  | "listStateMachineTasks"
  | "getStateMachineTask"
  | "getSyncState"
  | "hasProjectionSnapshot"
> & {
  getOrderSnapshot?: ProjectionStore["getOrderSnapshot"];
  getCursor?: ProjectionStore["getCursor"];
};

function contextWithStore(store: ReadStore): ApiRouteContext {
  return { store, now: () => READ_NOW } as unknown as ApiRouteContext;
}

function currentStore(overrides: Partial<ReadStore> = {}): ReadStore {
  return {
    listStateMachineOrders: async () => [],
    getStateMachineOrder: async () => undefined,
    findStateMachineOrdersByOrderId: async () => [],
    listStateMachineTasks: async () => [],
    getStateMachineTask: async () => undefined,
    getSyncState: async () => INDEXED_SYNC_STATE,
    hasProjectionSnapshot: async () => true,
    getCursor: async () => ({ nextBlock: 43n, finalizedBlock: 42n }),
    ...overrides,
  } as ReadStore;
}

async function get(
  context: ApiRouteContext,
  pathname: string,
): Promise<ApiResponse> {
  const request: ApiRequest = { method: "GET", pathname };
  const response = await createChainReadRouteModule().handle(request, context);
  if (!response) {
    throw new Error(`chain read route did not handle ${pathname}`);
  }
  return response;
}

describe("generic chain read routes", () => {
  it("passes order projection fields through and serializes block numbers as decimal strings", async () => {
    const context = contextWithStore(currentStore({
      listStateMachineOrders: async () => [order()],
    }));

    const response = await get(context, "/chain/orders");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      orders: [
        {
          orderId: ORDER_ID,
          chainId: CHAIN_ID,
          contractAddress: STATE_MACHINE,
          deploymentId: DEPLOYMENT_ID,
          planId: PLAN_A,
          planHash: PLAN_HASH,
          status: "registered",
          currentStage: STAGE_ID,
          relayer: RELAYER,
          signals: {},
          derivedSignals: {},
          stageMaterializations: {},
          stageSupplierAssignments: {},
          stageFiles: {},
          hooks: {},
          tasks: {},
          timeline: [],
          proof: [
            {
              chainId: CHAIN_ID,
              contractAddress: STATE_MACHINE,
              blockNumber: "11",
              transactionIndex: 0,
              transactionHash: TX_HASH,
              logIndex: 0,
              eventId: "event-11",
              eventName: "HookReady",
              args: { hookId: HOOK_A, attempt: 2 },
            },
          ],
          registeredAt: {
            chainId: CHAIN_ID,
            contractAddress: STATE_MACHINE,
            blockNumber: "10",
            transactionIndex: 0,
            transactionHash: TX_HASH,
            logIndex: 0,
          },
          updatedAt: {
            chainId: CHAIN_ID,
            contractAddress: STATE_MACHINE,
            blockNumber: "12",
            transactionIndex: 0,
            transactionHash: TX_HASH,
            logIndex: 0,
          },
        },
      ],
    });
  });

  it("returns 404 for unknown order and task ids when the current projection proves the absence", async () => {
    const context = contextWithStore(currentStore());

    await expect(get(context, `/chain/orders/${ORDER_ID}`)).resolves.toEqual({
      status: 404,
      body: { error: "chain_order_not_found" },
    });
    await expect(get(context, `/chain/orders/${ORDER_ID}/tasks`)).resolves.toEqual({
      status: 404,
      body: { error: "chain_order_not_found" },
    });
    await expect(get(context, `/chain/tasks/${HOOK_A}`)).resolves.toEqual({
      status: 404,
      body: { error: "chain_task_not_found" },
    });
  });

  it("maps malformed path parameters to 400 and storage outages to 503", async () => {
    const healthy = contextWithStore(currentStore());
    await expect(get(healthy, "/chain/orders/%ZZ")).resolves.toMatchObject({
      status: 400,
      body: { error: "invalid_path_parameter" },
    });

    const unavailable = contextWithStore(currentStore({
      listStateMachineOrders: async () => {
        throw new StorageUnavailableError("projection store is unavailable");
      },
    }));
    await expect(get(unavailable, "/chain/orders")).resolves.toMatchObject({
      status: 503,
      body: { error: "chain_read_unavailable", retryable: true },
    });
  });

  it("returns every plan projection for an order id that exists on multiple plans", async () => {
    const context = contextWithStore(currentStore({
      findStateMachineOrdersByOrderId: async () => [
        order({ planId: PLAN_A }),
        order({ planId: PLAN_B }),
      ],
    }));

    const response = await get(context, `/chain/orders/${ORDER_ID}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      orders: [{ planId: PLAN_A }, { planId: PLAN_B }],
    });
  });

  it("filters order task reads to the requested order and serves task drafts unchanged", async () => {
    const taskA = task({ taskId: "task-a", orderId: ORDER_ID, hookId: HOOK_A });
    const taskB = task({
      taskId: "task-b",
      orderId: `0x${"9".repeat(64)}`,
      hookId: HOOK_B,
    });
    const context = contextWithStore(currentStore({
      findStateMachineOrdersByOrderId: async () => [order()],
      listStateMachineTasks: async () => [taskA, taskB],
      getStateMachineTask: async (taskId) =>
        taskId === taskA.taskId ? taskA : undefined,
    }));

    const orderTasks = await get(context, `/chain/orders/${ORDER_ID}/tasks`);
    expect(orderTasks.status).toBe(200);
    expect(orderTasks.body).toEqual({ tasks: [taskJson(taskA)] });

    const singleTask = await get(context, `/chain/tasks/${taskA.taskId}`);
    expect(singleTask.status).toBe(200);
    expect(singleTask.body).toEqual({ task: taskJson(taskA) });
  });

  it("passes the projection sync state through and reports an unbuilt projection as retryable 503", async () => {
    const syncState: ProjectionSyncState = {
      chainId: CHAIN_ID,
      contractAddress: STATE_MACHINE,
      syncStatus: "syncing",
      latestIndexedBlock: 42n,
      finalizedBlock: 40n,
      confirmationDepth: 2,
      lastEventName: "HookReady",
      eventCount: 7,
      rebuild: {
        status: "completed",
        fromBlock: 38n,
        toBlock: 42n,
        eventCount: 7,
        removedLogsFiltered: true,
      },
      degradedReason: "rpc lag",
      updatedAt: "2026-10-27T00:00:00.000Z",
    };
    const present = contextWithStore(currentStore({
      getSyncState: async () => syncState,
    }));
    await expect(get(present, "/chain/sync-state")).resolves.toEqual({
      status: 200,
      body: {
        syncState: {
          ...syncState,
          latestIndexedBlock: "42",
          finalizedBlock: "40",
          rebuild: { ...syncState.rebuild, fromBlock: "38", toBlock: "42" },
        },
      },
    });

    const absent = contextWithStore(currentStore({
      getSyncState: async () => undefined,
      hasProjectionSnapshot: async () => false,
    }));
    await expect(get(absent, "/chain/sync-state")).resolves.toMatchObject({
      status: 503,
      body: {
        error: "chain_projection_unavailable",
        retryable: true,
        syncStatus: "not_started",
      },
    });
  });

  it("returns stale while rebuilding and when the durable cursor is behind the finalized bound", async () => {
    const rebuilding: ProjectionSyncState = {
      chainId: CHAIN_ID,
      contractAddress: STATE_MACHINE,
      syncStatus: "rebuilding",
      latestIndexedBlock: 20n,
      finalizedBlock: 40n,
      confirmationDepth: 2,
      eventCount: 7,
      rebuild: { status: "running", fromBlock: 0n, toBlock: 40n },
      updatedAt: "2026-10-27T00:00:00.000Z",
    };
    const rebuildingContext = {
      store: {
        getSyncState: async () => rebuilding,
      },
      now: () => new Date("2026-10-27T00:01:00.000Z"),
      indexerDiagnostics: { configured: true, pollIntervalMs: 5_000 },
    } as unknown as ApiRouteContext;

    await expect(get(rebuildingContext, "/chain/sync-state")).resolves.toMatchObject({
      status: 200,
      body: { syncState: { syncStatus: "stale" } },
    });

    const behind = {
      ...rebuilding,
      syncStatus: "indexed" as const,
      rebuild: { status: "completed" as const, fromBlock: 0n, toBlock: 20n },
    };
    const behindContext = {
      store: {
        getSyncState: async () => behind,
        getCursor: async () => ({ nextBlock: 21n, finalizedBlock: 40n }),
      },
      now: () => new Date("2026-10-27T00:01:00.000Z"),
      indexerDiagnostics: { configured: true, pollIntervalMs: 5_000 },
    } as unknown as ApiRouteContext;

    await expect(get(behindContext, "/chain/sync-state")).resolves.toMatchObject({
      status: 200,
      body: { syncState: { syncStatus: "stale" } },
    });
  });

  it("serves the whole projection snapshot from one snapshot read with recursive bigint serialization", async () => {
    let snapshotReads = 0;
    const context = contextWithStore(currentStore({
      getOrderSnapshot: async () => {
        snapshotReads += 1;
        return projectionSnapshot();
      },
    }));

    const response = await get(context, "/chain/snapshot");

    expect(response.status).toBe(200);
    expect(snapshotReads).toBe(1);
    expect(Object.keys(record(response.body))).toEqual(["snapshot"]);
    const snapshot = record(record(response.body)["snapshot"]);
    expect(snapshot["rebuildable"]).toBe(true);
    expect(snapshot["eventCount"]).toBe(15);
    expect(snapshot["activeStateMachineDeploymentId"]).toBe(DEPLOYMENT_ID);
    expect(Object.keys(record(snapshot["stateMachineOrders"]))).toEqual([ORDER_ID]);
    expect(
      record(record(snapshot["stateMachineDeployments"])[DEPLOYMENT_ID])["registeredAt"],
    ).toMatchObject({ blockNumber: "4" });
    expect(
      record(record(snapshot["stateMachinePlans"])[`${CHAIN_ID}:${STATE_MACHINE}:${PLAN_A}`])[
        "commitProof"
      ],
    ).toMatchObject({ blockNumber: "8" });
    expect(
      record(record(snapshot["stateMachineOrders"])[ORDER_ID])["signals"],
    ).toMatchObject({ [SIGNAL_ID]: { submittedAt: { blockNumber: "13" } } });
    const snapshotOrder = record(record(snapshot["stateMachineOrders"])[ORDER_ID]);
    expect(record(snapshotOrder["stageSupplierAssignments"])[STAGE_ID]).toMatchObject({
      supplierId: SUPPLIER_ID,
      supplierAccount: WALLET,
      patchNonce: "2",
      dockId: DOCK_ID,
    });
    expect(
      record(record(snapshot["stateMachinePlans"])[`${CHAIN_ID}:${STATE_MACHINE}:${PLAN_A}`])[
        "supplierBindings"
      ],
    ).toEqual([{ stageId: STAGE_ID, supplierId: SUPPLIER_ID, kind: "default" }]);
    expect(
      record(record(snapshot["stateMachineSuppliers"])[SUPPLIER_ID]),
    ).toMatchObject({
      supplierId: SUPPLIER_ID,
      account: WALLET,
      status: "active",
      registeredAt: { blockNumber: "6" },
      statusChangedAt: { blockNumber: "14" },
    });
    expect(snapshot["lastEvent"]).toMatchObject({ blockNumber: "15" });
    expect(findBigints(response.body)).toEqual([]);
  });

  it("marks absence unknown while the projection is rebuilding, stale, or never built", async () => {
    const rebuilding: ProjectionSyncState = {
      ...INDEXED_SYNC_STATE,
      syncStatus: "rebuilding",
      rebuild: { status: "running", fromBlock: 0n, toBlock: 42n },
    };
    const rebuildingContext = contextWithStore(currentStore({
      getSyncState: async () => rebuilding,
    }));
    for (const pathname of [
      `/chain/orders/${ORDER_ID}`,
      `/chain/orders/${ORDER_ID}/tasks`,
      `/chain/tasks/${HOOK_A}`,
    ]) {
      await expect(get(rebuildingContext, pathname)).resolves.toMatchObject({
        status: 503,
        body: {
          error: "chain_projection_stale",
          retryable: true,
          syncStatus: "rebuilding",
        },
      });
    }
    await expect(get(rebuildingContext, "/chain/snapshot")).resolves.toMatchObject({
      status: 503,
      body: { error: "chain_projection_stale", syncStatus: "rebuilding" },
    });

    const staleContext = {
      ...contextWithStore(currentStore({
        getSyncState: async () => ({
          ...INDEXED_SYNC_STATE,
          updatedAt: "2026-10-27T00:00:00.000Z",
        }),
      })),
      indexerDiagnostics: { configured: true, pollIntervalMs: 5_000 },
    } as unknown as ApiRouteContext;
    await expect(get(staleContext, `/chain/orders/${ORDER_ID}`)).resolves.toMatchObject({
      status: 503,
      body: { error: "chain_projection_stale", syncStatus: "stale" },
    });

    const neverBuilt = contextWithStore(currentStore({
      getSyncState: async () => undefined,
      hasProjectionSnapshot: async () => false,
    }));
    for (const pathname of [
      "/chain/orders",
      "/chain/tasks",
      "/chain/snapshot",
      `/chain/orders/${ORDER_ID}`,
    ]) {
      await expect(get(neverBuilt, pathname)).resolves.toMatchObject({
        status: 503,
        body: {
          error: "chain_projection_unavailable",
          retryable: true,
          syncStatus: "not_started",
        },
      });
    }

    const snapshotMissing = contextWithStore(currentStore({
      hasProjectionSnapshot: async () => false,
    }));
    for (const pathname of ["/chain/snapshot", `/chain/orders/${ORDER_ID}`]) {
      await expect(get(snapshotMissing, pathname)).resolves.toMatchObject({
        status: 503,
        body: {
          error: "chain_projection_unavailable",
          retryable: true,
          syncStatus: "current",
        },
      });
    }
  });

  it("serves a valid empty projection as 200 only when the snapshot was materialized", async () => {
    const context = contextWithStore(currentStore());

    await expect(get(context, "/chain/orders")).resolves.toEqual({
      status: 200,
      body: { orders: [] },
    });
    await expect(get(context, "/chain/tasks")).resolves.toEqual({
      status: 200,
      body: { tasks: [] },
    });
  });

  it("redacts endpoint credentials from the sync-state and dock window 503 bodies", async () => {
    const degraded = contextWithStore(currentStore({
      getSyncState: async () => ({
        ...INDEXED_SYNC_STATE,
        syncStatus: "degraded",
        degradedReason:
          "RPC failed at https://base-mainnet.g.alchemy.com/v2/secret-rpc-key and https://user:pass@rpc.example/v3/other-key",
      }),
    }));
    const syncStateResponse = await get(degraded, "/chain/sync-state");
    expect(syncStateResponse.status).toBe(200);
    const serializedSyncState = JSON.stringify(syncStateResponse.body);
    expect(serializedSyncState).not.toContain("secret-rpc-key");
    expect(serializedSyncState).not.toContain("other-key");
    expect(serializedSyncState).not.toContain("user:pass");
    expect(serializedSyncState).toContain("[redacted:url]");
  });

  it("serves GET /chain/orders/:planId/:orderId with dockLinks and GET /chain/dock-links/:linkId conforming to chain-read-contract decoders", async () => {
    const linkId = `0x${"9".repeat(64)}` as const;
    const peerOrderId = `0x${"a".repeat(62)}02` as const;
    const dockLink = {
      linkId,
      dkid: DOCK_ID,
      fromPlanId: PLAN_B,
      fromOrderId: peerOrderId,
      toPlanId: PLAN_A,
      toOrderId: ORDER_ID,
      toStageId: STAGE_ID,
      toConsentStageId: STAGE_ID,
      toConsent: ACTOR,
      linkedAt: provenance(30n),
      proof: proof(30n, { linkId }, "DockLinkBound"),
      submittedOutputs: [
        {
          linkId,
          outputIndex: 0,
          toPlanId: PLAN_A,
          toOrderId: ORDER_ID,
          toSourceId: SOURCE_ID,
          signalId: SIGNAL_ID,
          payloadHash: PAYLOAD_HASH,
          idempotencyKey: `0x${"c".repeat(64)}` as const,
          submittedAt: provenance(31n),
          proof: proof(31n, { linkId, outputIndex: "0" }, "DockOutputSubmitted"),
        },
      ],
    };
    const linkedOrder: StateMachineOrderProjection = {
      ...order(),
      dockLinks: {
        incoming: [
          {
            linkId: dockLink.linkId,
            dkid: dockLink.dkid,
            fromPlanId: dockLink.fromPlanId,
            fromOrderId: dockLink.fromOrderId,
            toPlanId: dockLink.toPlanId,
            toOrderId: dockLink.toOrderId,
            toStageId: dockLink.toStageId,
            toConsentStageId: dockLink.toConsentStageId,
            toConsent: dockLink.toConsent,
            linkedAt: dockLink.linkedAt,
            proof: dockLink.proof,
          },
        ],
        outgoing: [],
      },
    };
    const context = contextWithStore(currentStore({
      getStateMachineOrder: async (orderId, planId) =>
        orderId === ORDER_ID && planId === PLAN_A ? linkedOrder : undefined,
      getOrderSnapshot: async () => ({
        ...projectionSnapshot(),
        dockLinks: { [linkId]: dockLink },
      }),
    }));

    const orderRes = await get(context, `/chain/orders/${PLAN_A}/${ORDER_ID}`);
    expect(orderRes.status).toBe(200);
    const decodedOrder = decodeOrderWire(record(orderRes.body)["order"]);
    expect(decodedOrder.dockLinks?.incoming).toHaveLength(1);
    expect(decodedOrder.dockLinks?.incoming[0]?.fromOrderId).toBe(peerOrderId);
    expect(decodedOrder.dockLinks?.outgoing).toEqual([]);
    expect(findBigints(orderRes.body)).toEqual([]);

    const linkRes = await get(context, `/chain/dock-links/${linkId}`);
    expect(linkRes.status).toBe(200);
    const decodedLink = decodeOrderDockLinkWire(record(linkRes.body)["dockLink"]);
    expect(decodedLink.linkId).toBe(linkId);
    expect(decodedLink.fromOrderId).toBe(peerOrderId);
    expect(findBigints(linkRes.body)).toEqual([]);

    const missingOrder = await get(context, `/chain/orders/${PLAN_B}/${ORDER_ID}`);
    expect(missingOrder).toEqual({ status: 404, body: { error: "chain_order_not_found" } });

    const missingLink = await get(context, `/chain/dock-links/0x${"0".repeat(64)}`);
    expect(missingLink).toEqual({ status: 404, body: { error: "chain_dock_link_not_found" } });
  });

});

function taskJson(task: StateMachineTaskProjection): Record<string, unknown> {
  return {
    taskId: task.taskId,
    orderId: task.orderId,
    stateMachineAddress: task.stateMachineAddress,
    planId: task.planId,
    hookId: task.hookId,
    stageIdentifier: task.stageIdentifier,
    hookName: task.hookName,
    assigneeSupplierId: task.assigneeSupplierId,
    assigneeSupplierAccount: task.assigneeSupplierAccount,
    status: task.status,
    submitSignals: [
      { sourceId: SOURCE_ID, signalId: SIGNAL_ID },
    ],
    createdAt: {
      chainId: CHAIN_ID,
      contractAddress: STATE_MACHINE,
      blockNumber: "20",
      transactionIndex: 0,
      transactionHash: TX_HASH,
      logIndex: 0,
    },
    updatedAt: {
      chainId: CHAIN_ID,
      contractAddress: STATE_MACHINE,
      blockNumber: "21",
      transactionIndex: 0,
      transactionHash: TX_HASH,
      logIndex: 0,
    },
    proof: {
      chainId: CHAIN_ID,
      contractAddress: STATE_MACHINE,
      blockNumber: "21",
      transactionIndex: 0,
      transactionHash: TX_HASH,
      logIndex: 0,
      eventId: "event-21",
      eventName: "HookReady",
      args: { hookId: task.hookId },
    },
  };
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected the chain read response to contain a JSON object");
  }
  return value as Record<string, unknown>;
}

function findBigints(value: unknown): bigint[] {
  if (typeof value === "bigint") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => findBigints(entry));
  }
  if (value !== null && typeof value === "object") {
    return Object.values(value).flatMap((entry) => findBigints(entry));
  }
  return [];
}
