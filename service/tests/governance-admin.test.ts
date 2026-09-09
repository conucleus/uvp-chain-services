import { describe, expect, it, vi } from "vitest";
import { createApiRouter } from "../src/api/routes.js";
import { ObjectEvidenceStorage } from "../src/evidence/index.js";
import {
  createGovernanceBroadcasterAdapter,
  createGovernanceService,
  type GovernanceChainAdapter,
  type GovernanceChainRequestDTO,
  type GovernancePublicClient,
  type GovernanceWalletClient,
} from "../src/governance/index.js";
import type { Address, Hex } from "../src/shared/types.js";
import { MemoryProjectionStore } from "../src/storage/projection-store.js";

const adminHeaders = {
  "x-uvp-admin-id": "admin-1",
  "x-uvp-admin-role": "admin",
};
/** 管理面口令因子：sha256("test-admin-password")。 */
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
    const router = createApiRouter(new MemoryProjectionStore(), { productRuntimeEnvironment: "local", submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111" });
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
      productRuntimeEnvironment: "staging" as const,
      submissionChainId: 84532,
      submissionVerifyingContract: "0x1111111111111111111111111111111111111111" as Address,
      governanceAdminIds: ["admin-1"],
      opsConsoleAdminIds: ["admin-1"],
      governanceAdminTokenHashes: [adminTokenHash],
      // staging/production 边界要求 production-safe 对象存储适配器。
      evidenceStorage: new ObjectEvidenceStorage({ client: memoryObjectClient() }),
    };
    const router = createApiRouter(new MemoryProjectionStore(), routerOptions);

    // staging：白名单命中的明文自报头不再是完整凭据 → 403。
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

    // 口令因子命中（x-uvp-admin-token 哈希比对）→ 放行。
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

    // 口令错误 → 403。
    await expect(router.handle({
      method: "GET",
      pathname: "/admin/governance/reviews",
      headers: { ...adminHeaders, "x-uvp-admin-token": "wrong-password" },
    })).resolves.toMatchObject({ status: 403 });

    // production 同口径拒绝明文自报头。
    const productionRouter = createApiRouter(new MemoryProjectionStore(), {
      ...routerOptions,
      productRuntimeEnvironment: "production" as const,
    });
    await expect(productionRouter.handle({
      method: "GET",
      pathname: "/admin/governance/reviews",
      headers: adminHeaders,
    })).resolves.toMatchObject({ status: 403 });

    // local 档保持明文白名单自报头（dev 便利）。
    const localRouter = createApiRouter(new MemoryProjectionStore(), {
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
    const router = createApiRouter(new MemoryProjectionStore(), { productRuntimeEnvironment: "local", submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111",
      governanceService: createGovernanceService({ adapter }),
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
    const router = createApiRouter(new MemoryProjectionStore(), { productRuntimeEnvironment: "local", submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111",
      governanceService: createGovernanceService({ adapter }),
    });

    // No review exists for the subject: the request must be refused. The
    // removed fallback would have hashed the request body itself into an
    // "approved_for_broadcast" review hash and broadcast that on chain.
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

    // A non-approved review keeps the existing guard as well.
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
});

/** 非 local 边界可接受的内存对象存储客户端（production-safe 适配器用）。 */
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
