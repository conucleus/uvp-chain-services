// V1 订单面墓碑：草稿/邀请/参与者/要求包写入路由已删除，只保留显式 410，
// 让仍在调用的旧客户端拿到确定错误而不是 404 或静默成功。V3 订单面在
// /product/v3/*（product-order / product-read-kernel / product-tasks）。

import type { RouteModule } from "../route-module.js";

const V1_ORDER_SURFACE: readonly RegExp[] = [
  /^\/product\/order-drafts$/,
  /^\/product\/order-drafts\/([^/]+)$/,
  /^\/product\/order-drafts\/([^/]+)\/requirements(?:\/consents)?$/,
  /^\/product\/orders\/([^/]+)\/invites$/,
  /^\/product\/orders\/([^/]+)\/participants$/,
  /^\/product\/invites\/([^/]+)(?:\/(?:preview|accept|reject|revoke))?$/
];

export function createV1OrderGoneRouteModule(): RouteModule {
  return {
    async handle(request) {
      if (!V1_ORDER_SURFACE.some((pattern) => pattern.test(request.pathname))) {
        return undefined;
      }
      return {
        status: 410,
        body: {
          error: "v1_order_surface_removed",
          message: "the V1 order draft/invite/participant/requirements surface was removed; use /product/v3 order routes"
        }
      };
    }
  };
}
