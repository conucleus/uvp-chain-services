import { randomUUID } from "node:crypto";
import {
  assertOnchainHookPlanArtifact,
  capabilityTablesOf,
  compileZhixuOnchainHookPlan,
  displayIdentity,
  hashCanonical,
  ONCHAIN_HOOK_PLAN_SCHEMA_VERSION,
  parseZhixuDefinition,
  planIdForPublisher,
  toSolidityRegisterPlanArgs,
  type OnchainHookPlanArtifact,
  type OnchainSignalInstruction
} from "@uvp-eth/compiler";
import {
  type StoreProductSchemaDTO,
  type StoreProductSchemaSelectorBindingDTO,
  type StoreProductSchemaValidationDTO,
  type StoreProductSchemaValidationIssueDTO,
  type ZhixuStageDTO,
} from "@uvp-eth/product-dto";
import type {
  GovernancePrincipal,
  GovernanceReviewResultDTO,
  GovernanceReviewStatus,
  GovernanceService
} from "../../governance/index.js";
import type { ProjectionStore } from "../../storage/projection-store.js";
import type { Address, Hex } from "../../shared/types.js";
import { buildV3PublishMetadata, type V3PublishMetadata } from "../../v3/store-publishing.js";
import type { PlanCapabilityTablesInput } from "../../indexer/projections/plan.js";
import type { SemanticOraclePlan } from "../../indexer/semantic-oracle.js";
import { isPlanRegisteredProjection } from "./version.js";

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
}

export interface StoreZhixuDraftDTO {
  readonly draftId: string;
  readonly status: StoreZhixuDraftStatus;
  readonly zhixuId?: string;
  readonly zhixuDisplay?: string;
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
  readonly publisherAddress: `0x${string}`;
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
    planHash: string
  ): Promise<StoreProductSchemaDTO | undefined>;
  updateDraft(draft: StoreZhixuDraftRecord): Promise<void>;
}

export function createPlanCapabilityTablesResolver(
  draftStore: StoreZhixuDraftStore
): (planId: Hex, planHash: Hex) => Promise<PlanCapabilityTablesInput | undefined> {
  return async (planId, planHash) => {
    const schema = await draftStore.findProductSchemaByPlan(planId, planHash);
    if (!schema) {
      return undefined;
    }
    const artifact = schema.onchainHookPlanArtifact as
      | Parameters<typeof capabilityTablesOf>[0]
      | undefined;
    if (
      !artifact ||
      !Array.isArray(artifact.selectorBindings) ||
      !Array.isArray(artifact.signalCapabilities)
    ) {
      throw new Error(
        `product schema for plan ${planId} carries no usable onchainHookPlanArtifact; a missing or malformed artifact is a validation failure, not an empty vocabulary (fail-closed)`
      );
    }
    return {
      planId,
      planHash,
      ...capabilityTablesOf(artifact),
      ...executorCandidatesFromArtifact(artifact),
    };
  };
}

function executorCandidatesFromArtifact(
  artifact: Parameters<typeof capabilityTablesOf>[0],
): { readonly executorCandidates?: NonNullable<PlanCapabilityTablesInput["executorCandidates"]> } {
  const raw = (artifact as { readonly executorCandidates?: unknown }).executorCandidates;
  if (!Array.isArray(raw)) {
    return {};
  }
  const candidates: { readonly stageId: Hex; readonly executor: Address }[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return {};
    }
    const record = entry as { readonly stageId?: unknown; readonly executor?: unknown };
    if (typeof record.stageId !== "string" || typeof record.executor !== "string") {
      return {};
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(record.stageId) || !/^0x[0-9a-fA-F]{40}$/.test(record.executor)) {
      return {};
    }
    candidates.push({
      stageId: record.stageId.toLowerCase() as Hex,
      executor: record.executor.toLowerCase() as Address,
    });
  }
  return { executorCandidates: candidates };
}

export function createSemanticOraclePlanResolver(
  draftStore: StoreZhixuDraftStore
): (planId: Hex, planHash: Hex) => Promise<SemanticOraclePlan | undefined> {
  return async (planId, planHash) => {
    const schema = await draftStore.findProductSchemaByPlan(planId, planHash);
    if (!schema) {
      return undefined;
    }
    const plan = semanticOraclePlanFromArtifact(
      planId,
      schema.zhixuId,
      schema.onchainHookPlanArtifact
    );
    if (!plan) {
      throw new Error(
        `product schema for plan ${planId} carries an unusable onchainHookPlanArtifact for semantic verification; the plan is not silently excluded (fail-closed)`
      );
    }
    return plan;
  };
}

function semanticOraclePlanFromArtifact(
  planId: Hex,
  zhixuId: string | undefined,
  artifact: unknown
): SemanticOraclePlan | undefined {
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
    return undefined;
  }
  const record = artifact as Record<string, unknown>;
  if (record.schemaVersion !== ONCHAIN_HOOK_PLAN_SCHEMA_VERSION) {
    throw new Error(
      `onchainHookPlanArtifact for plan ${planId} carries schemaVersion ${String(record.schemaVersion)}; the semantic oracle consumer only interprets ${ONCHAIN_HOOK_PLAN_SCHEMA_VERSION}`
    );
  }
  const rawHooks = record.compiledHooks;
  const rawDependencyIndex = record.dependencyIndex;
  if (!Array.isArray(rawHooks) || rawHooks.length === 0) {
    return undefined;
  }
  if (!rawDependencyIndex || typeof rawDependencyIndex !== "object" || Array.isArray(rawDependencyIndex)) {
    return undefined;
  }
  const compiledHooks: SemanticOraclePlan["compiledHooks"][number][] = [];
  for (const rawHook of rawHooks) {
    if (!rawHook || typeof rawHook !== "object" || Array.isArray(rawHook)) {
      return undefined;
    }
    const hook = rawHook as Record<string, unknown>;
    if (typeof hook.hookId !== "string" || !Array.isArray(hook.instructions)) {
      return undefined;
    }
    compiledHooks.push({
      hookId: hook.hookId as Hex,
      ...(typeof hook.stageId === "string" ? { stageId: hook.stageId as Hex } : {}),
      ...(typeof hook.stageIdentifier === "string" ? { stageIdentifier: hook.stageIdentifier } : {}),
      ...(typeof hook.hookName === "string" ? { hookName: hook.hookName } : {}),
      ...(hook.orderTriggerKind === "none" || hook.orderTriggerKind === "mint" || hook.orderTriggerKind === "dock"
        ? { orderTriggerKind: hook.orderTriggerKind }
        : {}),
      ...(typeof hook.emitReady === "boolean" ? { emitReady: hook.emitReady } : {}),
      instructions: hook.instructions.filter(
        (instruction): instruction is Record<string, unknown> =>
          Boolean(instruction) && typeof instruction === "object" && !Array.isArray(instruction)
      )
    });
  }
  const dependencyIndex: Record<string, readonly unknown[]> = {};
  for (const [key, targets] of Object.entries(rawDependencyIndex)) {
    if (!Array.isArray(targets)) {
      return undefined;
    }
    dependencyIndex[key] = targets;
  }
  const admissions = semanticOracleAdmissionsOf(record.admissions);
  return {
    planId,
    zhixuId: zhixuId && zhixuId.length > 0 ? zhixuId : planId,
    compiledHooks,
    dependencyIndex,
    ...(admissions ? { admissions } : {})
  };
}

function semanticOracleAdmissionsOf(raw: unknown): SemanticOraclePlan["admissions"] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const admissions: NonNullable<SemanticOraclePlan["admissions"]>[number][] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return undefined;
    }
    const admission = entry as Record<string, unknown>;
    admissions.push({
      ...(typeof admission.admissionId === "string" ? { admissionId: admission.admissionId as Hex } : {}),
      ...(typeof admission.stageIdentifier === "string" ? { stageIdentifier: admission.stageIdentifier } : {}),
      ...(typeof admission.signalName === "string" ? { signalName: admission.signalName } : {}),
      ...(Array.isArray(admission.instructions)
        ? {
          instructions: admission.instructions.filter(
            (instruction): instruction is Record<string, unknown> =>
              Boolean(instruction) && typeof instruction === "object" && !Array.isArray(instruction)
          )
        }
        : {})
    });
  }
  return admissions;
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
    planHash: string
  ): Promise<StoreProductSchemaDTO | undefined> {
    return Array.from(this.#drafts.values())
      .map((draft) => draft.productSchema)
      .filter((schema): schema is StoreProductSchemaDTO => Boolean(schema))
      .filter((schema) =>
        hexOrTextEquals(schema.planId, planId) &&
        hexOrTextEquals(schema.planHash, planHash)
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
  importDraft(input: unknown, publisherAddress: `0x${string}`): Promise<StoreZhixuDraftDTO>;
  getDraft(draftId: string): Promise<StoreZhixuDraftDTO | undefined>;
  compilePreview(draftId: string): Promise<StoreZhixuDraftDTO>;
  getPublishMetadata(draftId: string): Promise<V3PublishMetadata | undefined>;
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
    async importDraft(input, publisherAddress) {
      const request = parseImportRequest(input);
      if (request.sourceKind === "onchain_hook_plan_manifest") {
        const serviceAnchor = tryCompileManifestServiceAnchor(request.content);
        if (serviceAnchor) {
          await assertPlanAnchorNotInService(serviceAnchor.planId, serviceAnchor.planHash, options.projectionStore);
        }
      }
      if (request.sourceKind === "zhixu_yaml" && !publisherAddress) {
        throw new StoreZhixuDraftWorkflowError(400, "publisher_required", "zhixu_yaml import requires an anchored publisher address");
      }
      const timestamp = now().toISOString();
      const draft: StoreZhixuDraftRecord = {
        draftId: draftIdFactory(),
        sourceKind: request.sourceKind,
        content: request.content,
        publisherAddress,
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
      if (compiled.ok) {
        await assertDraftSchemaMutable(draft, options.projectionStore);
        await assertDraftSchemaMutable(
          { ...draft, compilePreview: compiled.preview },
          options.projectionStore
        );
      }
      const updated: StoreZhixuDraftRecord = compiled.ok
        ? {
            ...draft,
            status: "compiled",
            zhixuId: compiled.zhixuId,
            zhixuDisplay: compiled.zhixuDisplay,
            title: draft.title === "未命名秩序草稿" ? compiled.title : draft.title,
            compilePreview: compiled.preview,
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

    async getPublishMetadata(draftId) {
      const draft = await requireDraft(draftStore, draftId);
      const preview = draft.compilePreview;
      if (!preview) {
        return undefined;
      }
      return buildV3PublishMetadata({
        config: {
          configId: draft.zhixuId ?? preview.planId,
          version: String(draft.productSchema?.version ?? 1),
        },
        planId: preview.planId as `0x${string}`,
        planHash: preview.planHash as `0x${string}`,
      });
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
} {
  if (draft.status === "compile_failed") {
    throw new StoreZhixuDraftWorkflowError(409, "compile_failed", "compile errors must be fixed before review", draft.errors);
  }
  if (!draft.compilePreview) {
    throw new StoreZhixuDraftWorkflowError(409, "compile_preview_required", "compile preview is required before review");
  }
}

async function assertDraftSchemaMutable(
  draft: StoreZhixuDraftRecord,
  projectionStore: ProjectionStore
): Promise<void> {
  if (draft.status === "active") {
    throw new StoreZhixuDraftWorkflowError(
      409,
      "product_schema_new_version_required",
      "active product schema cannot be changed in place; create a new draft version"
    );
  }
  if (await hasPublishedPlan(draft, projectionStore)) {
    throw new StoreZhixuDraftWorkflowError(
      409,
      "product_schema_new_version_required",
      "this draft anchors a published plan; its product schema cannot be changed in place (create a new draft version)"
    );
  }
}

async function assertPlanAnchorNotInService(
  planId: string,
  planHash: string,
  projectionStore: ProjectionStore
): Promise<void> {
  const snapshot = await projectionStore.getOrderSnapshot();
  const inService = Object.values(snapshot.stateMachinePlans).some(
    (plan) =>
      plan.planId.toLowerCase() === planId.toLowerCase() &&
      plan.planHash.toLowerCase() === planHash.toLowerCase() &&
      isPlanRegisteredProjection(plan)
  );
  if (inService) {
    throw new StoreZhixuDraftWorkflowError(
      409,
      "plan_already_in_service",
      "the imported manifest anchors a plan that is already published and in service; its product schema is immutable and cannot be re-derived by import (create a new draft version instead)"
    );
  }
}

function tryCompileManifestServiceAnchor(raw: string): { readonly planId: string; readonly planHash: string } | undefined {
  try {
    const artifact = compileManifest(raw);
    return {
      planId: artifact.planId,
      planHash: toSolidityRegisterPlanArgs(artifact).planHash
    };
  } catch {
    return undefined;
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
  readonly zhixuDisplay: string;
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
      zhixuDisplay: displayIdentity(onchain.zhixuName, onchain.zhixuId),
      title: onchain.zhixuName,
      preview: previewFromOnchainArtifact(
        onchain,
        draft.sourceKind === "zhixu_yaml" ? draft.publisherAddress : undefined
      ),
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
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`manifest content must be valid JSON: ${errorMessage(error)}`);
  }

  assertOnchainHookPlanArtifact(parsed);
  return parsed as OnchainHookPlanArtifact;
}

function previewFromOnchainArtifact(
  artifact: OnchainHookPlanArtifact,
  publisherAddress?: `0x${string}`
): StoreCompilePreviewDTO {
  const planHash = toSolidityRegisterPlanArgs(artifact).planHash;
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
    planId: publisherAddress ? planIdForPublisher(publisherAddress, planHash) : artifact.planId,
    planHash,
    artifactHash: artifact.planHash,
    stageCount: stages.size,
    roleSlotCount: artifact.executorRoutes.length,
    sourceCount: sources.size,
    signalCount: signals.size
  };
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

function validationForIssues(
  issues: readonly StoreProductSchemaValidationIssueDTO[],
  checkedAt?: string
): StoreProductSchemaValidationDTO {
  return {
    ok: !issues.some((issue) => issue.severity === "error"),
    status: "explicit",
    issues,
    ...(checkedAt ? { checkedAt } : {}),
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
    ...(draft.zhixuDisplay ? { zhixuDisplay: draft.zhixuDisplay } : {}),
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
      plan.planHash === draft.compilePreview.planHash &&
      isPlanRegisteredProjection(plan)
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
    compilePreview: draft.compilePreview
  };
}

function reviewPolicyForDraft(draft: StoreZhixuDraftRecord & {
  readonly compilePreview: StoreCompilePreviewDTO;
}): unknown {
  return {
    workflow: "store_zhixu_import_compile_review_publish",
    sourceKind: draft.sourceKind,
    planId: draft.compilePreview.planId,
    planHash: draft.compilePreview.planHash,
    artifactHash: draft.compilePreview.artifactHash,
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

function invalidSchemaType(message: string): StoreZhixuDraftWorkflowError {
  return new StoreZhixuDraftWorkflowError(400, "invalid_product_schema", message);
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
