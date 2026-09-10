import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createApiRouter } from "../src/api/routes.js";
import { MemoryProjectionStore } from "../src/storage/projection-store.js";
import type { StoreAuthConfig } from "../src/config/index.js";
import { createStoreIdentityProvider, type StoreSessionDTO } from "../src/store-console/access.js";

const issuer = "https://identity.example/";
const audience = "uvp-store";
const kid = "store-auth-test-key";

describe("Store JWT/JWKS operator identity", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => closeServer(server)));
  });

  it("resolves Store sessions from verified JWT claims without exposing raw claims", async () => {
    const fixture = await createJwksFixture(servers);
    const router = createJwtRouter(fixture);
    const token = await signStoreToken(fixture, {
      sub: "operator-1",
      name: "Operator One",
      roles: ["store_operator"]
    });

    const session = await storeSession(router, token);

    expect(session).toMatchObject({
      authenticated: true,
      principalId: "operator-1",
      displayName: "Operator One",
      accessLevel: "store_operator",
      roles: ["store_operator"],
      authMode: "jwt"
    });
    expect(session.capabilities).toContain("store.draft.import");
    expect(session.capabilities).toContain("store.docking.save");
    expect(JSON.stringify(session)).not.toContain("Bearer");
  });

  it("maps JWT Store roles to the existing capability matrix", async () => {
    const fixture = await createJwksFixture(servers);
    const router = createJwtRouter(fixture);

    await expect(storeSession(router, await signStoreToken(fixture, {
      sub: "reader-1",
      roles: ["store_reader"]
    }))).resolves.toMatchObject({
      accessLevel: "store_read",
      roles: ["store_reader"],
      capabilities: ["store.read", "store.audit.read", "store.docking.read"]
    });

    const storeAdmin = await storeSession(router, await signStoreToken(fixture, {
      sub: "store-admin-1",
      roles: ["store_admin"]
    }));
    expect(storeAdmin.capabilities).toContain("store.version.activate");

    const governanceAdmin = await storeSession(router, await signStoreToken(fixture, {
      sub: "governance-admin-1",
      roles: ["governance_admin"]
    }));
    expect(governanceAdmin).toMatchObject({
      accessLevel: "store_read",
      roles: ["governance_admin"]
    });
    expect(governanceAdmin.capabilities).toContain("store.supplier.identity.register");
    expect(governanceAdmin.capabilities).toContain("store.supplier.identity.revoke");
    expect(governanceAdmin.capabilities).not.toContain("store.draft.import");
    expect(governanceAdmin.capabilities).not.toContain("store.version.activate");
  });

  it("does not grant canWrite to read-level Store JWT identities", async () => {
    // store.docking.read 是读级能力：纯读会话（store_reader）不得因
    // 漏排该能力被判定 canWrite（JWT 访问态谓词）。
    const fixture = await createJwksFixture(servers);
    const provider = createStoreIdentityProvider({
      // 本地 JWKS fixture 是 http/127.0.0.1——strict runtime 会按 SSRF
      // 防线拒绝；canWrite 谓词与运行档位无关，用 local 装配即可。
      runtimeEnvironment: "local",
      authConfig: {
        mode: "jwt",
        jwksUrl: fixture.jwksUrl,
        issuer,
        audience,
        roleClaim: "roles",
        principalClaim: "sub",
        clockToleranceSeconds: 5
      }
    });

    const reader = await provider.resolve({
      authorization: `Bearer ${await signStoreToken(fixture, { sub: "reader-1", roles: ["store_reader"] })}`
    });
    expect(reader.capabilities).toEqual(["store.read", "store.audit.read", "store.docking.read"]);
    expect(reader.canWrite).toBe(false);

    const operator = await provider.resolve({
      authorization: `Bearer ${await signStoreToken(fixture, { sub: "operator-1", roles: ["store_operator"] })}`
    });
    expect(operator.capabilities).toContain("store.docking.read");
    expect(operator.canWrite).toBe(true);
  });

  it("requires JWT governance_admin principals to pass the governance whitelist", async () => {
    const fixture = await createJwksFixture(servers);
    // 白名单注入后，IdP 声明的 governance_admin 角色不再直接映射治理权威：
    // 未命中 GOVERNANCE_ADMIN_REVIEWER_IDS 的 principal 只保留公共读。
    const router = createJwtRouter(fixture, { governanceAdminIds: ["gov-reviewer-1"] });
    const unlisted = await storeSession(router, await signStoreToken(fixture, {
      sub: "idp-claims-admin",
      roles: ["governance_admin"]
    }));
    expect(unlisted.roles).not.toContain("governance_admin");
    expect(unlisted.capabilities).not.toContain("store.supplier.identity.register");
    expect(unlisted.capabilities).not.toContain("store.draft.review");
    expect(unlisted.capabilities).toEqual(["store.read"]);

    const listed = await storeSession(router, await signStoreToken(fixture, {
      sub: "gov-reviewer-1",
      roles: ["governance_admin"]
    }));
    expect(listed.roles).toContain("governance_admin");
    expect(listed.capabilities).toContain("store.supplier.identity.register");
  });

  it("returns 401 for missing or invalid JWT identity and 403 for underprivileged JWT identity", async () => {
    const fixture = await createJwksFixture(servers);
    const router = createJwtRouter(fixture);

    await expect(importDraft(router)).resolves.toMatchObject({
      status: 401,
      body: {
        error: "store_identity_missing",
        requiredCapability: "store.draft.import",
        authMode: "jwt"
      }
    });

    await expect(importDraft(router, "not-a-jwt")).resolves.toMatchObject({
      status: 401,
      body: { error: "store_identity_invalid" }
    });

    await expect(importDraft(router, await signStoreToken(fixture, {
      sub: "reader-1",
      roles: ["store_reader"]
    }))).resolves.toMatchObject({
      status: 403,
      body: {
        error: "forbidden",
        requiredCapability: "store.draft.import",
        accessLevel: "store_read",
        authMode: "jwt"
      }
    });
  });

  it("rejects bad signature, issuer, and audience before route authorization", async () => {
    const fixture = await createJwksFixture(servers);
    const router = createJwtRouter(fixture);
    const wrongKey = await generateKeyPair("RS256");

    for (const token of [
      await signStoreToken(fixture, { sub: "operator-1", roles: ["store_operator"] }, { issuer: "https://wrong.example/" }),
      await signStoreToken(fixture, { sub: "operator-1", roles: ["store_operator"] }, { audience: "wrong-audience" }),
      await new SignJWT({ roles: ["store_operator"] })
        .setProtectedHeader({ alg: "RS256", kid })
        .setIssuer(issuer)
        .setAudience(audience)
        .setSubject("operator-1")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(wrongKey.privateKey)
    ]) {
      await expect(importDraft(router, token)).resolves.toMatchObject({
        status: 401,
        body: { error: "store_identity_invalid" }
      });
    }
  });

  it("does not accept a local pilot JWKS as staging Store identity evidence", async () => {
    const fixture = await createJwksFixture(servers);
    const router = createJwtRouter(fixture, { runtimeEnvironment: "staging" });
    const token = await signStoreToken(fixture, {
      sub: "operator-1",
      roles: ["store_operator"]
    });

    await expect(importDraft(router, token)).resolves.toMatchObject({
      status: 401,
      body: {
        error: "store_identity_invalid",
        authMode: "jwt"
      }
    });
  });

  it("supports configured nested role, principal, and display-name claims", async () => {
    const fixture = await createJwksFixture(servers);
    const router = createJwtRouter(fixture, {
      roleClaim: "permissions.storeRoles",
      principalClaim: "operator.id",
      displayNameClaim: "operator.displayName"
    });
    const token = await signStoreToken(fixture, {
      operator: {
        id: "nested-operator-1",
        displayName: "Nested Operator"
      },
      permissions: {
        storeRoles: ["store_admin"]
      }
    });

    await expect(storeSession(router, token)).resolves.toMatchObject({
      authenticated: true,
      principalId: "nested-operator-1",
      displayName: "Nested Operator",
      accessLevel: "store_admin",
      roles: ["store_admin"]
    });
  });

  it("rejects a discovery-advertised jwks_uri that is not HTTPS or points at a private host in strict runtimes", async () => {
    // discovery 响应是外部输入，其 jwks_uri 可把密钥拉取指向内网
    // 端点/明文信道（受限 SSRF 纵深）。非 local 复用配置层同款校验；
    // local 开发允许本地 IdP。
    const originalFetch = globalThis.fetch;
    const discoveryCalls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      discoveryCalls.push(String(input));
      return new Response(JSON.stringify({
        issuer,
        jwks_uri: "http://127.0.0.1:8443/.well-known/jwks.json"
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    try {
      const strictConfig: StoreAuthConfig = {
        mode: "jwt",
        oidcDiscoveryUrl: `${issuer}.well-known/openid-configuration`,
        issuer,
        audience,
        roleClaim: "roles",
        principalClaim: "sub",
        clockToleranceSeconds: 60
      };
      const provider = createStoreIdentityProvider({
        runtimeEnvironment: "staging",
        authConfig: strictConfig
      });
      const access = await provider.resolve({ authorization: "Bearer some.jwt.token" });
      expect(access.authenticationFailure?.code).toBe("store_identity_unavailable");
      expect(access.authenticationFailure?.message).toContain("jwks_uri must be HTTPS on a non-private host");
      expect(discoveryCalls).toHaveLength(1);

      const localProvider = createStoreIdentityProvider({
        runtimeEnvironment: "local",
        authConfig: strictConfig
      });
      const localAccess = await localProvider.resolve({ authorization: "Bearer some.jwt.token" });
      expect(localAccess.authenticationFailure?.message ?? "").not.toContain("jwks_uri must be HTTPS");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("discovers the JWKS URI from vendor-neutral OIDC metadata", async () => {
    const fixture = await createJwksFixture(servers);
    const router = createJwtRouter(fixture, {
      jwksUrl: null,
      oidcDiscoveryUrl: fixture.oidcDiscoveryUrl
    });
    const token = await signStoreToken(fixture, {
      sub: "oidc-operator-1",
      roles: ["store_operator"]
    });

    await expect(storeSession(router, token)).resolves.toMatchObject({
      authenticated: true,
      principalId: "oidc-operator-1",
      accessLevel: "store_operator",
      authMode: "jwt"
    });
  });
});

type JwksFixture = Awaited<ReturnType<typeof createJwksFixture>>;
type GeneratedPrivateKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

async function createJwksFixture(servers: Server[]) {
  const keyPair = await generateKeyPair("RS256");
  const jwk = await exportJWK(keyPair.publicKey) as unknown as Record<string, unknown>;
  jwk.kid = kid;
  jwk.alg = "RS256";
  jwk.use = "sig";

  const server = createServer((request, response) => {
    if (request.url === "/.well-known/openid-configuration") {
      response.statusCode = 200;
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(JSON.stringify({
        issuer,
        jwks_uri: `http://${request.headers.host}/.well-known/jwks.json`
      }));
      return;
    }
    if (request.url !== "/.well-known/jwks.json") {
      response.statusCode = 404;
      response.end();
      return;
    }
    response.statusCode = 200;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(JSON.stringify({ keys: [jwk] }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("JWKS test server did not bind to a TCP address");
  }

  return {
    privateKey: keyPair.privateKey,
    jwksUrl: `http://127.0.0.1:${(address as AddressInfo).port}/.well-known/jwks.json`,
    oidcDiscoveryUrl: `http://127.0.0.1:${(address as AddressInfo).port}/.well-known/openid-configuration`
  };
}

type JwtRouterOverrides = Partial<Pick<StoreAuthConfig, "roleClaim" | "principalClaim" | "displayNameClaim" | "oidcDiscoveryUrl">> & {
  readonly jwksUrl?: string | null;
  readonly runtimeEnvironment?: "local" | "testnet" | "staging" | "production";
  readonly governanceAdminIds?: readonly string[];
};

function createJwtRouter(
  fixture: JwksFixture,
  overrides: JwtRouterOverrides = {}
): ReturnType<typeof createApiRouter> {
  return createApiRouter(new MemoryProjectionStore(), { submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111",
    productRuntimeEnvironment: overrides.runtimeEnvironment ?? "local",
    ...(overrides.governanceAdminIds ? { governanceAdminIds: overrides.governanceAdminIds } : {}),
    evidenceRuntimeEnvironment: "local",
    storeAuthConfig: {
      mode: "jwt",
      ...(overrides.jwksUrl === null ? {} : { jwksUrl: overrides.jwksUrl ?? fixture.jwksUrl }),
      ...(overrides.oidcDiscoveryUrl ? { oidcDiscoveryUrl: overrides.oidcDiscoveryUrl } : {}),
      issuer,
      audience,
      roleClaim: overrides.roleClaim ?? "roles",
      principalClaim: overrides.principalClaim ?? "sub",
      displayNameClaim: overrides.displayNameClaim ?? "name",
      clockToleranceSeconds: 5
    }
  });
}

async function signStoreToken(
  fixture: { readonly privateKey: GeneratedPrivateKey },
  payload: Record<string, unknown>,
  options: { readonly issuer?: string; readonly audience?: string } = {}
): Promise<string> {
  const jwt = new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuer(options.issuer ?? issuer)
    .setAudience(options.audience ?? audience)
    .setIssuedAt()
    .setExpirationTime("5m");

  return jwt.sign(fixture.privateKey);
}

async function storeSession(
  router: ReturnType<typeof createApiRouter>,
  token: string
): Promise<StoreSessionDTO> {
  const response = await router.handle({
    method: "GET",
    pathname: "/store/session",
    headers: { authorization: `Bearer ${token}` }
  });
  expect(response.status).toBe(200);
  return (response.body as { session: StoreSessionDTO }).session;
}

async function importDraft(
  router: ReturnType<typeof createApiRouter>,
  token?: string
) {
  return router.handle({
    method: "POST",
    pathname: "/store/zhixu-drafts/import",
    ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
    body: {
      sourceKind: "zhixu_yaml",
      content: "apiVersion: uvp/v0\nkind: Zhixu\nmetadata:\n  name: jwt-auth-probe\n"
    }
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
