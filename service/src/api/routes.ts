import type { ProjectionStore } from "../storage/projection-store.js";
import type { Hex } from "../shared/types.js";
import { createNoopComplianceService } from "../compliance/index.js";
import { createNoopRiskGraphService } from "../risk/index.js";
import { createProductService } from "../product/service.js";
import {
  createProductBffService,
} from "../product/bff/service.js";
import type { ProductBffStore } from "../product/bff/store.js";
import { createEvidenceService, LocalEvidenceStorage } from "../evidence/index.js";
import { createGovernanceService } from "../governance/index.js";
import {
  createStoreZhixuDraftWorkflowService,
  MemoryStoreZhixuDraftStore
} from "../store-console/zhixu-drafts.js";
import { createStoreRuntimeService } from "../store-console/runtime.js";
import {
  createStoreZhixuVersionService,
  MemoryStoreZhixuVersionMetadataStore
} from "../store-console/version.js";
import {
  createProductSubmissionService,
  type SubmissionAuthorizationAdapter,
  type SubmissionAuthorizationRequest,
  type SubmissionAuthorizationResult
} from "../submissions/index.js";
import {
  createProductDockedOrderLinkService,
  createProductStageExecutorPatchService,
  createProductStageResourcePatchService
} from "../stage-patches/index.js";
import { noopAuditSink } from "../security/audit.js";
import { buildOperationalDiagnostics } from "./diagnostics.js";
import {
  createNotificationService,
  createSupplierNotificationProfileConfigService
} from "../notifications/index.js";
import { createStoreConsoleService } from "../store-console/service.js";
import { MemoryStoreAuditStore } from "../store-console/audit.js";
import { createStoreIdentityProvider } from "../store-console/access.js";
import { createStoreDockingService, MemoryStoreDockingSessionStore } from "../store-console/docking.js";
import { createStoreSupplierService, InMemoryStoreSupplierMetadataStore } from "../store-suppliers/service.js";
import type { ApiRouteContext, ApiRouter, CreateApiRouterOptions } from "./route-context.js";
import type { RouteModule } from "./route-module.js";
import { createDiagnosticsRouteModule } from "./routes/diagnostics.js";
import { createAdminOpsRouteModule } from "./routes/admin-ops.js";
import { createEvidenceRouteModule } from "./routes/evidence.js";
import { createGovernanceRouteModule } from "./routes/governance.js";
import { createNotificationsRouteModule } from "./routes/notifications.js";
import { createProductBffRouteModule } from "./routes/product-bff.js";
import { createProductReadRouteModule } from "./routes/product-read.js";
import { createStoreConsoleRouteModule } from "./routes/store-console.js";
import { createStoreComplianceRouteModule } from "./routes/store-compliance.js";
import { createStoreDockingRouteModule } from "./routes/store-docking.js";
import { createStoreRiskRouteModule } from "./routes/store-risk.js";
import { createStoreSuppliersRouteModule } from "./routes/store-suppliers.js";
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

export function createApiRouter(store: ProjectionStore, options: CreateApiRouterOptions = {}): ApiRouter {
  const audit = options.audit ?? noopAuditSink;
  const productRuntimeEnvironment = options.productRuntimeEnvironment ?? options.configDiagnostics?.environment;
  const storeZhixuDraftStore = options.storeZhixuDraftStore ?? new MemoryStoreZhixuDraftStore();
  const storeZhixuVersionMetadataStore = options.storeZhixuVersionMetadataStore ?? new MemoryStoreZhixuVersionMetadataStore();
  const storeSupplierMetadataStore = options.storeSupplierMetadataStore ?? new InMemoryStoreSupplierMetadataStore();
  const storeDockingSessionStore = options.storeDockingSessionStore ?? new MemoryStoreDockingSessionStore();
  const storeAuditStore = options.storeAuditStore ?? new MemoryStoreAuditStore();
  const productSchemaResolver = options.productSchemaResolver ?? {
    getProductSchemaByPlan: (planId: string, planHash: string, artifactHash?: string) =>
      storeZhixuDraftStore.findProductSchemaByPlan(planId, planHash, artifactHash)
  };
  const productService = createProductService(store, { productSchemaResolver });
  const storeConsoleService = createStoreConsoleService({
    productService,
    store,
    supplierMetadataStore: storeSupplierMetadataStore
  });
  const storeDockingService = createStoreDockingService({
    productService,
    sessionStore: storeDockingSessionStore,
    ...(options.now ? { now: options.now } : {})
  });
  const governanceService = options.governanceService ?? createGovernanceService({
    ...(options.governanceStore ? { store: options.governanceStore } : {}),
    audit
  });
  const complianceService = options.complianceService ?? createNoopComplianceService();
  const riskGraphService = options.riskGraphService ?? createNoopRiskGraphService();
  const storeRuntimeService = createStoreRuntimeService({
    productService,
    store,
    ...(options.now ? { now: options.now } : {})
  });
  const storeZhixuVersionService = createStoreZhixuVersionService({
    productService,
    projectionStore: store,
    metadataStore: storeZhixuVersionMetadataStore,
    ...(options.now ? { now: options.now } : {})
  });
  const submissionAuthorization = options.productBffStore
    ? productBffStoreSubmissionAuthorization(options.productBffStore)
    : undefined;
  const productTriggerChainId = options.productTriggerChainId ?? options.submissionChainId;
  if (productTriggerChainId === undefined) {
    throw new Error("productTriggerChainId or submissionChainId is required to create the Product BFF service");
  }
  const productBffService = createProductBffService({
    productService,
    ...(options.productBffStore ? { store: options.productBffStore } : {}),
    ...(options.productRegistrationAdapter ? { registrationAdapter: options.productRegistrationAdapter } : {}),
    ...(options.productTriggerAdapter ? { triggerAdapter: options.productTriggerAdapter } : {}),
    ...(options.productRegistrationCreatorAddress ? { registrationCreatorAddress: options.productRegistrationCreatorAddress } : {}),
    ...(options.productRegistrarAddress ? { registrarAddress: options.productRegistrarAddress } : {}),
    triggerChainId: productTriggerChainId,
    versionResolver: storeZhixuVersionService,
    ...(options.now ? { now: options.now } : {})
  });
  const defaultEvidenceStorage = options.evidenceStorage ?? (options.evidenceService ? undefined : new LocalEvidenceStorage());
  const evidenceService = options.evidenceService ?? (
    createEvidenceService({
      ...(options.evidenceMetadataStore ? { metadataStore: options.evidenceMetadataStore } : {}),
      storage: defaultEvidenceStorage ?? new LocalEvidenceStorage(),
      runtimeEnvironment: options.evidenceRuntimeEnvironment ?? productRuntimeEnvironment ?? "local"
    })
  );
  const storeZhixuDraftWorkflowService = options.storeZhixuDraftWorkflowService ??
    createStoreZhixuDraftWorkflowService({
      draftStore: storeZhixuDraftStore,
      governanceService,
      projectionStore: store,
      ...(options.now ? { now: options.now } : {})
    });
  const storeSupplierService = createStoreSupplierService({
    productService,
    store,
    governanceService,
    metadataStore: storeSupplierMetadataStore
  });
  const notificationService = options.notificationService ?? createNotificationService({
    store,
    supplierMetadataStore: storeSupplierMetadataStore,
    productSchemaResolver
  });
  const supplierNotificationConfigService = options.supplierNotificationConfigService ??
    createSupplierNotificationProfileConfigService();
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
    ...(options.submissionStore ? { store: options.submissionStore } : {}),
    chainId: submissionChainId,
    verifyingContract: submissionVerifyingContract,
    // 审计 #10：plan 作用域 submitSignal 的 planId 取自索引器投影
    // （OrderRegistered/OrderMaterialized 的 indexed planId）。
    resolveOrderPlanId: resolveOrderPlanIdFromStore(store),
    ...(options.submissionBroadcastAdapter ? { broadcastAdapter: options.submissionBroadcastAdapter } : {}),
    ...(submissionAuthorization ? { authorization: submissionAuthorization } : {}),
    audit
  });
  const stageExecutorPatchChainId = options.stageExecutorPatchChainId ?? options.submissionChainId;
  // 审计 fail-open：patch/docking 模块地址必须显式提供（地址清单），
  // 不再默认到 submissionVerifyingContract（状态机地址）；缺省时服务不持有
  // 模块地址，patch/docking prepare 按模块地址缺失 fail-closed。
  const stageExecutorPatchVerifyingContract = options.stageExecutorPatchVerifyingContract;
  const productStageExecutorPatchService = options.productStageExecutorPatchService ?? createProductStageExecutorPatchService({
    store,
    productSchemaResolver,
    ...(options.productBffStore ? { productBffStore: options.productBffStore } : {}),
    ...(stageExecutorPatchChainId !== undefined ? { chainId: stageExecutorPatchChainId } : {}),
    ...(stageExecutorPatchVerifyingContract ? { stagePatchModuleAddress: stageExecutorPatchVerifyingContract } : {}),
    ...(options.stageExecutorPatchBroadcastAdapter ? { broadcastAdapter: options.stageExecutorPatchBroadcastAdapter } : {}),
    ...(options.now ? { now: options.now } : {})
  });
  const stageResourcePatchChainId = options.stageResourcePatchChainId ?? options.submissionChainId;
  const stageResourcePatchVerifyingContract = options.stageResourcePatchVerifyingContract;
  const productStageResourcePatchService = options.productStageResourcePatchService ?? createProductStageResourcePatchService({
    store,
    productSchemaResolver,
    ...(options.productBffStore ? { productBffStore: options.productBffStore } : {}),
    ...(stageResourcePatchChainId !== undefined ? { chainId: stageResourcePatchChainId } : {}),
    ...(stageResourcePatchVerifyingContract ? { stagePatchModuleAddress: stageResourcePatchVerifyingContract } : {}),
    ...(options.stageResourcePatchBroadcastAdapter ? { broadcastAdapter: options.stageResourcePatchBroadcastAdapter } : {}),
    ...(productRuntimeEnvironment ? { runtimeEnvironment: productRuntimeEnvironment } : {}),
    ...(options.now ? { now: options.now } : {})
  });
  const dockedOrderLinkChainId = options.dockedOrderLinkChainId ?? options.submissionChainId;
  const dockedOrderLinkVerifyingContract = options.dockedOrderLinkVerifyingContract;
  const productDockedOrderLinkService = options.productDockedOrderLinkService ?? createProductDockedOrderLinkService({
    store,
    productSchemaResolver,
    ...(options.productBffStore ? { productBffStore: options.productBffStore } : {}),
    ...(dockedOrderLinkChainId !== undefined ? { chainId: dockedOrderLinkChainId } : {}),
    ...(dockedOrderLinkVerifyingContract ? { dockingModuleAddress: dockedOrderLinkVerifyingContract } : {}),
    ...(options.dockedOrderLinkBroadcastAdapter ? { broadcastAdapter: options.dockedOrderLinkBroadcastAdapter } : {}),
    ...(options.now ? { now: options.now } : {})
  });
  const buildDiagnostics = () => buildOperationalDiagnostics({
    store,
    ...(options.configDiagnostics ? { configDiagnostics: options.configDiagnostics } : {}),
    ...(productRuntimeEnvironment ? { runtimeEnvironment: productRuntimeEnvironment } : {}),
    ...(options.indexerDiagnostics ? { indexer: options.indexerDiagnostics } : {}),
    ...(options.reconcileDiagnostics ? { reconcile: options.reconcileDiagnostics } : {}),
    ...(options.submissionStore ? { submissionStore: options.submissionStore } : {}),
    ...(options.governanceStore ? { governanceStore: options.governanceStore } : {}),
    storeMetadataStores: {
      draft: storeZhixuDraftStore,
      version: storeZhixuVersionMetadataStore,
      supplier: storeSupplierMetadataStore,
      docking: storeDockingSessionStore
    },
    ...(defaultEvidenceStorage ? { evidenceStorage: defaultEvidenceStorage } : {}),
    ...(options.evidenceRuntimeEnvironment ?? productRuntimeEnvironment
      ? { evidenceRuntimeEnvironment: (options.evidenceRuntimeEnvironment ?? productRuntimeEnvironment)! }
      : {})
  });
  const now = options.now ?? (() => new Date());
  const storeIdentityProvider = options.storeIdentityProvider ?? createStoreIdentityProvider({
    ...(productRuntimeEnvironment ? { runtimeEnvironment: productRuntimeEnvironment } : {}),
    ...(options.storeAuthConfig ? { authConfig: options.storeAuthConfig } : {})
  });
  const context: ApiRouteContext = {
    store,
    productService,
    productBffService,
    storeConsoleService,
    storeDockingService,
    storeRuntimeService,
    storeZhixuVersionService,
    storeZhixuDraftWorkflowService,
    storeSupplierService,
    storeAuditStore,
    storeIdentityProvider,
    governanceService,
    complianceService,
    riskGraphService,
    notificationService,
    supplierNotificationConfigService,
    evidenceService,
    submissionService,
    productStageExecutorPatchService,
    productStageResourcePatchService,
    productDockedOrderLinkService,
    ...(options.submissionStore ? { submissionStore: options.submissionStore } : {}),
    ...(options.opsRecoveryActions ? { opsRecoveryActions: options.opsRecoveryActions } : {}),
    ...(options.opsConsoleAdminIds ? { opsConsoleAdminIds: options.opsConsoleAdminIds } : {}),
    audit,
    buildDiagnostics,
    ...(options.onTxMined ? { onTxMined: options.onTxMined } : {}),
    now
  };
  const modules: readonly RouteModule[] = [
    createDiagnosticsRouteModule(),
    createAdminOpsRouteModule(),
    createStoreConsoleRouteModule(),
    createStoreComplianceRouteModule(),
    createStoreDockingRouteModule(),
    createStoreRiskRouteModule(),
    createStoreSuppliersRouteModule(),
    createGovernanceRouteModule(),
    createNotificationsRouteModule(),
    createEvidenceRouteModule(),
    createStagePatchRouteModule(),
    createSubmissionsRouteModule(),
    createProductBffRouteModule(),
    createProductReadRouteModule()
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

export function productBffStoreSubmissionAuthorization(store: ProductBffStore): SubmissionAuthorizationAdapter {
  return {
    async authorize(request) {
      const overlayAuthorization = productBffActiveStageExecutorAuthorization(request);
      if (overlayAuthorization) {
        return overlayAuthorization;
      }

      const registrations = await store.listRegistrations();
      const registration = registrations.find((item) =>
        equalHex(item.orderId, request.onchainOrderId) || item.orderId.toLowerCase() === request.orderId.toLowerCase()
      );
      if (!registration) {
        return {
          authorized: false,
          source: "product_bff_trigger",
          reason: "order trigger authorization was not found"
        };
      }
      const authorized = registration.authorizations.some((authorization) =>
        equalHex(authorization.sourceId, request.sourceId) &&
        equalHex(authorization.signalId, request.signalId) &&
        authorization.submitter.toLowerCase() === request.submitter.toLowerCase()
      );
      return {
        authorized,
        source: "product_bff_trigger",
        ...(authorized ? {} : { reason: "submitter is not present in order trigger authorizations" })
      };
    }
  };
}

type ProductTaskWithExecutorOverlay = {
  readonly executorOverlay?: ProductTaskExecutorOverlay;
  readonly stageExecutorOverlay?: ProductTaskExecutorOverlay;
};

type ProductTaskExecutorOverlay = {
  readonly targetStageId?: string;
  readonly activeExecutorWallet?: string;
};

function productBffActiveStageExecutorAuthorization(
  request: SubmissionAuthorizationRequest
): SubmissionAuthorizationResult | undefined {
  const task = request.task as ProductTaskWithExecutorOverlay;
  const executorOverlay = task.stageExecutorOverlay ?? task.executorOverlay;
  if (!executorOverlay?.targetStageId || !executorOverlay.activeExecutorWallet) {
    return undefined;
  }

  if (!equalHex(executorOverlay.targetStageId, request.sourceId)) {
    return {
      authorized: false,
      source: "active_stage_executor_overlay",
      reason: "active executor overlay does not target the submitted source"
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

/**
 * 审计 #10：plan 作用域 submitSignal 的 planId 从索引器投影读取
 * （OrderRegistered/OrderMaterialized 均带 indexed planId，投影行已存）。
 * 找不到非零 planId 时返回 undefined，由 submission service 拒绝 prepare。
 */
function resolveOrderPlanIdFromStore(
  store: ProjectionStore
): (onchainOrderId: Hex) => Promise<Hex | undefined> {
  return async (onchainOrderId) => {
    const orders = await store.findStateMachineOrdersByOrderId(onchainOrderId);
    const order = orders.find((candidate) =>
      Boolean(candidate.planId) &&
      candidate.planId.toLowerCase() !== ZERO_BYTES32
    );
    return order?.planId;
  };
}
