import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApiServer } from "../src/api/server.js";
import type { ChainServicesConfig } from "../src/config/index.js";
import type { ChainEventSource } from "../src/indexer/service.js";
import { buildConfigDiagnostics, loadConfigFromEnv } from "../src/config/index.js";
import { createApiRouter } from "../src/api/routes.js";
import { createChainServicesStores, type ChainServicesStores } from "../src/storage/factory.js";
import { projectionScopeContractAddress } from "../src/storage/projection-store.js";
import { createPostgresTestDatabase } from "./postgres.js";
import { redactSecrets } from "../src/security/index.js";
import type { Address } from "@uvp-eth/service-runtime";

let stores: ChainServicesStores;
let databaseUrl: string;

beforeAll(async () => {
  databaseUrl = await createPostgresTestDatabase();
  stores = createChainServicesStores({
    database: { url: databaseUrl, migrationsAutoRun: true },
    chainId: 31337
  });
});

afterAll(async () => {
  await stores.close();
});

const stateMachine = "0x1111111111111111111111111111111111111111" as Address;
const identityRegistry = "0x2222222222222222222222222222222222222222" as Address;
const now = "2026-04-29T00:00:00.000Z";
const adminHeaders = {
  "x-uvp-admin-id": "ops-admin-1",
  "x-uvp-admin-role": "admin"
};

describe("ops health diagnostics", () => {
  it("exposes safe runtime, indexer, and preflight summaries without retired business blocks", async () => {
    const projectionStore = stores.projectionStore;
    await projectionStore.saveSyncState({
      chainId: 31337,
      contractAddress: projectionScopeContractAddress,
      syncStatus: "indexed",
      latestIndexedBlock: 10n,
      finalizedBlock: 12n,
      confirmationDepth: 2,
      eventCount: 4,
      lastEventName: "HookReady",
      rebuild: {
        status: "completed",
        startedAt: now,
        completedAt: now,
        fromBlock: 0n,
        toBlock: 12n,
        eventCount: 4,
        mismatchCount: 0
      }
    });

    const router = createApiRouter(projectionStore, {
      runtimeEnvironment: "local",
      configDiagnostics: buildConfigDiagnostics(testConfig()),
      indexerDiagnostics: { configured: true, pollIntervalMs: 5_000 }
    });

    const response = await router.handle({ method: "GET", pathname: "/healthz" });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      sourceOfTruth: "contracts-and-chain-events",
      status: expect.any(String)
    });
    expect((response.body as Record<string, unknown>).diagnostics).toBeUndefined();

    const detailResponse = await router.handle({
      method: "GET",
      pathname: "/admin/diagnostics",
      headers: { "x-uvp-admin-id": "ops-admin-1", "x-uvp-admin-role": "governance_admin" }
    });
    expect(detailResponse.status).toBe(200);
    expect(detailResponse.body).toMatchObject({
      diagnostics: {
        backendAuthority: false,
        environment: "local",
        network: {
          chainId: 31337,
          contracts: {
            UVPStateMachine: stateMachine,
            UVPIdentityRegistry: identityRegistry
          }
        },
        preflight: { status: "skipped" },
        indexer: {
          configured: true,
          syncStatus: "indexed",
          latestIndexedBlock: "10",
          finalizedBlock: "12",
          lagBlocks: "2",
          rebuild: { status: "completed", eventCount: 4 }
        }
      }
    });
    const diagnostics = (detailResponse.body as { diagnostics: Record<string, unknown> }).diagnostics;
    expect(diagnostics).not.toHaveProperty("submissions");
  });

  it("requires admin headers for operator console routes", async () => {
    const router = createApiRouter(stores.projectionStore, { runtimeEnvironment: "local" });

    for (const request of [
      { method: "GET", pathname: "/admin/ops/status" },
      { method: "GET", pathname: "/admin/ops/summary" },
      { method: "POST", pathname: "/admin/ops/projections/rebuild" },
      { method: "GET", pathname: "/admin/ops/indexer/pending-steps" },
      { method: "POST", pathname: "/admin/ops/indexer/pending-steps/retry" }
    ]) {
      const response = await router.handle(request);
      expect(response.status).toBe(403);
      expect(response.body).toEqual({ error: "forbidden" });
    }
  });

  it("enforces the OPS_CONSOLE_ADMIN_IDS allowlist when configured", async () => {
    const router = createApiRouter(stores.projectionStore, {
      runtimeEnvironment: "local",
      opsConsoleAdminIds: ["ops-admin-1", "ops-admin-2"]
    });

    const allowed = await router.handle({
      method: "GET",
      pathname: "/admin/ops/status",
      headers: adminHeaders
    });
    expect(allowed.status).toBe(200);

    const outsideAdmin = await router.handle({
      method: "GET",
      pathname: "/admin/ops/status",
      headers: { "x-uvp-admin-id": "other-admin-9", "x-uvp-admin-role": "admin" }
    });
    expect(outsideAdmin.status).toBe(403);
    expect(outsideAdmin.body).toEqual({ error: "forbidden" });
  });

  it("falls back to the admin header check when no ops allowlist is configured", async () => {
    const router = createApiRouter(stores.projectionStore, { runtimeEnvironment: "local" });

    const response = await router.handle({
      method: "GET",
      pathname: "/admin/ops/status",
      headers: { "x-uvp-admin-id": "reviewer-9", "x-uvp-admin-role": "governance_admin" }
    });
    expect(response.status).toBe(200);
  });

  it("assembles real admin recovery actions in the running server", async () => {
    let server: Server | undefined;
    try {
      const eventSource: ChainEventSource = {
        async getFinalizedBlock() {
          return 0n;
        },
        async readEvents() {
          return [];
        }
      };
      server = await startApiServer({
        config: serverTestConfig(),
        eventSource
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected TCP server address");
      }
      const base = `http://127.0.0.1:${address.port}`;
      const headers = { "content-type": "application/json", ...adminHeaders, "x-request-id": "req-eth06-1" };

      const rebuild = await fetch(`${base}/admin/ops/projections/rebuild`, {
        method: "POST",
        headers
      });
      expect(rebuild.status).toBe(202);
      expect(await rebuild.json()).toMatchObject({
        ok: true,
        action: "projections.rebuild",
        status: "completed",
        summary: { eventCount: 0, syncStatus: "indexed" }
      });

      const pending = await fetch(`${base}/admin/ops/indexer/pending-steps`, { headers });
      expect(pending.status).toBe(200);
      expect(await pending.json()).toMatchObject({ ok: true, pendingSteps: [] });

      const sweep = await fetch(`${base}/admin/ops/indexer/pending-steps/retry`, {
        method: "POST",
        headers
      });
      expect(sweep.status).toBe(202);
      expect(await sweep.json()).toMatchObject({
        ok: true,
        action: "indexer.sweep_pending",
        status: "completed"
      });
    } finally {
      if (server) {
        await new Promise<void>((resolvePromise, reject) => {
          server!.close((error) => (error ? reject(error) : resolvePromise()));
        });
      }
    }
  });

  it("exposes admin operator status and redacted downloadable summary fields", async () => {
    const projectionStore = stores.projectionStore;
    await projectionStore.saveSyncState({
      chainId: 31337,
      contractAddress: projectionScopeContractAddress,
      syncStatus: "indexed",
      latestIndexedBlock: 10n,
      finalizedBlock: 12n,
      confirmationDepth: 2,
      eventCount: 4,
      rebuild: { status: "completed", toBlock: 12n, eventCount: 4 }
    });
    const router = createApiRouter(projectionStore, {
      runtimeEnvironment: "local",
      configDiagnostics: buildConfigDiagnostics(testConfig()),
      now: () => new Date(now)
    });

    const statusResponse = await router.handle({
      method: "GET",
      pathname: "/admin/ops/status",
      headers: adminHeaders
    });
    const summaryResponse = await router.handle({
      method: "GET",
      pathname: "/admin/ops/summary",
      headers: adminHeaders
    });

    expect(statusResponse.status).toBe(200);
    expect(statusResponse.body).toMatchObject({
      ok: true,
      sourceOfTruth: "contracts-and-chain-events",
      backendAuthority: false,
      readiness: { status: "ready", reasons: [] },
      runtime: {
        environment: "local",
        chainId: 31337,
        contracts: {
          UVPStateMachine: stateMachine,
          UVPIdentityRegistry: identityRegistry
        }
      },
      preflight: { status: "skipped" },
      indexer: {
        syncStatus: "indexed",
        latestIndexedBlock: "10",
        finalizedBlock: "12",
        lagBlocks: "2"
      },
      recoveryPolicy: {
        actionsAreNonAuthoritative: true,
        canCreateBusinessSignatures: false,
        canForgeChainState: false,
        allowedActions: ["projections.rebuild", "indexer.sweep_pending"]
      }
    });
    expect(statusResponse.body).not.toHaveProperty("submissions");
    expect(summaryResponse.status).toBe(200);
    expect(summaryResponse.body).toMatchObject({
      ok: true,
      filename: "uvp-ops-diagnostics-2026-04-29T00-00-00-000Z.json",
      mimeType: "application/json",
      summary: {
        sourceOfTruth: "contracts-and-chain-events",
        sync: {
          indexerStatus: "indexed",
          latestIndexedBlock: "10",
          finalizedBlock: "12",
          lagBlocks: "2"
        }
      }
    });
    expect(summaryResponse.body).not.toHaveProperty("summary.counts");
  });

  it("returns stable safe action records for recovery hooks", async () => {
    const projectionStore = stores.projectionStore;
    const router = createApiRouter(projectionStore, {
      runtimeEnvironment: "local",
      now: () => new Date(now),
      opsRecoveryActions: {
        async rebuildProjections() {
          return { status: "queued", nextCheckAt: "2026-04-29T00:00:30.000Z" };
        },
        async sweepPendingPostCommitSteps() {
          return {
            status: "completed",
            summary: { swept: 0, delivered: 0, failed: 0, waitingFinality: 0, ghostDropped: 0 }
          };
        },
        async listPendingPostCommitSteps() {
          return [];
        }
      }
    });

    const rebuildHeaders = { ...adminHeaders, "x-request-id": "req-ops-rebuild-1" };
    const firstRebuild = await router.handle({
      method: "POST",
      pathname: "/admin/ops/projections/rebuild",
      headers: rebuildHeaders
    });
    const secondRebuild = await router.handle({
      method: "POST",
      pathname: "/admin/ops/projections/rebuild",
      headers: rebuildHeaders
    });
    const pending = await router.handle({
      method: "GET",
      pathname: "/admin/ops/indexer/pending-steps",
      headers: adminHeaders
    });
    const sweep = await router.handle({
      method: "POST",
      pathname: "/admin/ops/indexer/pending-steps/retry",
      headers: { ...adminHeaders, "x-request-id": "req-ops-sweep-1" }
    });

    expect(firstRebuild.status).toBe(202);
    expect(secondRebuild.status).toBe(202);
    expect(firstRebuild.body).toMatchObject({
      ok: true,
      requestId: "req-ops-rebuild-1",
      action: "projections.rebuild",
      status: "queued",
      sourceOfTruth: "contracts-and-chain-events",
      recoveryBoundary: {
        nonAuthoritative: true,
        businessSignaturesCreated: false,
        chainStateForged: false
      }
    });
    expect((secondRebuild.body as Record<string, unknown>).actionId)
      .toBe((firstRebuild.body as Record<string, unknown>).actionId);
    expect(pending.status).toBe(200);
    expect(pending.body).toEqual({ ok: true, pendingSteps: [] });
    expect(sweep.status).toBe(202);
    expect(sweep.body).toMatchObject({
      requestId: "req-ops-sweep-1",
      action: "indexer.sweep_pending",
      status: "completed",
      summary: { swept: 0, delivered: 0, failed: 0, waitingFinality: 0, ghostDropped: 0 }
    });
    expect(JSON.stringify(firstRebuild.body)).not.toContain("signature");
  });

  it("fails recovery actions closed when preflight fails or dependencies are missing", async () => {
    let called = false;
    const failedDiagnostics = {
      ...buildConfigDiagnostics(testConfig()),
      preflight: {
        strict: true,
        status: "failed" as const,
        checks: [{
          name: "rpc",
          status: "failed" as const,
          message: "RPC token=secret refused"
        }]
      }
    };
    const preflightFailedRouter = createApiRouter(stores.projectionStore, {
      runtimeEnvironment: "local",
      configDiagnostics: failedDiagnostics,
      opsRecoveryActions: {
        async rebuildProjections() {
          called = true;
          return { status: "completed" };
        }
      }
    });
    const missingDependencyRouter = createApiRouter(stores.projectionStore, { runtimeEnvironment: "local" });

    const failedResponse = await preflightFailedRouter.handle({
      method: "POST",
      pathname: "/admin/ops/projections/rebuild",
      headers: { ...adminHeaders, "x-request-id": "req-preflight-failed" }
    });
    const missingResponse = await missingDependencyRouter.handle({
      method: "POST",
      pathname: "/admin/ops/projections/rebuild",
      headers: { ...adminHeaders, "x-request-id": "req-missing-rebuild" }
    });
    const missingPendingResponse = await missingDependencyRouter.handle({
      method: "GET",
      pathname: "/admin/ops/indexer/pending-steps",
      headers: { ...adminHeaders, "x-request-id": "req-missing-pending" }
    });

    expect(failedResponse.status).toBe(503);
    expect(failedResponse.body).toMatchObject({
      ok: false,
      requestId: "req-preflight-failed",
      action: "projections.rebuild",
      status: "rejected",
      error: "preflight_failed"
    });
    expect(called).toBe(false);
    expect(missingResponse.status).toBe(503);
    expect(missingResponse.body).toMatchObject({
      ok: false,
      requestId: "req-missing-rebuild",
      action: "projections.rebuild",
      status: "rejected",
      error: "ops_dependency_unavailable"
    });
    expect(missingPendingResponse.status).toBe(503);
    expect(missingPendingResponse.body).toEqual({ ok: false, error: "ops_dependency_unavailable" });
    expect(JSON.stringify(failedResponse.body)).not.toContain("secret");
  });

  it("returns not ready when the indexer projection is degraded", async () => {
    const projectionStore = stores.projectionStore;
    await projectionStore.saveSyncState({
      chainId: 31337,
      contractAddress: projectionScopeContractAddress,
      syncStatus: "degraded",
      finalizedBlock: 20n,
      confirmationDepth: 2,
      eventCount: 0,
      rebuild: { status: "failed", toBlock: 20n },
      degradedReason: "RPC timeout token=secret"
    });

    const router = createApiRouter(projectionStore, { runtimeEnvironment: "local" });

    const response = await router.handle({ method: "GET", pathname: "/readyz" });

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      ready: false,
      status: "not_ready",
      reasons: ["indexer_degraded"]
    });
    expect((response.body as Record<string, unknown>).diagnostics).toBeUndefined();

    const detailResponse = await router.handle({
      method: "GET",
      pathname: "/admin/diagnostics",
      headers: { "x-uvp-admin-id": "ops-admin-1", "x-uvp-admin-role": "governance_admin" }
    });
    expect(detailResponse.status).toBe(200);
    expect(detailResponse.body).toMatchObject({
      diagnostics: {
        indexer: {
          syncStatus: "degraded",
          degradedReason: expect.stringContaining("[redacted:secret]")
        }
      }
    });
  });

  it("redacts private keys, full signatures, RPC tokens, presigned URLs, and evidence plaintext", () => {
    const redacted = redactSecrets({
      privateKey: "0x1111111111111111111111111111111111111111111111111111111111111111",
      signature: `0x${"aa".repeat(65)}`,
      rpcUrl: "https://rpc.example/base?api_key=rpc-secret&chain=base-sepolia",
      presignedUrl: "https://objects.example/evidence.bin?X-Amz-Signature=aws-secret&X-Amz-Credential=cred",
      textPayload: "doc-1 plaintext must not appear",
      content: "raw evidence body"
    });
    const serialized = JSON.stringify(redacted);

    expect(serialized).not.toContain("1111111111111111111111111111111111111111111111111111111111111111");
    expect(serialized).not.toContain("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(serialized).not.toContain("rpc-secret");
    expect(serialized).not.toContain("aws-secret");
    expect(serialized).not.toContain("doc-1 plaintext");
    expect(serialized).not.toContain("raw evidence body");
    expect(serialized).toContain("[redacted:presigned-url]");
    expect(serialized).toContain("[redacted:evidence]");
  });
});

function testConfig() {
  return loadConfigFromEnv({
    CHAIN_SERVICES_RUNTIME_ENV: "local",
    CHAIN_SERVICES_DATABASE_URL: databaseUrl,
    UVP_PRODUCT_BFF_REGISTRATION_ADAPTER: "memory-trigger",
    UVP_CHAIN_ID: "31337",
    UVP_CONTRACTS_JSON: JSON.stringify({
      UVPStateMachine: stateMachine,
      UVPIdentityRegistry: identityRegistry
    })
  });
}

function serverTestConfig(): ChainServicesConfig {
  return {
    network: {
      chainId: 31337,
      rpcUrl: "http://127.0.0.1:8545",
      deploymentBlock: 0n,
      finalityAnchor: "confirmations",
      finalityConfirmations: 2,
      contracts: {
        UVPStateMachine: "0x1111111111111111111111111111111111111111"
      }
    },
    database: {
      url: databaseUrl,
      migrationsAutoRun: true
    },
    api: {
      host: "127.0.0.1",
      port: 0,
      indexerPollIntervalMs: 0
    },
    operatorRoles: {},
    security: {
      environment: "local",
      preflightStrict: false,
      logRedactionEnabled: true
    }
  };
}
