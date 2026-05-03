import { describe, expect, it, vi } from "vitest";
import { CROSS_BORDER_ZHIXU_ID, crossBorderPlanIds } from "@uvp-eth/product-dto/fixtures";
import { createApiRouter, type ApiRouter } from "../src/api/routes.js";
import type { GovernanceService } from "../src/governance/index.js";
import type { ChainEvent } from "../src/indexer/events.js";
import { MemoryProjectionStore } from "../src/storage/projection-store.js";
import type { Address, Hex } from "../src/shared/types.js";

const adminHeaders = {
  "x-uvp-admin-id": "store-admin",
  "x-uvp-admin-role": "admin"
};

const contractAddress = "0x1111111111111111111111111111111111111111" as Address;
const attester = "0x2222222222222222222222222222222222222222";
const submitter = "0x3333333333333333333333333333333333333333";
const metadataHash = "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const policyHash = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const payloadHash = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const idempotencyKey = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const reasonHash = "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
const orderId = bytes32Hex("0202");
const hookId = bytes32Hex("0303");
const stageId = bytes32Text("export.customs");
const hookName = bytes32Text("customs-review");
const supplierSubjectId = bytes32Hex("3001");
const planIdV2 = bytes32Hex("0102");
const planHashV2 = "0x9999999999999999999999999999999999999999999999999999999999999999";
const artifactHashV2 = "0x8888888888888888888888888888888888888888888888888888888888888888";

describe("Store runtime observation and version cutover", () => {
  it("summarizes runtime state and warns without deleting revoked plan or supplier history", async () => {
    const store = new MemoryProjectionStore();
    const events = [
      ...stateMachineOrderEvents({ includeAuthorization: true }),
      supplierAttestedEvent(8n),
      supplierRevokedEvent(9n),
      planRevokedEvent(10n, crossBorderPlanIds.planId)
    ];
    await store.resetFromEvents({
      deploymentBlock: 0n,
      events,
      syncState: {
        chainId: 31337,
        contractAddress,
        syncStatus: "syncing",
        latestIndexedBlock: 10n,
        finalizedBlock: 4n,
        confirmationDepth: 2,
        lastEventName: "PlanRevoked",
        eventCount: events.length
      }
    });
    const router = createApiRouter(store, { now: () => new Date("2026-04-29T00:00:00Z") });

    const summaryResponse = await router.handle({ method: "GET", pathname: "/store/runtime/summary" });
    const observationResponse = await router.handle({ method: "GET", pathname: `/store/orders/${orderId}/observation` });
    const replayResponse = await router.handle({ method: "GET", pathname: `/store/orders/${orderId}/replay` });
    const auditResponse = await router.handle({ method: "GET", pathname: `/store/orders/${orderId}/audit-summary` });
    const blockedListResponse = await router.handle({
      method: "GET",
      pathname: `/store/zhixus/${CROSS_BORDER_ZHIXU_ID}/orders`,
      query: { status: "revoked-plan" }
    });

    expect(summaryResponse.status).toBe(200);
    expect(summaryResponse.body).toMatchObject({
      sourceOfTruth: "contracts-and-chain-events",
      runningOrderCount: 1,
      openTaskCount: 0,
      blockedOrderCount: 1,
      revokedPlanOrderCount: 1,
      revokedSupplierOpenTaskCount: 1,
      indexerStatus: "syncing"
    });

    expect(observationResponse.status).toBe(200);
    const observation = (observationResponse.body as { observation: { lifecycleWarnings: string[]; planId: string; tasks: unknown[]; suppliers: unknown[] } }).observation;
    expect(observation.planId).toBe(crossBorderPlanIds.planId);
    expect(observation.lifecycleWarnings).toEqual(expect.arrayContaining([
      "plan_revoked",
      "open_task_supplier_revoked",
      "indexer_syncing",
      "proof_finality_below_confirmation_depth"
    ]));
    expect(observation.tasks).toHaveLength(1);
    expect(observation.suppliers).toContainEqual(expect.objectContaining({
      wallet: submitter,
      trustStatus: "revoked"
    }));

    expect(replayResponse.status).toBe(200);
    expect((replayResponse.body as { replay: { replayStatus: string; planId: string; eventCount: number } }).replay)
      .toMatchObject({
        replayStatus: "syncing",
        planId: crossBorderPlanIds.planId,
        eventCount: expect.any(Number)
      });

    expect(auditResponse.status).toBe(200);
    const auditJson = JSON.stringify(auditResponse.body);
    expect(auditJson).toContain("redactionNotice");
    expect(auditJson).not.toContain(payloadHash);

    expect(blockedListResponse.status).toBe(200);
    expect((blockedListResponse.body as { orders: Array<{ orderId: string }> }).orders)
      .toContainEqual(expect.objectContaining({ orderId }));
  });

  it("flags open tasks that have no matching order-level authorization", async () => {
    const store = new MemoryProjectionStore();
    await store.resetFromEvents({
      deploymentBlock: 0n,
      events: stateMachineOrderEvents({ includeAuthorization: false })
    });
    const router = createApiRouter(store);

    const response = await router.handle({ method: "GET", pathname: `/store/orders/${orderId}/observation` });

    expect(response.status).toBe(200);
    expect((response.body as { observation: { lifecycleWarnings: string[] } }).observation.lifecycleWarnings)
      .toContain("open_task_authorization_missing");
  });

  it("activates one Store version at a time and keeps deprecated version order history visible", async () => {
    const store = new MemoryProjectionStore();
    await store.resetFromEvents({
      deploymentBlock: 0n,
      events: [
        ...stateMachineOrderEvents({ includeAuthorization: true }),
        planAttestedEvent(20n, planIdV2, planHashV2, artifactHashV2)
      ]
    });
    const router = createApiRouter(store, { now: () => new Date("2026-04-29T00:00:00Z") });

    const activateV1 = await activateVersion(router, "v1", {
      planId: crossBorderPlanIds.planId,
      planHash: crossBorderPlanIds.planHash,
      artifactHash: crossBorderPlanIds.artifactHash,
      versionLabel: "v1"
    });
    const activateV2 = await activateVersion(router, "v2", {
      planId: planIdV2,
      planHash: planHashV2,
      artifactHash: artifactHashV2,
      versionLabel: "v2",
      cutoverReason: "safer supplier checks"
    });
    const draftResponse = await createDraft(router);

    expect(activateV1.status).toBe(200);
    expect(activateV2.status).toBe(200);
    const versions = (activateV2.body as { versions: Array<{ versionId: string; status: string; orderCount: number }> }).versions;
    expect(versions).toContainEqual(expect.objectContaining({
      versionId: "v1",
      status: "deprecated",
      orderCount: 1
    }));
    expect(versions).toContainEqual(expect.objectContaining({
      versionId: "v2",
      status: "active",
      orderCount: 0
    }));
    expect((draftResponse.body as { draft: { planId: string; planHash: string } }).draft).toMatchObject({
      planId: planIdV2,
      planHash: planHashV2
    });

    const deprecateV2 = await router.handle({
      method: "POST",
      pathname: `/store/zhixu-series/${CROSS_BORDER_ZHIXU_ID}/versions/v2/deprecate`,
      headers: adminHeaders,
      body: {
        planId: planIdV2,
        planHash: planHashV2,
        cutoverReason: "manual pause",
        confirmation: {
          versionId: "v2",
          planId: planIdV2,
          planHash: planHashV2
        }
      }
    });
    expect(deprecateV2.status).toBe(200);
    await expect(createDraft(router)).resolves.toMatchObject({
      status: 409,
      body: { error: "no_active_version" }
    });
  });

  it("rejects activation for a version that is not attested", async () => {
    const router = createApiRouter(new MemoryProjectionStore());

    const response = await activateVersion(router, "unattested", {
      planId: planIdV2,
      planHash: planHashV2,
      artifactHash: artifactHashV2,
      versionLabel: "unattested"
    });

    expect(response).toMatchObject({
      status: 403,
      body: { error: "plan_not_attested" }
    });
  });

  it("blocks new drafts when the active Store version is later revoked by projection", async () => {
    const store = new MemoryProjectionStore();
    await store.resetFromEvents({
      deploymentBlock: 0n,
      events: [
        planAttestedEvent(1n, crossBorderPlanIds.planId, crossBorderPlanIds.planHash, crossBorderPlanIds.artifactHash),
        planAttestedEvent(2n, planIdV2, planHashV2, artifactHashV2)
      ]
    });
    const router = createApiRouter(store);
    await activateVersion(router, "v2", {
      planId: planIdV2,
      planHash: planHashV2,
      artifactHash: artifactHashV2,
      versionLabel: "v2"
    });
    await store.resetFromEvents({
      deploymentBlock: 0n,
      events: [
        planAttestedEvent(1n, crossBorderPlanIds.planId, crossBorderPlanIds.planHash, crossBorderPlanIds.artifactHash),
        planAttestedEvent(2n, planIdV2, planHashV2, artifactHashV2),
        planRevokedEvent(3n, planIdV2)
      ]
    });

    const versionsResponse = await router.handle({
      method: "GET",
      pathname: `/store/zhixu-series/${CROSS_BORDER_ZHIXU_ID}/versions`
    });
    const draftResponse = await createDraft(router);

    expect((versionsResponse.body as { versions: Array<{ versionId: string; status: string; attestationStatus: string }> }).versions)
      .toContainEqual(expect.objectContaining({
        versionId: "v2",
        status: "revoked",
        attestationStatus: "revoked"
      }));
    expect(draftResponse).toMatchObject({
      status: 409,
      body: { error: "plan_revoked" }
    });
  });

  it("delegates Store revocation requests to governance without marking projection revoked", async () => {
    const revokeZhixu = vi.fn(async (input: unknown) => ({
      request: {
        kind: "revokePlan" as const,
        domainId: crossBorderPlanIds.domainId,
        planId: planIdV2,
        reasonHash,
        reasonURI: "uvp-governance://metadata/revocation"
      },
      broadcast: {
        status: "submitted" as const,
        txHash: txHash(42n),
        retryable: false,
        simulated: false
      },
      log: {
        logId: "plan_log_store",
        txLogId: "tx_store",
        action: "revoke_plan" as const,
        domainId: crossBorderPlanIds.domainId,
        subjectId: planIdV2,
        planId: planIdV2,
        reasonHash,
        reasonURI: "uvp-governance://metadata/revocation",
        txHash: txHash(42n),
        requester: "store-admin",
        status: "pending" as const,
        broadcastStatus: "submitted" as const,
        retryable: false,
        request: input,
        createdAt: "2026-04-29T00:00:00.000Z",
        updatedAt: "2026-04-29T00:00:00.000Z"
      }
    }));
    const governanceService = {
      listReviews: vi.fn(async () => []),
      getTxLog: vi.fn(async () => undefined),
      reviewZhixu: vi.fn(),
      reviewSupplier: vi.fn(),
      attestZhixu: vi.fn(),
      revokeZhixu,
      attestSupplier: vi.fn(),
      revokeSupplier: vi.fn()
    } as unknown as GovernanceService;
    const store = new MemoryProjectionStore();
    await store.resetFromEvents({
      deploymentBlock: 0n,
      events: [planAttestedEvent(1n, planIdV2, planHashV2, artifactHashV2)]
    });
    const router = createApiRouter(store, { governanceService });

    const response = await router.handle({
      method: "POST",
      pathname: `/store/zhixu-series/${CROSS_BORDER_ZHIXU_ID}/versions/v2/request-revocation`,
      headers: adminHeaders,
      body: {
        planId: planIdV2,
        planHash: planHashV2,
        artifactHash: artifactHashV2,
        versionLabel: "v2",
        reason: "unsafe artifact",
        confirmation: {
          versionId: "v2",
          planId: planIdV2,
          planHash: planHashV2,
          domainId: crossBorderPlanIds.domainId
        }
      }
    });

    expect(response.status).toBe(202);
    expect(revokeZhixu).toHaveBeenCalledWith(expect.objectContaining({
      domainId: crossBorderPlanIds.domainId,
      planId: planIdV2,
      reason: "unsafe artifact"
    }), expect.objectContaining({ adminId: "store-admin" }));
    expect((response.body as { version: { status: string; attestationStatus: string } }).version)
      .toMatchObject({
        status: "candidate",
        attestationStatus: "attested"
      });
  });
});

async function activateVersion(router: ApiRouter, versionId: string, body: Record<string, unknown>) {
  return router.handle({
    method: "POST",
    pathname: `/store/zhixu-series/${CROSS_BORDER_ZHIXU_ID}/versions/${versionId}/activate`,
    headers: adminHeaders,
    body: {
      ...body,
      confirmation: {
        versionId,
        planId: typeof body.planId === "string" ? body.planId : undefined,
        planHash: typeof body.planHash === "string" ? body.planHash : undefined
      }
    }
  });
}

async function createDraft(router: ApiRouter) {
  return router.handle({
    method: "POST",
    pathname: "/product/order-drafts",
    body: {
      zhixuId: CROSS_BORDER_ZHIXU_ID,
      title: "A company purchase",
      businessType: "parallel-export",
      totalAmount: "10000",
      currency: "USDC"
    }
  });
}

function stateMachineOrderEvents(input: { readonly includeAuthorization: boolean }): readonly ChainEvent[] {
  return [
    chainEvent(1n, "PlanRegistered", {
      planId: crossBorderPlanIds.planId,
      planHash: crossBorderPlanIds.planHash,
      hookCount: 1n
    }),
    planAttestedEvent(2n, crossBorderPlanIds.planId, crossBorderPlanIds.planHash, crossBorderPlanIds.artifactHash),
    chainEvent(3n, "OrderRegistered", {
      orderId,
      planId: crossBorderPlanIds.planId
    }),
    ...(input.includeAuthorization
      ? [
          chainEvent(4n, "SignalSubmitterAuthorized", {
            orderId,
            sourceId: stageId,
            signalId: hookName,
            submitter,
            role: bytes32Text("customs-broker"),
            metadataHash
          })
        ]
      : []),
    chainEvent(5n, "HookReady", {
      orderId,
      hookId,
      stageId,
      hookName
    })
  ];
}

function planAttestedEvent(blockNumber: bigint, planId: string, planHash: string, artifactHash: string): ChainEvent {
  return chainEvent(blockNumber, "PlanAttested", {
    domainId: crossBorderPlanIds.domainId,
    planId,
    planHash,
    artifactHash,
    policyHash,
    metadataHash,
    metadataURI: "https://store.example/zhixu/version",
    attester
  });
}

function planRevokedEvent(blockNumber: bigint, planId: string): ChainEvent {
  return chainEvent(blockNumber, "PlanRevoked", {
    domainId: crossBorderPlanIds.domainId,
    planId,
    reasonHash,
    reasonURI: "https://store.example/revoke/version",
    revoker: attester
  });
}

function supplierAttestedEvent(blockNumber: bigint): ChainEvent {
  return chainEvent(blockNumber, "SupplierAttested", {
    domainId: crossBorderPlanIds.domainId,
    supplierSubjectId,
    wallet: submitter,
    profileHash: metadataHash,
    capabilityHash: policyHash,
    reputationHash: payloadHash,
    metadataURI: "https://store.example/suppliers/customs",
    attester
  });
}

function supplierRevokedEvent(blockNumber: bigint): ChainEvent {
  return chainEvent(blockNumber, "SupplierRevoked", {
    domainId: crossBorderPlanIds.domainId,
    supplierSubjectId,
    reasonHash,
    reasonURI: "https://store.example/suppliers/customs/revoke",
    revoker: attester
  });
}

function chainEvent(blockNumber: bigint, eventName: string, args: Record<string, unknown>): ChainEvent {
  return {
    chainId: 31337,
    contractAddress,
    blockNumber,
    transactionHash: txHash(blockNumber),
    logIndex: 0,
    eventName,
    args
  };
}

function txHash(blockNumber: bigint): Hex {
  return `0x${blockNumber.toString(16).padStart(64, "0")}`;
}

function bytes32Text(value: string): Hex {
  return `0x${Buffer.from(value, "utf8").toString("hex").padEnd(64, "0")}`;
}

function bytes32Hex(suffix: string): Hex {
  return `0x${suffix.padStart(64, "0")}`;
}
