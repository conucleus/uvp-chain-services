import type { ChainServicesRuntimeEnv, ConfigDiagnostics } from "../config/index.js";
import type { ReconcileWorkerDiagnostics } from "../reconcile/index.js";
import { redactErrorMessage, redactSecrets } from "../security/redaction.js";
import {
  hasProjectionDiagnosticsAnomalies,
  type ProjectionRebuildMetadata,
  type ProjectionStore,
  type ProjectionSyncDiagnosticsCounts,
  type ProjectionSyncState
} from "../storage/projection-store.js";
import type {
  ProductSubmissionAttemptDTO,
  ProductSubmissionDTO,
  ProductSubmissionStore
} from "../submissions/index.js";

type HealthStatus = "ok" | "degraded";
type ReadinessStatus = "ready" | "not_ready";
type JsonRecord = Record<string, unknown>;

export interface IndexerRuntimeDiagnostics {
  readonly configured: boolean;
  readonly pollIntervalMs?: number;
}

export interface BuildOperationalDiagnosticsOptions {
  readonly store: ProjectionStore;
  readonly configDiagnostics?: ConfigDiagnostics;
  readonly runtimeEnvironment: ChainServicesRuntimeEnv;
  readonly indexer?: IndexerRuntimeDiagnostics;
  readonly reconcile?: ReconcileWorkerDiagnostics | (() => ReconcileWorkerDiagnostics);
  readonly submissionStore?: ProductSubmissionStore;
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
  const runtimeEnvironment = options.configDiagnostics?.environment ?? options.runtimeEnvironment;
  const reconcile = buildReconcileDiagnostics(options.reconcile);
  const indexer = buildIndexerDiagnostics(syncStateResult, options.indexer);

  const diagnostics = {
    ...(options.configDiagnostics ?? fallbackConfigDiagnostics(options.runtimeEnvironment)),
    generatedAt,
    sourceOfTruth: "contracts-and-chain-events",
    backendAuthority: false,
    runtime: {
      environment: runtimeEnvironment,
      chainId: options.configDiagnostics?.network.chainId ?? null,
      contracts: options.configDiagnostics?.network.contracts ?? {}
    },
    indexer,
    projectionRebuild: indexer.rebuild,
    reconcile,
    submissions
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
    operatorRoles: diagnostics.operatorRoles ?? {},
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
  const indexer = recordOf(status.indexer);
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
      deadLetterAttempts: numberOf(submissions?.deadLetterAttemptCount)
    },
    sync: {
      indexerStatus: indexer?.syncStatus ?? "unknown",
      finalizedBlock: indexer?.finalizedBlock ?? null,
      latestIndexedBlock: indexer?.latestIndexedBlock ?? null,
      lagBlocks: indexer?.lagBlocks ?? null,
      rebuild: status.projectionRebuild ?? {}
    },
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
    projectionDiagnostics: state?.projectionDiagnostics ?? null,
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
    deploymentBlock: bigintToString(rebuild.deploymentBlock),
    fromBlock: bigintToString(rebuild.fromBlock),
    toBlock: bigintToString(rebuild.toBlock),
    eventCount: rebuild.eventCount ?? null,
    activeEventCount: rebuild.activeEventCount ?? null,
    removedEventCount: rebuild.removedEventCount ?? null,
    removedLogsFiltered: rebuild.removedLogsFiltered ?? null,
    projectionRebuilt: rebuild.projectionRebuilt ?? null,
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

function storeUnavailableDiagnostics(degradedReason: string): Record<string, unknown> {
  return {
    configured: true,
    unavailable: true,
    degradedReason
  };
}

async function readDiagnosticsStoreValue<TValue>(
  read: () => Promise<readonly TValue[]>
): Promise<
  | { readonly ok: true; readonly value: readonly TValue[] }
  | { readonly ok: false; readonly degradedReason: string }
> {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    return { ok: false, degradedReason: redactErrorMessage(error) };
  }
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

  const submissionsResult = await readDiagnosticsStoreValue(() => store.listSubmissions());
  if (!submissionsResult.ok) {
    return storeUnavailableDiagnostics(submissionsResult.degradedReason);
  }
  const submissions = submissionsResult.value;
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

function operationalHealthStatus(diagnostics: Record<string, unknown>): HealthStatus {
  return operationalDegradedReasons(diagnostics).length > 0 ? "degraded" : "ok";
}

function operationalDegradedReasons(diagnostics: Record<string, unknown>): readonly string[] {
  const reasons = operationalNotReadyReasons(diagnostics);
  const submissions = diagnostics.submissions as { readonly deadLetterCount?: number } | undefined;
  const indexer = diagnostics.indexer as { readonly projectionDiagnostics?: ProjectionSyncDiagnosticsCounts | null } | undefined;
  const degraded = [...reasons];
  if ((submissions?.deadLetterCount ?? 0) > 0) {
    degraded.push("submission_dead_letters");
  }
  if (hasProjectionDiagnosticsAnomalies(indexer?.projectionDiagnostics ?? undefined)) {
    degraded.push("projection_unresolved_counts");
  }
  return degraded;
}

function operationalNotReadyReasons(diagnostics: Record<string, unknown>): readonly string[] {
  const reasons: string[] = [];
  const preflight = (diagnostics.preflight ?? {}) as { readonly status?: string };
  const indexer = (diagnostics.indexer ?? {}) as { readonly syncStatus?: string };
  const reconcile = (diagnostics.reconcile ?? {}) as { readonly lastError?: string | null };
  const submissions = (diagnostics.submissions ?? {}) as { readonly unavailable?: boolean };

  if (preflight.status === "failed") {
    reasons.push("preflight_failed");
  }
  if (indexer.syncStatus === "degraded") {
    reasons.push("indexer_degraded");
  }
  if (reconcile.lastError) {
    reasons.push("reconcile_error");
  }
  if (submissions.unavailable === true) {
    reasons.push("submission_store_unavailable");
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

function recordOf(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function numberOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function fallbackConfigDiagnostics(environment: ChainServicesRuntimeEnv): Record<string, unknown> {
  return {
    environment,
    storageDriver: "unknown",
    relayerConfigured: false,
    network: {
      chainId: null,
      deploymentBlock: null,
      finalityConfirmations: null,
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
