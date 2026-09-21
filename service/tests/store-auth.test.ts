import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { createApiRouter } from "../src/api/routes.js";
import { MemoryProjectionStore } from "../src/storage/projection-store.js";
import type { StoreSessionDTO } from "../src/store/console/access.js";

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

describe("Store operator identity and capability auth", () => {
  it("resolves Store sessions through the identity provider capability matrix", async () => {
    const router = createApiRouter(new MemoryProjectionStore(), { productRuntimeEnvironment: "local", submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111" });

    await expect(session(router, undefined)).resolves.toMatchObject({
      authenticated: false,
      accessLevel: "anonymous_read",
      authMode: "anonymous",
      capabilities: ["store.read"]
    });

    await expect(session(router, readHeaders)).resolves.toMatchObject({
      authenticated: true,
      principalId: "reader-1",
      accessLevel: "store_read",
      authMode: "dev_store_headers",
      capabilities: ["store.read", "store.audit.read", "store.docking.read"]
    });

    const operator = await session(router, operatorHeaders);
    expect(operator).toMatchObject({
      authenticated: true,
      principalId: "operator-1",
      accessLevel: "store_operator",
      authMode: "dev_store_headers"
    });
    expect(operator.capabilities).toContain("store.draft.import");
    expect(operator.capabilities).toContain("store.docking.save");

    const storeAdmin = await session(router, storeAdminHeaders);
    expect(storeAdmin).toMatchObject({
      authenticated: true,
      principalId: "store-admin-1",
      accessLevel: "store_admin",
      authMode: "dev_store_headers"
    });
    expect(storeAdmin.capabilities).toContain("store.version.activate");

    const governanceAdmin = await session(router, governanceAdminHeaders);
    expect(governanceAdmin).toMatchObject({
      authenticated: true,
      principalId: "governance-admin-1",
      accessLevel: "store_admin",
      authMode: "dev_governance_admin_headers",
      roles: ["store_admin", "governance_admin"]
    });
    expect(governanceAdmin.capabilities).toContain("store.supplier.identity.register");
    expect(governanceAdmin.capabilities).toContain("store.supplier.identity.revoke");
  });

  it("fails Store writes closed when a principal lacks the named capability", async () => {
    const router = createApiRouter(new MemoryProjectionStore(), { productRuntimeEnvironment: "local", submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111" });

    await expect(router.handle({
      method: "POST",
      pathname: "/store/zhixu-drafts/import",
      body: importBody()
    })).resolves.toMatchObject({
      status: 401,
      body: {
        error: "store_identity_missing",
        requiredCapability: "store.draft.import",
        requiredAccess: "store_operator",
        accessLevel: "anonymous_read"
      }
    });

    await expect(router.handle({
      method: "POST",
      pathname: "/store/zhixu-drafts/import",
      headers: readHeaders,
      body: importBody()
    })).resolves.toMatchObject({
      status: 403,
      body: {
        error: "forbidden",
        requiredCapability: "store.draft.import",
        requiredAccess: "store_operator",
        accessLevel: "store_read"
      }
    });
  });

  it("disables development header auth in staging and production runtime", async () => {
    const router = createApiRouter(new MemoryProjectionStore(), { submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111",
      productRuntimeEnvironment: "staging",
      evidenceRuntimeEnvironment: "local"
    });

    await expect(session(router, operatorHeaders)).resolves.toMatchObject({
      authenticated: false,
      accessLevel: "anonymous_read",
      authMode: "dev_headers_disabled",
      capabilities: ["store.read"]
    });

    await expect(router.handle({
      method: "POST",
      pathname: "/store/zhixu-drafts/import",
      headers: operatorHeaders,
      body: importBody()
    })).resolves.toMatchObject({
      status: 401,
      body: {
        error: "store_identity_missing",
        requiredCapability: "store.draft.import",
        accessLevel: "anonymous_read",
        authMode: "dev_headers_disabled"
      }
    });
  });

  it("binds wallet challenges to the issuing domain and rejects cross-domain replay", async () => {
    // 同一部署被多个域名触达时，A 域签下的登录证明不得在 B 域换会话：
    // 挑战按签发时的请求 Host 绑定（写入签名 message），verify 时点按
    // 当前请求 Host 复核；跨域重放被拒且不烧挑战。
    const router = createApiRouter(new MemoryProjectionStore(), { productRuntimeEnvironment: "local", submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111" });
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

    // 被重放方不承担烧挑战的代价：签发域内核验仍成功。
    const verified = await router.handle({
      method: "POST",
      pathname: "/store/auth/verify",
      headers: { host: "console.good.example" },
      body: { nonce: challenge.nonce, signature }
    });
    expect(verified.status).toBe(201);
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

function importBody(): Record<string, unknown> {
  return {
    sourceKind: "zhixu_yaml",
    content: "apiVersion: uvp/v0\nkind: Zhixu\nmetadata:\n  name: auth-probe\n"
  };
}
