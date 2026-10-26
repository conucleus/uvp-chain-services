import type {
  ChainServicesRuntimeEnv,
  ConfigDiagnostics,
  StoreAuthConfig,
} from "../config/index.js";
import type {
  EvidenceMetadataStore,
  EvidenceService,
  EvidenceStorage
} from "../evidence/index.js";
import type { GovernanceAdminAuthPolicy, GovernanceService, GovernanceStore } from "../governance/index.js";
import type { ProductBffService } from "../product/query/bff/service.js";
import type { ProductBffStore } from "../product/query/bff/store.js";
import type { ProductSchemaResolver, ProductService } from "../product/application/service.js";
import type { ReconcileWorkerDiagnostics } from "../reconcile/index.js";
import type { AuditSink } from "../security/audit.js";
import type { Address } from "../shared/types.js";
import type { ChainClock } from "../shared/chain-clock.js";
import type { ProjectionStore } from "../storage/projection-store.js";
import type {
  ProductSubmissionDTO,
  ProductSubmissionService,
  ProductSubmissionStore,
  SubmissionBroadcastAdapter
} from "../submissions/index.js";
import type {
  ProductStageExecutorPatchService,
  ProductStageExecutorPatchStore,
  ProductStageResourcePatchService,
  ProductStageResourcePatchStore,
  StageExecutorPatchBroadcastAdapter,
  StageResourcePatchBroadcastAdapter
} from "../stage-patches/index.js";
import type {
  StoreIdentityProvider
} from "../store/console/access.js";
import type { StoreSessionService, StoreWalletSessionStore } from "../store/sessions/index.js";
import type { StoreIdentityDescriptorSnapshotStore } from "../governance/descriptors.js";
import type {
  OrderBirthPort,
  OrderTriggerPort,
  OrderService,
  OrderStore,
  PublishedPlanProvider,
} from "../order/index.js";
import type { IndexerRuntimeDiagnostics } from "./diagnostics.js";

export interface ApiRequest {
  readonly method: string;
  readonly pathname: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly headers?: Readonly<Record<string, string | undefined>>;
  readonly body?: unknown;
  readonly clientAddress?: string | undefined;
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
  readonly evidenceMetadataStore: EvidenceMetadataStore;
  readonly governanceService?: GovernanceService;
  readonly governanceStore: GovernanceStore;
  readonly submissionService?: ProductSubmissionService;
  readonly submissionStore: ProductSubmissionStore;
  readonly submissionChainId?: number;
  readonly submissionVerifyingContract?: Address;
  readonly submissionBroadcastAdapter?: SubmissionBroadcastAdapter;
  readonly productStageExecutorPatchService?: ProductStageExecutorPatchService;
  readonly stageExecutorPatchBroadcastAdapter?: StageExecutorPatchBroadcastAdapter;
  readonly stageExecutorPatchChainId?: number;
  readonly stageExecutorPatchVerifyingContract?: Address;
  readonly stageExecutorPatchStore: ProductStageExecutorPatchStore;
  readonly productStageResourcePatchService?: ProductStageResourcePatchService;
  readonly stageResourcePatchBroadcastAdapter?: StageResourcePatchBroadcastAdapter;
  readonly stageResourcePatchChainId?: number;
  readonly stageResourcePatchVerifyingContract?: Address;
  readonly stageResourcePatchStore: ProductStageResourcePatchStore;
  readonly productBffStore: ProductBffStore;
  readonly orderStore: OrderStore;
  readonly orderService?: OrderService;
  readonly orderChainId?: number;
  readonly orderStateMachineAddress?: Address;
  readonly orderConfigPublisherWallets?: readonly Address[];
  readonly orderOperatorWallets?: readonly Address[];
  readonly orderResourceResolver?: import("../visibility/types.js").ResourceResolverPort;
  readonly orderRuntimeIntervalMs?: number;
  readonly orderTimerPoker?: () => Promise<unknown>;
  readonly orderPublishedPlanProvider?: PublishedPlanProvider;
  readonly orderBirthPort?: OrderBirthPort;
  readonly orderTriggerPort?: OrderTriggerPort;
  readonly productTriggerChainId?: number;
  readonly productRuntimeEnvironment?: ChainServicesRuntimeEnv;
  readonly audit?: AuditSink;
  readonly configDiagnostics?: ConfigDiagnostics;
  readonly indexerDiagnostics?: IndexerRuntimeDiagnostics;
  readonly reconcileDiagnostics?: ReconcileWorkerDiagnostics | (() => ReconcileWorkerDiagnostics);
  readonly evidenceStorage?: EvidenceStorage;
  readonly evidenceRuntimeEnvironment?: ChainServicesRuntimeEnv;
  readonly productSchemaResolver?: ProductSchemaResolver;
  readonly storeIdentityProvider?: StoreIdentityProvider;
  readonly storeAuthConfig?: StoreAuthConfig;
  readonly storeWalletSessionStore: StoreWalletSessionStore;
  readonly storeSessionService?: StoreSessionService;
  readonly identityDescriptorSnapshots: StoreIdentityDescriptorSnapshotStore;
  readonly descriptorPublicBaseUrl?: string;
  readonly opsRecoveryActions?: AdminOpsRecoveryActions;
  readonly opsConsoleAdminIds?: readonly string[];
  readonly governanceAdminIds?: readonly string[];
  readonly governanceAdminTokenHashes?: readonly string[];
  readonly onTxMined?: () => void;
  readonly now?: () => Date;
  readonly productChainClock?: ChainClock;
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
  sweepPendingPostCommitSteps?(): Promise<AdminOpsActionEffect | void>;
  listPendingPostCommitSteps?(): Promise<unknown>;
}

export interface ApiRouteContext {
  readonly store: ProjectionStore;
  readonly productService: ProductService;
  readonly productBffService: ProductBffService;
  readonly orderService: OrderService;
  readonly storeIdentityProvider: StoreIdentityProvider;
  readonly sessionService?: StoreSessionService;
  readonly identityDescriptorSnapshots: StoreIdentityDescriptorSnapshotStore;
  readonly governanceService: GovernanceService;
  readonly evidenceService: EvidenceService;
  readonly submissionService: ProductSubmissionService;
  readonly productStageExecutorPatchService: ProductStageExecutorPatchService;
  readonly productStageResourcePatchService: ProductStageResourcePatchService;
  readonly submissionStore?: ProductSubmissionStore;
  readonly opsRecoveryActions?: AdminOpsRecoveryActions;
  readonly opsConsoleAdminIds?: readonly string[];
  readonly governanceAdminPolicy: GovernanceAdminAuthPolicy;
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

export class InvalidPathParameterError extends Error {
  override readonly name = "InvalidPathParameterError";
  readonly status = 400;

  constructor(readonly rawValue: string) {
    super("path parameter is not a valid percent-encoded value");
  }
}

export function decodePathParameter(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch (error) {
    if (error instanceof URIError) {
      throw new InvalidPathParameterError(value);
    }
    throw error;
  }
}

export function invalidPathParameterResponse(): ApiResponse {
  return {
    status: 400,
    body: { error: "invalid_path_parameter", message: "path parameter is not a valid percent-encoded value" }
  };
}

export function readApiHeader(headers: ApiRequest["headers"], name: string): string | undefined {
  if (!headers) {
    return undefined;
  }
  return headers[name] ?? headers[name.toLowerCase()] ?? Object.entries(headers)
    .find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

export function normalizeRequestId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || !/^[A-Za-z0-9._:-]{1,128}$/.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}
