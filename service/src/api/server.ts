import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { loadConfigFromEnv, runConfigPreflight, type ChainServicesConfig } from "../config/index.js";
import { selectActiveStateMachineDeployment } from "../config/preflight.js";
import {
  BackupEvidenceStorage,
  LocalEvidenceStorage,
  ObjectEvidenceStorage,
  RehearsalObjectEvidenceStorage,
  S3EvidenceStorageClient,
  type EvidenceStorage
} from "../evidence/index.js";
import { createConfiguredGovernanceChainAdapter, createGovernanceService } from "../governance/index.js";
import { IndexerService, type ChainEventSource } from "../indexer/service.js";
import { createChainEventSourceForTarget } from "../chain-adapters/events.js";
import { createNotificationService, WebhookNotificationDispatcher } from "../notifications/index.js";
import {
  AnvilProductOrderTriggerBroadcastAdapter,
  MemoryProductOrderTriggerBroadcastAdapter,
  type ProductOrderTriggerBroadcastAdapter
} from "../product/bff/trigger.js";
import { createViemReconcileReceiptClient, TxReconcileWorker } from "../reconcile/index.js";
import { DockAutomationWorker } from "../dock-automation/index.js";
import { createChainServicesStores } from "../storage/factory.js";
import type { ProjectionStore } from "../storage/projection-store.js";
import {
  createSecureSubmissionBroadcastAdapter,
  createStateMachineSubmissionBroadcastAdapter,
  type SubmissionBroadcastAdapter
} from "../submissions/index.js";
import {
  createStateMachineStageExecutorPatchBroadcastAdapter,
  createStateMachineStageResourcePatchBroadcastAdapter,
  type StageExecutorPatchBroadcastAdapter,
  type StageResourcePatchBroadcastAdapter
} from "../stage-patches/index.js";
import { createLoggerAuditSink, type AuditSink } from "../security/audit.js";
import { createRedactingLogger, redactErrorMessage, redactSecrets } from "../security/redaction.js";
import { isDirectRun } from "../shared/runtime.js";
import { ConfigError, consoleLogger, type Address, type Logger } from "../shared/types.js";
import { createApiRouter } from "./routes.js";
import { createListingAnchorChainView } from "../store-listings/index.js";

export interface StartApiServerOptions {
  readonly config?: ChainServicesConfig;
  readonly store?: ProjectionStore;
  readonly eventSource?: ChainEventSource | false;
  readonly logger?: Logger;
}

export async function startApiServer(
  configOrOptions: ChainServicesConfig | StartApiServerOptions = {},
  storeOverride?: ProjectionStore,
  eventSourceOverride?: ChainEventSource | false
): Promise<Server> {
  const options = normalizeStartOptions(configOrOptions, storeOverride, eventSourceOverride);
  const config = options.config ?? loadConfigFromEnv();
  const stores = createChainServicesStores({
    database: config.database,
    chainId: config.network.chainId
  });
  const store = options.store ?? stores.projectionStore;
  const logger = createRedactingLogger(options.logger ?? consoleLogger, config.security.logRedactionEnabled);
  const audit = createLoggerAuditSink(logger);
  const configDiagnostics = await runConfigPreflight(config);
  const eventSource = options.eventSource === undefined
    ? createChainEventSourceForTarget(config, { logger })
    : options.eventSource;
  const productBffStore = stores.productBffStore;
  const submissionStore = stores.submissionStore;
  const governanceStore = stores.governanceStore;
  const productSchemaResolver = {
    getProductSchemaByPlan: (planId: string, planHash: string, artifactHash?: string) =>
      stores.storeZhixuDraftStore.findProductSchemaByPlan(planId, planHash, artifactHash)
  };
  // 通用 webhook transport。产品渠道决策仍未做，默认关闭——
  // 只在显式配置 UVP_NOTIFY_WEBHOOK_URL 时装配 dispatcher；未配置时保持
  // 现状（delivery 记为 transport_adapter_missing），并给出一次性启动警告。
  const notificationDispatcher = config.notifications?.webhookUrl
    ? new WebhookNotificationDispatcher({
      url: config.notifications.webhookUrl,
      ...(config.notifications.webhookSecretConfigured && process.env.UVP_NOTIFY_WEBHOOK_SECRET?.trim()
        ? { secret: process.env.UVP_NOTIFY_WEBHOOK_SECRET.trim() }
        : {})
    })
    : undefined;
  if (!notificationDispatcher) {
    logger.warn("NOTIFICATION DELIVERY IS NOT CONFIGURED: set UVP_NOTIFY_WEBHOOK_URL to enable the generic webhook transport; until then every delivery is recorded as failed (transport_adapter_missing) and no external channel is notified");
  }
  const notificationService = createNotificationService({
    store,
    supplierMetadataStore: stores.storeSupplierMetadataStore,
    productSchemaResolver,
    // delivery / read 状态落 sqlite（memory 驱动保持内存语义）。
    ...(stores.notificationStateStore
      ? {
        deliveryStore: stores.notificationStateStore,
        participantReadStateStore: stores.notificationStateStore
      }
      : {}),
    ...(notificationDispatcher ? { dispatcher: notificationDispatcher } : {})
  });
  // open/input/output 的 dock 活性自动化（keeper 只提供活性）
  // 由 DockAutomationWorker 按显式 route source 承担。
  const indexer = eventSource
    ? new IndexerService({
      config,
      eventSource,
      store,
      notificationProcessor: notificationService,
      logger
    })
    : undefined;

  if (indexer) {
    await indexer.rebuildFromDeploymentBlock();
  }

  const submissionVerifyingContract = stateMachineAddress(config.network.contracts);
  // stage-patch / docking 模块地址必须显式存在于配置或
  // 地址清单；缺失时不回退到状态机地址（strict preflight 亦会对清单
  // 缺项 fail-fast），未配置即不装配对应 patch/docking 服务地址。
  const stagePatchVerifyingContract = stagePatchModuleAddress(config);
  const submissionBroadcastAdapter = createConfiguredSubmissionBroadcastAdapter(
    config,
    submissionVerifyingContract,
    audit,
    // sqlite 驱动下 broadcast 去重状态持久化，重启后仍可去重。
    stores.broadcastDedupeStore
  );
  if (!submissionBroadcastAdapter && (config.security.environment !== "local" || config.relayer.broadcastEnabled)) {
    throw new ConfigError(
      `state-machine signal broadcast is not configured: UVP_STATE_MACHINE_RELAYER_BROADCAST_ENABLED=true and a non-empty ${config.relayer.stateMachinePrivateKeyEnv} are required when the runtime is not local or broadcast was explicitly enabled`,
    );
  }
  const stageExecutorPatchBroadcastAdapter = createConfiguredStageExecutorPatchBroadcastAdapter(config, stagePatchVerifyingContract);
  const stageResourcePatchBroadcastAdapter = createConfiguredStageResourcePatchBroadcastAdapter(config, stagePatchVerifyingContract);
  const productRegistrationAdapter = productRegistrationAdapterFromConfig(config);
  const evidenceStorage = createConfiguredEvidenceStorage(config);
  const governanceService = createGovernanceService({
    store: governanceStore,
    adapter: createConfiguredGovernanceChainAdapter(config),
    audit,
    // descriptor 托管：注册时快照被哈希原文，descriptorURI 指向公开端点。
    descriptorSnapshotStore: stores.identityDescriptorSnapshots,
    ...(config.api.identityDescriptorPublicBaseUrl
      ? { descriptorPublicBaseUrl: config.api.identityDescriptorPublicBaseUrl }
      : {})
  });
  const reconcileWorker = new TxReconcileWorker({
    config: config.reconcile,
    receiptClient: createViemReconcileReceiptClient({
      rpcUrl: config.network.rpcUrl,
      chainId: config.network.chainId
    }),
    projectionStore: store,
    productStore: productBffStore,
    submissionStore,
    governanceStore,
    logger
  });
  // dock liveness worker。routeSource/submitter 未装配时为
  // 显式 no-op（候选扫描归零），装配点由云编译 route 数据库接入方提供。
  const dockingModuleAddressValue = moduleAddress(config, "docking", "UVPDockingModule");
  const dockAutomationWorker = new DockAutomationWorker({
    config: config.dockAutomation,
    projectionStore: store,
    dockingAddress: dockingModuleAddressValue ?? "0x0000000000000000000000000000000000000000",
    chainId: config.network.chainId,
    logger
  });
  // admin recovery actions 从既有 worker/indexer 原语构造，路由
  // 拿不到 ops_dependency_unavailable 的假边界。retrySubmission 复用
  // reconcile 原语（按 receipt 重新推进提交状态）并回报该提交的当前状态。
  const opsRecoveryActions = {
    ...(indexer
      ? {
        rebuildProjections: async () => {
          const { summary } = await indexer.rebuildFromDeploymentBlockWithSummary();
          return {
            status: "completed" as const,
            summary: {
              eventCount: summary.eventCount,
              activeEventCount: summary.activeEventCount,
              mismatchCount: summary.mismatchCount,
              finalizedBlock: summary.finalizedBlock,
              syncStatus: summary.syncStatus
            }
          };
        },
        // post-commit 失败批次（游标已前进）的人工补投入口。
        sweepPendingPostCommitSteps: async () => {
          const summary = await indexer.sweepPendingPostCommitSteps();
          return { status: "completed" as const, summary };
        },
        listPendingPostCommitSteps: async () => indexer.listPendingPostCommitSteps()
      }
      : {}),
    runReconcile: async () => {
      const summary = await reconcileWorker.runOnce();
      return { status: "completed" as const, summary };
    },
    ...(stores.submissionStore
      ? {
        retrySubmission: async (input: { readonly submissionId: string }) => {
          const reconcileSummary = await reconcileWorker.runOnce();
          const submission = await stores.submissionStore!.getSubmission(input.submissionId);
          return {
            status: "completed" as const,
            summary: {
              reconcile: reconcileSummary,
              submissionId: input.submissionId,
              ...(submission
                ? { status: submission.status, retryState: submission.retryState }
                : { found: false })
            }
          };
        }
      }
      : {})
  };
  const opsConsoleAdminIds = config.operatorRoles.opsConsoleAdmins ?? [];
  const router = createApiRouter(store, {
    productBffStore,
    evidenceMetadataStore: stores.evidenceMetadataStore,
    evidenceStorage,
    submissionStore,
    governanceStore,
    governanceService,
    productSchemaResolver,
    // ops 控制台白名单进入鉴权；未配置时回退 governance admin 检查。
    ...(opsConsoleAdminIds.length > 0 ? { opsConsoleAdminIds } : {}),
    opsRecoveryActions,
    storeZhixuDraftStore: stores.storeZhixuDraftStore,
    storeZhixuVersionMetadataStore: stores.storeZhixuVersionMetadataStore,
    storeSupplierMetadataStore: stores.storeSupplierMetadataStore,
    storeDockingSessionStore: stores.storeDockingSessionStore,
    storeAuditStore: stores.storeAuditStore,
    storeWalletSessionStore: stores.storeWalletSessionStore,
    identityDescriptorSnapshots: stores.identityDescriptorSnapshots,
    storeDecorationStore: stores.storeDecorationStore,
    storePublisherDelegationStore: stores.storePublisherDelegationStore,
    storeListingStore: stores.storeListingStore,
    storeJoinApplicationStore: stores.storeJoinApplicationStore,
    ...(config.api.identityDescriptorPublicBaseUrl
      ? { descriptorPublicBaseUrl: config.api.identityDescriptorPublicBaseUrl }
      : {}),
    // 锚核验链直读：RPC + 状态机地址齐备时提供第二证据源。
    ...(config.network.rpcUrl && submissionVerifyingContract
      ? {
        listingAnchorChainView: createListingAnchorChainView({
          rpcUrl: config.network.rpcUrl,
          stateMachineAddress: submissionVerifyingContract
        })
      }
      : {}),
    notificationService,
    submissionChainId: config.network.chainId,
    ...(submissionVerifyingContract ? { submissionVerifyingContract } : {}),
    ...(stagePatchVerifyingContract ? { stageExecutorPatchVerifyingContract: stagePatchVerifyingContract } : {}),
    ...(stagePatchVerifyingContract ? { stageResourcePatchVerifyingContract: stagePatchVerifyingContract } : {}),
    ...(submissionBroadcastAdapter ? { submissionBroadcastAdapter } : {}),
    ...(stageExecutorPatchBroadcastAdapter ? { stageExecutorPatchBroadcastAdapter } : {}),
    ...(stageResourcePatchBroadcastAdapter ? { stageResourcePatchBroadcastAdapter } : {}),
    productRegistrationAdapter,
    productTriggerChainId: config.network.chainId,
    ...(config.productBff.registrationCreatorAddress
      ? { productRegistrationCreatorAddress: config.productBff.registrationCreatorAddress }
      : {}),
    productRuntimeEnvironment: config.security.environment,
    ...(config.storeAuth ? { storeAuthConfig: config.storeAuth } : {}),
    evidenceRuntimeEnvironment: config.security.environment,
    indexerDiagnostics: {
      configured: Boolean(eventSource),
      pollIntervalMs: config.api.indexerPollIntervalMs
    },
    reconcileDiagnostics: () => reconcileWorker.getDiagnostics(),
    audit,
    configDiagnostics,
    ...(indexer ? { onTxMined: () => indexer.refreshIfIdle() } : {})
  });
  const server = createServer((request, response) => {
    const requestId = requestIdFromHeaders(request);
    const runId = runIdFromHeaders(request);
    void (async () => {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      setCorsHeaders(response, request);
      response.setHeader("x-request-id", requestId);
      if (runId) {
        response.setHeader("x-uvp-run-id", runId);
      }

      if (request.method === "OPTIONS") {
        response.statusCode = 204;
        response.end();
        return;
      }

      const parsedBody = await readJsonBody(request).catch((error: unknown) => {
        response.statusCode = 400;
        response.setHeader("content-type", "application/json; charset=utf-8");
        const body = withErrorMetadata({
          error: "invalid_json_body",
          message: error instanceof Error ? redactErrorMessage(error) : "request body must be valid JSON"
        }, requestId, runId);
        logger.warn("api request rejected", {
          requestId,
          ...(runId ? { runId } : {}),
          method: request.method,
          pathname: url.pathname,
          status: 400,
          errorCode: "invalid_json_body"
        });
        response.end(JSON.stringify(body));
        return invalidBodySent;
      });
      if (parsedBody === invalidBodySent) {
        return;
      }

      const apiResponse = await router.handle({
        method: request.method ?? "GET",
        pathname: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: normalizeHeaders(request.headers),
        body: parsedBody
      });

      response.statusCode = apiResponse.status;
      response.setHeader("content-type", "application/json; charset=utf-8");
      const responseBody = apiResponse.status >= 400
        ? withErrorMetadata(apiResponse.body, requestId, runId)
        : apiResponse.body;
      const safeBody = redactSecrets(responseBody);
      logger.info("api request completed", {
        requestId,
        ...(runId ? { runId } : {}),
        method: request.method,
        pathname: url.pathname,
        status: apiResponse.status,
        ...extractResponseLogFields(safeBody)
      });
      response.end(JSON.stringify(safeBody, jsonReplacer));
    })().catch((error: unknown) => {
      response.statusCode = 500;
      setCorsHeaders(response);
      response.setHeader("x-request-id", requestId);
      if (runId) {
        response.setHeader("x-uvp-run-id", runId);
      }
      response.setHeader("content-type", "application/json; charset=utf-8");
      const body = withErrorMetadata({
        error: "internal_server_error",
        message: error instanceof Error ? redactErrorMessage(error) : "unknown error"
      }, requestId, runId);
      logger.error("api request failed", {
        requestId,
        ...(runId ? { runId } : {}),
        method: request.method,
        pathname: request.url ?? "/",
        status: 500,
        errorCode: "internal_server_error",
        message: error instanceof Error ? redactErrorMessage(error) : "unknown error"
      });
      response.end(
        JSON.stringify(body)
      );
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(config.api.port, config.api.host, resolve);
  });

  const pollInterval = indexer ? startProjectionRefresh(indexer, config, logger) : undefined;
  if (pollInterval) {
    server.on("close", () => clearInterval(pollInterval));
  }
  await reconcileWorker.start();
  await dockAutomationWorker.start();
  server.on("close", () => {
    void (async () => {
      await dockAutomationWorker.stop();
      await reconcileWorker.stop();
      await stores.close();
    })();
  });

  logger.info("api server listening", {
    host: config.api.host,
    port: config.api.port,
    indexerPollIntervalMs: config.api.indexerPollIntervalMs,
    reconcileWorkerEnabled: config.reconcile.enabled,
    reconcilePollIntervalMs: config.reconcile.pollIntervalMs
  });

  return server;
}

export function createConfiguredEvidenceStorage(config: ChainServicesConfig): EvidenceStorage {
  const evidenceStorageConfig = config.evidenceStorage;
  if (evidenceStorageConfig.adapter === "s3") {
    if (!evidenceStorageConfig.s3Bucket) {
      throw new ConfigError(
        "UVP_EVIDENCE_S3_BUCKET is required when UVP_EVIDENCE_STORAGE_ADAPTER=s3",
      );
    }
    if (!evidenceStorageConfig.s3Region) {
      throw new ConfigError(
        "UVP_EVIDENCE_S3_REGION is required when UVP_EVIDENCE_STORAGE_ADAPTER=s3",
      );
    }
    if (!evidenceStorageConfig.s3AccessKeyIdEnv) {
      throw new ConfigError(
        "UVP_EVIDENCE_S3_ACCESS_KEY_ID_ENV is required when UVP_EVIDENCE_STORAGE_ADAPTER=s3",
      );
    }
    if (!evidenceStorageConfig.s3SecretAccessKeyEnv) {
      throw new ConfigError(
        "UVP_EVIDENCE_S3_SECRET_ACCESS_KEY_ENV is required when UVP_EVIDENCE_STORAGE_ADAPTER=s3",
      );
    }
    const primary = new ObjectEvidenceStorage({
      client: new S3EvidenceStorageClient({
        bucket: evidenceStorageConfig.s3Bucket,
        ...(evidenceStorageConfig.s3Prefix ? { prefix: evidenceStorageConfig.s3Prefix } : {}),
        region: evidenceStorageConfig.s3Region,
        ...(evidenceStorageConfig.s3Endpoint ? { endpoint: evidenceStorageConfig.s3Endpoint } : {}),
        forcePathStyle: evidenceStorageConfig.s3ForcePathStyle ?? false,
        accessKeyIdEnv: evidenceStorageConfig.s3AccessKeyIdEnv,
        secretAccessKeyEnv: evidenceStorageConfig.s3SecretAccessKeyEnv,
        // forward the optional STS session-token env so temporary
        // credentials actually reach the S3 client instead of dying at the
        // first upload/read with a 403 that preflight never saw.
        ...(evidenceStorageConfig.s3SessionTokenEnv
          ? { sessionTokenEnv: evidenceStorageConfig.s3SessionTokenEnv }
          : {}),
        ...(evidenceStorageConfig.s3UriMode === "object"
          ? {
              uriMode: evidenceStorageConfig.s3UriMode,
              ...(evidenceStorageConfig.s3ObjectNamespace ? { objectNamespace: evidenceStorageConfig.s3ObjectNamespace } : {})
            }
          : {})
      })
    });
    // 配置了第二副本 bucket 时，put 同步写第二副本并提供
    // 按 hash 校验/恢复能力；未配置时保持单副本（preflight 警告）。
    if (evidenceStorageConfig.s3BackupBucket) {
      const backup = new ObjectEvidenceStorage({
        client: new S3EvidenceStorageClient({
          bucket: evidenceStorageConfig.s3BackupBucket,
          region: evidenceStorageConfig.s3Region,
          ...(evidenceStorageConfig.s3Endpoint ? { endpoint: evidenceStorageConfig.s3Endpoint } : {}),
          forcePathStyle: evidenceStorageConfig.s3ForcePathStyle ?? false,
          accessKeyIdEnv: evidenceStorageConfig.s3AccessKeyIdEnv,
          secretAccessKeyEnv: evidenceStorageConfig.s3SecretAccessKeyEnv,
          ...(evidenceStorageConfig.s3SessionTokenEnv
            ? { sessionTokenEnv: evidenceStorageConfig.s3SessionTokenEnv }
            : {}),
          // 备份客户端必须沿用主存储的 uriMode/
          // objectNamespace——object:// URI 空间下两边不一致会让 verify/
          // restore 的 URI 翻译失效。
          ...(evidenceStorageConfig.s3UriMode === "object"
            ? {
                uriMode: evidenceStorageConfig.s3UriMode,
                ...(evidenceStorageConfig.s3ObjectNamespace ? { objectNamespace: evidenceStorageConfig.s3ObjectNamespace } : {})
              }
            : {})
        })
      });
      return new BackupEvidenceStorage({ primary, backup });
    }
    return primary;
  }
  if (evidenceStorageConfig.adapter === "rehearsal-object") {
    return new RehearsalObjectEvidenceStorage({
      ...(evidenceStorageConfig.objectRootDir ? { rootDir: evidenceStorageConfig.objectRootDir } : {}),
      namespace: evidenceStorageConfig.objectNamespace
    });
  }
  return new LocalEvidenceStorage({
    ...(evidenceStorageConfig.localDir ? { rootDir: evidenceStorageConfig.localDir } : {})
  });
}

function startProjectionRefresh(indexer: IndexerService, config: ChainServicesConfig, logger: Logger): NodeJS.Timeout | undefined {
  const pollIntervalMs = config.api.indexerPollIntervalMs;
  if (pollIntervalMs <= 0) {
    // poll=0 意味着外部参与方事件永不入投影、reconcile 永卡，只能
    // 人工 rebuild——必须响亮提示，不允许静默。
    logger.warn(
      "INDEXER POLLING IS DISABLED (UVP_INDEXER_POLL_INTERVAL_MS=0): chain events from external participants will never enter the projection, reconcile will stall at indexing, and recovery requires a manual projection rebuild"
    );
    return undefined;
  }

  return setInterval(() => {
    indexer.refreshIfIdle();
  }, pollIntervalMs);
}

function normalizeStartOptions(
  configOrOptions: ChainServicesConfig | StartApiServerOptions,
  storeOverride?: ProjectionStore,
  eventSourceOverride?: ChainEventSource | false
): StartApiServerOptions {
  if ("network" in configOrOptions) {
    return {
      config: configOrOptions,
      ...(storeOverride ? { store: storeOverride } : {}),
      ...(eventSourceOverride !== undefined ? { eventSource: eventSourceOverride } : {})
    };
  }
  return configOrOptions;
}

// 跨源默认关闭（不回 allow-origin，浏览器跨源读写被拦）；
// 显式配置 UVP_API_CORS_ALLOWED_ORIGINS（逗号分隔）后按 Origin 精确回显。
// 通配 "*" + 放行 x-uvp-* 身份头会让任意网页伪造管理员调用，禁止使用。
const CORS_ALLOWED_ORIGINS = new Set(
  (process.env.UVP_API_CORS_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
);

function setCorsHeaders(response: ServerResponse, request?: IncomingMessage): void {
  response.setHeader("access-control-allow-methods", "GET, POST, PATCH, DELETE, OPTIONS");
  response.setHeader(
    "access-control-allow-headers",
    "content-type, x-request-id, x-uvp-request-id, x-uvp-run-id, x-uvp-principal-id, x-uvp-principal-role, x-uvp-admin-id, x-uvp-admin-role, x-uvp-store-operator-id, x-uvp-store-operator-role, x-uvp-store-user-id, x-uvp-store-role, x-uvp-store-session, x-uvp-store-dev-anchored-address"
  );
  response.setHeader("access-control-max-age", "86400");
  const origin = request?.headers.origin?.trim() ?? "";
  if (origin !== "" && CORS_ALLOWED_ORIGINS.has(origin)) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("vary", "Origin");
  }
}

function stateMachineAddress(contracts: Readonly<Record<string, Address>>): Address | undefined {
  return contracts.UVPStateMachine;
}

function stagePatchModuleAddress(config: ChainServicesConfig): Address | undefined {
  return moduleAddress(config, "stagePatch", "UVPStagePatchModule");
}

function dockingModuleAddress(config: ChainServicesConfig): Address | undefined {
  return moduleAddress(config, "docking", "UVPDockingModule");
}

function moduleAddress(
  config: ChainServicesConfig,
  key: "stagePatch" | "derivedSignal" | "docking" | "planMetadata" | "orderLink" | "lens",
  contractName: string
): Address | undefined {
  const configuredAddress = config.network.contracts[contractName];
  if (configuredAddress) {
    return configuredAddress;
  }
  // D16：与 preflight 共用同一选择口径（精确 activeDeploymentId 优先，
  // 其次 status=active）——OR 谓词首中曾在两处口径漂移时取错部署。
  const activeDeployment = selectActiveStateMachineDeployment(config);
  return activeDeployment?.modules?.[key];
}

function productRegistrationAdapterFromConfig(config: ChainServicesConfig): ProductOrderTriggerBroadcastAdapter {
  if (config.productBff.registrationAdapter === "memory-trigger") {
    return new MemoryProductOrderTriggerBroadcastAdapter();
  }

  const stateMachine = stateMachineAddress(config.network.contracts);
  if (!stateMachine) {
    throw new ConfigError("UVPStateMachine contract address is required when Product BFF registration adapter is anvil");
  }
  const privateKey = process.env[config.productBff.registrarPrivateKeyEnv];
  if (!privateKey?.trim()) {
    throw new ConfigError(`${config.productBff.registrarPrivateKeyEnv} is required when Product BFF registration adapter is anvil`);
  }
  return new AnvilProductOrderTriggerBroadcastAdapter({
    stateMachineAddress: stateMachine,
    rpcUrl: config.network.rpcUrl,
    chainId: config.network.chainId,
    privateKey,
    waitForReceipt: config.productBff.waitForReceipt
  });
}

function createConfiguredSubmissionBroadcastAdapter(
  config: ChainServicesConfig,
  stateMachine: Address | undefined,
  audit: AuditSink,
  dedupeStore?: import("../submissions/index.js").BroadcastDedupeStore
): SubmissionBroadcastAdapter | undefined {
  if (!config.relayer.broadcastEnabled) {
    return undefined;
  }
  if (!stateMachine) {
    return undefined;
  }
  const privateKeyEnv = config.relayer.stateMachinePrivateKeyEnv;
  if (!process.env[privateKeyEnv]?.trim()) {
    return undefined;
  }
  return createSecureSubmissionBroadcastAdapter({
    adapter: createStateMachineSubmissionBroadcastAdapter({
      stateMachineAddress: stateMachine,
      chainId: config.network.chainId,
      rpcUrl: config.network.rpcUrl,
      relayerPrivateKeyEnv: privateKeyEnv,
      waitForReceipt: true,
      rejectGasPayerAsSubmitter: config.security.environment !== "local",
      receiptTimeoutMs: config.security.broadcastReceiptTimeoutMs
    }),
    maxInFlightPerOrder: config.security.broadcastMaxInFlightPerOrder,
    maxRetryAttempts: config.security.broadcastMaxRetry,
    retryBaseMs: config.security.broadcastRetryBaseMs,
    retryMaxMs: config.security.broadcastRetryMaxMs,
    ...(dedupeStore ? { dedupeStore } : {}),
    audit
  });
}

function createConfiguredStageExecutorPatchBroadcastAdapter(
  config: ChainServicesConfig,
  stateMachine: Address | undefined
): StageExecutorPatchBroadcastAdapter | undefined {
  if (!config.relayer.broadcastEnabled) {
    return undefined;
  }
  if (!stateMachine) {
    return undefined;
  }
  const privateKeyEnv = config.relayer.stateMachinePrivateKeyEnv;
  if (!process.env[privateKeyEnv]?.trim()) {
    return undefined;
  }
  return createStateMachineStageExecutorPatchBroadcastAdapter({
    stateMachineAddress: stateMachine,
    chainId: config.network.chainId,
    rpcUrl: config.network.rpcUrl,
    relayerPrivateKeyEnv: privateKeyEnv,
    waitForReceipt: true,
    rejectGasPayerAsSelector: config.security.environment !== "local",
    receiptTimeoutMs: config.security.broadcastReceiptTimeoutMs
  });
}

function createConfiguredStageResourcePatchBroadcastAdapter(
  config: ChainServicesConfig,
  stateMachine: Address | undefined
): StageResourcePatchBroadcastAdapter | undefined {
  if (!config.relayer.broadcastEnabled) {
    return undefined;
  }
  if (!stateMachine) {
    return undefined;
  }
  const privateKeyEnv = config.relayer.stateMachinePrivateKeyEnv;
  if (!process.env[privateKeyEnv]?.trim()) {
    return undefined;
  }
  return createStateMachineStageResourcePatchBroadcastAdapter({
    stateMachineAddress: stateMachine,
    chainId: config.network.chainId,
    rpcUrl: config.network.rpcUrl,
    relayerPrivateKeyEnv: privateKeyEnv,
    waitForReceipt: true,
    rejectGasPayerAsSelector: config.security.environment !== "local",
    receiptTimeoutMs: config.security.broadcastReceiptTimeoutMs
  });
}

function normalizeHeaders(headers: IncomingMessage["headers"]): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key.toLowerCase(),
      Array.isArray(value) ? value.join(",") : value
    ])
  );
}

function requestIdFromHeaders(request: IncomingMessage): string {
  const header = request.headers["x-request-id"] ?? request.headers["x-uvp-request-id"];
  const value = Array.isArray(header) ? header[0] : header;
  return value && value.trim().length > 0 ? value.trim() : randomUUID();
}

function runIdFromHeaders(request: IncomingMessage): string | undefined {
  const header = request.headers["x-uvp-run-id"] ?? request.headers["x-run-id"];
  const value = Array.isArray(header) ? header[0] : header;
  const runId = value && value.trim().length > 0 ? value.trim() : process.env.UVP_RUN_ID?.trim();
  return runId && runId.length > 0 ? runId : undefined;
}

function withErrorMetadata(body: unknown, requestId: string, runId: string | undefined): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {
      error: "request_failed",
      message: redactErrorMessage(body),
      requestId,
      ...(runId ? { runId } : {})
    };
  }
  return {
    ...(body as Record<string, unknown>),
    requestId,
    ...(runId ? { runId } : {})
  };
}

function extractResponseLogFields(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object") {
    return {};
  }
  const record = body as Record<string, unknown>;
  const fields: Record<string, unknown> = {};
  for (const key of ["error", "errorCode", "txHash", "orderId", "submissionId", "requestId", "runId"]) {
    const value = findFirstString(record, key);
    if (value) {
      fields[key === "error" ? "errorCode" : key] = value;
    }
  }
  return fields;
}

function findFirstString(value: unknown, key: string, seen: WeakSet<object> = new WeakSet()): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  if (seen.has(value)) {
    return undefined;
  }
  seen.add(value);
  if (!Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (typeof record[key] === "string") {
      return record[key];
    }
  }
  const entries = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  for (const entry of entries) {
    const found = findFirstString(entry, key, seen);
    if (found) {
      return found;
    }
  }
  return undefined;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown | undefined> {
  const method = request.method ?? "GET";
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return undefined;
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > 16_000_000) {
      throw new Error("request body exceeds 16MB limit");
    }
    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw.length === 0) {
    return undefined;
  }
  return JSON.parse(raw) as unknown;
}

const invalidBodySent = Symbol("invalidBodySent");

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

if (isDirectRun(import.meta.url)) {
  void startApiServer();
}
