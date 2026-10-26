import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createApiRouter, type ApiRouter } from "../src/api/routes.js";
import { loadConfigFromEnv } from "../src/config/index.js";
import { createChainServicesStores, type ChainServicesStores } from "../src/storage/factory.js";
import { createPostgresTestDatabase } from "./postgres.js";
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
          authMode: "anonymous" as const,
          canWrite: false,
          canAdmin: false,
        };
      }
      return {
        level: "store_operator" as const,
        roles: [] as const,
        authMode: "dev_store_headers" as const,
        canWrite: true,
        canAdmin: false,
        anchoredAddress: supplied as Address,
        anchorSource: "dev_header" as const,
      };
    },
  };
}

const wiredStores: ChainServicesStores[] = [];

afterEach(async () => {
  for (const stores of wiredStores.splice(0)) {
    await stores.close();
  }
});

function requiredRouterStores(stores: ChainServicesStores) {
  return {
    storeWalletSessionStore: stores.storeWalletSessionStore,
    identityDescriptorSnapshots: stores.identityDescriptorSnapshots,
    productBffStore: stores.productBffStore,
    orderStore: stores.orderStore,
    orderRequirementsStore: stores.orderRequirementsStore,
    evidenceMetadataStore: stores.evidenceMetadataStore,
    submissionStore: stores.submissionStore,
    governanceStore: stores.governanceStore,
    stageExecutorPatchStore: stores.stageExecutorPatchStore,
    stageResourcePatchStore: stores.stageResourcePatchStore,
  };
}

async function router(): Promise<ApiRouter> {
  const stores = createChainServicesStores({
    database: { url: await createPostgresTestDatabase(), migrationsAutoRun: true }
  });
  wiredStores.push(stores);
  return createApiRouter(stores.projectionStore, {
    ...requiredRouterStores(stores),
    productRuntimeEnvironment: "local",
    submissionChainId: 31337,
    submissionVerifyingContract: stateMachine,
    productTriggerChainId: 31337,
    orderChainId: 31337,
    orderStateMachineAddress: stateMachine,
    storeIdentityProvider: identityProvider() as never,
    now: () => new Date("2026-10-25T00:00:00.000Z"),
  });
}

const unknownOrder = `0x${"ab".repeat(32)}`;

describe("order integration wiring", () => {

  it("registers product-signals and tasks routes", async () => {
    const app = await router();
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

  it("requires wallet identity for finalize preparation on unknown orders", async () => {
    const app = await router();
    const response = await app.handle({
      method: "POST",
      pathname: `/product/v3/order-drafts/${unknownOrder}/finalize/prepare`,
      headers: {},
      body: {},
    });
    expect(response).toMatchObject({ status: 401, body: { error: "wallet_identity_required" } });
  });

  it("applies the order Postgres schema through the store factory", async () => {
    const stores = createChainServicesStores({
      database: {
        url: await createPostgresTestDatabase(),
        migrationsAutoRun: true,
      },
      migrationsDirectory: fileURLToPath(new URL("../migrations", import.meta.url)),
    });
    try {
      expect(await stores.orderStore.getConfig("missing", "1.0.0")).toBeUndefined();
    } finally {
      await stores.close();
    }
  });
});

const mandatoryEnv = {
  CHAIN_SERVICES_RUNTIME_ENV: "local",
  CHAIN_SERVICES_DATABASE_URL: "postgres://uvp:uvp@127.0.0.1:5432/uvp_chain_services",
  UVP_PRODUCT_BFF_REGISTRATION_ADAPTER: "memory-trigger",
} as const;

describe("order birth env wiring", () => {
  it("accepts the local-only birth signer", () => {
    const key = `0x${randomBytes(32).toString("hex")}`;
    const config = loadConfigFromEnv({
      ...mandatoryEnv,
      UVP_ORDER_V3_BIRTH_SIGNER_KEY: key,
    });
    expect(config.orderBirth?.signerPrivateKey).toBe(key);
    expect(config.orderBirth?.broadcastEnabled).toBe(true);
    expect(() =>
      loadConfigFromEnv({
        ...mandatoryEnv,
        CHAIN_SERVICES_RUNTIME_ENV: "testnet",
        UVP_ORDER_V3_BIRTH_SIGNER_KEY: key,
      }),
    ).toThrow(/only allowed in local/);
  });
});
