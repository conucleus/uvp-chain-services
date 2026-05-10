import { describe, expect, it } from "vitest";
import { createApiRouter } from "../src/api/routes.js";
import type {
  RiskGraphAssessmentInput,
  RiskGraphAssessmentResult,
  RiskGraphCapabilities,
  RiskGraphService
} from "../src/risk/index.js";
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

describe("Store risk graph no-op routes", () => {
  it("returns no-op capabilities to authenticated Store audit readers", async () => {
    const router = createApiRouter(new MemoryProjectionStore());

    const response = await router.handle({
      method: "GET",
      pathname: "/store/risk/capabilities",
      headers: readOnlyHeaders
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      capabilities: {
        providerName: "noop-risk-graph",
        providerMode: "noop",
        configured: false,
        supportedSubjects: ["zhixu", "order", "entity"],
        supportedInputs: ["signal_metadata", "trust_snapshot", "evidence_metadata"],
        readsBusinessPlaintext: false
      }
    });
  });

  it("requires an authenticated Store identity for capabilities", async () => {
    const router = createApiRouter(new MemoryProjectionStore());

    const response = await router.handle({
      method: "GET",
      pathname: "/store/risk/capabilities"
    });

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({
      error: "store_identity_missing",
      requiredCapability: "store.audit.read"
    });
  });

  it("returns not_configured assessments for zhixu, order, and entity subjects", async () => {
    const router = createApiRouter(new MemoryProjectionStore());

    await expect(assess(router, { subjectType: "zhixu", zhixuId: "zhixu-cross-border" })).resolves.toMatchObject({
      riskLevel: "not_configured",
      score: null,
      decision: "not_configured",
      reason: "risk graph provider is not configured",
      configured: false,
      providerMode: "noop",
      modelVersion: "noop",
      evidencePaths: [],
      subjectType: "zhixu"
    });
    await expect(assess(router, { subjectType: "order", orderId: "order-1" })).resolves.toMatchObject({
      riskLevel: "not_configured",
      subjectType: "order"
    });
    await expect(assess(router, { subjectType: "entity", entityId: "supplier-1" })).resolves.toMatchObject({
      riskLevel: "not_configured",
      subjectType: "entity"
    });
  });

  it("requires an authenticated Store identity for assessments", async () => {
    const router = createApiRouter(new MemoryProjectionStore());

    const response = await router.handle({
      method: "POST",
      pathname: "/store/risk/assess",
      body: {
        subjectType: "zhixu",
        zhixuId: "zhixu-cross-border"
      }
    });

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({
      error: "store_identity_missing",
      requiredCapability: "store.audit.read"
    });
  });

  it("rejects invalid assessment subjects", async () => {
    const router = createApiRouter(new MemoryProjectionStore());

    const response = await router.handle({
      method: "POST",
      pathname: "/store/risk/assess",
      headers: storeHeaders,
      body: {
        subjectType: "payment"
      }
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: "invalid_subject_type"
    });
  });

  it("audits assessments without raw payload, evidence content, API keys, or signatures", async () => {
    const audit = new InMemoryAuditSink();
    const router = createApiRouter(new MemoryProjectionStore(), { audit });

    const response = await router.handle({
      method: "POST",
      pathname: "/store/risk/assess",
      headers: {
        ...storeHeaders,
        "x-uvp-request-id": "req-risk-assess-1"
      },
      body: {
        subjectType: "order",
        orderId: "order-1",
        payload: "must not be audited",
        apiKey: "must not be audited",
        signature: "must not be audited",
        evidence: {
          content: "must not be audited"
        },
        riskSemantics: {
          payloadHint: "must not be audited"
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
        resourceType: "store_risk",
        resourceId: "order-1"
      }),
      metadata: expect.objectContaining({
        requestId: "req-risk-assess-1",
        subjectType: "order",
        subject: "order-1",
        providerMode: "noop",
        configured: false
      })
    }));
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("must not be audited");
    expect(serialized).not.toContain("apiKey");
    expect(serialized).not.toContain("signature");
    expect(serialized).not.toContain("content");
  });

  it("allows a private risk graph provider to be injected through the router", async () => {
    const service = fakeRiskGraphService();
    const router = createApiRouter(new MemoryProjectionStore(), { riskGraphService: service });

    const capabilities = await router.handle({
      method: "GET",
      pathname: "/store/risk/capabilities",
      headers: readOnlyHeaders
    });
    expect(capabilities.status).toBe(200);
    expect(capabilities.body).toMatchObject({
      capabilities: {
        providerName: "fake-private-risk-graph",
        providerMode: "external",
        configured: true
      }
    });

    await expect(assess(router, { subjectType: "order", orderId: "order-risky" })).resolves.toMatchObject({
      riskLevel: "high",
      score: 82,
      decision: "review",
      configured: true,
      providerMode: "external",
      evidencePaths: [{
        pathId: "fake-path-1"
      }]
    });
  });
});

async function assess(
  router: ReturnType<typeof createApiRouter>,
  input: Omit<RiskGraphAssessmentInput, "metadataOnly">
): Promise<RiskGraphAssessmentResult> {
  const response = await router.handle({
    method: "POST",
    pathname: "/store/risk/assess",
    headers: storeHeaders,
    body: input
  });
  expect(response.status).toBe(200);
  return (response.body as { result: RiskGraphAssessmentResult }).result;
}

function fakeRiskGraphService(): RiskGraphService {
  const capabilities: RiskGraphCapabilities = {
    providerName: "fake-private-risk-graph",
    providerMode: "external",
    configured: true,
    supportedSubjects: ["order"],
    supportedInputs: ["signal_metadata", "trust_snapshot", "evidence_metadata"],
    readsBusinessPlaintext: false
  };
  return {
    async getCapabilities() {
      return capabilities;
    },
    async assess(input) {
      return {
        riskLevel: "high",
        score: 82,
        decision: "review",
        reason: "fake provider risk decision",
        reasons: [{
          code: "fake_cycle",
          message: "fake provider detected a suspicious signal cycle",
          severity: "high"
        }],
        configured: true,
        providerMode: "external",
        modelVersion: "fake-v1",
        evidencePaths: [{
          pathId: "fake-path-1",
          label: "fake signal loop",
          nodes: [input.orderId ?? "order"],
          edges: ["submitted_signal"]
        }],
        subjectType: input.subjectType
      };
    }
  };
}
