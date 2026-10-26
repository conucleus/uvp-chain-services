import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiRouter } from "../src/api/routes.js";
import { createChainServicesStores, type ChainServicesStores } from "../src/storage/factory.js";
import { createPostgresTestDatabase } from "./postgres.js";

let stores: ChainServicesStores;

beforeAll(async () => {
  stores = createChainServicesStores({
    database: { url: await createPostgresTestDatabase(), migrationsAutoRun: true }
  });
});

afterAll(async () => {
  await stores.close();
});

function routerOptions(runtimeEnvironment: "local" | "production" = "local") {
  return { runtimeEnvironment };
}

describe("API router composition", () => {
  it("returns not_found for unknown routes", async () => {
    const router = createApiRouter(stores.projectionStore, routerOptions());

    await expect(router.handle({ method: "GET", pathname: "/unknown-route" }))
      .resolves.toEqual({
        status: 404,
        body: { error: "not_found" }
      });
  });

  it("retires the V1 order draft/invite/participant/requirements surface with 410", async () => {
    const router = createApiRouter(stores.projectionStore, routerOptions());

    for (const request of [
      { method: "POST", pathname: "/product/order-drafts", body: { title: "gone" } },
      { method: "GET", pathname: "/product/orders/0xabc/participants" },
      { method: "PUT", pathname: "/product/order-drafts/draft-1/requirements", body: {} }
    ]) {
      await expect(router.handle(request)).resolves.toMatchObject({
        status: 410,
        body: { error: "v1_order_surface_removed" }
      });
    }
  });

  it("drops the legacy prepare/submission/wallet-claim surface instead of serving it", async () => {
    const router = createApiRouter(stores.projectionStore, routerOptions());

    for (const request of [
      { method: "POST", pathname: "/product/tasks/task-1/prepare-submit", body: {} },
      { method: "POST", pathname: "/product/tasks/task-1/submit", body: {} },
      { method: "GET", pathname: "/product/submissions/sub_1" },
      { method: "POST", pathname: "/product/tasks/task-1/prepare-stage-executor-patch", body: {} },
      { method: "POST", pathname: "/product/tasks/task-1/submit-stage-resource-patch", body: {} }
    ]) {
      await expect(router.handle(request)).resolves.toEqual({
        status: 404,
        body: { error: "not_found" }
      });
    }
  });

  it("rejects malformed percent-encoded path parameters with 400 instead of 500", async () => {
    const router = createApiRouter(stores.projectionStore, routerOptions());

    const response = await router.handle({
      method: "GET",
      pathname: "/chain/orders/%ZZ"
    });
    expect(response).toMatchObject({ status: 400, body: { error: "invalid_path_parameter" } });
  });
});
