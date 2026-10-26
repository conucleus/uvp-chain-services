import type { ProjectionStore } from "../storage/projection-store.js";
import type { Hex } from "../shared/types.js";
import { submissionProjectionConfirmation } from "../reconcile/worker.js";
import { resolvePlanCapabilityTablesFromStore, type PlanCapabilityTables } from "../submissions/capability-proofs.js";
import { createProductService, ProductOrderLookupError } from "../product/application/service.js";
import {
  createProductBffService,
} from "../product/query/bff/service.js";
import { createOrderService } from "../order/index.js";
import type { ProductBffStore } from "../product/query/bff/store.js";
import { createEvidenceService, LocalEvidenceStorage } from "../evidence/index.js";
import { createGovernanceService } from "../governance/index.js";
import {
  createProductSubmissionService,
  type SubmissionAuthorizationAdapter,
  type SubmissionAuthorizationRequest,
  type SubmissionAuthorizationResult
} from "../submissions/index.js";
import {
  createProductStageExecutorPatchService,
  createProductStageResourcePatchService
} from "../stage-patches/index.js";
import { noopAuditSink, type AuditSink } from "../security/audit.js";
import { buildOperationalDiagnostics } from "./diagnostics.js";
import { createStoreIdentityProvider } from "../store/console/access.js";
import {
  createStoreSessionService,
  createWalletSessionStoreIdentityProvider
} from "../store/sessions/index.js";
import { createStoreAuthRouteModule } from "./routes/store-auth.js";
import type { ApiRouteContext, ApiRouter, CreateApiRouterOptions } from "./route-context.js";
import type { RouteModule } from "./route-module.js";
import { createDiagnosticsRouteModule } from "./routes/diagnostics.js";
import { createChainReadRouteModule } from "./routes/chain-read.js";
import { createAdminOpsRouteModule } from "./routes/admin-ops.js";
import { createEvidenceRouteModule } from "./routes/evidence.js";
import { createGovernanceRouteModule } from "./routes/governance.js";
import { createV1OrderGoneRouteModule } from "./routes/v1-gone.js";
import { createProductOrderRouteModule } from "./routes/product-order.js";
import { createProductSignalsRouteModule } from "./routes/product-signals.js";
import { createProductReadKernelRouteModule } from "./routes/product-read-kernel.js";
import { createResourceResolver } from "../resources/resolver.js";
import { createProductTasksRouteModule } from "./routes/product-tasks.js";
import { createProductReadRouteModule } from "./routes/product-read.js";
import { createSubmissionsRouteModule } from "./routes/submissions.js";
import { createStagePatchRouteModule } from "./routes/stage-patches.js";

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
  const productRuntimeEnvironment = options.productRuntimeEnvironment ?? options.configDiagnostics?.environment;
  if (!productRuntimeEnvironment) {
    throw new Error("productRuntimeEnvironment (or configDiagnostics.environment) is required to create the API router");
  }
  const governanceAdminPolicy = {
    runtimeEnvironment: productRuntimeEnvironment,
    allowedAdminIds: options.governanceAdminIds ?? [],
    ...(options.governanceAdminTokenHashes && options.governanceAdminTokenHashes.length > 0
      ? { adminTokenHashes: options.governanceAdminTokenHashes }
      : {})
  };
  const productSchemaResolver = options.productSchemaResolver;
  const productService = createProductService(
    store,
    productSchemaResolver ? { productSchemaResolver } : {},
  );
  const identityDescriptorSnapshots = options.identityDescriptorSnapshots;
  const governanceService = options.governanceService ?? createGovernanceService({
    store: options.governanceStore,
    audit,
    descriptorSnapshotStore: identityDescriptorSnapshots,
    ...(options.descriptorPublicBaseUrl ? { descriptorPublicBaseUrl: options.descriptorPublicBaseUrl } : {})
  });
  const submissionAuthorization = projectionSubmissionAuthorization(store);
  const resolveDraftOrder = productBffStoreDraftOrderResolver(options.productBffStore);
  const productBffStore = options.productBffStore;
  const productTriggerChainId = options.productTriggerChainId ?? options.submissionChainId;
  const productBffService = createProductBffService({
    productService,
    store: productBffStore,
    ...(options.now ? { now: options.now } : {})
  });
  const defaultEvidenceStorage = options.evidenceStorage ?? (options.evidenceService ? undefined : new LocalEvidenceStorage());
  const evidenceService = options.evidenceService ?? (
    createEvidenceService({
      metadataStore: options.evidenceMetadataStore,
      storage: defaultEvidenceStorage ?? new LocalEvidenceStorage(),
      runtimeEnvironment: options.evidenceRuntimeEnvironment ?? productRuntimeEnvironment,
      resolveDraftOrder,
      audit
    })
  );
  const submissionChainId = options.submissionChainId;
  if (submissionChainId === undefined) {
    throw new Error("submissionChainId is required to create the product submission service");
  }
  const submissionVerifyingContract = options.submissionVerifyingContract;
  if (submissionVerifyingContract === undefined) {
    throw new Error("submissionVerifyingContract is required to create the product submission service");
  }
  const submissionService = options.submissionService ?? createProductSubmissionService({
    productTasks: productService,
    evidenceReader: evidenceService,
    store: options.submissionStore,
    chainId: submissionChainId,
    verifyingContract: submissionVerifyingContract,
    resolveOrderPlanId: resolveOrderPlanIdFromStore(store),
    resolvePlanCapabilityTables: resolvePlanCapabilityTablesFromStore(store),
    resolveDraftOrder,
    probePriorSubmissionOnChain: priorSubmissionChainProbeFromStore(store),
    ...(options.submissionBroadcastAdapter ? { broadcastAdapter: options.submissionBroadcastAdapter } : {}),
    ...(submissionAuthorization ? { authorization: submissionAuthorization } : {}),
    audit
  });
  const stageExecutorPatchChainId = options.stageExecutorPatchChainId ?? options.submissionChainId;
  const stageExecutorPatchVerifyingContract = options.stageExecutorPatchVerifyingContract;
  const productStageExecutorPatchService = options.productStageExecutorPatchService ?? createProductStageExecutorPatchService({
    store,
    ...(productSchemaResolver ? { productSchemaResolver } : {}),
    ...(options.productBffStore ? { productBffStore: options.productBffStore } : {}),
    ...(stageExecutorPatchChainId !== undefined ? { chainId: stageExecutorPatchChainId } : {}),
    ...(stageExecutorPatchVerifyingContract ? { stagePatchModuleAddress: stageExecutorPatchVerifyingContract } : {}),
    ...(options.stageExecutorPatchBroadcastAdapter ? { broadcastAdapter: options.stageExecutorPatchBroadcastAdapter } : {}),
    stageExecutorPatchStore: options.stageExecutorPatchStore,
    ...(options.productChainClock ? { chainClock: options.productChainClock } : {}),
    ...(options.now ? { now: options.now } : {})
  });
  const stageResourcePatchChainId = options.stageResourcePatchChainId ?? options.submissionChainId;
  const stageResourcePatchVerifyingContract = options.stageResourcePatchVerifyingContract;
  const productStageResourcePatchService = options.productStageResourcePatchService ?? createProductStageResourcePatchService({
    store,
    ...(productSchemaResolver ? { productSchemaResolver } : {}),
    ...(options.productBffStore ? { productBffStore: options.productBffStore } : {}),
    ...(stageResourcePatchChainId !== undefined ? { chainId: stageResourcePatchChainId } : {}),
    ...(stageResourcePatchVerifyingContract ? { stagePatchModuleAddress: stageResourcePatchVerifyingContract } : {}),
    ...(options.stageResourcePatchBroadcastAdapter ? { broadcastAdapter: options.stageResourcePatchBroadcastAdapter } : {}),
    stageResourcePatchStore: options.stageResourcePatchStore,
    ...(options.productChainClock ? { chainClock: options.productChainClock } : {}),
    ...(productRuntimeEnvironment ? { runtimeEnvironment: productRuntimeEnvironment } : {}),
    ...(options.now ? { now: options.now } : {})
  });
  const buildDiagnostics = () => buildOperationalDiagnostics({
    store,
    ...(options.configDiagnostics ? { configDiagnostics: options.configDiagnostics } : {}),
    runtimeEnvironment: productRuntimeEnvironment,
    ...(options.indexerDiagnostics ? { indexer: options.indexerDiagnostics } : {}),
    ...(options.reconcileDiagnostics ? { reconcile: options.reconcileDiagnostics } : {}),
    submissionStore: options.submissionStore,
    governanceStore: options.governanceStore,
    ...(defaultEvidenceStorage ? { evidenceStorage: defaultEvidenceStorage } : {}),
    evidenceRuntimeEnvironment: options.evidenceRuntimeEnvironment ?? productRuntimeEnvironment
  });
  const now = options.now ?? (() => new Date());
  const storeWalletSessionStore = options.storeWalletSessionStore;
  const storeAuthConfig = options.storeAuthConfig;
  const sessionService = options.storeSessionService ?? createStoreSessionService({
    store: storeWalletSessionStore,
    ...(storeAuthConfig?.walletSession ? { config: storeAuthConfig.walletSession } : {}),
    ...(options.now ? { now: options.now } : {})
  });
  const baseStoreIdentityProvider = options.storeIdentityProvider ?? createStoreIdentityProvider({
    runtimeEnvironment: productRuntimeEnvironment,
    ...(storeAuthConfig ? { authConfig: storeAuthConfig } : {}),
    ...(options.governanceAdminIds ? { governanceAdminIds: options.governanceAdminIds } : {}),
    ...(options.governanceAdminTokenHashes && options.governanceAdminTokenHashes.length > 0
      ? { governanceAdminTokenHashes: options.governanceAdminTokenHashes }
      : {})
  });
  const storeIdentityProvider = createWalletSessionStoreIdentityProvider({
    base: baseStoreIdentityProvider,
    sessionService,
    ...(storeAuthConfig?.walletSession ? { config: storeAuthConfig.walletSession } : {}),
    runtimeEnvironment: productRuntimeEnvironment
  });
  const orderStore = options.orderStore;
  const orderService = options.orderService ?? createOrderService({
    store: orderStore,
    chainId: options.orderChainId ?? options.productTriggerChainId ?? options.submissionChainId ?? 0,
    ...(options.orderStateMachineAddress ?? options.submissionVerifyingContract
      ? { stateMachine: options.orderStateMachineAddress ?? options.submissionVerifyingContract! }
      : {}),
    publisherWallets: options.orderConfigPublisherWallets ?? [],
    ...(options.orderPublishedPlanProvider ? { publishedPlanProvider: options.orderPublishedPlanProvider } : {}),
    ...(options.orderBirthPort ? { birthPort: options.orderBirthPort } : {}),
    ...(options.orderTriggerPort ? { triggerPort: options.orderTriggerPort } : {}),
    chainProjection: {
      findChainOrders: (orderId) => store.findStateMachineOrdersByOrderId(orderId)
    },
    ...(options.now ? { now: options.now } : {})
  });
  const orderResourceResolver = options.orderResourceResolver ?? createResourceResolver({
    loadOrder: (orderId) => orderService.loadOrderSnapshotForVisibility(orderId),
    ...(options.orderOperatorWallets !== undefined
      ? { operatorWallets: options.orderOperatorWallets }
      : {}),
  });
  const context: ApiRouteContext = {
    store,
    productService,
    productBffService,
    orderService,
    storeIdentityProvider,
    sessionService,
    identityDescriptorSnapshots,
    governanceService,
    evidenceService,
    submissionService,
    productStageExecutorPatchService,
    productStageResourcePatchService,
    submissionStore: options.submissionStore,
    ...(options.opsRecoveryActions ? { opsRecoveryActions: options.opsRecoveryActions } : {}),
    ...(options.opsConsoleAdminIds ? { opsConsoleAdminIds: options.opsConsoleAdminIds } : {}),
    audit,
    buildDiagnostics,
    governanceAdminPolicy,
    ...(options.onTxMined ? { onTxMined: options.onTxMined } : {}),
    now
  };
  const modules: readonly RouteModule[] = [
    createDiagnosticsRouteModule(),
    createChainReadRouteModule(),
    createAdminOpsRouteModule(),
    createV1OrderGoneRouteModule(),
    createStoreAuthRouteModule({ sessionService }),
    createGovernanceRouteModule(),
    createEvidenceRouteModule({
      runtimeEnvironment: options.evidenceRuntimeEnvironment ?? productRuntimeEnvironment
    }),
    createStagePatchRouteModule({ runtimeEnvironment: productRuntimeEnvironment }),
    createSubmissionsRouteModule({ runtimeEnvironment: productRuntimeEnvironment }),
    createProductSignalsRouteModule({
      ...(options.orderOperatorWallets !== undefined ? { operatorWallets: options.orderOperatorWallets } : {}),
      resourceResolver: orderResourceResolver,
      planCapabilities: resolvePlanCapabilityTablesFromStore(store)
    }),
    createProductReadKernelRouteModule({
      ...(options.orderOperatorWallets !== undefined ? { operatorWallets: options.orderOperatorWallets } : {}),
      resourceResolver: orderResourceResolver,
    }),
    createProductTasksRouteModule({
      ...(options.orderOperatorWallets !== undefined ? { operatorWallets: options.orderOperatorWallets } : {}),
    }),
    createProductOrderRouteModule(),
    createProductReadRouteModule({ runtimeEnvironment: productRuntimeEnvironment })
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

export function productBffStoreDraftOrderResolver(
  store: ProductBffStore
): (draftId: string) => Promise<string | undefined> {
  return async (draftId) => {
    const registration = await store.getRegistrationByDraft(draftId);
    if (registration) {
      return registration.orderId;
    }
    return (await store.getDraft(draftId))?.triggeredOrderId;
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
