// Generic chain projection reads (anonymous): orders/tasks/sync state/snapshot
// and plan artifact admissions straight from ProjectionStore / plan_artifacts,
// with no session, business rows, or participant clipping. Order ids are
// plan-scoped, so the item read always returns `{ orders }` (one or many) and
// 404s only when no projection exists.

import {
  toWire,
  type ChainOrderProjection,
  type ChainPlanAdmissionsResponse,
  type ChainProjectionSnapshot,
  type ChainSyncState,
  type ChainTaskProjection,
} from "@uvp-eth/chain-read-contract";
import { ConfigError, normalizeBytes32, type Hex } from "@uvp-eth/service-runtime";
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
const PLAN_ADMISSIONS_PATH = /^\/chain\/plans\/([^/]+)\/([^/]+)\/admissions$/;

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

  const planAdmissionsMatch = PLAN_ADMISSIONS_PATH.exec(request.pathname);
  if (planAdmissionsMatch) {
    return planAdmissionsRead(
      context,
      decodePathParameter(planAdmissionsMatch[1] ?? ""),
      decodePathParameter(planAdmissionsMatch[2] ?? ""),
    );
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

async function planAdmissionsRead(
  context: ApiRouteContext,
  rawPlanId: string,
  rawPlanHash: string,
): Promise<ApiResponse> {
  const planId = planIdentifier(rawPlanId, "planId");
  if (!planId) {
    return invalidPlanIdentifier("planId");
  }
  const planHash = planIdentifier(rawPlanHash, "planHash");
  if (!planHash) {
    return invalidPlanIdentifier("planHash");
  }
  const planArtifacts = context.planArtifacts;
  if (!planArtifacts) {
    throw new Error("plan artifact store is not wired into the chain read API");
  }
  const record = await planArtifacts.store.get({
    chainId: planArtifacts.chainId,
    planId,
    planHash,
  });
  if (!record) {
    return { status: 404, body: { error: "plan_artifact_missing" } };
  }
  const response: ChainPlanAdmissionsResponse = {
    chainId: record.chainId,
    planId: record.planId,
    planHash: record.planHash,
    admissions: record.artifact.admissions.map((admission) => ({
      admissionId: admission.admissionId,
      stageId: admission.stageId,
      stageIdentifier: admission.stageIdentifier,
      signalName: admission.signalName,
      signalId: admission.signalId,
      sourceId: admission.sourceId,
    })),
  };
  return { status: 200, body: response };
}

function planIdentifier(value: string, field: "planId" | "planHash"): Hex | undefined {
  try {
    return normalizeBytes32(value, field);
  } catch (error) {
    if (error instanceof ConfigError) {
      return undefined;
    }
    throw error;
  }
}

function invalidPlanIdentifier(field: "planId" | "planHash"): ApiResponse {
  return {
    status: 400,
    body: {
      error: field === "planId" ? "invalid_plan_id" : "invalid_plan_hash",
      message: `${field} must be a 32-byte hex value`,
    },
  };
}
