import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  compileZhixuOnchainHookPlan,
  parseZhixuDefinition,
  planIdForPublisher
} from "@uvp-eth/compiler";
import {
  type StoreProductSchemaDTO
} from "@uvp-eth/product-dto";
import { examplePlanIds } from "./fixtures/business/index.js";
import { createApiRouter } from "../src/api/routes.js";
import { createNotificationService, createSupplierNotificationProfileConfigService, MemorySupplierNotificationProfileConfigStore } from "../src/notifications/index.js";
import {
  createGovernanceService,
  type GovernanceChainAdapter,
  type GovernanceChainRequestDTO
} from "../src/governance/index.js";
import { createChainServicesStores, type ChainServicesStores } from "../src/storage/factory.js";
import { createPlanArtifactResolvers } from "../src/projection/plan-artifacts.js";
import { createPostgresTestDatabase } from "./postgres.js";
import type {
  StoreCompilePreviewDTO,
  StoreZhixuDraftDTO,
  StoreZhixuDraftRecord,
  StoreZhixuDraftStore
} from "../src/store/console/zhixu-drafts.js";

let stores: ChainServicesStores;

beforeAll(async () => {
  stores = createChainServicesStores({
    database: { url: await createPostgresTestDatabase(), migrationsAutoRun: true }
  });
});

afterAll(async () => {
  await stores.close();
});

function requiredRouterStores() {
  return {
    storeSupplierMetadataStore: stores.storeSupplierMetadataStore,
    storeEntityRegistrationStore: stores.storeEntityRegistrationStore,
    storeWalletSessionStore: stores.storeWalletSessionStore,
    storeDecorationStore: stores.storeDecorationStore,
    storePublisherDelegationStore: stores.storePublisherDelegationStore,
    identityDescriptorSnapshots: stores.identityDescriptorSnapshots,
    storeListingStore: stores.storeListingStore,
    storeJoinApplicationStore: stores.storeJoinApplicationStore,
    productBffStore: stores.productBffStore,
    orderStore: stores.orderStore,
    orderRequirementsStore: stores.orderRequirementsStore,
    evidenceMetadataStore: stores.evidenceMetadataStore,
    submissionStore: stores.submissionStore,
    governanceStore: stores.governanceStore,
    stageExecutorPatchStore: stores.stageExecutorPatchStore,
    stageResourcePatchStore: stores.stageResourcePatchStore,
    storeZhixuDraftStore: stores.storeZhixuDraftStore,
    storeZhixuVersionMetadataStore: stores.storeZhixuVersionMetadataStore,
    storeDockingSessionStore: stores.storeDockingSessionStore,
    storeAuditStore: stores.storeAuditStore,
    notificationService: createNotificationService({
      store: stores.projectionStore,
      supplierMetadataStore: stores.storeSupplierMetadataStore,
      deliveryStore: stores.notificationStateStore,
      participantReadStateStore: stores.notificationStateStore
    }),
    supplierNotificationConfigService: createSupplierNotificationProfileConfigService({
      store: new MemorySupplierNotificationProfileConfigStore()
    })
  };
}

const storeOperatorHeaders = {
  "x-uvp-store-operator-id": "operator-1",
  "x-uvp-store-operator-role": "store_operator",
  "x-uvp-store-dev-anchored-address": "0x1234567890123456789012345678901234567890"
};

const devAnchoredStoreAuth = {
  mode: "dev_headers" as const,
  roleClaim: "roles",
  principalClaim: "sub",
  clockToleranceSeconds: 60,
  walletSession: {
    enabled: true,
    operatorWallets: [],
    adminWallets: [],
    sessionTtlSeconds: 43200,
    challengeTtlSeconds: 300,
    devAnchoredAddressHeaderEnabled: true,
  },
};

const adminHeaders = {
  "x-uvp-admin-id": "admin-1",
  "x-uvp-admin-role": "admin",
  "x-uvp-store-dev-anchored-address": "0x1234567890123456789012345678901234567890"
};


const validZhixuYaml = `
apiVersion: uvp/v0
kind: Zhixu
metadata:
  name: store-draft-demo
  annotations:
    version: "1"
spec:
  platform:
    type: blockchain
    provider: eth
  nucleation:
    id: store-draft
  stages:
    - name: gate
      source: slot-a
      receiveSignals:
        START: "slot-a::gate.seed"
      sendSignals: [{ name: "ready" }, { name: "seed" }]
      executor:
        supplierType: organization
        supplierID: selector-ops
    - name: intake
      source: slot-a
      receiveSignals:
        START: "slot-a::gate.ready"
      sendSignals: [{ name: "cmp" }]
      executor:
        supplierType: organization
        supplierID: intake-ops
`;

const invalidZhixuYaml = `
apiVersion: uvp/v0
kind: Zhixu
metadata:
  name: broken-store-draft
spec:
  platform:
    type: blockchain
  nucleation:
    id: broken
  stages:
    - name: intake
      source: slot-a
`;

describe("Store Zhixu draft workflow", () => {
  it("draft/schema reads and writes fail closed without identity or anchor", async () => {
    const router = createApiRouter(stores.projectionStore, { ...requiredRouterStores(), productRuntimeEnvironment: "local", submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111", storeAuthConfig: devAnchoredStoreAuth });
    const draft = await importDraft(router);

    await expect(router.handle({
      method: "GET",
      pathname: `/store/zhixu-drafts/${draft.draftId}`
    })).resolves.toMatchObject({ status: 401, body: { error: "store_identity_missing" } });

    const unanchoredOperator = {
      "x-uvp-store-operator-id": "operator-no-anchor",
      "x-uvp-store-operator-role": "store_operator"
    };
    await expect(router.handle({
      method: "POST",
      pathname: "/store/zhixu-drafts/import",
      headers: unanchoredOperator,
      body: { sourceKind: "zhixu_yaml", content: validZhixuYaml }
    })).resolves.toMatchObject({
      status: 403,
      body: { error: "store_address_anchor_required" }
    });
  });

  it("zhixu submit-review is governance-admin gated, not operator level", async () => {
    const router = createApiRouter(stores.projectionStore, { ...requiredRouterStores(), productRuntimeEnvironment: "local", submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111", storeAuthConfig: devAnchoredStoreAuth });
    const draft = await importDraft(router);
    await compileDraft(router, draft.draftId);

    await expect(router.handle({
      method: "POST",
      pathname: `/store/zhixu-drafts/${draft.draftId}/submit-review`,
      headers: storeOperatorHeaders,
      body: { status: "approved_for_broadcast" }
    })).resolves.toMatchObject({
      status: 403,
      body: {
        error: "forbidden",
        requiredAccess: "governance_admin"
      }
    });
  });

  it("version activation confirmation cannot self-confirm via body claims", async () => {
    const store = stores.projectionStore;
    await store.resetFromEvents({
      deploymentBlock: 0n,
      events: [{
        chainId: 31337,
        contractAddress: "0x1111111111111111111111111111111111111111",
        blockNumber: 1n,
        transactionHash: ("0x" + "ab".repeat(32)) as import("../src/shared/types.js").Hex,
        logIndex: 0,
        eventName: "PlanRegistered",
        args: { planId: examplePlanIds.planId, planHash: examplePlanIds.planHash, hookCount: 1n }
      }]
    });
    const router = createApiRouter(store, { ...requiredRouterStores(), productRuntimeEnvironment: "local", submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111", storeAuthConfig: devAnchoredStoreAuth });
    const unregisteredPlanId = "0x" + "99".repeat(32);
    const unregisteredPlanHash = "0x" + "88".repeat(32);

    await expect(router.handle({
      method: "POST",
      pathname: `/store/zhixu-series/series-x/versions/v-x/activate`,
      headers: adminHeaders,
      body: {
        planId: unregisteredPlanId,
        planHash: unregisteredPlanHash,
        confirmation: { versionId: "v-x", planId: unregisteredPlanId, planHash: unregisteredPlanHash }
      }
    })).resolves.toMatchObject({
      status: 400,
      body: { error: "store_confirmation_mismatch" }
    });

    const activated = await router.handle({
      method: "POST",
      pathname: `/store/zhixu-series/series-x/versions/v-ok/activate`,
      headers: adminHeaders,
      body: {
        planId: examplePlanIds.planId,
        planHash: examplePlanIds.planHash,
        confirmation: { versionId: "v-ok", planId: examplePlanIds.planId, planHash: examplePlanIds.planHash }
      }
    });
    expect(activated.status, JSON.stringify(activated.body)).toBe(200);
  });

  it("imports a Zhixu draft without adding it to the public Product catalog", async () => {
    const router = createApiRouter(stores.projectionStore, { ...requiredRouterStores(), productRuntimeEnvironment: "local", submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111", storeAuthConfig: devAnchoredStoreAuth });
    const draft = await importDraft(router);

    expect(draft).toMatchObject({
      status: "imported",
      title: "Imported demo",
      maintainer: "Store team"
    });
    expect(draft.compilePreview).toBeUndefined();

    const catalog = await router.handle({ method: "GET", pathname: "/product/zhixus" });
    expect((catalog.body as { zhixus: Array<{ zhixuId: string }> }).zhixus)
      .not.toContainEqual(expect.objectContaining({ zhixuId: "store-draft-demo" }));
    await expect(router.handle({ method: "GET", pathname: `/store/zhixu-drafts/${draft.draftId}`, headers: storeOperatorHeaders }))
      .resolves.toMatchObject({ status: 200, body: { draft: { draftId: draft.draftId, status: "imported" } } });
  });

  it("exposes publish metadata for a compiled draft", async () => {
    const router = createApiRouter(stores.projectionStore, { ...requiredRouterStores(), productRuntimeEnvironment: "local", submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111", storeAuthConfig: devAnchoredStoreAuth });
    const draft = await importDraft(router);
    await compileDraft(router, draft.draftId);
    const response = await router.handle({
      method: "GET",
      pathname: `/store/zhixu-drafts/${draft.draftId}/publish-metadata`,
      headers: storeOperatorHeaders
    });
    expect(response.status).toBe(200);
    expect((response.body as { publishMetadata: Record<string, unknown> }).publishMetadata).toMatchObject({
      schema: "uvp.order-config-publish/v3",
      planId: expect.stringMatching(/^0x[0-9a-f]{64}$/),
      planHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
      configId: expect.any(String),
      version: expect.any(String)
    });
  });

  it("fails Store metadata writes closed when the draft store is unavailable", async () => {
    const router = createApiRouter(stores.projectionStore, { ...requiredRouterStores(), productRuntimeEnvironment: "local", submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111", storeAuthConfig: devAnchoredStoreAuth,
      storeZhixuDraftStore: new FailingStoreZhixuDraftStore()
    });

    const response = await router.handle({
      method: "POST",
      pathname: "/store/zhixu-drafts/import",
      headers: storeOperatorHeaders,
      body: {
        sourceKind: "zhixu_yaml",
        content: validZhixuYaml,
        title: "Unavailable metadata",
        maintainer: "Store team"
      }
    });

    expect(response).toEqual({
      status: 503,
      body: {
        error: "store_metadata_unavailable",
        message: "Store metadata unavailable: draft store offline"
      }
    });
  });

  it("produces deterministic compile previews for DSL and manifest imports", async () => {
    const router = createApiRouter(stores.projectionStore, { ...requiredRouterStores(), productRuntimeEnvironment: "local", submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111", storeAuthConfig: devAnchoredStoreAuth });
    const yamlDraft = await importDraft(router);
    const first = await compileDraft(router, yamlDraft.draftId);
    const second = await compileDraft(router, yamlDraft.draftId);

    expect(first.compilePreview).toEqual(second.compilePreview);
    expect(first.productSchema?.schemaHash).toBe(second.productSchema?.schemaHash);
    expect(first.compilePreview).toMatchObject({
      planId: expect.stringMatching(/^0x[0-9a-f]{64}$/),
      planHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
      artifactHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
      stageCount: 2,
      roleSlotCount: 2
    });

    const manifest = compileZhixuOnchainHookPlan(parseZhixuDefinition(validZhixuYaml, "store-draft.yaml"));
    const manifestDraft = await importDraft(router, {
      sourceKind: "onchain_hook_plan_manifest",
      content: JSON.stringify(manifest)
    });
    const manifestCompiled = await compileDraft(router, manifestDraft.draftId);

    const yamlPreview = first.compilePreview!;
    const manifestPreview = manifestCompiled.compilePreview!;
    const { planId: yamlPlanId, ...yamlRest } = yamlPreview;
    const { planId: manifestPlanId, ...manifestRest } = manifestPreview;
    expect(yamlRest).toEqual(manifestRest);
    expect(yamlPlanId).toBe(
      planIdForPublisher("0x1234567890123456789012345678901234567890" as `0x${string}`, yamlPreview.planHash as `0x${string}`)
    );
    expect(manifestPlanId).toBe(manifest.planId);
  });







  it("records the compiled plan artifact so the projection seam can resolve the plan vocabulary", async () => {
    const chainId = 84532;
    const router = createApiRouter(stores.projectionStore, {
      ...requiredRouterStores(),
      productRuntimeEnvironment: "local",
      submissionChainId: chainId,
      submissionVerifyingContract: "0x1111111111111111111111111111111111111111",
      storeAuthConfig: devAnchoredStoreAuth,
      recordPlanArtifact: (input) => stores.planArtifactStore.put({ chainId, ...input })
    });
    const draft = await importDraft(router);
    const compiled = await compileDraft(router, draft.draftId);
    const preview = compiled.compilePreview!;
    const resolvers = createPlanArtifactResolvers({ store: stores.planArtifactStore, chainId });

    const tables = await resolvers.resolvePlanCapabilityTables(
      preview.planId as `0x${string}`,
      preview.planHash as `0x${string}`
    );
    expect(tables.planId).toBe(preview.planId);
    expect(tables.signalCapabilities).toHaveLength(3);
  });

  it("records compile failures and blocks review submission", async () => {
    const router = createApiRouter(stores.projectionStore, { ...requiredRouterStores(), productRuntimeEnvironment: "local", submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111", storeAuthConfig: devAnchoredStoreAuth });
    const draft = await importDraft(router, { content: invalidZhixuYaml });
    const compiled = await compileDraft(router, draft.draftId);

    expect(compiled.status).toBe("compile_failed");
    expect(compiled.errors.length).toBeGreaterThan(0);

    await expect(router.handle({
      method: "POST",
      pathname: `/store/zhixu-drafts/${draft.draftId}/submit-review`,
      headers: adminHeaders,
      body: { status: "approved_for_broadcast" }
    })).resolves.toMatchObject({
      status: 409,
      body: { error: "compile_failed" }
    });
  });

  it("persists an approved Store review", async () => {
    const router = createApiRouter(stores.projectionStore, { ...requiredRouterStores(), productRuntimeEnvironment: "local", submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111", storeAuthConfig: devAnchoredStoreAuth });
    const draft = await importDraft(router);
    await compileDraft(router, draft.draftId);

    const reviewResponse = await router.handle({
      method: "POST",
      pathname: `/store/zhixu-drafts/${draft.draftId}/submit-review`,
      headers: adminHeaders,
      body: {
        status: "approved_for_broadcast",
        publicSummary: "Approved for Store broadcast."
      }
    });

    expect(reviewResponse.status).toBe(200);
    expect((reviewResponse.body as { draft: StoreZhixuDraftDTO }).draft).toMatchObject({
      status: "approved_for_broadcast",
      reviewId: expect.stringMatching(/^review_/)
    });
    await expect(router.handle({ method: "GET", pathname: `/store/zhixu-drafts/${draft.draftId}`, headers: storeOperatorHeaders }))
      .resolves.toMatchObject({ status: 200, body: { draft: { status: "approved_for_broadcast" } } });
  });

});

async function importDraft(
  router: ReturnType<typeof createApiRouter>,
  overrides: Partial<{
    readonly sourceKind: "zhixu_yaml" | "onchain_hook_plan_manifest";
    readonly content: string;
  }> = {}
): Promise<StoreZhixuDraftDTO> {
  const response = await router.handle({
    method: "POST",
    pathname: "/store/zhixu-drafts/import",
    headers: storeOperatorHeaders,
    body: {
      sourceKind: overrides.sourceKind ?? "zhixu_yaml",
      content: overrides.content ?? validZhixuYaml,
      title: "Imported demo",
      maintainer: "Store team",
      publicSummary: "Imported for Store review.",
      tags: ["store", "demo"]
    }
  });
  expect(response.status).toBe(201);
  return (response.body as { draft: StoreZhixuDraftDTO }).draft;
}

async function compileDraft(
  router: ReturnType<typeof createApiRouter>,
  draftId: string
): Promise<StoreZhixuDraftDTO> {
  const response = await router.handle({
    method: "POST",
    pathname: `/store/zhixu-drafts/${draftId}/compile-preview`,
    headers: storeOperatorHeaders
  });
  expect(response.status).toBe(200);
  return (response.body as { draft: StoreZhixuDraftDTO }).draft;
}

class FailingStoreZhixuDraftStore implements StoreZhixuDraftStore {
  async createDraft(): Promise<void> {
    throw new Error("Store metadata unavailable: draft store offline");
  }

  async getDraft(): Promise<StoreZhixuDraftRecord | undefined> {
    throw new Error("Store metadata unavailable: draft store offline");
  }

  async findProductSchemaByPlan(): Promise<StoreProductSchemaDTO | undefined> {
    throw new Error("Store metadata unavailable: draft store offline");
  }

  async updateDraft(): Promise<void> {
    throw new Error("Store metadata unavailable: draft store offline");
  }
}
