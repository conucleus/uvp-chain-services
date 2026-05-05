import { describe, expect, it } from "vitest";
import { createApiRouter } from "../src/api/routes.js";
import { rebuildTrustProjections } from "../src/indexer/trust-projections.js";
import { MemoryProjectionStore } from "../src/storage/projection-store.js";
import type { ChainEvent } from "../src/indexer/events.js";

const contractAddress = "0x1111111111111111111111111111111111111111";
const newOwner = "0x3333333333333333333333333333333333333333";
const attester = "0x2222222222222222222222222222222222222222";
const supplierWallet = "0x4444444444444444444444444444444444444444";
const planId = "0x0000000000000000000000000000000000000000000000000000000000002001";
const planHash = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const artifactHash = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const policyHash = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const metadataHash = "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const reasonHash = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const supplierSubjectId = "0x0000000000000000000000000000000000000000000000000000000000003001";
const profileHash = "0x9999999999999999999999999999999999999999999999999999999999999999";
const capabilityHash = "0x8888888888888888888888888888888888888888888888888888888888888888";
const reputationHash = "0x7777777777777777777777777777777777777777777777777777777777777777";

describe("trust registry projection replay", () => {
  it("rebuilds registry-scoped plan and supplier trust from registry events", () => {
    const events: readonly ChainEvent[] = [
      chainEvent(2n, 0, "PlanAttested", {
        planId,
        planHash,
        artifactHash,
        policyHash,
        metadataHash,
        metadataURI: "https://store/plans/1",
        attester
      }),
      chainEvent(3n, 0, "SupplierAttested", {
        supplierSubjectId,
        wallet: supplierWallet,
        profileHash,
        capabilityHash,
        reputationHash,
        metadataURI: "https://store/suppliers/1",
        attester
      }),
      chainEvent(5n, 0, "PlanRevoked", {
        planId,
        reasonHash,
        reasonURI: "https://store/revocations/1",
        revoker: newOwner
      }),
      chainEvent(6n, 0, "SupplierRevoked", {
        supplierSubjectId,
        reasonHash,
        reasonURI: "https://store/supplier-revocations/1",
        revoker: newOwner
      })
    ];

    const snapshot = rebuildTrustProjections(events);
    const plan = snapshot.plans[`31337:${contractAddress}:${planId}`];
    const supplier = snapshot.suppliers[`31337:${contractAddress}:${supplierSubjectId}`];

    expect(snapshot.eventCount).toBe(4);
    expect(plan?.status).toBe("revoked");
    expect(plan?.registryAddress).toBe(contractAddress);
    expect(plan?.planHash).toBe(planHash);
    expect(plan?.artifactHash).toBe(artifactHash);
    expect(plan?.revoked).toBe(true);
    expect(plan?.revokeReasonHash).toBe(reasonHash);
    expect(supplier?.status).toBe("revoked");
    expect(supplier?.wallet).toBe(supplierWallet.toLowerCase());
    expect(supplier?.capabilityHash).toBe(capabilityHash);
    expect(supplier?.revokeReasonHash).toBe(reasonHash);
  });

  it("exposes trust queries through the projection store and API router", async () => {
    const events: readonly ChainEvent[] = [
      chainEvent(2n, 0, "PlanAttested", {
        planId,
        planHash,
        artifactHash,
        policyHash,
        metadataHash,
        metadataURI: "https://store/plans/1",
        attester
      }),
      chainEvent(3n, 0, "SupplierAttested", {
        supplierSubjectId,
        wallet: supplierWallet,
        profileHash,
        capabilityHash,
        reputationHash,
        metadataURI: "https://store/suppliers/1",
        attester
      })
    ];
    const store = new MemoryProjectionStore();
    await store.resetFromEvents({ deploymentBlock: 0n, events });

    expect(await store.listPlanTrust({ registryAddress: contractAddress, planHash })).toHaveLength(1);
    expect(await store.listSupplierTrust({ wallet: supplierWallet })).toHaveLength(1);

    const router = createApiRouter(store);
    const planResponse = await router.handle({
      method: "GET",
      pathname: "/trust/plans",
      query: { registryAddress: contractAddress, planHash }
    });
    const supplierResponse = await router.handle({
      method: "GET",
      pathname: "/trust/suppliers",
      query: { registryAddress: contractAddress, wallet: supplierWallet }
    });

    expect(planResponse.status).toBe(200);
    expect((planResponse.body as { plans: Array<{ status: string }> }).plans).toEqual([
      expect.objectContaining({ status: "attested" })
    ]);
    expect(supplierResponse.status).toBe(200);
    expect((supplierResponse.body as { suppliers: Array<{ status: string }> }).suppliers).toEqual([
      expect.objectContaining({ status: "attested" })
    ]);
  });

  it("orders same-block attest and revoke events by log index, not transaction hash", () => {
    const events: readonly ChainEvent[] = [
      chainEvent(10n, 3, "PlanRevoked", {
        planId,
        reasonHash,
        reasonURI: "https://store/revocations/1",
        revoker: attester
      }, "0x00"),
      chainEvent(10n, 2, "PlanAttested", {
        planId,
        planHash,
        artifactHash,
        policyHash,
        metadataHash,
        metadataURI: "https://store/plans/1",
        attester
      }, "0xff")
    ];

    const snapshot = rebuildTrustProjections(events);
    const plan = snapshot.plans[`31337:${contractAddress}:${planId}`];

    expect(plan?.revoked).toBe(true);
    expect(plan?.updatedAt.logIndex).toBe(3);
    expect(plan?.revokedAt?.transactionHash).toBe(
      "0x0000000000000000000000000000000000000000000000000000000000000000"
    );
  });

  it("allows public trust API queries without a registry filter", async () => {
    const store = new MemoryProjectionStore();
    const router = createApiRouter(store);

    await expect(router.handle({
      method: "GET",
      pathname: "/trust/plans",
      query: { planHash }
    })).resolves.toMatchObject({ status: 200 });

    await expect(router.handle({
      method: "GET",
      pathname: "/trust/suppliers",
      query: { wallet: supplierWallet }
    })).resolves.toMatchObject({ status: 200 });
  });

  it("returns 400 for malformed public trust API query values", async () => {
    const store = new MemoryProjectionStore();
    const router = createApiRouter(store);

    await expect(router.handle({
      method: "GET",
      pathname: "/trust/plans",
      query: { registryAddress: "not-an-address", planHash }
    })).resolves.toMatchObject({
      status: 400,
      body: { error: "invalid_query" }
    });

    await expect(router.handle({
      method: "GET",
      pathname: "/trust/suppliers",
      query: { registryAddress: contractAddress, wallet: "not-an-address" }
    })).resolves.toMatchObject({
      status: 400,
      body: { error: "invalid_query" }
    });
  });
});

function chainEvent(
  blockNumber: bigint,
  logIndex: number,
  eventName: string,
  args: Record<string, unknown>,
  transactionHashPrefix?: string
): ChainEvent {
  return {
    chainId: 31337,
    contractAddress,
    blockNumber,
    transactionHash: transactionHashPrefix
      ? `${transactionHashPrefix}${"0".repeat(66 - transactionHashPrefix.length)}` as `0x${string}`
      : `0x${blockNumber.toString(16).padStart(64, "0")}`,
    logIndex,
    eventName,
    args
  };
}
