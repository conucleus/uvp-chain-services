import { describe, expect, it } from "vitest";
import type {
  ComplianceAccessPreviewInput,
  ComplianceAccessPreviewResult,
  ComplianceProviderCapabilities,
  ComplianceService
} from "../src/compliance/index.js";
import { createApiRouter } from "../src/api/routes.js";
import { InMemoryAuditSink } from "../src/security/index.js";
import { MemoryProjectionStore } from "../src/storage/projection-store.js";

const storeHeaders = {
  "x-uvp-store-operator-id": "store-operator-1",
  "x-uvp-store-operator-role": "store_operator"
};

const readOnlyHeaders = {
  "x-uvp-store-user-id": "store-reader-1",
  "x-uvp-store-role": "reader"
};

describe("Store compliance no-op routes", () => {
  it("returns no-op capabilities to authenticated Store readers", async () => {
    const router = createApiRouter(new MemoryProjectionStore(), { submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111" });

    const response = await router.handle({
      method: "GET",
      pathname: "/store/compliance/capabilities",
      headers: readOnlyHeaders
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      capabilities: {
        providerName: "noop-store-compliance",
        providerMode: "noop",
        configured: false,
        sourceOfAuthority: "none",
        authorityGrantInput: "accepted",
        supportedDataLayers: expect.arrayContaining([
          "zhixu_definition",
          "signal_payload",
          "evidence_object",
          "escrow_state"
        ]),
        defaultAllow: ["zhixu_definition"],
        defaultDeny: ["signal_payload", "evidence_object", "payment_leg", "escrow_state"],
        privacy: {
          selectiveDisclosure: false,
          privacyCompute: "not_supported"
        }
      }
    });
  });

  it("requires an authenticated Store identity for capabilities", async () => {
    const router = createApiRouter(new MemoryProjectionStore(), { submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111" });

    const response = await router.handle({
      method: "GET",
      pathname: "/store/compliance/capabilities"
    });

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({
      error: "store_identity_missing",
      requiredCapability: "store.read"
    });
  });

  it("previews no-op access decisions by data layer", async () => {
    const router = createApiRouter(new MemoryProjectionStore(), { submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111" });

    await expect(preview(router, "zhixu_definition")).resolves.toMatchObject({
      decision: "allow",
      providerMode: "noop",
      sourceOfAuthority: "none",
      requiredGrants: []
    });
    await expect(preview(router, "signal_payload")).resolves.toMatchObject({
      decision: "deny",
      providerMode: "noop",
      sourceOfAuthority: "none",
      requiredGrants: ["authority_grant"]
    });
    await expect(preview(router, "evidence_object")).resolves.toMatchObject({
      decision: "deny"
    });
    await expect(preview(router, "signal_imprint")).resolves.toMatchObject({
      decision: "not_configured",
      providerMode: "noop",
      sourceOfAuthority: "none",
      requiredGrants: ["compliance_provider"]
    });
  });

  it("blocks read-only principals from access-preview", async () => {
    const router = createApiRouter(new MemoryProjectionStore(), { submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111" });

    const response = await router.handle({
      method: "POST",
      pathname: "/store/compliance/access-preview",
      headers: readOnlyHeaders,
      body: { dataLayer: "zhixu_definition" }
    });

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({
      error: "forbidden",
      requiredCapability: "store.audit.read"
    });
  });

  it("audits access-preview without raw payload, credential, object content, or signatures", async () => {
    const audit = new InMemoryAuditSink();
    const router = createApiRouter(new MemoryProjectionStore(), { submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111", audit });

    const response = await router.handle({
      method: "POST",
      pathname: "/store/compliance/access-preview",
      headers: {
        ...storeHeaders,
        "x-uvp-request-id": "req-compliance-preview-1"
      },
      body: {
        dataLayer: "signal_payload",
        resource: {
          type: "order",
          id: "order-1"
        },
        payload: "must not be audited",
        credential: "must not be audited",
        signature: "must not be audited",
        object: {
          content: "must not be audited"
        }
      }
    });

    expect(response.status).toBe(200);
    const events = audit.list().filter((event) => event.action === "store.audit.read");
    expect(events).toContainEqual(expect.objectContaining({
      type: "store.operator",
      outcome: "succeeded",
      actor: "store-operator-1",
      subject: expect.objectContaining({
        resourceType: "store_compliance",
        resourceId: "order-1"
      }),
      metadata: expect.objectContaining({
        requestId: "req-compliance-preview-1",
        dataLayer: "signal_payload",
        resource: {
          type: "store_compliance",
          id: "order-1"
        }
      })
    }));
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("must not be audited");
    expect(serialized).not.toContain("credential");
    expect(serialized).not.toContain("signature");
    expect(serialized).not.toContain("content");
  });

  it("allows a private compliance provider to be injected through the router", async () => {
    const service = fakeComplianceService();
    const router = createApiRouter(new MemoryProjectionStore(), { submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111", complianceService: service });

    const capabilities = await router.handle({
      method: "GET",
      pathname: "/store/compliance/capabilities",
      headers: readOnlyHeaders
    });
    expect(capabilities.status).toBe(200);
    expect(capabilities.body).toMatchObject({
      capabilities: {
        providerName: "fake-private-compliance",
        providerMode: "external",
        configured: true
      }
    });

    await expect(preview(router, "payment_leg")).resolves.toMatchObject({
      decision: "allow",
      providerMode: "external",
      sourceOfAuthority: "provider",
      requiredGrants: []
    });
  });
});

async function preview(
  router: ReturnType<typeof createApiRouter>,
  dataLayer: ComplianceAccessPreviewInput["dataLayer"]
): Promise<ComplianceAccessPreviewResult> {
  const response = await router.handle({
    method: "POST",
    pathname: "/store/compliance/access-preview",
    headers: storeHeaders,
    body: {
      dataLayer,
      resource: {
        type: "zhixu",
        id: "zhixu-cross-border"
      }
    }
  });
  expect(response.status).toBe(200);
  return (response.body as { result: ComplianceAccessPreviewResult }).result;
}

function fakeComplianceService(): ComplianceService {
  const capabilities: ComplianceProviderCapabilities = {
    providerName: "fake-private-compliance",
    providerMode: "external",
    configured: true,
    sourceOfAuthority: "provider",
    supportedDataLayers: ["payment_leg"],
    defaultAllow: ["payment_leg"],
    defaultNotConfigured: [],
    defaultDeny: [],
    authorityGrantInput: "accepted",
    privacy: {
      selectiveDisclosure: true,
      privacyCompute: "reserved"
    }
  };
  return {
    async getCapabilities() {
      return capabilities;
    },
    async previewAccess(input) {
      return {
        decision: input.dataLayer === "payment_leg" ? "allow" : "not_configured",
        reason: "fake provider decision",
        requiredGrants: [],
        providerMode: "external",
        sourceOfAuthority: "provider",
        dataLayer: input.dataLayer
      };
    }
  };
}
