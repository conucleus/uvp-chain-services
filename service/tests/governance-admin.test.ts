import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApiRouter } from "../src/api/routes.js";
import { ObjectEvidenceStorage } from "../src/evidence/index.js";
import {
  createGovernanceBroadcasterAdapter,
  createGovernanceService,
  InMemoryGovernanceStore,
  type GovernanceChainAdapter,
  type GovernanceChainRequestDTO,
  type GovernancePublicClient,
  type GovernanceWalletClient,
} from "../src/governance/index.js";
import type { Address, Hex } from "../src/shared/types.js";
import { createChainServicesStores, type ChainServicesStores } from "../src/storage/factory.js";
import { createPostgresTestDatabase } from "./postgres.js";

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

const adminHeaders = {
  "x-uvp-admin-id": "admin-1",
  "x-uvp-admin-role": "admin",
};
const adminTokenHash = "f7a03f48c0e2aa2d5e55ca186c20032ddbf53b7f5f93fce387d65c3f83433e8d";
const subjectId = "0x0000000000000000000000000000000000000000000000000000000000003001" as Hex;
const bindingId = "0x0000000000000000000000000000000000000000000000000000000000004001" as Hex;
const wallet = "0x4444444444444444444444444444444444444444" as Address;
const registryAddress = "0x5555555555555555555555555555555555555555" as Address;
const signerPrivateKey = "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex;
const signer = "0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a" as Address;
const txHash = "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" as Hex;

describe("identity governance API", () => {
  it("keeps admin review off-chain and requires an authenticated admin", async () => {
    const router = createApiRouter(stores.projectionStore, { ...requiredRouterStores(), productRuntimeEnvironment: "local", submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111" });
    await expect(router.handle({
      method: "POST",
      pathname: "/admin/governance/review-supplier",
      body: { subjectId, status: "submitted" },
    })).resolves.toMatchObject({ status: 403 });

    await expect(router.handle({
      method: "POST",
      pathname: "/admin/governance/review-supplier",
      headers: adminHeaders,
      body: { subjectId, status: "approved_for_broadcast", publicSummary: "Identity checked." },
    })).resolves.toMatchObject({
      status: 200,
      body: { review: { subjectType: "supplier", status: "approved_for_broadcast" } },
    });
  });

  it("requires a password factor for the admin surface outside local", async () => {
    const routerOptions = {
      ...requiredRouterStores(),
      productRuntimeEnvironment: "staging" as const,
      submissionChainId: 84532,
      submissionVerifyingContract: "0x1111111111111111111111111111111111111111" as Address,
      governanceAdminIds: ["admin-1"],
      opsConsoleAdminIds: ["admin-1"],
      governanceAdminTokenHashes: [adminTokenHash],
      evidenceStorage: new ObjectEvidenceStorage({ client: memoryObjectClient() }),
    };
    const router = createApiRouter(stores.projectionStore, routerOptions);

    await expect(router.handle({
      method: "GET",
      pathname: "/admin/governance/reviews",
      headers: adminHeaders,
    })).resolves.toMatchObject({ status: 403 });

    await expect(router.handle({
      method: "GET",
      pathname: "/admin/ops/status",
      headers: adminHeaders,
    })).resolves.toMatchObject({ status: 403 });

    await expect(router.handle({
      method: "GET",
      pathname: "/admin/governance/reviews",
      headers: { ...adminHeaders, "x-uvp-admin-token": "test-admin-password" },
    })).resolves.toMatchObject({ status: 200 });

    await expect(router.handle({
      method: "GET",
      pathname: "/admin/ops/status",
      headers: { ...adminHeaders, "x-uvp-admin-token": "test-admin-password" },
    })).resolves.toMatchObject({ status: 200, body: { ok: true } });

    await expect(router.handle({
      method: "GET",
      pathname: "/admin/governance/reviews",
      headers: { ...adminHeaders, "x-uvp-admin-token": "wrong-password" },
    })).resolves.toMatchObject({ status: 403 });

    const productionRouter = createApiRouter(stores.projectionStore, { ...requiredRouterStores(),
      ...routerOptions,
      productRuntimeEnvironment: "production" as const,
    });
    await expect(productionRouter.handle({
      method: "GET",
      pathname: "/admin/governance/reviews",
      headers: adminHeaders,
    })).resolves.toMatchObject({ status: 403 });

    const localRouter = createApiRouter(stores.projectionStore, { ...requiredRouterStores(),
      ...routerOptions,
      productRuntimeEnvironment: "local" as const,
    });
    await expect(localRouter.handle({
      method: "GET",
      pathname: "/admin/governance/reviews",
      headers: adminHeaders,
    })).resolves.toMatchObject({ status: 200 });
  });

  it("registers and revokes a concrete identity binding without capability or reputation fields", async () => {
    const requests: GovernanceChainRequestDTO[] = [];
    const adapter: GovernanceChainAdapter = {
      async registerIdentity(request) {
        requests.push(request);
        return { status: "submitted", txHash, signer, retryable: false, simulated: false };
      },
      async revokeIdentity(request) {
        requests.push(request);
        return { status: "submitted", txHash, signer, retryable: false, simulated: false };
      },
    };
    const router = createApiRouter(stores.projectionStore, { ...requiredRouterStores(), productRuntimeEnvironment: "local", submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111",
      governanceService: createGovernanceService({
    store: new InMemoryGovernanceStore(), adapter }),
    });
    await router.handle({
      method: "POST",
      pathname: "/admin/governance/review-supplier",
      headers: adminHeaders,
      body: { subjectId, status: "approved_for_broadcast", metadataURI: "uvp-store://identity/acme" },
    });

    const registered = await router.handle({
      method: "POST",
      pathname: "/admin/governance/register-identity",
      headers: adminHeaders,
      body: { subjectId, account: wallet },
    });
    expect(registered).toMatchObject({
      status: 202,
      body: {
        request: { kind: "registerIdentity", subjectId, account: wallet, descriptorURI: "uvp-store://identity/acme" },
        log: { action: "register_identity" },
      },
    });
    expect((registered.body as { request: Record<string, unknown> }).request).not.toHaveProperty("capabilityHash");
    expect((registered.body as { request: Record<string, unknown> }).request).not.toHaveProperty("reputationHash");

    const revoked = await router.handle({
      method: "POST",
      pathname: "/admin/governance/revoke-identity",
      headers: adminHeaders,
      body: { bindingId, subjectId, reason: "Identity document expired." },
    });
    expect(revoked).toMatchObject({
      status: 202,
      body: { request: { kind: "revokeIdentity", bindingId }, log: { action: "revoke_identity" } },
    });
    expect(requests.map((request) => request.kind)).toEqual(["registerIdentity", "revokeIdentity"]);
  });

  it("refuses identity registration without any review record instead of faking an approved hash", async () => {
    const requests: GovernanceChainRequestDTO[] = [];
    const adapter: GovernanceChainAdapter = {
      async registerIdentity(request) {
        requests.push(request);
        return { status: "submitted", txHash, signer, retryable: false, simulated: false };
      },
      async revokeIdentity(request) {
        requests.push(request);
        return { status: "submitted", txHash, signer, retryable: false, simulated: false };
      },
    };
    const router = createApiRouter(stores.projectionStore, { ...requiredRouterStores(), productRuntimeEnvironment: "local", submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111",
      governanceService: createGovernanceService({
    store: new InMemoryGovernanceStore(), adapter }),
    });

    const unreviewed = await router.handle({
      method: "POST",
      pathname: "/admin/governance/register-identity",
      headers: adminHeaders,
      body: { subjectId, account: wallet, status: "approved_for_broadcast", publicSummary: "self approved" },
    });
    expect(unreviewed).toMatchObject({
      status: 409,
      body: { error: "review_not_approved" },
    });
    expect(requests).toEqual([]);

    await router.handle({
      method: "POST",
      pathname: "/admin/governance/review-supplier",
      headers: adminHeaders,
      body: { subjectId, status: "draft" },
    });
    const draftOnly = await router.handle({
      method: "POST",
      pathname: "/admin/governance/register-identity",
      headers: adminHeaders,
      body: { subjectId, account: wallet },
    });
    expect(draftOnly).toMatchObject({
      status: 409,
      body: { error: "review_not_approved" },
    });
    expect(requests).toEqual([]);
  });

  it("broadcasts only UVPIdentityRegistry methods after owner preflight", async () => {
    const writeContract = vi.fn(async () => txHash);
    const publicClient: GovernancePublicClient = {
      async getChainId() { return 31337; },
      async readContract() { return signer; },
      async waitForTransactionReceipt() { return { status: "success", blockNumber: 99n }; },
    };
    const walletClient = { writeContract } as GovernanceWalletClient;
    const adapter = createGovernanceBroadcasterAdapter({
      rpcUrl: "http://127.0.0.1:8545",
      chainId: 31337,
      contractAddress: registryAddress,
      privateKey: signerPrivateKey,
      txConfirmations: 1,
      publicClient,
      walletClient,
    });
    const request = {
      kind: "registerIdentity" as const,
      subjectId,
      account: wallet,
      descriptorHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex,
      descriptorURI: "uvp-store://identity/acme",
    };
    await expect(adapter.registerIdentity?.(request)).resolves.toMatchObject({
      status: "confirmed",
      txHash,
      blockNumber: "99",
      signer,
    });
    expect(writeContract).toHaveBeenCalledWith(expect.objectContaining({
      functionName: "registerIdentityBinding",
      args: [subjectId, wallet, request.descriptorHash, request.descriptorURI],
    }));
  });

  it("keeps the broadcast txHash when waiting for the receipt fails", async () => {
    const publicClient: GovernancePublicClient = {
      async getChainId() { return 31337; },
      async readContract() { return signer; },
      async waitForTransactionReceipt() {
        throw new Error("receipt timeout");
      },
    };
    const walletClient = { writeContract: vi.fn(async () => txHash) } as GovernanceWalletClient;
    const adapter = createGovernanceBroadcasterAdapter({
      rpcUrl: "http://127.0.0.1:8545",
      chainId: 31337,
      contractAddress: registryAddress,
      privateKey: signerPrivateKey,
      txConfirmations: 1,
      publicClient,
      walletClient,
    });
    const request = {
      kind: "registerIdentity" as const,
      subjectId,
      account: wallet,
      descriptorHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex,
      descriptorURI: "uvp-store://identity/acme",
    };
    await expect(adapter.registerIdentity?.(request)).resolves.toMatchObject({
      status: "failed",
      txHash,
      signer,
      retryable: true,
    });
  });

  it("classifies viem's unknown-RPC transport envelope as retryable instead of a permanent failure", async () => {
    const publicClient: GovernancePublicClient = {
      async getChainId() { return 31337; },
      async readContract() { return signer; },
      async waitForTransactionReceipt() {
        const error = new Error("An unknown RPC error occurred.");
        error.name = "UnknownRpcError";
        throw error;
      },
    };
    const walletClient = { writeContract: vi.fn(async () => txHash) } as GovernanceWalletClient;
    const adapter = createGovernanceBroadcasterAdapter({
      rpcUrl: "http://127.0.0.1:8545",
      chainId: 31337,
      contractAddress: registryAddress,
      privateKey: signerPrivateKey,
      txConfirmations: 1,
      publicClient,
      walletClient,
    });
    const request = {
      kind: "registerIdentity" as const,
      subjectId,
      account: wallet,
      descriptorHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex,
      descriptorURI: "uvp-store://identity/acme",
    };
    await expect(adapter.registerIdentity?.(request)).resolves.toMatchObject({
      status: "failed",
      txHash,
      retryable: true,
    });
  });

  it("still treats deterministic contract reverts as permanent", async () => {
    const publicClient: GovernancePublicClient = {
      async getChainId() { return 31337; },
      async readContract() { return signer; },
      async waitForTransactionReceipt() {
        throw new Error("The contract function reverted with reason: NotOwner");
      },
    };
    const walletClient = { writeContract: vi.fn(async () => txHash) } as GovernanceWalletClient;
    const adapter = createGovernanceBroadcasterAdapter({
      rpcUrl: "http://127.0.0.1:8545",
      chainId: 31337,
      contractAddress: registryAddress,
      privateKey: signerPrivateKey,
      txConfirmations: 1,
      publicClient,
      walletClient,
    });
    const request = {
      kind: "revokeIdentity" as const,
      bindingId,
      subjectId,
      reasonHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Hex,
      reasonURI: "uvp-governance://metadata/test",
    };
    await expect(adapter.revokeIdentity?.(request)).resolves.toMatchObject({
      status: "failed",
      retryable: false,
    });
  });

  it("re-broadcasts after a permanent failure instead of reusing the failed ledger entry as a final answer", async () => {
    const broadcasts: string[] = [];
    const adapter: GovernanceChainAdapter = {
      async registerIdentity() {
        broadcasts.push("register");
        if (broadcasts.length === 1) {
          return {
            status: "failed",
            errorCode: "transaction_reverted",
            message: "governance transaction reverted",
            retryable: false,
            simulated: false,
          };
        }
        return { status: "submitted", txHash, signer, retryable: false, simulated: false };
      },
      async revokeIdentity() {
        broadcasts.push("revoke");
        return { status: "submitted", txHash, signer, retryable: false, simulated: false };
      },
    };
    const service = createGovernanceService({
      adapter,
      store: new InMemoryGovernanceStore(),
      now: () => new Date("2026-04-28T00:00:00Z"),
    });
    const principal = { adminId: "admin-1", role: "admin" };
    await service.reviewSupplier(
      { subjectId, status: "approved_for_broadcast", publicSummary: "Identity checked." },
      principal,
    );
    const body = { subjectId, account: wallet };

    const first = await service.registerIdentity(body, principal);
    expect(first.broadcast).toMatchObject({ status: "failed", retryable: false });

    const second = await service.registerIdentity(body, principal);
    expect(second.broadcast).toMatchObject({ status: "submitted", txHash });
    expect(broadcasts).toEqual(["register", "register"]);

    const third = await service.registerIdentity(body, principal);
    expect(third.broadcast).toMatchObject({ status: "submitted", txHash });
    expect(third.log.logId).toBe(second.log.logId);
    expect(broadcasts).toEqual(["register", "register"]);
  });

  it("records a persist_failed fallback log with the txHash when the tx log write fails after a real broadcast", async () => {
    const adapter: GovernanceChainAdapter = {
      async registerIdentity() {
        return { status: "submitted", txHash, signer, retryable: false, simulated: false };
      },
      async revokeIdentity() {
        return { status: "submitted", txHash, signer, retryable: false, simulated: false };
      },
    };
    let appendCalls = 0;
    const base = new InMemoryGovernanceStore();
    const flaky: InMemoryGovernanceStore = Object.create(base);
    flaky.appendIdentityTxLog = async (log: Parameters<InMemoryGovernanceStore["appendIdentityTxLog"]>[0]) => {
      appendCalls += 1;
      if (appendCalls === 1) {
        throw new Error("governance store unavailable");
      }
      return base.appendIdentityTxLog(log);
    };
    const service = createGovernanceService({
      adapter,
      store: flaky,
      now: () => new Date("2026-04-28T00:00:00Z"),
    });
    const principal = { adminId: "admin-1", role: "admin" };
    await service.reviewSupplier(
      { subjectId, status: "approved_for_broadcast", publicSummary: "Identity checked." },
      principal,
    );

    await expect(
      service.registerIdentity({ subjectId, account: wallet }, principal),
    ).rejects.toThrow("governance store unavailable");

    const logs = await flaky.listIdentityTxLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      action: "register_identity",
      status: "failed",
      txHash,
      errorCode: "persist_failed",
    });
  });

  it("rejects a review transition validated against a stale snapshot", async () => {
    const base = new InMemoryGovernanceStore();
    const principal = { adminId: "admin-1", role: "admin" };
    const service = createGovernanceService({
      adapter: {
        async registerIdentity() {
          return { status: "simulated_tx", retryable: false, simulated: true };
        },
        async revokeIdentity() {
          return { status: "simulated_tx", retryable: false, simulated: true };
        },
      },
      store: base,
    });
    const created = await service.reviewSupplier(
      { subjectId, status: "approved_for_broadcast", publicSummary: "Identity checked." },
      principal,
    );
    const reviewId = created.review.reviewId;
    await service.reviewSupplier(
      { reviewId, subjectId, status: "revoked", publicSummary: "Revoked concurrently." },
      principal,
    );

    let staleReadPending = false;
    const doctored: InMemoryGovernanceStore = Object.create(base);
    doctored.getReview = async (reviewId: string) => {
      const latest = await base.getReview(reviewId);
      if (staleReadPending && latest) {
        staleReadPending = false;
        return { ...latest, status: "approved_for_broadcast" as const };
      }
      return latest;
    };
    const racing = createGovernanceService({
      store: doctored,
      adapter: {
        async registerIdentity() {
          return { status: "simulated_tx", retryable: false, simulated: true };
        },
        async revokeIdentity() {
          return { status: "simulated_tx", retryable: false, simulated: true };
        },
      },
    });

    staleReadPending = true;
    await expect(
      racing.reviewSupplier({ reviewId, subjectId, status: "restricted" }, principal),
    ).rejects.toMatchObject({
      status: 409,
      code: "invalid_review_transition",
    });
    await expect(base.findLatestReview("supplier", subjectId)).resolves.toMatchObject({
      status: "revoked",
    });
  });

  it("assembles a fail-closed refusing governance adapter for production when broadcast is disabled", async () => {
    const { createConfiguredGovernanceChainAdapter } = await import("../src/governance/adapter.js");
    const productionConfig = {
      security: { environment: "production" },
      governance: { broadcastEnabled: false, signerPrivateKeyEnv: "GOVERNANCE_SIGNER_PRIVATE_KEY" },
      network: { contracts: { UVPIdentityRegistry: registryAddress } },
    };
    const adapter = createConfiguredGovernanceChainAdapter(
      productionConfig as unknown as Parameters<typeof createConfiguredGovernanceChainAdapter>[0],
    );
    await expect(adapter.registerIdentity({
      kind: "registerIdentity",
      subjectId,
      account: wallet,
      descriptorHash: txHash,
      descriptorURI: "uvp-governance://metadata/x",
    })).resolves.toMatchObject({
      status: "failed",
      errorCode: "governance_broadcast_disabled",
      retryable: true,
    });
  });
});

function memoryObjectClient() {
  const objects = new Map<string, Uint8Array>();
  return {
    async put(input: { readonly evidenceId: string; readonly bytes: Uint8Array }) {
      const storageURI = `object://governance-admin/${encodeURIComponent(input.evidenceId)}`;
      objects.set(storageURI, input.bytes);
      return { storageURI, size: input.bytes.byteLength };
    },
    async get(storageURI: string) {
      return objects.get(storageURI);
    },
    async exists(storageURI: string) {
      return objects.has(storageURI);
    },
    storageURIForEvidenceId: (evidenceId: string) => `object://governance-admin/${encodeURIComponent(evidenceId)}`,
    evidenceIdForStorageURI: (storageURI: string) => {
      if (!storageURI.startsWith("object://governance-admin/")) {
        throw new Error("storageURI is not managed by memoryObjectClient");
      }
      return decodeURIComponent(storageURI.slice("object://governance-admin/".length));
    }
  };
}
