// Projection sync-state read model: a stored "indexed" status is only current
// while the indexer heartbeat and scan cursor actually cover the finalized bound;
// otherwise readers are told the projection is stale instead of treating it as fresh.

import type { ProjectionSyncState, StoredProjectionCursor } from "./projection-store.js";

export const DEFAULT_SYNC_STALE_AFTER_MS = 60_000;
export const MIN_SYNC_STALE_AFTER_MS = 30_000;

export interface ReadableSyncStateOptions {
  readonly now: Date;
  readonly staleAfterMs?: number | undefined;
  readonly cursor?: Pick<StoredProjectionCursor, "nextBlock" | "finalizedBlock"> | undefined;
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
