import type { ChainServicesRuntimeEnv, ConfigDiagnostics, StoreAuthConfig } from "../config/index.js";
import type { ComplianceService } from "../compliance/index.js";
import type {
  EvidenceMetadataStore,
  EvidenceService,
  EvidenceStorage
} from "../evidence/index.js";
import type { GovernanceService, GovernanceStore } from "../governance/index.js";
import type { ProductBffService } from "../product/bff/service.js";
import type { ProductOrderTriggerBroadcastAdapter } from "../product/bff/trigger.js";
import type { ProductBffStore } from "../product/bff/store.js";
import type { ProductSchemaResolver, ProductService } from "../product/service.js";
import type { ReconcileWorkerDiagnostics } from "../reconcile/index.js";
import type { RiskGraphService } from "../risk/index.js";
import type { AuditSink } from "../security/audit.js";
import type { Address } from "../shared/types.js";
import type { ProjectionStore } from "../storage/projection-store.js";
import type {
  ProductSubmissionDTO,
  ProductSubmissionService,
  ProductSubmissionStore,
  SubmissionBroadcastAdapter
} from "../submissions/index.js";
import type {
  ProductStageExecutorPatchService,
  ProductStageResourcePatchService,
  StageExecutorPatchBroadcastAdapter,
  StageResourcePatchBroadcastAdapter
} from "../stage-patches/index.js";
import type {
  NotificationService,
  SupplierNotificationProfileConfigService
} from "../notifications/index.js";
import type {
  StoreConsoleService
} from "../store-console/service.js";
import type {
  StoreAuditStore
} from "../store-console/audit.js";
import type {
  StoreIdentityProvider
} from "../store-console/access.js";
import type {
  StoreDockingSessionStore,
  StoreDockingService
} from "../store-console/docking.js";
import type {
  StoreRuntimeService
} from "../store-console/runtime.js";
import type {
  StoreZhixuDraftStore,
  StoreZhixuDraftWorkflowService
} from "../store-console/zhixu-drafts.js";
import type {
  StoreZhixuVersionMetadataStore,
  StoreZhixuVersionService
} from "../store-console/version.js";
import type {
  StoreSupplierMetadataStore,
  StoreSupplierService
} from "../store-suppliers/service.js";
import type { StoreSessionService, StoreWalletSessionStore } from "../store-sessions/index.js";
import type { StoreDecorationService, StoreZhixuDecorationStore, StorePublisherDelegationStore } from "../store-decoration/index.js";
import type { StoreIdentityDescriptorSnapshotStore } from "../governance/descriptors.js";
import type { ListingAnchorChainView, StoreListingService, StoreListingStore } from "../store-listings/index.js";
import type { StoreJoinService, StoreJoinApplicationStore } from "../store-join/index.js";
import type { IndexerRuntimeDiagnostics } from "./diagnostics.js";

export interface ApiRequest {
  readonly method: string;
  readonly pathname: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly headers?: Readonly<Record<string, string | undefined>>;
  readonly body?: unknown;
}

export interface ApiResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface ApiRouter {
  handle(request: ApiRequest): Promise<ApiResponse>;
}

export interface CreateApiRouterOptions {
  readonly evidenceService?: EvidenceService;
  readonly evidenceMetadataStore?: EvidenceMetadataStore;
  readonly governanceService?: GovernanceService;
  readonly complianceService?: ComplianceService;
  readonly riskGraphService?: RiskGraphService;
  readonly governanceStore?: GovernanceStore;
  readonly submissionService?: ProductSubmissionService;
  readonly submissionStore?: ProductSubmissionStore;
  readonly submissionChainId?: number;
  readonly submissionVerifyingContract?: Address;
  readonly submissionBroadcastAdapter?: SubmissionBroadcastAdapter;
  readonly productStageExecutorPatchService?: ProductStageExecutorPatchService;
  readonly stageExecutorPatchBroadcastAdapter?: StageExecutorPatchBroadcastAdapter;
  readonly stageExecutorPatchChainId?: number;
  readonly stageExecutorPatchVerifyingContract?: Address;
  readonly productStageResourcePatchService?: ProductStageResourcePatchService;
  readonly stageResourcePatchBroadcastAdapter?: StageResourcePatchBroadcastAdapter;
  readonly stageResourcePatchChainId?: number;
  readonly stageResourcePatchVerifyingContract?: Address;
  readonly productBffStore?: ProductBffStore;
  readonly productRegistrationAdapter?: ProductOrderTriggerBroadcastAdapter;
  readonly productTriggerAdapter?: ProductOrderTriggerBroadcastAdapter;
  readonly productTriggerChainId?: number;
  readonly productRegistrationCreatorAddress?: Address;
  readonly productRegistrarAddress?: Address;
  readonly productRuntimeEnvironment?: ChainServicesRuntimeEnv;
  readonly audit?: AuditSink;
  readonly configDiagnostics?: ConfigDiagnostics;
  readonly indexerDiagnostics?: IndexerRuntimeDiagnostics;
  readonly reconcileDiagnostics?: ReconcileWorkerDiagnostics | (() => ReconcileWorkerDiagnostics);
  readonly evidenceStorage?: EvidenceStorage;
  readonly evidenceRuntimeEnvironment?: ChainServicesRuntimeEnv;
  readonly notificationService?: NotificationService;
  readonly supplierNotificationConfigService?: SupplierNotificationProfileConfigService;
  readonly storeZhixuDraftStore?: StoreZhixuDraftStore;
  readonly storeZhixuDraftWorkflowService?: StoreZhixuDraftWorkflowService;
  readonly productSchemaResolver?: ProductSchemaResolver;
  readonly storeZhixuVersionMetadataStore?: StoreZhixuVersionMetadataStore;
  readonly storeDockingSessionStore?: StoreDockingSessionStore;
  readonly storeSupplierMetadataStore?: StoreSupplierMetadataStore;
  readonly storeAuditStore?: StoreAuditStore;
  readonly storeIdentityProvider?: StoreIdentityProvider;
  readonly storeAuthConfig?: StoreAuthConfig;
  readonly storeWalletSessionStore?: StoreWalletSessionStore;
  readonly storeSessionService?: StoreSessionService;
  readonly storeDecorationStore?: StoreZhixuDecorationStore;
  readonly storePublisherDelegationStore?: StorePublisherDelegationStore;
  readonly storeDecorationService?: StoreDecorationService;
  readonly identityDescriptorSnapshots?: StoreIdentityDescriptorSnapshotStore;
  readonly descriptorPublicBaseUrl?: string;
  readonly storeListingStore?: StoreListingStore;
  readonly storeListingService?: StoreListingService;
  readonly listingAnchorChainView?: ListingAnchorChainView;
  readonly storeJoinService?: StoreJoinService;
  readonly storeJoinApplicationStore?: StoreJoinApplicationStore;
  readonly opsRecoveryActions?: AdminOpsRecoveryActions;
  /**
   * OPS_CONSOLE_ADMIN_IDS 白名单（去空格后的 id 列表）。非空时
   * /admin/ops 只放行集合内的 admin id；未配置时回退到既有 governance
   * admin 鉴权（adminPrincipalFromHeaders），保持本地开发兼容。
   */
  readonly opsConsoleAdminIds?: readonly string[];
  readonly onTxMined?: () => void;
  readonly now?: () => Date;
}

export interface AdminOpsActionEffect {
  readonly status?: "accepted" | "queued" | "running" | "completed";
  readonly nextCheckAt?: string;
  readonly summary?: unknown;
}

export interface AdminOpsRetrySubmissionInput {
  readonly submissionId: string;
  readonly submission?: ProductSubmissionDTO;
}

export interface AdminOpsRecoveryActions {
  runReconcile?(): Promise<AdminOpsActionEffect | void>;
  rebuildProjections?(): Promise<AdminOpsActionEffect | void>;
  retrySubmission?(input: AdminOpsRetrySubmissionInput): Promise<AdminOpsActionEffect | void>;
  /** 补投 post-commit 失败批次（游标已前进的持久 pending 队列）。 */
  sweepPendingPostCommitSteps?(): Promise<AdminOpsActionEffect | void>;
  /** 列出 pending 队列（人工研判）。 */
  listPendingPostCommitSteps?(): Promise<unknown>;
}

export interface ApiRouteContext {
  readonly store: ProjectionStore;
  readonly productService: ProductService;
  readonly productBffService: ProductBffService;
  readonly storeConsoleService: StoreConsoleService;
  readonly storeDockingService: StoreDockingService;
  readonly storeRuntimeService: StoreRuntimeService;
  readonly storeZhixuVersionService: StoreZhixuVersionService;
  readonly storeZhixuDraftWorkflowService: StoreZhixuDraftWorkflowService;
  readonly storeSupplierService: StoreSupplierService;
  readonly storeAuditStore: StoreAuditStore;
  readonly storeIdentityProvider: StoreIdentityProvider;
  readonly sessionService?: StoreSessionService;
  readonly decorationService?: StoreDecorationService;
  readonly listingService?: StoreListingService;
  readonly joinService?: StoreJoinService;
  readonly identityDescriptorSnapshots?: StoreIdentityDescriptorSnapshotStore;
  readonly governanceService: GovernanceService;
  readonly complianceService: ComplianceService;
  readonly riskGraphService: RiskGraphService;
  readonly notificationService: NotificationService;
  readonly supplierNotificationConfigService: SupplierNotificationProfileConfigService;
  readonly evidenceService: EvidenceService;
  readonly submissionService: ProductSubmissionService;
  readonly productStageExecutorPatchService: ProductStageExecutorPatchService;
  readonly productStageResourcePatchService: ProductStageResourcePatchService;
  readonly submissionStore?: ProductSubmissionStore;
  readonly opsRecoveryActions?: AdminOpsRecoveryActions;
  /** 见 CreateApiRouterOptions.opsConsoleAdminIds。 */
  readonly opsConsoleAdminIds?: readonly string[];
  readonly audit: AuditSink;
  readonly buildDiagnostics: () => Promise<Record<string, unknown>>;
  readonly onTxMined?: () => void;
  readonly now: () => Date;
}

export function cleanQuery<TQuery extends Readonly<Record<string, string | undefined>>>(query: TQuery): Record<string, string> {
  return Object.fromEntries(
    Object.entries(query).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0)
  );
}

export function readApiHeader(headers: ApiRequest["headers"], name: string): string | undefined {
  if (!headers) {
    return undefined;
  }
  return headers[name] ?? headers[name.toLowerCase()] ?? Object.entries(headers)
    .find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}
