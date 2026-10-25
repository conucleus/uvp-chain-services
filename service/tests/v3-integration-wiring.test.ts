// V3 集成接线回归：共享路由注册（order/read/tasks/binding/signals）、会话
// 身份门、factory 的 binding/settlement/runtime store 装配与 sqlite 迁移。

import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApiRouter } from "../src/api/routes.js";
import { loadConfigFromEnv } from "../src/config/index.js";
import { createChainServicesStores } from "../src/storage/factory.js";
import { MemoryProjectionStore } from "../src/storage/projection-store.js";
import type { Address } from "../src/shared/types.js";

const stateMachine = "0x9999999999999999999999999999999999999999" as Address;
const wallet = "0x1111111111111111111111111111111111111111" as Address;

function identityProvider() {
  return {
    async resolve(headers: Record<string, string | undefined> | undefined) {
      const supplied = headers?.["x-test-wallet"];
      if (!supplied) {
        return {
          level: "anonymous_read" as const,
          roles: [] as const,
          capabilities: [] as const,
          authMode: "anonymous" as const,
          canWrite: false,
          canAdmin: false,
        };
      }
      return {
        level: "store_operator" as const,
        roles: [] as const,
        capabilities: [] as const,
        authMode: "dev_store_headers" as const,
        canWrite: true,
        canAdmin: false,
        anchoredAddress: supplied as Address,
        anchorSource: "dev_header" as const,
      };
    },
  };
}

function router() {
  return createApiRouter(new MemoryProjectionStore(), {
    productRuntimeEnvironment: "local",
    submissionChainId: 31337,
    submissionVerifyingContract: stateMachine,
    productTriggerChainId: 31337,
    orderV3ChainId: 31337,
    orderV3StateMachineAddress: stateMachine,
    storeIdentityProvider: identityProvider() as never,
    now: () => new Date("2026-10-25T00:00:00.000Z"),
  });
}

const unknownOrder = `0x${"ab".repeat(32)}`;

describe("V3 integration wiring", () => {

  it("registers product-v3-signals and tasks routes", async () => {
    const app = router();
    const candidates = await app.handle({
      method: "GET",
      pathname: `/product/v3/orders/${unknownOrder}/signal-candidates`,
      headers: { "x-test-wallet": wallet },
    });
    expect(candidates.status).toBe(404);
    expect((candidates.body as { error: string }).error).toBe("order_not_found");

    const tasks = await app.handle({
      method: "GET",
      pathname: "/product/v3/tasks",
      query: { orderId: unknownOrder },
      headers: { "x-test-wallet": wallet },
    });
    expect(tasks.status).toBe(404);

    const anonymousTasks = await app.handle({
      method: "GET",
      pathname: "/product/v3/tasks",
      query: { orderId: unknownOrder },
      headers: {},
    });
    expect(anonymousTasks.status).toBe(401);
  });

  it("serves V3 finalize preparation while legacy BFF trigger routes are gone", async () => {
    const app = router();
    for (const pathname of [
      "/product/order-drafts/draft_1/prepare-trigger",
      "/product/order-drafts/draft_1/trigger",
      "/product/order-triggers/trg_1"
    ]) {
      const legacy = await app.handle({
        method: pathname.includes("order-triggers") ? "GET" : "POST",
        pathname,
        headers: { "x-test-wallet": wallet },
        body: {},
      });
      expect(legacy).toMatchObject({ status: 404, body: { error: "not_found" } });
    }
    const v3 = await app.handle({
      method: "POST",
      pathname: `/product/v3/order-drafts/${unknownOrder}/finalize/prepare`,
      headers: {},
      body: {},
    });
    expect(v3).toMatchObject({ status: 401, body: { error: "wallet_identity_required" } });
  });

  it("applies V3 sqlite migrations through the store factory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "uvp-v3-wiring-"));
    const stores = createChainServicesStores({
      database: {
        driver: "sqlite",
        url: `sqlite://${join(dir, "v3.sqlite")}`,
        migrationsAutoRun: true,
      },
    });
    try {
      expect(await stores.orderV3Store.getConfig("missing", "1.0.0")).toBeUndefined();
    } finally {
      await stores.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const mandatoryEnv = {
  CHAIN_SERVICES_RUNTIME_ENV: "local",
  CHAIN_SERVICES_DATABASE_DRIVER: "memory",
  CHAIN_SERVICES_DATABASE_URL: "memory://projection-store",
  UVP_PRODUCT_BFF_REGISTRATION_ADAPTER: "memory-trigger",
} as const;

describe("V3 env wiring", () => {
  it("accepts the local-only birth signer", () => {
    const key = `0x${randomBytes(32).toString("hex")}`;
    const config = loadConfigFromEnv({
      ...mandatoryEnv,
      UVP_ORDER_V3_BIRTH_SIGNER_KEY: key,
    });
    expect(config.orderV3Birth?.signerPrivateKey).toBe(key);
    expect(config.orderV3Birth?.broadcastEnabled).toBe(true);
    expect(() =>
      loadConfigFromEnv({
        ...mandatoryEnv,
        CHAIN_SERVICES_RUNTIME_ENV: "testnet",
        UVP_ORDER_V3_BIRTH_SIGNER_KEY: key,
      }),
    ).toThrow(/only allowed in local/);
  });
});
