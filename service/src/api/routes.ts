import type { ProjectionStore } from "../storage/projection-store.js";
import type { Hex } from "../shared/types.js";
import { submissionProjectionConfirmation } from "../reconcile/worker.js";
import { resolvePlanCapabilityTablesFromStore } from "../submissions/capability-proofs.js";
import {
  createProductSubmissionService,
  ProductOrderLookupError,
  ProductSubmissionError,
  type ProductTaskReader,
  type ProductSubmissionEvidenceReader,
  type SubmissionAuthorizationAdapter,
  type SubmissionAuthorizationRequest,
  type SubmissionAuthorizationResult
} from "../submissions/index.js";
import {
  createProductStageExecutorPatchService,
  createProductStageResourcePatchService
} from "../stage-patches/index.js";
import { noopAuditSink, type AuditSink } from "../security/audit.js";
import type { AdminAuthPolicy } from "../security/admin-auth.js";
import { buildOperationalDiagnostics } from "./diagnostics.js";
import type { ApiRouteContext, ApiRouter, CreateApiRouterOptions } from "./route-context.js";
import type { RouteModule } from "./route-module.js";
import { createDiagnosticsRouteModule } from "./routes/diagnostics.js";
import { createChainReadRouteModule } from "./routes/chain-read.js";
import { createAdminOpsRouteModule } from "./routes/admin-ops.js";
import { createV1OrderGoneRouteModule } from "./routes/v1-gone.js";
import { createSubmissionsRouteModule } from "./routes/submissions.js";
import { createStagePatchRouteModule } from "./routes/stage-patches.js";
import { createIdentityBindingsRouteModule } from "./routes/identity-bindings.js";

export type {
  AdminOpsActionEffect,
  AdminOpsRecoveryActions,
  AdminOpsRetrySubmissionInput,
  ApiRequest,
  ApiResponse,
  ApiRouter,
  CreateApiRouterOptions
} from "./route-context.js";

export function createApiRouter(store: ProjectionStore, options: CreateApiRouterOptions): ApiRouter {
  const audit = options.audit ?? noopAuditSink;
  const runtimeEnvironment = options.runtimeEnvironment;
  if (!runtimeEnvironment) {
    throw new Error("runtimeEnvironment is required to create the API router");
  }
  const submissionChainId = options.submissionChainId;
  if (submissionChainId === undefined) {
    throw new Error("submissionChainId is required to create the product submission service");
  }
  const submissionVerifyingContract = options.submissionVerifyingContract;
  if (submissionVerifyingContract === undefined) {
    throw new Error("submissionVerifyingContract is required to create the product submission service");
  }
  const submissionService = options.submissionService ?? createProductSubmissionService({
    productTasks: legacyProductTaskReader(),
    evidenceReader: legacyEvidenceReader(),
    store: options.submissionStore,
    chainId: submissionChainId,
    verifyingContract: submissionVerifyingContract,
    resolveOrderPlanId: resolveOrderPlanIdFromStore(store),
    resolvePlanCapabilityTables: resolvePlanCapabilityTablesFromStore(store),
    probePriorSubmissionOnChain: priorSubmissionChainProbeFromStore(store),
    ...(options.submissionBroadcastAdapter ? { broadcastAdapter: options.submissionBroadcastAdapter } : {}),
    authorization: projectionSubmissionAuthorization(store),
    audit
  });
  const stageExecutorPatchChainId = options.stageExecutorPatchChainId ?? options.submissionChainId;
  const stageExecutorPatchVerifyingContract = options.stageExecutorPatchVerifyingContract;
  const productStageExecutorPatchService = options.productStageExecutorPatchService ?? createProductStageExecutorPatchService({
    store,
    ...(stageExecutorPatchChainId !== undefined ? { chainId: stageExecutorPatchChainId } : {}),
    ...(stageExecutorPatchVerifyingContract ? { stagePatchModuleAddress: stageExecutorPatchVerifyingContract } : {}),
    ...(options.stageExecutorPatchBroadcastAdapter ? { broadcastAdapter: options.stageExecutorPatchBroadcastAdapter } : {}),
    stageExecutorPatchStore: options.stageExecutorPatchStore,
    ...(options.chainClock ? { chainClock: options.chainClock } : {}),
    runtimeEnvironment: runtimeEnvironment,
    ...(options.now ? { now: options.now } : {})
  });
  const stageResourcePatchChainId = options.stageResourcePatchChainId ?? options.submissionChainId;
  const stageResourcePatchVerifyingContract = options.stageResourcePatchVerifyingContract;
  const productStageResourcePatchService = options.productStageResourcePatchService ?? createProductStageResourcePatchService({
    store,
    ...(stageResourcePatchChainId !== undefined ? { chainId: stageResourcePatchChainId } : {}),
    ...(stageResourcePatchVerifyingContract ? { stagePatchModuleAddress: stageResourcePatchVerifyingContract } : {}),
    ...(options.stageResourcePatchBroadcastAdapter ? { broadcastAdapter: options.stageResourcePatchBroadcastAdapter } : {}),
    stageResourcePatchStore: options.stageResourcePatchStore,
    ...(options.chainClock ? { chainClock: options.chainClock } : {}),
    runtimeEnvironment: runtimeEnvironment,
    ...(options.now ? { now: options.now } : {})
  });
  const buildDiagnostics = () => buildOperationalDiagnostics({
    store,
    ...(options.configDiagnostics ? { configDiagnostics: options.configDiagnostics } : {}),
    runtimeEnvironment: runtimeEnvironment,
    ...(options.indexerDiagnostics ? { indexer: options.indexerDiagnostics } : {}),
    ...(options.reconcileDiagnostics ? { reconcile: options.reconcileDiagnostics } : {}),
    submissionStore: options.submissionStore
  });
  const now = options.now ?? (() => new Date());
  const adminAuthPolicy: AdminAuthPolicy = options.adminAuthPolicy ?? {
    runtimeEnvironment: runtimeEnvironment,
    allowedAdminIds: options.opsConsoleAdminIds ?? []
  };
  const context: ApiRouteContext = {
    store,
    submissionService,
    productStageExecutorPatchService,
    productStageResourcePatchService,
    submissionStore: options.submissionStore,
    ...(options.opsRecoveryActions ? { opsRecoveryActions: options.opsRecoveryActions } : {}),
    ...(options.opsConsoleAdminIds ? { opsConsoleAdminIds: options.opsConsoleAdminIds } : {}),
    adminAuthPolicy,
    audit,
    buildDiagnostics,
    ...(options.onTxMined ? { onTxMined: options.onTxMined } : {}),
    now
  };
  const modules: readonly RouteModule[] = [
    createDiagnosticsRouteModule(),
    createChainReadRouteModule(),
    createAdminOpsRouteModule(),
    createV1OrderGoneRouteModule(),
    createIdentityBindingsRouteModule(),
    createStagePatchRouteModule({ runtimeEnvironment }),
    createSubmissionsRouteModule({ runtimeEnvironment })
  ];

  return {
    async handle(request) {
      for (const module of modules) {
        const response = await module.handle(request, context);
        if (response) {
          return response;
        }
      }
      return {
        status: 404,
        body: { error: "not_found" }
      };
    }
  };
}

// Product task and evidence reads moved to uvp-app-backend. Keep the legacy
// prepare surface explicit about it instead of fabricating task/evidence rows.
function legacyProductTaskReader(): ProductTaskReader {
  return {
    async getTask() {
      throw new ProductSubmissionError(
        503,
        "product_task_read_moved",
        "product task reads are served by uvp-app-backend; chain-services prepare is legacy"
      );
    }
  };
}

function legacyEvidenceReader(): ProductSubmissionEvidenceReader {
  const moved = async (): Promise<never> => {
    throw new ProductSubmissionError(
      503,
      "evidence_service_moved",
      "evidence metadata is served by uvp-app-backend; chain-services prepare is legacy"
    );
  };
  return {
    getEvidence: moved,
    getProof: moved,
    bindEvidence: moved
  };
}

export function projectionSubmissionAuthorization(
  projectionStore: ProjectionStore
): SubmissionAuthorizationAdapter {
  return {
    async authorize(request) {
      const chainAuthorization = await chainSignalSubmitterAuthorization(projectionStore, request);
      if (chainAuthorization?.verdict) {
        return chainAuthorization.verdict;
      }
      const overlayAuthorization = activeStageExecutorAuthorization(request);
      if (overlayAuthorization) {
        return overlayAuthorization;
      }
      return chainAuthorization?.miss ?? {
        authorized: false,
        source: "chain_signal_authorization",
        reason: "order projection was not found for this order id"
      };
    }
  };
}

async function chainSignalSubmitterAuthorization(
  projectionStore: ProjectionStore,
  request: SubmissionAuthorizationRequest
): Promise<
  | { readonly verdict?: SubmissionAuthorizationResult; readonly miss?: SubmissionAuthorizationResult }
  | undefined
> {
  const orders = await projectionStore.findStateMachineOrdersByOrderId(request.onchainOrderId);
  if (orders.length === 0) {
    return undefined;
  }
  const distinctPlanIds = new Set(orders.map((order) => order.planId.toLowerCase()));
  if (distinctPlanIds.size > 1) {
    return {
      verdict: {
        authorized: false,
        source: "chain_signal_authorization",
        reason: "ambiguous_order_id: order id exists on multiple plans"
      }
    };
  }
  const authorizationKey = `${request.sourceId}:${request.signalId}:${request.submitter.toLowerCase()}`;
  if (orders.some((order) => order.authorizations[authorizationKey] !== undefined)) {
    return {
      verdict: { authorized: true, source: "chain_signal_authorization" }
    };
  }
  return {
    miss: {
      authorized: false,
      source: "chain_signal_authorization",
      reason: "submitter is not authorized on chain for this signal"
    }
  };
}

type ProductTaskWithExecutorOverlay = {
  readonly executorOverlay?: ProductTaskExecutorOverlay;
  readonly stageExecutorOverlay?: ProductTaskExecutorOverlay;
  readonly proof?: {
    readonly signalId?: string;
  };
};

type ProductTaskExecutorOverlay = {
  readonly targetStageId?: string;
  readonly activeExecutorWallet?: string;
};

function activeStageExecutorAuthorization(
  request: SubmissionAuthorizationRequest
): SubmissionAuthorizationResult | undefined {
  if (!request.task) {
    return undefined;
  }
  const task = request.task as ProductTaskWithExecutorOverlay;
  const executorOverlay = task.stageExecutorOverlay ?? task.executorOverlay;
  if (!executorOverlay?.targetStageId || !executorOverlay?.activeExecutorWallet) {
    return undefined;
  }

  if (!equalHex(executorOverlay.targetStageId, request.sourceId)) {
    return {
      authorized: false,
      source: "active_stage_executor_overlay",
      reason: "active executor overlay does not target the submitted source"
    };
  }

  const recordedSignalId = task.proof?.signalId;
  if (!recordedSignalId || !equalHex(recordedSignalId, request.signalId)) {
    return {
      authorized: false,
      source: "active_stage_executor_overlay",
      reason: "active executor overlay only covers the task's recorded submit signal; refusing to authorize a derived signal that has no chain counterpart"
    };
  }

  const authorized = executorOverlay.activeExecutorWallet.toLowerCase() === request.submitter.toLowerCase();
  return {
    authorized,
    source: "active_stage_executor_overlay",
    ...(authorized ? {} : { reason: "submitter is not the active stage executor" })
  };
}

function equalHex(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";

function resolveOrderPlanIdFromStore(
  store: ProjectionStore
): (onchainOrderId: Hex) => Promise<Hex | undefined> {
  return async (onchainOrderId) => {
    const orders = await store.findStateMachineOrdersByOrderId(onchainOrderId);
    const candidates = orders.filter((candidate) =>
      Boolean(candidate.planId) &&
      candidate.planId.toLowerCase() !== ZERO_BYTES32
    );
    const distinctPlanIds = new Set(candidates.map((candidate) => candidate.planId.toLowerCase()));
    if (distinctPlanIds.size > 1) {
      throw new ProductOrderLookupError(
        "ambiguous_order_id",
        "order id exists on multiple plans; refusing to pick a planId for the plan-scoped signature",
        {
          orderId: onchainOrderId,
          planIds: [...distinctPlanIds]
        }
      );
    }
    return candidates[0]?.planId;
  };
}

function priorSubmissionChainProbeFromStore(
  store: ProjectionStore
): (prepared: import("../submissions/types.js").PreparedSubmissionRecord) => Promise<import("../submissions/service.js").PriorSubmissionChainProbe> {
  return async (prepared) => {
    try {
      const confirmation = await submissionProjectionConfirmation(store, prepared);
      return confirmation
        ? {
            outcome: "confirmed",
            txHash: confirmation.transactionHash,
            ...(confirmation.blockNumber ? { blockNumber: confirmation.blockNumber } : {})
          }
        : { outcome: "absent" };
    } catch {
      return { outcome: "unknown" };
    }
  };
}

