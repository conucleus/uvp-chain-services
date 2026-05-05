import { describe, expect, it, vi } from "vitest";
import { createApiRouter } from "../src/api/routes.js";
import {
  createGovernanceService,
  type GovernanceChainAdapter,
  type GovernanceChainRequestDTO
} from "../src/governance/index.js";
import { InMemoryAuditSink } from "../src/security/index.js";
import { MemoryProjectionStore } from "../src/storage/projection-store.js";
import type { Address, Hex } from "../src/shared/types.js";

const operatorHeaders = {
  "x-uvp-store-operator-id": "operator-1",
  "x-uvp-store-operator-role": "store_operator"
};

const governanceAdminHeaders = {
  "x-uvp-admin-id": "governance-admin-1",
  "x-uvp-admin-role": "admin"
};

const registryAddress = "0x5555555555555555555555555555555555555555" as Address;
const supplierSubjectId = "0x0000000000000000000000000000000000000000000000000000000000003001" as Hex;
const supplierWallet = "0x4444444444444444444444444444444444444444";
const txHash = "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" as Hex;
const signer = "0x3333333333333333333333333333333333333333" as Address;

describe("Store operator audit events", () => {
  it("audits blocked Store writes with actor, capability, resource, and request id", async () => {
    const audit = new InMemoryAuditSink();
    const router = createApiRouter(new MemoryProjectionStore(), { audit });

    const response = await router.handle({
      method: "POST",
      pathname: "/store/docking-sessions",
      headers: { "x-uvp-request-id": "req-blocked-1" },
      body: {
        sourceZhixuId: "missing",
        targetZhixuId: "missing"
      }
    });

    expect(response.status).toBe(401);
    expect(audit.list()).toContainEqual(expect.objectContaining({
      type: "store.operator",
      action: "store.docking.create",
      outcome: "blocked",
      actor: "anonymous",
      errorCode: "store_identity_missing",
      subject: expect.objectContaining({
        resourceType: "store_docking_session",
        accessLevel: "anonymous_read",
        authMode: "anonymous"
      }),
      metadata: expect.objectContaining({
        requestId: "req-blocked-1"
      })
    }));
  });

  it("audits successful Store metadata mutations", async () => {
    const audit = new InMemoryAuditSink();
    const router = createApiRouter(new MemoryProjectionStore(), { audit });

    const response = await router.handle({
      method: "POST",
      pathname: "/store/zhixu-drafts/import",
      headers: {
        ...operatorHeaders,
        "x-uvp-request-id": "req-import-1"
      },
      body: {
        sourceKind: "zhixu_yaml",
        content: "apiVersion: uvp/v0\nkind: Zhixu\nmetadata:\n  name: audit-import\n",
        title: "Audit import"
      }
    });

    expect(response.status).toBe(201);
    expect(audit.list()).toContainEqual(expect.objectContaining({
      type: "store.operator",
      action: "store.draft.import",
      outcome: "succeeded",
      actor: "operator-1",
      subject: expect.objectContaining({
        resourceType: "store_zhixu_draft",
        resourceId: expect.stringMatching(/^zhixu_draft_/),
        accessLevel: "store_operator"
      }),
      metadata: expect.objectContaining({
        requestId: "req-import-1"
      })
    }));
  });

  it("audits governance handoff requests separately from supplier metadata rows", async () => {
    const requests: GovernanceChainRequestDTO[] = [];
    const adapter: GovernanceChainAdapter = {
      async attestPlan() {
        throw new Error("not used");
      },
      async revokePlan() {
        throw new Error("not used");
      },
      attestSupplier: vi.fn(async (request) => {
        requests.push(request);
        return { status: "submitted" as const, txHash, signer, retryable: false, simulated: false };
      }),
      async revokeSupplier() {
        throw new Error("not used");
      }
    };
    const audit = new InMemoryAuditSink();
    const router = createApiRouter(new MemoryProjectionStore(), {
      audit,
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
      pathname: "/store/suppliers/supplier-audit/review",
      headers: operatorHeaders,
      body: {
        reviewStatus: "approved_for_broadcast",
        capabilityTags: ["inspection"],
        confirmation: {
          supplierId: "supplier-audit"
        }
      }
    })).resolves.toMatchObject({ status: 200 });

    await expect(router.handle({
      method: "POST",
      pathname: "/store/suppliers/supplier-audit/request-attestation",
      headers: {
        ...governanceAdminHeaders,
        "x-request-id": "req-supplier-attest-1"
      },
      body: {
        confirmation: {
          supplierId: "supplier-audit"
        }
      }
    })).resolves.toMatchObject({ status: 202 });

    expect(requests).toHaveLength(1);
    expect(audit.list()).toContainEqual(expect.objectContaining({
      type: "store.operator",
      action: "store.supplier.attestation.request",
      outcome: "succeeded",
      actor: "governance-admin-1",
      subject: expect.objectContaining({
        resourceType: "store_supplier",
        resourceId: "supplier-audit",
        roles: ["store_admin", "governance_admin"]
      }),
      metadata: expect.objectContaining({
        requestId: "req-supplier-attest-1"
      })
    }));
  });
});

function supplierBody(): Record<string, unknown> {
  return {
    supplierId: "supplier-audit",
    supplierSubjectId,
    displayName: "Audit Supplier",
    wallet: supplierWallet,
    capabilityTags: ["logistics"],
    supportedRoleSlotIds: ["delivery"],
    supportedStageIds: ["shipping"],
    registryAddresses: [registryAddress]
  };
}
