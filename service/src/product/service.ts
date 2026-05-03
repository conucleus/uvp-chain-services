import {
  DEFAULT_OFFICIAL_DOMAIN_ID,
  summarizeZhixu,
  type ChainAttestationDTO,
  type ChainProofRowDTO,
  type FulfillmentPluginKind,
  type ProductExecutorOverlayDTO,
  type ProductOrderDTO,
  type ProductResourceRequirementDTO,
  type ProductTaskCapabilityPluginDTO,
  type ProductTaskDTO,
  type ProductTimelineEventDTO,
  type SettlementPreviewDTO,
  type StoreProductSchemaDTO,
  type ZhixuDetailDTO,
  type ZhixuStageDTO,
  type ZhixuSummaryDTO
} from "@uvp-eth/product-dto";
import {
  CROSS_BORDER_ZHIXU_ID,
  crossBorderPlanIds,
  demoOrder,
  demoProductCatalog
} from "@uvp-eth/product-dto/fixtures";
import { keccak256, stringToBytes, type Hex } from "viem";
import type {
  EventProofArgs,
  ProjectionProvenance,
  StateMachineHookProjection,
  StateMachineOrderProjection,
  StateMachineOrderStatus,
  StateMachineProofProjection,
  StateMachineSignalProjection,
  StateMachineStageExecutorOverlayProjection,
  StateMachineStageResourceOverlayProjection,
  StateMachineTaskProjection,
  StateMachineTaskStatus,
  StateMachineTimelineEventProjection
} from "../indexer/projections.js";
import type { PlanTrustProjection, SupplierTrustProjection, TrustProjectionSnapshot } from "../indexer/trust-projections.js";
import type { ProjectionStore, ProjectionSyncState } from "../storage/projection-store.js";

export interface ProductChainProofDTO {
  readonly eventId: string;
  readonly chainId: number;
  readonly contractAddress: string;
  readonly blockNumber: string;
  readonly transactionHash: string;
  readonly logIndex: number;
  readonly eventName: string;
  readonly proofKind: string;
  readonly args: EventProofArgs;
  readonly blockHash?: string;
  readonly orderId?: string;
  readonly planId?: string;
  readonly planHash?: string;
  readonly artifactHash?: string;
  readonly payloadHash?: string;
  readonly sourceId?: string;
  readonly signalId?: string;
  readonly hookId?: string;
  readonly stageIdentifier?: string;
  readonly selectorStageId?: string;
  readonly targetStageId?: string;
  readonly resourceKey?: string;
  readonly patchHash?: string;
  readonly patchNonce?: string;
  readonly manifestHash?: string;
  readonly policyHash?: string;
  readonly activeExecutorWallet?: string;
  readonly metadataURI?: string;
  readonly attestationTx?: string;
  readonly submitter?: string;
}

export interface ProductTimelineEventApiDTO extends ProductTimelineEventDTO {
  readonly eventName: string;
  readonly proofKind: string;
  readonly blockNumber: string;
  readonly transactionHash: string;
  readonly actor?: string;
  readonly proof: ProductChainProofDTO;
}

export interface ProductConfirmationDTO {
  readonly confirmationId: string;
  readonly orderId: string;
  readonly sourceLabel: string;
  readonly actionLabel: string;
  readonly payloadHash: string;
  readonly submitter: string;
  readonly submittedAt: string;
  readonly proof: ProductChainProofDTO;
}

export interface ProductConditionDTO {
  readonly conditionId: string;
  readonly stageId: string;
  readonly stageName: string;
  readonly status: StateMachineHookProjection["status"];
  readonly statusLabel: string;
  readonly dueAt?: string;
  readonly proof: ProductChainProofDTO;
}

export interface ProductStageExecutorOverlayApiDTO {
  readonly orderId: string;
  readonly selectorStageId: string;
  readonly targetStageId: string;
  readonly selectorWallet: string;
  readonly activeExecutorWallet: string;
  readonly mode: string;
  readonly modeHash?: string;
  readonly previousExecutor?: string;
  readonly approvalSourceId?: string;
  readonly approvalSignalId?: string;
  readonly roleHash: string;
  readonly executorMetadataHash: string;
  readonly patchHash: string;
  readonly patchNonce: string;
  readonly metadataURI: string;
  readonly proofRows: readonly ChainProofRowDTO[];
  readonly proof: ProductChainProofDTO;
  readonly activationProof?: ProductChainProofDTO;
}

export interface ProductStageResourceOverlayApiDTO {
  readonly orderId: string;
  readonly selectorStageId: string;
  readonly targetStageId: string;
  readonly resourceKey: string;
  readonly selectorWallet: string;
  readonly manifestHash: string;
  readonly policyHash: string;
  readonly patchHash: string;
  readonly patchNonce: string;
  readonly manifestURI: string;
  readonly proofRows: readonly ChainProofRowDTO[];
  readonly proof: ProductChainProofDTO;
}

export interface ProductProjectionMetadataDTO {
  readonly source: "chain_projection" | "legacy_projection";
  readonly syncStatus: ProjectionSyncState["syncStatus"];
  readonly chainId?: number;
  readonly contractAddress?: string;
  readonly updatedAtBlock?: string;
  readonly latestIndexedBlock?: string;
  readonly finalizedBlock?: string;
  readonly confirmationDepth?: number;
  readonly lastEventName?: string;
  readonly eventCount?: number;
  readonly rebuildStatus?: string;
  readonly degradedReason?: string;
}

export type ProductOrderApiDTO = ProductOrderDTO & {
  readonly planId?: string;
  readonly planHash?: string;
  readonly chainStatus?: StateMachineOrderStatus;
  readonly paymentConditionSummary?: string;
  readonly tasks?: readonly ProductTaskApiDTO[];
  readonly stageExecutorOverlays?: Readonly<Record<string, ProductStageExecutorOverlayApiDTO>>;
  readonly stageResourceOverlays?: Readonly<Record<string, ProductStageResourceOverlayApiDTO>>;
  readonly confirmations?: readonly ProductConfirmationDTO[];
  readonly conditions?: readonly ProductConditionDTO[];
  readonly timeline?: readonly ProductTimelineEventApiDTO[];
  readonly proof?: readonly ProductChainProofDTO[];
  readonly projection?: ProductProjectionMetadataDTO;
};

export type ProductTaskApiDTO = ProductTaskDTO & {
  readonly hookId?: string;
  readonly hookName?: string;
  readonly stageIdentifier?: string;
  readonly chainStatus?: StateMachineTaskStatus;
  readonly readyTxHash?: string;
  readonly submittedSignalTxHash?: string;
  readonly stageExecutorOverlay?: ProductStageExecutorOverlayApiDTO;
  readonly stageResourceOverlays?: readonly ProductStageResourceOverlayApiDTO[];
  readonly proof?: ProductChainProofDTO;
  readonly projection?: ProductProjectionMetadataDTO;
};

export interface ProductTaskQuery {
  readonly orderId?: string;
  readonly assignee?: string;
  readonly status?: string;
}

export interface ProductParticipantViewQuery {
  readonly walletAddress?: string;
  readonly acceptedParticipants?: readonly ProductParticipantIdentityDTO[];
}

export interface ProductParticipantIdentityDTO {
  readonly participantId: string;
  readonly displayName: string;
  readonly walletAddress: string;
  readonly roleLabel: string;
  readonly roleSlotId: string;
  readonly draftId: string;
  readonly draftTitle: string;
  readonly orderId?: string;
}

export interface ProductParticipantView {
  readonly participant: {
    readonly participantId: string;
    readonly displayName: string;
    readonly walletAddress?: string;
    readonly roleLabels: readonly string[];
    readonly source: "accepted_participant" | "wallet" | "anonymous";
  };
  readonly orders: readonly ProductOrderApiDTO[];
  readonly tasks: readonly ProductTaskApiDTO[];
}

export interface ProductZhixuListOptions {
  readonly demoFallback?: boolean;
}

export interface ProductZhixuLookupOptions {
  readonly includeUnattested?: boolean;
}

export interface ProductService {
  listZhixu(options?: ProductZhixuListOptions): Promise<readonly ZhixuSummaryDTO[]>;
  getZhixu(zhixuId: string, options?: ProductZhixuLookupOptions): Promise<ZhixuDetailDTO | undefined>;
  listOrders(): Promise<readonly ProductOrderApiDTO[]>;
  getOrder(orderId: string): Promise<ProductOrderApiDTO | undefined>;
  listOrderTimeline(orderId: string): Promise<readonly ProductTimelineEventApiDTO[] | undefined>;
  listOrderProof(orderId: string): Promise<readonly ProductChainProofDTO[] | undefined>;
  listTasks(query?: ProductTaskQuery): Promise<readonly ProductTaskApiDTO[]>;
  getTask(taskId: string): Promise<ProductTaskApiDTO | undefined>;
  getParticipantView(query?: ProductParticipantViewQuery): Promise<ProductParticipantView>;
  getActiveStateMachineDeployment(): Promise<{ readonly deploymentId: string; readonly stateMachineAddress: string } | undefined>;
}

export interface ProductSchemaResolver {
  getProductSchemaByPlan(
    planId: string,
    planHash: string,
    artifactHash?: string
  ): Promise<StoreProductSchemaDTO | undefined>;
}

export interface ProductServiceOptions {
  readonly productSchemaResolver?: ProductSchemaResolver;
}

export class ProductOrderLookupError extends Error {
  override readonly name = "ProductOrderLookupError";

  constructor(
    readonly code: "ambiguous_order_id",
    message: string,
    readonly details: unknown
  ) {
    super(message);
  }
}

export function createProductService(store: ProjectionStore, options: ProductServiceOptions = {}): ProductService {
  const productSchemaResolver = options.productSchemaResolver;
  return {
    async listZhixu(options = {}) {
      const trustSnapshot = await store.getTrustSnapshot();
      const catalogZhixus = demoProductCatalog.zhixus
        .map((zhixu) => enrichZhixuTrust(zhixu, trustSnapshot))
        .filter(isListedOfficialZhixu)
        .map((zhixu) => summarizeZhixu(zhixu));
      const catalogPlanKeys = new Set(
        demoProductCatalog.zhixus.map((zhixu) => planKey(zhixu.chainAttestation.planId, zhixu.chainAttestation.planHash))
      );
      const projectedZhixus = Object.values(trustSnapshot.plans)
        .filter((trust) => isActiveOfficialPlanTrust(trust) && !catalogPlanKeys.has(planKey(trust.planId, trust.planHash)))
        .map(async (trust) => summarizeZhixu(await zhixuDetailFromPlanTrustOrSchema(trust, productSchemaResolver)));
      const resolvedProjectedZhixus = await Promise.all(projectedZhixus);
      const listed = [...catalogZhixus, ...resolvedProjectedZhixus].sort((left, right) => left.zhixuId.localeCompare(right.zhixuId));

      if (listed.length > 0) {
        return listed;
      }

      if (options.demoFallback && Object.keys(trustSnapshot.plans).length === 0) {
        return demoProductCatalog.zhixus.map((zhixu) => summarizeZhixu(zhixu));
      }

      return [];
    },

    async getZhixu(zhixuId, lookupOptions = {}) {
      const trustSnapshot = await store.getTrustSnapshot();
      const zhixu = demoProductCatalog.zhixus.find((item) => item.zhixuId === zhixuId);
      if (!zhixu) {
        return resolveProjectedZhixuById(zhixuId, trustSnapshot, productSchemaResolver);
      }
      return findPlanTrust(trustSnapshot, zhixu.chainAttestation) || lookupOptions.includeUnattested
        ? enrichZhixuTrust(zhixu, trustSnapshot)
        : undefined;
    },

    async listOrders() {
      const syncState = await store.getSyncState();
      const stateMachineOrders = await store.listStateMachineOrders();
      if (stateMachineOrders.length > 0) {
        const trustSnapshot = await store.getTrustSnapshot();
        return await Promise.all(
          stateMachineOrders.map((order) => productOrderFromStateMachine(order, trustSnapshot, syncState, productSchemaResolver))
        );
      }

      return [];
    },

    async getOrder(orderId) {
      const syncState = await store.getSyncState();
      const matches = await store.findStateMachineOrdersByOrderId(orderId);
      if (matches.length > 1 && !orderId.includes(":")) {
        throw new ProductOrderLookupError("ambiguous_order_id", "order id exists on multiple state machine deployments", {
          orderId,
          candidates: matches.map((order) => ({
            chainId: order.chainId,
            stateMachineAddress: order.contractAddress,
            deploymentId: order.deploymentId ?? null
          }))
        });
      }
      const stateMachineOrder = matches[0] ?? await store.getStateMachineOrder(orderId);
      if (stateMachineOrder) {
        return await productOrderFromStateMachine(stateMachineOrder, await store.getTrustSnapshot(), syncState, productSchemaResolver);
      }

      return undefined;
    },

    async listOrderTimeline(orderId) {
      const matches = await store.findStateMachineOrdersByOrderId(orderId);
      const order = matches.length === 1 ? matches[0] : await store.getStateMachineOrder(orderId);
      if (!order) {
        return undefined;
      }
      return productTimelineFromStateMachine(order, await store.getTrustSnapshot());
    },

    async listOrderProof(orderId) {
      const matches = await store.findStateMachineOrdersByOrderId(orderId);
      const order = matches.length === 1 ? matches[0] : await store.getStateMachineOrder(orderId);
      if (!order) {
        return undefined;
      }
      return productProofFromStateMachine(order, await store.getTrustSnapshot());
    },

    async listTasks(query = {}) {
      const syncState = await store.getSyncState();
      const trustSnapshot = await store.getTrustSnapshot();
      const orders = await store.listStateMachineOrders();
      const ordersByTaskId = stateMachineOrdersByTaskId(orders);
      const stateMachineTasks = await store.listStateMachineTasks();
      const tasks = await Promise.all(
        stateMachineTasks.map((task) =>
          productTaskFromStateMachineTask(task, ordersByTaskId.get(task.taskId), syncState, trustSnapshot, productSchemaResolver)
        )
      );
      return tasks.filter((task) => matchesTaskQuery(task, query));
    },

    async getTask(taskId) {
      const syncState = await store.getSyncState();
      const stateMachineTask = await store.getStateMachineTask(taskId);
      if (stateMachineTask) {
        const order = findStateMachineOrderForTask(await store.listStateMachineOrders(), stateMachineTask);
        return await productTaskFromStateMachineTask(stateMachineTask, order, syncState, await store.getTrustSnapshot(), productSchemaResolver);
      }
      return undefined;
    },

    async getParticipantView(query = {}) {
      const walletAddress = query.walletAddress?.toLowerCase();
      const acceptedParticipants = walletAddress
        ? (query.acceptedParticipants ?? []).filter((participant) =>
            participant.walletAddress.toLowerCase() === walletAddress
          )
        : [];
      const syncState = await store.getSyncState();
      const trustSnapshot = await store.getTrustSnapshot();
      const orders = await store.listStateMachineOrders();
      const ordersByTaskId = stateMachineOrdersByTaskId(orders);
      const allTasks = (await Promise.all(
        (await store.listStateMachineTasks()).map((task) =>
          productTaskFromStateMachineTask(task, ordersByTaskId.get(task.taskId), syncState, trustSnapshot, productSchemaResolver)
        )
      )).filter((task) => matchesTaskQuery(task, walletAddress ? { assignee: walletAddress } : {}));
      const tasks = walletAddress ? allTasks.filter((task) => task.assigneeWallet?.toLowerCase() === walletAddress) : [];
      const visibleOrderIds = new Set([
        ...tasks.map((task) => task.orderId),
        ...acceptedParticipants.map((participant) => participant.orderId).filter((orderId): orderId is string => Boolean(orderId))
      ]);
      const visibleOrders = await Promise.all(orders
        .filter((order) => visibleOrderIds.has(order.orderId))
        .map((order) => productOrderFromStateMachine(order, trustSnapshot, syncState, productSchemaResolver)));
      const primaryParticipant = acceptedParticipants[0];
      return {
        participant: {
          participantId: primaryParticipant?.participantId ?? (walletAddress ? `wallet:${walletAddress}` : "anonymous"),
          displayName: primaryParticipant?.displayName ?? (walletAddress ? `钱包 ${shortHex(walletAddress)}` : "未连接钱包"),
          ...(query.walletAddress ? { walletAddress: query.walletAddress } : {}),
          roleLabels: Array.from(new Set([
            ...acceptedParticipants.map((participant) => participant.roleLabel),
            ...tasks.map((task) => task.participantRoleLabel ?? task.assigneeRole)
          ])).sort(),
          source: primaryParticipant ? "accepted_participant" : walletAddress ? "wallet" : "anonymous"
        },
        orders: visibleOrders,
        tasks
      };
    },

    async getActiveStateMachineDeployment() {
      const snapshot = await store.getOrderSnapshot?.();
      const activeDeploymentId = snapshot?.activeStateMachineDeploymentId;
      if (!snapshot || !activeDeploymentId) {
        return undefined;
      }
      const deployment = Object.values(snapshot.stateMachineDeployments).find((item) => item.deploymentId === activeDeploymentId);
      return deployment
        ? { deploymentId: deployment.deploymentId, stateMachineAddress: deployment.stateMachineAddress }
        : undefined;
    }
  };
}

async function productOrderFromStateMachine(
  order: StateMachineOrderProjection,
  trustSnapshot: TrustProjectionSnapshot,
  syncState?: ProjectionSyncState,
  productSchemaResolver?: ProductSchemaResolver
): Promise<ProductOrderApiDTO> {
  const tasks = await Promise.all(
    Object.values(order.tasks).map((task) =>
      productTaskFromStateMachineTask(task, order, syncState, trustSnapshot, productSchemaResolver)
    )
  );
  const timeline = productTimelineFromStateMachine(order, trustSnapshot);
  const proof = productProofFromStateMachine(order, trustSnapshot);
  const activeTask = tasks.find((task) => task.status === "open") ?? tasks[0];
  const stages = productStagesFromStateMachine(order);
  const executorOverlays = productExecutorOverlaysByStage(order);
  const resourceRequirements = productResourceRequirementsByStage(order);
  const currentStageId = displayStageId(order.currentStage ?? activeTask?.stageId ?? stages[0]?.stageId ?? order.orderId);
  const currentStageName = activeTask?.stageName ?? stages.find((stage) => stage.stageId === currentStageId)?.name ??
    displayBytes32(order.currentStage, "当前阶段");

  return {
    orderId: order.orderId,
    stateMachineAddress: order.contractAddress,
    ...(order.deploymentId ? { deploymentId: order.deploymentId } : {}),
    zhixuId: zhixuIdForPlan(order),
    title: `链上订单 ${shortId(order.orderId)}`,
    status: mapStateMachineOrderStatus(order.status),
    statusLabel: mapStateMachineOrderStatusLabel(order.status),
    totalAmount: {
      amount: "0",
      currency: "N/A",
      display: "未接入资金托管"
    },
    fundingStatus: "资金托管未接入本接口",
    currentStageId,
    currentStageName,
    ...(activeTask ? { currentTaskId: activeTask.taskId } : {}),
    currentTaskTitle: activeTask?.title ?? "等待下一步链上确认",
    currentTaskSummary: activeTask?.subtitle ?? "订单已从状态机事件重建",
    stages,
    ...(Object.keys(executorOverlays).length > 0 ? { executorOverlays } : {}),
    ...(Object.keys(resourceRequirements).length > 0 ? { resourceRequirements } : {}),
    participants: zhixuIdForPlan(order) === CROSS_BORDER_ZHIXU_ID ? demoOrder.participants : [],
    recentEvents: timeline.slice(-3).reverse().map(({ eventId, text, time }) => ({ eventId, text, time })),
    proofRows: proofRowsFromProof(proof[proof.length - 1]),
    planId: order.planId,
    ...(order.planHash ? { planHash: order.planHash } : {}),
    chainStatus: order.status,
    paymentConditionSummary: paymentConditionSummaryFromStateMachine(order),
    tasks,
    stageExecutorOverlays: Object.fromEntries(
      Object.entries(order.stageExecutorOverlays).map(([stageId, overlay]) => [stageId, productStageExecutorOverlayFromStateMachine(overlay)])
    ),
    stageResourceOverlays: Object.fromEntries(
      Object.entries(order.stageResourceOverlays).map(([resourceOverlayId, overlay]) => [
        resourceOverlayId,
        productStageResourceOverlayFromStateMachine(overlay)
      ])
    ),
    confirmations: Object.values(order.signals).map(productConfirmationFromStateMachineSignal),
    conditions: Object.values(order.hooks).map(productConditionFromStateMachineHook),
    timeline,
    proof,
    projection: projectionMetadataFromStateMachineOrder(order, syncState)
  };
}

function stateMachineOrdersByTaskId(
  orders: readonly StateMachineOrderProjection[]
): ReadonlyMap<string, StateMachineOrderProjection> {
  const byTaskId = new Map<string, StateMachineOrderProjection>();
  for (const order of orders) {
    for (const taskId of Object.keys(order.tasks)) {
      byTaskId.set(taskId, order);
    }
  }
  return byTaskId;
}

function findStateMachineOrderForTask(
  orders: readonly StateMachineOrderProjection[],
  task: StateMachineTaskProjection
): StateMachineOrderProjection | undefined {
  return orders.find((order) =>
    order.orderId.toLowerCase() === task.orderId.toLowerCase() &&
    Object.prototype.hasOwnProperty.call(order.tasks, task.taskId)
  );
}

async function productTaskFromStateMachineTask(
  task: StateMachineTaskProjection,
  order?: StateMachineOrderProjection,
  syncState?: ProjectionSyncState,
  trustSnapshot?: TrustProjectionSnapshot,
  productSchemaResolver?: ProductSchemaResolver
): Promise<ProductTaskApiDTO> {
  const decodedStageId = displayStageId(task.stageIdentifier);
  const stageName = displayBytes32(task.stageIdentifier, "阶段");
  const hookLabel = displayBytes32(task.hookName, "链上待办");
  const orderTitle = order ? `链上订单 ${shortId(order.orderId)}` : `链上订单 ${shortId(task.orderId)}`;
  const baseProof = proofFromStateMachineProof(task.proof);
  const capabilityResolution = await resolveTaskCapabilityPlugin(task, order, trustSnapshot, productSchemaResolver);
  const proof = proofWithCapabilitySubmitSignal(baseProof, capabilityResolution);
  const productStage = await resolveProductStageForTask(task, order, trustSnapshot, productSchemaResolver);
  const stageId = productStage?.stageId ?? decodedStageId;
  const taskAddOnManifest = capabilityResolution?.addOnManifest ??
    await resolveAddOnManifestForTask(task, order, trustSnapshot, productSchemaResolver, productStage?.addOnKind);
  const stageExecutorOverlay = order?.stageExecutorOverlays[task.stageIdentifier.toLowerCase()];
  const effectiveAssigneeWallet = stageExecutorOverlay?.activeExecutorWallet ??
    capabilityResolution?.submitterWallet ??
    task.assigneeWallet;
  const fulfillmentKind = capabilityResolution?.capabilityPlugin.pluginKind;
  const requiredEvidence = capabilityResolution
    ? requiredEvidenceForCapability(capabilityResolution.capabilityPlugin)
    : productStage?.evidence ?? [];
  const requiredInputs = capabilityResolution
    ? requiredInputsForCapability(capabilityResolution.capabilityPlugin, task.status === "submitted")
    : undefined;
  const supplierTrust = effectiveAssigneeWallet && trustSnapshot
    ? supplierTrustForWallet(trustSnapshot, effectiveAssigneeWallet)
    : undefined;
  const hasGenericAddOn = Boolean(productStage?.addOnKind ?? taskAddOnManifest);
  const productAddOnKind = productStage?.addOnKind ?? taskAddOnManifest?.addOnKind;
  const capabilityBacked = Boolean(capabilityResolution) || hasGenericAddOn;
  const baseProductStatus = capabilityBacked ? mapStateMachineTaskStatus(task.status) : "blocked" as const;
  const protocolBlockedReason = blockedReasonForTask(task, capabilityResolution, hasGenericAddOn);
  const supplierBlockedReason = supplierBlockedReasonForTask(task.status, supplierTrust);
  const blockedReason = task.status === "cancelled"
    ? protocolBlockedReason ?? supplierBlockedReason
    : supplierBlockedReason ?? protocolBlockedReason;
  const productStatus = blockedReason ? "blocked" as const : baseProductStatus;
  const executorOverlayDto = stageExecutorOverlay
    ? productStageExecutorOverlayFromStateMachine(stageExecutorOverlay)
    : undefined;
  const productExecutorOverlayDto = stageExecutorOverlay
    ? productExecutorOverlayFromStateMachine(stageExecutorOverlay)
    : undefined;
  const resourceOverlayDtos = order
    ? Object.values(order.stageResourceOverlays)
      .filter((overlay) => overlay.targetStageId === task.stageIdentifier)
      .map(productStageResourceOverlayFromStateMachine)
      .sort(compareStageResourceOverlays)
    : [];
  const resourceRequirements = order
    ? productResourceRequirementsForStage(order, task.stageIdentifier)
    : [];

  return {
    taskId: task.taskId,
    orderId: task.orderId,
    stateMachineAddress: task.stateMachineAddress,
    ...(task.deploymentId ? { deploymentId: task.deploymentId } : {}),
    orderTitle,
    zhixuId: order ? zhixuIdForPlan(order) : CROSS_BORDER_ZHIXU_ID,
    title: hookLabel === "链上待办" ? "处理链上待办" : `处理${hookLabel}`,
    subtitle: `${stageName} 已满足链上触发条件，需要继续处理。`,
    assigneeRole: displayAssigneeRole(task.assigneeRole),
    ...(effectiveAssigneeWallet ? { assigneeWallet: effectiveAssigneeWallet } : {}),
    ...(supplierTrust
      ? {
          supplierSubjectId: supplierTrust.supplierSubjectId,
          supplierTrustStatus: supplierTrust.revoked ? "revoked" as const : "attested" as const
        }
      : effectiveAssigneeWallet
        ? { supplierTrustStatus: "not_found" as const }
        : {}),
    stageId,
    stageName,
    deadline: "以业务约定为准",
    fundingImpact: fulfillmentKind
      ? fundingImpactForFulfillment(fulfillmentKind)
      : productAddOnKind
        ? fundingImpactForAddOn(productAddOnKind)
        : "缺少履约插槽能力插件元数据，当前只能展示链上证明，不能提交业务动作",
    requiredEvidence,
    status: productStatus,
    ...(fulfillmentKind ? { fulfillmentKind } : {}),
    ...(capabilityResolution ? {
      performanceSlotId: capabilityResolution.roleSlotId,
      performanceSlotLabel: capabilityResolution.performanceSlotLabel,
      businessPersonaLabels: capabilityResolution.businessPersonaLabels,
      capabilityPlugin: capabilityResolution.capabilityPlugin,
      ...(taskAddOnManifest ? { addOnManifest: taskAddOnManifest } : {}),
      primaryActionLabel: capabilityResolution.capabilityPlugin.primaryActionLabel ??
        primaryActionForFulfillment(capabilityResolution.capabilityPlugin.pluginKind)
    } : {
      capabilityPlugin: missingTaskCapabilityPlugin()
    }),
    ...(!capabilityResolution && taskAddOnManifest ? { addOnManifest: taskAddOnManifest } : {}),
    ...(requiredInputs ? { requiredInputs } : {}),
    ...(productAddOnKind ? { addOnKind: productAddOnKind } : {}),
    ...(productStage?.selectableTargets ? { selectableTargets: productStage.selectableTargets } : {}),
    ...(productExecutorOverlayDto ? { executorOverlay: productExecutorOverlayDto } : {}),
    ...(resourceRequirements.length > 0 ? { resourceRequirements } : {}),
    ...(productStage?.effectiveFileResources ? { effectiveFileResources: productStage.effectiveFileResources } : {}),
    ...(blockedReason ? { blockedReason } : {}),
    ...(fulfillmentKind === "payment_placeholder" ? { settlementPreview: paymentPlaceholderSettlementPreview() } : {}),
    participantRoleLabel: capabilityResolution?.participantRoleLabel ?? displayAssigneeRole(task.assigneeRole),
    ...(effectiveAssigneeWallet ? { participantWallet: effectiveAssigneeWallet } : {}),
    canSubmit: capabilityBacked && task.status === "ready" && Boolean(effectiveAssigneeWallet) && !supplierTrust?.revoked,
    proofSummary: {
      label: task.status === "submitted" ? "已提交链上确认" : "等待提交确认",
      txHash: task.status === "submitted" ? task.proof.transactionHash : task.createdAt.transactionHash,
      blockNumber: task.status === "submitted" ? task.proof.blockNumber.toString() : task.createdAt.blockNumber.toString(),
      ...(proof.payloadHash ? { payloadHash: proof.payloadHash } : {})
    },
    responsibilityStatements: [
      {
        title: "我确认本次处理基于真实业务事实",
        desc: "提交后会形成可追溯链上确认或触发下一步执行。"
      }
    ],
    proofRows: [
      ...proofRowsFromProof(proof),
      ...supplierProofRowsForTask(supplierTrust, effectiveAssigneeWallet),
      ...(executorOverlayDto ? [{ label: "Stage executor patch", value: shortHex(executorOverlayDto.patchHash) }] : []),
      ...resourceOverlayDtos.map((overlay) => ({
        label: "Stage resource patch",
        value: `${shortHex(overlay.resourceKey)} ${shortHex(overlay.patchHash)}`
      }))
    ],
    hookId: task.hookId,
    hookName: hookLabel,
    stageIdentifier: stageId,
    chainStatus: task.status,
    readyTxHash: task.createdAt.transactionHash,
    ...(task.status === "submitted" && task.proof.eventName === "SignalSubmitted"
      ? { submittedSignalTxHash: task.proof.transactionHash }
      : {}),
    ...(executorOverlayDto ? { stageExecutorOverlay: executorOverlayDto } : {}),
    ...(resourceOverlayDtos.length > 0 ? { stageResourceOverlays: resourceOverlayDtos } : {}),
    proof,
    projection: projectionMetadataFromStateMachineTask(task, syncState)
  };
}

interface TaskCapabilityResolution {
  readonly roleSlotId: string;
  readonly performanceSlotLabel: string;
  readonly participantRoleLabel: string;
  readonly businessPersonaLabels: readonly string[];
  readonly capabilityPlugin: ProductTaskCapabilityPluginDTO;
  readonly addOnManifest?: NonNullable<ZhixuDetailDTO["roleSlots"][number]["addOnManifest"]>;
  readonly submitterWallet?: string;
  readonly submitSignal?: {
    readonly sourceId: Hex;
    readonly signalId: Hex;
  };
}

interface TaskCapabilityCandidate extends TaskCapabilityResolution {
  readonly permissionCorroborated: boolean;
}

async function resolveTaskCapabilityPlugin(
  task: StateMachineTaskProjection,
  order?: StateMachineOrderProjection,
  trustSnapshot?: TrustProjectionSnapshot,
  productSchemaResolver?: ProductSchemaResolver
): Promise<TaskCapabilityResolution | undefined> {
  if (!order) {
    return undefined;
  }
  const zhixu = await zhixuDetailForOrder(order, trustSnapshot, productSchemaResolver);
  if (!zhixu || zhixu.roleSlots.length === 0) {
    return undefined;
  }

  const decodedStageId = displayStageId(task.stageIdentifier);
  const stageIds = new Set([decodedStageId, task.stageIdentifier.toLowerCase()]);
  const corroboratingRoleSlotIds = new Set(
    zhixu.orderPermissionTable
      .filter((entry) => taskStageMatches(entry.stageId, stageIds))
      .map((entry) => entry.roleSlotId)
  );
  const candidates: TaskCapabilityCandidate[] = [];

  for (const slot of zhixu.roleSlots) {
    for (const plugin of slot.capabilityPlugins ?? []) {
      if (!plugin.stageIds.some((stageId) => taskStageMatches(stageId, stageIds))) {
        continue;
      }
      const capabilityPlugin = taskCapabilityPluginFromSlot(plugin, slot.slotId);
      const submitter = submitterForCapability(order, zhixu, slot.slotId, stageIds);
      candidates.push({
        roleSlotId: slot.slotId,
        performanceSlotLabel: slot.performanceSlotLabel ?? slot.label,
        participantRoleLabel: slot.label,
        businessPersonaLabels: slot.businessPersonaLabels ?? [],
        capabilityPlugin,
        ...(slot.addOnManifest ? { addOnManifest: slot.addOnManifest } : {}),
        ...(submitter ? {
          submitterWallet: submitter.wallet,
          submitSignal: { sourceId: submitter.sourceId, signalId: submitter.signalId }
        } : {}),
        permissionCorroborated: corroboratingRoleSlotIds.has(slot.slotId)
      });
    }
  }

  return candidates.sort(compareTaskCapabilityCandidates)[0];
}

function submitterForCapability(
  order: StateMachineOrderProjection,
  zhixu: ZhixuDetailDTO,
  roleSlotId: string,
  stageIds: ReadonlySet<string>
): { readonly wallet: string; readonly sourceId: Hex; readonly signalId: Hex } | undefined {
  const entries = zhixu.orderPermissionTable
    .filter((entry) =>
      entry.roleSlotId === roleSlotId &&
      entry.source.length > 0 &&
      taskStageMatches(entry.stageId, stageIds)
    )
    .sort(compareCapabilityPermissionEntries);

  for (const entry of entries) {
    const sourceId = keccak256(stringToBytes(entry.source)).toLowerCase();
    const signalId = keccak256(stringToBytes(entry.signalName)).toLowerCase();
    const authorization = Object.values(order.authorizations).find((item) =>
      item.sourceId.toLowerCase() === sourceId &&
      item.signalId.toLowerCase() === signalId
    );
    if (authorization) {
      return {
        wallet: authorization.submitter,
        sourceId: sourceId as Hex,
        signalId: signalId as Hex
      };
    }
  }
  return undefined;
}

function proofWithCapabilitySubmitSignal(
  proof: ProductChainProofDTO,
  capabilityResolution?: TaskCapabilityResolution
): ProductChainProofDTO {
  const submitSignal = capabilityResolution?.submitSignal;
  if (!submitSignal || (proof.sourceId && proof.signalId)) {
    return proof;
  }
  return {
    ...proof,
    ...(proof.sourceId ? {} : { sourceId: submitSignal.sourceId }),
    ...(proof.signalId ? {} : { signalId: submitSignal.signalId })
  };
}

function compareCapabilityPermissionEntries(
  left: ZhixuDetailDTO["orderPermissionTable"][number],
  right: ZhixuDetailDTO["orderPermissionTable"][number]
): number {
  return permissionSignalPriority(left.signalName) - permissionSignalPriority(right.signalName) ||
    left.permissionId.localeCompare(right.permissionId);
}

function permissionSignalPriority(signalName: string): number {
  if (signalName.endsWith(".confirm_stage")) {
    return 0;
  }
  if (signalName.includes("confirm_stage")) {
    return 1;
  }
  return 2;
}

async function resolveProductStageForTask(
  task: StateMachineTaskProjection,
  order?: StateMachineOrderProjection,
  trustSnapshot?: TrustProjectionSnapshot,
  productSchemaResolver?: ProductSchemaResolver
): Promise<ZhixuStageDTO | undefined> {
  if (!order) {
    return undefined;
  }
  const zhixu = await zhixuDetailForOrder(order, trustSnapshot, productSchemaResolver);
  if (!zhixu) {
    return undefined;
  }
  const decodedStageId = displayStageId(task.stageIdentifier);
  const stageIds = new Set([decodedStageId, task.stageIdentifier.toLowerCase()]);
  return zhixu.stages.find((stage) => taskStageMatches(stage.stageId, stageIds));
}

async function resolveAddOnManifestForTask(
  task: StateMachineTaskProjection,
  order?: StateMachineOrderProjection,
  trustSnapshot?: TrustProjectionSnapshot,
  productSchemaResolver?: ProductSchemaResolver,
  preferredAddOnKind?: ZhixuStageDTO["addOnKind"]
): Promise<NonNullable<ZhixuDetailDTO["roleSlots"][number]["addOnManifest"]> | undefined> {
  if (!order) {
    return undefined;
  }
  const zhixu = await zhixuDetailForOrder(order, trustSnapshot, productSchemaResolver);
  if (!zhixu) {
    return undefined;
  }
  const decodedStageId = displayStageId(task.stageIdentifier);
  const stageIds = new Set([decodedStageId, decodedStageId.toLowerCase(), task.stageIdentifier.toLowerCase()]);
  const manifests = zhixu.roleSlots
    .map((slot) => slot.addOnManifest)
    .filter((manifest): manifest is NonNullable<ZhixuDetailDTO["roleSlots"][number]["addOnManifest"]> =>
      Boolean(manifest) && manifest!.stageBindings.some((stageId) => taskStageMatches(stageId, stageIds))
    );
  return manifests.find((manifest) => preferredAddOnKind && manifest.addOnKind === preferredAddOnKind) ?? manifests[0];
}

async function zhixuDetailForOrder(
  order: StateMachineOrderProjection,
  trustSnapshot?: TrustProjectionSnapshot,
  productSchemaResolver?: ProductSchemaResolver
): Promise<ZhixuDetailDTO | undefined> {
  const trust = trustSnapshot
    ? Object.values(trustSnapshot.plans).find((plan) => planTrustMatchesOrder(plan, order))
    : undefined;
  const storeSchema = await productSchemaForOrder(order, trust, productSchemaResolver);
  if (storeSchema) {
    return zhixuDetailFromProductSchema(storeSchema, trust);
  }

  const catalogZhixu = demoProductCatalog.zhixus.find((zhixu) => zhixuMatchesOrderPlan(zhixu, order));
  if (catalogZhixu) {
    return trustSnapshot ? enrichZhixuTrust(catalogZhixu, trustSnapshot) : catalogZhixu;
  }

  return trust ? zhixuDetailFromPlanTrust(trust) : undefined;
}

async function zhixuDetailFromPlanTrustOrSchema(
  trust: PlanTrustProjection,
  productSchemaResolver?: ProductSchemaResolver
): Promise<ZhixuDetailDTO> {
  const schema = productSchemaResolver
    ? await productSchemaResolver.getProductSchemaByPlan(trust.planId, trust.planHash, trust.artifactHash)
    : undefined;
  return schema && isExplicitStoreProductSchema(schema)
    ? zhixuDetailFromProductSchema(schema, trust)
    : zhixuDetailFromPlanTrust(trust);
}

async function resolveProjectedZhixuById(
  zhixuId: string,
  trustSnapshot: TrustProjectionSnapshot,
  productSchemaResolver?: ProductSchemaResolver
): Promise<ZhixuDetailDTO | undefined> {
  const officialPlans = Object.values(trustSnapshot.plans)
    .filter((trust) => trust.domainId === DEFAULT_OFFICIAL_DOMAIN_ID);
  for (const trust of officialPlans) {
    const detail = await zhixuDetailFromPlanTrustOrSchema(trust, productSchemaResolver);
    if (detail.zhixuId === zhixuId || zhixuIdFromPlanTrust(trust) === zhixuId) {
      return detail;
    }
  }
  return undefined;
}

async function productSchemaForOrder(
  order: StateMachineOrderProjection,
  trust: PlanTrustProjection | undefined,
  productSchemaResolver?: ProductSchemaResolver
): Promise<StoreProductSchemaDTO | undefined> {
  const planHash = order.planHash ?? trust?.planHash;
  if (!productSchemaResolver || !planHash) {
    return undefined;
  }
  const schema = await productSchemaResolver.getProductSchemaByPlan(order.planId, planHash, trust?.artifactHash);
  return schema && isExplicitStoreProductSchema(schema) ? schema : undefined;
}

function isExplicitStoreProductSchema(schema: StoreProductSchemaDTO): boolean {
  return schema.validation.ok && schema.roleSlots.every((slot) =>
    (slot.capabilityPlugins ?? []).length > 0 &&
    (slot.capabilityPlugins ?? []).every((plugin) => plugin.source === "explicit")
  );
}

function zhixuDetailFromProductSchema(
  schema: StoreProductSchemaDTO,
  trust?: PlanTrustProjection
): ZhixuDetailDTO {
  const baseAttestation: ChainAttestationDTO = {
    status: "not_found",
    label: "等待链上背书同步",
    domainLabel: "共同秩序官方审核",
    planId: schema.planId,
    planHash: schema.planHash,
    artifactHash: schema.artifactHash
  };
  const chainAttestation = trust ? chainAttestationFromTrust(baseAttestation, trust) : baseAttestation;
  const reviewStatus = trust?.revoked ? "revoked" : schema.validation.ok ? "approved" : "unreviewed";
  const paymentMethods = Array.from(new Set(schema.capabilityPlugins
    .filter((plugin) => plugin.pluginKind === "payment_placeholder")
    .map(() => "ERC20 stablecoin adapter")));
  const zhixuId = schema.zhixuId ?? zhixuIdFromPlanIdentity(schema.planId, schema.planHash);

  return {
    zhixuId,
    title: schema.title,
    subtitle: "该秩序来自 Store Product Schema Bundle；链上状态仍以合约事件为准。",
    reviewStatus,
    reviewLabel: trust?.revoked
      ? "链上背书已撤销"
      : schema.validation.ok
        ? "Store schema 已显式确认"
        : "Store schema 未完成确认",
    riskLevel: "以 Store 审核记录为准",
    applicableBusiness: schema.businessPersonaLabels,
    excludedBusiness: [],
    stageCount: schema.stages.length,
    roleSlotCount: schema.roleSlots.length,
    supportedPaymentMethods: paymentMethods,
    maintainer: schema.maintainer,
    updatedAt: schema.updatedAt,
    chainAttestation,
    roleSlots: schema.roleSlots,
    dockableModules: [],
    stages: schema.stages,
    orderPermissionTable: schema.orderPermissionTable,
    proofRows: [
      { label: "秩序编号", value: zhixuId },
      { label: "Plan ID", value: schema.planId },
      { label: "Plan Hash", value: schema.planHash },
      { label: "Artifact Hash", value: schema.artifactHash },
      { label: "Schema Hash", value: schema.schemaHash },
      { label: "Schema 状态", value: schema.validation.status },
      { label: "背书状态", value: chainAttestation.label }
    ],
    createOrderHint: "订单创建必须使用链上 planId/planHash，并由 Product API 按该 schema 解释普通用户任务。"
  };
}

function zhixuIdFromPlanIdentity(planId: string, planHash: string): string {
  return `plan-${shortId(planId)}-${shortId(planHash)}`;
}

function zhixuMatchesOrderPlan(zhixu: ZhixuDetailDTO, order: StateMachineOrderProjection): boolean {
  if (!hexStringEquals(zhixu.chainAttestation.planId, order.planId)) {
    return false;
  }
  return order.planHash === undefined || hexStringEquals(zhixu.chainAttestation.planHash, order.planHash);
}

function planTrustMatchesOrder(trust: PlanTrustProjection, order: StateMachineOrderProjection): boolean {
  if (!hexStringEquals(trust.planId, order.planId)) {
    return false;
  }
  return order.planHash === undefined || hexStringEquals(trust.planHash, order.planHash);
}

function hexStringEquals(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function taskCapabilityPluginFromSlot(
  plugin: NonNullable<ZhixuDetailDTO["roleSlots"][number]["capabilityPlugins"]>[number],
  roleSlotId: string
): ProductTaskCapabilityPluginDTO {
  return {
    pluginKind: plugin.pluginKind,
    source: plugin.source,
    roleSlotId,
    ...(plugin.title ? { title: plugin.title } : {}),
    ...(plugin.summary ? { summary: plugin.summary } : {}),
    ...(plugin.primaryActionLabel ? { primaryActionLabel: plugin.primaryActionLabel } : {}),
    requiredEvidence: plugin.requiredEvidence,
    ...(plugin.inputPolicy ? { inputPolicy: plugin.inputPolicy } : {})
  };
}

function taskStageMatches(stageId: string, taskStageIds: ReadonlySet<string>): boolean {
  const normalizedStageId = stageId.toLowerCase();
  const hashedStageId = keccak256(stringToBytes(stageId)).toLowerCase();
  return taskStageIds.has(stageId) ||
    taskStageIds.has(normalizedStageId) ||
    taskStageIds.has(hashedStageId);
}

function compareTaskCapabilityCandidates(left: TaskCapabilityCandidate, right: TaskCapabilityCandidate): number {
  if (left.permissionCorroborated !== right.permissionCorroborated) {
    return left.permissionCorroborated ? -1 : 1;
  }
  if (left.capabilityPlugin.source !== right.capabilityPlugin.source) {
    return left.capabilityPlugin.source === "explicit" ? -1 : right.capabilityPlugin.source === "explicit" ? 1 : 0;
  }
  return 0;
}

function requiredEvidenceForCapability(plugin: ProductTaskCapabilityPluginDTO): readonly string[] {
  return plugin.requiredEvidence.length > 0 ? plugin.requiredEvidence : requiredEvidenceForFulfillment(plugin.pluginKind);
}

function requiredInputsForCapability(
  plugin: ProductTaskCapabilityPluginDTO,
  completed: boolean
): NonNullable<ProductTaskDTO["requiredInputs"]> {
  if (!plugin.inputPolicy) {
    return requiredInputsForFulfillment(plugin.pluginKind, completed);
  }
  return plugin.inputPolicy.map((input) => ({
    ...input,
    completed: completed || input.completed
  }));
}

function missingTaskCapabilityPlugin(): ProductTaskCapabilityPluginDTO {
  return {
    pluginKind: "evidence_submission",
    source: "missing",
    title: "缺少履约插件配置",
    summary: "该链上待办没有匹配到秩序 metadata 中的履约插槽能力插件。",
    requiredEvidence: []
  };
}

function blockedReasonForTask(
  task: StateMachineTaskProjection,
  capabilityResolution: TaskCapabilityResolution | undefined,
  hasGenericAddOn = false
): string | undefined {
  if (task.status === "cancelled") {
    return "链上条件已取消，当前任务不能继续提交";
  }
  if (!capabilityResolution && !hasGenericAddOn) {
    return "缺少履约插槽能力插件元数据，Product API 不会根据阶段或角色文案猜测可提交动作。";
  }
  return undefined;
}

function primaryActionForFulfillment(kind: FulfillmentPluginKind): string {
  switch (kind) {
    case "payment_placeholder":
      return "确认付款条件";
    case "delivery_update":
      return "提交交付进度";
    case "validation_confirm":
      return "确认验收结果";
    case "dispute_material":
      return "提交争议材料";
    case "evidence_submission":
      return "提交阶段凭证";
  }
}

function requiredEvidenceForFulfillment(kind: FulfillmentPluginKind): readonly string[] {
  switch (kind) {
    case "payment_placeholder":
      return ["付款条件确认", "资金凭证指纹"];
    case "delivery_update":
      return ["交付/报关凭证", "业务确认"];
    case "validation_confirm":
      return ["检验报告", "验收确认"];
    case "dispute_material":
      return ["争议说明", "补充凭证"];
    case "evidence_submission":
      return ["凭证指纹或业务确认"];
  }
}

function fundingImpactForFulfillment(kind: FulfillmentPluginKind): string {
  if (kind === "payment_placeholder") {
    return "稳定币模块占位：仅记录付款条件和凭证，不托管或划转资金";
  }
  return "条件满足后进入下一步；资金托管不在本接口处理";
}

function fundingImpactForAddOn(kind: NonNullable<ZhixuStageDTO["addOnKind"]>): string {
  switch (kind) {
    case "stage_executor_patch":
      return "执行者调整会作为阶段补充写入链上，后续履约只认当前激活执行者";
    case "stage_resource_patch":
      return "资源要求补充会覆盖订单阶段配置，不直接托管或划转资金";
    case "submit_signal":
      return "执行者提交会形成链上确认；凭证正文仍保留在链下";
  }
}

function requiredInputsForFulfillment(
  kind: FulfillmentPluginKind,
  completed: boolean
): NonNullable<ProductTaskDTO["requiredInputs"]> {
  switch (kind) {
    case "payment_placeholder":
      return [
        {
          inputId: "payment-condition",
          label: "确认付款条件",
          inputType: "payment_placeholder",
          required: true,
          completed
        },
        {
          inputId: "funding-evidence",
          label: "资金凭证指纹",
          inputType: "evidence",
          required: true,
          completed
        }
      ];
    case "validation_confirm":
      return [
        {
          inputId: "validation-report",
          label: "检验或验收凭证",
          inputType: "evidence",
          required: true,
          completed
        },
        {
          inputId: "validation-confirmation",
          label: "确认验收结果",
          inputType: "confirmation",
          required: true,
          completed
        }
      ];
    case "dispute_material":
      return [
        {
          inputId: "dispute-statement",
          label: "争议说明",
          inputType: "text",
          required: true,
          completed
        },
        {
          inputId: "dispute-evidence",
          label: "补充凭证",
          inputType: "evidence",
          required: false,
          completed
        }
      ];
    case "delivery_update":
    case "evidence_submission":
      return [
        {
          inputId: "stage-evidence",
          label: kind === "delivery_update" ? "交付/报关凭证" : "阶段凭证",
          inputType: "evidence",
          required: true,
          completed
        },
        {
          inputId: "stage-confirmation",
          label: "确认业务事实",
          inputType: "confirmation",
          required: true,
          completed
        }
      ];
  }
}

function paymentPlaceholderSettlementPreview(): SettlementPreviewDTO {
  return {
    label: "稳定币模块占位",
    statusLabel: "等待后续 funding adapter 接入",
    adapterStatus: "placeholder",
    disclaimer: "当前不托管、不划转、不释放、不退款任何资金，只记录付款条件和证明。"
  };
}

function productTimelineFromStateMachine(
  order: StateMachineOrderProjection,
  trustSnapshot: TrustProjectionSnapshot
): readonly ProductTimelineEventApiDTO[] {
  const timeline = order.timeline.map(productTimelineEventFromStateMachine);
  const trust = planTrustForOrder(trustSnapshot, order);
  const trustEvent = trust ? productTimelineEventFromPlanTrust(trust) : undefined;
  return [...timeline, ...(trustEvent ? [trustEvent] : [])].sort(compareProductTimelineEvents);
}

function productProofFromStateMachine(
  order: StateMachineOrderProjection,
  trustSnapshot: TrustProjectionSnapshot
): readonly ProductChainProofDTO[] {
  const trust = planTrustForOrder(trustSnapshot, order);
  return [
    ...order.proof.map(proofFromStateMachineProof),
    ...(trust ? [proofFromPlanTrust(trust)] : [])
  ].sort(compareProductProof);
}

function productTimelineEventFromStateMachine(event: StateMachineTimelineEventProjection): ProductTimelineEventApiDTO {
  const proof = proofFromStateMachineProof(event.proof);
  return {
    eventId: event.timelineId,
    text: event.text,
    time: event.time,
    eventName: event.eventName,
    proofKind: proof.proofKind,
    blockNumber: proof.blockNumber,
    transactionHash: proof.transactionHash,
    ...(proof.submitter ? { actor: proof.submitter } : {}),
    proof
  };
}

function productTimelineEventFromPlanTrust(trust: PlanTrustProjection): ProductTimelineEventApiDTO {
  const proof = proofFromPlanTrust(trust);
  return {
    eventId: proof.eventId,
    text: trust.revoked ? "秩序背书已撤销" : "秩序背书已写入链上",
    time: `block ${proof.blockNumber}`,
    eventName: proof.eventName,
    proofKind: proof.proofKind,
    blockNumber: proof.blockNumber,
    transactionHash: proof.transactionHash,
    ...(proof.submitter ? { actor: proof.submitter } : {}),
    proof
  };
}

function productConfirmationFromStateMachineSignal(signal: StateMachineSignalProjection): ProductConfirmationDTO {
  return {
    confirmationId: `${signal.sourceId}:${signal.signalId}`,
    orderId: signal.orderId,
    sourceLabel: displayBytes32(signal.sourceId, "来源"),
    actionLabel: displayBytes32(signal.signalId, "确认动作"),
    payloadHash: signal.payloadHash,
    submitter: signal.submitter,
    submittedAt: `block ${signal.submittedAt.blockNumber.toString()}`,
    proof: proofFromStateMachineProof(signal.proof)
  };
}

function productStageExecutorOverlayFromStateMachine(
  overlay: StateMachineStageExecutorOverlayProjection
): ProductStageExecutorOverlayApiDTO {
  return {
    orderId: overlay.orderId,
    selectorStageId: overlay.selectorStageId,
    targetStageId: overlay.targetStageId,
    selectorWallet: overlay.selectorWallet,
    activeExecutorWallet: overlay.activeExecutorWallet,
    mode: overlay.mode,
    ...(overlay.modeHash ? { modeHash: overlay.modeHash } : {}),
    ...(overlay.previousExecutor ? { previousExecutor: overlay.previousExecutor } : {}),
    ...(overlay.approvalSourceId ? { approvalSourceId: overlay.approvalSourceId } : {}),
    ...(overlay.approvalSignalId ? { approvalSignalId: overlay.approvalSignalId } : {}),
    roleHash: overlay.roleHash,
    executorMetadataHash: overlay.executorMetadataHash,
    patchHash: overlay.patchHash,
    patchNonce: overlay.patchNonce,
    metadataURI: overlay.metadataURI,
    proofRows: [
      { label: "Mode", value: overlay.mode },
      { label: "Target stage", value: displayStageId(overlay.targetStageId) },
      { label: "New executor", value: overlay.activeExecutorWallet },
      { label: "Patch nonce", value: overlay.patchNonce },
      ...(overlay.previousExecutor ? [{ label: "Previous executor", value: overlay.previousExecutor }] : []),
      ...(overlay.approvalSourceId && overlay.approvalSignalId
        ? [{ label: "Approval signal", value: `${overlay.approvalSourceId}:${overlay.approvalSignalId}` }]
        : []),
      ...proofRowsFromProof(proofFromStateMachineProof(overlay.proof))
    ],
    proof: proofFromStateMachineProof(overlay.proof),
    ...(overlay.activationProof ? { activationProof: proofFromStateMachineProof(overlay.activationProof) } : {})
  };
}

function productExecutorOverlayFromStateMachine(
  overlay: StateMachineStageExecutorOverlayProjection
): ProductExecutorOverlayDTO {
  return {
    orderId: overlay.orderId,
    selectorStageId: overlay.selectorStageId,
    targetStageId: overlay.targetStageId,
    mode: overlay.mode,
    modeLabel: executorPatchModeLabel(overlay.mode),
    selectorWallet: overlay.selectorWallet,
    ...(overlay.previousExecutor ? { previousExecutor: overlay.previousExecutor, previousExecutorWallet: overlay.previousExecutor } : {}),
    activeExecutorWallet: overlay.activeExecutorWallet,
    newExecutorWallet: overlay.activeExecutorWallet,
    roleHash: overlay.roleHash,
    executorMetadataHash: overlay.executorMetadataHash,
    ...(overlay.approvalSourceId ? { approvalSourceId: overlay.approvalSourceId } : {}),
    ...(overlay.approvalSignalId ? { approvalSignalId: overlay.approvalSignalId } : {}),
    patchHash: overlay.patchHash,
    patchNonce: overlay.patchNonce,
    ...(overlay.metadataURI ? { metadataURI: overlay.metadataURI } : {}),
    proofRows: [
      { label: "Target stage", value: displayStageId(overlay.targetStageId) },
      { label: "Active executor", value: shortHex(overlay.activeExecutorWallet) },
      { label: "Patch nonce", value: overlay.patchNonce },
      ...proofRowsFromProof(proofFromStateMachineProof(overlay.activationProof ?? overlay.proof))
    ]
  };
}

function productStageResourceOverlayFromStateMachine(
  overlay: StateMachineStageResourceOverlayProjection
): ProductStageResourceOverlayApiDTO {
  return {
    orderId: overlay.orderId,
    selectorStageId: overlay.selectorStageId,
    targetStageId: overlay.targetStageId,
    resourceKey: overlay.resourceKey,
    selectorWallet: overlay.selectorWallet,
    manifestHash: overlay.manifestHash,
    policyHash: overlay.policyHash,
    patchHash: overlay.patchHash,
    patchNonce: overlay.patchNonce,
    manifestURI: overlay.manifestURI,
    proofRows: [
      { label: "Target stage", value: displayStageId(overlay.targetStageId) },
      { label: "Resource key", value: displayBytes32(overlay.resourceKey, "资源") },
      { label: "Manifest hash", value: shortHex(overlay.manifestHash) },
      { label: "Policy hash", value: shortHex(overlay.policyHash) },
      { label: "Patch nonce", value: overlay.patchNonce },
      ...proofRowsFromProof(proofFromStateMachineProof(overlay.proof))
    ],
    proof: proofFromStateMachineProof(overlay.proof)
  };
}

function productExecutorOverlaysByStage(
  order: StateMachineOrderProjection
): Readonly<Record<string, ProductExecutorOverlayDTO>> {
  return Object.fromEntries(
    Object.values(order.stageExecutorOverlays).map((overlay) => [
      displayStageId(overlay.targetStageId),
      productExecutorOverlayFromStateMachine(overlay)
    ])
  );
}

function productResourceRequirementsByStage(
  order: StateMachineOrderProjection
): Readonly<Record<string, readonly ProductResourceRequirementDTO[]>> {
  const entries = Object.values(order.stageResourceOverlays)
    .map((overlay) => displayStageId(overlay.targetStageId))
    .filter((stageId, index, stageIds) => stageIds.indexOf(stageId) === index)
    .map((stageId) => [stageId, productResourceRequirementsForStage(order, stageId)] as const)
    .filter(([, requirements]) => requirements.length > 0);
  return Object.fromEntries(entries);
}

function productResourceRequirementsForStage(
  order: StateMachineOrderProjection,
  stageIdentifier: string
): readonly ProductResourceRequirementDTO[] {
  const stageIds = new Set([
    stageIdentifier,
    stageIdentifier.toLowerCase(),
    displayStageId(stageIdentifier),
    displayStageId(stageIdentifier).toLowerCase()
  ]);
  return Object.values(order.stageResourceOverlays)
    .filter((overlay) =>
      stageIds.has(overlay.targetStageId) ||
      stageIds.has(overlay.targetStageId.toLowerCase()) ||
      stageIds.has(displayStageId(overlay.targetStageId)) ||
      stageIds.has(displayStageId(overlay.targetStageId).toLowerCase())
    )
    .sort(compareStageResourceOverlayProjections)
    .map(productResourceRequirementFromStageOverlay);
}

function productResourceRequirementFromStageOverlay(
  overlay: StateMachineStageResourceOverlayProjection
): ProductResourceRequirementDTO {
  const proof = proofFromStateMachineProof(overlay.proof);
  const resourceLabel = displayBytes32(overlay.resourceKey, "资源");
  return {
    resourceId: `${overlay.targetStageId}:${overlay.resourceKey}`,
    resourceKey: overlay.resourceKey,
    label: resourceLabel,
    required: true,
    source: "resource_patch",
    resourceType: "metadata",
    description: "链上资源补丁提供的最新 manifest 引用；资源正文保留在链下。",
    manifestURI: overlay.manifestURI,
    manifestHash: overlay.manifestHash,
    metadataURI: overlay.manifestURI,
    manifest: {
      schemaVersion: "uvp-resource-manifest-v1",
      orderId: overlay.orderId,
      targetStageId: overlay.targetStageId,
      resourceKey: overlay.resourceKey,
      visibility: "protected",
      manifestURI: overlay.manifestURI,
      manifestHash: overlay.manifestHash,
      policyHash: overlay.policyHash,
      createdBy: overlay.selectorWallet,
      createdAt: `block ${overlay.updatedAt.blockNumber.toString()}`
    },
    accessPolicy: {
      visibility: "protected",
      readers: [],
      writers: [],
      controllers: [{ kind: "wallet", label: "Selector", value: overlay.selectorWallet }],
      policyHash: overlay.policyHash
    },
    sourceStageId: displayStageId(overlay.selectorStageId),
    sourcePatchHash: overlay.patchHash,
    proofRows: [
      { label: "Resource key", value: resourceLabel },
      { label: "Manifest hash", value: shortHex(overlay.manifestHash) },
      { label: "Policy hash", value: shortHex(overlay.policyHash) },
      { label: "Patch nonce", value: overlay.patchNonce },
      ...proofRowsFromProof(proof)
    ]
  };
}

function productConditionFromStateMachineHook(hook: StateMachineHookProjection): ProductConditionDTO {
  return {
    conditionId: hook.hookId,
    stageId: displayStageId(hook.stageIdentifier ?? hook.hookId),
    stageName: displayBytes32(hook.stageIdentifier ?? hook.hookId, "阶段"),
    status: hook.status,
    statusLabel: mapHookStatusLabel(hook.status),
    ...(hook.dueAt ? { dueAt: hook.dueAt } : {}),
    proof: proofFromStateMachineProof(hook.proof)
  };
}

function productStagesFromStateMachine(order: StateMachineOrderProjection): readonly ZhixuStageDTO[] {
  const hooks = Object.values(order.hooks).sort(compareHooksByUpdate);
  if (hooks.length === 0) {
    const resourceRequirements = productResourceRequirementsForStage(order, order.orderId);
    return [
      {
        stageId: displayStageId(order.orderId),
        index: 1,
        name: "订单创建",
        evidence: ["链上订单注册"],
        ownerRole: "系统",
        status: order.status === "registered" ? "active" : "done",
        updatedAt: `区块 ${order.updatedAt.blockNumber.toString()}`,
        ...(resourceRequirements.length > 0 ? { resourceRequirements } : {})
      }
    ];
  }

  return hooks.map((hook, index) => {
    const stageIdentifier = hook.stageIdentifier ?? hook.hookId;
    const executorOverlay = order.stageExecutorOverlays[stageIdentifier.toLowerCase()];
    const resourceRequirements = productResourceRequirementsForStage(order, stageIdentifier);
    return {
      stageId: displayStageId(stageIdentifier),
      index: index + 1,
      name: displayBytes32(stageIdentifier, "阶段"),
      evidence: ["凭证指纹或链上确认"],
      ownerRole: "待分配角色",
      status: mapHookStatusToStageStatus(hook.status),
      updatedAt: `区块 ${hook.updatedAt.blockNumber.toString()}`,
      ...(executorOverlay ? { executorOverlay: productExecutorOverlayFromStateMachine(executorOverlay) } : {}),
      ...(resourceRequirements.length > 0 ? { resourceRequirements } : {})
    };
  });
}

function proofFromStateMachineProof(proof: StateMachineProofProjection): ProductChainProofDTO {
  const payloadHash = proofArgString(proof.args, "payloadHash");
  const sourceId = proofArgString(proof.args, "sourceId");
  const signalId = proofArgString(proof.args, "signalId");
  const hookId = proofArgString(proof.args, "hookId");
  const stageIdentifier = proofArgString(proof.args, "stageId");
  const selectorStageId = proofArgString(proof.args, "selectorStageId");
  const targetStageId = proofArgString(proof.args, "targetStageId");
  const resourceKey = proofArgString(proof.args, "resourceKey");
  const patchHash = proofArgString(proof.args, "patchHash");
  const patchNonce = proofArgString(proof.args, "patchNonce");
  const manifestHash = proofArgString(proof.args, "manifestHash");
  const policyHash = proofArgString(proof.args, "policyHash");
  const activeExecutorWallet = proofArgString(proof.args, "executor");
  const metadataURI = proofArgString(proof.args, "metadataURI") ?? proofArgString(proof.args, "manifestURI");

  return {
    eventId: proof.eventId,
    chainId: proof.chainId,
    contractAddress: proof.contractAddress,
    blockNumber: proof.blockNumber.toString(),
    transactionHash: proof.transactionHash,
    logIndex: proof.logIndex,
    eventName: proof.eventName,
    proofKind: proof.eventName,
    args: proof.args,
    ...(proof.blockHash ? { blockHash: proof.blockHash } : {}),
    ...(proof.orderId ? { orderId: proof.orderId } : {}),
    ...(proof.planId ? { planId: proof.planId } : {}),
    ...(proof.planHash ? { planHash: proof.planHash } : {}),
    ...(payloadHash ? { payloadHash } : {}),
    ...(sourceId ? { sourceId } : {}),
    ...(signalId ? { signalId } : {}),
    ...(hookId ? { hookId } : {}),
    ...(stageIdentifier ? { stageIdentifier } : {}),
    ...(selectorStageId ? { selectorStageId } : {}),
    ...(targetStageId ? { targetStageId } : {}),
    ...(resourceKey ? { resourceKey } : {}),
    ...(patchHash ? { patchHash } : {}),
    ...(patchNonce ? { patchNonce } : {}),
    ...(manifestHash ? { manifestHash } : {}),
    ...(policyHash ? { policyHash } : {}),
    ...(activeExecutorWallet ? { activeExecutorWallet } : {}),
    ...(metadataURI ? { metadataURI } : {}),
    ...(proof.submitter ? { submitter: proof.submitter } : {})
  };
}

function proofFromPlanTrust(trust: PlanTrustProjection): ProductChainProofDTO {
  const provenance = trust.revoked && trust.revokedAt ? trust.revokedAt : trust.updatedAt;
  return {
    eventId: `${provenance.chainId}:${provenance.contractAddress}:${provenance.blockNumber.toString()}:${provenance.transactionHash}:${provenance.logIndex}`,
    chainId: provenance.chainId,
    contractAddress: provenance.contractAddress,
    blockNumber: provenance.blockNumber.toString(),
    transactionHash: provenance.transactionHash,
    logIndex: provenance.logIndex,
    eventName: trust.revoked ? "PlanRevoked" : "PlanAttested",
    proofKind: trust.revoked ? "PlanRevoked" : "PlanAttested",
    args: {
      domainId: trust.domainId,
      planId: trust.planId,
      planHash: trust.planHash,
      artifactHash: trust.artifactHash,
      policyHash: trust.policyHash,
      metadataHash: trust.metadataHash,
      metadataURI: trust.metadataURI,
      revoked: trust.revoked,
      revokeReasonHash: trust.revokeReasonHash ?? null,
      revokeReasonURI: trust.revokeReasonURI ?? null
    },
    planId: trust.planId,
    planHash: trust.planHash,
    artifactHash: trust.artifactHash,
    metadataURI: trust.metadataURI,
    attestationTx: trust.attestedAt.transactionHash,
    submitter: trust.attester
  };
}

function proofRowsFromProof(proof: ProductChainProofDTO | undefined): readonly ChainProofRowDTO[] {
  if (!proof) {
    return [{ label: "链上证明", value: "等待链上事件同步" }];
  }
  return [
    { label: "交易编号", value: proof.transactionHash ? shortHex(proof.transactionHash) : "未上链" },
    { label: "区块高度", value: proof.blockNumber || "未同步" },
    { label: "链上事件", value: proof.eventName },
    ...(proof.targetStageId ? [{ label: "Target stage", value: displayStageId(proof.targetStageId) }] : []),
    ...(proof.patchNonce ? [{ label: "Patch nonce", value: proof.patchNonce }] : []),
    ...(proof.manifestHash ? [{ label: "Manifest hash", value: shortHex(proof.manifestHash) }] : []),
    ...(proof.policyHash ? [{ label: "Policy hash", value: shortHex(proof.policyHash) }] : []),
    ...(proof.activeExecutorWallet ? [{ label: "Active executor", value: shortHex(proof.activeExecutorWallet) }] : []),
    ...(proof.submitter ? [{ label: "提交人", value: shortHex(proof.submitter) }] : [])
  ];
}

function proofArgString(args: EventProofArgs, name: string): string | undefined {
  const value = args[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function planTrustForOrder(
  trustSnapshot: TrustProjectionSnapshot,
  order: StateMachineOrderProjection
): PlanTrustProjection | undefined {
  return Object.values(trustSnapshot.plans).find((plan) =>
    plan.planId === order.planId && (!order.planHash || plan.planHash === order.planHash)
  );
}

function supplierTrustForWallet(
  trustSnapshot: TrustProjectionSnapshot,
  wallet: string
): SupplierTrustProjection | undefined {
  const normalizedWallet = wallet.toLowerCase();
  return Object.values(trustSnapshot.suppliers)
    .filter((supplier) => supplier.wallet.toLowerCase() === normalizedWallet)
    .sort(compareSupplierTrustForProductTask)[0];
}

function supplierBlockedReasonForTask(
  taskStatus: StateMachineTaskStatus,
  supplierTrust: SupplierTrustProjection | undefined
): string | undefined {
  if (taskStatus !== "ready" || !supplierTrust?.revoked) {
    return undefined;
  }
  return "供应商链上背书已撤销；该钱包仍可能是订单授权地址，但 Product API 不允许继续提交业务动作。";
}

function supplierProofRowsForTask(
  supplierTrust: SupplierTrustProjection | undefined,
  wallet: string | undefined
): readonly ChainProofRowDTO[] {
  if (!wallet) {
    return [];
  }
  if (!supplierTrust) {
    return [
      { label: "Supplier trust", value: "not_found" },
      { label: "Supplier wallet", value: wallet }
    ];
  }

  const provenance = supplierTrust.revoked && supplierTrust.revokedAt
    ? supplierTrust.revokedAt
    : supplierTrust.updatedAt;
  return [
    { label: "Supplier trust", value: supplierTrust.status },
    { label: "Supplier subject", value: supplierTrust.supplierSubjectId },
    { label: "Supplier domain", value: supplierTrust.domainId },
    { label: "Supplier wallet", value: supplierTrust.wallet },
    { label: "Supplier trust event", value: supplierTrust.revoked ? "SupplierRevoked" : "SupplierAttested" },
    { label: "Supplier trust tx", value: provenance.transactionHash },
    { label: "Supplier trust block", value: provenance.blockNumber.toString() },
    ...(supplierTrust.revokeReasonURI ? [{ label: "Supplier revoke reason", value: supplierTrust.revokeReasonURI }] : [])
  ];
}

function compareSupplierTrustForProductTask(left: SupplierTrustProjection, right: SupplierTrustProjection): number {
  if (left.revoked !== right.revoked) {
    return left.revoked ? -1 : 1;
  }
  if (left.updatedAt.blockNumber !== right.updatedAt.blockNumber) {
    return left.updatedAt.blockNumber > right.updatedAt.blockNumber ? -1 : 1;
  }
  return left.supplierSubjectId.localeCompare(right.supplierSubjectId);
}

function displayAssigneeRole(role: string): string {
  switch (role) {
    case "unknown":
      return "待分配角色";
    case "authorized_submitter":
      return "链上授权执行方";
    case "stage_overlay_executor":
      return "订单指定执行方";
    default:
      return role;
  }
}

function executorPatchModeLabel(mode: StateMachineStageExecutorOverlayProjection["mode"]): string {
  switch (mode) {
    case "assign":
      return "指派执行方";
    case "handoff":
      return "执行方交接";
    case "replacement":
      return "替换执行方";
  }
}

function paymentConditionSummaryFromStateMachine(order: StateMachineOrderProjection): string {
  const hooks = Object.values(order.hooks);
  if (hooks.length === 0) {
    return "付款条件尚未产生链上 hook 状态";
  }

  const ready = hooks.filter((hook) => hook.status === "ready").length;
  const waiting = hooks.filter((hook) => hook.status === "waiting").length;
  const cancelled = hooks.filter((hook) => hook.status === "cancelled").length;
  return `条件 ${hooks.length} 个：${ready} 个已满足，${waiting} 个等待时间条件，${cancelled} 个已取消`;
}

function zhixuIdForPlan(order: StateMachineOrderProjection): string {
  return order.planId === crossBorderPlanIds.planId ||
    (order.planHash !== undefined && order.planHash === crossBorderPlanIds.planHash)
    ? CROSS_BORDER_ZHIXU_ID
    : `plan-${shortId(order.planId)}`;
}

function zhixuIdFromPlanTrust(trust: PlanTrustProjection): string {
  return trust.planId === crossBorderPlanIds.planId && trust.planHash === crossBorderPlanIds.planHash
    ? CROSS_BORDER_ZHIXU_ID
    : `plan-${shortId(trust.planId)}`;
}

function planKey(planId: string, planHash: string): string {
  return `${planId}:${planHash}`;
}

function isActiveOfficialPlanTrust(trust: PlanTrustProjection): boolean {
  return trust.domainId === DEFAULT_OFFICIAL_DOMAIN_ID && trust.status === "attested" && !trust.revoked;
}

function matchesTaskQuery(task: ProductTaskDTO, query: ProductTaskQuery): boolean {
  const assigneeQuery = query.assignee?.toLowerCase();
  return (!query.orderId || task.orderId === query.orderId) &&
    (!assigneeQuery ||
      task.assigneeRole === query.assignee ||
      task.assigneeWallet?.toLowerCase() === assigneeQuery) &&
    (!query.status || taskStatusMatchesQuery(task.status, query.status));
}

function taskStatusMatchesQuery(status: ProductTaskDTO["status"], queryStatus: string): boolean {
  return status === queryStatus ||
    (queryStatus === "ready" && status === "open") ||
    (queryStatus === "cancelled" && status === "blocked");
}

function mapStateMachineOrderStatus(status: StateMachineOrderStatus): ProductOrderDTO["status"] {
  switch (status) {
    case "registered":
      return "pending_participants";
    case "running":
    case "waiting":
    case "action_required":
      return "active";
    case "completed":
      return "completed";
    case "cancelled":
      return "in_dispute";
    case "unknown":
      return "draft";
  }
}

function mapStateMachineOrderStatusLabel(status: StateMachineOrderStatus): string {
  switch (status) {
    case "registered":
      return "已创建";
    case "running":
      return "进行中";
    case "waiting":
      return "等待时间条件";
    case "action_required":
      return "待处理";
    case "completed":
      return "已完成";
    case "cancelled":
      return "已取消";
    case "unknown":
      return "同步中";
  }
}

function mapStateMachineTaskStatus(status: StateMachineTaskStatus): ProductTaskDTO["status"] {
  switch (status) {
    case "ready":
      return "open";
    case "submitted":
      return "submitted";
    case "cancelled":
    case "unknown":
      return "blocked";
  }
}

function mapHookStatusLabel(status: StateMachineHookProjection["status"]): string {
  switch (status) {
    case "init":
      return "等待确认";
    case "waiting":
      return "等待时间条件";
    case "ready":
      return "条件满足";
    case "cancelled":
      return "条件已取消";
    case "unknown":
      return "同步中";
  }
}

function mapHookStatusToStageStatus(status: StateMachineHookProjection["status"]): ZhixuStageDTO["status"] {
  switch (status) {
    case "ready":
      return "active";
    case "cancelled":
      return "pending";
    case "init":
    case "waiting":
    case "unknown":
      return "pending";
  }
}

function projectionMetadataFromStateMachineOrder(
  order: StateMachineOrderProjection,
  syncState?: ProjectionSyncState
): ProductProjectionMetadataDTO {
  const lastProof = order.proof[order.proof.length - 1];
  return {
    source: "chain_projection",
    syncStatus: syncState?.syncStatus ?? "indexed",
    chainId: order.chainId,
    contractAddress: order.contractAddress,
    updatedAtBlock: order.updatedAt.blockNumber.toString(),
    ...(lastProof ? { lastEventName: lastProof.eventName } : {}),
    eventCount: order.proof.length,
    ...projectionSyncMetadata(syncState)
  };
}

function projectionMetadataFromStateMachineTask(
  task: StateMachineTaskProjection,
  syncState?: ProjectionSyncState
): ProductProjectionMetadataDTO {
  return {
    source: "chain_projection",
    syncStatus: syncState?.syncStatus ?? "indexed",
    chainId: task.proof.chainId,
    contractAddress: task.proof.contractAddress,
    updatedAtBlock: task.updatedAt.blockNumber.toString(),
    lastEventName: task.proof.eventName,
    eventCount: 1,
    ...projectionSyncMetadata(syncState)
  };
}

function projectionSyncMetadata(syncState: ProjectionSyncState | undefined): Partial<ProductProjectionMetadataDTO> {
  if (!syncState) {
    return {};
  }
  return {
    ...(syncState.latestIndexedBlock !== undefined ? { latestIndexedBlock: syncState.latestIndexedBlock.toString() } : {}),
    ...(syncState.finalizedBlock !== undefined ? { finalizedBlock: syncState.finalizedBlock.toString() } : {}),
    confirmationDepth: syncState.confirmationDepth,
    ...(syncState.lastEventName ? { lastEventName: syncState.lastEventName } : {}),
    eventCount: syncState.eventCount,
    ...(syncState.rebuild?.status ? { rebuildStatus: syncState.rebuild.status } : {}),
    ...(syncState.degradedReason ? { degradedReason: syncState.degradedReason } : {})
  };
}

function compareHooksByUpdate(left: StateMachineHookProjection, right: StateMachineHookProjection): number {
  return compareProvenance(left.updatedAt, right.updatedAt);
}

function compareStageResourceOverlays(
  left: ProductStageResourceOverlayApiDTO,
  right: ProductStageResourceOverlayApiDTO
): number {
  return left.resourceKey.localeCompare(right.resourceKey) || compareProductProof(left.proof, right.proof);
}

function compareStageResourceOverlayProjections(
  left: StateMachineStageResourceOverlayProjection,
  right: StateMachineStageResourceOverlayProjection
): number {
  return left.resourceKey.localeCompare(right.resourceKey) || compareProvenance(left.updatedAt, right.updatedAt);
}

function compareProductTimelineEvents(left: ProductTimelineEventApiDTO, right: ProductTimelineEventApiDTO): number {
  return compareProductProof(left.proof, right.proof);
}

function compareProductProof(left: ProductChainProofDTO, right: ProductChainProofDTO): number {
  if (left.chainId !== right.chainId) {
    return left.chainId - right.chainId;
  }
  const blockCompare = compareNumericStrings(left.blockNumber, right.blockNumber);
  if (blockCompare !== 0) {
    return blockCompare;
  }
  if (left.logIndex !== right.logIndex) {
    return left.logIndex - right.logIndex;
  }
  return left.eventId.localeCompare(right.eventId);
}

function compareProvenance(left: ProjectionProvenance, right: ProjectionProvenance): number {
  if (left.chainId !== right.chainId) {
    return left.chainId - right.chainId;
  }
  if (left.blockNumber !== right.blockNumber) {
    return left.blockNumber < right.blockNumber ? -1 : 1;
  }
  if (left.logIndex !== right.logIndex) {
    return left.logIndex - right.logIndex;
  }
  return left.transactionHash.localeCompare(right.transactionHash);
}

function compareNumericStrings(left: string, right: string): number {
  if (!/^\d+$/.test(left) || !/^\d+$/.test(right)) {
    return left.localeCompare(right);
  }
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue === rightValue ? 0 : leftValue < rightValue ? -1 : 1;
}

function displayStageId(value: string): string {
  return decodeBytes32Text(value) ?? value;
}

function displayBytes32(value: string | undefined, fallback: string): string {
  if (!value) {
    return fallback;
  }
  return decodeBytes32Text(value) ?? `${fallback} ${shortHex(value)}`;
}

function decodeBytes32Text(value: string): string | undefined {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    return undefined;
  }
  const hex = value.slice(2).replace(/(00)+$/, "");
  if (hex.length === 0 || hex.length % 2 !== 0) {
    return undefined;
  }
  const text = Buffer.from(hex, "hex").toString("utf8");
  return /^[\x20-\x7E]+$/.test(text) ? text : undefined;
}

function enrichZhixuTrust(zhixu: ZhixuDetailDTO, trustSnapshot: TrustProjectionSnapshot): ZhixuDetailDTO {
  const trust = findPlanTrust(trustSnapshot, zhixu.chainAttestation);
  const chainAttestation = trust ? chainAttestationFromTrust(zhixu.chainAttestation, trust) : zhixu.chainAttestation;
  const reviewStatus = chainAttestation.status === "revoked" ? "revoked" : zhixu.reviewStatus;
  const reviewLabel = chainAttestation.status === "revoked" ? "链上背书已撤销" : zhixu.reviewLabel;
  const proofRows = [
    ...zhixu.proofRows.filter((row) => row.label !== "背书状态"),
    { label: "背书状态", value: chainAttestation.label },
    ...(chainAttestation.txHash ? [{ label: "背书交易", value: shortHex(chainAttestation.txHash) }] : []),
    ...(chainAttestation.blockNumber ? [{ label: "背书区块", value: chainAttestation.blockNumber }] : [])
  ];

  return {
    ...zhixu,
    reviewStatus,
    reviewLabel,
    chainAttestation,
    proofRows
  };
}

function isListedOfficialZhixu(zhixu: ZhixuDetailDTO): boolean {
  return zhixu.reviewStatus === "approved" && zhixu.chainAttestation.status === "attested";
}

function findPlanTrust(
  trustSnapshot: TrustProjectionSnapshot,
  attestation: ChainAttestationDTO
): PlanTrustProjection | undefined {
  return Object.values(trustSnapshot.plans).find((plan) =>
    plan.domainId === DEFAULT_OFFICIAL_DOMAIN_ID &&
    plan.planId === attestation.planId &&
    plan.planHash === attestation.planHash
  );
}

function zhixuDetailFromPlanTrust(trust: PlanTrustProjection): ZhixuDetailDTO {
  const chainAttestation = chainAttestationFromTrust(
    {
      status: "not_found",
      label: "等待链上背书同步",
      domainLabel: "共同秩序官方审核",
      planId: trust.planId,
      planHash: trust.planHash,
      artifactHash: trust.artifactHash
    },
    trust
  );
  const zhixuId = zhixuIdFromPlanTrust(trust);

  return {
    zhixuId,
    title: `链上秩序 ${shortId(trust.planId)}`,
    subtitle: "该秩序来自官方域链上背书；UI schema 尚未接入，当前展示基础链上信息。",
    reviewStatus: trust.revoked ? "revoked" : "approved",
    reviewLabel: trust.revoked ? "链上背书已撤销" : "已由官方域链上背书",
    riskLevel: "待补充",
    applicableBusiness: [],
    excludedBusiness: [],
    stageCount: 0,
    roleSlotCount: 0,
    supportedPaymentMethods: [],
    maintainer: "共同秩序官方域",
    updatedAt: `block ${trust.updatedAt.blockNumber.toString()}`,
    chainAttestation,
    roleSlots: [],
    dockableModules: [],
    stages: [],
    orderPermissionTable: [],
    proofRows: [
      { label: "秩序编号", value: zhixuId },
      { label: "审核域", value: "共同秩序官方审核" },
      { label: "秩序指纹", value: shortHex(trust.planHash) },
      { label: "背书状态", value: chainAttestation.label },
      { label: "背书交易", value: shortHex(chainAttestation.txHash ?? "") },
      { label: "背书区块", value: chainAttestation.blockNumber ?? "" }
    ].filter((row) => row.value.length > 0),
    createOrderHint: "该秩序缺少 Product UI schema，创建订单前需要补齐角色和阶段定义。"
  };
}

function chainAttestationFromTrust(base: ChainAttestationDTO, trust: PlanTrustProjection): ChainAttestationDTO {
  return {
    ...base,
    status: trust.status,
    label: trust.status === "revoked" ? "已撤销链上背书" : "已写入链上背书",
    artifactHash: trust.artifactHash,
    metadataURI: trust.metadataURI,
    txHash: trust.updatedAt.transactionHash,
    blockNumber: trust.updatedAt.blockNumber.toString(),
    ...(trust.revokeReasonURI ? { revokedReasonURI: trust.revokeReasonURI } : {})
  };
}

function shortHex(value: string): string {
  return value.length > 18 ? `${value.slice(0, 8)}...${value.slice(-8)}` : value;
}

function shortId(value: string): string {
  return value.length > 16 ? `${value.slice(0, 8)}...${value.slice(-6)}` : value;
}
