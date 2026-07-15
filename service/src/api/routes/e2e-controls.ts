import {
  type ProductOrderDTO,
  type ProductTaskDTO,
} from "@uvp-eth/product-dto";
import type { ProductE2EControls } from "../route-context.js";
import type { RouteModule } from "../route-module.js";

export function createProductE2EControlsRouteModule(): RouteModule {
  return {
    async handle(request, context) {
      if (!request.pathname.startsWith("/product/e2e/")) {
        return undefined;
      }
      if (!context.productE2eControls.enabled) {
        return {
          status: 404,
          body: { error: "not_found" }
        };
      }

      if (request.pathname === "/product/e2e/controls/syncing") {
        if (request.method === "POST") {
          context.productE2eControls.setSyncing(true);
          return {
            status: 200,
            body: { syncState: "syncing" }
          };
        }
        if (request.method === "DELETE") {
          context.productE2eControls.setSyncing(false);
          return {
            status: 200,
            body: { syncState: "ready" }
          };
        }
      }

      return {
        status: 404,
        body: { error: "not_found" }
      };
    }
  };
}

export function createProductE2EControls(enabled: boolean): ProductE2EControls {
  let syncing = false;
  return {
    enabled,
    setSyncing(value) {
      syncing = value;
    },
    listZhixu(zhixus) {
      return zhixus;
    },
    getZhixu() {
      return undefined;
    },
    listOrders(orders) {
      return syncing ? orders.map((order) => syncingOrder(order)) : orders;
    },
    order(order) {
      return syncing && order ? syncingOrder(order) : order;
    },
    listTasks(tasks) {
      return syncing ? tasks.map((task) => syncingTask(task)) : tasks;
    },
    task(task) {
      return syncing && task ? syncingTask(task) : task;
    }
  };
}

function syncingOrder(order: ProductOrderDTO): ProductOrderDTO {
  return {
    ...order,
    statusLabel: "同步中",
    currentTaskSummary: "提交已发出，订单页正在等待后端投影更新。"
  };
}

function syncingTask(task: ProductTaskDTO): ProductTaskDTO {
  return {
    ...task,
    status: "blocked",
    subtitle: "同步中，待链上事件投影完成后继续处理。"
  };
}
