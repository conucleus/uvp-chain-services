// Read-side projection availability: a chain read may only serve a full
// projection snapshot, or prove that an order/task is absent, when the snapshot
// was materialized and the readable sync state is current. A missing or lagging
// projection is reported as retryable 503 instead of an empty 200 or a 404.

import type { ProjectionSnapshotKind } from "../storage/projection-store.js";
import {
  indexerStaleAfterMs,
  readProjectionState,
  type ProjectionReadState,
  type ProjectionReadStatus
} from "../storage/sync-state.js";
import type { ApiResponse, ApiRouteContext } from "./route-context.js";

export interface ProjectionAvailability {
  readonly syncStatus: ProjectionReadStatus;
  readonly current: boolean;
}

export async function readProjectionAvailability(
  context: ApiRouteContext
): Promise<ProjectionAvailability> {
  const state = await readProjectionStateForRead(context);
  return {
    syncStatus: state?.status ?? "not_started",
    current: state?.status === "current"
  };
}

export async function readProjectionStateForRead(
  context: ApiRouteContext
): Promise<ProjectionReadState | undefined> {
  return readProjectionState(context.store, {
    now: context.now?.() ?? new Date(),
    staleAfterMs: indexerStaleAfterMs(context.indexerDiagnostics)
  });
}

export async function requireMaterializedProjection(
  context: ApiRouteContext,
  kind: ProjectionSnapshotKind
): Promise<ApiResponse | undefined> {
  if (await context.store.hasProjectionSnapshot(kind)) {
    return undefined;
  }
  const availability = await readProjectionAvailability(context);
  return projectionUnavailableResponse(availability.syncStatus, "unavailable");
}

export async function requireCurrentProjection(
  context: ApiRouteContext
): Promise<ApiResponse | undefined> {
  const availability = await readProjectionAvailability(context);
  if (!availability.current) {
    return projectionUnavailableResponse(
      availability.syncStatus,
      availability.syncStatus === "not_started" ? "unavailable" : "stale"
    );
  }
  if (await context.store.hasProjectionSnapshot("order")) {
    return undefined;
  }
  return projectionUnavailableResponse(availability.syncStatus, "unavailable");
}

export type ProjectionUnavailableKind = "unavailable" | "stale";

export function projectionUnavailableResponse(
  syncStatus: ProjectionReadStatus,
  kind: ProjectionUnavailableKind = syncStatus === "not_started" ? "unavailable" : "stale"
): ApiResponse {
  return {
    status: 503,
    body: {
      error: kind === "unavailable" ? "chain_projection_unavailable" : "chain_projection_stale",
      message: kind === "unavailable"
        ? "the chain projection snapshot is missing for this chain; absence is unknown until a rebuild materializes it"
        : "the chain projection is not current; absence is unknown until the indexer catches up",
      retryable: true,
      syncStatus
    }
  };
}
