import { describe, expect, it, vi } from "vitest";
import { createApiRouter } from "../src/api/routes.js";
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
const subjectId = "0x0000000000000000000000000000000000000000000000000000000000003001" as Hex;
const bindingId = "0x0000000000000000000000000000000000000000000000000000000000004001" as Hex;
const wallet = "0x4444444444444444444444444444444444444444" as Address;
const registryAddress = "0x5555555555555555555555555555555555555555" as Address;
const signerPrivateKey = "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex;
const signer = "0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a" as Address;
const txHash = "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" as Hex;

describe("identity governance API", () => {
  it("keeps admin review off-chain and requires an authenticated admin", async () => {
    const router = createApiRouter(new MemoryProjectionStore());
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
    const router = createApiRouter(new MemoryProjectionStore(), {
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
