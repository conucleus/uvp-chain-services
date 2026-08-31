import { randomUUID } from "node:crypto";
import {
  assertOnchainHookPlanArtifact,
  compileZhixuOnchainHookPlan,
  hashCanonical,
  parseZhixuDefinition,
  type OnchainHookPlanArtifact,
  type OnchainSignalInstruction
} from "@uvp-eth/compiler";
import {
  type FulfillmentPluginKind,
  type OrderPermissionTableEntryDTO,
  type ParticipantAddOnKind,
  type ParticipantAddOnManifestActionDTO,
  type ParticipantAddOnManifestComponentDTO,
  type ParticipantAddOnManifestDTO,
  type RoleSlotDTO,
  type SlotCapabilityPluginDTO,
  type StoreProductSchemaDTO,
  type StoreProductSchemaSelectorBindingDTO,
  type StoreProductSchemaValidationDTO,
  type StoreProductSchemaValidationIssueDTO,
  type ZhixuStageDTO
} from "@uvp-eth/product-dto";
import type {
  GovernancePrincipal,
  GovernanceReviewResultDTO,
  GovernanceReviewStatus,
  GovernanceService
} from "../governance/index.js";
import type { ProjectionStore } from "../storage/projection-store.js";

export type StoreZhixuDraftSourceKind = "zhixu_yaml" | "onchain_hook_plan_manifest";

export type StoreZhixuDraftStatus =
  | "imported"
  | "compile_failed"
  | "compiled"
  | "submitted_for_review"
  | "approved_for_broadcast"
  | "active"
  | "rejected"
  | "revoked";

export interface StoreZhixuImportRequestDTO {
  readonly sourceKind: StoreZhixuDraftSourceKind;
  readonly content: string;
  readonly title?: string;
  readonly maintainer?: string;
  readonly publicSummary?: string;
  readonly tags?: readonly string[];
}

export interface StoreDraftErrorDTO {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

export interface StoreCompilePreviewDTO {
  readonly planId: string;
  readonly planHash: string;
  readonly artifactHash: string;
  readonly stageCount: number;
  readonly roleSlotCount: number;
  readonly sourceCount: number;
  readonly signalCount: number;
  readonly canonicalArtifactHash: string;
}

export interface StoreZhixuDraftDTO {
  readonly draftId: string;
  readonly status: StoreZhixuDraftStatus;
  readonly zhixuId?: string;
  readonly title: string;
  readonly maintainer: string;
  readonly compilePreview?: StoreCompilePreviewDTO;
  readonly productSchema?: StoreProductSchemaDTO;
  readonly reviewId?: string;
  readonly errors: readonly StoreDraftErrorDTO[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface StoreZhixuDraftRecord extends StoreZhixuDraftDTO {
  readonly sourceKind: StoreZhixuDraftSourceKind;
  readonly content: string;
  readonly publicSummary?: string;
  readonly tags: readonly string[];
  readonly reviewStatus?: GovernanceReviewStatus;
}

export interface SubmitStoreZhixuReviewInput {
  readonly status?: GovernanceReviewStatus;
  readonly riskLevel?: string;
  readonly riskTags?: readonly string[];
  readonly publicSummary?: string;
  readonly internalNotes?: string;
  readonly metadataURI?: string;
  readonly metadata?: unknown;
  readonly policy?: unknown;
}

export interface StoreZhixuDraftStore {
  createDraft(draft: StoreZhixuDraftRecord): Promise<void>;
  getDraft(draftId: string): Promise<StoreZhixuDraftRecord | undefined>;
  findProductSchemaByPlan(
    planId: string,
    planHash: string,
    artifactHash?: string
  ): Promise<StoreProductSchemaDTO | undefined>;
  updateDraft(draft: StoreZhixuDraftRecord): Promise<void>;
}

export class MemoryStoreZhixuDraftStore implements StoreZhixuDraftStore {
  readonly #drafts = new Map<string, StoreZhixuDraftRecord>();

  async createDraft(draft: StoreZhixuDraftRecord): Promise<void> {
    this.#drafts.set(draft.draftId, draft);
  }

  async getDraft(draftId: string): Promise<StoreZhixuDraftRecord | undefined> {
    return this.#drafts.get(draftId);
  }

  async findProductSchemaByPlan(
    planId: string,
    planHash: string,
    artifactHash?: string
  ): Promise<StoreProductSchemaDTO | undefined> {
    return Array.from(this.#drafts.values())
      .map((draft) => draft.productSchema)
      .filter((schema): schema is StoreProductSchemaDTO => Boolean(schema))
      .filter((schema) =>
        hexOrTextEquals(schema.planId, planId) &&
        hexOrTextEquals(schema.planHash, planHash) &&
        (artifactHash === undefined || hexOrTextEquals(schema.artifactHash, artifactHash))
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  }

  async updateDraft(draft: StoreZhixuDraftRecord): Promise<void> {
    this.#drafts.set(draft.draftId, draft);
  }
}

export class StoreZhixuDraftWorkflowError extends Error {
  override readonly name = "StoreZhixuDraftWorkflowError";

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
  }
}

export interface StoreZhixuDraftWorkflowService {
  importDraft(input: unknown): Promise<StoreZhixuDraftDTO>;
  getDraft(draftId: string): Promise<StoreZhixuDraftDTO | undefined>;
  compilePreview(draftId: string): Promise<StoreZhixuDraftDTO>;
  getProductSchema(draftId: string): Promise<StoreProductSchemaDTO | undefined>;
  updateProductSchema(
    draftId: string,
    input: unknown
  ): Promise<{
    readonly draft: StoreZhixuDraftDTO;
    readonly productSchema: StoreProductSchemaDTO;
    readonly validation: StoreProductSchemaValidationDTO;
  }>;
  validateProductSchema(
    draftId: string,
    input?: unknown
  ): Promise<StoreProductSchemaValidationDTO>;
  getProductSchemaByPlan(
    planId: string,
    planHash: string,
    artifactHash?: string
  ): Promise<StoreProductSchemaDTO | undefined>;
  submitReview(
    draftId: string,
    input: unknown,
    principal: GovernancePrincipal
  ): Promise<{
    readonly draft: StoreZhixuDraftDTO;
    readonly review: GovernanceReviewResultDTO["publicReview"];
  }>;
}

export function createStoreZhixuDraftWorkflowService(options: {
  readonly draftStore?: StoreZhixuDraftStore;
  readonly governanceService: GovernanceService;
  readonly projectionStore: ProjectionStore;
  readonly now?: () => Date;
  readonly draftIdFactory?: () => string;
}): StoreZhixuDraftWorkflowService {
  const draftStore = options.draftStore ?? new MemoryStoreZhixuDraftStore();
  const now = options.now ?? (() => new Date());
  const draftIdFactory = options.draftIdFactory ?? (() => `zhixu_draft_${randomUUID()}`);

  return {
    async importDraft(input) {
      const request = parseImportRequest(input);
      const timestamp = now().toISOString();
      const draft: StoreZhixuDraftRecord = {
        draftId: draftIdFactory(),
        sourceKind: request.sourceKind,
        content: request.content,
        status: "imported",
        title: request.title ?? "未命名秩序草稿",
        maintainer: request.maintainer ?? "未指定维护方",
        ...(request.publicSummary ? { publicSummary: request.publicSummary } : {}),
        tags: request.tags ?? [],
        errors: [],
        createdAt: timestamp,
        updatedAt: timestamp
      };
      await draftStore.createDraft(draft);
      return toDraftDTO(draft, options.projectionStore);
    },

    async getDraft(draftId) {
      const draft = await draftStore.getDraft(draftId);
      return draft ? toDraftDTO(draft, options.projectionStore) : undefined;
    },

    async compilePreview(draftId) {
      const draft = await requireDraft(draftStore, draftId);
      const timestamp = now().toISOString();
      const compiled = compileDraftContent(draft);
      const updated: StoreZhixuDraftRecord = compiled.ok
        ? {
            ...draft,
            status: "compiled",
            zhixuId: compiled.zhixuId,
            title: draft.title === "未命名秩序草稿" ? compiled.title : draft.title,
            compilePreview: compiled.preview,
            productSchema: buildSuggestedProductSchema(draft, compiled.artifact, timestamp),
            errors: [],
            updatedAt: timestamp
          }
        : {
            ...draft,
            status: "compile_failed",
            errors: compiled.errors,
            updatedAt: timestamp
          };
      await draftStore.updateDraft(updated);
      return toDraftDTO(updated, options.projectionStore);
    },

    async getProductSchema(draftId) {
      const draft = await requireDraft(draftStore, draftId);
      return draft.productSchema;
    },

    async updateProductSchema(draftId, input) {
      const draft = await requireDraft(draftStore, draftId);
      assertDraftSchemaMutable(draft);
      const timestamp = now().toISOString();
      const productSchema = normalizeProductSchemaInput(input, draft, timestamp);
      const updated: StoreZhixuDraftRecord = {
        ...draft,
        productSchema,
        updatedAt: timestamp
      };
      await draftStore.updateDraft(updated);
      return {
        draft: await toDraftDTO(updated, options.projectionStore),
        productSchema,
        validation: productSchema.validation
      };
    },

    async validateProductSchema(draftId, input) {
      const draft = await requireDraft(draftStore, draftId);
      const timestamp = now().toISOString();
      if (input !== undefined && input !== null) {
        return normalizeProductSchemaInput(input, draft, timestamp).validation;
      }
      if (!draft.productSchema) {
        return validationForIssues([
          {
            code: "missing_role_slot",
            severity: "error",
            message: "draft has no Product Schema Bundle; compile-preview must generate one first"
          }
        ], timestamp);
      }
      return validateProductSchemaBundle(draft.productSchema, draft.compilePreview, timestamp);
    },

    async getProductSchemaByPlan(planId, planHash, artifactHash) {
      return draftStore.findProductSchemaByPlan(planId, planHash, artifactHash);
    },

    async submitReview(draftId, input, principal) {
      const draft = await requireDraft(draftStore, draftId);
      assertDraftCompiledForReview(draft);
      const body = parseSubmitReviewInput(input);
      const reviewStatus = body.status ?? "submitted";
      const result = await options.governanceService.reviewZhixu({
        ...(draft.reviewId ? { reviewId: draft.reviewId } : {}),
        subjectId: draft.compilePreview.planId,
        status: reviewStatus,
        ...(body.riskLevel ? { riskLevel: body.riskLevel } : {}),
        ...(body.riskTags ? { riskTags: body.riskTags } : {}),
        publicSummary: body.publicSummary ?? draft.publicSummary ?? `Store review for ${draft.title}`,
        ...(body.internalNotes ? { internalNotes: body.internalNotes } : {}),
        ...(body.metadataURI ? { metadataURI: body.metadataURI } : {}),
        metadata: body.metadata ?? reviewMetadataForDraft(draft),
        policy: body.policy ?? reviewPolicyForDraft(draft)
      }, principal);
      const timestamp = now().toISOString();
      const updated: StoreZhixuDraftRecord = {
        ...draft,
        status: draftStatusFromReviewStatus(result.review.status),
        reviewId: result.review.reviewId,
        reviewStatus: result.review.status,
        updatedAt: timestamp
      };
      await draftStore.updateDraft(updated);
      return {
        draft: await toDraftDTO(updated, options.projectionStore),
        review: result.publicReview
      };
    },

  };
}

async function requireDraft(
  store: StoreZhixuDraftStore,
  draftId: string
): Promise<StoreZhixuDraftRecord> {
  const draft = await store.getDraft(draftId);
  if (!draft) {
    throw new StoreZhixuDraftWorkflowError(404, "store_zhixu_draft_not_found", "Store Zhixu draft not found");
  }
  return draft;
}

function assertDraftCompiledForReview(
  draft: StoreZhixuDraftRecord
): asserts draft is StoreZhixuDraftRecord & {
  readonly compilePreview: StoreCompilePreviewDTO;
  readonly productSchema: StoreProductSchemaDTO;
} {
  if (draft.status === "compile_failed") {
    throw new StoreZhixuDraftWorkflowError(409, "compile_failed", "compile errors must be fixed before review", draft.errors);
  }
  if (!draft.compilePreview) {
    throw new StoreZhixuDraftWorkflowError(409, "compile_preview_required", "compile preview is required before review");
  }
  if (!draft.productSchema) {
    throw new StoreZhixuDraftWorkflowError(409, "product_schema_required", "Product Schema Bundle is required before review");
  }
  if (!draft.productSchema.validation.ok) {
    throw new StoreZhixuDraftWorkflowError(
      409,
      "product_schema_not_explicit",
      "Product Schema Bundle must be explicitly reviewed before Store broadcast",
      draft.productSchema.validation
    );
  }
}

function assertDraftSchemaMutable(draft: StoreZhixuDraftRecord): void {
  if (draft.status === "active") {
    throw new StoreZhixuDraftWorkflowError(
      409,
      "product_schema_new_version_required",
      "active product schema cannot be changed in place; create a new draft version"
    );
  }
}

function parseImportRequest(input: unknown): StoreZhixuImportRequestDTO {
  const record = requireRecord(input, "import request");
  const sourceKind = requiredString(record, "sourceKind");
  if (sourceKind !== "zhixu_yaml" && sourceKind !== "onchain_hook_plan_manifest") {
    throw new StoreZhixuDraftWorkflowError(400, "invalid_source_kind", "sourceKind must be zhixu_yaml or onchain_hook_plan_manifest");
  }
  const content = requiredString(record, "content");
  if (content.trim().length === 0) {
    throw new StoreZhixuDraftWorkflowError(400, "empty_content", "content is required");
  }
  return {
    sourceKind,
    content,
    ...(optionalString(record, "title") ? { title: optionalString(record, "title")! } : {}),
    ...(optionalString(record, "maintainer") ? { maintainer: optionalString(record, "maintainer")! } : {}),
    ...(optionalString(record, "publicSummary") ? { publicSummary: optionalString(record, "publicSummary")! } : {}),
    ...(optionalStringArray(record, "tags") ? { tags: optionalStringArray(record, "tags")! } : {})
  };
}

function parseSubmitReviewInput(input: unknown): SubmitStoreZhixuReviewInput {
  if (input === undefined || input === null) {
    return {};
  }
  const record = requireRecord(input, "submit-review request");
  const status = optionalString(record, "status");
  if (status !== undefined && !isGovernanceReviewStatus(status)) {
    throw new StoreZhixuDraftWorkflowError(400, "invalid_review_status", "invalid review status");
  }
  return {
    ...(status ? { status } : {}),
    ...(optionalString(record, "riskLevel") ? { riskLevel: optionalString(record, "riskLevel")! } : {}),
    ...(optionalStringArray(record, "riskTags") ? { riskTags: optionalStringArray(record, "riskTags")! } : {}),
    ...(optionalString(record, "publicSummary") ? { publicSummary: optionalString(record, "publicSummary")! } : {}),
    ...(optionalString(record, "internalNotes") ? { internalNotes: optionalString(record, "internalNotes")! } : {}),
    ...(optionalString(record, "metadataURI") ? { metadataURI: optionalString(record, "metadataURI")! } : {}),
    ...(Object.hasOwn(record, "metadata") ? { metadata: record.metadata } : {}),
    ...(Object.hasOwn(record, "policy") ? { policy: record.policy } : {})
  };
}

function compileDraftContent(
  draft: StoreZhixuDraftRecord
): {
  readonly ok: true;
  readonly zhixuId: string;
  readonly title: string;
  readonly preview: StoreCompilePreviewDTO;
  readonly artifact: OnchainHookPlanArtifact;
} |
  { readonly ok: false; readonly errors: readonly StoreDraftErrorDTO[] } {
  try {
    const onchain = draft.sourceKind === "zhixu_yaml"
      ? compileZhixuOnchainHookPlan(parseZhixuDefinition(draft.content, "store-zhixu-draft.yaml"))
      : compileManifest(draft.content);
    return {
      ok: true,
      zhixuId: onchain.zhixuId,
      title: onchain.zhixuName,
      preview: previewFromOnchainArtifact(onchain),
      artifact: onchain
    };
  } catch (error) {
    return {
      ok: false,
      errors: errorsFromCompileError(error)
    };
  }
}

function compileManifest(raw: string): OnchainHookPlanArtifact {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`manifest content must be valid JSON: ${errorMessage(error)}`);
  }

  assertOnchainHookPlanArtifact(parsed);
  return parsed as OnchainHookPlanArtifact;
}

function previewFromOnchainArtifact(artifact: OnchainHookPlanArtifact): StoreCompilePreviewDTO {
  const canonicalArtifactHash = hashCanonical("uvp:store-onchain-hook-plan-artifact:v1", artifact);
  const stages = new Set<string>();
  const sources = new Set<string>();
  const signals = new Set<string>();

  for (const hook of artifact.compiledHooks) {
    stages.add(hook.stageId);
    for (const dependency of hook.dependencies) {
      sources.add(dependency.source);
      signals.add(dependency.signalKey);
    }
    for (const instruction of hook.instructions) {
      if (instruction.op === "SIGNAL") {
        const signalInstruction = instruction as OnchainSignalInstruction;
        sources.add(signalInstruction.source);
        signals.add(signalInstruction.signalKey);
      }
    }
  }
  for (const route of artifact.executorRoutes) {
    stages.add(route.stageId);
  }

  return {
    planId: artifact.planId,
    planHash: artifact.planHash,
    artifactHash: canonicalArtifactHash,
    stageCount: stages.size,
    roleSlotCount: artifact.executorRoutes.length,
    sourceCount: sources.size,
    signalCount: signals.size,
    canonicalArtifactHash
  };
}

function buildSuggestedProductSchema(
  draft: StoreZhixuDraftRecord,
  artifact: OnchainHookPlanArtifact,
  timestamp: string
): StoreProductSchemaDTO {
  const preview = previewFromOnchainArtifact(artifact);
  const stages = stagesFromOnchainArtifact(artifact);
  const stageIds = new Set(stages.map((stage) => stage.stageId));
  const routeByStage = new Map(artifact.executorRoutes.map((route) => [route.stageIdentifier, route]));
  const roleSlots: RoleSlotDTO[] = stages.map((stage) => {
    const route = routeByStage.get(stage.stageId);
    const plugin = suggestedPluginForStage(stage.stageId);
    const slotId = stage.stageId;
    return {
      slotId,
      title: route?.executorId ? `${stage.name}执行方` : `${stage.name}履约者`,
      label: route?.executorId ?? stage.ownerRole,
      duty: `负责 ${stage.name} 阶段的链下履约、凭证提交和签名确认。`,
      evidence: stage.evidence,
      status: "required",
      tone: "info",
      required: true,
      performanceSlotLabel: `${stage.name}履约者`,
      businessPersonaLabels: route?.executorId ? [route.executorId] : [],
      capabilityPlugins: [plugin],
      addOnManifest: suggestedAddOnManifestForSlot(slotId, stage.name, plugin)
    };
  });
  const orderPermissionTable = permissionTableFromOnchainArtifact(artifact, stageIds);
  const capabilityPlugins = roleSlots.flatMap((slot) => slot.capabilityPlugins ?? []);
  const selectorBindings = selectorBindingsFromOnchainArtifact(artifact);
  const createOrderTrigger = createOrderTriggerFromOnchainArtifact(artifact, stages, roleSlots);
  const schemaWithoutHash: Omit<StoreProductSchemaDTO, "schemaHash" | "validation"> & {
    readonly schemaHash?: string;
    readonly validation?: StoreProductSchemaValidationDTO;
  } = {
    schemaVersion: "store-product-schema.v1",
    version: draft.productSchema?.version ?? 1,
    zhixuId: artifact.zhixuId,
    title: draft.title === "未命名秩序草稿" ? artifact.zhixuName : draft.title,
    maintainer: draft.maintainer,
    planId: artifact.planId,
    planHash: artifact.planHash,
    artifactHash: preview.artifactHash,
    onchainHookPlanArtifact: artifact,
    ...(createOrderTrigger ? { createOrderTrigger } : {}),
    roleSlots,
    orderPermissionTable,
    capabilityPlugins,
    businessPersonaLabels: uniqueSorted(roleSlots.flatMap((slot) => slot.businessPersonaLabels ?? [])),
    stages,
    ...(selectorBindings.length > 0 ? { selectorBindings } : {}),
    createdAt: draft.productSchema?.createdAt ?? timestamp,
    updatedAt: timestamp
  };
  return finalizeProductSchema(schemaWithoutHash, draft.compilePreview ?? preview, timestamp);
}

function stagesFromOnchainArtifact(artifact: OnchainHookPlanArtifact): readonly ZhixuStageDTO[] {
  const seen = new Set<string>();
  const stageIds: string[] = [];
  for (const hook of artifact.compiledHooks) {
    if (!seen.has(hook.stageIdentifier)) {
      seen.add(hook.stageIdentifier);
      stageIds.push(hook.stageIdentifier);
    }
  }
  for (const route of artifact.executorRoutes) {
    if (!seen.has(route.stageIdentifier)) {
      seen.add(route.stageIdentifier);
      stageIds.push(route.stageIdentifier);
    }
  }
  return stageIds.map((stageId, index) => ({
    stageId,
    index,
    name: displayStageLabel(stageId),
    evidence: [defaultEvidenceLabel(stageId)],
    ownerRole: stageId,
    status: "pending"
  }));
}

function permissionTableFromOnchainArtifact(
  artifact: OnchainHookPlanArtifact,
  stageIds: ReadonlySet<string>
): readonly OrderPermissionTableEntryDTO[] {
  return artifact.compiledHooks
    .filter((hook) => stageIds.has(hook.stageIdentifier))
    .map((hook): OrderPermissionTableEntryDTO => ({
      permissionId: `${hook.stageIdentifier}#${hook.hookName}`,
      roleSlotId: hook.stageIdentifier,
      stageId: hook.stageIdentifier,
      source: hook.dependencies[0]?.source ?? hook.kind,
      signalName: hook.hookName,
      payloadPolicy: "required",
      requiredEvidence: [defaultEvidenceLabel(hook.stageIdentifier)]
    }));
}

function createOrderTriggerFromOnchainArtifact(
  artifact: OnchainHookPlanArtifact,
  stages: readonly ZhixuStageDTO[],
  roleSlots: readonly RoleSlotDTO[]
): StoreProductSchemaDTO["createOrderTrigger"] {
  // uvp-semantic/0.7：入口表退役。mint 出生阶段的订阅已可上链（编译为
  // SIGNAL 指令、isTrigger=true，现实成立后经 triggerOrderFrom* 开放提交）；
  // 非 mint 阶段的订阅不上链。这里为 Store 产品 schema 选择 createOrderTrigger：
  // 首条携带正依赖的 receive hook（注册者的 bootstrap 入口）。signalMap 委托
  // 缝的 hook 是父秩序转发信号，不能当开单入口；依赖按 kind 字典序排序，必须
  // 显式取正依赖，负依赖不能用于构造开单 typed data。
  // isTrigger（= mint 出生阶段）是冻结合约 triggerOrderFrom* 的硬门槛：
  // 缺失时用户签名后链上 InvalidTriggerHook revert，draft 永久无法开单。
  const hook = artifact.compiledHooks.find((item) =>
    item.isTrigger === true &&
    item.kind === "receive" &&
    item.dependencies.some((dependency) => dependency.kind === "positive")
  );
  const dependency = hook?.dependencies.find((item) => item.kind === "positive");
  if (!hook || !dependency) {
    return undefined;
  }
  return {
    source: dependency.source,
    signalName: dependency.signalName,
    triggerHookId: hook.hookId,
    triggerStageId: hook.stageId,
    ...triggerSubmitterRoleSlot(hook.stageIdentifier, stages, roleSlots)
  };
}

function triggerSubmitterRoleSlot(
  stageIdentifier: string,
  stages: readonly ZhixuStageDTO[],
  roleSlots: readonly RoleSlotDTO[]
): { readonly submitterRoleSlotId: string } | Record<string, never> {
  const stage = stages.find((item) => item.stageId === stageIdentifier);
  if (stage?.staticExecutorRoleSlotId) {
    return { submitterRoleSlotId: stage.staticExecutorRoleSlotId };
  }
  const candidateSlots = roleSlots.filter((slot) =>
    (slot.capabilityPlugins ?? []).some((plugin) => plugin.stageIds.includes(stageIdentifier))
  );
  return candidateSlots.length === 1 ? { submitterRoleSlotId: candidateSlots[0]!.slotId } : {};
}

function selectorBindingsFromOnchainArtifact(
  artifact: OnchainHookPlanArtifact
): readonly StoreProductSchemaSelectorBindingDTO[] {
  return artifact.selectorBindings.map((binding) => ({
    selectorStageIdentifier: binding.selectorStageIdentifier,
    targetStageIdentifier: binding.targetStageIdentifier,
    selectorStageId: binding.selectorStageId,
    targetStageId: binding.targetStageId,
    bindingHash: binding.bindingHash
  }));
}

function suggestedPluginForStage(stageId: string): SlotCapabilityPluginDTO {
  const pluginKind = inferPluginKind(stageId);
  return {
    pluginKind,
    source: "inferred",
    stageIds: [stageId],
    title: `${displayStageLabel(stageId)}能力插件`,
    summary: "由编译产物推断生成，必须由 Store operator 确认为 explicit 后才能发布。",
    primaryActionLabel: primaryActionForPlugin(pluginKind),
    requiredEvidence: [defaultEvidenceLabel(stageId)],
    inputPolicy: [
      {
        inputId: `${safeId(stageId)}-evidence`,
        label: defaultEvidenceLabel(stageId),
        inputType: pluginKind === "payment_placeholder" ? "payment_placeholder" : "evidence",
        required: true,
        completed: false
      }
    ]
  };
}

function suggestedAddOnManifestForSlot(
  roleSlotId: string,
  stageName: string,
  plugin: SlotCapabilityPluginDTO
): ParticipantAddOnManifestDTO {
  const addOnKind = addOnKindForPlugin(plugin.pluginKind);
  const walletInputId = `${safeId(roleSlotId)}.wallet`;
  const evidenceInputId = `${safeId(roleSlotId)}.evidence`;
  const confirmationInputId = `${safeId(roleSlotId)}.confirmation`;
  return {
    schemaVersion: "participant-addon-manifest.v1",
    manifestId: `${roleSlotId}:addon:v1`,
    roleSlotId,
    addOnKind,
    title: plugin.title ?? `${stageName}附加能力`,
    summary: plugin.summary ?? "由 Store Product Schema 配置的参与方页面。",
    stageBindings: plugin.stageIds,
    pages: [
      {
        pageId: "main",
        title: plugin.title ?? `${stageName}附加能力`,
        ...(plugin.summary ? { summary: plugin.summary } : {}),
        sections: [
          {
            sectionId: "inputs",
            title: "提交材料",
            components: [
              {
                componentId: "wallet",
                componentKind: "wallet",
                inputId: walletInputId,
                label: "参与方钱包",
                required: true
              },
              {
                componentId: "evidence",
                componentKind: "evidence_refs",
                inputId: evidenceInputId,
                label: plugin.requiredEvidence[0] ?? defaultEvidenceLabel(roleSlotId),
                required: true
              },
              {
                componentId: "confirmation",
                componentKind: "confirmation",
                inputId: confirmationInputId,
                label: plugin.primaryActionLabel ?? primaryActionForPlugin(plugin.pluginKind),
                required: true
              },
              {
                componentId: "proof",
                componentKind: "proof_rows",
                label: "证明"
              }
            ]
          }
        ]
      }
    ],
    actions: [
      {
        actionId: `${roleSlotId}.confirm`,
        actionKind: "submit_signal",
        label: plugin.primaryActionLabel ?? primaryActionForPlugin(plugin.pluginKind),
        primary: true,
        intent: plugin.pluginKind === "dispute_material" ? "raise_dispute" : "confirm_stage",
        inputBindings: {
          walletAddress: walletInputId,
          evidenceIds: evidenceInputId,
          confirmation: confirmationInputId
        }
      }
    ]
  };
}

function normalizeProductSchemaInput(
  input: unknown,
  draft: StoreZhixuDraftRecord,
  timestamp: string
): StoreProductSchemaDTO {
  const record = requireRecord(input, "product-schema request");
  const schemaInput = Object.hasOwn(record, "productSchema") ? record.productSchema : record;
  const schemaRecord = requireRecord(schemaInput, "productSchema");
  const preview = draft.compilePreview;
  if (!preview) {
    throw new StoreZhixuDraftWorkflowError(409, "compile_preview_required", "compile preview is required before product schema update");
  }
  const roleSlots = arrayField<RoleSlotDTO>(schemaRecord, "roleSlots");
  const orderPermissionTable = arrayField<OrderPermissionTableEntryDTO>(schemaRecord, "orderPermissionTable");
  const stages = arrayField<ZhixuStageDTO>(schemaRecord, "stages");
  const selectorBindings = arrayField<StoreProductSchemaSelectorBindingDTO>(schemaRecord, "selectorBindings", () =>
    draft.productSchema?.selectorBindings ?? []
  );
  const createOrderTrigger = optionalCreateOrderTrigger(schemaRecord, draft.productSchema?.createOrderTrigger);
  const schemaWithoutHash = {
    schemaVersion: "store-product-schema.v1" as const,
    version: numberField(schemaRecord, "version") ?? draft.productSchema?.version ?? 1,
    ...(optionalRecordString(schemaRecord, "zhixuId") ? { zhixuId: optionalRecordString(schemaRecord, "zhixuId")! } : {}),
    title: optionalRecordString(schemaRecord, "title") ?? draft.title,
    maintainer: optionalRecordString(schemaRecord, "maintainer") ?? draft.maintainer,
    planId: optionalRecordString(schemaRecord, "planId") ?? preview.planId,
    planHash: optionalRecordString(schemaRecord, "planHash") ?? preview.planHash,
    artifactHash: optionalRecordString(schemaRecord, "artifactHash") ?? preview.artifactHash,
    ...(Object.hasOwn(schemaRecord, "onchainHookPlanArtifact")
      ? { onchainHookPlanArtifact: schemaRecord.onchainHookPlanArtifact }
      : draft.productSchema?.onchainHookPlanArtifact
        ? { onchainHookPlanArtifact: draft.productSchema.onchainHookPlanArtifact }
        : {}),
    ...(createOrderTrigger ? { createOrderTrigger } : {}),
    roleSlots,
    orderPermissionTable,
    capabilityPlugins: arrayField<SlotCapabilityPluginDTO>(schemaRecord, "capabilityPlugins", () =>
      roleSlots.flatMap((slot) => slot.capabilityPlugins ?? [])
    ),
    businessPersonaLabels: arrayField<string>(schemaRecord, "businessPersonaLabels", () =>
      uniqueSorted(roleSlots.flatMap((slot) => slot.businessPersonaLabels ?? []))
    ),
    stages,
    ...(selectorBindings.length > 0 ? { selectorBindings } : {}),
    createdAt: optionalRecordString(schemaRecord, "createdAt") ?? draft.productSchema?.createdAt ?? timestamp,
    updatedAt: timestamp,
    ...(optionalRecordString(schemaRecord, "publishedAt") ? { publishedAt: optionalRecordString(schemaRecord, "publishedAt")! } : {}),
    ...(optionalRecordString(schemaRecord, "deprecatedAt") ? { deprecatedAt: optionalRecordString(schemaRecord, "deprecatedAt")! } : {})
  };
  return finalizeProductSchema(schemaWithoutHash, preview, timestamp);
}

function finalizeProductSchema(
  schemaInput: Omit<StoreProductSchemaDTO, "schemaHash" | "validation"> & {
    readonly schemaHash?: string;
    readonly validation?: StoreProductSchemaValidationDTO;
  },
  preview: StoreCompilePreviewDTO | undefined,
  timestamp: string
): StoreProductSchemaDTO {
  const schemaHash = hashCanonical("uvp:store-product-schema:v1", productSchemaHashPayload(schemaInput));
  const validation = validateProductSchemaBundle({
    ...schemaInput,
    schemaHash,
    validation: validationForIssues([], timestamp)
  }, preview, timestamp);
  return {
    ...schemaInput,
    schemaHash,
    validation
  };
}

function productSchemaHashPayload(
  schema: Omit<StoreProductSchemaDTO, "schemaHash" | "validation"> & {
    readonly schemaHash?: string;
    readonly validation?: StoreProductSchemaValidationDTO;
  }
): unknown {
  return {
    schemaVersion: schema.schemaVersion,
    version: schema.version,
    zhixuId: schema.zhixuId ?? null,
    title: schema.title,
    maintainer: schema.maintainer,
    planId: schema.planId,
    planHash: schema.planHash,
    artifactHash: schema.artifactHash,
    createOrderTrigger: schema.createOrderTrigger ?? null,
    roleSlots: schema.roleSlots,
    orderPermissionTable: schema.orderPermissionTable,
    capabilityPlugins: schema.capabilityPlugins,
    businessPersonaLabels: schema.businessPersonaLabels,
    stages: schema.stages,
    selectorBindings: schema.selectorBindings ?? [],
    publishedAt: schema.publishedAt ?? null,
    deprecatedAt: schema.deprecatedAt ?? null
  };
}

function validateProductSchemaBundle(
  schema: StoreProductSchemaDTO,
  expected?: StoreCompilePreviewDTO,
  checkedAt?: string
): StoreProductSchemaValidationDTO {
  const issues: StoreProductSchemaValidationIssueDTO[] = [];
  if (schema.schemaVersion !== "store-product-schema.v1") {
    issues.push({
      code: "plan_identity_mismatch",
      severity: "error",
      message: "schemaVersion must be store-product-schema.v1",
      path: "schemaVersion"
    });
  }
  if (expected) {
    for (const [field, actual, wanted] of [
      ["planId", schema.planId, expected.planId],
      ["planHash", schema.planHash, expected.planHash],
      ["artifactHash", schema.artifactHash, expected.artifactHash]
    ] as const) {
      if (!hexOrTextEquals(actual, wanted)) {
        issues.push({
          code: "plan_identity_mismatch",
          severity: "error",
          message: `${field} must match compile preview`,
          path: field
        });
      }
    }
  }

  const roleSlots = new Map(schema.roleSlots.map((slot) => [slot.slotId, slot]));
  if (roleSlots.size === 0) {
    issues.push({
      code: "missing_role_slot",
      severity: "error",
      message: "at least one role slot is required",
      path: "roleSlots"
    });
  }
  if (schema.createOrderTrigger?.submitterRoleSlotId && !roleSlots.has(schema.createOrderTrigger.submitterRoleSlotId)) {
    issues.push({
      code: "create_order_trigger_invalid",
      severity: "error",
      message: "createOrderTrigger.submitterRoleSlotId must reference an existing trigger stage executor role slot",
      path: "createOrderTrigger.submitterRoleSlotId",
      roleSlotId: schema.createOrderTrigger.submitterRoleSlotId
    });
  }

  const stages = new Map(schema.stages.map((stage) => [stage.stageId, stage]));
  const stageCoverage = new Map<string, number>();
  for (const slot of schema.roleSlots) {
    const plugins = slot.capabilityPlugins ?? [];
    if (plugins.length === 0) {
      issues.push({
        code: "slot_missing_capability_plugin",
        severity: "error",
        message: "role slot must have at least one capability plugin",
        path: `roleSlots.${slot.slotId}.capabilityPlugins`,
        roleSlotId: slot.slotId
      });
      continue;
    }
    for (const plugin of plugins) {
      if (plugin.source !== "explicit") {
        issues.push({
          code: "capability_plugin_not_explicit",
          severity: "error",
          message: plugin.source === "missing"
            ? "capability plugin source is missing and must be authored before broadcast"
            : "capability plugin must be confirmed as explicit before broadcast",
          path: `roleSlots.${slot.slotId}.capabilityPlugins`,
          roleSlotId: slot.slotId
        });
      }
      if (plugin.stageIds.length === 0) {
        issues.push({
          code: "stage_not_covered",
          severity: "error",
          message: "capability plugin must cover at least one stage",
          path: `roleSlots.${slot.slotId}.capabilityPlugins.stageIds`,
          roleSlotId: slot.slotId
        });
      }
      for (const stageId of plugin.stageIds) {
        if (!stages.has(stageId)) {
          issues.push({
            code: "stage_not_covered",
            severity: "error",
            message: "capability plugin references a stage that does not exist in schema.stages",
            path: `roleSlots.${slot.slotId}.capabilityPlugins.stageIds`,
            stageId,
            roleSlotId: slot.slotId
          });
          continue;
        }
        stageCoverage.set(stageId, (stageCoverage.get(stageId) ?? 0) + 1);
      }
    }
    if (slot.addOnManifest) {
      issues.push(...validateAddOnManifest(slot, slot.addOnManifest, stages));
    }
  }

  issues.push(...validateSelectorBindings(schema, stages));
  issues.push(...validateStageExecutorSelection(schema, stages));

  for (const entry of schema.orderPermissionTable) {
    if (isSystemPermission(entry)) {
      issues.push({
        code: "unsupported_system_permission",
        severity: "error",
        message: "system permission rows are not supported in Product orderPermissionTable",
        path: `orderPermissionTable.${entry.permissionId}`,
        stageId: entry.stageId,
        roleSlotId: entry.roleSlotId
      });
      continue;
    }
    if (!roleSlots.has(entry.roleSlotId)) {
      issues.push({
        code: "permission_role_slot_not_found",
        severity: "error",
        message: "orderPermissionTable.roleSlotId must reference an existing role slot",
        path: `orderPermissionTable.${entry.permissionId}.roleSlotId`,
        stageId: entry.stageId,
        roleSlotId: entry.roleSlotId
      });
    }
  }

  for (const stage of schema.stages) {
    const coverage = stageCoverage.get(stage.stageId) ?? 0;
    if (coverage === 0) {
      issues.push({
        code: "stage_not_covered",
        severity: "error",
        message: "every stage must be covered by a role slot capability plugin",
        path: `stages.${stage.stageId}`,
        stageId: stage.stageId
      });
    }
    if (coverage > 1) {
      issues.push({
        code: "duplicate_stage_capability",
        severity: "error",
        message: "stage is covered by more than one capability plugin; Store operator must pick one",
        path: `stages.${stage.stageId}`,
        stageId: stage.stageId
      });
    }
  }

  return validationForIssues(issues, checkedAt);
}

function isSystemPermission(entry: OrderPermissionTableEntryDTO): boolean {
  return entry.permissionId.startsWith("system.") ||
    entry.roleSlotId.startsWith("system:") ||
    entry.stageId.startsWith("system:");
}

function validateSelectorBindings(
  schema: StoreProductSchemaDTO,
  stages: ReadonlyMap<string, ZhixuStageDTO>
): readonly StoreProductSchemaValidationIssueDTO[] {
  const issues: StoreProductSchemaValidationIssueDTO[] = [];
  const selectedStageBindingKeys = new Set<string>();
  for (const [index, binding] of (schema.selectorBindings ?? []).entries()) {
    const selectorStageId = binding.selectorStageIdentifier;
    const targetStageId = binding.targetStageIdentifier;
    if (!selectorStageId?.trim() || !targetStageId?.trim()) {
      issues.push(stageExecutorSelectionIssue(
        "selector binding must include selectorStageIdentifier and targetStageIdentifier",
        `selectorBindings.${index}`
      ));
      continue;
    }
    if (!stages.has(selectorStageId)) {
      issues.push(stageExecutorSelectionIssue(
        "selector binding selectorStageIdentifier must reference schema.stages",
        `selectorBindings.${index}.selectorStageIdentifier`,
        selectorStageId
      ));
    }
    if (!stages.has(targetStageId)) {
      issues.push(stageExecutorSelectionIssue(
        "selector binding targetStageIdentifier must reference schema.stages",
        `selectorBindings.${index}.targetStageIdentifier`,
        targetStageId
      ));
    }
    selectedStageBindingKeys.add(`${selectorStageId}->${targetStageId}`);
  }

  for (const stage of schema.stages) {
    for (const targetStageId of stage.selectedStageTargets ?? []) {
      if (!stages.has(targetStageId)) {
        issues.push(stageExecutorSelectionIssue(
          "stage selectedStageTargets must reference schema.stages",
          `stages.${stage.stageId}.selectedStageTargets`,
          targetStageId
        ));
        continue;
      }
      if (
        (schema.selectorBindings?.length ?? 0) > 0 &&
        !selectedStageBindingKeys.has(`${stage.stageId}->${targetStageId}`)
      ) {
        issues.push(stageExecutorSelectionIssue(
          "stage selectedStageTargets must be mirrored in selectorBindings",
          `stages.${stage.stageId}.selectedStageTargets`,
          targetStageId
        ));
      }
    }
  }
  return issues;
}

function validateStageExecutorSelection(
  schema: StoreProductSchemaDTO,
  stages: ReadonlyMap<string, ZhixuStageDTO>
): readonly StoreProductSchemaValidationIssueDTO[] {
  const issues: StoreProductSchemaValidationIssueDTO[] = [];
  const executorSelectorCoverage = new Map<string, string[]>();
  for (const slot of schema.roleSlots) {
    const manifest = slot.addOnManifest;
    if (!manifest || manifest.addOnKind !== "stage_executor_patch") {
      continue;
    }
    const canAssignExecutor = Array.isArray(manifest.actions) &&
      manifest.actions.some((action) => isRecord(action) && action.actionKind === "stage_executor_patch");
    if (!canAssignExecutor || !Array.isArray(manifest.stageBindings)) {
      continue;
    }
    for (const targetStageId of manifest.stageBindings) {
      const coveringSlots = executorSelectorCoverage.get(targetStageId) ?? [];
      coveringSlots.push(slot.slotId);
      executorSelectorCoverage.set(targetStageId, coveringSlots);
    }
  }

  for (const stage of schema.stages) {
    const coveringSlots = executorSelectorCoverage.get(stage.stageId) ?? [];
    if (stage.executorAssignment === "selected" && coveringSlots.length !== 1) {
      issues.push(stageExecutorSelectionIssue(
        "executor-less selected stage must be covered by exactly one executor patch action manifest with a stage_executor_patch action",
        `stages.${stage.stageId}.executorAssignment`,
        stage.stageId
      ));
    }
    if (stage.executorAssignment === "static" && coveringSlots.length > 0) {
      issues.push(stageExecutorSelectionIssue(
        "static executor stage must not also be claimed by dynamic executor selection",
        `stages.${stage.stageId}.executorAssignment`,
        stage.stageId
      ));
    }
    if (coveringSlots.length > 1) {
      issues.push(stageExecutorSelectionIssue(
        "target stage has ambiguous executor selector coverage",
        `stages.${stage.stageId}.executorAssignment`,
        stage.stageId
      ));
    }
  }

  for (const targetStageId of executorSelectorCoverage.keys()) {
    if (!stages.has(targetStageId)) {
      issues.push(stageExecutorSelectionIssue(
        "executor selector manifest stageBindings must reference schema.stages",
        "roleSlots.addOnManifest.stageBindings",
        targetStageId
      ));
    }
  }
  return issues;
}

function validateAddOnManifest(
  slot: RoleSlotDTO,
  manifest: ParticipantAddOnManifestDTO,
  stages: ReadonlyMap<string, ZhixuStageDTO>
): readonly StoreProductSchemaValidationIssueDTO[] {
  const issues: StoreProductSchemaValidationIssueDTO[] = [];
  const path = `roleSlots.${slot.slotId}.addOnManifest`;
  if (!isRecord(manifest)) {
    issues.push(addOnManifestIssue("addon_manifest_invalid", "add-on manifest must be an object", path, slot.slotId));
    return issues;
  }
  if (manifest.schemaVersion !== "participant-addon-manifest.v1") {
    issues.push(addOnManifestIssue("addon_manifest_invalid", "add-on manifest schemaVersion must be participant-addon-manifest.v1", path, slot.slotId));
  }
  if (!manifest.manifestId?.trim()) {
    issues.push(addOnManifestIssue("addon_manifest_invalid", "add-on manifestId is required", `${path}.manifestId`, slot.slotId));
  }
  if (manifest.roleSlotId !== slot.slotId) {
    issues.push(addOnManifestIssue("addon_manifest_invalid", "add-on manifest roleSlotId must match role slot", `${path}.roleSlotId`, slot.slotId));
  }
  if (!isParticipantAddOnKind(manifest.addOnKind)) {
    issues.push(addOnManifestIssue("addon_manifest_invalid", "add-on manifest addOnKind is unsupported", `${path}.addOnKind`, slot.slotId));
  }
  if (!Array.isArray(manifest.stageBindings) || manifest.stageBindings.length === 0) {
    issues.push(addOnManifestIssue("addon_manifest_stage_not_bound", "add-on manifest must bind at least one stage", `${path}.stageBindings`, slot.slotId));
  } else {
    for (const stageId of manifest.stageBindings) {
      if (!stages.has(stageId)) {
        issues.push({
          ...addOnManifestIssue("addon_manifest_stage_not_bound", "add-on manifest stageBindings must reference schema.stages", `${path}.stageBindings`, slot.slotId),
          stageId
        });
      }
    }
  }

  const inputIds = new Set<string>();
  const componentIds = new Set<string>();
  const componentCollection = collectAddOnManifestComponents(manifest, path, slot.slotId);
  issues.push(...componentCollection.issues);
  const components = componentCollection.components;
  for (const component of components) {
    if (!component.componentId?.trim()) {
      issues.push(addOnManifestIssue("addon_manifest_invalid", "add-on componentId is required", `${path}.pages.components.componentId`, slot.slotId));
    } else if (componentIds.has(component.componentId)) {
      issues.push(addOnManifestIssue("addon_manifest_invalid", "add-on componentId must be unique", `${path}.pages.components.${component.componentId}`, slot.slotId));
    }
    componentIds.add(component.componentId);
    if (!isAddOnComponentKind(component.componentKind)) {
      issues.push(addOnManifestIssue("addon_manifest_invalid", "add-on componentKind is unsupported", `${path}.pages.components.${component.componentId}`, slot.slotId));
    }
    if (componentRequiresInput(component)) {
      if (!component.inputId?.trim()) {
        issues.push(addOnManifestIssue("addon_manifest_input_not_found", "interactive add-on component must declare inputId", `${path}.pages.components.${component.componentId}.inputId`, slot.slotId));
      } else if (inputIds.has(component.inputId)) {
        issues.push(addOnManifestIssue("addon_manifest_input_not_found", "add-on inputId must be unique", `${path}.pages.components.${component.componentId}.inputId`, slot.slotId));
      } else {
        inputIds.add(component.inputId);
      }
    }
  }

  const actions = collectAddOnManifestActions(manifest, path, slot.slotId, issues);
  for (const action of actions) {
    issues.push(...validateAddOnManifestAction(action, inputIds, path, slot.slotId));
  }
  return issues;
}

function collectAddOnManifestComponents(
  manifest: ParticipantAddOnManifestDTO,
  path: string,
  roleSlotId: string
): {
  readonly components: readonly ParticipantAddOnManifestComponentDTO[];
  readonly issues: readonly StoreProductSchemaValidationIssueDTO[];
} {
  const issues: StoreProductSchemaValidationIssueDTO[] = [];
  const components: ParticipantAddOnManifestComponentDTO[] = [];
  if (!Array.isArray(manifest.pages) || manifest.pages.length === 0) {
    issues.push(addOnManifestIssue("addon_manifest_invalid", "add-on manifest must include at least one page", `${path}.pages`, roleSlotId));
    return { components, issues };
  }
  manifest.pages.forEach((page, pageIndex) => {
    const pagePath = `${path}.pages.${pageIndex}`;
    if (!isRecord(page)) {
      issues.push(addOnManifestIssue("addon_manifest_invalid", "add-on page must be an object", pagePath, roleSlotId));
      return;
    }
    if (!Array.isArray(page.sections) || page.sections.length === 0) {
      issues.push(addOnManifestIssue("addon_manifest_invalid", "add-on page must include sections", `${pagePath}.sections`, roleSlotId));
      return;
    }
    page.sections.forEach((section, sectionIndex) => {
      const sectionPath = `${pagePath}.sections.${sectionIndex}`;
      if (!isRecord(section)) {
        issues.push(addOnManifestIssue("addon_manifest_invalid", "add-on section must be an object", sectionPath, roleSlotId));
        return;
      }
      if (!Array.isArray(section.components) || section.components.length === 0) {
        issues.push(addOnManifestIssue("addon_manifest_invalid", "add-on section must include components", `${sectionPath}.components`, roleSlotId));
        return;
      }
      section.components.forEach((component, componentIndex) => {
        if (!isRecord(component)) {
          issues.push(addOnManifestIssue("addon_manifest_invalid", "add-on component must be an object", `${sectionPath}.components.${componentIndex}`, roleSlotId));
          return;
        }
        components.push(component as unknown as ParticipantAddOnManifestComponentDTO);
      });
    });
  });
  return { components, issues };
}

function collectAddOnManifestActions(
  manifest: ParticipantAddOnManifestDTO,
  path: string,
  roleSlotId: string,
  issues: StoreProductSchemaValidationIssueDTO[]
): readonly ParticipantAddOnManifestActionDTO[] {
  if (!Array.isArray(manifest.actions) || manifest.actions.length === 0) {
    issues.push(addOnManifestIssue("addon_manifest_invalid", "add-on manifest must include at least one action", `${path}.actions`, roleSlotId));
    return [];
  }
  const actions: ParticipantAddOnManifestActionDTO[] = [];
  manifest.actions.forEach((action, actionIndex) => {
    if (!isRecord(action)) {
      issues.push(addOnManifestIssue("addon_manifest_invalid", "add-on action must be an object", `${path}.actions.${actionIndex}`, roleSlotId));
      return;
    }
    actions.push(action as unknown as ParticipantAddOnManifestActionDTO);
  });
  return actions;
}

function validateAddOnManifestAction(
  action: ParticipantAddOnManifestActionDTO,
  inputIds: ReadonlySet<string>,
  path: string,
  roleSlotId: string
): readonly StoreProductSchemaValidationIssueDTO[] {
  const issues: StoreProductSchemaValidationIssueDTO[] = [];
  if (!action.actionId?.trim()) {
    issues.push(addOnManifestIssue("addon_manifest_invalid", "add-on actionId is required", `${path}.actions.actionId`, roleSlotId));
  }
  if (!isAddOnActionKind(action.actionKind)) {
    issues.push(addOnManifestIssue("addon_manifest_invalid", "add-on actionKind is unsupported", `${path}.actions.${action.actionId}.actionKind`, roleSlotId));
    return issues;
  }
  const requiredBindings = requiredActionBindings(action.actionKind);
  for (const binding of requiredBindings) {
    const inputId = action.inputBindings?.[binding];
    if (!inputId || !inputIds.has(inputId)) {
      issues.push(addOnManifestIssue(
        "addon_manifest_input_not_found",
        `add-on action ${action.actionKind} must bind ${binding} to a component inputId`,
        `${path}.actions.${action.actionId}.inputBindings.${binding}`,
        roleSlotId
      ));
    }
  }
  for (const [binding, inputId] of Object.entries(action.inputBindings ?? {})) {
    if (!inputIds.has(inputId)) {
      issues.push(addOnManifestIssue(
        "addon_manifest_input_not_found",
        `add-on action binding ${binding} references an unknown inputId`,
        `${path}.actions.${action.actionId}.inputBindings.${binding}`,
        roleSlotId
      ));
    }
  }
  if (action.actionKind === "stage_resource_patch") {
    for (const binding of ["writerWallet", "visibility"]) {
      if (Object.hasOwn(action.inputBindings ?? {}, binding)) {
        issues.push(addOnManifestIssue(
          "addon_manifest_invalid",
          `stage_resource_patch action must not bind ${binding}; selectorWallet is the canonical controller and visibility belongs in the resource manifest`,
          `${path}.actions.${action.actionId}.inputBindings.${binding}`,
          roleSlotId
        ));
      }
    }
  }
  return issues;
}

function addOnManifestIssue(
  code: "addon_manifest_invalid" | "addon_manifest_stage_not_bound" | "addon_manifest_input_not_found",
  message: string,
  path: string,
  roleSlotId: string
): StoreProductSchemaValidationIssueDTO {
  return {
    code,
    severity: "error",
    message,
    path,
    roleSlotId
  };
}

function stageExecutorSelectionIssue(
  message: string,
  path: string,
  stageId?: string
): StoreProductSchemaValidationIssueDTO {
  return {
    code: "stage_executor_selection_invalid",
    severity: "error",
    message,
    path,
    ...(stageId ? { stageId } : {})
  };
}

function validationForIssues(
  issues: readonly StoreProductSchemaValidationIssueDTO[],
  checkedAt?: string
): StoreProductSchemaValidationDTO {
  const hasMissing = issues.some((issue) =>
    issue.code === "missing_role_slot" ||
    issue.code === "slot_missing_capability_plugin" ||
    issue.code === "stage_not_covered" ||
    issue.message.includes("missing")
  );
  const hasInferred = issues.some((issue) => issue.code === "capability_plugin_not_explicit");
  return {
    ok: !issues.some((issue) => issue.severity === "error"),
    status: hasMissing ? "missing" : hasInferred ? "inferred" : "explicit",
    issues,
    ...(checkedAt ? { checkedAt } : {})
  };
}

function errorsFromCompileError(error: unknown): readonly StoreDraftErrorDTO[] {
  const issues = isIssueListError(error) ? error.issues : undefined;
  if (issues && issues.length > 0) {
    return issues.map((issue) => typeof issue === "string"
      ? { code: "compile_error", message: issue }
      : { code: "compile_error", message: issue.message, path: issue.path });
  }
  return [{ code: "compile_error", message: errorMessage(error) }];
}

async function toDraftDTO(
  draft: StoreZhixuDraftRecord,
  projectionStore: ProjectionStore
): Promise<StoreZhixuDraftDTO> {
  const published = draft.compilePreview
    ? await hasPublishedPlan(draft, projectionStore)
    : false;
  const status = published ? "active" : draft.status;

  return {
    draftId: draft.draftId,
    status,
    ...(draft.zhixuId ? { zhixuId: draft.zhixuId } : {}),
    title: draft.title,
    maintainer: draft.maintainer,
    ...(draft.compilePreview ? { compilePreview: draft.compilePreview } : {}),
    ...(draft.productSchema ? { productSchema: draft.productSchema } : {}),
    ...(draft.reviewId ? { reviewId: draft.reviewId } : {}),
    errors: draft.errors,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt
  };
}

async function hasPublishedPlan(
  draft: StoreZhixuDraftRecord & { readonly compilePreview?: StoreCompilePreviewDTO },
  projectionStore: ProjectionStore
): Promise<boolean> {
  if (!draft.compilePreview) {
    return false;
  }
  const snapshot = await projectionStore.getOrderSnapshot();
  return Object.values(snapshot.stateMachinePlans).some(
    (plan) =>
      plan.planId === draft.compilePreview?.planId &&
      plan.planHash === draft.compilePreview.planHash
  );
}

function draftStatusFromReviewStatus(status: GovernanceReviewStatus): StoreZhixuDraftStatus {
  switch (status) {
    case "draft":
    case "submitted":
      return "submitted_for_review";
    case "approved_for_broadcast":
    case "approved":
    case "restricted":
      return "approved_for_broadcast";
    case "rejected":
      return "rejected";
    case "revoked":
      return "revoked";
  }
}

function reviewMetadataForDraft(draft: StoreZhixuDraftRecord & { readonly compilePreview: StoreCompilePreviewDTO }): unknown {
  return {
    source: "store_zhixu_draft",
    draftId: draft.draftId,
    zhixuId: draft.zhixuId ?? null,
    title: draft.title,
    maintainer: draft.maintainer,
    tags: draft.tags,
    compilePreview: draft.compilePreview,
    productSchemaHash: draft.productSchema?.schemaHash ?? null,
    productSchemaValidation: draft.productSchema?.validation ?? null
  };
}

function reviewPolicyForDraft(draft: StoreZhixuDraftRecord & {
  readonly compilePreview: StoreCompilePreviewDTO;
  readonly productSchema: StoreProductSchemaDTO;
}): unknown {
  return {
    workflow: "store_zhixu_import_compile_review_publish",
    sourceKind: draft.sourceKind,
    planId: draft.compilePreview.planId,
    planHash: draft.compilePreview.planHash,
    artifactHash: draft.compilePreview.artifactHash,
    productSchemaHash: draft.productSchema.schemaHash,
    productSchemaStatus: draft.productSchema.validation.status,
    businessSignaturesCreated: false
  };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new StoreZhixuDraftWorkflowError(400, "invalid_request_body", `${label} must be an object`);
  }
  return value;
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new StoreZhixuDraftWorkflowError(400, "invalid_request_body", `${key} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new StoreZhixuDraftWorkflowError(400, "invalid_request_body", `${key} must be a string`);
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function optionalStringArray(record: Record<string, unknown>, key: string): readonly string[] | undefined {
  const value = record[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new StoreZhixuDraftWorkflowError(400, "invalid_request_body", `${key} must be a string array`);
  }
  return value.map((item) => item.trim()).filter((item) => item.length > 0);
}

function optionalRecordString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function optionalCreateOrderTrigger(
  record: Record<string, unknown>,
  fallback?: StoreProductSchemaDTO["createOrderTrigger"]
): StoreProductSchemaDTO["createOrderTrigger"] {
  if (!Object.hasOwn(record, "createOrderTrigger")) {
    return fallback;
  }
  const value = record.createOrderTrigger;
  if (value === undefined || value === null) {
    return undefined;
  }
  const trigger = requireRecord(value, "createOrderTrigger");
  return {
    source: stringField(trigger, "source"),
    signalName: requiredString(trigger, "signalName"),
    triggerHookId: requiredString(trigger, "triggerHookId"),
    triggerStageId: requiredString(trigger, "triggerStageId"),
    ...optionalNonEmptyStringField(trigger, "submitterRoleSlotId")
  };
}

function optionalNonEmptyStringField(record: Record<string, unknown>, key: string): Record<string, string> {
  const value = record[key];
  if (value === undefined || value === null) {
    return {};
  }
  if (typeof value !== "string") {
    throw new StoreZhixuDraftWorkflowError(400, "invalid_product_schema", `${key} must be a string`);
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? { [key]: trimmed } : {};
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new StoreZhixuDraftWorkflowError(400, "invalid_request_body", `${key} must be a string`);
  }
  return value.trim();
}

function arrayField<TValue>(
  record: Record<string, unknown>,
  key: string,
  fallback?: () => readonly TValue[]
): readonly TValue[] {
  const value = record[key];
  if (value === undefined || value === null) {
    if (fallback) {
      return fallback();
    }
    throw new StoreZhixuDraftWorkflowError(400, "invalid_product_schema", `${key} must be an array`);
  }
  if (!Array.isArray(value)) {
    throw new StoreZhixuDraftWorkflowError(400, "invalid_product_schema", `${key} must be an array`);
  }
  return value as readonly TValue[];
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new StoreZhixuDraftWorkflowError(400, "invalid_product_schema", `${key} must be a positive integer`);
  }
  return value;
}

function isGovernanceReviewStatus(value: string): value is GovernanceReviewStatus {
  return (
    value === "draft" ||
    value === "submitted" ||
    value === "approved_for_broadcast" ||
    value === "approved" ||
    value === "restricted" ||
    value === "rejected" ||
    value === "revoked"
  );
}

function inferPluginKind(stageId: string): FulfillmentPluginKind {
  const normalized = stageId.toLowerCase();
  if (normalized.includes("pay") || normalized.includes("fund") || normalized.includes("settle")) {
    return "payment_placeholder";
  }
  if (normalized.includes("delivery") || normalized.includes("ship") || normalized.includes("logistic") || normalized.includes("custom")) {
    return "delivery_update";
  }
  if (normalized.includes("valid") || normalized.includes("inspect") || normalized.includes("accept")) {
    return "validation_confirm";
  }
  if (normalized.includes("dispute") || normalized.includes("claim")) {
    return "dispute_material";
  }
  return "evidence_submission";
}

function primaryActionForPlugin(kind: FulfillmentPluginKind): string {
  switch (kind) {
    case "payment_placeholder":
      return "确认付款条件";
    case "delivery_update":
      return "提交交付进度";
    case "validation_confirm":
      return "确认验收结果";
    case "dispute_material":
      return "提交争议材料";
    case "evidence_submission":
      return "提交阶段凭证";
  }
}

function addOnKindForPlugin(kind: FulfillmentPluginKind): ParticipantAddOnKind {
  switch (kind) {
    case "payment_placeholder":
    case "validation_confirm":
    case "dispute_material":
    case "delivery_update":
    case "evidence_submission":
      return "submit_signal";
  }
}

function componentRequiresInput(component: ParticipantAddOnManifestComponentDTO): boolean {
  return component.componentKind !== "resource_requirements" && component.componentKind !== "proof_rows";
}

function requiredActionBindings(actionKind: ParticipantAddOnManifestActionDTO["actionKind"]): readonly string[] {
  switch (actionKind) {
    case "submit_signal":
      return ["walletAddress", "evidenceIds", "confirmation"];
    case "stage_executor_patch":
      return ["selectorWallet", "targetStageId", "executorWallet", "executorMetadataHash", "metadataURI"];
    case "stage_resource_patch":
      return ["selectorWallet", "targetStageId", "resourceKey", "manifestURI", "manifestHash", "policyHash"];
  }
}

function isParticipantAddOnKind(value: unknown): value is ParticipantAddOnKind {
  return value === "submit_signal" || value === "stage_executor_patch" || value === "stage_resource_patch";
}

function isAddOnActionKind(value: unknown): value is ParticipantAddOnManifestActionDTO["actionKind"] {
  return value === "submit_signal" || value === "stage_executor_patch" || value === "stage_resource_patch";
}

function isAddOnComponentKind(value: unknown): value is ParticipantAddOnManifestComponentDTO["componentKind"] {
  return value === "text" ||
    value === "textarea" ||
    value === "wallet" ||
    value === "uri" ||
    value === "hash" ||
    value === "select" ||
    value === "confirmation" ||
    value === "stage_select" ||
    value === "evidence_refs" ||
    value === "resource_requirements" ||
    value === "proof_rows";
}

function defaultEvidenceLabel(stageId: string): string {
  return `${displayStageLabel(stageId)}凭证`;
}

function displayStageLabel(stageId: string): string {
  const last = stageId.split(".").filter(Boolean).at(-1) ?? stageId;
  return last
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function safeId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "stage";
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return Array.from(new Set(values.filter((value) => value.trim().length > 0))).sort();
}

function hexOrTextEquals(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIssueListError(error: unknown): error is { readonly issues: readonly (string | { readonly path: string; readonly message: string })[] } {
  return (
    isRecord(error) &&
    Array.isArray(error.issues) &&
    error.issues.every((issue) =>
      typeof issue === "string" ||
      (isRecord(issue) && typeof issue.path === "string" && typeof issue.message === "string")
    )
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
