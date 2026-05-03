import { describe, expect, it, vi } from "vitest";
import { createApiRouter } from "../src/api/routes.js";
import { createGovernanceService, type GovernanceChainAdapter } from "../src/governance/index.js";
import { MemoryProjectionStore } from "../src/storage/projection-store.js";
import type { Address, Hex } from "../src/shared/types.js";

const operatorHeaders = {
  "x-uvp-store-operator-id": "operator-confirm",
  "x-uvp-store-operator-role": "store_operator"
};

const adminHeaders = {
  "x-uvp-admin-id": "governance-confirm",
  "x-uvp-admin-role": "admin"
};

const domainId = "0x0000000000000000000000000000000000000000000000000000000000005201" as Hex;
const supplierSubjectId = "0x0000000000000000000000000000000000000000000000000000000000007001" as Hex;
const supplierWallet = "0x4444444444444444444444444444444444444444" as Address;

describe("Store sensitive action confirmation", () => {
  it("requires exact confirmation before supplier approval and governance handoff side effects", async () => {
    const adapter: GovernanceChainAdapter = {
      attestPlan: vi.fn(),
      revokePlan: vi.fn(),
      attestSupplier: vi.fn(),
      revokeSupplier: vi.fn()
    };
    const router = createApiRouter(new MemoryProjectionStore(), {
      governanceService: createGovernanceService({ adapter })
    });

    await expect(router.handle({
      method: "POST",
      pathname: "/store/suppliers",
      headers: operatorHeaders,
      body: supplierBody()
    })).resolves.toMatchObject({ status: 201 });

    await expect(router.handle({
      method: "POST",
      pathname: "/store/suppliers/supplier-confirm/review",
      headers: operatorHeaders,
      body: {
        reviewStatus: "approved_for_broadcast",
        capabilityTags: ["inspection"]
      }
    })).resolves.toMatchObject({
      status: 400,
      body: { error: "store_confirmation_required" }
    });

    await expect(router.handle({
      method: "POST",
      pathname: "/store/suppliers/supplier-confirm/review",
      headers: operatorHeaders,
      body: {
        reviewStatus: "submitted",
        capabilityTags: ["inspection"]
      }
    })).resolves.toMatchObject({ status: 200 });

    await expect(router.handle({
      method: "POST",
      pathname: "/store/suppliers/supplier-confirm/review",
      headers: operatorHeaders,
      body: {
        reviewStatus: "approved_for_broadcast",
        capabilityTags: ["inspection"],
        confirmation: { supplierId: "wrong-supplier" }
      }
    })).resolves.toMatchObject({
      status: 400,
      body: { error: "store_confirmation_mismatch" }
    });

    await expect(router.handle({
      method: "POST",
      pathname: "/store/suppliers/supplier-confirm/review",
      headers: operatorHeaders,
      body: {
        reviewStatus: "approved_for_broadcast",
        capabilityTags: ["inspection"],
        confirmation: { supplierId: "supplier-confirm" }
      }
    })).resolves.toMatchObject({ status: 200 });

    await expect(router.handle({
      method: "POST",
      pathname: "/store/suppliers/supplier-confirm/request-attestation",
      headers: adminHeaders,
      body: { domainId }
    })).resolves.toMatchObject({
      status: 400,
      body: { error: "store_confirmation_required" }
    });
    expect(adapter.attestSupplier).not.toHaveBeenCalled();
  });

  it("requires draft attestation confirmation before governance adapter invocation", async () => {
    const adapter: GovernanceChainAdapter = {
      attestPlan: vi.fn(),
      revokePlan: vi.fn(),
      attestSupplier: vi.fn(),
      revokeSupplier: vi.fn()
    };
    const router = createApiRouter(new MemoryProjectionStore(), {
      governanceService: createGovernanceService({ adapter })
    });

    await expect(router.handle({
      method: "POST",
      pathname: "/store/zhixu-drafts/missing-draft/request-attestation",
      headers: adminHeaders,
      body: { domainId }
    })).resolves.toMatchObject({
      status: 400,
      body: { error: "store_confirmation_required" }
    });
    expect(adapter.attestPlan).not.toHaveBeenCalled();
  });
});

function supplierBody(): Record<string, unknown> {
  return {
    supplierId: "supplier-confirm",
    supplierSubjectId,
    displayName: "Confirmation Supplier",
    wallet: supplierWallet,
    capabilityTags: ["logistics"],
    supportedRoleSlotIds: ["delivery"],
    supportedStageIds: ["shipping"],
    domains: [domainId]
  };
}
