// Live dock binding window enrichment: binding identity/emitted is the
// event-rebuilt projection, while the current A/B window snapshot comes from
// the stage-patch module's dockOutputWindow view at read time (relative due,
// no wall clock). Window state is never persisted and opened_by/closed_by are
// omitted when no history exists.
import { toWire } from "@uvp-eth/chain-read-contract";
import type { ChainDockBinding, ChainDockBindingOutput } from "@uvp-eth/chain-read-contract";
import { DOCK_PAYLOAD_FILE_KEY, STAGE_PATCH_MODULE_ABI } from "@uvp-eth/protocol-bindings";
import { compareChainPointers } from "@uvp-eth/service-runtime";
import {
  createPublicClient,
  http,
  type Address,
  type Hex,
} from "viem";
import type { StateMachineDockBindingProjection } from "../indexer/projections/dock.js";
import type { ProjectionProvenance, ProjectionSnapshot } from "../indexer/projections/index.js";

export interface DockOutputWindowRequest {
  readonly planId: Hex;
  readonly orderId: Hex;
  readonly targetStageId: Hex;
  readonly fromOrderId: Hex;
  readonly outputIndex: number;
}

export interface DockOutputWindowState {
  readonly current: boolean;
  readonly aSatisfied: boolean;
  readonly aDueInSeconds: number;
  readonly bSatisfied: boolean;
  readonly emitted: boolean;
}

export interface DockBindingWindowReader {
  readWindow(request: DockOutputWindowRequest): Promise<DockOutputWindowState>;
}

export class DockBindingWindowUnavailableError extends Error {
  override readonly name = "DockBindingWindowUnavailableError";
}

export function createDockBindingWindowReader(options: {
  readonly rpcUrl: string;
  readonly stagePatchAddress: Address;
  readonly cacheTtlMs?: number;
}): DockBindingWindowReader {
  const client = createPublicClient({ transport: http(options.rpcUrl) });
  const cacheTtlMs = options.cacheTtlMs ?? 1_000;
  const cache = new Map<
    string,
    { readonly expiresAt: number; readonly value: Promise<DockOutputWindowState> }
  >();
  return {
    async readWindow(request) {
      const key = [
        request.planId,
        request.orderId,
        request.targetStageId,
        request.fromOrderId,
        request.outputIndex
      ].join(":").toLowerCase();
      const now = Date.now();
      const cached = cache.get(key);
      if (cached && cached.expiresAt > now) {
        return cached.value;
      }
      const value = (async (): Promise<DockOutputWindowState> => {
        try {
          const result = (await client.readContract({
            address: options.stagePatchAddress,
            abi: STAGE_PATCH_MODULE_ABI,
            functionName: "dockOutputWindow",
            args: [
              request.planId,
              request.orderId,
              request.targetStageId,
              request.fromOrderId,
              BigInt(request.outputIndex)
            ]
          })) as readonly [boolean, boolean, bigint, boolean, boolean];
          return {
            current: result[0],
            aSatisfied: result[1],
            aDueInSeconds: Number(result[2]),
            bSatisfied: result[3],
            emitted: result[4]
          };
        } catch (error) {
          throw new DockBindingWindowUnavailableError(
            `dock binding window view failed: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      })();
      cache.set(key, { expiresAt: now + cacheTtlMs, value });
      try {
        return await value;
      } catch (error) {
        cache.delete(key);
        throw error;
      }
    }
  };
}

export async function wireDockBindings(
  snapshot: ProjectionSnapshot,
  reader: DockBindingWindowReader | undefined
): Promise<Readonly<Record<string, ChainDockBinding>>> {
  const rows = Object.values(snapshot.stateMachineDockBindings);
  if (rows.length === 0) {
    return {};
  }
  if (!reader) {
    throw new DockBindingWindowUnavailableError(
      "dock binding window reader is not configured while dock bindings exist; refusing to serve stale windows"
    );
  }
  const latestByStage = latestBindingByStage(rows);
  const wired = await Promise.all(
    rows.map(async (row) => [row, await wireBinding(snapshot, row, reader, latestByStage)] as const)
  );
  return Object.fromEntries(
    wired.map(([row, binding]) => [row.bindingId.toLowerCase(), binding])
  );
}

function latestBindingByStage(
  rows: readonly StateMachineDockBindingProjection[]
): ReadonlyMap<string, StateMachineDockBindingProjection> {
  const latest = new Map<string, StateMachineDockBindingProjection>();
  for (const row of rows) {
    const key = stageKey(row.planId, row.orderId, row.targetStageId);
    const current = latest.get(key);
    if (current === undefined || compareChainPointers(row.pokedAt, current.pokedAt) > 0) {
      latest.set(key, row);
    }
  }
  return latest;
}

function stageKey(planId: Hex, orderId: Hex, targetStageId: Hex): string {
  return `${planId.toLowerCase()}:${orderId.toLowerCase()}:${targetStageId.toLowerCase()}`;
}

function bindingStageFile(
  snapshot: ProjectionSnapshot,
  row: StateMachineDockBindingProjection
) : { readonly updatedAt: ProjectionProvenance } | undefined {
  const order = Object.values(snapshot.stateMachineOrders).find(
    (candidate) =>
      candidate.planId.toLowerCase() === row.planId.toLowerCase() &&
      candidate.orderId.toLowerCase() === row.orderId.toLowerCase()
  );
  if (!order) {
    return undefined;
  }
  const stageFiles = Object.entries(order.stageFiles).find(
    ([stageId]) => stageId.toLowerCase() === row.targetStageId.toLowerCase()
  )?.[1];
  if (!stageFiles) {
    return undefined;
  }
  const entry = Object.entries(stageFiles.files).find(
    ([key]) => key.toLowerCase() === DOCK_PAYLOAD_FILE_KEY.toLowerCase()
  )?.[1];
  return entry === undefined ? undefined : { updatedAt: entry.updatedAt };
}

async function wireBinding(
  snapshot: ProjectionSnapshot,
  row: StateMachineDockBindingProjection,
  reader: DockBindingWindowReader,
  latestByStage: ReadonlyMap<string, StateMachineDockBindingProjection>
): Promise<ChainDockBinding> {
  const latest = latestByStage.get(stageKey(row.planId, row.orderId, row.targetStageId));
  const file = bindingStageFile(snapshot, row);
  const pending =
    latest === undefined ||
    latest.bindingId.toLowerCase() !== row.bindingId.toLowerCase() ||
    file === undefined ||
    compareChainPointers(file.updatedAt, row.pokedAt) > 0;
  if (pending) {
    return toWire({
      binding_id: row.bindingId,
      dkid: row.dkid,
      from_zhixu_id: row.fromZhixuId,
      from_source: row.fromSource,
      from_order_id: row.fromOrderId,
      to_zhixu_id: row.toZhixuId,
      to_stage_identifier: row.toStageIdentifier,
      to_order_id: row.orderId,
      pending: true,
      ...(row.selectedBy ? { selected_by: row.selectedBy } : {}),
      outputs: row.outputs.map((output) => ({
        signal: output.signal,
        emitted: output.emitted,
        ...(output.emittedBy ? { emitted_by: output.emittedBy } : {}),
        ...(output.emittedBindingId ? { emitted_binding_id: output.emittedBindingId } : {})
      })),
      ...(row.proof ? { proof: row.proof } : {})
    });
  }

  const windows = await Promise.all(
    row.outputs.map(async (output) =>
      reader.readWindow({
        planId: row.planId,
        orderId: row.orderId,
        targetStageId: row.targetStageId,
        fromOrderId: row.fromOrderId,
        outputIndex: output.outputIndex
      })
    )
  );
  if (windows.some((window) => !window.current)) {
    return toWire({
      binding_id: row.bindingId,
      dkid: row.dkid,
      from_zhixu_id: row.fromZhixuId,
      from_source: row.fromSource,
      from_order_id: row.fromOrderId,
      to_zhixu_id: row.toZhixuId,
      to_stage_identifier: row.toStageIdentifier,
      to_order_id: row.orderId,
      pending: true,
      ...(row.selectedBy ? { selected_by: row.selectedBy } : {}),
      outputs: row.outputs.map((output) => ({
        signal: output.signal,
        emitted: output.emitted,
        ...(output.emittedBy ? { emitted_by: output.emittedBy } : {}),
        ...(output.emittedBindingId ? { emitted_binding_id: output.emittedBindingId } : {})
      })),
      ...(row.proof ? { proof: row.proof } : {})
    });
  }

  const outputs = row.outputs.map((output, index): ChainDockBindingOutput => {
    const window = windows[index]!;
    return toWire({
      signal: output.signal,
      a_window: {
        satisfied: window.aSatisfied,
        ...(window.aDueInSeconds > 0 ? { delay_seconds: window.aDueInSeconds } : {})
      },
      b_window: { satisfied: window.bSatisfied },
      emitted: window.emitted,
      ...(output.emittedBy ? { emitted_by: output.emittedBy } : {}),
      ...(output.emittedBindingId ? { emitted_binding_id: output.emittedBindingId } : {})
    });
  });
  return toWire({
    binding_id: row.bindingId,
    dkid: row.dkid,
    from_zhixu_id: row.fromZhixuId,
    from_source: row.fromSource,
    from_order_id: row.fromOrderId,
    to_zhixu_id: row.toZhixuId,
    to_stage_identifier: row.toStageIdentifier,
    to_order_id: row.orderId,
    ...(row.selectedBy ? { selected_by: row.selectedBy } : {}),
    outputs,
    ...(row.proof ? { proof: row.proof } : {})
  });
}
