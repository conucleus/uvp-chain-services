import { describe, expect, it, vi } from "vitest";
import { crossBorderPlanIds, CROSS_BORDER_ZHIXU_ID } from "@uvp-eth/product-dto/fixtures";
import { createApiRouter } from "../src/api/routes.js";
import {
  createGovernanceBroadcasterAdapter,
  createGovernanceService,
  filterPublicGovernanceReviews,
  hashPlanMetadata,
  hashPlanPolicy,
  hashSupplierCapability,
  isRecommendedReview,
  InMemoryGovernanceStore,
  type GovernanceChainAdapter,
  type GovernanceChainRequestDTO,
  type GovernanceReviewDTO
} from "../src/governance/index.js";
import type { Address, Hex } from "../src/shared/types.js";
import { InMemoryAuditSink } from "../src/security/index.js";
import type { ChainEvent } from "../src/indexer/events.js";
import { MemoryProjectionStore } from "../src/storage/projection-store.js";

const adminHeaders = {
  "x-uvp-admin-id": "admin-1",
  "x-uvp-admin-role": "admin"
};

const planId = "0x0000000000000000000000000000000000000000000000000000000000002001" as Hex;
const supplierSubjectId = "0x0000000000000000000000000000000000000000000000000000000000003001" as Hex;
const planHash = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex;
const artifactHash = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Hex;
const wallet = "0x4444444444444444444444444444444444444444";
const signerPrivateKey = "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex;
const signer = "0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a" as Address;
const registryAddress = "0x5555555555555555555555555555555555555555" as Address;
const simulatedTx = "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" as Hex;

describe("governance admin API", () => {
  it("stores review state, keeps internal notes out of public DTOs, and rejects invalid terminal transitions", async () => {
    const router = createApiRouter(new MemoryProjectionStore(), {
      governanceService: createGovernanceService({
        now: () => new Date("2026-04-28T00:00:00Z")
      })
    });

    const draftResponse = await router.handle({
      method: "POST",
      pathname: "/admin/governance/review-zhixu",
      headers: adminHeaders,
      body: {
        subjectId: "cross-border-demo",
        status: "draft",
        riskLevel: "medium",
        riskTags: ["sanctions-check"],
        publicSummary: "Needs reviewer approval.",
        internalNotes: "Private compliance memo"
      }
    });
    expect(draftResponse.status).toBe(200);
    const draft = draftResponse.body as { review: GovernanceReviewDTO; publicReview: Record<string, unknown> };
    expect(draft.review.internalNotes).toBe("Private compliance memo");
    expect(draft.publicReview).not.toHaveProperty("internalNotes");

    const revokedResponse = await router.handle({
      method: "POST",
      pathname: "/admin/governance/review-zhixu",
      headers: adminHeaders,
      body: {
        reviewId: draft.review.reviewId,
        subjectId: "cross-border-demo",
        status: "revoked",
        publicSummary: "Revoked by governance."
      }
    });
    expect(revokedResponse.status).toBe(200);

    await expect(router.handle({
      method: "POST",
      pathname: "/admin/governance/review-zhixu",
      headers: adminHeaders,
      body: {
        reviewId: draft.review.reviewId,
        subjectId: "cross-border-demo",
        status: "approved"
      }
    })).resolves.toMatchObject({
      status: 409,
      body: { error: "invalid_review_transition" }
    });

    const listResponse = await router.handle({
      method: "GET",
      pathname: "/admin/governance/reviews",
      headers: adminHeaders
    });
    expect(listResponse.status).toBe(200);
    expect((listResponse.body as { reviews: GovernanceReviewDTO[] }).reviews[0]?.internalNotes)
      .toBe("Private compliance memo");
  });

  it("returns 403 for non-admin governance calls", async () => {
    const router = createApiRouter(new MemoryProjectionStore());

    await expect(router.handle({
      method: "GET",
      pathname: "/admin/governance/reviews"
    })).resolves.toMatchObject({ status: 403 });

    await expect(router.handle({
      method: "POST",
      pathname: "/admin/governance/review-supplier",
      headers: {
        "x-uvp-admin-id": "user-1",
        "x-uvp-admin-role": "participant"
      },
      body: {
        subjectId: supplierSubjectId,
        status: "approved"
      }
    })).resolves.toMatchObject({ status: 403 });
  });

  it("generates stable plan and supplier hashes from canonical snapshots", () => {
    const review = {
      subjectType: "zhixu" as const,
      subjectId: "cross-border-demo",
      status: "approved" as const,
      riskLevel: "low",
      riskTags: ["b", "a"],
      publicSummary: "Approved"
    };
    const first = {
      planId,
      planHash,
      artifactHash,
      review,
      metadata: { z: 1, a: { b: true } },
      policy: { regions: ["CN", "US"], threshold: 2 }
    };
    const second = {
      planId,
      planHash,
      artifactHash,
      review: { ...review, riskTags: ["a", "b"] },
      metadata: { a: { b: true }, z: 1 },
      policy: { threshold: 2, regions: ["CN", "US"] }
    };

    expect(hashPlanMetadata(first)).toBe(hashPlanMetadata(second));
    expect(hashPlanPolicy(first)).toBe(hashPlanPolicy(second));
    expect(hashSupplierCapability({
      supplierSubjectId,
      wallet,
      capability: { licenses: ["iso"], regions: ["CN"] }
    })).toBe(hashSupplierCapability({
      supplierSubjectId,
      wallet: wallet.toUpperCase(),
      capability: { regions: ["CN"], licenses: ["iso"] }
    }));
    const webhookCapability = {
      lanes: ["CN-US"],
      notification: {
        version: "uvp.supplierNotificationProfile.v1",
        transports: [
          {
            type: "webhook",
            endpointRef: "secret://suppliers/a/webhook"
          },
          {
            type: "slack",
            channelRef: "secret://suppliers/a/slack/customs"
          },
          {
            type: "email",
            mailboxRef: "secret://suppliers/a/email/ops"
          },
          {
            type: "mcp",
            serverRef: "secret://suppliers/a/mcp/server",
            toolName: "uvp.handleHookReady",
            authRef: "secret://suppliers/a/mcp/auth"
          }
        ]
      }
    };
    expect(hashSupplierCapability({
      supplierSubjectId,
      wallet,
      capability: webhookCapability
    })).toBe(hashSupplierCapability({
      supplierSubjectId,
      wallet,
      capability: {
        notification: {
          transports: [
            {
              endpointRef: "secret://suppliers/a/webhook",
              type: "webhook"
            },
            {
              channelRef: "secret://suppliers/a/slack/customs",
              type: "slack"
            },
            {
              mailboxRef: "secret://suppliers/a/email/ops",
              type: "email"
            },
            {
              authRef: "secret://suppliers/a/mcp/auth",
              serverRef: "secret://suppliers/a/mcp/server",
              toolName: "uvp.handleHookReady",
              type: "mcp"
            }
          ],
          version: "uvp.supplierNotificationProfile.v1"
        },
        lanes: ["CN-US"]
      }
    }));
    expect(hashSupplierCapability({
      supplierSubjectId,
      wallet,
      capability: webhookCapability
    })).not.toBe(hashSupplierCapability({
      supplierSubjectId,
      wallet,
      capability: {
        ...webhookCapability,
        notification: {
          version: "uvp.supplierNotificationProfile.v1",
          transports: [
            {
              type: "webhook",
              endpointRef: "secret://suppliers/a/rotated-webhook"
            },
            {
              type: "slack",
              channelRef: "secret://suppliers/a/slack/customs"
            },
            {
              type: "email",
              mailboxRef: "secret://suppliers/a/email/ops"
            },
            {
              type: "mcp",
              serverRef: "secret://suppliers/a/mcp/server",
              toolName: "uvp.handleHookReady",
              authRef: "secret://suppliers/a/mcp/auth"
            }
          ]
        }
      }
    }));
  });

  it("uses the adapter seam for attest and revoke requests", async () => {
    const requests: GovernanceChainRequestDTO[] = [];
    const adapter: GovernanceChainAdapter = {
      async attestPlan(request) {
        requests.push(request);
        return { status: "confirmed", txHash: simulatedTx, blockNumber: "7", signer, retryable: false, simulated: false };
      },
      async revokePlan(request) {
        requests.push(request);
        return { status: "submitted", txHash: simulatedTx, signer, retryable: false, simulated: false };
      },
      async attestSupplier(request) {
        requests.push(request);
        return { status: "submitted", txHash: simulatedTx, signer, retryable: false, simulated: false };
      },
      async revokeSupplier(request) {
        requests.push(request);
        return { status: "submitted", txHash: simulatedTx, signer, retryable: false, simulated: false };
      }
    };
    const store = new InMemoryGovernanceStore();
    const router = createApiRouter(new MemoryProjectionStore(), {
      governanceService: createGovernanceService({
        store,
        adapter,
        now: () => new Date("2026-04-28T00:00:00Z")
      })
    });

    await router.handle({
      method: "POST",
      pathname: "/admin/governance/review-zhixu",
      headers: adminHeaders,
      body: {
        subjectId: planId,
        status: "approved_for_broadcast",
        publicSummary: "Approved for official marketplace."
      }
    });
    const attestPlanResponse = await router.handle({
      method: "POST",
      pathname: "/admin/governance/attest-zhixu",
      headers: adminHeaders,
      body: { planId, planHash, artifactHash }
    });
    expect(attestPlanResponse.status).toBe(202);
    expect(attestPlanResponse.body).toMatchObject({
      request: {
        kind: "attestPlan",
        planId,
        planHash,
        artifactHash
      },
      broadcast: { status: "confirmed", txHash: simulatedTx, signer },
      log: {
        action: "attest_plan",
        status: "indexing",
        broadcastStatus: "confirmed",
        reconcileStatus: "indexing",
        receiptStatus: "success",
        projectionStatus: "missing",
        txHash: simulatedTx,
        blockNumber: "7",
        requester: "admin-1",
        signer,
        retryable: false
      }
    });

    await expect(router.handle({
      method: "POST",
      pathname: "/admin/governance/revoke-zhixu",
      headers: adminHeaders,
      body: { planId, reason: "Evidence became stale." }
    })).resolves.toMatchObject({
      status: 202,
      body: {
        request: { kind: "revokePlan", planId },
        log: { action: "revoke_plan", status: "pending" }
      }
    });

    await router.handle({
      method: "POST",
      pathname: "/admin/governance/review-supplier",
      headers: adminHeaders,
      body: {
        subjectId: supplierSubjectId,
        status: "restricted",
        publicSummary: "Restricted but eligible for direct matching."
      }
    });
    const supplierResponse = await router.handle({
      method: "POST",
      pathname: "/admin/governance/attest-supplier",
      headers: adminHeaders,
      body: {
        supplierSubjectId,
        wallet,
        profile: { name: "Supplier A" },
        metadata: {
          capability: {
            lanes: ["CN-US"],
            notification: {
              version: "uvp.supplierNotificationProfile.v1",
              transports: [
                {
                  type: "webhook",
                  endpointRef: "secret://suppliers/a/webhook"
                }
              ]
            }
          }
        },
        reputation: { score: 80 }
      }
    });
    const expectedSupplierCapabilityHash = hashSupplierCapability({
      supplierSubjectId,
      wallet,
      capability: {
        lanes: ["CN-US"],
        notification: {
          version: "uvp.supplierNotificationProfile.v1",
          transports: [
            {
              type: "webhook",
              endpointRef: "secret://suppliers/a/webhook"
            }
          ]
        }
      }
    });
    expect(supplierResponse.status).toBe(202);
    expect(supplierResponse.body).toMatchObject({
      request: {
        kind: "attestSupplier",
        supplierSubjectId,
        wallet,
        capabilityHash: expectedSupplierCapabilityHash
      },
      log: {
        profileHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
        capabilityHash: expectedSupplierCapabilityHash,
        reputationHash: expect.stringMatching(/^0x[0-9a-f]{64}$/)
      }
    });

    await router.handle({
      method: "POST",
      pathname: "/admin/governance/revoke-supplier",
      headers: adminHeaders,
      body: { supplierSubjectId, reason: "Supplier authorization revoked." }
    });

    expect(requests.map((request) => request.kind)).toEqual([
      "attestPlan",
      "revokePlan",
      "attestSupplier",
      "revokeSupplier"
    ]);
    expect(requests[0]).toMatchObject({
      kind: "attestPlan",
      metadataHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
      policyHash: expect.stringMatching(/^0x[0-9a-f]{64}$/)
    });
  });

  it("ignores client-supplied hash overrides and exposes retryable failed tx logs", async () => {
    const clientHash = "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex;
    const adapter: GovernanceChainAdapter = {
      async attestPlan() {
        throw new Error("rpc unavailable");
      },
      async revokePlan() {
        throw new Error("not used");
      },
      async attestSupplier() {
        throw new Error("not used");
      },
      async revokeSupplier() {
        throw new Error("not used");
      }
    };
    const governanceService = createGovernanceService({
      adapter,
      now: () => new Date("2026-04-28T00:00:00Z")
    });
    const router = createApiRouter(new MemoryProjectionStore(), { governanceService });

    await router.handle({
      method: "POST",
      pathname: "/admin/governance/review-zhixu",
      headers: adminHeaders,
      body: {
        subjectId: planId,
        status: "approved",
        metadataHash: clientHash,
        policyHash: clientHash,
        publicSummary: "Approved."
      }
    });
    const response = await router.handle({
      method: "POST",
      pathname: "/admin/governance/attest-zhixu",
      headers: adminHeaders,
      body: {
        planId,
        planHash,
        artifactHash,
        metadataHash: clientHash,
        policyHash: clientHash
      }
    });

    expect(response.status).toBe(202);
    const body = response.body as {
      readonly request: { readonly metadataHash: Hex; readonly policyHash: Hex };
      readonly log: { readonly txLogId: string };
    };
    expect(body.request.metadataHash).not.toBe(clientHash);
    expect(body.request.policyHash).not.toBe(clientHash);
    expect(response.body).toMatchObject({
      broadcast: {
        status: "failed",
        errorCode: "governance_adapter_failed",
        retryable: true
      },
      log: {
        status: "failed",
        errorCode: "governance_adapter_failed",
        retryable: true
      }
    });

    await expect(router.handle({
      method: "GET",
      pathname: `/admin/governance/tx/${body.log.txLogId}`,
      headers: adminHeaders
    })).resolves.toMatchObject({
      status: 200,
      body: {
        txLog: {
          txLogId: body.log.txLogId,
          status: "failed",
          retryable: true
        }
      }
    });
  });

  it("redacts governance adapter secrets from failed admin responses and audit records", async () => {
    const audit = new InMemoryAuditSink();
    const adapter: GovernanceChainAdapter = {
      async attestPlan() {
        throw new Error(`rpc rejected private key ${signerPrivateKey}`);
      },
      async revokePlan() {
        throw new Error("not used");
      },
      async attestSupplier() {
        throw new Error("not used");
      },
      async revokeSupplier() {
        throw new Error("not used");
      }
    };
    const router = createApiRouter(new MemoryProjectionStore(), {
      governanceService: createGovernanceService({ adapter, audit })
    });

    await router.handle({
      method: "POST",
      pathname: "/admin/governance/review-zhixu",
      headers: adminHeaders,
      body: {
        subjectId: planId,
        status: "approved_for_broadcast",
        publicSummary: "Approved."
      }
    });
    const response = await router.handle({
      method: "POST",
      pathname: "/admin/governance/attest-zhixu",
      headers: adminHeaders,
      body: { planId, planHash, artifactHash }
    });

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      log: {
        status: "failed",
        errorMessage: "rpc rejected private key [redacted:secret]"
      }
    });
    expect(JSON.stringify(response.body)).not.toContain(signerPrivateKey.slice(2));
    expect(JSON.stringify(audit.list())).not.toContain(signerPrivateKey.slice(2));
  });

  it("returns the existing tx log for duplicate non-retryable governance actions", async () => {
    const adapter: GovernanceChainAdapter = {
      attestPlan: vi.fn(async () => ({
        status: "confirmed" as const,
        txHash: simulatedTx,
        blockNumber: "11",
        signer,
        retryable: false,
        simulated: false
      })),
      async revokePlan() {
        throw new Error("not used");
      },
      async attestSupplier() {
        throw new Error("not used");
      },
      async revokeSupplier() {
        throw new Error("not used");
      }
    };
    const audit = new InMemoryAuditSink();
    const router = createApiRouter(new MemoryProjectionStore(), {
      governanceService: createGovernanceService({
        adapter,
        now: () => new Date("2026-04-28T00:00:00Z"),
        audit
      })
    });

    await router.handle({
      method: "POST",
      pathname: "/admin/governance/review-zhixu",
      headers: adminHeaders,
      body: {
        subjectId: planId,
        status: "approved",
        publicSummary: "Approved for duplicate check."
      }
    });

    const body = { planId, planHash, artifactHash };
    const first = await router.handle({
      method: "POST",
      pathname: "/admin/governance/attest-zhixu",
      headers: adminHeaders,
      body
    });
    const second = await router.handle({
      method: "POST",
      pathname: "/admin/governance/attest-zhixu",
      headers: adminHeaders,
      body
    });

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    const firstLogId = (first.body as { log: { txLogId: string } }).log.txLogId;
    expect(second.body).toMatchObject({
      log: { txLogId: firstLogId },
      broadcast: { txHash: simulatedTx, status: "confirmed" }
    });
    expect(adapter.attestPlan).toHaveBeenCalledOnce();
    expect(audit.list().map((event) => event.outcome)).toEqual(["succeeded", "duplicate"]);
  });

  it("broadcasts real TrustRegistry method parameters after chain, domain, and signer preflight", async () => {
    const publicClient = {
      getChainId: vi.fn(async () => 31337),
      readContract: vi.fn(async () => signer),
      waitForTransactionReceipt: vi.fn(async () => ({
        status: "success" as const,
        blockNumber: 99n
      }))
    };
    type WriteContractCall = {
      readonly address?: Address;
      readonly functionName: string;
      readonly args?: readonly unknown[];
    };
    const writeContract = vi.fn(async (_call: WriteContractCall) => simulatedTx);
    const adapter = createGovernanceBroadcasterAdapter({
      rpcUrl: "http://127.0.0.1:8545",
      chainId: 31337,
      contractAddress: registryAddress,
      privateKey: signerPrivateKey,
      txConfirmations: 1,
      publicClient,
      walletClient: { writeContract }
    });
    const profileHash = "0x9999999999999999999999999999999999999999999999999999999999999999" as Hex;
    const capabilityHash = "0x8888888888888888888888888888888888888888888888888888888888888888" as Hex;
    const reputationHash = "0x7777777777777777777777777777777777777777777777777777777777777777" as Hex;
    const metadataHash = "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd" as Hex;
    const policyHash = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" as Hex;
    const reasonHash = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as Hex;

    await expect(adapter.attestPlan({
      kind: "attestPlan",
      planId,
      planHash,
      artifactHash,
      policyHash,
      metadataHash,
      metadataURI: "uvp-governance://metadata/plan"
    })).resolves.toMatchObject({
      status: "confirmed",
      txHash: simulatedTx,
      blockNumber: "99",
      signer,
      simulated: false
    });
    await adapter.revokePlan({
      kind: "revokePlan",
      planId,
      reasonHash,
      reasonURI: "uvp-governance://metadata/revoke-plan"
    });
    await adapter.attestSupplier({
      kind: "attestSupplier",
      supplierSubjectId,
      wallet,
      profileHash,
      capabilityHash,
      reputationHash,
      metadataHash,
      metadataURI: "uvp-governance://metadata/supplier"
    });
    await adapter.revokeSupplier({
      kind: "revokeSupplier",
      supplierSubjectId,
      reasonHash,
      reasonURI: "uvp-governance://metadata/revoke-supplier"
    });

    expect(writeContract.mock.calls.map(([call]) => call.functionName)).toEqual([
      "attestPlan",
      "revokePlan",
      "attestSupplier",
      "revokeSupplier"
    ]);
    expect(writeContract.mock.calls[0]?.[0]).toMatchObject({
      address: registryAddress,
      functionName: "attestPlan",
      args: [planId, planHash, artifactHash, policyHash, metadataHash, "uvp-governance://metadata/plan"]
    });
    expect(writeContract.mock.calls[2]?.[0]).toMatchObject({
      functionName: "attestSupplier",
      args: [supplierSubjectId, wallet, profileHash, capabilityHash, reputationHash, "uvp-governance://metadata/supplier"]
    });
    expect(JSON.stringify(writeContract.mock.calls)).not.toContain(signerPrivateKey.slice(2));
  });

  it("blocks unauthorized governance signers while keeping the explicit operator seam available", async () => {
    const otherOwner = "0x9999999999999999999999999999999999999999" as Address;
    const publicClient = {
      getChainId: vi.fn(async () => 31337),
      readContract: vi.fn(async () => otherOwner),
      waitForTransactionReceipt: vi.fn(async () => ({
        status: "success" as const,
        blockNumber: 100n
      }))
    };
    const writeContract = vi.fn(async (_call: { readonly functionName: string }) => simulatedTx);
    const unauthorized = createGovernanceBroadcasterAdapter({
      rpcUrl: "http://127.0.0.1:8545",
      chainId: 31337,
      contractAddress: registryAddress,
      privateKey: signerPrivateKey,
      txConfirmations: 0,
      publicClient,
      walletClient: { writeContract }
    });

    await expect(unauthorized.revokePlan({
      kind: "revokePlan",
      planId,
      reasonHash: planHash,
      reasonURI: "uvp-governance://metadata/revoke"
    })).resolves.toMatchObject({
      status: "failed",
      errorCode: "governance_signer_not_authorized",
      retryable: false,
      signer
    });
    expect(writeContract).not.toHaveBeenCalled();

    const allowed = createGovernanceBroadcasterAdapter({
      rpcUrl: "http://127.0.0.1:8545",
      chainId: 31337,
      contractAddress: registryAddress,
      privateKey: signerPrivateKey,
      txConfirmations: 0,
      allowedOperators: [signer],
      publicClient,
      walletClient: { writeContract }
    });
    await expect(allowed.revokePlan({
      kind: "revokePlan",
      planId,
      reasonHash: planHash,
      reasonURI: "uvp-governance://metadata/revoke"
    })).resolves.toMatchObject({
      status: "submitted",
      txHash: simulatedTx,
      signer
    });
    expect(writeContract).toHaveBeenCalledOnce();
  });

  it("keeps public plan state projection-driven and blocks product drafts after revoked projection", async () => {
    const projectionStore = new MemoryProjectionStore();
    const adapter: GovernanceChainAdapter = {
      async attestPlan() {
        return { status: "confirmed", txHash: simulatedTx, blockNumber: "8", signer, retryable: false, simulated: false };
      },
      async revokePlan() {
        return { status: "confirmed", txHash: simulatedTx, blockNumber: "9", signer, retryable: false, simulated: false };
      },
      async attestSupplier() {
        throw new Error("not used");
      },
      async revokeSupplier() {
        throw new Error("not used");
      }
    };
    const router = createApiRouter(projectionStore, {
      governanceService: createGovernanceService({ adapter })
    });

    await router.handle({
      method: "POST",
      pathname: "/admin/governance/review-zhixu",
      headers: adminHeaders,
      body: {
        subjectId: crossBorderPlanIds.planId,
        status: "approved"
      }
    });
    const attestResponse = await router.handle({
      method: "POST",
      pathname: "/admin/governance/attest-zhixu",
      headers: adminHeaders,
      body: {
        planId: crossBorderPlanIds.planId,
        planHash: crossBorderPlanIds.planHash,
        artifactHash: crossBorderPlanIds.artifactHash
      }
    });
    expect(attestResponse.status).toBe(202);
    expect(attestResponse.body).toMatchObject({
      log: {
        status: "indexing",
        broadcastStatus: "confirmed",
        projectionStatus: "missing"
      }
    });

    await expect(createProductDraft(router)).resolves.toMatchObject({
      status: 403,
      body: { error: "plan_not_attested" }
    });

    await projectionStore.resetFromEvents({
      deploymentBlock: 0n,
      events: [planAttestedEvent(1n), planRevokedEvent(2n)]
    });
    await expect(createProductDraft(router)).resolves.toMatchObject({
      status: 409,
      body: { error: "plan_revoked" }
    });
  });

  it("filters rejected and revoked reviews while keeping restricted reviews public but not recommended", () => {
    const reviews = [
      review("approved-for-broadcast-1", "approved_for_broadcast"),
      review("approved-1", "approved"),
      review("restricted-1", "restricted"),
      review("rejected-1", "rejected"),
      review("revoked-1", "revoked")
    ];

    const publicReviews = filterPublicGovernanceReviews(reviews);
    expect(publicReviews.map((item) => item.reviewId)).toEqual([
      "approved-for-broadcast-1",
      "approved-1",
      "restricted-1"
    ]);
    expect(publicReviews[0]).not.toHaveProperty("internalNotes");
    expect(isRecommendedReview(reviews[0]!)).toBe(true);
    expect(isRecommendedReview(reviews[1]!)).toBe(true);
    expect(isRecommendedReview(reviews[2]!)).toBe(false);
  });
});

function createProductDraft(router: ReturnType<typeof createApiRouter>) {
  return router.handle({
    method: "POST",
    pathname: "/product/order-drafts",
    body: {
      zhixuId: CROSS_BORDER_ZHIXU_ID,
      title: "A company purchase",
      businessType: "parallel-export",
      totalAmount: "10000",
      currency: "USDC",
      createdBy: "creator-wallet"
    }
  });
}

function planAttestedEvent(blockNumber: bigint): ChainEvent {
  return chainEvent(blockNumber, 0, "PlanAttested", {
    planId: crossBorderPlanIds.planId,
    planHash: crossBorderPlanIds.planHash,
    artifactHash: crossBorderPlanIds.artifactHash,
    policyHash: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    metadataHash: "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    metadataURI: "uvp-governance://metadata/cross-border",
    attester: signer
  });
}

function planRevokedEvent(blockNumber: bigint): ChainEvent {
  return chainEvent(blockNumber, 1, "PlanRevoked", {
    planId: crossBorderPlanIds.planId,
    reasonHash: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    reasonURI: "uvp-governance://metadata/cross-border-revoked",
    revoker: signer
  });
}

function chainEvent(
  blockNumber: bigint,
  logIndex: number,
  eventName: string,
  args: Record<string, unknown>
): ChainEvent {
  return {
    chainId: 31337,
    contractAddress: registryAddress,
    blockNumber,
    transactionHash: `0x${blockNumber.toString(16).padStart(64, "0")}`,
    logIndex,
    eventName,
    args
  };
}

function review(reviewId: string, status: GovernanceReviewDTO["status"]): GovernanceReviewDTO {
  return {
    reviewId,
    subjectType: "zhixu",
    subjectId: reviewId,
    status,
    riskLevel: "low",
    riskTags: [],
    publicSummary: `${status} summary`,
    internalNotes: `${status} internal`,
    policyHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
    metadataHash: "0x2222222222222222222222222222222222222222222222222222222222222222",
    metadataURI: "uvp-governance://metadata/test",
    reviewer: "admin-1",
    createdAt: "2026-04-28T00:00:00.000Z",
    updatedAt: "2026-04-28T00:00:00.000Z"
  };
}
