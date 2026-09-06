import { describe, expect, it, vi } from "vitest";
import {
  compileZhixuOnchainHookPlan,
  parseZhixuDefinition
} from "@uvp-eth/compiler";
import {
  type StoreProductSchemaDTO
} from "@uvp-eth/product-dto";
import {
  crossBorderPlanIds,
  customsInitialTriggerSource,
  customsOnchainHookPlanArtifact,
  customsRoleSlotIds,
  customsSignalIds,
  customsStageIds,
  customsStoreProductSchema
} from "@uvp-eth/product-dto/fixtures";
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
} from "../src/store-console/zhixu-drafts.js";

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
  uid: store-draft-demo-001
  annotations:
    version: "1"
spec:
  platform:
    type: blockchain
    provider: eth
  nucleation:
    id: store-draft
  taskPatterns:
    - name: selector
      stages:
        - name: gate
          source: buyer
          sendSignals: ["ready"]
          executor:
            supplierType: organization
            supplierID: selector-ops
    - name: order
      stages:
        - name: intake
          source: buyer
          receiveSignals:
            START: "buyer::selector.gate.ready"
          sendSignals: ["cmp"]
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
  taskPatterns:
    - name: order
      stages:
        - name: intake
          source: buyer
`;

describe("Store Zhixu draft workflow", () => {
  it("KEEP: draft/schema reads and writes fail closed without identity or anchor (G-38/G-39)", async () => {
    // 匿名读取草稿/完整 Product Schema 一律 401（DTO 含 compilePreview 与
    // 发布者创作资产）；无锚定地址的 operator 写操作 403（红线）。
    const router = createApiRouter(new MemoryProjectionStore(), { submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111", storeAuthConfig: devAnchoredStoreAuth });
    const draft = await importDraft(router);

    await expect(router.handle({
      method: "GET",
      pathname: `/store/zhixu-drafts/${draft.draftId}`
    })).resolves.toMatchObject({ status: 401, body: { error: "store_identity_missing" } });
    await expect(router.handle({
      method: "GET",
      pathname: `/store/zhixu-drafts/${draft.draftId}/product-schema`
    })).resolves.toMatchObject({ status: 401, body: { error: "store_identity_missing" } });
    await expect(router.handle({
      method: "GET",
      pathname: `/store/product-schemas/${encodeURIComponent("0x" + "11".repeat(32))}/${encodeURIComponent("0x" + "22".repeat(32))}`
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

  it("KEEP: zhixu submit-review is governance-admin gated, not operator level (G-37/L-2)", async () => {
    // submit-review 要求 governance_admin 能力 + 真实治理身份：
    // operator 级（即便锚定）被能力门禁拒绝；身份解析不再把
    // principalId/roles[0] 包装成 GovernancePrincipal。
    const router = createApiRouter(new MemoryProjectionStore(), { submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111", storeAuthConfig: devAnchoredStoreAuth });
    const draft = await importDraft(router);
    await compileDraft(router, draft.draftId);
    await confirmDraftProductSchema(router, draft.draftId);

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

  it("KEEP: version activation confirmation cannot self-confirm via body claims (CS-A3)", async () => {
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
    const router = createApiRouter(store, { submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111", storeAuthConfig: devAnchoredStoreAuth });
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
    const router = createApiRouter(new MemoryProjectionStore(), { submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111", storeAuthConfig: devAnchoredStoreAuth });
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

  it("fails Store metadata writes closed when the draft store is unavailable", async () => {
    const router = createApiRouter(new MemoryProjectionStore(), { submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111", storeAuthConfig: devAnchoredStoreAuth,
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
    const router = createApiRouter(new MemoryProjectionStore(), { submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111", storeAuthConfig: devAnchoredStoreAuth });
    const yamlDraft = await importDraft(router);
    const first = await compileDraft(router, yamlDraft.draftId);
    const second = await compileDraft(router, yamlDraft.draftId);

    expect(first.compilePreview).toEqual(second.compilePreview);
    expect(first.productSchema?.schemaHash).toBe(second.productSchema?.schemaHash);
    expect(first.compilePreview).toMatchObject({
      planId: expect.stringMatching(/^0x[0-9a-f]{64}$/),
      planHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
      artifactHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
      canonicalArtifactHash: first.compilePreview?.artifactHash,
      stageCount: 2,
      roleSlotCount: 2
    });

    const manifest = compileZhixuOnchainHookPlan(parseZhixuDefinition(validZhixuYaml, "store-draft.yaml"));
    const manifestDraft = await importDraft(router, {
      sourceKind: "onchain_hook_plan_manifest",
      content: JSON.stringify(manifest)
    });
    const manifestCompiled = await compileDraft(router, manifestDraft.draftId);

    expect(manifestCompiled.compilePreview).toEqual(first.compilePreview);
  });

  it("generates durable Product Schema Bundle and blocks inferred plugins before review", async () => {
    const router = createApiRouter(new MemoryProjectionStore(), { submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111", storeAuthConfig: devAnchoredStoreAuth });
    const draft = await importDraft(router);
    const compiled = await compileDraft(router, draft.draftId);
    const preview = requirePreview(compiled);

    const schemaResponse = await router.handle({
      method: "GET",
      pathname: `/store/zhixu-drafts/${draft.draftId}/product-schema`,
      headers: storeOperatorHeaders
    });
    expect(schemaResponse.status).toBe(200);
    const schema = (schemaResponse.body as { productSchema: StoreProductSchemaDTO }).productSchema;
    expect(schema).toMatchObject({
      planId: preview.planId,
      planHash: preview.planHash,
      artifactHash: preview.artifactHash,
      validation: {
        ok: false,
        status: "inferred"
      }
    });
    expect(schema.roleSlots[0]?.capabilityPlugins?.[0]).toMatchObject({
      source: "inferred"
    });

    await expect(router.handle({
      method: "POST",
      pathname: `/store/zhixu-drafts/${draft.draftId}/submit-review`,
      headers: adminHeaders,
      body: { status: "approved_for_broadcast" }
    })).resolves.toMatchObject({
      status: 409,
      body: {
        error: "product_schema_not_explicit",
        details: {
          ok: false,
          issues: expect.arrayContaining([
            expect.objectContaining({ code: "capability_plugin_not_explicit" })
          ])
        }
      }
    });

    const explicit = await confirmDraftProductSchema(router, draft.draftId);
    await expect(router.handle({
      method: "POST",
      pathname: `/store/zhixu-drafts/${draft.draftId}/product-schema/validate`
    })).resolves.toMatchObject({
      status: 200,
      body: {
        validation: { ok: true, status: "explicit", issues: [] }
      }
    });
    await expect(router.handle({
      method: "GET",
      pathname: `/store/product-schemas/${encodeURIComponent(preview.planId)}/${encodeURIComponent(preview.planHash)}`,
      headers: storeOperatorHeaders
    })).resolves.toMatchObject({
      status: 200,
      body: {
        productSchema: {
          schemaHash: explicit.schemaHash,
          validation: { ok: true }
        }
      }
    });
  });

  it("preserves publisher evidenceSpec on stages and capability plugins across schema rebuild (evidenceSpec passthrough)", async () => {
    // schema 是发布者拥有的不透明 JSON：从编译产物重建 schema 时，
    // stage / capability plugin 携带的 evidenceSpec 不得被静默丢掉。
    const router = createApiRouter(new MemoryProjectionStore(), { submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111", storeAuthConfig: devAnchoredStoreAuth });
    const draft = await importDraft(router);
    await compileDraft(router, draft.draftId);
    const schemaResponse = await router.handle({
      method: "GET",
      pathname: `/store/zhixu-drafts/${draft.draftId}/product-schema`,
      headers: storeOperatorHeaders
    });
    expect(schemaResponse.status).toBe(200);
    const schema = (schemaResponse.body as { productSchema: StoreProductSchemaDTO }).productSchema;
    const firstSlotId = schema.roleSlots[0]!.slotId;

    const stageEvidenceSpec = [
      {
        key: "stage-evidence",
        label: "阶段交付凭证",
        inputKind: "file",
        accept: ["application/pdf"],
        required: true
      }
    ];
    const pluginEvidenceSpec = [
      { key: "completed-at", label: "完成日期", inputKind: "date", required: true }
    ];
    const schemaWithEvidenceSpec = {
      ...schema,
      stages: schema.stages.map((stage) =>
        stage.stageId === firstSlotId
          ? { ...stage, evidenceSpec: stageEvidenceSpec }
          : stage
      ),
      roleSlots: schema.roleSlots.map((slot) =>
        slot.slotId === firstSlotId
          ? {
              ...slot,
              capabilityPlugins: (slot.capabilityPlugins ?? []).map((plugin) => ({
                ...plugin,
                source: "explicit" as const,
                evidenceSpec: pluginEvidenceSpec
              }))
            }
          : slot
      ),
      capabilityPlugins: schema.roleSlots.flatMap((slot) =>
        (slot.capabilityPlugins ?? []).map((plugin) => ({
          ...plugin,
          source: "explicit" as const,
          ...(slot.slotId === firstSlotId ? { evidenceSpec: pluginEvidenceSpec } : {})
        }))
      )
    } as StoreProductSchemaDTO;
    await updateDraftProductSchema(router, draft.draftId, schemaWithEvidenceSpec);

    // 重新 compile：schema 从编译产物重建，发布者 evidenceSpec 必须保留。
    const recompiled = await compileDraft(router, draft.draftId);
    const rebuilt = recompiled.productSchema;
    expect(rebuilt).toBeDefined();
    const rebuiltStage = rebuilt?.stages.find((stage) => stage.stageId === firstSlotId);
    expect((rebuiltStage as { evidenceSpec?: unknown } | undefined)?.evidenceSpec)
      .toEqual(stageEvidenceSpec);
    const rebuiltSlot = rebuilt?.roleSlots.find((slot) => slot.slotId === firstSlotId);
    expect(
      (rebuiltSlot?.capabilityPlugins?.[0] as { evidenceSpec?: unknown } | undefined)?.evidenceSpec
    ).toEqual(pluginEvidenceSpec);
    // add-on manifest 的 evidence 组件同样透传 evidenceSpec 供参与方页面渲染。
    const rebuiltComponent = rebuiltSlot?.addOnManifest?.pages
      .flatMap((page) => page.sections)
      .flatMap((section) => section.components)
      .find((component) => component.componentId === "evidence");
    expect((rebuiltComponent as { evidenceSpec?: unknown } | undefined)?.evidenceSpec)
      .toEqual(pluginEvidenceSpec);
  });

  it("validates role-slot add-on manifests before Product Schema review", async () => {
    const router = createApiRouter(new MemoryProjectionStore(), { submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111", storeAuthConfig: devAnchoredStoreAuth });
    const draft = await importDraft(router);
    await compileDraft(router, draft.draftId);
    const schemaResponse = await router.handle({
      method: "GET",
      pathname: `/store/zhixu-drafts/${draft.draftId}/product-schema`,
      headers: storeOperatorHeaders
    });
    expect(schemaResponse.status).toBe(200);
    const schema = (schemaResponse.body as { productSchema: StoreProductSchemaDTO }).productSchema;
    const roleSlots = schema.roleSlots.map((slot) => ({
      ...slot,
      capabilityPlugins: (slot.capabilityPlugins ?? []).map((plugin) => ({
        ...plugin,
        source: "explicit" as const
      }))
    }));
    const firstSlot = roleSlots[0];
    expect(firstSlot?.addOnManifest).toBeDefined();

    const cases = [
      {
        expectedCode: "addon_manifest_stage_not_bound",
        addOnManifest: {
          ...firstSlot!.addOnManifest!,
          stageBindings: []
        }
      },
      {
        expectedCode: "addon_manifest_input_not_found",
        addOnManifest: {
          ...firstSlot!.addOnManifest!,
          actions: firstSlot!.addOnManifest!.actions.map((action) => ({
            ...action,
            inputBindings: {
              ...action.inputBindings,
              evidenceIds: "missing-input"
            }
          }))
        }
      },
      {
        expectedCode: "addon_manifest_invalid",
        addOnManifest: {
          ...firstSlot!.addOnManifest!,
          actions: firstSlot!.addOnManifest!.actions.map((action) => ({
            ...action,
            actionKind: "unknown_action"
          }))
        }
      },
      {
        expectedCode: "addon_manifest_invalid",
        addOnManifest: {
          ...firstSlot!.addOnManifest!,
          pages: "not-an-array"
        }
      },
      {
        expectedCode: "addon_manifest_invalid",
        addOnManifest: {
          ...firstSlot!.addOnManifest!,
          actions: "not-an-array"
        }
      }
    ] as const;

    for (const item of cases) {
      const invalidRoleSlots = roleSlots.map((slot, index) => index === 0 ? {
        ...slot,
        addOnManifest: item.addOnManifest
      } : slot);
      const updateResponse = await router.handle({
        method: "PUT",
        pathname: `/store/zhixu-drafts/${draft.draftId}/product-schema`,
        headers: storeOperatorHeaders,
        body: {
          productSchema: {
            ...schema,
            roleSlots: invalidRoleSlots,
            capabilityPlugins: invalidRoleSlots.flatMap((slot) => slot.capabilityPlugins ?? [])
          }
        }
      });
      expect(updateResponse.status).toBe(200);
      expect((updateResponse.body as { productSchema: StoreProductSchemaDTO }).productSchema.validation).toMatchObject({
        ok: false,
        issues: expect.arrayContaining([
          expect.objectContaining({ code: item.expectedCode })
        ])
      });
    }
  });

  it("accepts the customs Product Schema fixture", async () => {
    const router = createApiRouter(new MemoryProjectionStore(), { submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111", storeAuthConfig: devAnchoredStoreAuth });
    const draft = await importCustomsDraft(router);
    const compiled = await compileDraft(router, draft.draftId);
    expect(compiled.compilePreview).toMatchObject({
      planId: customsStoreProductSchema.planId,
      planHash: customsStoreProductSchema.planHash,
      artifactHash: customsStoreProductSchema.artifactHash,
      stageCount: 3,
      roleSlotCount: 2
    });

    const productSchema = await updateDraftProductSchema(router, draft.draftId, customsStoreProductSchema);
    expect(productSchema.validation).toEqual({
      ok: true,
      status: "explicit",
      issues: [],
      checkedAt: productSchema.validation.checkedAt
    });
    expect(productSchema.roleSlots.map((slot) => slot.slotId)).toEqual([
      customsRoleSlotIds.buyerSelector,
      customsRoleSlotIds.buyerResourceController,
      customsRoleSlotIds.customsExecutor
    ]);
    expect(productSchema.roleSlots.some((slot) => slot.slotId.startsWith("system:"))).toBe(false);
    expect(productSchema.orderPermissionTable.some((entry) => entry.permissionId.startsWith("system."))).toBe(false);
    expect(productSchema.createOrderTrigger).toMatchObject({
      source: customsInitialTriggerSource,
      signalName: customsSignalIds.orderRegistered,
      triggerHookId: customsStoreProductSchema.createOrderTrigger?.triggerHookId,
      triggerStageId: customsStoreProductSchema.createOrderTrigger?.triggerStageId
    });
    expect(productSchema.selectorBindings?.map((binding) => `${binding.selectorStageIdentifier}->${binding.targetStageIdentifier}`)).toEqual([
      `${customsStageIds.buyerSelectCustomsExecutor}->${customsStageIds.customsComplete}`,
      `${customsStageIds.buyerPublishCustomsResources}->${customsStageIds.customsComplete}`
    ]);
  });

  it("rejects invalid customs Product Schema inputs", async () => {
    const router = createApiRouter(new MemoryProjectionStore(), { submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111", storeAuthConfig: devAnchoredStoreAuth });
    const draft = await importCustomsDraft(router);
    await compileDraft(router, draft.draftId);

    const cases: readonly {
      readonly name: string;
      readonly expectedCode: string;
      mutate(schema: StoreProductSchemaDTO): void;
    }[] = [
      {
        name: "unsupported addOnKind",
        expectedCode: "addon_manifest_invalid",
        mutate(schema) {
          const slot = mutableRoleSlot(schema, customsRoleSlotIds.buyerSelector);
          slot.addOnManifest.addOnKind = "customs_selector";
        }
      },
      {
        name: "missing manifest stage binding target",
        expectedCode: "addon_manifest_stage_not_bound",
        mutate(schema) {
          const slot = mutableRoleSlot(schema, customsRoleSlotIds.buyerSelector);
          slot.addOnManifest.stageBindings = ["missing-stage"];
        }
      },
      {
        name: "action binding references an unrendered input",
        expectedCode: "addon_manifest_input_not_found",
        mutate(schema) {
          const slot = mutableRoleSlot(schema, customsRoleSlotIds.buyerSelector);
          slot.addOnManifest.actions[0].inputBindings.executorWallet = "missing.executorWallet";
        }
      },
      {
        name: "selector misses executorMetadataHash",
        expectedCode: "addon_manifest_input_not_found",
        mutate(schema) {
          const slot = mutableRoleSlot(schema, customsRoleSlotIds.buyerSelector);
          delete slot.addOnManifest.actions[0].inputBindings.executorMetadataHash;
        }
      },
      {
        name: "resource patch action uses writerWallet",
        expectedCode: "addon_manifest_invalid",
        mutate(schema) {
          const slot = mutableRoleSlot(schema, customsRoleSlotIds.buyerResourceController);
          delete slot.addOnManifest.actions[0].inputBindings.selectorWallet;
          slot.addOnManifest.actions[0].inputBindings.writerWallet = "buyerResourceController.selectorWallet";
        }
      },
      {
        name: "resource patch action binds visibility as chain payload",
        expectedCode: "addon_manifest_invalid",
        mutate(schema) {
          const slot = mutableRoleSlot(schema, customsRoleSlotIds.buyerResourceController);
          slot.addOnManifest.actions[0].inputBindings.visibility = "buyerResourceController.selectorWallet";
        }
      },
      {
        name: "executor-less target is not covered by exactly one selector",
        expectedCode: "stage_executor_selection_invalid",
        mutate(schema) {
          const slot = mutableRoleSlot(schema, customsRoleSlotIds.buyerSelector);
          slot.addOnManifest.addOnKind = "resource_controller";
        }
      }
    ];

    for (const item of cases) {
      const schema = cloneCustomsSchema();
      item.mutate(schema);
      const productSchema = await updateDraftProductSchema(router, draft.draftId, schema);
      expect(productSchema.validation.ok, item.name).toBe(false);
      expect(productSchema.validation.issues, item.name).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: item.expectedCode })
      ]));
    }
  });

  it("records compile failures and blocks review submission", async () => {
    const router = createApiRouter(new MemoryProjectionStore(), { submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111", storeAuthConfig: devAnchoredStoreAuth });
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
    const router = createApiRouter(new MemoryProjectionStore(), { submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111", storeAuthConfig: devAnchoredStoreAuth });
    const draft = await importDraft(router);
    await compileDraft(router, draft.draftId);
    await confirmDraftProductSchema(router, draft.draftId);

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

async function importCustomsDraft(
  router: ReturnType<typeof createApiRouter>
): Promise<StoreZhixuDraftDTO> {
  return importDraft(router, {
    sourceKind: "onchain_hook_plan_manifest",
    content: JSON.stringify(customsOnchainHookPlanArtifact)
  });
}

async function updateDraftProductSchema(
  router: ReturnType<typeof createApiRouter>,
  draftId: string,
  productSchema: StoreProductSchemaDTO
): Promise<StoreProductSchemaDTO> {
  const updateResponse = await router.handle({
    method: "PUT",
    pathname: `/store/zhixu-drafts/${draftId}/product-schema`,
    headers: storeOperatorHeaders,
    body: { productSchema }
  });
  expect(updateResponse.status).toBe(200);
  return (updateResponse.body as { productSchema: StoreProductSchemaDTO }).productSchema;
}

function cloneCustomsSchema(): StoreProductSchemaDTO {
  return JSON.parse(JSON.stringify(customsStoreProductSchema)) as StoreProductSchemaDTO;
}

function mutableRoleSlot(schema: StoreProductSchemaDTO, slotId: string): any {
  const slot = schema.roleSlots.find((item) => item.slotId === slotId);
  expect(slot).toBeDefined();
  return slot as any;
}

async function approvedDraft(router: ReturnType<typeof createApiRouter>): Promise<StoreZhixuDraftDTO> {
  const draft = await importDraft(router);
  const compiled = await compileDraft(router, draft.draftId);
  await confirmDraftProductSchema(router, draft.draftId);
  const response = await router.handle({
    method: "POST",
    pathname: `/store/zhixu-drafts/${draft.draftId}/submit-review`,
    headers: storeOperatorHeaders,
    body: {
      status: "approved_for_broadcast",
      publicSummary: "Approved for broadcast."
    }
  });
  expect(response.status).toBe(200);
  return {
    ...compiled,
    ...(response.body as { draft: StoreZhixuDraftDTO }).draft
  };
}

async function confirmDraftProductSchema(
  router: ReturnType<typeof createApiRouter>,
  draftId: string
): Promise<StoreProductSchemaDTO> {
  const schemaResponse = await router.handle({
    method: "GET",
    pathname: `/store/zhixu-drafts/${draftId}/product-schema`,
    headers: storeOperatorHeaders
  });
  expect(schemaResponse.status).toBe(200);
  const schema = (schemaResponse.body as { productSchema: StoreProductSchemaDTO }).productSchema;
  const roleSlots = schema.roleSlots.map((slot) => ({
    ...slot,
    capabilityPlugins: (slot.capabilityPlugins ?? []).map((plugin) => ({
      ...plugin,
      source: "explicit" as const
    }))
  }));
  const explicitSchema: StoreProductSchemaDTO = {
    ...schema,
    roleSlots,
    capabilityPlugins: roleSlots.flatMap((slot) => slot.capabilityPlugins ?? [])
  };
  const updateResponse = await router.handle({
    method: "PUT",
    pathname: `/store/zhixu-drafts/${draftId}/product-schema`,
    headers: storeOperatorHeaders,
    body: { productSchema: explicitSchema }
  });
  expect(updateResponse.status).toBe(200);
  const productSchema = (updateResponse.body as { productSchema: StoreProductSchemaDTO }).productSchema;
  expect(productSchema.validation).toMatchObject({ ok: true, status: "explicit" });
  return productSchema;
}

function requirePreview(draft: StoreZhixuDraftDTO): StoreCompilePreviewDTO {
  expect(draft.compilePreview).toBeDefined();
  return draft.compilePreview!;
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
