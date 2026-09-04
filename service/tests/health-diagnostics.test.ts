import type { Server } from "node:http";
import { describe, expect, it } from "vitest";
import { startApiServer } from "../src/api/server.js";
import type { ChainServicesConfig } from "../src/config/index.js";
import type { ChainEventSource } from "../src/indexer/service.js";
import { buildConfigDiagnostics, loadConfigFromEnv } from "../src/config/index.js";
import {
  InMemoryEvidenceStorage,
  type EvidencePrincipal,
  type EvidenceService
} from "../src/evidence/index.js";
import { InMemoryGovernanceStore, type IdentityTxLogDTO } from "../src/governance/index.js";
import { createApiRouter } from "../src/api/routes.js";
import {
  MemoryProjectionStore,
  projectionScopeContractAddress
} from "../src/storage/projection-store.js";
import { redactSecrets } from "../src/security/index.js";
import {
  InMemoryProductSubmissionStore,
  type ProductSubmissionDTO
} from "../src/submissions/index.js";
import type { Address, Hex } from "../src/shared/types.js";

const stateMachine = "0x1111111111111111111111111111111111111111" as Address;
const identityRegistry = "0x2222222222222222222222222222222222222222" as Address;
const orderId = bytes32("1001");
const sourceId = bytes32("2001");
const signalId = bytes32("2002");
const payloadHash = bytes32("3001");
const idempotencyKey = bytes32("3002");
const submitter = "0x3333333333333333333333333333333333333333" as Address;
const txHash = bytes32("aaaa");
const planId = bytes32("4002");
const planHash = bytes32("4003");
const artifactHash = bytes32("4004");
const policyHash = bytes32("4005");
const metadataHash = bytes32("4006");
const now = "2026-04-29T00:00:00.000Z";
const adminHeaders = {
  "x-uvp-admin-id": "ops-admin-1",
  "x-uvp-admin-role": "admin"
};

describe("ops health diagnostics", () => {
  it("exposes safe runtime, indexer, submission, governance, evidence, and preflight summaries", async () => {
    const projectionStore = new MemoryProjectionStore();
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

    const submissionStore = new InMemoryProductSubmissionStore();
    await submissionStore.putSubmission(deadLetterSubmission());
    const governanceStore = new InMemoryGovernanceStore();
    await governanceStore.appendIdentityTxLog(pendingGovernanceLog());

    const router = createApiRouter(projectionStore, { submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111",
      configDiagnostics: buildConfigDiagnostics(testConfig()),
      submissionStore,
      governanceStore,
      evidenceStorage: new InMemoryEvidenceStorage(),
      indexerDiagnostics: { configured: true, pollIntervalMs: 5_000 },
      reconcileDiagnostics: {
        enabled: true,
        running: true,
        checking: false,
        pollIntervalMs: 5_000,
        txTimeoutMs: 60_000,
        lastRunAt: now,
        lastSummary: {
          registrationsChecked: 0,
          submissionsChecked: 1,
          governanceLogsChecked: 1,
          updated: 0,
          failed: 0
        }
      }
    });

    const response = await router.handle({ method: "GET", pathname: "/healthz" });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      sourceOfTruth: "contracts-and-chain-events",
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
        },
        reconcile: {
          enabled: true,
          running: true,
          lastSummary: { submissionsChecked: 1, governanceLogsChecked: 1 }
        },
        submissions: {
          submissionCount: 1,
          submissionsByStatus: { failed: 1 },
          attemptsByStatus: { failed: 1 },
          deadLetterCount: 1,
          deadLetters: [expect.objectContaining({
            submissionId: "sub_dead",
            errorCode: "unauthorized_signal_submitter",
            txHash
          })]
        },
        governanceTxs: {
          txCount: 1,
          byStatus: { pending: 1 },
          pendingOrIndexing: [expect.objectContaining({
            txLogId: "gov_tx_1",
            action: "register_identity",
            txHash
          })]
        },
        evidenceStorage: {
          adapterKind: "memory",
          readiness: "ready"
        }
      }
    });
    expect(JSON.stringify(response.body)).not.toContain("2222222222222222222222222222222222222222222222222222222222222222");
  });

  it("requires admin headers for operator console routes", async () => {
    const router = createApiRouter(new MemoryProjectionStore(), { submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111" });

    for (const request of [
      { method: "GET", pathname: "/admin/ops/status" },
      { method: "GET", pathname: "/admin/ops/summary" },
      { method: "POST", pathname: "/admin/ops/reconcile/run" },
      { method: "POST", pathname: "/admin/ops/projections/rebuild" },
      { method: "POST", pathname: "/admin/ops/submissions/sub_1/retry" }
    ]) {
      const response = await router.handle(request);
      expect(response.status).toBe(403);
      expect(response.body).toEqual({ error: "forbidden" });
    }
  });

  it("enforces the OPS_CONSOLE_ADMIN_IDS allowlist when configured (ETH-03)", async () => {
    const router = createApiRouter(new MemoryProjectionStore(), { submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111",
      opsConsoleAdminIds: ["ops-admin-1", "ops-admin-2"]
    });

    // 白名单内：放行（governance admin 检查之后命中 ops 白名单）。
    const allowed = await router.handle({
      method: "GET",
      pathname: "/admin/ops/status",
      headers: adminHeaders
    });
    expect(allowed.status).toBe(200);

    // governance admin 身份合法但不在 ops 白名单内：403。
    const outsideGovernanceAdmin = await router.handle({
      method: "GET",
      pathname: "/admin/ops/status",
      headers: { "x-uvp-admin-id": "governance-reviewer-9", "x-uvp-admin-role": "governance_admin" }
    });
    expect(outsideGovernanceAdmin.status).toBe(403);
    expect(outsideGovernanceAdmin.body).toMatchObject({
      error: "forbidden",
      reason: "ops_console_admin_allowlist"
    });
  });

  it("falls back to the governance admin check when no ops allowlist is configured (ETH-03)", async () => {
    const router = createApiRouter(new MemoryProjectionStore(), { submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111" });

    const response = await router.handle({
      method: "GET",
      pathname: "/admin/ops/status",
      headers: { "x-uvp-admin-id": "governance-reviewer-9", "x-uvp-admin-role": "governance_admin" }
    });
    expect(response.status).toBe(200);
  });

  it("assembles real admin recovery actions in the running server (ETH-06)", async () => {
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
        store: new MemoryProjectionStore(),
        eventSource
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected TCP server address");
      }
      const base = `http://127.0.0.1:${address.port}`;
      const headers = { "content-type": "application/json", ...adminHeaders, "x-request-id": "req-eth06-1" };

      const reconcile = await fetch(`${base}/admin/ops/reconcile/run`, {
        method: "POST",
        headers
      });
      expect(reconcile.status).toBe(202);
      expect(await reconcile.json()).toMatchObject({
        ok: true,
        action: "reconcile.run",
        status: "completed",
        summary: { registrationsChecked: 0, submissionsChecked: 0, governanceLogsChecked: 0 }
      });

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
    } finally {
      if (server) {
        await new Promise<void>((resolvePromise, reject) => {
          server!.close((error) => (error ? reject(error) : resolvePromise()));
        });
      }
    }
  });

  it("exposes admin operator status and redacted downloadable summary fields", async () => {
    const projectionStore = new MemoryProjectionStore();
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
    const router = createApiRouter(projectionStore, { submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111",
      configDiagnostics: buildConfigDiagnostics(testConfig()),
      evidenceStorage: new InMemoryEvidenceStorage(),
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
      storeMetadata: {
        readiness: "ready",
        stores: {
          draft: { kind: "memory", readiness: "ready" },
          productSchema: { kind: "memory", readiness: "ready", representedBy: "draft" },
          version: { kind: "memory", readiness: "ready" },
          supplier: { kind: "memory", readiness: "ready" },
          supplierAudit: { kind: "memory", readiness: "ready", representedBy: "supplier" },
          docking: { kind: "memory", readiness: "ready" }
        }
      },
      recoveryPolicy: {
        actionsAreNonAuthoritative: true,
        canCreateBusinessSignatures: false,
        canForgeChainState: false
      }
    });
    expect(summaryResponse.status).toBe(200);
    expect(summaryResponse.body).toMatchObject({
      ok: true,
      filename: "uvp-ops-diagnostics-2026-04-29T00-00-00-000Z.json",
      mimeType: "application/json",
      summary: {
        sourceOfTruth: "contracts-and-chain-events",
        counts: {
          retryableSubmissions: 0,
          deadLetterSubmissions: 0
        },
        storeMetadata: {
          readiness: "ready",
          stores: {
            productSchema: { representedBy: "draft", kind: "memory", readiness: "ready" },
            supplierAudit: { representedBy: "supplier", kind: "memory", readiness: "ready" },
            docking: { kind: "memory", readiness: "ready" }
          }
        }
      }
    });
    expect(JSON.stringify(statusResponse.body)).not.toContain("2222222222222222222222222222222222222222222222222222222222222222");
    expect(JSON.stringify(summaryResponse.body)).not.toContain("2222222222222222222222222222222222222222222222222222222222222222");
  });

  it("returns stable safe action records for recovery hooks", async () => {
    const projectionStore = new MemoryProjectionStore();
    const submissionStore = new InMemoryProductSubmissionStore();
    await submissionStore.putSubmission(retryableSubmission());
    const seenRetries: string[] = [];
    const router = createApiRouter(projectionStore, { submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111",
      submissionStore,
      now: () => new Date(now),
      opsRecoveryActions: {
        async runReconcile() {
          return { status: "completed", summary: { submissionsChecked: 1, updated: 0 } };
        },
        async rebuildProjections() {
          return { status: "queued", nextCheckAt: "2026-04-29T00:00:30.000Z" };
        },
        async retrySubmission(input) {
          seenRetries.push(input.submissionId);
          return {
            status: "queued",
            summary: {
              submissionId: input.submissionId,
              retryable: input.submission?.retryable ?? false
            }
          };
        }
      }
    });

    const retryHeaders = { ...adminHeaders, "x-request-id": "req-ops-retry-1" };
    const firstRetry = await router.handle({
      method: "POST",
      pathname: "/admin/ops/submissions/sub_retry/retry",
      headers: retryHeaders
    });
    const secondRetry = await router.handle({
      method: "POST",
      pathname: "/admin/ops/submissions/sub_retry/retry",
      headers: retryHeaders
    });
    const reconcile = await router.handle({
      method: "POST",
      pathname: "/admin/ops/reconcile/run",
      headers: { ...adminHeaders, "x-request-id": "req-ops-reconcile-1" }
    });
    const rebuild = await router.handle({
      method: "POST",
      pathname: "/admin/ops/projections/rebuild",
      headers: { ...adminHeaders, "x-request-id": "req-ops-rebuild-1" }
    });

    expect(firstRetry.status).toBe(202);
    expect(secondRetry.status).toBe(202);
    expect(firstRetry.body).toMatchObject({
      ok: true,
      requestId: "req-ops-retry-1",
      action: "submissions.retry",
      targetId: "sub_retry",
      status: "queued",
      sourceOfTruth: "contracts-and-chain-events",
      recoveryBoundary: {
        nonAuthoritative: true,
        businessSignaturesCreated: false,
        chainStateForged: false
      },
      summary: {
        submissionId: "sub_retry",
        retryable: true
      }
    });
    expect((secondRetry.body as Record<string, unknown>).actionId).toBe((firstRetry.body as Record<string, unknown>).actionId);
    expect(reconcile.body).toMatchObject({
      requestId: "req-ops-reconcile-1",
      action: "reconcile.run",
      status: "completed",
      nextCheckAt: "2026-04-29T00:00:15.000Z"
    });
    expect(rebuild.body).toMatchObject({
      requestId: "req-ops-rebuild-1",
      action: "projections.rebuild",
      status: "queued",
      nextCheckAt: "2026-04-29T00:00:30.000Z"
    });
    expect(seenRetries).toEqual(["sub_retry", "sub_retry"]);
    expect(JSON.stringify(firstRetry.body)).not.toContain("signature");
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
    const preflightFailedRouter = createApiRouter(new MemoryProjectionStore(), { submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111",
      configDiagnostics: failedDiagnostics,
      opsRecoveryActions: {
        async runReconcile() {
          called = true;
          return { status: "completed" };
        }
      }
    });
    const missingDependencyRouter = createApiRouter(new MemoryProjectionStore(), { submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111" });

    const failedResponse = await preflightFailedRouter.handle({
      method: "POST",
      pathname: "/admin/ops/reconcile/run",
      headers: { ...adminHeaders, "x-request-id": "req-preflight-failed" }
    });
    const missingResponse = await missingDependencyRouter.handle({
      method: "POST",
      pathname: "/admin/ops/projections/rebuild",
      headers: { ...adminHeaders, "x-request-id": "req-missing-rebuild" }
    });

    expect(failedResponse.status).toBe(503);
    expect(failedResponse.body).toMatchObject({
      ok: false,
      requestId: "req-preflight-failed",
      action: "reconcile.run",
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
    expect(JSON.stringify(failedResponse.body)).not.toContain("secret");
  });

  it("returns not ready when critical diagnostics are degraded", async () => {
    const projectionStore = new MemoryProjectionStore();
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

    const router = createApiRouter(projectionStore, { submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111",
      evidenceService: noopEvidenceService(),
      evidenceStorage: new InMemoryEvidenceStorage(),
      evidenceRuntimeEnvironment: "production",
      reconcileDiagnostics: {
        enabled: true,
        running: true,
        checking: false,
        pollIntervalMs: 5_000,
        txTimeoutMs: 60_000,
        lastError: "rpc rejected private key 0x1111111111111111111111111111111111111111111111111111111111111111"
      }
    });

    const response = await router.handle({ method: "GET", pathname: "/readyz" });

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      ready: false,
      status: "not_ready",
      reasons: expect.arrayContaining(["indexer_degraded", "reconcile_error", "evidence_storage_degraded"]),
      diagnostics: {
        indexer: {
          syncStatus: "degraded",
          degradedReason: expect.stringContaining("[redacted:secret]")
        },
        evidenceStorage: { readiness: "degraded" },
        reconcile: { lastError: expect.stringContaining("[redacted:secret]") }
      }
    });
  });

  it("redacts private keys, full signatures, RPC tokens, presigned URLs, and evidence plaintext", () => {
    const redacted = redactSecrets({
      privateKey: "0x1111111111111111111111111111111111111111111111111111111111111111",
      signature: `0x${"aa".repeat(65)}`,
      rpcUrl: "https://rpc.example/base?api_key=rpc-secret&chain=base-sepolia",
      presignedUrl: "https://objects.example/evidence.bin?X-Amz-Signature=aws-secret&X-Amz-Credential=cred",
      textPayload: "invoice plaintext must not appear",
      content: "raw evidence body"
    });
    const serialized = JSON.stringify(redacted);

    expect(serialized).not.toContain("1111111111111111111111111111111111111111111111111111111111111111");
    expect(serialized).not.toContain("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(serialized).not.toContain("rpc-secret");
    expect(serialized).not.toContain("aws-secret");
    expect(serialized).not.toContain("invoice plaintext");
    expect(serialized).not.toContain("raw evidence body");
    expect(serialized).toContain("[redacted:presigned-url]");
    expect(serialized).toContain("[redacted:evidence]");
  });

});

function testConfig() {
  return loadConfigFromEnv({
    CHAIN_SERVICES_DATABASE_DRIVER: "memory",
    CHAIN_SERVICES_DATABASE_URL: "memory://projection-store",
    UVP_PRODUCT_BFF_REGISTRATION_ADAPTER: "memory-trigger",
    UVP_CHAIN_ID: "31337",
    UVP_CONTRACTS_JSON: JSON.stringify({
      UVPStateMachine: stateMachine,
      UVPIdentityRegistry: identityRegistry
    }),
    UVP_STATE_MACHINE_RELAYER_PRIVATE_KEY: "0x2222222222222222222222222222222222222222222222222222222222222222"
  });
}

function deadLetterSubmission(): ProductSubmissionDTO {
  return {
    submissionId: "sub_dead",
    prepareId: "prep_dead",
    taskId: "task_dead",
    orderId: "order-dead",
    onchainOrderId: orderId,
    planId,
    stageIdentifier: "customs",
    signalName: "confirm_stage",
    sourceId,
    signalId,
    intent: "confirm_stage",
    payloadHash,
    payloadRef: "uvp-evidence://product/ev_dead",
    idempotencyKey,
    submitter,
    nonce: "1",
    deadline: "1770000000",
    status: "failed",
    signatureStatus: "signature_verified",
    signatureHash: bytes32("5001"),
    recoveredSubmitter: submitter,
    broadcastStatus: "failed",
    txHash,
    errorCode: "unauthorized_signal_submitter",
    errorMessage: "submitter is not authorized",
    retryable: false,
    retryState: "dead_letter",
    deadLetter: true,
    attempts: [{
      attemptId: "attempt_dead_1",
      submissionId: "sub_dead",
      orderId,
      sourceId,
      signalId,
      submitter,
      txHash,
      status: "failed",
      errorCode: "unauthorized_signal_submitter",
      errorMessage: "submitter is not authorized",
      attemptNumber: 1,
      retryable: false,
      retryState: "dead_letter",
      deadLetter: true,
      createdAt: now,
      updatedAt: now
    }],
    attemptCount: 1,
    proofRows: [],
    createdAt: now,
    updatedAt: now
  };
}

function retryableSubmission(): ProductSubmissionDTO {
  const submission = deadLetterSubmission();
  return {
    ...submission,
    submissionId: "sub_retry",
    prepareId: "prep_retry",
    status: "failed",
    broadcastStatus: "failed",
    retryable: true,
    retryState: "retryable",
    deadLetter: false,
    errorCode: "tx_reconcile_timeout",
    errorMessage: "transaction did not produce a receipt before timeout",
    attempts: [{
      ...submission.attempts[0]!,
      attemptId: "attempt_retry_1",
      submissionId: "sub_retry",
      errorCode: "tx_reconcile_timeout",
      errorMessage: "transaction did not produce a receipt before timeout",
      retryable: true,
      retryState: "retryable",
      deadLetter: false
    }],
    proofRows: [],
    updatedAt: now
  };
}

function pendingGovernanceLog(): IdentityTxLogDTO {
  return {
    logId: "gov_log_1",
    txLogId: "gov_tx_1",
    action: "register_identity",
    subjectId: planId,
    account: submitter,
    descriptorHash: metadataHash,
    descriptorURI: "uvp-store://identities/acme",
    txHash,
    signer: submitter,
    requester: "admin-1",
    status: "pending",
    broadcastStatus: "submitted",
    retryable: false,
    request: {
      kind: "registerIdentity",
      subjectId: planId,
      account: submitter,
      descriptorHash: metadataHash,
      descriptorURI: "uvp-store://identities/acme"
    },
    createdAt: now,
    updatedAt: now
  };
}

function noopEvidenceService(): EvidenceService {
  return {
    async uploadEvidence() {
      throw new Error("not used");
    },
    async getEvidence(_evidenceId: string, _principal: EvidencePrincipal) {
      return undefined;
    },
    async getProof(_evidenceId: string, _principal: EvidencePrincipal) {
      return undefined;
    },
    async bindEvidence() {
      return undefined;
    }
  };
}

function bytes32(value: string): Hex {
  return `0x${value.padStart(64, "0")}` as Hex;
}

function serverTestConfig(): ChainServicesConfig {
  return {
    network: {
      chainId: 31337,
      rpcUrl: "http://127.0.0.1:8545",
      deploymentBlock: 0n,
      finalityConfirmations: 2,
      contracts: {
        UVPStateMachine: "0x1111111111111111111111111111111111111111"
      }
    },
    database: {
      driver: "memory",
      url: "memory://projection-store",
      migrationsAutoRun: false
    },
    api: {
      host: "127.0.0.1",
      port: 0,
      indexerPollIntervalMs: 0
    },
    relayer: {
      businessSigning: "forbidden",
      broadcastEnabled: false,
      stateMachinePrivateKeyEnv: "UVP_STATE_MACHINE_RELAYER_PRIVATE_KEY",
      maxRetries: 0
    },
    governance: {
      broadcastEnabled: false,
      rpcUrl: "http://127.0.0.1:8545",
      chainId: 31337,
      txConfirmations: 1,
      allowedOperators: []
    },
    productBff: {
      registrationAdapter: "memory-trigger",
      registrarPrivateKeyEnv: "UVP_PRODUCT_BFF_REGISTRAR_PRIVATE_KEY",
      waitForReceipt: false
    },
    operatorRoles: {
      deployerPrivateKeyEnv: "UVP_ETH_DEPLOYER_PRIVATE_KEY",
      participantWallets: [],
      adminReviewers: []
    },
    reconcile: {
      enabled: false,
      pollIntervalMs: 0,
      txTimeoutMs: 60_000
    },
    dockAutomation: {
      enabled: false,
      pollIntervalMs: 5_000,
      maxCandidatesPerRun: 4,
      maxGasPerTx: 500_000n,
      waitForReceipt: true
    },
    evidenceStorage: {
      adapter: "local",
      objectNamespace: "uvp-rehearsal"
    },
    notifications: {
      webhookSecretConfigured: false
    },
    security: {
      environment: "local",
      preflightStrict: false,
      logRedactionEnabled: true,
      broadcastMaxInFlightPerOrder: 1,
      broadcastMaxRetry: 0,
      broadcastRetryBaseMs: 250,
      broadcastRetryMaxMs: 5_000,
      broadcastReceiptTimeoutMs: 0
    }
  };
}
