import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createApiRouter } from "../src/api/routes.js";
import { MemoryProjectionStore } from "../src/storage/projection-store.js";
import type { StoreAuthConfig } from "../src/config/index.js";
import type { StoreSessionDTO } from "../src/store-console/access.js";

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
    expect(session.capabilities).not.toContain("store.draft.attestation.request");
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
      capabilities: ["store.read", "store.audit.read"]
    });

    const storeAdmin = await storeSession(router, await signStoreToken(fixture, {
      sub: "store-admin-1",
      roles: ["store_admin"]
    }));
    expect(storeAdmin.capabilities).toContain("store.version.activate");
    expect(storeAdmin.capabilities).not.toContain("store.version.revocation.request");

    const governanceAdmin = await storeSession(router, await signStoreToken(fixture, {
      sub: "governance-admin-1",
      roles: ["governance_admin"]
    }));
    expect(governanceAdmin).toMatchObject({
      accessLevel: "store_read",
      roles: ["governance_admin"]
    });
    expect(governanceAdmin.capabilities).toContain("store.draft.attestation.request");
    expect(governanceAdmin.capabilities).toContain("store.supplier.revocation.request");
    expect(governanceAdmin.capabilities).not.toContain("store.draft.import");
    expect(governanceAdmin.capabilities).not.toContain("store.version.activate");
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
    jwksUrl: `http://127.0.0.1:${(address as AddressInfo).port}/.well-known/jwks.json`
  };
}

function createJwtRouter(
  fixture: JwksFixture,
  overrides: Partial<Pick<StoreAuthConfig, "roleClaim" | "principalClaim" | "displayNameClaim">> = {}
): ReturnType<typeof createApiRouter> {
  return createApiRouter(new MemoryProjectionStore(), {
    productRuntimeEnvironment: "staging",
    evidenceRuntimeEnvironment: "local",
    storeAuthConfig: {
      mode: "jwt",
      jwksUrl: fixture.jwksUrl,
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
