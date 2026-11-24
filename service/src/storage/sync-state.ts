// Projection sync-state read model: a stored "indexed" status is only current
// while the indexer heartbeat and scan cursor actually cover the finalized
// bound; readers are told the projection is stale, rebuilding, or never built
// instead of treating it as fresh or as a valid empty projection.

import { redactEndpointErrorMessage } from "../shared/redaction.js";
import type {
  ProjectionStore,
  ProjectionSyncState,
  StoredProjectionCursor,
} from "./projection-store.js";

export const DEFAULT_SYNC_STALE_AFTER_MS = 60_000;
export const MIN_SYNC_STALE_AFTER_MS = 30_000;

export type ProjectionReadStatus =
  | "current"
  | "not_started"
  | "syncing"
  | "rebuilding"
  | "stale"
  | "degraded";

export interface ProjectionReadState {
  readonly stored: ProjectionSyncState;
  readonly readable: ProjectionSyncState;
  readonly status: ProjectionReadStatus;
}

export interface ReadableSyncStateOptions {
  readonly now: Date;
  readonly staleAfterMs?: number | undefined;
  readonly cursor?: Pick<StoredProjectionCursor, "nextBlock" | "finalizedBlock"> | undefined;
}

export interface ReadProjectionStateOptions {
  readonly now: Date;
  readonly staleAfterMs?: number | undefined;
}

export async function readProjectionState(
  store: ProjectionStore,
  options: ReadProjectionStateOptions,
): Promise<ProjectionReadState | undefined> {
  const stored = await store.getSyncState();
  if (!stored) {
    return undefined;
  }
  const cursor = await store.getCursor?.({
    chainId: stored.chainId,
    contractAddress: stored.contractAddress,
  });
  const readable = readableSyncState(stored, {
    now: options.now,
    ...(options.staleAfterMs !== undefined ? { staleAfterMs: options.staleAfterMs } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
  });
  return {
    stored,
    readable: readable.degradedReason === undefined
      ? readable
      : { ...readable, degradedReason: redactEndpointErrorMessage(readable.degradedReason) },
    status: projectionReadStatus(stored, readable),
  };
}

export function readableSyncState(
  state: ProjectionSyncState,
  options: ReadableSyncStateOptions,
): ProjectionSyncState {
  if (state.syncStatus === "degraded") {
    return state;
  }
  if (state.syncStatus === "rebuilding" || state.rebuild?.status === "running") {
    return { ...state, syncStatus: "stale" };
  }
  if (isScanBehindFinalized(state, options.cursor)) {
    return { ...state, syncStatus: "stale" };
  }
  if (isHeartbeatStale(state, options)) {
    return { ...state, syncStatus: "stale" };
  }
  return state;
}

export function syncStaleAfterMs(pollIntervalMs: number | undefined): number | undefined {
  if (pollIntervalMs === undefined) {
    return undefined;
  }
  return Math.max(pollIntervalMs * 3, MIN_SYNC_STALE_AFTER_MS);
}

export function indexerStaleAfterMs(
  indexer: { readonly configured: boolean; readonly pollIntervalMs?: number } | undefined,
): number | undefined {
  if (!indexer) {
    return undefined;
  }
  return syncStaleAfterMs(indexer.pollIntervalMs) ??
    (indexer.configured ? DEFAULT_SYNC_STALE_AFTER_MS : undefined);
}

function projectionReadStatus(
  stored: ProjectionSyncState,
  readable: ProjectionSyncState,
): ProjectionReadStatus {
  if (stored.syncStatus === "degraded") {
    return "degraded";
  }
  if (stored.syncStatus === "rebuilding" || stored.rebuild?.status === "running") {
    return "rebuilding";
  }
  if (stored.syncStatus === "syncing") {
    return readable.syncStatus === "stale" ? "stale" : "syncing";
  }
  return readable.syncStatus === "indexed" ? "current" : "stale";
}

function isScanBehindFinalized(
  state: ProjectionSyncState,
  cursor: ReadableSyncStateOptions["cursor"],
): boolean {
  if (cursor?.finalizedBlock !== undefined) {
    const scannedThrough = cursor.nextBlock > 0n ? cursor.nextBlock - 1n : 0n;
    return scannedThrough < cursor.finalizedBlock;
  }
  if (state.finalizedBlock === undefined || state.latestIndexedBlock === undefined) {
    return false;
  }
  return state.latestIndexedBlock < state.finalizedBlock;
}

function isHeartbeatStale(
  state: ProjectionSyncState,
  options: ReadableSyncStateOptions,
): boolean {
  if (options.staleAfterMs === undefined) {
    return false;
  }
  const updatedAtMs = Date.parse(state.updatedAt);
  if (!Number.isFinite(updatedAtMs)) {
    return true;
  }
  return options.now.getTime() - updatedAtMs > options.staleAfterMs;
}
