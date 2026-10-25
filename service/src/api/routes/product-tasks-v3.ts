// V3 任务投影路由：GET /product/v3/tasks?orderId=...（会话钱包）与
// /product/v3/orders/:orderId/stages/:stageKey/tasks。任务只读，不写回订单。

import type { Address } from "../../shared/types.js";
import { OrderV3Error } from "../../order/v3/index.js";
import { createVisibilityResolver } from "../../visibility/index.js";
import { createTaskService } from "../../task/index.js";
import {
  decodePathParameter,
  InvalidPathParameterError,
  invalidPathParameterResponse,
  type ApiResponse,
  type ApiRequest,
  type ApiRouteContext,
} from "../route-context.js";
import type { RouteModule } from "../route-module.js";

const TASKS_PATH = "/product/v3/tasks";
const STAGE_TASKS_PATH = /^\/product\/v3\/orders\/([^/]+)\/stages\/([^/]+)\/tasks$/;

export interface ProductTasksV3RouteOptions {
  readonly operatorWallets?: readonly Address[];
}

export function createProductTasksV3RouteModule(
  options: ProductTasksV3RouteOptions = {},
): RouteModule {
  return {
    async handle(request, context) {
      if (!request.pathname.startsWith("/product/v3/") || request.method !== "GET") {
        return undefined;
      }
      const stageMatch = STAGE_TASKS_PATH.exec(request.pathname);
      if (request.pathname !== TASKS_PATH && !stageMatch) {
        return undefined;
      }
      try {
        const wallet = await requireWallet(request, context);
        const tasks = createTaskService({
          visibility: createVisibilityResolver({
            loadOrder: (orderId) => context.orderV3Service.loadOrderSnapshotForVisibility(orderId),
            ...(options.operatorWallets !== undefined ? { operatorWallets: options.operatorWallets } : {}),
          }),
          loadOrder: (orderId) => context.orderV3Service.loadOrderSnapshotForVisibility(orderId),
          now: context.now,
        });

        if (request.pathname === TASKS_PATH) {
          const orderId = request.query?.orderId?.trim() ?? "";
          if (orderId.length === 0) {
            throw new OrderV3Error(400, "invalid_request", "orderId query parameter is required");
          }
          return { status: 200, body: await tasks.listTasks(wallet, orderId) };
        }
        if (stageMatch) {
          return {
            status: 200,
            body: await tasks.listStageTasks(
              wallet,
              decodePathParameter(stageMatch[1] ?? ""),
              decodePathParameter(stageMatch[2] ?? ""),
            ),
          };
        }
        return undefined;
      } catch (error) {
        if (error instanceof OrderV3Error) {
          return { status: error.status, body: { error: error.code, message: error.message, ...(error.details !== undefined ? { details: error.details } : {}) } };
        }
        if (error instanceof InvalidPathParameterError) {
          return invalidPathParameterResponse();
        }
        throw error;
      }
    },
  };
}

async function requireWallet(request: ApiRequest, context: ApiRouteContext): Promise<Address> {
  const access = await context.storeIdentityProvider.resolve(request.headers);
  if (!access.anchoredAddress) {
    throw new OrderV3Error(401, "wallet_identity_required", "a wallet session is required for V3 task endpoints");
  }
  return access.anchoredAddress;
}
