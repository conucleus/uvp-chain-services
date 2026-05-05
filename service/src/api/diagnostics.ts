import type { ChainServicesRuntimeEnv, ConfigDiagnostics } from "../config/index.js";
import type { EvidenceStorage, EvidenceStorageRuntimeEnvironment } from "../evidence/index.js";
import type { GovernanceStore, GovernanceTxLogDTO } from "../governance/index.js";
import type { ReconcileWorkerDiagnostics } from "../reconcile/index.js";
import { redactErrorMessage, redactSecrets } from "../security/redaction.js";
import type { ProjectionRebuildMetadata, ProjectionStore, ProjectionSyncState } from "../storage/projection-store.js";
import type { StoreDockingSessionStore } from "../store-console/docking.js";
import type { StoreZhixuDraftStore } from "../store-console/zhixu-drafts.js";
import type { StoreZhixuVersionMetadataStore } from "../store-console/version.js";
import type { StoreSupplierMetadataStore } from "../store-suppliers/index.js";
import type {
  ProductSubmissionAttemptDTO,
  ProductSubmissionDTO,
  ProductSubmissionStore
} from "../submissions/index.js";

type HealthStatus = "ok" | "degraded";
type ReadinessStatus = "ready" | "not_ready";
type EvidenceReadiness = "ready" | "degraded" | "unknown";
type StoreMetadataReadiness = "ready" | "degraded" | "unknown";
type StoreMetadataKind = "memory" | "sqlite" | "postgres" | "unknown";
type JsonRecord = Record<string, unknown>;
type StoreMetadataRepresentation = "draft" | "supplier";

export interface IndexerRuntimeDiagnostics {
  readonly configured: boolean;
  readonly pollIntervalMs?: number;
}

export interface BuildOperationalDiagnosticsOptions {
  readonly store: ProjectionStore;
  readonly configDiagnostics?: ConfigDiagnostics;
  readonly runtimeEnvironment?: ChainServicesRuntimeEnv;
  readonly indexer?: IndexerRuntimeDiagnostics;
  readonly reconcile?: ReconcileWorkerDiagnostics | (() => ReconcileWorkerDiagnostics);
  readonly submissionStore?: ProductSubmissionStore;
  readonly governanceStore?: GovernanceStore;
  readonly evidenceStorage?: Pick<EvidenceStorage, "adapterKind" | "productionSafe">;
  readonly evidenceRuntimeEnvironment?: EvidenceStorageRuntimeEnvironment;
  readonly storeMetadataStores?: {
    readonly draft?: StoreZhixuDraftStore;
    readonly version?: StoreZhixuVersionMetadataStore;
    readonly supplier?: StoreSupplierMetadataStore;
    readonly docking?: StoreDockingSessionStore;
  };
  readonly now?: () => Date;
}

export interface OperationalReadiness {
  readonly ready: boolean;
  readonly status: ReadinessStatus;
  readonly reasons: readonly string[];
}

export async function buildOperationalDiagnostics(
  options: BuildOperationalDiagnosticsOptions
): Promise<Record<string, unknown>> {
  const generatedAt = (options.now ?? (() => new Date()))().toISOString();
  const syncStateResult = await readSyncState(options.store);
  const submissions = await buildSubmissionDiagnostics(options.submissionStore);
  const governanceTxs = await buildGovernanceTxDiagnostics(options.governanceStore);
  const evidenceStorage = buildEvidenceStorageDiagnostics({
    source: options.evidenceStorage,
    runtimeEnvironment: options.evidenceRuntimeEnvironment ?? options.runtimeEnvironment ?? "local"
  });
  const runtimeEnvironment = options.configDiagnostics?.environment ?? options.runtimeEnvironment ?? "local";
  const storeMetadata = buildStoreMetadataDiagnostics({
    stores: options.storeMetadataStores,
    runtimeEnvironment
  });
  const reconcile = buildReconcileDiagnostics(options.reconcile);
  const indexer = buildIndexerDiagnostics(syncStateResult, options.indexer);

  const diagnostics = {
    ...(options.configDiagnostics ?? fallbackConfigDiagnostics(options.runtimeEnvironment ?? "local")),
    generatedAt,
    sourceOfTruth: "contracts-and-chain-events",
    backendAuthority: false,
    runtime: {
      environment: options.configDiagnostics?.environment ?? options.runtimeEnvironment ?? "local",
      chainId: options.configDiagnostics?.network.chainId ?? null,
      contracts: options.configDiagnostics?.network.contracts ?? {}
    },
    indexer,
    projectionRebuild: indexer.rebuild,
    reconcile,
    submissions,
    governanceTxs,
    evidenceStorage,
    storeMetadata
  };

  return redactSecrets({
    ...diagnostics,
    health: {
      status: operationalHealthStatus(diagnostics),
      degradedReasons: operationalDegradedReasons(diagnostics)
    }
  });
}

export function operationalReadiness(diagnostics: Record<string, unknown>): OperationalReadiness {
  const reasons = operationalNotReadyReasons(diagnostics);
  return {
    ready: reasons.length === 0,
    status: reasons.length === 0 ? "ready" : "not_ready",
    reasons
  };
}

export function buildOperatorOpsStatus(diagnostics: Record<string, unknown>): Record<string, unknown> {
  const readiness = operationalReadiness(diagnostics);
  return redactSecrets({
    generatedAt: diagnostics.generatedAt ?? null,
    sourceOfTruth: diagnostics.sourceOfTruth ?? "contracts-and-chain-events",
    backendAuthority: false,
    health: diagnostics.health ?? { status: operationalHealthStatus(diagnostics), degradedReasons: [] },
    readiness,
    runtime: operatorRuntimeDiagnostics(diagnostics),
    preflight: diagnostics.preflight ?? { status: "skipped", checks: [] },
    indexer: diagnostics.indexer ?? {},
    projectionRebuild: diagnostics.projectionRebuild ?? recordOf(diagnostics.indexer)?.rebuild ?? {},
    reconcile: diagnostics.reconcile ?? {},
    submissions: diagnostics.submissions ?? {},
    governanceTxs: diagnostics.governanceTxs ?? {},
    evidenceStorage: diagnostics.evidenceStorage ?? {},
    storeMetadata: diagnostics.storeMetadata ?? {},
    operatorRoles: diagnostics.operatorRoles ?? {},
    roleBoundaries: buildOperatorRoleBoundaryDiagnostics(diagnostics),
    recoveryPolicy: {
      sourceOfTruth: "contracts-and-chain-events",
      actionsAreNonAuthoritative: true,
      canCreateBusinessSignatures: false,
      canForgeChainState: false,
      allowedActions: [
        "reconcile.run",
        "projections.rebuild",
        "submissions.retry"
      ],
      forbiddenOutputs: [
        "private_keys",
        "raw_calldata",
        "full_signatures",
        "evidence_plaintext",
        "database_credentials",
        "object_credentials",
        "presigned_urls"
      ]
    }
  });
}

export function buildOperatorOpsSummary(diagnostics: Record<string, unknown>): Record<string, unknown> {
  const status = buildOperatorOpsStatus(diagnostics);
  const submissions = recordOf(status.submissions);
  const governanceTxs = recordOf(status.governanceTxs);
  const indexer = recordOf(status.indexer);
  const evidenceStorage = recordOf(status.evidenceStorage);
  const storeMetadata = recordOf(status.storeMetadata);
  return redactSecrets({
    generatedAt: status.generatedAt ?? null,
    sourceOfTruth: status.sourceOfTruth ?? "contracts-and-chain-events",
    backendAuthority: false,
    runtime: status.runtime ?? {},
    health: status.health ?? {},
    readiness: status.readiness ?? {},
    counts: {
      retryableSubmissions: numberOf(submissions?.retryableCount),
      deadLetterSubmissions: numberOf(submissions?.deadLetterCount),
      deadLetterAttempts: numberOf(submissions?.deadLetterAttemptCount),
      governancePendingOrIndexing: arrayCount(governanceTxs?.pendingOrIndexing),
      governanceFailed: arrayCount(governanceTxs?.failed)
    },
    sync: {
      indexerStatus: indexer?.syncStatus ?? "unknown",
      finalizedBlock: indexer?.finalizedBlock ?? null,
      latestIndexedBlock: indexer?.latestIndexedBlock ?? null,
      lagBlocks: indexer?.lagBlocks ?? null,
      rebuild: status.projectionRebuild ?? {}
    },
    evidenceStorage: {
      adapterKind: evidenceStorage?.adapterKind ?? "unknown",
      readiness: evidenceStorage?.readiness ?? "unknown",
      credentialsExposed: false
    },
    storeMetadata: {
      readiness: storeMetadata?.readiness ?? "unknown",
      stores: storeMetadata?.stores ?? {},
      credentialsExposed: false
    },
    roleBoundaries: status.roleBoundaries ?? {},
    recoveryPolicy: status.recoveryPolicy ?? {}
  });
}

async function readSyncState(store: ProjectionStore): Promise<
  | { readonly ok: true; readonly state: ProjectionSyncState | undefined }
  | { readonly ok: false; readonly error: string }
> {
  try {
    return { ok: true, state: await store.getSyncState() };
  } catch (error) {
    return { ok: false, error: redactErrorMessage(error) };
  }
}

function buildIndexerDiagnostics(
  syncStateResult:
    | { readonly ok: true; readonly state: ProjectionSyncState | undefined }
    | { readonly ok: false; readonly error: string },
  runtime: IndexerRuntimeDiagnostics | undefined
): Record<string, unknown> {
  if (!syncStateResult.ok) {
    return {
      configured: runtime?.configured ?? false,
      pollIntervalMs: runtime?.pollIntervalMs ?? null,
      syncStatus: "degraded",
      latestIndexedBlock: null,
      finalizedBlock: null,
      lagBlocks: null,
      rebuild: { status: "failed" },
      degradedReason: syncStateResult.error
    };
  }

  const state = syncStateResult.state;
  return {
    configured: runtime?.configured ?? false,
    pollIntervalMs: runtime?.pollIntervalMs ?? null,
    syncStatus: state?.syncStatus ?? "not_started",
    latestIndexedBlock: bigintToString(state?.latestIndexedBlock),
    finalizedBlock: bigintToString(state?.finalizedBlock),
    lagBlocks: lagBlocks(state),
    confirmationDepth: state?.confirmationDepth ?? null,
    eventCount: state?.eventCount ?? 0,
    lastEventName: state?.lastEventName ?? null,
    updatedAt: state?.updatedAt ?? null,
    rebuild: formatRebuild(state?.rebuild),
    ...(state?.degradedReason ? { degradedReason: redactErrorMessage(state.degradedReason) } : {})
  };
}

function formatRebuild(rebuild: ProjectionRebuildMetadata | undefined): Record<string, unknown> {
  if (!rebuild) {
    return { status: "unknown" };
  }
  return {
    status: rebuild.status,
    startedAt: rebuild.startedAt ?? null,
    completedAt: rebuild.completedAt ?? null,
    fromBlock: bigintToString(rebuild.fromBlock),
    toBlock: bigintToString(rebuild.toBlock),
    eventCount: rebuild.eventCount ?? null,
    mismatchCount: rebuild.mismatchCount ?? null
  };
}

function buildReconcileDiagnostics(
  source: ReconcileWorkerDiagnostics | (() => ReconcileWorkerDiagnostics) | undefined
): Record<string, unknown> {
  const diagnostics = typeof source === "function" ? source() : source;
  if (!diagnostics) {
    return {
      enabled: false,
      running: false,
      checking: false,
      pollIntervalMs: null,
      txTimeoutMs: null,
      lastRunAt: null,
      lastSummary: null,
      lastError: null
    };
  }
  return {
    ...diagnostics,
    lastRunAt: diagnostics.lastRunAt ?? null,
    lastSummary: diagnostics.lastSummary ?? null,
    lastError: diagnostics.lastError ? redactErrorMessage(diagnostics.lastError) : null
  };
}

async function buildSubmissionDiagnostics(
  store: ProductSubmissionStore | undefined
): Promise<Record<string, unknown>> {
  if (!store) {
    return {
      configured: false,
      submissionsByStatus: {},
      broadcastByStatus: {},
      attemptsByStatus: {},
      attemptCount: 0,
      deadLetterCount: 0,
      retryableCount: 0,
      deadLetters: []
    };
  }

  const submissions = await store.listSubmissions();
  const attempts = submissions.flatMap((submission) => [...submission.attempts]);
  const deadLetters = submissions.filter((submission) =>
    submission.deadLetter || submission.attempts.some((attempt) => attempt.deadLetter)
  );
  return {
    configured: true,
    submissionCount: submissions.length,
    submissionsByStatus: countBy(submissions, (submission) => submission.status),
    broadcastByStatus: countBy(submissions, (submission) => submission.broadcastStatus),
    attemptsByStatus: countBy(attempts, (attempt) => attempt.status),
    attemptCount: attempts.length,
    deadLetterCount: deadLetters.length,
    deadLetterAttemptCount: attempts.filter((attempt) => attempt.deadLetter).length,
    retryableCount: submissions.filter((submission) => submission.retryable).length,
    latestUpdatedAt: latestTimestamp(submissions.map((submission) => submission.updatedAt)),
    deadLetters: deadLetters
      .sort(compareUpdatedDesc)
      .slice(0, 20)
      .map(safeDeadLetterSubmission)
  };
}

async function buildGovernanceTxDiagnostics(
  store: GovernanceStore | undefined
): Promise<Record<string, unknown>> {
  if (!store) {
    return {
      configured: false,
      txCount: 0,
      byStatus: {},
      byBroadcastStatus: {},
      pendingOrIndexing: [],
      failed: []
    };
  }

  const logs = [
    ...(await store.listPlanAttestationLogs()),
    ...(await store.listSupplierAttestationLogs())
  ].sort(compareGovernanceUpdatedDesc);

  return {
    configured: true,
    txCount: logs.length,
    byStatus: countBy(logs, (log) => log.status),
    byBroadcastStatus: countBy(logs, (log) => log.broadcastStatus),
    latestUpdatedAt: latestTimestamp(logs.map((log) => log.updatedAt)),
    pendingOrIndexing: logs
      .filter((log) => log.status === "pending" || log.status === "broadcasting" || log.status === "indexing")
      .slice(0, 20)
      .map(safeGovernanceTx),
    failed: logs
      .filter((log) => log.status === "failed")
      .slice(0, 20)
      .map(safeGovernanceTx)
  };
}

function buildEvidenceStorageDiagnostics(input: {
  readonly source: Pick<EvidenceStorage, "adapterKind" | "productionSafe"> | undefined;
  readonly runtimeEnvironment: EvidenceStorageRuntimeEnvironment;
}): Record<string, unknown> {
  if (!input.source) {
    return {
      adapterKind: "unknown",
      productionSafe: false,
      readiness: "unknown" satisfies EvidenceReadiness,
      credentialsExposed: false
    };
  }

  const productionReady = input.source.adapterKind === "object" && input.source.productionSafe;
  const readiness: EvidenceReadiness = input.runtimeEnvironment !== "local" && !productionReady
    ? "degraded"
    : "ready";
  return {
    adapterKind: input.source.adapterKind,
    productionSafe: input.source.productionSafe,
    readiness,
    credentialsExposed: false
  };
}

function buildStoreMetadataDiagnostics(input: {
  readonly stores: BuildOperationalDiagnosticsOptions["storeMetadataStores"] | undefined;
  readonly runtimeEnvironment: ChainServicesRuntimeEnv;
}): Record<string, unknown> {
  const nonLocalRuntime = input.runtimeEnvironment === "testnet" ||
    input.runtimeEnvironment === "staging" ||
    input.runtimeEnvironment === "production";
  const stores = {
    draft: storeMetadataStoreStatus(input.stores?.draft, nonLocalRuntime),
    productSchema: storeMetadataStoreStatus(input.stores?.draft, nonLocalRuntime, "draft"),
    version: storeMetadataStoreStatus(input.stores?.version, nonLocalRuntime),
    supplier: storeMetadataStoreStatus(input.stores?.supplier, nonLocalRuntime),
    supplierAudit: storeMetadataStoreStatus(input.stores?.supplier, nonLocalRuntime, "supplier"),
    docking: storeMetadataStoreStatus(input.stores?.docking, nonLocalRuntime)
  };
  const readiness: StoreMetadataReadiness = Object.values(stores)
    .some((store) => store.readiness === "degraded")
    ? "degraded"
    : Object.values(stores).some((store) => store.readiness === "unknown")
      ? "unknown"
      : "ready";
  return {
    readiness,
    credentialsExposed: false,
    nonAuthoritative: true,
    sourceOfTruth: "contracts-and-chain-events",
    stores
  };
}

function storeMetadataStoreStatus(
  source: unknown,
  nonLocalRuntime: boolean,
  representedBy?: StoreMetadataRepresentation
): {
  readonly configured: boolean;
  readonly kind: StoreMetadataKind;
  readonly durable: boolean;
  readonly readiness: StoreMetadataReadiness;
  readonly credentialsExposed: false;
  readonly representedBy?: StoreMetadataRepresentation;
} {
  const kind = storeMetadataKind(source);
  const durable = kind === "sqlite" || kind === "postgres";
  return {
    configured: source !== undefined,
    kind,
    durable,
    readiness: source === undefined || kind === "unknown"
      ? nonLocalRuntime ? "degraded" : "unknown"
      : nonLocalRuntime && !durable
        ? "degraded"
        : "ready",
    credentialsExposed: false,
    ...(representedBy ? { representedBy } : {})
  };
}

function storeMetadataKind(source: unknown): StoreMetadataKind {
  if (source === undefined) {
    return "unknown";
  }
  if (source && typeof source === "object") {
    const driver = (source as { readonly driver?: unknown }).driver;
    if (driver === "postgres" || driver === "sqlite" || driver === "memory") {
      return driver;
    }
  }
  const constructorName = source && typeof source === "object"
    ? (source as { readonly constructor?: { readonly name?: string } }).constructor?.name?.toLowerCase() ?? ""
    : "";
  if (constructorName.includes("postgres")) {
    return "postgres";
  }
  if (constructorName.includes("sqlite")) {
    return "sqlite";
  }
  if (constructorName.includes("memory")) {
    return "memory";
  }
  return "unknown";
}

function operationalHealthStatus(diagnostics: Record<string, unknown>): HealthStatus {
  return operationalDegradedReasons(diagnostics).length > 0 ? "degraded" : "ok";
}

function operationalDegradedReasons(diagnostics: Record<string, unknown>): readonly string[] {
  const reasons = operationalNotReadyReasons(diagnostics);
  const submissions = diagnostics.submissions as { readonly deadLetterCount?: number } | undefined;
  const governanceTxs = diagnostics.governanceTxs as { readonly failed?: readonly unknown[] } | undefined;
  const degraded = [...reasons];
  if ((submissions?.deadLetterCount ?? 0) > 0) {
    degraded.push("submission_dead_letters");
  }
  if ((governanceTxs?.failed?.length ?? 0) > 0) {
    degraded.push("governance_failed_txs");
  }
  return degraded;
}

function operationalNotReadyReasons(diagnostics: Record<string, unknown>): readonly string[] {
  const reasons: string[] = [];
  const preflight = (diagnostics.preflight ?? {}) as { readonly status?: string };
  const indexer = (diagnostics.indexer ?? {}) as { readonly syncStatus?: string };
  const reconcile = (diagnostics.reconcile ?? {}) as { readonly lastError?: string | null };
  const evidenceStorage = (diagnostics.evidenceStorage ?? {}) as { readonly readiness?: string };
  const storeMetadata = (diagnostics.storeMetadata ?? {}) as { readonly readiness?: string };

  if (preflight.status === "failed") {
    reasons.push("preflight_failed");
  }
  if (indexer.syncStatus === "degraded") {
    reasons.push("indexer_degraded");
  }
  if (reconcile.lastError) {
    reasons.push("reconcile_error");
  }
  if (evidenceStorage.readiness === "degraded") {
    reasons.push("evidence_storage_degraded");
  }
  if (storeMetadata.readiness === "degraded") {
    reasons.push("store_metadata_degraded");
  }
  return reasons;
}

function safeDeadLetterSubmission(submission: ProductSubmissionDTO): Record<string, unknown> {
  const latestAttempt = [...submission.attempts].sort(compareAttemptUpdatedDesc)[0];
  return {
    submissionId: submission.submissionId,
    orderId: submission.orderId,
    onchainOrderId: submission.onchainOrderId,
    sourceId: submission.sourceId,
    signalId: submission.signalId,
    submitter: submission.submitter,
    status: submission.status,
    broadcastStatus: submission.broadcastStatus,
    retryState: submission.retryState,
    deadLetter: submission.deadLetter,
    txHash: submission.txHash ?? latestAttempt?.txHash ?? null,
    errorCode: submission.errorCode ?? latestAttempt?.errorCode ?? null,
    updatedAt: submission.updatedAt
  };
}

function safeGovernanceTx(log: GovernanceTxLogDTO): Record<string, unknown> {
  return {
    txLogId: log.txLogId,
    action: log.action,
    subjectId: log.subjectId,
    status: log.status,
    broadcastStatus: log.broadcastStatus,
    txHash: log.txHash ?? null,
    errorCode: log.errorCode ?? null,
    retryable: log.retryable,
    updatedAt: log.updatedAt
  };
}

function countBy<TItem>(items: readonly TItem[], select: (item: TItem) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = select(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function latestTimestamp(values: readonly string[]): string | null {
  return values.reduce<string | null>((latest, value) => latest === null || value > latest ? value : latest, null);
}

function compareUpdatedDesc(left: ProductSubmissionDTO, right: ProductSubmissionDTO): number {
  return right.updatedAt.localeCompare(left.updatedAt) || right.submissionId.localeCompare(left.submissionId);
}

function compareAttemptUpdatedDesc(left: ProductSubmissionAttemptDTO, right: ProductSubmissionAttemptDTO): number {
  return right.updatedAt.localeCompare(left.updatedAt) || right.attemptId.localeCompare(left.attemptId);
}

function compareGovernanceUpdatedDesc(left: GovernanceTxLogDTO, right: GovernanceTxLogDTO): number {
  return right.updatedAt.localeCompare(left.updatedAt) || right.txLogId.localeCompare(left.txLogId);
}

function lagBlocks(state: ProjectionSyncState | undefined): string | null {
  if (!state) {
    return null;
  }
  if (state.finalizedBlock !== undefined && state.latestIndexedBlock !== undefined) {
    const lag = state.finalizedBlock > state.latestIndexedBlock ? state.finalizedBlock - state.latestIndexedBlock : 0n;
    return lag.toString();
  }
  if (state.syncStatus === "indexed") {
    return "0";
  }
  return null;
}

function bigintToString(value: bigint | undefined): string | null {
  return value === undefined ? null : value.toString();
}

function operatorRuntimeDiagnostics(diagnostics: JsonRecord): JsonRecord {
  const runtime = recordOf(diagnostics.runtime);
  const network = recordOf(diagnostics.network);
  return runtime ?? {
    environment: diagnostics.environment ?? null,
    chainId: network?.chainId ?? null,
    contracts: network?.contracts ?? {}
  };
}

function buildOperatorRoleBoundaryDiagnostics(diagnostics: JsonRecord): JsonRecord {
  const relayer = recordOf(diagnostics.relayer);
  const governance = recordOf(diagnostics.governance);
  return {
    sourceOfTruth: "contracts-and-chain-events",
    backendBusinessSigning: "forbidden",
    relayer: {
      transactionSubmission: relayer?.configured === true ? "configured" : "not_configured",
      businessSignatures: "forbidden",
      privateValuesExposed: false
    },
    governance: {
      txBroadcast: governance?.configured === true ? "configured" : "not_configured",
      reviewAuthority: "admin_headers_v1",
      privateValuesExposed: false
    },
    configuredRoles: diagnostics.operatorRoles ?? {},
    rawCalldataExposed: false,
    fullSignaturesExposed: false,
    evidencePlaintextExposed: false,
    credentialValuesExposed: false
  };
}

function recordOf(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function numberOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function arrayCount(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function fallbackConfigDiagnostics(environment: ChainServicesRuntimeEnv): Record<string, unknown> {
  return {
    environment,
    demoMode: false,
    e2eControls: false,
    storageDriver: "unknown",
    relayerConfigured: false,
    network: {
      chainId: null,
      deploymentBlock: null,
      finalityConfirmations: null,
      reorgBufferBlocks: null,
      contracts: {}
    },
    warnings: [],
    preflight: {
      strict: false,
      status: "skipped",
      checks: []
    }
  };
}
