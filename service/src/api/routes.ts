import type { ProjectionStore } from "../storage/projection-store.js";
import type { Hex } from "../shared/types.js";
import { createNoopComplianceService } from "../compliance/index.js";
import { createNoopRiskGraphService } from "../risk/index.js";
import { createProductService, ProductOrderLookupError } from "../product/application/service.js";
import {
  createProductBffService,
} from "../product/query/bff/service.js";
import type { ProductBffStore } from "../product/query/bff/store.js";
import { createEvidenceService, LocalEvidenceStorage } from "../evidence/index.js";
import { createGovernanceService } from "../governance/index.js";
import {
  createStoreZhixuDraftWorkflowService,
  MemoryStoreZhixuDraftStore
} from "../store/console/zhixu-drafts.js";
import { createStoreRuntimeService } from "../store/console/runtime.js";
import {
  createStoreZhixuVersionService,
  MemoryStoreZhixuVersionMetadataStore
} from "../store/console/version.js";
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
import { noopAuditSink } from "../security/audit.js";
import { buildOperationalDiagnostics } from "./diagnostics.js";
import {
  createNotificationService,
  createSupplierNotificationProfileConfigService
} from "../notifications/index.js";
import { createStoreConsoleService } from "../store/console/service.js";
import { MemoryStoreAuditStore } from "../store/console/audit.js";
import { createStoreIdentityProvider } from "../store/console/access.js";
import { createStoreDockingService, MemoryStoreDockingSessionStore } from "../store/console/docking.js";
import { createStoreSupplierService, InMemoryStoreSupplierMetadataStore } from "../store/suppliers/service.js";
import {
  createStoreSessionService,
  createWalletSessionStoreIdentityProvider,
  InMemoryStoreWalletSessionStore
} from "../store/sessions/index.js";
import {
  createStoreDecorationService,
  InMemoryStorePublisherDelegationStore,
  InMemoryStoreZhixuDecorationStore
} from "../store/decoration/index.js";
import {
  InMemoryStoreIdentityDescriptorSnapshotStore
} from "../governance/descriptors.js";
import {
  createStoreListingService,
  InMemoryStoreListingStore
} from "../store/listings/index.js";
import {
  createStoreJoinService,
  InMemoryStoreJoinApplicationStore
} from "../store/join/index.js";
import { createStoreAuthRouteModule } from "./routes/store-auth.js";
import { createStoreDecorationRouteModule } from "./routes/store-decoration.js";
import { createStoreJoinRouteModule } from "./routes/store-join.js";
import { createStoreListingsRouteModule } from "./routes/store-listings.js";
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
  // 运行环境只接受显式注入（config.security.environment 或等价的
  // configDiagnostics.environment），绝不缺省 local——身份门/证据边界/
  // 诊断全部以该档位定宽严，漏传即 fail-closed 拒绝装配。
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
  const identityDescriptorSnapshots = options.identityDescriptorSnapshots
    ?? new InMemoryStoreIdentityDescriptorSnapshotStore();
  const governanceService = options.governanceService ?? createGovernanceService({
    ...(options.governanceStore ? { store: options.governanceStore } : {}),
    audit,
    descriptorSnapshotStore: identityDescriptorSnapshots,
    ...(options.descriptorPublicBaseUrl ? { descriptorPublicBaseUrl: options.descriptorPublicBaseUrl } : {})
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
    ? productBffStoreSubmissionAuthorization(options.productBffStore, store)
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
      runtimeEnvironment: options.evidenceRuntimeEnvironment ?? productRuntimeEnvironment
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
    // plan 作用域 submitSignal 的 planId 取自索引器投影
    // （OrderRegistered/OrderMaterialized 的 indexed planId）。
    resolveOrderPlanId: resolveOrderPlanIdFromStore(store),
    ...(options.submissionBroadcastAdapter ? { broadcastAdapter: options.submissionBroadcastAdapter } : {}),
    ...(submissionAuthorization ? { authorization: submissionAuthorization } : {}),
    audit
  });
  const stageExecutorPatchChainId = options.stageExecutorPatchChainId ?? options.submissionChainId;
  // patch/docking 模块地址必须显式提供（地址清单），
  // 不默认到 submissionVerifyingContract（状态机地址）；缺省时服务不持有
  // 模块地址，patch/docking prepare 按模块地址缺失 fail-closed。
  const stageExecutorPatchVerifyingContract = options.stageExecutorPatchVerifyingContract;
  const productStageExecutorPatchService = options.productStageExecutorPatchService ?? createProductStageExecutorPatchService({
    store,
    productSchemaResolver,
    ...(options.productBffStore ? { productBffStore: options.productBffStore } : {}),
    ...(stageExecutorPatchChainId !== undefined ? { chainId: stageExecutorPatchChainId } : {}),
    ...(stageExecutorPatchVerifyingContract ? { stagePatchModuleAddress: stageExecutorPatchVerifyingContract } : {}),
    ...(options.stageExecutorPatchBroadcastAdapter ? { broadcastAdapter: options.stageExecutorPatchBroadcastAdapter } : {}),
    // 持久驱动（sqlite/postgres）注入持久化 stage-patch store；未注入
    // （memory）时服务内部回落内存 store。
    ...(options.stageExecutorPatchStore ? { stageExecutorPatchStore: options.stageExecutorPatchStore } : {}),
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
    ...(options.stageResourcePatchStore ? { stageResourcePatchStore: options.stageResourcePatchStore } : {}),
    ...(productRuntimeEnvironment ? { runtimeEnvironment: productRuntimeEnvironment } : {}),
    ...(options.now ? { now: options.now } : {})
  });
  const buildDiagnostics = () => buildOperationalDiagnostics({
    store,
    ...(options.configDiagnostics ? { configDiagnostics: options.configDiagnostics } : {}),
    runtimeEnvironment: productRuntimeEnvironment,
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
    evidenceRuntimeEnvironment: options.evidenceRuntimeEnvironment ?? productRuntimeEnvironment
  });
  const now = options.now ?? (() => new Date());
  const storeWalletSessionStore = options.storeWalletSessionStore ?? new InMemoryStoreWalletSessionStore();
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
  // 钱包会话叠加层（未启用时原样透传，fail-closed）。
  const storeIdentityProvider = createWalletSessionStoreIdentityProvider({
    base: baseStoreIdentityProvider,
    sessionService,
    ...(storeAuthConfig?.walletSession ? { config: storeAuthConfig.walletSession } : {}),
    runtimeEnvironment: productRuntimeEnvironment
  });
  const storeDecorationService = options.storeDecorationService ?? createStoreDecorationService({
    projectionStore: store,
    decorationStore: options.storeDecorationStore ?? new InMemoryStoreZhixuDecorationStore(),
    delegationStore: options.storePublisherDelegationStore ?? new InMemoryStorePublisherDelegationStore(),
    ...(options.now ? { now: options.now } : {})
  });
  const listingService = options.storeListingService ?? createStoreListingService({
    projectionStore: store,
    listingStore: options.storeListingStore ?? new InMemoryStoreListingStore(),
    ...(options.listingAnchorChainView ? { chainView: options.listingAnchorChainView } : {}),
    ...(options.now ? { now: options.now } : {})
  });
  const joinService = options.storeJoinService ?? createStoreJoinService({
    projectionStore: store,
    productService,
    supplierService: storeSupplierService,
    publisherAccess: storeDecorationService,
    // 红线：加入入口被下架/锚冲突 listing 抑制（服务端强制）。
    listingGate: {
      getListingForPlan: async (planId) => {
        const detail = await listingService.findListingByPlanId(planId);
        if (!detail) {
          return undefined;
        }
        return {
          status: detail.listing.status,
          anchorVerification: { status: detail.anchorVerification.status }
        };
      }
    },
    joinStore: options.storeJoinApplicationStore ?? new InMemoryStoreJoinApplicationStore(),
    ...(options.now ? { now: options.now } : {})
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
    sessionService,
    decorationService: storeDecorationService,
    listingService,
    joinService,
    identityDescriptorSnapshots,
    governanceService,
    complianceService,
    riskGraphService,
    notificationService,
    supplierNotificationConfigService,
    evidenceService,
    submissionService,
    productStageExecutorPatchService,
    productStageResourcePatchService,
    ...(options.submissionStore ? { submissionStore: options.submissionStore } : {}),
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
    createAdminOpsRouteModule(),
    createStoreAuthRouteModule({ sessionService }),
    createStoreConsoleRouteModule({ runtimeEnvironment: productRuntimeEnvironment }),
    createStoreDecorationRouteModule({ decorationService: storeDecorationService }),
    createStoreJoinRouteModule({ joinService }),
    createStoreListingsRouteModule({ listingService }),
    createStoreComplianceRouteModule(),
    createStoreDockingRouteModule(),
    createStoreRiskRouteModule(),
    createStoreSuppliersRouteModule(),
    createGovernanceRouteModule(),
    createNotificationsRouteModule({ runtimeEnvironment: productRuntimeEnvironment }),
    createEvidenceRouteModule({
      runtimeEnvironment: options.evidenceRuntimeEnvironment ?? productRuntimeEnvironment
    }),
    createStagePatchRouteModule({ runtimeEnvironment: productRuntimeEnvironment }),
    createSubmissionsRouteModule({ runtimeEnvironment: productRuntimeEnvironment }),
    createProductBffRouteModule({ runtimeEnvironment: productRuntimeEnvironment }),
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

export function productBffStoreSubmissionAuthorization(
  store: ProductBffStore,
  projectionStore?: ProjectionStore
): SubmissionAuthorizationAdapter {
  return {
    async authorize(request) {
      // 《授权与签名规则》§五：执行者变更/委任不抹除既有的显式订单级
      // 授权——先看显式 trigger 授权，命中即放行；未命中再看阶段委任的
      // 在任执行者（overlay）。overlay 优先会一票否决显式授权者，
      // 与合约口径（显式优先）相反。
      const registrations = await store.listRegistrations();
      const matches = registrations.filter((item) =>
        equalHex(item.orderId, request.onchainOrderId) || item.orderId.toLowerCase() === request.orderId.toLowerCase()
      );
      // 同号订单跨 plan 复用时歧义即拒（ambiguous_order_id），不取第一条，
      // 防止用别的 plan 的 trigger 授权通过本单的提交鉴权。
      const distinctPlanIds = new Set(matches.map((item) => item.planId.toLowerCase()));
      if (distinctPlanIds.size > 1) {
        return {
          authorized: false,
          source: "product_bff_trigger",
          reason: "ambiguous_order_id: order id exists on multiple plans"
        };
      }
      const registration = matches[0];
      if (registration) {
        const authorized = registration.authorizations.some((authorization) =>
          equalHex(authorization.sourceId, request.sourceId) &&
          equalHex(authorization.signalId, request.signalId) &&
          authorization.submitter.toLowerCase() === request.submitter.toLowerCase()
        );
        if (authorized) {
          return { authorized: true, source: "product_bff_trigger" };
        }
      }
      // 《授权与签名规则》§四/§五 + 合约 _isSignalSubmitterAuthorized 的
      // 两腿结构：显式授权未命中不是终局否决——链上还可能有阶段委任
      // 记录。链上腿（显式+委任）与任务 overlay 兜底依序合并裁决，
      // 任一命中即放行；全部未命中才拒绝，并以最具信息量的腿作为
      // 拒绝理由。显式命中即短路是安全的；显式未命中短路才是缺陷
      // （会把委任执行者系统性 403）。
      const chainAuthorization = await chainSignalSubmitterAuthorization(projectionStore, request);
      if (chainAuthorization?.verdict) {
        return chainAuthorization.verdict;
      }
      const overlayAuthorization = productBffActiveStageExecutorAuthorization(request);
      if (overlayAuthorization) {
        return overlayAuthorization;
      }
      return chainAuthorization?.miss ?? {
        authorized: false,
        source: "product_bff_trigger",
        reason: registration
          ? "submitter is not present in order trigger authorizations"
          : "order trigger authorization was not found"
      };
    }
  };
}

/**
 * 链上事后授权（SignalSubmitterAuthorized 事件投影）：参与方在订单
 * 创建后才拿到 (sourceId, signalId, submitter) 授权时，BFF trigger
 * 台账里没有对应记录——不读投影会让合法参与方的 prepare-submit 403。
 * 同号订单跨 plan 复用与 BFF 路径同口径歧义即拒。
 *
 * 与合约 _isSignalSubmitterAuthorized 同构的两腿结构：
 * - 显式腿：order.authorizations，键 `${sourceId}:${signalId}:${submitter}`；
 * - 委任腿：order.signalDelegations，键 `${sourceId}:${signalId}`（真实
 *   链上 sourceId，不是 targetStageId——合约 _delegatedStageSignalAuthorizations
 *   按信号键落库，StageExecutorSignalDelegated 由 patch 模块按阶段能力
 *   的真实 (targetSourceId, signalId) 逐条委派），executor 匹配即命中。
 *
 * verdict 是立即裁决（命中/歧义拒绝）；miss 只在两腿都评估过且未命中时
 * 出现——未命中不是终局否决，调用方继续评估任务 overlay 兜底，仍未决
 * 时才以 miss 作为最终拒绝理由。
 */
async function chainSignalSubmitterAuthorization(
  projectionStore: ProjectionStore | undefined,
  request: SubmissionAuthorizationRequest
): Promise<
  | { readonly verdict?: SubmissionAuthorizationResult; readonly miss?: SubmissionAuthorizationResult }
  | undefined
> {
  if (!projectionStore) {
    return undefined;
  }
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
  // 投影键与 indexer signalAuthorizationProjectionKey 同构：
  // `${sourceId}:${signalId}:${submitter 小写}`。
  const authorizationKey = `${request.sourceId}:${request.signalId}:${request.submitter.toLowerCase()}`;
  if (orders.some((order) => order.authorizations[authorizationKey] !== undefined)) {
    return {
      verdict: { authorized: true, source: "chain_signal_authorization" }
    };
  }
  // 委任腿：键与 indexer signalProjectionKey 同构 `${sourceId}:${signalId}`。
  const delegationKey = `${request.sourceId}:${request.signalId}`;
  const delegated = orders.some((order) => {
    const delegation = order.signalDelegations[delegationKey];
    return delegation !== undefined && delegation.executor.toLowerCase() === request.submitter.toLowerCase();
  });
  if (delegated) {
    return {
      verdict: { authorized: true, source: "chain_signal_delegation" }
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

/**
 * 任务 overlay 兜底（无链上投影裁决时的近似授权）：投影在场时委任
 * 已由 chainSignalSubmitterAuthorization 的委任腿按真实 (sourceId,
 * signalId) 键精确裁决（合约 _delegatedStageSignalAuthorizations 同构）；
 * 本腿只覆盖任务自带 overlay 而投影未裁决的场景。targetStageId ==
 * request.sourceId 是保守的阶段绑定——放宽为"在任执行者可提交任意
 * 记录信号"会授权链上必 revert 的签名（active patch 单独不构成提交
 * 权，见 _isSignalSubmitterAuthorized），保持 fail-closed。
 */
function productBffActiveStageExecutorAuthorization(
  request: SubmissionAuthorizationRequest
): SubmissionAuthorizationResult | undefined {
  // 无任务上下文（链上腿评估过的请求可以不带 task）即无 overlay 可言。
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

  // overlay 委任只覆盖目标阶段已记录的真实提交信号（proof.signalId 来自
  // 投影 submitSignals）。signalId 是推导值（proof 缺signalId 时按
  // stageId+intent 拼出）意味着无法证明链上存在该信号——为必 revert 的
  // 签名完成授权并广播，必须在授权层拒绝。
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

/**
 * plan 作用域 submitSignal 的 planId 从索引器投影读取
 * （OrderRegistered/OrderMaterialized 均带 indexed planId，投影行已存）。
 * 找不到非零 planId 时返回 undefined，由 submission service 拒绝 prepare；
 * 同号订单跨 plan 复用（多命中非零 planId）时歧义即拒
 * （ambiguous_order_id，对齐 product/service.ts resolveProductOrder 先例），
 * 绝不取第一个。
 */
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
