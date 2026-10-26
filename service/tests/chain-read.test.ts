// Bug prevented: the generic chain read API losing or reshaping projection
// facts, collapsing plan-scoped duplicate order ids, or returning another
// order's tasks. Uses an in-memory ProjectionStore only (no Postgres).
import { describe, expect, it } from "vitest";
import type {
  ApiRequest,
  ApiResponse,
  ApiRouteContext,
} from "../src/api/route-context.js";
import { createChainReadRouteModule } from "../src/api/routes/chain-read.js";
import type {
  ProjectionProvenance,
  StateMachineOrderProjection,
  StateMachineProofProjection,
  StateMachineTaskProjection,
} from "../src/indexer/projections/index.js";
import type { ProjectionStore } from "../src/storage/projection-store.js";
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
const CREATOR = "0x3333333333333333333333333333333333333333" as const;
const RELAYER = "0x4444444444444444444444444444444444444444" as const;
const TX_HASH = `0x${"5".repeat(64)}` as const;

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

function proof(blockNumber: bigint, args: StateMachineProofProjection["args"]): StateMachineProofProjection {
  return {
    ...provenance(blockNumber),
    eventId: `event-${blockNumber.toString()}`,
    eventName: "HookReady",
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
    creator: CREATOR,
    authorizations: {},
    signals: {},
    derivedSignals: {},
    stageMaterializations: {},
    stageExecutorOverlays: {},
    stageResourceOverlays: {},
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
    assigneeRole: "performer",
    assigneeWallet: WALLET,
    status: "ready",
    submitSignals: [{ sourceId: SOURCE_ID, signalId: SIGNAL_ID, source: "authorization" }],
    createdAt: provenance(20n),
    updatedAt: provenance(21n),
    proof: proof(21n, { hookId: overrides.hookId }),
  };
}

function contextWithStore(
  store: Pick<
    ProjectionStore,
    | "listStateMachineOrders"
    | "findStateMachineOrdersByOrderId"
    | "listStateMachineTasks"
    | "getStateMachineTask"
  >,
): ApiRouteContext {
  return { store } as unknown as ApiRouteContext;
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
    const context = contextWithStore({
      listStateMachineOrders: async () => [order()],
      findStateMachineOrdersByOrderId: async () => [],
      listStateMachineTasks: async () => [],
      getStateMachineTask: async () => undefined,
    });

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
          creator: CREATOR,
          authorizations: {},
          signals: {},
          derivedSignals: {},
          stageMaterializations: {},
          stageExecutorOverlays: {},
          stageResourceOverlays: {},
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

  it("returns 404 for unknown order and task ids", async () => {
    const context = contextWithStore({
      listStateMachineOrders: async () => [],
      findStateMachineOrdersByOrderId: async () => [],
      listStateMachineTasks: async () => [],
      getStateMachineTask: async () => undefined,
    });

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
    const healthy = contextWithStore({
      listStateMachineOrders: async () => [],
      findStateMachineOrdersByOrderId: async () => [],
      listStateMachineTasks: async () => [],
      getStateMachineTask: async () => undefined,
    });
    await expect(get(healthy, "/chain/orders/%ZZ")).resolves.toMatchObject({
      status: 400,
      body: { error: "invalid_path_parameter" },
    });

    const unavailable = contextWithStore({
      listStateMachineOrders: async () => {
        throw new StorageUnavailableError("projection store is unavailable");
      },
      findStateMachineOrdersByOrderId: async () => [],
      listStateMachineTasks: async () => [],
      getStateMachineTask: async () => undefined,
    });
    await expect(get(unavailable, "/chain/orders")).resolves.toMatchObject({
      status: 503,
      body: { error: "chain_read_unavailable", retryable: true },
    });
  });

  it("returns every plan projection for an order id that exists on multiple plans", async () => {
    const context = contextWithStore({
      listStateMachineOrders: async () => [],
      findStateMachineOrdersByOrderId: async () => [
        order({ planId: PLAN_A }),
        order({ planId: PLAN_B }),
      ],
      listStateMachineTasks: async () => [],
      getStateMachineTask: async () => undefined,
    });

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
    const context = contextWithStore({
      listStateMachineOrders: async () => [],
      findStateMachineOrdersByOrderId: async () => [order()],
      listStateMachineTasks: async () => [taskA, taskB],
      getStateMachineTask: async (taskId) =>
        taskId === taskA.taskId ? taskA : undefined,
    });

    const orderTasks = await get(context, `/chain/orders/${ORDER_ID}/tasks`);
    expect(orderTasks.status).toBe(200);
    expect(orderTasks.body).toEqual({ tasks: [taskJson(taskA)] });

    const singleTask = await get(context, `/chain/tasks/${taskA.taskId}`);
    expect(singleTask.status).toBe(200);
    expect(singleTask.body).toEqual({ task: taskJson(taskA) });
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
    assigneeRole: task.assigneeRole,
    assigneeWallet: task.assigneeWallet,
    status: task.status,
    submitSignals: [
      { sourceId: SOURCE_ID, signalId: SIGNAL_ID, source: "authorization" },
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
