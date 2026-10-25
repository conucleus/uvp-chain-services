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
  it("registers product-binding routes and enforces the session gate", async () => {
    const app = router();
    const anonymous = await app.handle({
      method: "GET",
      pathname: `/product/orders/${unknownOrder}/bindings`,
      headers: {},
    });
    expect(anonymous.status).toBe(401);

    const bound = await app.handle({
      method: "GET",
      pathname: `/product/orders/${unknownOrder}/bindings`,
      headers: { "x-test-wallet": wallet },
    });
    expect(bound.status).toBe(404);
    expect((bound.body as { error: string }).error).toBe("order_not_found");

    const deposit = await app.handle({
      method: "POST",
      pathname: `/product/orders/${unknownOrder}/stages/alpha/deposit-intent`,
      headers: { "x-test-wallet": wallet },
      body: {},
    });
    expect([404, 409, 503]).toContain(deposit.status);
    expect((deposit.body as { error: string }).error).not.toBe("not_found");
  });

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

  it("assembles binding/settlement/runtime stores for sqlite and applies 0032/0033", async () => {
    const dir = mkdtempSync(join(tmpdir(), "uvp-v3-wiring-"));
    const stores = createChainServicesStores({
      database: {
        driver: "sqlite",
        url: `sqlite://${join(dir, "v3.sqlite")}`,
        migrationsAutoRun: true,
      },
    });
    try {
      const now = "2026-10-25T00:00:00.000Z";
      await stores.bindingStore.saveEscrowInstance({
        chainId: 31337,
        escrowAddress: "0x2222222222222222222222222222222222222222",
        contractVersion: "v3",
        startBlock: "0",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      const instances = await stores.bindingStore.listEscrowInstances();
      expect(instances).toHaveLength(1);
      expect(instances[0]!.contractVersion).toBe("v3");
      // settlement/runtime stores are queryable (empty ledger is "none", not error).
      expect(await stores.settlementStore.listByOrder(unknownOrder, 10)).toEqual([]);
      expect(await stores.runtimeStore.listDueFacts(unknownOrder)).toEqual([]);
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
  it("parses escrow v3 + fact source and local-only birth signer", () => {
    const key = `0x${randomBytes(32).toString("hex")}`;
    const config = loadConfigFromEnv({
      ...mandatoryEnv,
      UVP_ESCROW_V3_ADDRESS: "0x3333333333333333333333333333333333333333",
      UVP_ESCROW_V3_TOKEN_ADDRESS: "0x4444444444444444444444444444444444444444",
      UVP_ESCROW_V3_START_BLOCK: "99",
      UVP_ESCROW_V3_DEPLOYMENT_BLOCK: "42",
      FACT_SOURCE_ADDRESS: "0x5555555555555555555555555555555555555555",
      UVP_ORDER_V3_BINDING_INDEX_POLL_INTERVAL_MS: "2500",
      UVP_ORDER_V3_BIRTH_SIGNER_KEY: key,
    });
    expect(config.escrowV3).toMatchObject({
      chainId: 31337,
      startBlock: 99n,
      deploymentBlock: 42n,
      indexPollIntervalMs: 2500,
    });
    expect(config.escrowV3?.factSourceAddress).toBe("0x5555555555555555555555555555555555555555");
    expect(config.orderV3Birth?.signerPrivateKey).toBe(key);
    expect(config.orderV3Birth?.broadcastEnabled).toBe(true);

    expect(() =>
      loadConfigFromEnv({
        ...mandatoryEnv,
        CHAIN_SERVICES_RUNTIME_ENV: "testnet",
        UVP_ORDER_V3_BIRTH_SIGNER_KEY: key,
      }),
    ).toThrow(/only allowed in local/);

    expect(() =>
      loadConfigFromEnv({
        ...mandatoryEnv,
        UVP_ESCROW_V3_ADDRESS: "0x3333333333333333333333333333333333333333",
        UVP_ESCROW_V3_CHAIN_ID: "1",
      }),
    ).toThrow(/UVP_ESCROW_V3_CHAIN_ID must match UVP_CHAIN_ID/);
  });
});
