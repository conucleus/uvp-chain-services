import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { createApiRouter } from "../src/api/routes.js";
import { createChainServicesStores, type ChainServicesStores } from "../src/storage/factory.js";
import { createPostgresTestDatabase } from "./postgres.js";
import type { StoreSessionDTO } from "../src/store/console/access.js";

let stores: ChainServicesStores;

beforeAll(async () => {
  stores = createChainServicesStores({
    database: { url: await createPostgresTestDatabase(), migrationsAutoRun: true }
  });
});

afterAll(async () => {
  await stores.close();
});

function requiredRouterStores() {
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

const readHeaders = {
  "x-uvp-store-user-id": "reader-1",
  "x-uvp-store-role": "read"
};

const operatorHeaders = {
  "x-uvp-store-operator-id": "operator-1",
  "x-uvp-store-operator-role": "store_operator"
};

const storeAdminHeaders = {
  "x-uvp-store-user-id": "store-admin-1",
  "x-uvp-store-role": "admin"
};

const governanceAdminHeaders = {
  "x-uvp-admin-id": "governance-admin-1",
  "x-uvp-admin-role": "admin"
};

describe("Store operator identity and access auth", () => {
  it("resolves Store sessions through the identity provider access roles", async () => {
    const router = createApiRouter(stores.projectionStore, { ...requiredRouterStores(), productRuntimeEnvironment: "local", submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111" });

    await expect(session(router, undefined)).resolves.toMatchObject({
      authenticated: false,
      accessLevel: "anonymous_read",
      authMode: "anonymous",
      roles: ["anonymous_read"],
      canWrite: false,
      canAdmin: false
    });

    await expect(session(router, readHeaders)).resolves.toMatchObject({
      authenticated: true,
      principalId: "reader-1",
      accessLevel: "store_read",
      authMode: "dev_store_headers",
      roles: ["store_read"],
      canWrite: false,
      canAdmin: false
    });

    await expect(session(router, operatorHeaders)).resolves.toMatchObject({
      authenticated: true,
      principalId: "operator-1",
      accessLevel: "store_operator",
      authMode: "dev_store_headers",
      roles: ["store_operator"],
      canWrite: true,
      canAdmin: false
    });

    await expect(session(router, storeAdminHeaders)).resolves.toMatchObject({
      authenticated: true,
      principalId: "store-admin-1",
      accessLevel: "store_admin",
      authMode: "dev_store_headers",
      roles: ["store_admin"],
      canWrite: true,
      canAdmin: true
    });

    await expect(session(router, governanceAdminHeaders)).resolves.toMatchObject({
      authenticated: true,
      principalId: "governance-admin-1",
      accessLevel: "store_admin",
      authMode: "dev_governance_admin_headers",
      roles: ["store_admin", "governance_admin"],
      canWrite: true,
      canAdmin: true
    });
  });

  it("disables development header auth in staging and production runtime", async () => {
    const router = createApiRouter(stores.projectionStore, { ...requiredRouterStores(), submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111",
      productRuntimeEnvironment: "staging",
      evidenceRuntimeEnvironment: "local"
    });

    await expect(session(router, operatorHeaders)).resolves.toMatchObject({
      authenticated: false,
      accessLevel: "anonymous_read",
      authMode: "dev_headers_disabled"
    });

  });

  it("binds wallet challenges to the issuing domain and rejects cross-domain replay", async () => {
    const router = createApiRouter(stores.projectionStore, { ...requiredRouterStores(), productRuntimeEnvironment: "local", submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111" });
    const account = privateKeyToAccount("0x2222222222222222222222222222222222222222222222222222222222222222");

    const challengeResponse = await router.handle({
      method: "POST",
      pathname: "/store/auth/challenge",
      headers: { host: "console.good.example" },
      body: { address: account.address }
    });
    expect(challengeResponse.status).toBe(201);
    const challenge = (challengeResponse.body as { challenge: { nonce: string; message: string } }).challenge;
    expect(challenge.message).toContain("Domain: console.good.example");

    const signature = await account.signMessage({ message: challenge.message });

    const replay = await router.handle({
      method: "POST",
      pathname: "/store/auth/verify",
      headers: { host: "mirror.evil.example" },
      body: { nonce: challenge.nonce, signature }
    });
    expect(replay.status).toBe(401);
    expect(replay.body).toMatchObject({ error: "store_challenge_domain_mismatch" });

    const verified = await router.handle({
      method: "POST",
      pathname: "/store/auth/verify",
      headers: { host: "console.good.example" },
      body: { nonce: challenge.nonce, signature }
    });
    expect(verified.status).toBe(201);
  });

  it("rejects a malformed Host header with a header-scoped error code, not invalid_body", async () => {
    const router = createApiRouter(stores.projectionStore, { ...requiredRouterStores(), productRuntimeEnvironment: "local", submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111" });

    const hostileCharacters = await router.handle({
      method: "POST",
      pathname: "/store/auth/challenge",
      headers: { host: "console.good.example/../../evil\r\nX-Injected: 1" },
      body: { address: "0x0000000000000000000000000000000000000001" }
    });
    expect(hostileCharacters).toMatchObject({
      status: 400,
      body: { error: "store_challenge_domain_invalid" }
    });

    const overlong = await router.handle({
      method: "POST",
      pathname: "/store/auth/challenge",
      headers: { host: `${"a".repeat(256)}.example` },
      body: { address: "0x0000000000000000000000000000000000000001" }
    });
    expect(overlong).toMatchObject({
      status: 400,
      body: { error: "store_challenge_domain_invalid" }
    });
  });
});

async function session(
  router: ReturnType<typeof createApiRouter>,
  headers: Readonly<Record<string, string>> | undefined
): Promise<StoreSessionDTO> {
  const response = await router.handle({
    method: "GET",
    pathname: "/store/session",
    ...(headers ? { headers } : {})
  });
  expect(response.status).toBe(200);
  return (response.body as { session: StoreSessionDTO }).session;
}

