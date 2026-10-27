import type { ChainServicesRuntimeEnv, ConfigDiagnostics } from "../config/index.js";
import { redactErrorMessage, redactSecrets } from "@uvp-eth/service-runtime";
import {
  hasProjectionDiagnosticsAnomalies,
  type ProjectionRebuildMetadata,
  type ProjectionStore,
  type ProjectionSyncDiagnosticsCounts,
  type ProjectionSyncState
} from "../storage/projection-store.js";

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
  const runtimeEnvironment = options.configDiagnostics?.environment ?? options.runtimeEnvironment;
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
    projectionRebuild: indexer.rebuild
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
    operatorRoles: diagnostics.operatorRoles ?? {},
    recoveryPolicy: {
      sourceOfTruth: "contracts-and-chain-events",
      actionsAreNonAuthoritative: true,
      canCreateBusinessSignatures: false,
      canForgeChainState: false,
      allowedActions: [
        "projections.rebuild",
        "indexer.sweep_pending"
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
  const indexer = recordOf(status.indexer);
  return redactSecrets({
    generatedAt: status.generatedAt ?? null,
    sourceOfTruth: status.sourceOfTruth ?? "contracts-and-chain-events",
    backendAuthority: false,
    runtime: status.runtime ?? {},
    health: status.health ?? {},
    readiness: status.readiness ?? {},
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

function operationalHealthStatus(diagnostics: Record<string, unknown>): HealthStatus {
  return operationalDegradedReasons(diagnostics).length > 0 ? "degraded" : "ok";
}

function operationalDegradedReasons(diagnostics: Record<string, unknown>): readonly string[] {
  const reasons = operationalNotReadyReasons(diagnostics);
  const indexer = diagnostics.indexer as { readonly projectionDiagnostics?: ProjectionSyncDiagnosticsCounts | null } | undefined;
  const degraded = [...reasons];
  if (hasProjectionDiagnosticsAnomalies(indexer?.projectionDiagnostics ?? undefined)) {
    degraded.push("projection_unresolved_counts");
  }
  return degraded;
}

function operationalNotReadyReasons(diagnostics: Record<string, unknown>): readonly string[] {
  const reasons: string[] = [];
  const preflight = (diagnostics.preflight ?? {}) as { readonly status?: string };
  const indexer = (diagnostics.indexer ?? {}) as { readonly syncStatus?: string };

  if (preflight.status === "failed") {
    reasons.push("preflight_failed");
  }
  if (indexer.syncStatus === "degraded") {
    reasons.push("indexer_degraded");
  }
  return reasons;
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

function fallbackConfigDiagnostics(environment: ChainServicesRuntimeEnv): Record<string, unknown> {
  return {
    environment,
    storageDriver: "unknown",
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
