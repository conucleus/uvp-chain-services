import {
  summarizeZhixu,
  type ProductOrderDTO,
  type ProductTaskDTO,
  type ZhixuDetailDTO
} from "@uvp-eth/product-dto";
import { demoZhixuDetail } from "@uvp-eth/product-dto/fixtures";
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

      if (request.pathname === "/product/e2e/fixtures/revoked-zhixu") {
        if (request.method === "POST") {
          return {
            status: 201,
            body: { zhixu: context.productE2eControls.createRevokedZhixu() }
          };
        }
        if (request.method === "DELETE") {
          context.productE2eControls.clearRevokedZhixu();
          return {
            status: 200,
            body: { ok: true }
          };
        }
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
  let revokedZhixu: ZhixuDetailDTO | undefined;
  let syncing = false;
  return {
    enabled,
    createRevokedZhixu() {
      revokedZhixu = buildRevokedE2EZhixu();
      return revokedZhixu;
    },
    clearRevokedZhixu() {
      revokedZhixu = undefined;
    },
    setSyncing(value) {
      syncing = value;
    },
    listZhixu(zhixus) {
      return revokedZhixu ? [summarizeZhixu(revokedZhixu), ...zhixus] : zhixus;
    },
    getZhixu(zhixuId) {
      return revokedZhixu?.zhixuId === zhixuId ? revokedZhixu : undefined;
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

function buildRevokedE2EZhixu(): ZhixuDetailDTO {
  const planId = "0x0000000000000000000000000000000000000000000000000000000000e2e701";
  const planHash = "0x0000000000000000000000000000000000000000000000000000000000e2e702";
  return {
    ...demoZhixuDetail,
    zhixuId: "e2e-revoked-cross-border-plan",
    title: "E2E 已撤销测试秩序",
    subtitle: "仅用于浏览器自动化测试，验证撤销秩序不可创建新订单。",
    reviewStatus: "revoked",
    reviewLabel: "链上背书已撤销",
    createOrderHint: "该秩序已撤销，不能创建新订单。",
    chainAttestation: {
      ...demoZhixuDetail.chainAttestation,
      status: "revoked",
      label: "链上背书已撤销",
      planId,
      planHash,
      revokedReasonURI: "uvp-product-e2e://revoked-plan"
    },
    proofRows: [
      ...demoZhixuDetail.proofRows.filter((row) => row.label !== "背书状态"),
      { label: "背书状态", value: "链上背书已撤销" }
    ]
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
