// Generic chain projection reads (anonymous): orders/tasks/sync state straight
// from ProjectionStore, with no session, business rows, or participant clipping.
// Order ids are plan-scoped, so the item read always returns `{ orders }`
// (one or many) and 404s only when no projection exists.

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
    const orders = await context.store.listStateMachineOrders();
    return { status: 200, body: { orders: toChainJson(orders) } };
  }

  if (request.pathname === TASKS_PATH) {
    const tasks = await context.store.listStateMachineTasks();
    return { status: 200, body: { tasks: toChainJson(tasks) } };
  }

  if (request.pathname === SYNC_STATE_PATH) {
    const syncState = await context.store.getSyncState();
    if (!syncState) {
      return { status: 404, body: { error: "chain_sync_state_not_found" } };
    }
    return { status: 200, body: { syncState: toChainJson(syncState) } };
  }

  const orderTasksMatch = ORDER_TASKS_PATH.exec(request.pathname);
  if (orderTasksMatch) {
    const orderId = decodePathParameter(orderTasksMatch[1] ?? "");
    const orders = await context.store.findStateMachineOrdersByOrderId(orderId);
    if (orders.length === 0) {
      return orderNotFound();
    }
    const tasks = await context.store.listStateMachineTasks();
    return {
      status: 200,
      body: {
        tasks: toChainJson(
          tasks.filter((task) => task.orderId.toLowerCase() === orderId.toLowerCase()),
        ),
      },
    };
  }

  const orderMatch = ORDER_PATH.exec(request.pathname);
  if (orderMatch) {
    const orderId = decodePathParameter(orderMatch[1] ?? "");
    const orders = await context.store.findStateMachineOrdersByOrderId(orderId);
    if (orders.length === 0) {
      return orderNotFound();
    }
    return { status: 200, body: { orders: toChainJson(orders) } };
  }

  const taskMatch = TASK_PATH.exec(request.pathname);
  if (taskMatch) {
    const taskId = decodePathParameter(taskMatch[1] ?? "");
    const task = await context.store.getStateMachineTask(taskId);
    if (!task) {
      return { status: 404, body: { error: "chain_task_not_found" } };
    }
    return { status: 200, body: { task: toChainJson(task) } };
  }

  return undefined;
}

function orderNotFound(): ApiResponse {
  return { status: 404, body: { error: "chain_order_not_found" } };
}

function toChainJson(value: unknown): unknown {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map((entry) => toChainJson(entry));
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== undefined) {
        result[key] = toChainJson(entry);
      }
    }
    return result;
  }
  return value;
}
