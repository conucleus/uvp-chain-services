// Generic chain projection reads (anonymous): orders/tasks/sync state/snapshot
// straight from ProjectionStore, with no session, business rows, or participant
// clipping. Order ids are plan-scoped, so the item read always returns
// `{ orders }` (one or many) and 404s only when no projection exists.

import {
  toWire,
  type ChainOrderProjection,
  type ChainProjectionSnapshot,
  type ChainSyncState,
  type ChainTaskProjection,
} from "@uvp-eth/chain-read-contract";
import { StorageUnavailableError } from "../../storage/errors.js";
import {
  decodePathParameter,
  InvalidPathParameterError,
  invalidPathParameterResponse,
  type ApiRequest,
  type ApiResponse,
  type ApiRouteContext,
} from "../route-context.js";
import type { RouteModule } from "../route-module.js";

const ORDERS_PATH = "/chain/orders";
const ORDER_PATH = /^\/chain\/orders\/([^/]+)$/;
const ORDER_TASKS_PATH = /^\/chain\/orders\/([^/]+)\/tasks$/;
const TASKS_PATH = "/chain/tasks";
const TASK_PATH = /^\/chain\/tasks\/([^/]+)$/;
const SYNC_STATE_PATH = "/chain/sync-state";
const SNAPSHOT_PATH = "/chain/snapshot";

export function createChainReadRouteModule(): RouteModule {
  return {
    async handle(request, context) {
      if (request.method !== "GET" || !request.pathname.startsWith("/chain/")) {
        return undefined;
      }
      try {
        return await handleRead(request, context);
      } catch (error) {
        if (error instanceof InvalidPathParameterError) {
          return invalidPathParameterResponse();
        }
        if (error instanceof StorageUnavailableError) {
          return {
            status: 503,
            body: {
              error: "chain_read_unavailable",
              message: error.message,
              retryable: true,
            },
          };
        }
        throw error;
      }
    },
  };
}

async function handleRead(
  request: ApiRequest,
  context: ApiRouteContext,
): Promise<ApiResponse | undefined> {
  if (request.pathname === ORDERS_PATH) {
    const orders: readonly ChainOrderProjection[] = toWire(
      await context.store.listStateMachineOrders(),
    );
    return { status: 200, body: { orders } };
  }

  if (request.pathname === TASKS_PATH) {
    const tasks: readonly ChainTaskProjection[] = toWire(
      await context.store.listStateMachineTasks(),
    );
    return { status: 200, body: { tasks } };
  }

  if (request.pathname === SYNC_STATE_PATH) {
    const current = await context.store.getSyncState();
    if (!current) {
      return { status: 404, body: { error: "chain_sync_state_not_found" } };
    }
    const syncState: ChainSyncState = toWire(current);
    return { status: 200, body: { syncState } };
  }

  if (request.pathname === SNAPSHOT_PATH) {
    const snapshot: ChainProjectionSnapshot = toWire(
      await context.store.getOrderSnapshot(),
    );
    return { status: 200, body: { snapshot } };
  }

  const orderTasksMatch = ORDER_TASKS_PATH.exec(request.pathname);
  if (orderTasksMatch) {
    const orderId = decodePathParameter(orderTasksMatch[1] ?? "");
    const orders = await context.store.findStateMachineOrdersByOrderId(orderId);
    if (orders.length === 0) {
      return orderNotFound();
    }
    const tasks = await context.store.listStateMachineTasks();
    const orderTasks: readonly ChainTaskProjection[] = toWire(
      tasks.filter((task) => task.orderId.toLowerCase() === orderId.toLowerCase()),
    );
    return {
      status: 200,
      body: { tasks: orderTasks },
    };
  }

  const orderMatch = ORDER_PATH.exec(request.pathname);
  if (orderMatch) {
    const orderId = decodePathParameter(orderMatch[1] ?? "");
    const orders = await context.store.findStateMachineOrdersByOrderId(orderId);
    if (orders.length === 0) {
      return orderNotFound();
    }
    const projections: readonly ChainOrderProjection[] = toWire(orders);
    return { status: 200, body: { orders: projections } };
  }

  const taskMatch = TASK_PATH.exec(request.pathname);
  if (taskMatch) {
    const taskId = decodePathParameter(taskMatch[1] ?? "");
    const task = await context.store.getStateMachineTask(taskId);
    if (!task) {
      return { status: 404, body: { error: "chain_task_not_found" } };
    }
    const projection: ChainTaskProjection = toWire(task);
    return { status: 200, body: { task: projection } };
  }

  return undefined;
}

function orderNotFound(): ApiResponse {
  return { status: 404, body: { error: "chain_order_not_found" } };
}
