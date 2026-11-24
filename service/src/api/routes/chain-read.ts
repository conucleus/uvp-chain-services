// Generic chain projection reads (anonymous): orders/tasks/sync state/snapshot
// and plan artifact admissions/trigger enumeration straight from
// ProjectionStore / plan_artifacts, with no session, business rows, or
// participant clipping. Order ids are plan-scoped, so the item read always
// returns `{ orders }` (one or many); absence is only a 404 when the projection
// is current, while a missing, rebuilding, or stale projection is a retryable
// 503 because it cannot prove absence.

import {
  toWire,
  type ChainOrderProjection,
  type ChainPlanAdmissionsResponse,
  type ChainPlanTriggersResponse,
  type ChainProjectionSnapshot,
  type ChainSyncState,
  type ChainTaskProjection,
} from "@uvp-eth/chain-read-contract";
import { ConfigError, normalizeBytes32, type Hex } from "@uvp-eth/service-runtime";
import {
  DockBindingWindowUnavailableError,
  wireDockBindings
} from "../dock-binding-windows.js";
import { StorageUnavailableError } from "../../storage/errors.js";
import { redactEndpointErrorMessage } from "../../shared/redaction.js";
import {
  requireCurrentProjection,
  requireMaterializedProjection,
  readProjectionStateForRead,
  projectionUnavailableResponse,
} from "../projection-read.js";
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
const PLAN_TRIGGERS_PATH = /^\/chain\/plans\/([^/]+)\/([^/]+)\/triggers$/;

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
              message: "the chain projection store is unavailable",
              retryable: true,
            },
          };
        }
        if (error instanceof DockBindingWindowUnavailableError) {
          return {
            status: 503,
            body: {
              error: "chain_read_unavailable",
              message: redactEndpointErrorMessage(error),
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
    if (orders.length === 0) {
      const unavailable = await requireMaterializedProjection(context, "order");
      if (unavailable) {
        return unavailable;
      }
    }
    return { status: 200, body: { orders } };
  }

  if (request.pathname === TASKS_PATH) {
    const tasks: readonly ChainTaskProjection[] = toWire(
      await context.store.listStateMachineTasks(),
    );
    if (tasks.length === 0) {
      const unavailable = await requireMaterializedProjection(context, "order");
      if (unavailable) {
        return unavailable;
      }
    }
    return { status: 200, body: { tasks } };
  }

  if (request.pathname === SYNC_STATE_PATH) {
    const current = await readProjectionStateForRead(context);
    if (!current) {
      return projectionUnavailableResponse("not_started");
    }
    const { projectionDiagnostics, ...syncBase } = toWire(current.readable);
    const syncState: ChainSyncState = projectionDiagnostics
      ? {
          ...syncBase,
          projectionDiagnostics: {
            ...projectionDiagnostics,
            unresolvedStageActivationEventCount: 0
          }
        }
      : syncBase;
    return { status: 200, body: { syncState } };
  }

  if (request.pathname === SNAPSHOT_PATH) {
    const unavailable = await requireCurrentProjection(context);
    if (unavailable) {
      return unavailable;
    }
    const stored = await context.store.getOrderSnapshot();
    const bindings = await wireDockBindings(stored, context.dockBindingWindows);
    const snapshot = { ...toWire(stored), stateMachineDockBindings: bindings };
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

  const planTriggersMatch = PLAN_TRIGGERS_PATH.exec(request.pathname);
  if (planTriggersMatch) {
    return planTriggersRead(
      context,
      decodePathParameter(planTriggersMatch[1] ?? ""),
      decodePathParameter(planTriggersMatch[2] ?? ""),
    );
  }

  const orderTasksMatch = ORDER_TASKS_PATH.exec(request.pathname);
  if (orderTasksMatch) {
    const orderId = decodePathParameter(orderTasksMatch[1] ?? "");
    const orders = await context.store.findStateMachineOrdersByOrderId(orderId);
    if (orders.length === 0) {
      return orderNotFound(context);
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
      return orderNotFound(context);
    }
    const projections: readonly ChainOrderProjection[] = toWire(orders);
    return { status: 200, body: { orders: projections } };
  }

  const taskMatch = TASK_PATH.exec(request.pathname);
  if (taskMatch) {
    const taskId = decodePathParameter(taskMatch[1] ?? "");
    const task = await context.store.getStateMachineTask(taskId);
    if (!task) {
      const unavailable = await requireCurrentProjection(context);
      return unavailable ?? { status: 404, body: { error: "chain_task_not_found" } };
    }
    const projection: ChainTaskProjection = toWire(task);
    return { status: 200, body: { task: projection } };
  }

  return undefined;
}

async function orderNotFound(context: ApiRouteContext): Promise<ApiResponse> {
  const unavailable = await requireCurrentProjection(context);
  return unavailable ?? { status: 404, body: { error: "chain_order_not_found" } };
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

async function planTriggersRead(
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
  const response: ChainPlanTriggersResponse = {
    chainId: record.chainId,
    planId: record.planId,
    planHash: record.planHash,
    triggers: record.artifact.triggers.map((trigger) => ({
      hookId: trigger.hookId,
      stageIdentifier: trigger.stageIdentifier,
      stageId: trigger.stageId,
      hookName: trigger.hookName,
      orderTriggerKind: trigger.orderTriggerKind,
      source: trigger.source,
      signalName: trigger.signalName,
      sourceId: trigger.sourceId,
      signalId: trigger.signalId,
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
