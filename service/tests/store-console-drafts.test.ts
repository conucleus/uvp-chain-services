import { describe, expect, it, vi } from "vitest";
import {
  compileZhixuOnchainHookPlan,
  parseZhixuDefinition,
  planIdForPublisher
} from "@uvp-eth/compiler";
import {
  type StoreProductSchemaDTO
} from "@uvp-eth/product-dto";
import { crossBorderPlanIds } from "@uvp-eth/product-dto/fixtures";
import { createApiRouter } from "../src/api/routes.js";
import {
  createGovernanceService,
  type GovernanceChainAdapter,
  type GovernanceChainRequestDTO
} from "../src/governance/index.js";
import { MemoryProjectionStore } from "../src/storage/projection-store.js";
import type {
  StoreCompilePreviewDTO,
  StoreZhixuDraftDTO,
  StoreZhixuDraftRecord,
  StoreZhixuDraftStore
} from "../src/store/console/zhixu-drafts.js";

const storeOperatorHeaders = {
  "x-uvp-store-operator-id": "operator-1",
  "x-uvp-store-operator-role": "store_operator",
  // 红线：草稿流程写操作要求会话已锚定地址（本地联调 dev 锚定头）。
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
      source: buyer
      # 自发种子入口（uvp-core 物化门：零 hook 阶段永不可物化，其
      # sendSignals 无钩子可挂，编译器拒绝该形状）。
      receiveSignals:
        START: "buyer::gate.seed"
      sendSignals: [{ name: "ready" }, { name: "seed" }]
      executor:
        supplierType: organization
        supplierID: selector-ops
    - name: intake
      source: buyer
      receiveSignals:
        START: "buyer::gate.ready"
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
      source: buyer
`;

describe("Store Zhixu draft workflow", () => {
  it("draft/schema reads and writes fail closed without identity or anchor", async () => {
    // 匿名读取草稿/完整 Product Schema 一律 401（DTO 含 compilePreview 与
    // 发布者创作资产）；无锚定地址的 operator 写操作 403（红线）。
    const router = createApiRouter(new MemoryProjectionStore(), { productRuntimeEnvironment: "local", submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111", storeAuthConfig: devAnchoredStoreAuth });
    const draft = await importDraft(router);

    await expect(router.handle({
      method: "GET",
      pathname: `/store/zhixu-drafts/${draft.draftId}`
    })).resolves.toMatchObject({ status: 401, body: { error: "store_identity_missing" } });

    // 能力通过但会话未锚定地址：写路由 403 store_address_anchor_required。
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
    // submit-review 要求 governance_admin 能力 + 真实治理身份：
    // operator 级（即便锚定）被能力门禁拒绝；身份解析不再把
    // principalId/roles[0] 包装成 GovernancePrincipal。
    const router = createApiRouter(new MemoryProjectionStore(), { productRuntimeEnvironment: "local", submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111", storeAuthConfig: devAnchoredStoreAuth });
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
        requiredCapability: "store.draft.review",
        requiredAccess: "governance_admin"
      }
    });
  });

  it("version activation confirmation cannot self-confirm via body claims", async () => {
    // 期望锚只取服务端可证明的值（版本记录或链投影）；自报 planId 与
    // confirmation.planId 自我印证、但锚未上链/未注册 → 400 mismatch。
    const store = new MemoryProjectionStore();
    await store.resetFromEvents({
      deploymentBlock: 0n,
      events: [{
        chainId: 31337,
        contractAddress: "0x1111111111111111111111111111111111111111",
        blockNumber: 1n,
        transactionHash: ("0x" + "ab".repeat(32)) as import("../src/shared/types.js").Hex,
        logIndex: 0,
        eventName: "PlanRegistered",
        args: { planId: crossBorderPlanIds.planId, planHash: crossBorderPlanIds.planHash, hookCount: 1n }
      }]
    });
    const router = createApiRouter(store, { productRuntimeEnvironment: "local", submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111", storeAuthConfig: devAnchoredStoreAuth });
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

    // 与投影一致的锚 + 正确 confirmation 可通过（期望值经投影证明）。
    const activated = await router.handle({
      method: "POST",
      pathname: `/store/zhixu-series/series-x/versions/v-ok/activate`,
      headers: adminHeaders,
      body: {
        planId: crossBorderPlanIds.planId,
        planHash: crossBorderPlanIds.planHash,
        confirmation: { versionId: "v-ok", planId: crossBorderPlanIds.planId, planHash: crossBorderPlanIds.planHash }
      }
    });
    expect(activated.status, JSON.stringify(activated.body)).toBe(200);
  });

  it("imports a Zhixu draft without adding it to the public Product catalog", async () => {
    const router = createApiRouter(new MemoryProjectionStore(), { productRuntimeEnvironment: "local", submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111", storeAuthConfig: devAnchoredStoreAuth });
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

  it("exposes V3 publish metadata for a compiled draft", async () => {
    const router = createApiRouter(new MemoryProjectionStore(), { productRuntimeEnvironment: "local", submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111", storeAuthConfig: devAnchoredStoreAuth });
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
    const router = createApiRouter(new MemoryProjectionStore(), { productRuntimeEnvironment: "local", submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111", storeAuthConfig: devAnchoredStoreAuth,
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
    const router = createApiRouter(new MemoryProjectionStore(), { productRuntimeEnvironment: "local", submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111", storeAuthConfig: devAnchoredStoreAuth });
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







  it("records compile failures and blocks review submission", async () => {
    const router = createApiRouter(new MemoryProjectionStore(), { productRuntimeEnvironment: "local", submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111", storeAuthConfig: devAnchoredStoreAuth });
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
    const router = createApiRouter(new MemoryProjectionStore(), { productRuntimeEnvironment: "local", submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111", storeAuthConfig: devAnchoredStoreAuth });
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
