import { describe, expect, it } from "vitest";
import { createApiRouter } from "../src/api/routes.js";
import { MemoryProjectionStore } from "../src/storage/projection-store.js";
import type { StoreSessionDTO } from "../src/store-console/access.js";

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
    const router = createApiRouter(new MemoryProjectionStore());

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
      capabilities: ["store.read", "store.audit.read"]
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
    expect(operator.capabilities).not.toContain("store.draft.attestation.request");

    const storeAdmin = await session(router, storeAdminHeaders);
    expect(storeAdmin).toMatchObject({
      authenticated: true,
      principalId: "store-admin-1",
      accessLevel: "store_admin",
      authMode: "dev_store_headers"
    });
    expect(storeAdmin.capabilities).toContain("store.version.activate");
    expect(storeAdmin.capabilities).not.toContain("store.version.revocation.request");

    const governanceAdmin = await session(router, governanceAdminHeaders);
    expect(governanceAdmin).toMatchObject({
      authenticated: true,
      principalId: "governance-admin-1",
      accessLevel: "store_admin",
      authMode: "dev_governance_admin_headers",
      roles: ["store_admin", "governance_admin"]
    });
    expect(governanceAdmin.capabilities).toContain("store.draft.attestation.request");
    expect(governanceAdmin.capabilities).toContain("store.supplier.revocation.request");
  });

  it("fails Store writes closed when a principal lacks the named capability", async () => {
    const router = createApiRouter(new MemoryProjectionStore());

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
    const router = createApiRouter(new MemoryProjectionStore(), {
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
