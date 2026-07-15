import { describe, expect, it } from "vitest";
import { keccak256, stringToBytes } from "viem";
import type { StoreProductSchemaDTO } from "@uvp-eth/product-dto";
import {
  CROSS_BORDER_ZHIXU_ID,
  DEMO_ORDER_ID,
  DEMO_TASK_ID,
  crossBorderPlanIds,
  customsStoreProductSchema
} from "@uvp-eth/product-dto/fixtures";
import { createApiRouter } from "../src/api/routes.js";
import { createEvidenceService, InMemoryEvidenceStorage, ObjectEvidenceStorage } from "../src/evidence/index.js";
import type { ChainEvent } from "../src/indexer/events.js";
import { MemoryProductBffStore } from "../src/product/bff/store.js";
import { MemoryProjectionStore } from "../src/storage/projection-store.js";
import { MemoryStoreZhixuDraftStore } from "../src/store-console/zhixu-drafts.js";
import { InMemoryStoreSupplierMetadataStore } from "../src/store-suppliers/service.js";
import type { Address, Hex } from "../src/shared/types.js";

const contractAddress = "0x1111111111111111111111111111111111111111";
const contractAddressV2 = "0x1212121212121212121212121212121212121212";
const submitter = "0x3333333333333333333333333333333333333333";
const overlayExecutor = "0x5555555555555555555555555555555555555555";
const storeOperatorHeaders = {
  "x-uvp-store-user-id": "store-operator-1",
  "x-uvp-store-role": "operator"
};
const storeAdminHeaders = {
  "x-uvp-store-user-id": "store-admin-1",
  "x-uvp-store-role": "admin"
};
const metadataHash = "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const nonOfficialDomainId = "0x0000000000000000000000000000000000000000000000000000000000009999";
const stateMachineOrderId = "0x0000000000000000000000000000000000000000000000000000000000000202";
const hookId = "0x0000000000000000000000000000000000000000000000000000000000000303";
const stageId = bytes32Text("export.customs");
const hookName = bytes32Text("customs-review");
const selectorStageId = bytes32Text("buyer.select-customs-executor");
const sourceId = bytes32Text("customs-source");
const signalId = bytes32Text("cmp");
const supplierSubjectId = bytes32Hex("3001");
const payloadHash = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const idempotencyKey = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

describe("product API routes", () => {
  it("serves the current zhixu catalog and detail routes", async () => {
    const router = createApiRouter(new MemoryProjectionStore());

    const listResponse = await router.handle({ method: "GET", pathname: "/product/zhixus" });
    expect(listResponse.status).toBe(200);
    expect((listResponse.body as { zhixus: unknown[] }).zhixus).toHaveLength(1);

    await expect(router.handle({ method: "GET", pathname: `/product/zhixus/${CROSS_BORDER_ZHIXU_ID}` }))
      .resolves.toMatchObject({ status: 200 });
  });

  it("uses demo zhixu fallback only when demo mode is enabled", async () => {
    const emptyRouter = createApiRouter(new MemoryProjectionStore());
    await expect(emptyRouter.handle({
      method: "GET",
      pathname: "/product/zhixus",
      query: { fallback: "demo" }
    })).resolves.toEqual({
      status: 403,
      body: { error: "demo_mode_disabled" }
    });

    const fallbackResponse = await createApiRouter(new MemoryProjectionStore(), { productDemoMode: true }).handle({
      method: "GET",
      pathname: "/product/zhixus",
      query: { fallback: "demo" }
    });
    expect(fallbackResponse.status).toBe(200);
    expect((fallbackResponse.body as { zhixus: Array<{ zhixuId: string; planPublication: { status: string } }> }).zhixus)
      .toEqual([
        expect.objectContaining({
          zhixuId: CROSS_BORDER_ZHIXU_ID,
          planPublication: expect.objectContaining({ status: "not_found" })
        })
      ]);

  });

  it("serves a Store Console zhixu lifecycle view without enabling product demo fallback", async () => {
    const emptyRouter = createApiRouter(new MemoryProjectionStore());

    const emptyResponse = await emptyRouter.handle({ method: "GET", pathname: "/store/zhixus" });
    const missingDetailResponse = await emptyRouter.handle({
      method: "GET",
      pathname: `/store/zhixus/${CROSS_BORDER_ZHIXU_ID}`
    });

    expect(emptyResponse.status).toBe(200);
    expect((emptyResponse.body as {
      summary: { totalZhixus: number; needsReview: number };
      zhixus: Array<{ zhixuId: string; lifecycleStatus: string; nextAction: string }>;
    })).toMatchObject({
      summary: { totalZhixus: 1, needsReview: 1 },
      zhixus: [expect.objectContaining({ zhixuId: CROSS_BORDER_ZHIXU_ID })]
    });
    expect(missingDetailResponse).toMatchObject({ status: 200 });

    const store = new MemoryProjectionStore();
    await store.resetFromEvents({ deploymentBlock: 0n, events: stateMachineProductEvents() });
    const router = createApiRouter(store);
    const listResponse = await router.handle({ method: "GET", pathname: "/store/zhixus" });
    const detailResponse = await router.handle({ method: "GET", pathname: `/store/zhixus/${CROSS_BORDER_ZHIXU_ID}` });

    expect((listResponse.body as {
      summary: { activeZhixus: number; runningOrders: number; openTasks: number };
      zhixus: Array<{ lifecycleStatus: string; orderCount: number; openTaskCount: number }>;
    })).toMatchObject({
      summary: { activeZhixus: 1, runningOrders: 1, openTasks: 1 },
      zhixus: [
        expect.objectContaining({
          lifecycleStatus: "active",
          orderCount: 1,
          openTaskCount: 1
        })
      ]
    });
    expect(detailResponse).toMatchObject({
      status: 200,
      body: {
        zhixu: expect.objectContaining({
          zhixuId: CROSS_BORDER_ZHIXU_ID,
          lifecycleStatus: "active",
          description: expect.any(String),
          stages: expect.any(Array),
          allowedActions: expect.arrayContaining([
            expect.objectContaining({ actionId: "create_order", enabled: true })
          ]),
          proofSections: expect.arrayContaining([
            expect.objectContaining({
              sectionId: "plan-publication",
              rows: expect.arrayContaining([
                expect.objectContaining({ label: "Plan ID", value: crossBorderPlanIds.planId })
              ])
            })
          ])
        })
      }
    });
    const detail = (detailResponse.body as { zhixu: Record<string, unknown> }).zhixu;
    const primaryDetailJson = JSON.stringify({
      description: detail.description,
      lifecycleReason: detail.lifecycleReason,
      usageGuidance: detail.usageGuidance,
      stages: detail.stages,
      roleSlots: detail.roleSlots,
      supplierRequirements: detail.supplierRequirements
    });
    expect(primaryDetailJson).not.toMatch(/HookReady|sourceId|signalId/);
  });

  it("filters Store zhixus and searches exact zhixu id", async () => {
    const store = new MemoryProjectionStore();
    await store.resetFromEvents({ deploymentBlock: 0n, events: stateMachineProductEvents() });
    const router = createApiRouter(store);

    const listResponse = await router.handle({
      method: "GET",
      pathname: "/store/zhixus",
      query: {
        query: "跨境",
        lifecycle: "active",
        review: "approved",
        publication: "published",
      }
    });
    const searchResponse = await router.handle({
      method: "GET",
      pathname: "/store/search",
      query: { q: CROSS_BORDER_ZHIXU_ID, type: "zhixu" }
    });

    expect((listResponse.body as { zhixus: Array<{ zhixuId: string; lifecycleStatus: string }> }).zhixus)
      .toEqual([
        expect.objectContaining({
          zhixuId: CROSS_BORDER_ZHIXU_ID,
          lifecycleStatus: "active"
        })
      ]);
    expect((searchResponse.body as { results: Array<{ resultType: string; id: string; matchedFields: string[]; sourceOfTruth: string }> }).results[0])
      .toMatchObject({
        resultType: "zhixu",
        id: CROSS_BORDER_ZHIXU_ID,
        matchedFields: expect.arrayContaining(["zhixuId"]),
        sourceOfTruth: "chain-and-store-metadata"
      });
  });

  it("searches exact order id and returns candidate page for ambiguous order ids", async () => {
    const store = new MemoryProjectionStore();
    await store.resetFromEvents({ deploymentBlock: 0n, events: stateMachineProductEvents() });
    const router = createApiRouter(store);

    const directSearch = await router.handle({
      method: "GET",
      pathname: "/store/search",
      query: { q: stateMachineOrderId, type: "order" }
    });
    const directCandidates = await router.handle({
      method: "GET",
      pathname: `/store/orders/${stateMachineOrderId}/candidates`
    });

    expect((directSearch.body as { results: Array<{ resultType: string; id: string; primaryHref: string }> }).results[0])
      .toMatchObject({
        resultType: "order",
        id: stateMachineOrderId,
        primaryHref: `/product/orders/${stateMachineOrderId}`
      });
    expect((directCandidates.body as { candidateCount: number; candidates: Array<{ stateMachineAddress: string }> }))
      .toMatchObject({
        candidateCount: 1,
        candidates: [expect.objectContaining({ stateMachineAddress: contractAddress })]
      });

    const ambiguousStore = new MemoryProjectionStore();
    await ambiguousStore.resetFromEvents({
      deploymentBlock: 0n,
      events: [
        ...stateMachineProductEvents(),
        ...stateMachineProductEvents().map((event) => ({
          ...event,
          contractAddress: contractAddressV2 as Address,
          blockNumber: event.blockNumber + 20n,
          transactionHash: txHash(event.blockNumber + 20n)
        }))
      ]
    });
    const ambiguousRouter = createApiRouter(ambiguousStore);
    const ambiguousSearch = await ambiguousRouter.handle({
      method: "GET",
      pathname: "/store/search",
      query: { q: stateMachineOrderId, type: "order" }
    });
    const ambiguousCandidates = await ambiguousRouter.handle({
      method: "GET",
      pathname: `/store/orders/${stateMachineOrderId}/candidates`
    });

    expect((ambiguousSearch.body as { results: Array<{ badgeLabel: string; primaryHref: string }> }).results[0])
      .toMatchObject({
        badgeLabel: "多个候选",
        primaryHref: `/store/orders/${stateMachineOrderId}/candidates`
      });
    expect((ambiguousCandidates.body as { candidateCount: number; candidates: Array<{ stateMachineAddress: string }> }))
      .toMatchObject({
        candidateCount: 2,
        candidates: expect.arrayContaining([
          expect.objectContaining({ stateMachineAddress: contractAddress }),
          expect.objectContaining({ stateMachineAddress: contractAddressV2 })
        ])
      });
  });

  it("searches Store supplier metadata by subject id or wallet", async () => {
    const store = new MemoryProjectionStore();
    await store.resetFromEvents({
      deploymentBlock: 0n,
      events: stateMachineProductEvents()
    });
    const supplierMetadata = new InMemoryStoreSupplierMetadataStore();
    await supplierMetadata.putSupplier({
      supplierId: "customs-broker",
      supplierSubjectId: supplierSubjectId as Hex,
      displayName: "Customs Broker",
      wallet: submitter as Address,
      capabilityTags: ["customs"],
      supportedRoleSlotIds: ["customs-broker"],
      supportedStageIds: ["export.customs"],
      registryAddresses: [],
      reviewStatus: "approved_for_broadcast",
      metadataURI: "https://store.example/suppliers/customs-broker",
      createdAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:00:00.000Z"
    });
    const router = createApiRouter(store, { storeSupplierMetadataStore: supplierMetadata });

    const bySubject = await router.handle({
      method: "GET",
      pathname: "/store/search",
      query: { q: supplierSubjectId, type: "supplier" }
    });
    const byWallet = await router.handle({
      method: "GET",
      pathname: "/store/search",
      query: { q: submitter, type: "supplier" }
    });

    expect((bySubject.body as { results: Array<{ resultType: string; id: string; badgeLabel: string; matchedFields: string[] }> }).results[0])
      .toMatchObject({
        resultType: "supplier",
        id: supplierSubjectId,
        badgeLabel: "已审核",
        matchedFields: expect.arrayContaining(["supplierSubjectId"])
      });
    expect((byWallet.body as { results: Array<{ id: string; matchedFields: string[]; statusLabel: string }> }).results[0])
      .toMatchObject({
        id: supplierSubjectId,
        matchedFields: expect.arrayContaining(["wallet"]),
        statusLabel: "Store 审核通过"
      });
  });

  it("includes Store search projection syncing state", async () => {
    const store = new MemoryProjectionStore();
    await store.saveSyncState({
      chainId: 31337,
      contractAddress: contractAddress as Address,
      syncStatus: "rebuilding",
      latestIndexedBlock: 12n,
      finalizedBlock: 10n,
      confirmationDepth: 2,
      eventCount: 0,
      rebuild: { status: "running", fromBlock: 0n, toBlock: 12n }
    });
    const response = await createApiRouter(store).handle({
      method: "GET",
      pathname: "/store/search",
      query: { q: "missing" }
    });

    expect(response.status).toBe(200);
    expect((response.body as { projectionStatus: { syncStatus: string; isCatchingUp: boolean; rebuildStatus: string } }).projectionStatus)
      .toMatchObject({
        syncStatus: "rebuilding",
        isCatchingUp: true,
        rebuildStatus: "running"
    });
  });

  it("creates, validates, and saves Store docking sandbox sessions without publishing zhixu changes", async () => {
    const store = new MemoryProjectionStore();
    await store.resetFromEvents({
      deploymentBlock: 0n,
      events: [
        chainEvent(1n, "PlanRegistered", {
          planId: crossBorderPlanIds.planId,
          planHash: crossBorderPlanIds.planHash,
          hookCount: 1n
        })
      ]
    });
    const router = createApiRouter(store, { now: () => new Date("2026-04-29T00:00:00Z") });

    const detailBefore = await router.handle({ method: "GET", pathname: `/store/zhixus/${CROSS_BORDER_ZHIXU_ID}` });
    const createResponse = await router.handle({
      method: "POST",
      pathname: "/store/docking-sessions",
      headers: storeOperatorHeaders,
      body: {
        sourceZhixuId: CROSS_BORDER_ZHIXU_ID,
        targetZhixuId: CROSS_BORDER_ZHIXU_ID
      }
    });

    expect(createResponse.status).toBe(201);
    const created = (createResponse.body as {
      session: {
        sessionId: string;
        status: string;
        validation: { ok: boolean; nonPublishing: boolean; errors: unknown[] };
        candidateMappings: Array<{
          sourceSignal: { signalId: string };
          targetSignal: { signalId: string };
        }>;
      };
    }).session;
    expect(created).toMatchObject({
      status: "draft",
      validation: {
        ok: true,
        nonPublishing: true,
        errors: []
      }
    });
    expect(created.candidateMappings.length).toBeGreaterThan(0);
    const candidate = created.candidateMappings[0]!;
    const draftSignalMap = [{
      sourceSignalId: candidate.sourceSignal.signalId,
      targetSignalId: candidate.targetSignal.signalId,
      note: "same stage candidate"
    }];

    const validateResponse = await router.handle({
      method: "POST",
      pathname: `/store/docking-sessions/${created.sessionId}/validate`,
      headers: storeOperatorHeaders,
      body: { draftSignalMap }
    });
    expect(validateResponse).toMatchObject({
      status: 200,
      body: {
        session: {
          status: "valid",
          validation: {
            ok: true,
            nonPublishing: true,
            errors: []
          }
        }
      }
    });

    const saveResponse = await router.handle({
      method: "POST",
      pathname: `/store/docking-sessions/${created.sessionId}/save-draft-map`,
      headers: storeOperatorHeaders,
      body: { draftSignalMap }
    });
    expect(saveResponse).toMatchObject({
      status: 200,
      body: {
        session: {
          status: "valid",
          draftSignalMap,
          validation: { ok: true }
        }
      }
    });

    const detailAfter = await router.handle({ method: "GET", pathname: `/store/zhixus/${CROSS_BORDER_ZHIXU_ID}` });
    expect(detailAfter.body).toEqual(detailBefore.body);
  });

  it("fails Store docking writes closed without operator access and validates explicit sandbox errors", async () => {
    const emptyRouter = createApiRouter(new MemoryProjectionStore());
    await expect(emptyRouter.handle({
      method: "POST",
      pathname: "/store/docking-sessions",
      body: {
        sourceZhixuId: CROSS_BORDER_ZHIXU_ID,
        targetZhixuId: CROSS_BORDER_ZHIXU_ID
      }
    })).resolves.toMatchObject({
      status: 401,
      body: {
        error: "store_identity_missing",
        requiredAccess: "store_operator",
        accessLevel: "anonymous_read"
      }
    });

    const missingZhixuResponse = await emptyRouter.handle({
      method: "POST",
      pathname: "/store/docking-sessions",
      headers: storeOperatorHeaders,
      body: {
        sourceZhixuId: CROSS_BORDER_ZHIXU_ID,
        targetZhixuId: CROSS_BORDER_ZHIXU_ID
      }
    });
    expect(missingZhixuResponse).toMatchObject({ status: 201 });

    const store = new MemoryProjectionStore();
    await store.resetFromEvents({
      deploymentBlock: 0n,
      events: [
        chainEvent(1n, "PlanRegistered", {
          planId: crossBorderPlanIds.planId,
          planHash: crossBorderPlanIds.planHash,
          hookCount: 1n
        })
      ]
    });
    const revokedResponse = await createApiRouter(store).handle({
      method: "POST",
      pathname: "/store/docking-sessions",
      headers: storeOperatorHeaders,
      body: {
        sourceZhixuId: CROSS_BORDER_ZHIXU_ID,
        targetZhixuId: CROSS_BORDER_ZHIXU_ID
      }
    });
    expect((revokedResponse.body as {
      session: { validation: { errors: Array<{ code: string }> } };
    }).session.validation.errors.map((error) => error.code)).toEqual([]);
  });

  it("returns missing source and target signal validation errors for docking drafts", async () => {
    const store = new MemoryProjectionStore();
    await store.resetFromEvents({
      deploymentBlock: 0n,
      events: [
        chainEvent(1n, "PlanRegistered", {
          planId: crossBorderPlanIds.planId,
          planHash: crossBorderPlanIds.planHash,
          hookCount: 1n
        })
      ]
    });
    const router = createApiRouter(store);
    const createResponse = await router.handle({
      method: "POST",
      pathname: "/store/docking-sessions",
      headers: storeOperatorHeaders,
      body: {
        sourceZhixuId: CROSS_BORDER_ZHIXU_ID,
        targetZhixuId: CROSS_BORDER_ZHIXU_ID
      }
    });
    const created = (createResponse.body as {
      session: {
        sessionId: string;
        candidateMappings: Array<{
          sourceSignal: { signalId: string };
          targetSignal: { signalId: string };
        }>;
      };
    }).session;
    const candidate = created.candidateMappings[0]!;

    const validateResponse = await router.handle({
      method: "POST",
      pathname: `/store/docking-sessions/${created.sessionId}/validate`,
      headers: storeOperatorHeaders,
      body: {
        draftSignalMap: [
          {
            sourceSignalId: "missing.output",
            targetSignalId: candidate.targetSignal.signalId
          },
          {
            sourceSignalId: candidate.sourceSignal.signalId,
            targetSignalId: "missing.input"
          }
        ]
      }
    });

    expect(validateResponse.status).toBe(200);
    expect((validateResponse.body as {
      session: { status: string; validation: { ok: boolean; errors: Array<{ code: string }> } };
    }).session).toMatchObject({
      status: "invalid",
      validation: {
        ok: false,
        errors: expect.arrayContaining([
          expect.objectContaining({ code: "source_output_not_found" }),
          expect.objectContaining({ code: "target_input_not_found" })
        ])
      }
    });
  });

  it("serves chain-backed product order, task, timeline, proof, and replays consistently", async () => {
    const events = stateMachineProductEvents();
    const store = new MemoryProjectionStore();
    await store.resetFromEvents({ deploymentBlock: 0n, events });
    const router = createApiRouter(store);
    const taskId = `${contractAddress}:${stateMachineOrderId}:${hookId}`;

    const orderResponse = await router.handle({ method: "GET", pathname: `/product/orders/${stateMachineOrderId}` });
    const timelineResponse = await router.handle({ method: "GET", pathname: `/product/orders/${stateMachineOrderId}/timeline` });
    const proofResponse = await router.handle({ method: "GET", pathname: `/product/orders/${stateMachineOrderId}/proof` });
    const tasksResponse = await router.handle({ method: "GET", pathname: "/product/tasks", query: { orderId: stateMachineOrderId } });

    expect(orderResponse.status).toBe(200);
    const order = (orderResponse.body as { order: ChainBackedOrder }).order;
    expect(order).toMatchObject({
      orderId: stateMachineOrderId,
      planId: crossBorderPlanIds.planId,
      planHash: crossBorderPlanIds.planHash,
      chainStatus: "registered",
      currentStageId: "export.customs",
      projection: expect.objectContaining({
        source: "chain_projection",
        syncStatus: "indexed",
        updatedAtBlock: "7"
      })
    });
    expect(order.paymentConditionSummary).toContain("1 个已满足");
    expect(order.confirmations).toContainEqual(expect.objectContaining({
      payloadHash,
      submitter
    }));
    expect(order.conditions).toContainEqual(expect.objectContaining({
      conditionId: hookId,
      status: "ready"
    }));
    expect(order.tasks).toContainEqual(expect.objectContaining({
      taskId,
      hookId,
      hookName: "customs-review",
      stageIdentifier: "export.customs",
      readyTxHash: txHash(7n),
      chainStatus: "ready",
      projection: expect.objectContaining({ source: "chain_projection" })
    }));

    expect((timelineResponse.body as { timeline: Array<{ eventName: string; blockNumber: string; transactionHash: string }> }).timeline)
      .toContainEqual(expect.objectContaining({
        eventName: "HookReady",
        blockNumber: "7",
        transactionHash: txHash(7n)
      }));
    expect((timelineResponse.body as { timeline: Array<{ eventName: string }> }).timeline.map((event) => event.eventName))
      .toEqual(expect.arrayContaining(["OrderRegistered", "SignalSubmitted", "HookReady"]));
    expect((proofResponse.body as { proof: Array<{ eventName: string; blockNumber: string; transactionHash: string }> }).proof)
      .toContainEqual(expect.objectContaining({
        eventName: "OrderRegistered",
        blockNumber: "3",
        transactionHash: txHash(3n)
      }));
    expect((tasksResponse.body as { tasks: Array<{ taskId: string; status: string }> }).tasks)
      .toContainEqual(expect.objectContaining({ taskId, status: "open" }));

    const firstOrderBody = orderResponse.body;
    const firstTimelineBody = timelineResponse.body;
    const firstProofBody = proofResponse.body;
    const firstTasksBody = tasksResponse.body;
    await store.resetFromEvents({ deploymentBlock: 0n, events: [] });
    await store.resetFromEvents({ deploymentBlock: 0n, events });

    await expect(router.handle({ method: "GET", pathname: `/product/orders/${stateMachineOrderId}` }))
      .resolves.toMatchObject({ body: firstOrderBody });
    await expect(router.handle({ method: "GET", pathname: `/product/orders/${stateMachineOrderId}/timeline` }))
      .resolves.toMatchObject({ body: firstTimelineBody });
    await expect(router.handle({ method: "GET", pathname: `/product/orders/${stateMachineOrderId}/proof` }))
      .resolves.toMatchObject({ body: firstProofBody });
    await expect(router.handle({ method: "GET", pathname: "/product/tasks", query: { orderId: stateMachineOrderId } }))
      .resolves.toMatchObject({ body: firstTasksBody });
  });

  it("marks HookReady task submitted when a matching signal is projected", async () => {
    const store = new MemoryProjectionStore();
    await store.resetFromEvents({ deploymentBlock: 0n, events: stateMachineProductEvents({ includeMatchingSignal: true }) });
    const taskId = `${contractAddress}:${stateMachineOrderId}:${hookId}`;

    const taskResponse = await createApiRouter(store).handle({ method: "GET", pathname: `/product/tasks/${taskId}` });

    expect(taskResponse.status).toBe(200);
    expect((taskResponse.body as { task: { status: string; chainStatus: string; submittedSignalTxHash: string } }).task)
      .toMatchObject({
        status: "submitted",
        chainStatus: "submitted",
        submittedSignalTxHash: txHash(8n)
      });
  });

  it("projects executor activation and resource patch manifests into Product order/task proof", async () => {
    const executorPatchHash = bytes32Hex("9201");
    const resourcePatchHash = bytes32Hex("9202");
    const resourceKey = bytes32Text("customs-manifest");
    const resourceManifestHash = bytes32Hex("9203");
    const resourcePolicyHash = bytes32Hex("9204");
    const store = new MemoryProjectionStore();
    await store.resetFromEvents({
      deploymentBlock: 0n,
      events: [
        ...stateMachineProductEvents(),
        chainEvent(8n, "StageExecutorPatchApplied", {
          orderId: stateMachineOrderId,
          selectorStageId,
          targetStageId: stageId,
          selector: submitter,
          executor: overlayExecutor,
          role: bytes32Text("customs-executor"),
          executorMetadataHash: metadataHash,
          patchHash: executorPatchHash,
          patchNonce: 1n,
          metadataURI: "ipfs://stage-executor/customs-1"
        }),
        chainEvent(9n, "StageExecutorActivated", {
          orderId: stateMachineOrderId,
          targetStageId: stageId,
          executor: overlayExecutor,
          role: bytes32Text("customs-executor"),
          metadataHash,
          patchNonce: 1n
        }),
        chainEvent(10n, "StageResourcePatchApplied", {
          orderId: stateMachineOrderId,
          selectorStageId,
          targetStageId: stageId,
          resourceKey,
          selector: submitter,
          manifestHash: resourceManifestHash,
          policyHash: resourcePolicyHash,
          patchHash: resourcePatchHash,
          patchNonce: 1n,
          manifestURI: "ipfs://resource-manifests/customs-1"
        })
      ]
    });
    const router = createApiRouter(store);
    const taskId = `${contractAddress}:${stateMachineOrderId}:${hookId}`;

    const taskResponse = await router.handle({ method: "GET", pathname: `/product/tasks/${taskId}` });
    const orderResponse = await router.handle({ method: "GET", pathname: `/product/orders/${stateMachineOrderId}` });
    const proofResponse = await router.handle({ method: "GET", pathname: `/product/orders/${stateMachineOrderId}/proof` });
    const timelineResponse = await router.handle({ method: "GET", pathname: `/product/orders/${stateMachineOrderId}/timeline` });

    expect(taskResponse.status).toBe(200);
    expect((taskResponse.body as { task: Record<string, unknown> }).task).toMatchObject({
      assigneeWallet: overlayExecutor,
      participantWallet: overlayExecutor,
      stageExecutorOverlay: expect.objectContaining({
        targetStageId: stageId,
        activeExecutorWallet: overlayExecutor,
        patchNonce: "1"
      }),
      executorOverlay: expect.objectContaining({
        targetStageId: stageId,
        activeExecutorWallet: overlayExecutor,
        patchNonce: "1"
      }),
      resourceRequirements: [
        expect.objectContaining({
          resourceKey,
          manifestURI: "ipfs://resource-manifests/customs-1",
          manifestHash: resourceManifestHash,
          manifest: expect.objectContaining({ policyHash: resourcePolicyHash }),
          accessPolicy: expect.objectContaining({ policyHash: resourcePolicyHash }),
          sourcePatchHash: resourcePatchHash
        })
      ],
      stageResourceOverlays: [
        expect.objectContaining({
          resourceKey,
          manifestHash: resourceManifestHash,
          policyHash: resourcePolicyHash,
          patchNonce: "1"
        })
      ]
    });
    expect((orderResponse.body as { order: Record<string, unknown> }).order).toMatchObject({
      executorOverlays: {
        "export.customs": expect.objectContaining({
          activeExecutorWallet: overlayExecutor,
          patchNonce: "1"
        })
      },
      resourceRequirements: {
        "export.customs": [
          expect.objectContaining({
            manifestHash: resourceManifestHash,
            manifest: expect.objectContaining({ policyHash: resourcePolicyHash }),
            accessPolicy: expect.objectContaining({ policyHash: resourcePolicyHash }),
            sourcePatchHash: resourcePatchHash
          })
        ]
      }
    });
    expect((proofResponse.body as { proof: Array<Record<string, unknown>> }).proof).toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventName: "StageExecutorActivated",
        targetStageId: stageId,
        activeExecutorWallet: overlayExecutor,
        patchNonce: "1",
        transactionHash: txHash(9n),
        blockNumber: "9"
      }),
      expect.objectContaining({
        eventName: "StageResourcePatchApplied",
        targetStageId: stageId,
        manifestHash: resourceManifestHash,
        policyHash: resourcePolicyHash,
        patchNonce: "1",
        transactionHash: txHash(10n),
        blockNumber: "10"
      })
    ]));
    expect((timelineResponse.body as { timeline: Array<{ eventName: string; proof: Record<string, unknown> }> }).timeline)
      .toContainEqual(expect.objectContaining({
        eventName: "StageResourcePatchApplied",
        proof: expect.objectContaining({
          manifestHash: resourceManifestHash,
          policyHash: resourcePolicyHash,
          patchNonce: "1"
        })
      }));
  });

  it("selects task plugins from explicit slot capability metadata for generic authorized roles", async () => {
    const store = new MemoryProjectionStore();
    await store.resetFromEvents({
      deploymentBlock: 0n,
      events: [
        ...stateMachineProductEvents(),
        chainEvent(8n, "SignalSubmitterAuthorized", {
          orderId: stateMachineOrderId,
          sourceId: stageId,
          signalId: hookName,
          submitter,
          role: bytes32Text("generic-executor"),
          metadataHash
        })
      ]
    });
    const taskId = `${contractAddress}:${stateMachineOrderId}:${hookId}`;

    const taskResponse = await createApiRouter(store).handle({ method: "GET", pathname: `/product/tasks/${taskId}` });

    expect(taskResponse.status).toBe(200);
    expect((taskResponse.body as { task: Record<string, unknown> }).task)
      .toMatchObject({
        assigneeRole: "链上授权执行方",
        assigneeWallet: submitter,
        performanceSlotId: "delivery",
        performanceSlotLabel: "交付履约者",
        businessPersonaLabels: ["报关行", "物流/货代"],
        participantRoleLabel: "物流/报关",
        primaryActionLabel: "确认报关完成",
        requiredEvidence: expect.arrayContaining(["报关单"]),
        requiredInputs: expect.arrayContaining([
          expect.objectContaining({ inputId: "customs-declaration", label: "报关单 PDF" })
        ]),
        capabilityPlugin: expect.objectContaining({
          source: "explicit",
          roleSlotId: "delivery",
          pluginKind: "delivery_update",
          primaryActionLabel: "确认报关完成"
        }),
        canSubmit: true
      });
  });

  it("does not change plugin selection when chain display labels change within explicit stage metadata", async () => {
    const shippingStageId = bytes32Text("shipping");
    const genericHookName = bytes32Text("generic-review");
    const store = new MemoryProjectionStore();
    await store.resetFromEvents({
      deploymentBlock: 0n,
      events: [
        ...stateMachineProductEvents({ taskStageId: shippingStageId, taskHookName: genericHookName }),
        chainEvent(8n, "SignalSubmitterAuthorized", {
          orderId: stateMachineOrderId,
          sourceId: shippingStageId,
          signalId: genericHookName,
          submitter,
          role: bytes32Text("role-without-delivery-text"),
          metadataHash
        })
      ]
    });
    const taskId = `${contractAddress}:${stateMachineOrderId}:${hookId}`;

    const taskResponse = await createApiRouter(store).handle({ method: "GET", pathname: `/product/tasks/${taskId}` });

    expect(taskResponse.status).toBe(200);
    expect((taskResponse.body as { task: Record<string, unknown> }).task)
      .toMatchObject({
        stageName: "shipping",
        hookName: "generic-review",
        performanceSlotId: "delivery",
        participantRoleLabel: "物流/报关",
        capabilityPlugin: expect.objectContaining({
          source: "explicit",
          pluginKind: "delivery_update"
        })
      });
  });

  it("blocks Product task submission instead of guessing when explicit slot metadata is missing", async () => {
    const unknownOfficialPlanId = bytes32Hex("0c01");
    const unknownOfficialPlanHash = bytes32Hex("0d01");
    const store = new MemoryProjectionStore();
    await store.resetFromEvents({
      deploymentBlock: 0n,
      events: [
        ...stateMachineProductEvents({
          planId: unknownOfficialPlanId,
          planHash: unknownOfficialPlanHash
        }),
        chainEvent(8n, "SignalSubmitterAuthorized", {
          orderId: stateMachineOrderId,
          sourceId: stageId,
          signalId: hookName,
          submitter,
          role: bytes32Text("customs-broker"),
          metadataHash
        })
      ]
    });
    const taskId = `${contractAddress}:${stateMachineOrderId}:${hookId}`;

    const taskResponse = await createApiRouter(store).handle({ method: "GET", pathname: `/product/tasks/${taskId}` });

    expect(taskResponse.status).toBe(200);
    const task = (taskResponse.body as { task: Record<string, unknown> }).task;
    expect(task).toMatchObject({
      status: "blocked",
      chainStatus: "ready",
      assigneeWallet: submitter,
      canSubmit: false,
      requiredEvidence: [],
      capabilityPlugin: expect.objectContaining({
        source: "missing"
      }),
      blockedReason: expect.stringContaining("不会根据阶段或角色文案猜测"),
      proof: expect.objectContaining({
        eventName: "HookReady"
      })
    });
    expect(task.primaryActionLabel).toBeUndefined();
  });

  it("uses durable Store Product Schema Bundle metadata for non-demo plan tasks", async () => {
    const storePlanId = bytes32Hex("0e01");
    const storePlanHash = bytes32Hex("0e02");
    const storeDraftStore = new MemoryStoreZhixuDraftStore();
    const productSchema: StoreProductSchemaDTO = {
      schemaVersion: "store-product-schema.v1",
      version: 1,
      zhixuId: "store-schema-plan",
      title: "Store schema plan",
      maintainer: "Store team",
      planId: storePlanId,
      planHash: storePlanHash,
      artifactHash: crossBorderPlanIds.artifactHash,
      roleSlots: [
        {
          slotId: "export.customs",
          title: "验收执行者",
          label: "检验/校验",
          duty: "按 Store schema 提交验收确认。",
          evidence: ["校验报告"],
          status: "required",
          tone: "info",
          required: true,
          performanceSlotLabel: "验收执行者",
          businessPersonaLabels: ["第三方检验方"],
          capabilityPlugins: [
            {
              pluginKind: "validation_confirm",
              source: "explicit",
              stageIds: ["export.customs"],
              title: "验收确认插件",
              summary: "由 Store Product Schema Bundle 显式维护。",
              primaryActionLabel: "确认校验通过",
              requiredEvidence: ["校验报告"]
            }
          ]
        }
      ],
      orderPermissionTable: [
        {
          permissionId: "export.customs#customs-review",
          roleSlotId: "export.customs",
          stageId: "export.customs",
          source: "customs-source",
          signalName: "customs-review",
          payloadPolicy: "required",
          requiredEvidence: ["校验报告"]
        }
      ],
      capabilityPlugins: [
        {
          pluginKind: "validation_confirm",
          source: "explicit",
          stageIds: ["export.customs"],
          title: "验收确认插件",
          summary: "由 Store Product Schema Bundle 显式维护。",
          primaryActionLabel: "确认校验通过",
          requiredEvidence: ["校验报告"]
        }
      ],
      businessPersonaLabels: ["第三方检验方"],
      stages: [
        {
          stageId: "export.customs",
          index: 0,
          name: "出口校验",
          evidence: ["校验报告"],
          ownerRole: "export.customs",
          status: "pending"
        }
      ],
      schemaHash: bytes32Hex("0e03"),
      validation: {
        ok: true,
        status: "explicit",
        issues: []
      },
      createdAt: "2026-04-30T00:00:00.000Z",
      updatedAt: "2026-04-30T00:00:00.000Z"
    };
    await storeDraftStore.createDraft({
      draftId: "store_schema_plan_draft",
      sourceKind: "zhixu_yaml",
      content: "apiVersion: uvp/v0\nkind: Zhixu\n",
      status: "compiled",
      zhixuId: "store-schema-plan",
      title: "Store schema plan",
      maintainer: "Store team",
      tags: [],
      compilePreview: {
        planId: storePlanId,
        planHash: storePlanHash,
        artifactHash: crossBorderPlanIds.artifactHash,
        canonicalArtifactHash: crossBorderPlanIds.artifactHash,
        stageCount: 1,
        roleSlotCount: 1,
        sourceCount: 1,
        signalCount: 1
      },
      productSchema,
      errors: [],
      createdAt: "2026-04-30T00:00:00.000Z",
      updatedAt: "2026-04-30T00:00:00.000Z"
    });
    const store = new MemoryProjectionStore();
    await store.resetFromEvents({
      deploymentBlock: 0n,
      events: [
        ...stateMachineProductEvents({
          planId: storePlanId,
          planHash: storePlanHash
        }),
        chainEvent(8n, "SignalSubmitterAuthorized", {
          orderId: stateMachineOrderId,
          sourceId: stageId,
          signalId: hookName,
          submitter,
          role: bytes32Text("neutral-executor"),
          metadataHash
        })
      ]
    });
    const taskId = `${contractAddress}:${stateMachineOrderId}:${hookId}`;

    const taskResponse = await createApiRouter(store, { storeZhixuDraftStore: storeDraftStore })
      .handle({ method: "GET", pathname: `/product/tasks/${taskId}` });

    expect(taskResponse.status).toBe(200);
    expect((taskResponse.body as { task: Record<string, unknown> }).task).toMatchObject({
      performanceSlotId: "export.customs",
      performanceSlotLabel: "验收执行者",
      businessPersonaLabels: ["第三方检验方"],
      primaryActionLabel: "确认校验通过",
      capabilityPlugin: expect.objectContaining({
        source: "explicit",
        pluginKind: "validation_confirm",
        roleSlotId: "export.customs"
      }),
      requiredEvidence: ["校验报告"],
      canSubmit: true
    });
  });

  it("serves participant-scoped task and order views for an accepted wallet", async () => {
    const store = new MemoryProjectionStore();
    await store.resetFromEvents({
      deploymentBlock: 0n,
      events: [
        ...stateMachineProductEvents(),
        chainEvent(8n, "SignalSubmitterAuthorized", {
          orderId: stateMachineOrderId,
          sourceId: stageId,
          signalId: hookName,
          submitter,
          role: bytes32Text("customs-broker"),
          metadataHash
        })
      ]
    });
    const router = createApiRouter(store);

    const meResponse = await router.handle({
      method: "GET",
      pathname: "/product/me",
      headers: { "x-uvp-wallet-address": submitter }
    });
    const tasksResponse = await router.handle({
      method: "GET",
      pathname: "/product/me/tasks",
      headers: { "x-uvp-wallet-address": submitter }
    });
    const unauthorizedResponse = await router.handle({
      method: "GET",
      pathname: "/product/me/tasks",
      headers: { "x-uvp-wallet-address": "0x0000000000000000000000000000000000000bad" }
    });

    expect(meResponse.status).toBe(200);
    expect((meResponse.body as { summary: { openTaskCount: number } }).summary.openTaskCount).toBe(1);
    expect(tasksResponse.status).toBe(200);
    expect((tasksResponse.body as { tasks: Array<Record<string, unknown>> }).tasks)
      .toContainEqual(expect.objectContaining({
        assigneeWallet: submitter,
        performanceSlotId: "delivery",
        performanceSlotLabel: "交付履约者",
        participantRoleLabel: "物流/报关",
        capabilityPlugin: expect.objectContaining({
          source: "explicit",
          roleSlotId: "delivery",
          pluginKind: "delivery_update"
        }),
        primaryActionLabel: "确认报关完成",
        canSubmit: true
      }));
    expect((unauthorizedResponse.body as { tasks: unknown[] }).tasks).toEqual([]);
  });

  it("uses accepted participant records for /product/me identity while filtering tasks by wallet authorization", async () => {
    const store = new MemoryProjectionStore();
    await store.resetFromEvents({
      deploymentBlock: 0n,
      events: [
        ...stateMachineProductEvents(),
        chainEvent(8n, "SignalSubmitterAuthorized", {
          orderId: stateMachineOrderId,
          sourceId: stageId,
          signalId: hookName,
          submitter,
          role: bytes32Text("customs-broker"),
          metadataHash
        })
      ]
    });
    const router = createApiRouter(store, { productBffStore: new MemoryProductBffStore() });
    const draftResponse = await router.handle({
      method: "POST",
      pathname: "/product/order-drafts",
      body: {
        zhixuId: CROSS_BORDER_ZHIXU_ID,
        title: "Accepted participant route",
        businessType: "parallel-export",
        totalAmount: "10000",
        currency: "USDC"
      }
    });
    const draft = (draftResponse.body as { draft: { draftId: string } }).draft;
    const inviteResponse = await router.handle({
      method: "POST",
      pathname: `/product/orders/${draft.draftId}/invites`,
      body: {
        roleSlotId: "delivery",
        contact: "delivery@example.com"
      }
    });
    const inviteId = (inviteResponse.body as { invite: { inviteId: string } }).invite.inviteId;
    await expect(router.handle({
      method: "POST",
      pathname: `/product/invites/${inviteId}/accept`,
      headers: { "x-uvp-wallet-address": submitter },
      body: {
        displayName: "Delivery Operator",
        walletAddress: submitter,
        contact: "delivery@example.com"
      }
    })).resolves.toMatchObject({ status: 200 });

    const tasksResponse = await router.handle({
      method: "GET",
      pathname: "/product/me/tasks",
      headers: { "x-uvp-wallet-address": submitter }
    });
    const wrongWalletResponse = await router.handle({
      method: "GET",
      pathname: "/product/me/tasks",
      headers: { "x-uvp-wallet-address": "0x0000000000000000000000000000000000000bad" }
    });

    expect(tasksResponse.status).toBe(200);
    expect(tasksResponse.body).toMatchObject({
      participant: {
        displayName: "Delivery Operator",
        source: "accepted_participant",
        roleLabels: expect.arrayContaining(["物流/报关"])
      },
      tasks: [
        expect.objectContaining({
          assigneeWallet: submitter,
          performanceSlotId: "delivery",
          participantRoleLabel: "物流/报关",
          capabilityPlugin: expect.objectContaining({
            roleSlotId: "delivery",
            pluginKind: "delivery_update",
            source: "explicit"
          }),
          canSubmit: true
        })
      ]
    });
    expect((wrongWalletResponse.body as { tasks: unknown[] }).tasks).toEqual([]);
  });

  it("does not serve demo order or task DTOs without indexed projection", async () => {
    const router = createApiRouter(new MemoryProjectionStore());

    const ordersResponse = await router.handle({
      method: "GET",
      pathname: "/product/orders"
    });
    const orderResponse = await router.handle({
      method: "GET",
      pathname: `/product/orders/${DEMO_ORDER_ID}`
    });
    const tasksResponse = await router.handle({
      method: "GET",
      pathname: "/product/tasks"
    });
    const taskResponse = await router.handle({
      method: "GET",
      pathname: `/product/tasks/${DEMO_TASK_ID}`
    });
    const timelineResponse = await router.handle({
      method: "GET",
      pathname: `/product/orders/${DEMO_ORDER_ID}/timeline`
    });
    const proofResponse = await router.handle({
      method: "GET",
      pathname: `/product/orders/${DEMO_ORDER_ID}/proof`
    });

    expect(ordersResponse.status).toBe(200);
    expect((ordersResponse.body as { orders: unknown[] }).orders).toEqual([]);
    expect(orderResponse.status).toBe(404);
    expect(tasksResponse.status).toBe(200);
    expect((tasksResponse.body as { tasks: unknown[] }).tasks).toEqual([]);
    expect(taskResponse.status).toBe(404);
    expect(timelineResponse.status).toBe(404);
    expect(proofResponse.status).toBe(404);
  });

  it("fails closed for production runtime even if demo and E2E controls are requested", async () => {
    const router = createApiRouter(new MemoryProjectionStore(), {
      productRuntimeEnvironment: "production",
      productDemoMode: true,
      productE2eControlsEnabled: true,
      evidenceService: createEvidenceService({
        storage: objectStorageWithUri("object://private-evidence/product-route-production"),
        runtimeEnvironment: "production"
      })
    });

    await expect(router.handle({
      method: "GET",
      pathname: "/product/zhixus",
      query: { fallback: "demo" }
    })).resolves.toEqual({
      status: 403,
      body: { error: "demo_mode_disabled" }
    });

  });

  it("overlays syncing state for Product API DTOs without changing chain facts", async () => {
    const store = new MemoryProjectionStore();
    await store.resetFromEvents({ deploymentBlock: 0n, events: stateMachineProductEvents() });
    const router = createApiRouter(store, { productE2eControlsEnabled: true });

    const beforeResponse = await router.handle({ method: "GET", pathname: `/product/orders/${stateMachineOrderId}` });
    await expect(router.handle({ method: "POST", pathname: "/product/e2e/controls/syncing" }))
      .resolves.toMatchObject({ status: 200, body: { syncState: "syncing" } });
    const syncingOrderResponse = await router.handle({ method: "GET", pathname: `/product/orders/${stateMachineOrderId}` });
    const syncingTasksResponse = await router.handle({ method: "GET", pathname: "/product/tasks", query: { orderId: stateMachineOrderId } });
    await expect(router.handle({ method: "DELETE", pathname: "/product/e2e/controls/syncing" }))
      .resolves.toMatchObject({ status: 200, body: { syncState: "ready" } });
    const afterResponse = await router.handle({ method: "GET", pathname: `/product/orders/${stateMachineOrderId}` });

    expect((syncingOrderResponse.body as { order: { statusLabel: string; currentTaskSummary: string } }).order)
      .toMatchObject({
        statusLabel: "同步中",
        currentTaskSummary: "提交已发出，订单页正在等待后端投影更新。"
      });
    expect((syncingTasksResponse.body as { tasks: Array<{ status: string; subtitle: string }> }).tasks[0])
      .toMatchObject({
        status: "blocked",
        subtitle: "同步中，待链上事件投影完成后继续处理。"
      });
    expect(afterResponse.body).toEqual(beforeResponse.body);
  });

  it("uses Product BFF trigger authorizations to reject unauthorized task prepares", async () => {
    const store = new MemoryProjectionStore();
    await store.resetFromEvents({ deploymentBlock: 0n, events: stateMachineProductEvents() });
    const productBffStore = new MemoryProductBffStore();
    const createdAt = "2026-04-29T00:00:00.000Z";
    await productBffStore.createRegistration({
      triggerId: "registration-auth-route",
      prepareId: "prepare-auth-route",
      draftId: "draft-auth-route",
      orderId: stateMachineOrderId as Hex,
      planId: crossBorderPlanIds.planId as Hex,
      planHash: crossBorderPlanIds.planHash as Hex,
      status: "confirmed",
      txHash: txHash(20n),
      sourceId: sourceId as Hex,
      signalId: signalId as Hex,
      triggerHookId: hookId as Hex,
      triggerStageId: stageId as Hex,
      submitter: submitter as Address,
      payloadHash,
      idempotencyKey,
      deadline: "1770000000",
      typedData: {},
      retryable: false,
      createdAt,
      updatedAt: createdAt,
      creator: "0x4444444444444444444444444444444444444444" as Address,
      authorizations: [{
        sourceId: stageId as Hex,
        signalId: hookName as Hex,
        submitter: submitter as Address,
        role: bytes32Text("customs") as Hex,
        metadataHash
      }],
      permissions: []
    });
    const evidenceService = createEvidenceService({
      storage: new InMemoryEvidenceStorage(),
      now: () => new Date(createdAt),
      evidenceIdFactory: () => "ev_product_auth"
    });
    const router = createApiRouter(store, { productBffStore, evidenceService });
    const taskId = `${contractAddress}:${stateMachineOrderId}:${hookId}`;
    const uploadResponse = await router.handle({
      method: "POST",
      pathname: "/product/evidence",
      headers: { "x-uvp-principal-id": "customs" },
      body: {
        orderId: stateMachineOrderId,
        taskId,
        stageIdentifier: "export.customs",
        documentType: "customs-declaration",
        textPayload: "customs declaration",
        metadata: { fields: { declarationNo: "CD-AUTH" } }
      }
    });
    const evidenceId = (uploadResponse.body as { evidence: { evidenceId: string } }).evidence.evidenceId;

    await expect(router.handle({
      method: "POST",
      pathname: `/product/tasks/${taskId}/prepare-submit`,
      headers: { "x-uvp-principal-id": "customs" },
      body: {
        evidenceIds: [evidenceId],
        walletAddress: "0x0000000000000000000000000000000000000bad",
        intent: "confirm_stage"
      }
    })).resolves.toMatchObject({
      status: 403,
      body: {
        error: "submitter_not_authorized"
      }
    });

    await expect(router.handle({
      method: "POST",
      pathname: `/product/tasks/${taskId}/prepare-submit`,
      headers: { "x-uvp-principal-id": "customs" },
      body: {
        evidenceIds: [evidenceId],
        walletAddress: submitter,
        intent: "confirm_stage"
      }
    })).resolves.toMatchObject({
      status: 201,
      body: {
        authorization: {
          source: "product_bff_trigger"
        }
      }
    });
  });

  it("returns typed product_storage_unavailable instead of opaque internal_server_error when database is unreachable", async () => {
    const { StorageUnavailableError } = await import("../src/storage/errors.js");
    const unavailableError = new StorageUnavailableError(
      "Postgres database is temporarily unavailable: Authentication timed out"
    );
    const store = new MemoryProjectionStore();
    store.getSyncState = () => { throw unavailableError; };
    store.listStateMachineOrders = () => { throw unavailableError; };
    store.listStateMachineTasks = () => { throw unavailableError; };

    const router = createApiRouter(store);

    // /product/tasks hits the store through productService.listTasks; verify it returns a typed error
    const tasksResponse = await router.handle({ method: "GET", pathname: "/product/tasks" });
    expect(tasksResponse.status).toBe(503);
    expect(tasksResponse.body).toMatchObject({
      error: "product_storage_unavailable",
      message: expect.stringContaining("temporarily unavailable"),
      retryable: true
    });

    // /product/orders should also return a typed error when the store is unavailable
    const ordersResponse = await router.handle({ method: "GET", pathname: "/product/orders" });
    expect(ordersResponse.status).toBe(503);
    expect(ordersResponse.body).toMatchObject({
      error: "product_storage_unavailable",
      retryable: true
    });
  });
});

function chainEvent(blockNumber: bigint, eventName: string, args: Record<string, unknown>): ChainEvent {
  return {
    chainId: 31337,
    contractAddress: contractAddress as Address,
    blockNumber,
    transactionHash: txHash(blockNumber),
    logIndex: 0,
    eventName,
    args
  };
}

interface ChainBackedOrder {
  readonly orderId: string;
  readonly planId: string;
  readonly planHash: string;
  readonly chainStatus: string;
  readonly currentStageId: string;
  readonly paymentConditionSummary: string;
  readonly confirmations: readonly unknown[];
  readonly conditions: readonly unknown[];
  readonly tasks: readonly unknown[];
  readonly projection: unknown;
}

function stateMachineProductEvents(options: {
  readonly includeMatchingSignal?: boolean;
  readonly taskStageId?: string;
  readonly taskHookName?: string;
  readonly planId?: string;
  readonly planHash?: string;
} = {}): readonly ChainEvent[] {
  const eventPlanId = options.planId ?? crossBorderPlanIds.planId;
  const eventPlanHash = options.planHash ?? crossBorderPlanIds.planHash;
  const eventTaskStageId = options.taskStageId ?? stageId;
  const eventTaskHookName = options.taskHookName ?? hookName;
  return [
    chainEvent(1n, "PlanRegistered", {
      planId: eventPlanId,
      planHash: eventPlanHash,
      hookCount: 1n
    }),
    chainEvent(2n, "SignalCapabilityRegistered", {
      planId: eventPlanId,
      stageId: eventTaskStageId,
      targetSourceId: eventTaskStageId,
      signalId: eventTaskHookName,
      targetOrderRelation: 0
    }),
    chainEvent(3n, "OrderRegistered", {
      orderId: stateMachineOrderId,
      planId: eventPlanId
    }),
    chainEvent(4n, "SignalSubmitted", {
      orderId: stateMachineOrderId,
      sourceId,
      signalId,
      payloadHash,
      idempotencyKey,
      submitter
    }),
    chainEvent(5n, "HookStatusChanged", {
      orderId: stateMachineOrderId,
      hookId,
      previousStatus: 0,
      newStatus: 1,
      dueAt: 123n
    }),
    chainEvent(6n, "HookStatusChanged", {
      orderId: stateMachineOrderId,
      hookId,
      previousStatus: 1,
      newStatus: 2,
      dueAt: 0n
    }),
    chainEvent(7n, "HookReady", {
      orderId: stateMachineOrderId,
      hookId,
      stageId: eventTaskStageId,
      hookName: eventTaskHookName
    }),
    ...(options.includeMatchingSignal
      ? [
          chainEvent(8n, "SignalSubmitted", {
            orderId: stateMachineOrderId,
            sourceId: hookId,
            signalId: bytes32Text("done"),
            payloadHash,
            idempotencyKey: "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
            submitter
          })
        ]
      : [])
  ];
}

function bytes32Text(value: string): string {
  return `0x${Buffer.from(value, "utf8").toString("hex").padEnd(64, "0")}`;
}

function objectStorageWithUri(storageURI: string): ObjectEvidenceStorage {
  const objects = new Map<string, Uint8Array>();
  return new ObjectEvidenceStorage({
    client: {
      async put(input) {
        const bytes = new Uint8Array(input.bytes);
        objects.set(storageURI, bytes);
        return {
          storageURI,
          size: bytes.byteLength
        };
      },
      async get(uri) {
        const bytes = objects.get(uri);
        return bytes ? new Uint8Array(bytes) : undefined;
      },
      async exists(uri) {
        return objects.has(uri);
      }
    }
  });
}

function txHash(blockNumber: bigint): `0x${string}` {
  return `0x${blockNumber.toString(16).padStart(64, "0")}`;
}

function routeTestWallet(index: number): `0x${string}` {
  return `0x${(index + 1).toString(16).padStart(40, "0")}`;
}

function bytes32Hex(suffix: string): `0x${string}` {
  return `0x${suffix.padStart(64, "0")}`;
}
