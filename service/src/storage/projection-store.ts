import type { ChainEvent } from "../indexer/events.js";
import { filterActiveChainEvents, sortChainEvents } from "../indexer/events.js";
import type { PlanCapabilityTablesInput } from "../indexer/projections/plan.js";
import type {
  ProjectionSnapshot,
  StateMachineOrderProjection,
  StateMachineTaskProjection,
} from "../indexer/projections/index.js";
import type {
  IdentityBindingProjection,
  IdentityBindingQuery,
  IdentityProjectionSnapshot,
} from "../indexer/identity-projections.js";
import type { Address, Hex } from "@uvp-eth/service-runtime";
import type { StorageAdapterLifecycle, TransactionalStorage } from "./types.js";

export const projectionScopeContractAddress =
  "0x0000000000000000000000000000000000000000" as const;

export type ProjectionSyncStatus =
  | "indexed"
  | "syncing"
  | "stale"
  | "rebuilding"
  | "degraded";
export type ProjectionRebuildStatus =
  | "idle"
  | "running"
  | "completed"
  | "failed";

export interface ProjectionRebuildMetadata {
  readonly status: ProjectionRebuildStatus;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly deploymentBlock?: bigint;
  readonly fromBlock?: bigint;
  readonly toBlock?: bigint;
  readonly eventCount?: number;
  readonly activeEventCount?: number;
  readonly removedEventCount?: number;
  readonly removedLogsFiltered?: boolean;
  readonly projectionRebuilt?: boolean;
  readonly mismatchCount?: number;
}

export interface ProjectionSyncDiagnosticsCounts {
  readonly unresolvedModuleOrderEventCount: number;
  readonly unresolvedDockEventCount: number;
  readonly unresolvedStageActivationEventCount: number;
  readonly unresolvedDockTargetDeploymentCount: number;
  readonly unresolvedIdentityRevokeEventCount: number;
  readonly capabilityEnrichmentMismatchCount: number;
  readonly unknownEventCount: number;
  readonly semanticOracleMismatchCount: number;
  readonly semanticOracleCheckedPlanCount: number;
  readonly semanticOracleErrorCount: number;
  readonly semanticOracleExcludedPlanCount: number;
}

export function projectionDiagnosticsFromSnapshots(
  orderSnapshot: ProjectionSnapshot,
  identitySnapshot: Pick<IdentityProjectionSnapshot, "unresolvedRevokeEventCount">,
  semanticOracle?: {
    readonly semanticOracleCheckedPlanCount: number;
    readonly semanticOracleMismatchCount: number;
    readonly semanticOracleErrorCount: number;
    readonly semanticOracleExcludedPlanCount: number;
  }
): ProjectionSyncDiagnosticsCounts {
  return {
    unresolvedModuleOrderEventCount: orderSnapshot.unresolvedModuleOrderEventCount ?? 0,
    unresolvedDockEventCount: orderSnapshot.unresolvedDockEventCount ?? 0,
    unresolvedStageActivationEventCount: orderSnapshot.unresolvedStageActivationEventCount ?? 0,
    unresolvedDockTargetDeploymentCount: orderSnapshot.unresolvedDockTargetDeploymentCount ?? 0,
    unresolvedIdentityRevokeEventCount: identitySnapshot.unresolvedRevokeEventCount ?? 0,
    capabilityEnrichmentMismatchCount: orderSnapshot.capabilityEnrichmentMismatchCount ?? 0,
    unknownEventCount: orderSnapshot.unknownEventCount ?? 0,
    semanticOracleMismatchCount: semanticOracle?.semanticOracleMismatchCount ?? 0,
    semanticOracleCheckedPlanCount: semanticOracle?.semanticOracleCheckedPlanCount ?? 0,
    semanticOracleErrorCount: semanticOracle?.semanticOracleErrorCount ?? 0,
    semanticOracleExcludedPlanCount: semanticOracle?.semanticOracleExcludedPlanCount ?? 0
  };
}

export function hasProjectionDiagnosticsAnomalies(
  counts: ProjectionSyncDiagnosticsCounts | undefined
): boolean {
  if (!counts) {
    return false;
  }
  return counts.unresolvedModuleOrderEventCount > 0 ||
    counts.unresolvedDockEventCount > 0 ||
    counts.unresolvedStageActivationEventCount > 0 ||
    counts.unresolvedDockTargetDeploymentCount > 0 ||
    counts.unresolvedIdentityRevokeEventCount > 0 ||
    counts.capabilityEnrichmentMismatchCount > 0 ||
    counts.unknownEventCount > 0 ||
    counts.semanticOracleMismatchCount > 0 ||
    counts.semanticOracleErrorCount > 0;
}

export interface ProjectionSyncState extends ProjectionScope {
  readonly syncStatus: ProjectionSyncStatus;
  readonly latestIndexedBlock?: bigint;
  readonly finalizedBlock?: bigint;
  readonly confirmationDepth: number;
  readonly lastEventName?: string;
  readonly eventCount: number;
  readonly rebuild?: ProjectionRebuildMetadata;
  readonly projectionDiagnostics?: ProjectionSyncDiagnosticsCounts;
  readonly degradedReason?: string;
  readonly updatedAt: string;
}

export interface ProjectionRebuildInput {
  readonly deploymentBlock: bigint;
  readonly events: readonly ChainEvent[];
  readonly planCapabilityTables?: readonly PlanCapabilityTablesInput[];
  readonly scope?: ProjectionScope;
  readonly syncState?: Omit<ProjectionSyncState, "updatedAt">;
  readonly cursor?: Omit<StoredProjectionCursor, "updatedAt">;
}

export interface ProjectionScope {
  readonly chainId: number;
  readonly contractAddress: Address;
}

export interface StoredProjectionCursor extends ProjectionScope {
  readonly deploymentBlock: bigint;
  readonly nextBlock: bigint;
  readonly finalizedBlock?: bigint;
  readonly blockHash?: Hex;
  readonly updatedAt: string;
}

export type ProjectionSnapshotKind = "order" | "identity";

export type PendingPostCommitKind = "signal_notification" | "projection_automation";

export interface PendingPostCommitStep {
  readonly stepId: string;
  readonly chainId: number;
  readonly kind: PendingPostCommitKind;
  readonly events?: readonly ChainEvent[];
  readonly attempts: number;
  readonly lastError?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SavePendingPostCommitStepInput {
  readonly stepId: string;
  readonly chainId: number;
  readonly kind: PendingPostCommitKind;
  readonly events?: readonly ChainEvent[];
}

export interface StoredProjectionSnapshot<TSnapshot> extends ProjectionScope {
  readonly kind: ProjectionSnapshotKind;
  readonly version: number;
  readonly snapshot: TSnapshot;
  readonly updatedAt: string;
}

export interface ProjectionStore {
  resetFromEvents(input: ProjectionRebuildInput): Promise<ProjectionSnapshot>;
  getOrderSnapshot(): Promise<ProjectionSnapshot>;
  saveSyncState(
    state: Omit<ProjectionSyncState, "updatedAt">,
  ): Promise<ProjectionSyncState>;
  getSyncState(
    scope?: Partial<ProjectionScope>,
  ): Promise<ProjectionSyncState | undefined>;
  listStateMachineOrders(): Promise<readonly StateMachineOrderProjection[]>;
  getStateMachineOrder(
    orderId: string,
    planId?: string,
  ): Promise<StateMachineOrderProjection | undefined>;
  findStateMachineOrdersByOrderId(
    orderId: string,
  ): Promise<readonly StateMachineOrderProjection[]>;
  listStateMachineTasks(): Promise<readonly StateMachineTaskProjection[]>;
  getStateMachineTask(
    taskId: string,
  ): Promise<StateMachineTaskProjection | undefined>;
  listIdentityBindings(
    query: IdentityBindingQuery,
  ): Promise<readonly IdentityBindingProjection[]>;
  getIdentitySnapshot(): Promise<IdentityProjectionSnapshot>;
}

export interface DurableProjectionStore
  extends ProjectionStore,
    StorageAdapterLifecycle,
    TransactionalStorage {
  saveCursor(
    cursor: Omit<StoredProjectionCursor, "updatedAt">,
    options?: { readonly expectNextBlock?: bigint }
  ): Promise<StoredProjectionCursor | undefined>;
  getCursor(
    scope: ProjectionScope,
  ): Promise<StoredProjectionCursor | undefined>;
  appendEvent(event: ChainEvent): Promise<void>;
  listEvents(scope: Partial<ProjectionScope>): Promise<readonly ChainEvent[]>;
  deleteEventsAfterBlock(
    scope: { readonly chainId: number; readonly contractAddress?: Address },
    blockNumber: bigint,
  ): Promise<number>;
  saveSnapshot<TSnapshot>(
    scope: ProjectionScope,
    kind: ProjectionSnapshotKind,
    snapshot: TSnapshot,
    version?: number,
  ): Promise<StoredProjectionSnapshot<TSnapshot>>;
  getSnapshot<TSnapshot>(
    scope: ProjectionScope,
    kind: ProjectionSnapshotKind,
  ): Promise<StoredProjectionSnapshot<TSnapshot> | undefined>;
  savePendingPostCommitStep(input: SavePendingPostCommitStepInput): Promise<PendingPostCommitStep>;
  listPendingPostCommitSteps(scope: { readonly chainId: number }): Promise<readonly PendingPostCommitStep[]>;
  recordPendingPostCommitAttempt(stepId: string, error: string): Promise<void>;
  deletePendingPostCommitStep(stepId: string): Promise<void>;
}

export function defaultProjectionScope(chainId: number): ProjectionScope {
  return {
    chainId,
    contractAddress: projectionScopeContractAddress,
  };
}

export function syncStateFromRebuildInput(
  input: ProjectionRebuildInput,
  events: readonly ChainEvent[],
): ProjectionSyncState {
  const activeEvents = filterActiveChainEvents(events);
  const sortedEvents = sortChainEvents(activeEvents);
  const lastEvent = sortedEvents.at(-1);
  const latestIndexedBlock = latestBlockNumber(activeEvents);
  const scope = input.scope ?? {
    chainId: lastEvent?.chainId ?? input.syncState?.chainId ?? 0,
    contractAddress:
      input.syncState?.contractAddress ?? projectionScopeContractAddress,
  };
  const base = input.syncState;

  return {
    chainId: scope.chainId,
    contractAddress: scope.contractAddress,
    syncStatus: base?.syncStatus ?? "indexed",
    ...(latestIndexedBlock !== undefined ? { latestIndexedBlock } : {}),
    ...(base?.finalizedBlock !== undefined
      ? { finalizedBlock: base.finalizedBlock }
      : {}),
    confirmationDepth: base?.confirmationDepth ?? 0,
    ...(lastEvent
      ? { lastEventName: lastEvent.eventName }
      : base?.lastEventName
        ? { lastEventName: base.lastEventName }
        : {}),
    eventCount: base?.eventCount ?? activeEvents.length,
    ...(base?.rebuild ? { rebuild: base.rebuild } : {}),
    ...(base?.projectionDiagnostics ? { projectionDiagnostics: base.projectionDiagnostics } : {}),
    ...(base?.degradedReason ? { degradedReason: base.degradedReason } : {}),
    updatedAt: new Date().toISOString(),
  };
}

function latestBlockNumber(events: readonly ChainEvent[]): bigint | undefined {
  return events.reduce<bigint | undefined>(
    (latest, event) =>
      latest === undefined || event.blockNumber > latest
        ? event.blockNumber
        : latest,
    undefined,
  );
}

