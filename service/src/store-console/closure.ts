import type { StoreProductSchemaDTO } from "@uvp-eth/product-dto";
import {
  createGovernanceService,
  type GovernancePrincipal,
} from "../governance/index.js";
import type { ProductOrderApiDTO, ProductService } from "../product/service.js";
import type { ProjectionStore } from "../storage/projection-store.js";
import {
  createStoreSupplierService,
  InMemoryStoreSupplierMetadataStore,
} from "../store-suppliers/service.js";
import type { Address, Hex } from "../shared/types.js";
import {
  hasStoreCapability,
  storeSessionFromAccess,
  type StoreAccessState,
  type StoreCapability,
  type StoreSessionDTO,
} from "./access.js";
import type { StoreAuditStore } from "./audit.js";
import {
  createStoreDockingService,
  MemoryStoreDockingSessionStore,
} from "./docking.js";
import type { StoreRuntimeService } from "./runtime.js";
import type { StoreConsoleService } from "./service.js";
import {
  createStoreZhixuDraftWorkflowService,
  MemoryStoreZhixuDraftStore,
} from "./zhixu-drafts.js";

export type StoreClosureCheckStatus =
  | "passed"
  | "blocked"
  | "skipped"
  | "failed"
  | "warning";
export type StoreClosureEvidenceClassification =
  | "dry_run"
  | "projection"
  | "workflow_metadata"
  | "prototype"
  | "external_identity";

export interface StoreClosureCheckDTO {
  readonly key: string;
  readonly label: string;
  readonly status: StoreClosureCheckStatus;
  readonly classification: StoreClosureEvidenceClassification;
  readonly nonAuthoritative: true;
  readonly sourceOfTruth:
    | "contracts-and-chain-events"
    | "store-workflow-metadata";
  readonly requiredCapabilities?: readonly StoreCapability[];
  readonly missingCapabilities?: readonly StoreCapability[];
  readonly details?: Readonly<Record<string, unknown>>;
  readonly message?: string;
}

export interface StoreClosureDryRunSummaryDTO {
  readonly mode: "store_console_closure_dry_run";
  readonly generatedAt: string;
  readonly ok: boolean;
  readonly dryRun: true;
  readonly nonAuthoritative: true;
  readonly sourceOfTruth: "contracts-and-chain-events";
  readonly authorityNotice: string;
  readonly releaseClassification: "prototype" | "verified";
  readonly prototypeReasons: readonly string[];
  readonly session: StoreSessionDTO;
  readonly authorityBoundaries: {
    readonly dockingDraftPublishesZhixu: false;
    readonly auditCreatesProtocolFacts: false;
    readonly backendCanCreateBusinessSignatures: false;
    readonly trustSourceOfTruth: "UVPIdentityRegistry events and UVPStateMachine events";
  };
  readonly checks: readonly StoreClosureCheckDTO[];
  readonly diagnostics: {
    readonly runtimeEnvironment: string;
    readonly evidenceStorage: unknown;
    readonly storeMetadata: unknown;
    readonly indexer: unknown;
  };
}

export interface StoreClosureDryRunOptions {
  readonly access: StoreAccessState;
  readonly productService: ProductService;
  readonly projectionStore: ProjectionStore;
  readonly storeConsoleService: StoreConsoleService;
  readonly storeRuntimeService: StoreRuntimeService;
  readonly storeAuditStore: StoreAuditStore;
  readonly buildDiagnostics: () => Promise<Record<string, unknown>>;
  readonly now?: () => Date;
}

const CLOSURE_DRY_RUN_ZHIXU_YAML = `
apiVersion: uvp/v0
kind: Zhixu
metadata:
  name: store-closure-dry-run
  uid: store-closure-dry-run-001
  annotations:
    version: "1"
spec:
  platform:
    type: blockchain
    provider: eth
  nucleation:
    id: store-closure
  taskPatterns:
    - name: order
      stages:
        - name: intake
          source: buyer
          sendSignals: ["cmp"]
          executor:
            supplierType: organization
            supplierID: closure-ops
`;

const CLOSURE_SUPPLIER_SUBJECT_ID =
  "0x0000000000000000000000000000000000000000000000000000000000011601" as Hex;
const CLOSURE_SUPPLIER_WALLET =
  "0x1160000000000000000000000000000000000001" as Address;
const CLOSURE_REGISTRY_ADDRESS =
  "0x1160000000000000000000000000000000000011" as Address;

export async function buildStoreClosureDryRunSummary(
  options: StoreClosureDryRunOptions,
): Promise<StoreClosureDryRunSummaryDTO> {
  const now = options.now ?? (() => new Date());
  const generatedAt = now().toISOString();
  const diagnostics = await safeDiagnostics(options.buildDiagnostics);
  const checks: StoreClosureCheckDTO[] = [];

  checks.push(sessionCheck(options.access, diagnostics));
  checks.push(
    await runCheck(
      {
        key: "search_detail",
        label: "Store search/detail projection",
        classification: "projection",
        sourceOfTruth: "contracts-and-chain-events",
      },
      () => checkSearchDetail(options.storeConsoleService),
    ),
  );
  checks.push(await checkDraftImportCompileReview(options));
  checks.push(await checkSupplierTagAuditReadback(options));
  checks.push(await checkDockingCreateValidateSave(options));
  checks.push(await checkRuntimeProofAudit(options));
  checks.push(await checkAuditReadiness(options));

  const prototypeReasons = prototypeReasonsFor({
    access: options.access,
    checks,
    diagnostics,
  });
  return {
    mode: "store_console_closure_dry_run",
    generatedAt,
    ok: checks.every((check) => check.status !== "failed"),
    dryRun: true,
    nonAuthoritative: true,
    sourceOfTruth: "contracts-and-chain-events",
    authorityNotice:
      "Store metadata, audit rows, dry-run drafts, and docking sessions are workflow/projection evidence only; plan, supplier, order, signal, hook, and proof truth remains on chain.",
    releaseClassification:
      prototypeReasons.length === 0 ? "verified" : "prototype",
    prototypeReasons,
    session: storeSessionFromAccess(options.access),
    authorityBoundaries: {
      dockingDraftPublishesZhixu: false,
      auditCreatesProtocolFacts: false,
      backendCanCreateBusinessSignatures: false,
      trustSourceOfTruth:
        "UVPIdentityRegistry events and UVPStateMachine events",
    },
    checks,
    diagnostics: {
      runtimeEnvironment: runtimeEnvironmentFromDiagnostics(diagnostics),
      evidenceStorage: recordOf(diagnostics.evidenceStorage) ?? {},
      storeMetadata: recordOf(diagnostics.storeMetadata) ?? {},
      indexer: recordOf(diagnostics.indexer) ?? {},
    },
  };
}

function sessionCheck(
  access: StoreAccessState,
  diagnostics: Record<string, unknown>,
): StoreClosureCheckDTO {
  const storeAuth = recordOf(diagnostics.storeAuth);
  const externalIdentityEvidence = storeAuth?.externalIdentityEvidence === true;
  const evidenceClassification =
    typeof storeAuth?.evidenceClassification === "string"
      ? storeAuth.evidenceClassification
      : access.authMode === "jwt"
        ? "not_verified"
        : "prototype";
  return {
    key: "session",
    label: "Store operator session",
    status: access.principalId ? "passed" : "blocked",
    classification:
      access.authMode === "jwt" && externalIdentityEvidence
        ? "external_identity"
        : "prototype",
    nonAuthoritative: true,
    sourceOfTruth: "store-workflow-metadata",
    details: {
      authenticated: Boolean(access.principalId),
      accessLevel: access.level,
      authMode: access.authMode,
      capabilityCount: access.capabilities.length,
      jwtIdentityEvidence: access.authMode === "jwt",
      externalOidcEvidence: externalIdentityEvidence,
      storeAuthEvidenceClassification: evidenceClassification,
      storeAuthKeySource:
        typeof storeAuth?.keySource === "string"
          ? storeAuth.keySource
          : "missing",
      externalOidcEvidenceNote:
        "The dry-run cannot prove a non-local issuer/JWKS endpoint; staging evidence must validate Store auth config.",
      localPilotPrototype:
        access.authMode !== "jwt" || !externalIdentityEvidence,
    },
    ...(access.principalId
      ? {}
      : {
          message:
            access.authenticationFailure?.message ??
            "Store identity is missing",
        }),
  };
}

async function checkSearchDetail(
  storeConsoleService: StoreConsoleService,
): Promise<StoreClosureCheckDTO> {
  const [list, search] = await Promise.all([
    storeConsoleService.listZhixus({
      lifecycle: "all",
      review: "all",
      publication: "all",
    }),
    storeConsoleService.search({ query: "", type: "all", limit: 5 }),
  ]);
  const first = list.zhixus[0];
  const detail = first
    ? await storeConsoleService.getZhixu(first.zhixuId)
    : undefined;
  if (!first) {
    return check({
      key: "search_detail",
      label: "Store search/detail projection",
      status: "skipped",
      classification: "projection",
      sourceOfTruth: "contracts-and-chain-events",
      message: "No zhixu projection is available for detail readback.",
      details: {
        resultCount: search.resultCount,
        totalZhixus: list.summary.totalZhixus,
      },
    });
  }
  return check({
    key: "search_detail",
    label: "Store search/detail projection",
    status: detail ? "passed" : "warning",
    classification: "projection",
    sourceOfTruth: "contracts-and-chain-events",
    details: {
      resultCount: search.resultCount,
      totalZhixus: list.summary.totalZhixus,
      detailZhixuId: first.zhixuId,
      detailFound: Boolean(detail),
      planPublicationStatus: first.planPublication.status,
    },
  });
}

async function checkDraftImportCompileReview(
  options: StoreClosureDryRunOptions,
): Promise<StoreClosureCheckDTO> {
  // store.draft.review 是治理级能力（submit-review 要求 governance
  // admin）；operator dry-run 覆盖 import/compile/schema，review 子步骤
  // 用 dry-run 治理身份在一次性模拟治理服务上演练，不触碰真实治理记录。
  const required = [
    "store.draft.import",
    "store.draft.compile",
    "store.draft.schema.save",
  ] as const satisfies readonly StoreCapability[];
  const missing = missingCapabilities(options.access, required);
  if (missing.length > 0) {
    return blockedCapabilityCheck(
      "draft_import_compile_review",
      "Draft import/compile/review dry-run",
      required,
      missing,
    );
  }

  return runCheck(
    {
      key: "draft_import_compile_review",
      label: "Draft import/compile/review dry-run",
      classification: "workflow_metadata",
      sourceOfTruth: "store-workflow-metadata",
      requiredCapabilities: required,
    },
    async () => {
      const draftWorkflow = createStoreZhixuDraftWorkflowService({
        draftStore: new MemoryStoreZhixuDraftStore(),
        governanceService: createGovernanceService({
          ...(options.now ? { now: options.now } : {}),
        }),
        projectionStore: options.projectionStore,
        ...(options.now ? { now: options.now } : {}),
        draftIdFactory: () => "zhixu_draft_closure_dry_run",
      });
      const imported = await draftWorkflow.importDraft({
        sourceKind: "zhixu_yaml",
        content: CLOSURE_DRY_RUN_ZHIXU_YAML,
        title: "Store closure dry-run draft",
        maintainer: "Store Console dry-run",
      });
      const compiled = await draftWorkflow.compilePreview(imported.draftId);
      if (!compiled.compilePreview) {
        return check({
          key: "draft_import_compile_review",
          label: "Draft import/compile/review dry-run",
          status: "failed",
          classification: "workflow_metadata",
          sourceOfTruth: "store-workflow-metadata",
          requiredCapabilities: required,
          message: "Compile preview did not produce a deterministic artifact.",
          details: {
            draftId: imported.draftId,
            status: compiled.status,
            errorCount: compiled.errors.length,
          },
        });
      }
      const productSchema = await draftWorkflow.getProductSchema(
        imported.draftId,
      );
      const explicitSchema = productSchema
        ? explicitProductSchema(productSchema)
        : undefined;
      const validation = explicitSchema
        ? (
            await draftWorkflow.updateProductSchema(imported.draftId, {
              productSchema: explicitSchema,
            })
          ).validation
        : await draftWorkflow.validateProductSchema(imported.draftId);
      const reviewed = validation.ok
        ? await draftWorkflow.submitReview(
            imported.draftId,
            {
              status: "approved_for_broadcast",
              publicSummary: "Store closure dry-run review.",
            },
            dryRunGovernancePrincipal(options.access),
          )
        : undefined;

      return check({
        key: "draft_import_compile_review",
        label: "Draft import/compile/review dry-run",
        status: validation.ok && reviewed ? "passed" : "warning",
        classification: "workflow_metadata",
        sourceOfTruth: "store-workflow-metadata",
        requiredCapabilities: required,
        details: {
          draftId: imported.draftId,
          draftStatus: reviewed?.draft.status ?? compiled.status,
          planId: compiled.compilePreview.planId,
          planHash: compiled.compilePreview.planHash,
          artifactHash: compiled.compilePreview.artifactHash,
          schemaValidationOk: validation.ok,
          reviewId: reviewed?.review.reviewId,
          nonPublishing: true,
        },
      });
    },
  );
}

async function checkSupplierTagAuditReadback(
  options: StoreClosureDryRunOptions,
): Promise<StoreClosureCheckDTO> {
  const required = [
    "store.supplier.create",
    "store.supplier.review",
    "store.supplier.tags.update",
    "store.audit.read",
  ] as const satisfies readonly StoreCapability[];
  const missing = missingCapabilities(options.access, required);
  if (missing.length > 0) {
    return blockedCapabilityCheck(
      "supplier_tag_audit_readback",
      "Supplier capability tag audit readback",
      required,
      missing,
    );
  }

  return runCheck(
    {
      key: "supplier_tag_audit_readback",
      label: "Supplier capability tag audit readback",
      classification: "workflow_metadata",
      sourceOfTruth: "store-workflow-metadata",
      requiredCapabilities: required,
    },
    async () => {
      const metadataStore = new InMemoryStoreSupplierMetadataStore();
      const supplierService = createStoreSupplierService({
        productService: options.productService,
        store: options.projectionStore,
        governanceService: createGovernanceService({
          ...(options.now ? { now: options.now } : {}),
        }),
        metadataStore,
        ...(options.now ? { now: options.now } : {}),
      });
      const principal = {
        operatorId: options.access.principalId ?? "store-closure-dry-run",
        role: options.access.roles[0] ?? options.access.level,
      };
      await supplierService.createSupplier(
        {
          supplierId: "supplier-closure-dry-run",
          supplierSubjectId: CLOSURE_SUPPLIER_SUBJECT_ID,
          displayName: "Closure Dry-run Supplier",
          wallet: CLOSURE_SUPPLIER_WALLET,
          capabilityTags: ["logistics"],
          supportedRoleSlotIds: ["delivery"],
          supportedStageIds: ["shipping"],
          registryAddresses: [CLOSURE_REGISTRY_ADDRESS],
        },
        principal,
      );
      await supplierService.reviewSupplier(
        "supplier-closure-dry-run",
        {
          reviewStatus: "submitted",
          capabilityTags: ["inspection", "logistics"],
          supportedRoleSlotIds: ["customs-broker", "logistics-operator"],
          supportedStageIds: ["export.customs"],
          publicSummary: "Closure dry-run tag update only.",
        },
        principal,
      );
      const auditReadback = await supplierService.listSupplierAudits(
        "supplier-closure-dry-run",
      );
      const tagAudit = auditReadback.records.find(
        (record) => record.action === "tags_updated",
      );
      return check({
        key: "supplier_tag_audit_readback",
        label: "Supplier capability tag audit readback",
        status: tagAudit ? "passed" : "failed",
        classification: "workflow_metadata",
        sourceOfTruth: "store-workflow-metadata",
        requiredCapabilities: required,
        details: {
          supplierId: "supplier-closure-dry-run",
          auditRecordCount: auditReadback.records.length,
          tagAuditFound: Boolean(tagAudit),
          nonAuthoritative: auditReadback.nonAuthoritative,
          identitySourceOfTruth: auditReadback.identitySourceOfTruth,
        },
      });
    },
  );
}

async function checkDockingCreateValidateSave(
  options: StoreClosureDryRunOptions,
): Promise<StoreClosureCheckDTO> {
  const required = [
    "store.docking.create",
    "store.docking.validate",
    "store.docking.save",
  ] as const satisfies readonly StoreCapability[];
  const missing = missingCapabilities(options.access, required);
  if (missing.length > 0) {
    return blockedCapabilityCheck(
      "docking_create_validate_save",
      "Docking sandbox create/validate/save",
      required,
      missing,
    );
  }

  return runCheck(
    {
      key: "docking_create_validate_save",
      label: "Docking sandbox create/validate/save",
      classification: "workflow_metadata",
      sourceOfTruth: "store-workflow-metadata",
      requiredCapabilities: required,
    },
    async () => {
      const list = await options.storeConsoleService.listZhixus({
        lifecycle: "all",
        review: "all",
        publication: "published",
      });
      // STORE-03：docking 禁止 self-docking，dry-run 需要两个不同的已发布
      // zhixu 分别充当 source 与 target。
      const published = list.zhixus.filter(
        (zhixu) => zhixu.planPublication.status === "published",
      );
      const source = published[0];
      const target = source
        ? published.find((zhixu) => zhixu.zhixuId !== source.zhixuId)
        : undefined;
      if (!source || !target) {
        return check({
          key: "docking_create_validate_save",
          label: "Docking sandbox create/validate/save",
          status: "skipped",
          classification: "workflow_metadata",
          sourceOfTruth: "store-workflow-metadata",
          requiredCapabilities: required,
          message:
            "Docking sandbox validation needs two distinct published zhixu projections (self-docking is forbidden).",
          details: {
            totalZhixus: list.summary.totalZhixus,
            publishedZhixus: published.length,
            nonPublishing: true,
          },
        });
      }
      const docking = createStoreDockingService({
        productService: options.productService,
        sessionStore: new MemoryStoreDockingSessionStore(),
        ...(options.now ? { now: options.now } : {}),
      });
      const created = await docking.createSession({
        sourceZhixuId: source.zhixuId,
        targetZhixuId: target.zhixuId,
      });
      const candidate = created.candidateMappings[0];
      if (!candidate) {
        return check({
          key: "docking_create_validate_save",
          label: "Docking sandbox create/validate/save",
          status: "warning",
          classification: "workflow_metadata",
          sourceOfTruth: "store-workflow-metadata",
          requiredCapabilities: required,
          message:
            "Docking session was created, but no candidate signal mapping was available.",
          details: {
            sessionId: created.sessionId,
            validationOk: created.validation.ok,
            nonPublishing: created.validation.nonPublishing,
          },
        });
      }
      const draftSignalMap = [
        {
          sourceSignalId: candidate.sourceSignal.signalId,
          targetSignalId: candidate.targetSignal.signalId,
          note: "closure dry-run candidate",
        },
      ];
      const validated = await docking.validateSession(
        created.sessionId,
        draftSignalMap,
      );
      const saved = await docking.saveDraftMap(
        created.sessionId,
        draftSignalMap,
      );
      return check({
        key: "docking_create_validate_save",
        label: "Docking sandbox create/validate/save",
        status: saved.validation.ok ? "passed" : "warning",
        classification: "workflow_metadata",
        sourceOfTruth: "store-workflow-metadata",
        requiredCapabilities: required,
        details: {
          sessionId: created.sessionId,
          sourceZhixuId: source.zhixuId,
          targetZhixuId: target.zhixuId,
          candidateMappingCount: created.candidateMappings.length,
          validateStatus: validated.status,
          saveStatus: saved.status,
          savedDraftEntries: saved.draftSignalMap.length,
          validationOk: saved.validation.ok,
          nonPublishing: saved.validation.nonPublishing,
          createsOrder: false,
          createsSignalAuthorization: false,
        },
      });
    },
  );
}

async function checkRuntimeProofAudit(
  options: StoreClosureDryRunOptions,
): Promise<StoreClosureCheckDTO> {
  return runCheck(
    {
      key: "runtime_proof_audit_readiness",
      label: "Runtime/proof/audit readiness",
      classification: "projection",
      sourceOfTruth: "contracts-and-chain-events",
    },
    async () => {
      const [runtimeSummary, orders] = await Promise.all([
        options.storeRuntimeService.getSummary(),
        options.productService.listOrders(),
      ]);
      const order = orders[0];
      if (!order) {
        return check({
          key: "runtime_proof_audit_readiness",
          label: "Runtime/proof/audit readiness",
          status: "skipped",
          classification: "projection",
          sourceOfTruth: "contracts-and-chain-events",
          message:
            "No chain-backed order projection is available for proof/audit readback.",
          details: {
            runningOrderCount: runtimeSummary.runningOrderCount,
            openTaskCount: runtimeSummary.openTaskCount,
            indexerStatus: runtimeSummary.indexerStatus,
          },
        });
      }
      const [observation, replay, auditSummary] = await Promise.all([
        options.storeRuntimeService.getOrderObservation(order.orderId),
        options.storeRuntimeService.getOrderReplay(order.orderId),
        options.storeRuntimeService.getOrderAuditSummary(order.orderId),
      ]);
      return check({
        key: "runtime_proof_audit_readiness",
        label: "Runtime/proof/audit readiness",
        status: observation && auditSummary ? "passed" : "warning",
        classification: "projection",
        sourceOfTruth: "contracts-and-chain-events",
        details: {
          orderId: redactedOrderId(order),
          runningOrderCount: runtimeSummary.runningOrderCount,
          openTaskCount: runtimeSummary.openTaskCount,
          indexerStatus: runtimeSummary.indexerStatus,
          observationFound: Boolean(observation),
          replayStatus:
            replay?.replayStatus ?? observation?.replayStatus ?? "not_found",
          proofRowCount: observation?.proofRows.length ?? 0,
          timelineCount: observation?.timeline.length ?? 0,
          auditSummaryFound: Boolean(auditSummary),
          redactionNotice: auditSummary?.redactionNotice,
        },
      });
    },
  );
}

async function checkAuditReadiness(
  options: StoreClosureDryRunOptions,
): Promise<StoreClosureCheckDTO> {
  return runCheck(
    {
      key: "store_operator_audit_readiness",
      label: "Store operator audit readiness",
      classification: "workflow_metadata",
      sourceOfTruth: "store-workflow-metadata",
    },
    async () => {
      const records = await options.storeAuditStore.query({ limit: 5 });
      return check({
        key: "store_operator_audit_readiness",
        label: "Store operator audit readiness",
        status: "passed",
        classification: "workflow_metadata",
        sourceOfTruth: "store-workflow-metadata",
        details: {
          recordCount: records.length,
          redacted: true,
          nonAuthoritative: true,
          canCreateProtocolFacts: false,
        },
      });
    },
  );
}

async function runCheck(
  descriptor: Pick<
    StoreClosureCheckDTO,
    | "key"
    | "label"
    | "classification"
    | "sourceOfTruth"
    | "requiredCapabilities"
  >,
  callback: () => Promise<StoreClosureCheckDTO>,
): Promise<StoreClosureCheckDTO> {
  try {
    return await callback();
  } catch (error) {
    return check({
      ...descriptor,
      status: "failed",
      message:
        error instanceof Error
          ? error.message
          : "Store closure dry-run check failed",
      details: {
        errorName: error instanceof Error ? error.name : typeof error,
      },
    });
  }
}

function check(
  input: Omit<StoreClosureCheckDTO, "nonAuthoritative">,
): StoreClosureCheckDTO {
  return {
    ...input,
    nonAuthoritative: true,
  };
}

function blockedCapabilityCheck(
  key: string,
  label: string,
  requiredCapabilities: readonly StoreCapability[],
  missingCapabilities: readonly StoreCapability[],
): StoreClosureCheckDTO {
  return check({
    key,
    label,
    status: "blocked",
    classification: "prototype",
    sourceOfTruth: "store-workflow-metadata",
    requiredCapabilities,
    missingCapabilities,
    message:
      "The current Store session lacks one or more write capabilities for this dry-run step.",
    details: {
      writeControlsFailClosed: true,
    },
  });
}

function missingCapabilities(
  access: StoreAccessState,
  required: readonly StoreCapability[],
): readonly StoreCapability[] {
  return required.filter(
    (capability) => !hasStoreCapability(access, capability),
  );
}

function explicitProductSchema(
  schema: StoreProductSchemaDTO,
): StoreProductSchemaDTO {
  const roleSlots = schema.roleSlots.map((slot) => ({
    ...slot,
    capabilityPlugins: (slot.capabilityPlugins ?? []).map((plugin) => ({
      ...plugin,
      source: "explicit" as const,
    })),
  }));
  return {
    ...schema,
    roleSlots,
    capabilityPlugins: roleSlots.flatMap(
      (slot) => slot.capabilityPlugins ?? [],
    ),
  };
}

/**
 * dry-run 的治理 principal：优先沿用会话真实携带的治理身份；否则使用
 * 显式的 dry-run 标记身份。不再把任意 operator 的 roles[0] 包装成治理
 * 角色——dry-run 内部使用一次性的模拟治理服务，不触碰真实治理记录，
 * 但 principal 本身也不得伪装成某个真实运营方。
 */
function dryRunGovernancePrincipal(
  access: StoreAccessState,
): GovernancePrincipal {
  if (access.governancePrincipal) {
    return access.governancePrincipal;
  }
  return { adminId: access.principalId ?? "store-closure-dry-run", role: "governance_admin" };
}

async function safeDiagnostics(
  buildDiagnostics: () => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  try {
    return await buildDiagnostics();
  } catch (error) {
    return {
      runtime: { environment: "unknown" },
      evidenceStorage: { readiness: "unknown" },
      storeMetadata: { readiness: "unknown" },
      indexer: { syncStatus: "unknown" },
      diagnosticsError:
        error instanceof Error ? error.message : "diagnostics unavailable",
    };
  }
}

function prototypeReasonsFor(input: {
  readonly access: StoreAccessState;
  readonly checks: readonly StoreClosureCheckDTO[];
  readonly diagnostics: Record<string, unknown>;
}): readonly string[] {
  const reasons = new Set<string>(["dry_run_no_broadcast"]);
  const storeAuth = recordOf(input.diagnostics.storeAuth);
  const externalIdentityEvidence = storeAuth?.externalIdentityEvidence === true;
  if (input.access.authMode !== "jwt" || !externalIdentityEvidence) {
    reasons.add("store_identity_not_external_oidc");
  } else {
    reasons.add("external_oidc_not_proven_by_dry_run");
  }
  const storeMetadata = recordOf(input.diagnostics.storeMetadata);
  if (storeMetadata?.readiness !== "ready") {
    reasons.add("store_metadata_not_ready");
  }
  if (hasMemoryMetadataStore(storeMetadata)) {
    reasons.add("store_metadata_memory_only");
  }
  for (const checkItem of input.checks) {
    if (checkItem.status === "blocked") {
      reasons.add(`${checkItem.key}_blocked`);
    } else if (checkItem.status === "skipped") {
      reasons.add(`${checkItem.key}_skipped`);
    } else if (checkItem.status === "warning") {
      reasons.add(`${checkItem.key}_warning`);
    } else if (checkItem.status === "failed") {
      reasons.add(`${checkItem.key}_failed`);
    }
  }
  return [...reasons].sort();
}

function hasMemoryMetadataStore(
  storeMetadata: Record<string, unknown> | undefined,
): boolean {
  const stores = recordOf(storeMetadata?.stores);
  if (!stores) {
    return false;
  }
  return Object.values(stores).some(
    (value) => recordOf(value)?.kind === "memory",
  );
}

function runtimeEnvironmentFromDiagnostics(
  diagnostics: Record<string, unknown>,
): string {
  const runtime = recordOf(diagnostics.runtime);
  const environment = runtime?.environment;
  return typeof environment === "string" ? environment : "unknown";
}

function redactedOrderId(order: ProductOrderApiDTO): string {
  if (order.orderId.length <= 18) {
    return order.orderId;
  }
  return `${order.orderId.slice(0, 10)}...${order.orderId.slice(-8)}`;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
