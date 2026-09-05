import { redactSecrets } from "../security/redaction.js";
import { compareChainPointers } from "../shared/types.js";
import type { ProjectionStore } from "../storage/projection-store.js";
import type {
  ProductChainProofDTO,
  ProductOrderApiDTO,
  ProductService,
  ProductTaskApiDTO
} from "./service.js";

type JsonRecord = Record<string, unknown>;

export type ProductApiStagingReadinessStatus = "ready" | "not_ready";

export interface ProductApiStagingReadiness {
  readonly generatedAt: string;
  readonly sourceOfTruth: "contracts-and-chain-events";
  readonly backendAuthority: false;
  readonly ready: boolean;
  readonly status: ProductApiStagingReadinessStatus;
  readonly reasons: readonly string[];
  readonly profile: JsonRecord;
  readonly deployment: JsonRecord;
  readonly indexer: JsonRecord;
  readonly planPublication: JsonRecord;
  readonly productState: JsonRecord;
  readonly proof: JsonRecord;
  readonly evidenceStorage: JsonRecord;
  readonly roleInputs: JsonRecord;
}

export interface BuildProductApiStagingReadinessOptions {
  readonly productService: ProductService;
  readonly store: ProjectionStore;
  readonly diagnostics: JsonRecord;
  readonly now: () => Date;
}

export async function buildProductApiStagingReadiness(
  options: BuildProductApiStagingReadinessOptions
): Promise<ProductApiStagingReadiness> {
  const [
    zhixus,
    orders,
    tasks,
    activeDeployment,
    orderSnapshot
  ] = await Promise.all([
    options.productService.listZhixu(),
    options.productService.listOrders(),
    options.productService.listTasks(),
    options.productService.getActiveStateMachineDeployment(),
    options.store.getOrderSnapshot?.() ?? Promise.resolve(undefined)
  ]);
  const diagnostics = options.diagnostics;
  const profile = profileSummary(diagnostics);
  const deployment = deploymentSummary(diagnostics, activeDeployment, orderSnapshot);
  const indexer = indexerSummary(diagnostics);
  const planPublication = planPublicationSummary(
    orders,
    Object.values(orderSnapshot?.stateMachinePlans ?? {}),
  );
  const productState = productStateSummary(zhixus.length, orders, tasks);
  const proof = proofSummary(orders, tasks);
  const evidenceStorage = evidenceStorageSummary(diagnostics);
  const roleInputs = roleInputSummary(diagnostics);

  const reasons = readinessReasons({
    profile,
    deployment,
    indexer,
    planPublication,
    productState,
    proof,
    evidenceStorage,
    roleInputs
  });
  const ready = reasons.length === 0;

  return redactSecrets({
    generatedAt: options.now().toISOString(),
    sourceOfTruth: "contracts-and-chain-events",
    backendAuthority: false,
    ready,
    status: ready ? "ready" : "not_ready",
    reasons,
    profile,
    deployment,
    indexer,
    planPublication,
    productState,
    proof,
    evidenceStorage,
    roleInputs
  });
}

function readinessReasons(input: {
  readonly profile: JsonRecord;
  readonly deployment: JsonRecord;
  readonly indexer: JsonRecord;
  readonly planPublication: JsonRecord;
  readonly productState: JsonRecord;
  readonly proof: JsonRecord;
  readonly evidenceStorage: JsonRecord;
  readonly roleInputs: JsonRecord;
}): readonly string[] {
  const reasons: string[] = [];
  if (input.profile.environment !== "staging") {
    reasons.push("not_staging_profile");
  }
  if (input.profile.preflightStrict !== true || input.profile.preflightStatus !== "passed") {
    reasons.push("staging_preflight_not_passed");
  }
  if (input.profile.e2eControls === true) {
    reasons.push("product_e2e_fixtures_enabled");
  }
  if (input.profile.permissiveAuthorizationRequested === true) {
    reasons.push("permissive_product_authorization_requested");
  }
  if (input.profile.storageDriver !== "postgres" || input.profile.storageDurable !== true) {
    reasons.push("staging_storage_not_postgres");
  }
  if (input.profile.storeAuthMode !== "jwt" || input.profile.storeAuthJwtConfigured !== true) {
    reasons.push("store_auth_jwt_missing");
  } else if (input.profile.storeAuthExternalIdentityEvidence !== true) {
    reasons.push("store_auth_external_oidc_missing");
  }
  if (input.evidenceStorage.readiness !== "ready" || input.evidenceStorage.adapterKind !== "object") {
    reasons.push("evidence_storage_not_ready");
  }
  if (input.roleInputs.ready !== true) {
    reasons.push("operator_roles_incomplete");
  }
  if (input.deployment.ready !== true) {
    reasons.push("no_active_deployment");
  }
  if (input.indexer.ready !== true) {
    reasons.push("indexer_not_indexed");
  }
  if (input.indexer.rebuildReady !== true) {
    reasons.push("projection_rebuild_not_complete");
  }
  if (input.productState.orderCount === 0) {
    reasons.push("no_chain_projected_order");
  }
  if (input.productState.taskCount === 0) {
    reasons.push("no_chain_projected_task");
  }
  if (input.proof.orderProofEventCount === 0 || input.proof.taskProofRowCount === 0) {
    reasons.push("no_chain_proof");
  }
  return reasons;
}

function profileSummary(diagnostics: JsonRecord): JsonRecord {
  const product = recordOf(diagnostics.product);
  const preflight = recordOf(diagnostics.preflight);
  const storage = recordOf(diagnostics.storage);
  const storeAuth = recordOf(diagnostics.storeAuth);
  return {
    environment: stringOf(diagnostics.environment) ?? stringOf(recordOf(diagnostics.runtime)?.environment) ?? "unknown",
    preflightStrict: preflight?.strict === true,
    preflightStatus: stringOf(preflight?.status) ?? "unknown",
    e2eControls: product?.e2eControls === true || diagnostics.e2eControls === true,
    registrationAdapter: stringOf(product?.registrationAdapter) ?? "unknown",
    permissiveAuthorizationRequested: product?.permissiveAuthorizationRequested === true,
    storageDriver: stringOf(storage?.driver) ?? stringOf(diagnostics.storageDriver) ?? "unknown",
    storageDurable: storage?.durable === true,
    storeAuthMode: stringOf(storeAuth?.mode) ?? "unknown",
    storeAuthJwtConfigured: storeAuth?.jwtConfigured === true,
    storeAuthExternalIdentityEvidence: storeAuth?.externalIdentityEvidence === true,
    storeAuthEvidenceClassification: stringOf(storeAuth?.evidenceClassification) ?? "not_verified",
    storeAuthKeySource: stringOf(storeAuth?.keySource) ?? "missing",
    sourceOfTruth: "contracts-and-chain-events",
    backendAuthority: false
  };
}

function deploymentSummary(
  diagnostics: JsonRecord,
  activeDeployment: Awaited<ReturnType<ProductService["getActiveStateMachineDeployment"]>>,
  orderSnapshot: Awaited<ReturnType<NonNullable<ProjectionStore["getOrderSnapshot"]>>> | undefined
): JsonRecord {
  const network = recordOf(diagnostics.network);
  const activeDeploymentProjection = activeDeployment && orderSnapshot
    ? Object.values(orderSnapshot.stateMachineDeployments).find((deployment) =>
        deployment.deploymentId === activeDeployment.deploymentId
      )
    : undefined;
  return {
    ready: Boolean(activeDeployment),
    activeDeploymentId: activeDeployment?.deploymentId ?? null,
    stateMachineAddress: activeDeployment?.stateMachineAddress ?? null,
    projectionStatus: activeDeploymentProjection?.status ?? "missing",
    registryProjectionPresent: Boolean(activeDeploymentProjection),
    configuredStateMachine: network?.stateMachineConfigured === true,
    configuredIdentityRegistry: network?.identityRegistryConfigured === true,
    source: activeDeployment ? "registry_projection" : "missing"
  };
}

function indexerSummary(diagnostics: JsonRecord): JsonRecord {
  const indexer = recordOf(diagnostics.indexer);
  const rebuild = recordOf(diagnostics.projectionRebuild) ?? recordOf(indexer?.rebuild);
  const syncStatus = stringOf(indexer?.syncStatus) ?? "unknown";
  const rebuildStatus = stringOf(rebuild?.status) ?? "unknown";
  return {
    ready: syncStatus === "indexed",
    configured: indexer?.configured === true,
    syncStatus,
    latestIndexedBlock: stringOrNull(indexer?.latestIndexedBlock),
    finalizedBlock: stringOrNull(indexer?.finalizedBlock),
    lagBlocks: stringOrNull(indexer?.lagBlocks),
    eventCount: numberOf(indexer?.eventCount),
    lastEventName: stringOrNull(indexer?.lastEventName),
    rebuildStatus,
    // 簇 N 修正（审计三轮）：staging readiness 的 rebuild "unknown" 不再
    // 视为就绪——此前 unknown 与 completed/idle 同权重，重建状态未知的
    // 部署照样宣告 ready。
    rebuildReady: rebuildStatus === "completed" || rebuildStatus === "idle",
    rebuild: {
      status: rebuildStatus,
      deploymentBlock: stringOrNull(rebuild?.deploymentBlock),
      fromBlock: stringOrNull(rebuild?.fromBlock),
      toBlock: stringOrNull(rebuild?.toBlock),
      eventCount: numberOf(rebuild?.eventCount),
      activeEventCount: numberOf(rebuild?.activeEventCount),
      removedEventCount: numberOf(rebuild?.removedEventCount),
      removedLogsFiltered: rebuild?.removedLogsFiltered === true,
      projectionRebuilt: rebuild?.projectionRebuilt === true,
      mismatchCount: numberOf(rebuild?.mismatchCount)
    },
    deploymentBlock: stringOrNull(rebuild?.deploymentBlock),
    fromBlock: stringOrNull(rebuild?.fromBlock),
    toBlock: stringOrNull(rebuild?.toBlock),
    activeEventCount: numberOf(rebuild?.activeEventCount),
    removedEventCount: numberOf(rebuild?.removedEventCount),
    removedLogsFiltered: rebuild?.removedLogsFiltered === true,
    projectionRebuilt: rebuild?.projectionRebuilt === true,
    eventRowsReplayed: numberOf(rebuild?.activeEventCount),
    degradedReason: stringOrNull(indexer?.degradedReason)
  };
}

function planPublicationSummary(
  orders: readonly ProductOrderApiDTO[],
  plans: readonly {
    readonly planId: string;
    readonly planHash: string;
  }[],
): JsonRecord {
  const orderPlans = orders.map((order) => publishedPlanForOrder(order, plans));
  return {
    publishedPlanCount: plans.length,
    orderCount: orders.length,
    ordersWithPublishedPlanCount: orderPlans.filter(Boolean).length,
    ordersWithMissingPlanCount: orderPlans.filter((plan) => !plan).length,
  };
}

function productStateSummary(
  zhixuCount: number,
  orders: readonly ProductOrderApiDTO[],
  tasks: readonly ProductTaskApiDTO[]
): JsonRecord {
  return {
    zhixuCount,
    orderCount: orders.length,
    taskCount: tasks.length,
    openTaskCount: tasks.filter((task) => task.status === "open").length,
    blockedTaskCount: tasks.filter((task) => task.status === "blocked").length,
    submittedTaskCount: tasks.filter((task) => task.status === "submitted" || task.status === "done").length,
    submittableTaskCount: tasks.filter((task) => task.canSubmit === true).length,
    sampleOrders: orders.slice(0, 10).map((order) => ({
      orderId: order.orderId,
      planId: order.planId ?? null,
      planHash: order.planHash ?? null,
      status: order.status,
      chainStatus: order.chainStatus ?? null,
      stateMachineAddress: order.stateMachineAddress ?? null,
      deploymentId: order.deploymentId ?? null,
      proofEventCount: order.proof?.length ?? 0
    })),
    sampleTasks: tasks.slice(0, 20).map((task) => ({
      taskId: task.taskId,
      orderId: task.orderId,
      status: task.status,
      chainStatus: task.chainStatus ?? null,
      canSubmit: task.canSubmit === true,
      assigneeWallet: task.assigneeWallet ?? task.participantWallet ?? null,
      proofRowCount: task.proofRows?.length ?? 0,
      readyTxHash: task.readyTxHash ?? null,
      projection: task.projection ?? null
    }))
  };
}

function proofSummary(
  orders: readonly ProductOrderApiDTO[],
  tasks: readonly ProductTaskApiDTO[]
): JsonRecord {
  const orderProofEvents = orders.flatMap((order) => [...(order.proof ?? [])]);
  const taskProofRowCount = tasks.reduce((count, task) => count + (task.proofRows?.length ?? 0), 0);
  return {
    orderProofEventCount: orderProofEvents.length,
    taskProofRowCount,
    payloadHashEventCount: orderProofEvents.filter((proof) => Boolean(proof.payloadHash)).length,
    eventNames: uniqueSorted(orderProofEvents.map((proof) => proof.eventName)),
    latestProof: latestProof(orderProofEvents)
  };
}

function evidenceStorageSummary(diagnostics: JsonRecord): JsonRecord {
  const evidenceStorage = recordOf(diagnostics.evidenceStorage);
  return {
    adapterKind: stringOf(evidenceStorage?.adapterKind) ?? "unknown",
    readiness: stringOf(evidenceStorage?.readiness) ?? "unknown",
    productionSafe: evidenceStorage?.productionSafe === true
  };
}

function roleInputSummary(diagnostics: JsonRecord): JsonRecord {
  const relayer = recordOf(diagnostics.relayer);
  const governance = recordOf(diagnostics.governance);
  const operatorRoles = recordOf(diagnostics.operatorRoles);
  const deployer = recordOf(operatorRoles?.deployer);
  const stateMachineOwner = recordOf(operatorRoles?.stateMachineOwner);
  const planPublisher = recordOf(operatorRoles?.planPublisher);
  const orderRegistrar = recordOf(operatorRoles?.orderRegistrar);
  const relayerGasPayer = recordOf(operatorRoles?.relayerGasPayer);
  const participantWallet = recordOf(operatorRoles?.participantWallet);
  const governanceRegistryOwner = recordOf(operatorRoles?.governanceRegistryOwner);
  const governanceSigner = recordOf(operatorRoles?.governanceSigner);
  const governanceAdminReviewer = recordOf(operatorRoles?.governanceAdminReviewer);
  const opsConsoleAdmin = recordOf(operatorRoles?.opsConsoleAdmin);
  const governanceSimulated = governance?.broadcastEnabled !== true;
  const ready = relayer?.configured === true &&
    governance?.configured === true &&
    !governanceSimulated &&
    privateKeyRoleReady(deployer) &&
    addressRoleReady(stateMachineOwner) &&
    addressRoleReady(planPublisher) &&
    privateKeyRoleReady(orderRegistrar) &&
    privateKeyRoleReady(relayerGasPayer) &&
    numberOf(participantWallet?.configuredCount) > 0 &&
    addressRoleReady(governanceRegistryOwner) &&
    privateKeyRoleReady(governanceSigner) &&
    numberOf(governanceAdminReviewer?.configuredCount) > 0 &&
    numberOf(opsConsoleAdmin?.configuredCount) > 0;

  return {
    ready,
    relayerConfigured: relayer?.configured === true,
    governanceConfigured: governance?.configured === true,
    governanceSimulatedIdentityRegistration: governanceSimulated,
    deployerConfigured: privateKeyRoleReady(deployer),
    stateMachineOwnerConfigured: addressRoleReady(stateMachineOwner),
    planPublisherConfigured: addressRoleReady(planPublisher),
    orderRegistrarConfigured: privateKeyRoleReady(orderRegistrar),
    relayerGasPayerConfigured: privateKeyRoleReady(relayerGasPayer),
    participantWalletCount: numberOf(participantWallet?.configuredCount),
    governanceRegistryOwnerConfigured: addressRoleReady(governanceRegistryOwner),
    governanceSignerConfigured: privateKeyRoleReady(governanceSigner),
    governanceAdminReviewerCount: numberOf(governanceAdminReviewer?.configuredCount),
    opsConsoleAdminCount: numberOf(opsConsoleAdmin?.configuredCount)
  };
}

function publishedPlanForOrder(
  order: ProductOrderApiDTO,
  plans: readonly {
    readonly planId: string;
    readonly planHash: string;
  }[]
): { readonly planId: string; readonly planHash: string } | undefined {
  return plans.find((plan) =>
    equalHex(plan.planId, order.planId) && (!order.planHash || equalHex(plan.planHash, order.planHash))
  );
}

function latestProof(proofs: readonly ProductChainProofDTO[]): JsonRecord | null {
  const proof = [...proofs].sort((left, right) =>
    compareChainPointers(productProofPointer(right), productProofPointer(left))
  )[0];
  return proof
    ? {
        eventName: proof.eventName,
        blockNumber: proof.blockNumber,
        transactionHash: proof.transactionHash
      }
    : null;
}

function productProofPointer(proof: ProductChainProofDTO) {
  return {
    chainId: proof.chainId,
    blockNumber: BigInt(proof.blockNumber),
    ...(proof.transactionIndex !== undefined
      ? { transactionIndex: proof.transactionIndex }
      : {}),
    transactionHash: proof.transactionHash as `0x${string}`,
    logIndex: proof.logIndex
  };
}

function privateKeyRoleReady(value: JsonRecord | undefined): boolean {
  return value?.privateKeyConfigured === true && value.addressMatches !== false;
}

function addressRoleReady(value: JsonRecord | undefined): boolean {
  return value?.configured === true;
}

function recordOf(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function equalHex(left: string | undefined, right: string | undefined): boolean {
  return Boolean(left && right && left.toLowerCase() === right.toLowerCase());
}
