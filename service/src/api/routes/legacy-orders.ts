import type { RouteModule } from "../route-module.js";

export function createLegacyOrdersRouteModule(): RouteModule {
  return {
    async handle(request, context) {
      if (request.method === "GET" && request.pathname === "/orders") {
        return {
          status: 200,
          body: { orders: await context.store.listOrders() }
        };
      }

      const orderMatch = /^\/orders\/([^/]+)$/.exec(request.pathname);
      if (request.method === "GET" && orderMatch) {
        const orderId = decodeURIComponent(orderMatch[1] ?? "");
        const order = await context.store.getOrder(orderId);
        if (!order) {
          return {
            status: 404,
            body: { error: "order_not_found" }
          };
        }
        return {
          status: 200,
          body: { order }
        };
      }

      return undefined;
    }
  };
}
