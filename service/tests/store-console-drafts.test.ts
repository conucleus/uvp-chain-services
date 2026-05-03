import { describe, expect, it, vi } from "vitest";
import {
  compileZhixuHookPlan,
  parseZhixuDefinition
} from "@uvp-eth/compiler";
import {
  ORDER_INITIAL_TRIGGER_PERMISSION_ID,
  ORDER_REGISTRAR_ROLE_SLOT_ID,
  type StoreProductSchemaDTO
} from "@uvp-eth/product-dto";
import {
  phase2CustomsInitialTriggerSource,
  phase2CustomsOnchainHookPlanArtifact,
  phase2CustomsRoleSlotIds,
  phase2CustomsSignalIds,
  phase2CustomsStageIds,
  phase2CustomsStoreProductSchema
} from "@uvp-eth/product-dto/fixtures";
import { createApiRouter } from "../src/api/routes.js";
import {
  createGovernanceService,
  type GovernanceChainAdapter,
  type GovernanceChainRequestDTO
} from "../src/governance/index.js";
import type { ChainEvent } from "../src/indexer/events.js";
import { MemoryProjectionStore } from "../src/storage/projection-store.js";
import type { Address, Hex } from "../src/shared/types.js";
import type {
  StoreCompilePreviewDTO,
  StoreZhixuDraftDTO,
  StoreZhixuDraftRecord,
  StoreZhixuDraftStore
} from "../src/store-console/zhixu-drafts.js";

const storeOperatorHeaders = {
  "x-uvp-store-operator-id": "operator-1",
  "x-uvp-store-operator-role": "store_operator"
};

const adminHeaders = {
  "x-uvp-admin-id": "admin-1",
  "x-uvp-admin-role": "admin"
};

const domainId = "0x0000000000000000000000000000000000000000000000000000000000005201" as Hex;
const registryAddress = "0x5555555555555555555555555555555555555555" as Address;
const attester = "0x2222222222222222222222222222222222222222" as Address;
const signer = "0x3333333333333333333333333333333333333333" as Address;
const txHash = "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" as Hex;

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
    - name: order
      stages:
        - name: intake
          source: buyer
          trigger: ["TRIGGER"]
          receiveSignals:
            TRIGGER: "::OUTSIDE"
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
          trigger: ["MISSING"]
          receiveSignals:
            TRIGGER: "::OUTSIDE"
`;

describe("Store Zhixu draft workflow", () => {
  it("imports a Zhixu draft without adding it to the public Product catalog", async () => {
    const router = createApiRouter(new MemoryProjectionStore());
    const draft = await importDraft(router);

    expect(draft).toMatchObject({
      status: "imported",
      title: "Imported demo",
      maintainer: "Store team"
    });
    expect(draft.compilePreview).toBeUndefined();

    await expect(router.handle({ method: "GET", pathname: "/product/zhixus" }))
      .resolves.toEqual({ status: 200, body: { zhixus: [] } });
    await expect(router.handle({ method: "GET", pathname: `/store/zhixu-drafts/${draft.draftId}` }))
      .resolves.toMatchObject({ status: 200, body: { draft: { draftId: draft.draftId, status: "imported" } } });
  });

  it("fails Store metadata writes closed when the draft store is unavailable", async () => {
    const router = createApiRouter(new MemoryProjectionStore(), {
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
    const router = createApiRouter(new MemoryProjectionStore());
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
      stageCount: 1,
      roleSlotCount: 1
    });

    const manifest = compileZhixuHookPlan(parseZhixuDefinition(validZhixuYaml, "store-draft.yaml"));
    const manifestDraft = await importDraft(router, {
      sourceKind: "hook_plan_manifest",
      content: JSON.stringify(manifest)
    });
    const manifestCompiled = await compileDraft(router, manifestDraft.draftId);

    expect(manifestCompiled.compilePreview).toEqual(first.compilePreview);
  });

  it("generates durable Product Schema Bundle and blocks inferred plugins before review", async () => {
    const router = createApiRouter(new MemoryProjectionStore());
    const draft = await importDraft(router);
    const compiled = await compileDraft(router, draft.draftId);
    const preview = requirePreview(compiled);

    const schemaResponse = await router.handle({
      method: "GET",
      pathname: `/store/zhixu-drafts/${draft.draftId}/product-schema`
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
      source: "legacy_inferred"
    });

    await expect(router.handle({
      method: "POST",
      pathname: `/store/zhixu-drafts/${draft.draftId}/submit-review`,
      headers: storeOperatorHeaders,
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
      pathname: `/store/product-schemas/${encodeURIComponent(preview.planId)}/${encodeURIComponent(preview.planHash)}`
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

  it("validates role-slot add-on manifests before Product Schema review", async () => {
    const router = createApiRouter(new MemoryProjectionStore());
    const draft = await importDraft(router);
    await compileDraft(router, draft.draftId);
    const schemaResponse = await router.handle({
      method: "GET",
      pathname: `/store/zhixu-drafts/${draft.draftId}/product-schema`
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

  it("accepts the PRD89 Phase 2 customs Product Schema fixture", async () => {
    const router = createApiRouter(new MemoryProjectionStore());
    const draft = await importPhase2CustomsDraft(router);
    const compiled = await compileDraft(router, draft.draftId);
    expect(compiled.compilePreview).toMatchObject({
      planId: phase2CustomsStoreProductSchema.planId,
      planHash: phase2CustomsStoreProductSchema.planHash,
      artifactHash: phase2CustomsStoreProductSchema.artifactHash,
      stageCount: 3,
      roleSlotCount: 2
    });

    const productSchema = await updateDraftProductSchema(router, draft.draftId, phase2CustomsStoreProductSchema);
    expect(productSchema.validation).toEqual({
      ok: true,
      status: "explicit",
      issues: [],
      checkedAt: productSchema.validation.checkedAt
    });
    expect(productSchema.roleSlots.map((slot) => slot.slotId)).toEqual([
      phase2CustomsRoleSlotIds.buyerSelector,
      phase2CustomsRoleSlotIds.buyerResourceController,
      phase2CustomsRoleSlotIds.customsExecutor
    ]);
    expect(productSchema.roleSlots.some((slot) => slot.slotId === ORDER_REGISTRAR_ROLE_SLOT_ID)).toBe(false);
    expect(productSchema.orderPermissionTable[0]).toMatchObject({
      permissionId: ORDER_INITIAL_TRIGGER_PERMISSION_ID,
      roleSlotId: ORDER_REGISTRAR_ROLE_SLOT_ID,
      source: phase2CustomsInitialTriggerSource,
      signalName: phase2CustomsSignalIds.orderRegistered
    });
    expect(productSchema.selectorBindings?.map((binding) => `${binding.selectorStageIdentifier}->${binding.targetStageIdentifier}`)).toEqual([
      `${phase2CustomsStageIds.buyerSelectCustomsExecutor}->${phase2CustomsStageIds.customsComplete}`,
      `${phase2CustomsStageIds.buyerPublishCustomsResources}->${phase2CustomsStageIds.customsComplete}`
    ]);
  });

  it("rejects PRD89 Phase 2 customs Product Schema negative cases", async () => {
    const router = createApiRouter(new MemoryProjectionStore());
    const draft = await importPhase2CustomsDraft(router);
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
          const slot = mutableRoleSlot(schema, phase2CustomsRoleSlotIds.buyerSelector);
          slot.addOnManifest.addOnKind = "customs_selector";
        }
      },
      {
        name: "missing manifest stage binding target",
        expectedCode: "addon_manifest_stage_not_bound",
        mutate(schema) {
          const slot = mutableRoleSlot(schema, phase2CustomsRoleSlotIds.buyerSelector);
          slot.addOnManifest.stageBindings = ["missing-stage"];
        }
      },
      {
        name: "action binding references an unrendered input",
        expectedCode: "addon_manifest_input_not_found",
        mutate(schema) {
          const slot = mutableRoleSlot(schema, phase2CustomsRoleSlotIds.buyerSelector);
          slot.addOnManifest.actions[0].inputBindings.executorWallet = "missing.executorWallet";
        }
      },
      {
        name: "selector misses executorMetadataHash",
        expectedCode: "addon_manifest_input_not_found",
        mutate(schema) {
          const slot = mutableRoleSlot(schema, phase2CustomsRoleSlotIds.buyerSelector);
          delete slot.addOnManifest.actions[0].inputBindings.executorMetadataHash;
        }
      },
      {
        name: "resource patch action uses writerWallet",
        expectedCode: "addon_manifest_invalid",
        mutate(schema) {
          const slot = mutableRoleSlot(schema, phase2CustomsRoleSlotIds.buyerResourceController);
          delete slot.addOnManifest.actions[0].inputBindings.selectorWallet;
          slot.addOnManifest.actions[0].inputBindings.writerWallet = "buyerResourceController.selectorWallet";
        }
      },
      {
        name: "resource patch action binds visibility as chain payload",
        expectedCode: "addon_manifest_invalid",
        mutate(schema) {
          const slot = mutableRoleSlot(schema, phase2CustomsRoleSlotIds.buyerResourceController);
          slot.addOnManifest.actions[0].inputBindings.visibility = "buyerResourceController.selectorWallet";
        }
      },
      {
        name: "executor-less target is not covered by exactly one selector",
        expectedCode: "stage_executor_selection_invalid",
        mutate(schema) {
          const slot = mutableRoleSlot(schema, phase2CustomsRoleSlotIds.buyerSelector);
          slot.addOnManifest.addOnKind = "resource_controller";
        }
      }
    ];

    for (const item of cases) {
      const schema = clonePhase2Schema();
      item.mutate(schema);
      const productSchema = await updateDraftProductSchema(router, draft.draftId, schema);
      expect(productSchema.validation.ok, item.name).toBe(false);
      expect(productSchema.validation.issues, item.name).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: item.expectedCode })
      ]));
    }
  });

  it("records compile failures and blocks review submission", async () => {
    const router = createApiRouter(new MemoryProjectionStore());
    const draft = await importDraft(router, { content: invalidZhixuYaml });
    const compiled = await compileDraft(router, draft.draftId);

    expect(compiled.status).toBe("compile_failed");
    expect(compiled.errors.length).toBeGreaterThan(0);

    await expect(router.handle({
      method: "POST",
      pathname: `/store/zhixu-drafts/${draft.draftId}/submit-review`,
      headers: storeOperatorHeaders,
      body: { status: "approved_for_broadcast" }
    })).resolves.toMatchObject({
      status: 409,
      body: { error: "compile_failed" }
    });
  });

  it("keeps approved review separate from active trust projection state", async () => {
    const router = createApiRouter(new MemoryProjectionStore());
    const draft = await importDraft(router);
    await compileDraft(router, draft.draftId);
    await confirmDraftProductSchema(router, draft.draftId);

    const reviewResponse = await router.handle({
      method: "POST",
      pathname: `/store/zhixu-drafts/${draft.draftId}/submit-review`,
      headers: storeOperatorHeaders,
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
    await expect(router.handle({ method: "GET", pathname: `/store/zhixu-drafts/${draft.draftId}` }))
      .resolves.toMatchObject({ status: 200, body: { draft: { status: "approved_for_broadcast" } } });
  });

  it("delegates attestation requests to governance and waits for PlanAttested projection before active", async () => {
    const requests: GovernanceChainRequestDTO[] = [];
    const adapter: GovernanceChainAdapter = {
      attestPlan: vi.fn(async (request) => {
        requests.push(request);
        return { status: "confirmed" as const, txHash, blockNumber: "7", signer, retryable: false, simulated: false };
      }),
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
    const store = new MemoryProjectionStore();
    const router = createApiRouter(store, {
      governanceService: createGovernanceService({
        adapter,
        now: () => new Date("2026-04-29T00:00:00Z")
      })
    });
    const draft = await approvedDraft(router);
    const preview = requirePreview(draft);

    const attestResponse = await router.handle({
      method: "POST",
      pathname: `/store/zhixu-drafts/${draft.draftId}/request-attestation`,
      headers: adminHeaders,
      body: {
        domainId,
        metadataURI: "https://store.example/zhixu/store-draft-demo",
        confirmation: {
          draftId: draft.draftId,
          domainId,
          planId: preview.planId,
          planHash: preview.planHash
        }
      }
    });

    expect(attestResponse.status).toBe(202);
    const body = attestResponse.body as {
      readonly draft: StoreZhixuDraftDTO;
      readonly attestation: {
        readonly request: {
          readonly domainId: Hex;
          readonly planId: Hex;
          readonly planHash: Hex;
          readonly artifactHash: Hex;
          readonly policyHash: Hex;
          readonly metadataHash: Hex;
          readonly metadataURI: string;
        };
      };
    };
    expect(body.draft.status).toBe("indexing");
    expect(body.attestation.request).toMatchObject({
      domainId,
      planId: preview.planId,
      planHash: preview.planHash,
      artifactHash: preview.artifactHash,
      policyHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
      metadataHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
      metadataURI: expect.any(String)
    });
    expect(adapter.attestPlan).toHaveBeenCalledOnce();
    expect(requests[0]).toMatchObject({ kind: "attestPlan", domainId, planId: preview.planId });

    await expect(router.handle({ method: "GET", pathname: `/store/zhixu-drafts/${draft.draftId}` }))
      .resolves.toMatchObject({ status: 200, body: { draft: { status: "indexing" } } });

    await store.resetFromEvents({
      deploymentBlock: 0n,
      events: [planAttestedEvent({
        planId: preview.planId as Hex,
        planHash: preview.planHash as Hex,
        artifactHash: preview.artifactHash as Hex,
        policyHash: body.attestation.request.policyHash,
        metadataHash: body.attestation.request.metadataHash,
        metadataURI: body.attestation.request.metadataURI
      })]
    });

    await expect(router.handle({ method: "GET", pathname: `/store/zhixu-drafts/${draft.draftId}` }))
      .resolves.toMatchObject({ status: 200, body: { draft: { status: "active" } } });
  });

  it("fails closed for attestation without valid governance admin headers", async () => {
    const router = createApiRouter(new MemoryProjectionStore());
    const draft = await approvedDraft(router);

    await expect(router.handle({
      method: "POST",
      pathname: `/store/zhixu-drafts/${draft.draftId}/request-attestation`,
      body: { domainId }
    })).resolves.toMatchObject({
      status: 401,
      body: { error: "store_identity_missing" }
    });

    await expect(router.handle({
      method: "POST",
      pathname: `/store/zhixu-drafts/${draft.draftId}/request-attestation`,
      headers: storeOperatorHeaders,
      body: { domainId }
    })).resolves.toMatchObject({
      status: 403,
      body: { error: "forbidden" }
    });

    await expect(router.handle({
      method: "POST",
      pathname: `/store/zhixu-drafts/${draft.draftId}/request-attestation`,
      headers: { "x-uvp-admin-id": "user-1", "x-uvp-admin-role": "participant" },
      body: { domainId }
    })).resolves.toMatchObject({
      status: 401,
      body: { error: "store_identity_missing" }
    });
  });
});

async function importDraft(
  router: ReturnType<typeof createApiRouter>,
  overrides: Partial<{
    readonly sourceKind: "zhixu_yaml" | "hook_plan_manifest";
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

async function importPhase2CustomsDraft(
  router: ReturnType<typeof createApiRouter>
): Promise<StoreZhixuDraftDTO> {
  return importDraft(router, {
    sourceKind: "hook_plan_manifest",
    content: JSON.stringify(phase2CustomsOnchainHookPlanArtifact)
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

function clonePhase2Schema(): StoreProductSchemaDTO {
  return JSON.parse(JSON.stringify(phase2CustomsStoreProductSchema)) as StoreProductSchemaDTO;
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
    pathname: `/store/zhixu-drafts/${draftId}/product-schema`
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

function planAttestedEvent(input: {
  readonly planId: Hex;
  readonly planHash: Hex;
  readonly artifactHash: Hex;
  readonly policyHash: Hex;
  readonly metadataHash: Hex;
  readonly metadataURI: string;
}): ChainEvent {
  return {
    chainId: 31337,
    contractAddress: registryAddress,
    blockNumber: 7n,
    transactionHash: txHash,
    logIndex: 0,
    eventName: "PlanAttested",
    args: {
      domainId,
      planId: input.planId,
      planHash: input.planHash,
      artifactHash: input.artifactHash,
      policyHash: input.policyHash,
      metadataHash: input.metadataHash,
      metadataURI: input.metadataURI,
      attester
    }
  };
}
