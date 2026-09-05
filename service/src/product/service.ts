import {
  summarizeZhixu,
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
  type ZhixuSummaryDTO,
} from "@uvp-eth/product-dto";
import { keccak256, stringToBytes, type Hex } from "viem";
import type {
  EventProofArgs,
  ProjectionSnapshot,
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
  StateMachineTimelineEventProjection,
} from "../indexer/projections.js";
import { stateMachineOrderProjectionKey } from "../indexer/projections.js";
import type {
  ProjectionStore,
  ProjectionSyncState,
} from "../storage/projection-store.js";
import { compareChainPointers } from "../shared/types.js";

export interface ProductChainProofDTO {
  readonly eventId: string;
  readonly chainId: number;
  readonly contractAddress: string;
  readonly blockNumber: string;
  readonly transactionIndex?: number;
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
  readonly source: "chain_projection";
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

/**
 * 订单读面的投影完整性。协议包 OrderStatus 是冻结的单值类型（忠实于合约
 * 词表），"store 行已建但 OrderRegistered 事件尚未投影"的中间态由本字段
 * 诚实表达，避免读面看起来"一切正常已注册"：
 * - "projected"：OrderRegistered 事件已投影（registeredAt 在场）；
 * - "pending"：订单行已被其他事件建出，但注册投影尚未到达（最终一致
 *   窗口，不是错误——因此用字段而不是 404/错误码表达）。
 */
export type ProductOrderProjectionStatus = "projected" | "pending";

export type ProductOrderApiDTO = ProductOrderDTO & {
  readonly planId?: string;
  readonly planHash?: string;
  readonly chainStatus?: StateMachineOrderStatus;
  readonly projectionStatus?: ProductOrderProjectionStatus;
  readonly paymentConditionSummary?: string;
  readonly tasks?: readonly ProductTaskApiDTO[];
  readonly stageExecutorOverlays?: Readonly<
    Record<string, ProductStageExecutorOverlayApiDTO>
  >;
  readonly stageResourceOverlays?: Readonly<
    Record<string, ProductStageResourceOverlayApiDTO>
  >;
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

export interface ProductService {
  listZhixu(): Promise<readonly ZhixuSummaryDTO[]>;
  getZhixu(zhixuId: string): Promise<ZhixuDetailDTO | undefined>;
  listOrders(): Promise<readonly ProductOrderApiDTO[]>;
  getOrder(orderId: string): Promise<ProductOrderApiDTO | undefined>;
  listOrderTimeline(
    orderId: string,
  ): Promise<readonly ProductTimelineEventApiDTO[] | undefined>;
  listOrderProof(
    orderId: string,
  ): Promise<readonly ProductChainProofDTO[] | undefined>;
  listTasks(query?: ProductTaskQuery): Promise<readonly ProductTaskApiDTO[]>;
  getTask(taskId: string): Promise<ProductTaskApiDTO | undefined>;
  getParticipantView(
    query?: ProductParticipantViewQuery,
  ): Promise<ProductParticipantView>;
  getActiveStateMachineDeployment(): Promise<
    | { readonly deploymentId: string; readonly stateMachineAddress: string }
    | undefined
  >;
}

export interface ProductSchemaResolver {
  getProductSchemaByPlan(
    planId: string,
    planHash: string,
    artifactHash?: string,
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
    readonly details: unknown,
  ) {
    super(message);
  }
}

/**
 * Resolves a Product order through the same deployment-aware boundary for
 * detail, timeline, and proof reads. A bare order id is not an identity when
 * several state-machine deployments contain it.
 */
async function resolveProductOrder(
  store: ProjectionStore,
  orderId: string,
): Promise<StateMachineOrderProjection | undefined> {
  const matches = await store.findStateMachineOrdersByOrderId(orderId);
  if (matches.length > 1 && !orderId.includes(":")) {
    throw new ProductOrderLookupError(
      "ambiguous_order_id",
      "order id exists on multiple state machine deployments",
      {
        orderId,
        candidates: matches.map((order) => ({
          chainId: order.chainId,
          stateMachineAddress: order.contractAddress,
          deploymentId: order.deploymentId ?? null,
        })),
      },
    );
  }
  return matches[0] ?? store.getStateMachineOrder(orderId);
}

export function createProductService(
  store: ProjectionStore,
  options: ProductServiceOptions = {},
): ProductService {
  const productSchemaResolver = options.productSchemaResolver;
  return {
    async listZhixu() {
      const snapshot = await store.getOrderSnapshot();
      const rows = await Promise.all(
        Object.values(snapshot.stateMachinePlans).map(async (plan) => {
          const schema = await explicitStoreSchemaForPlan(plan, productSchemaResolver);
          const detail = schema ? zhixuDetailFromProductSchema(schema) : zhixuDetailFromPlan(plan);
          return summarizeZhixu(overlayPlanPublication(detail, plan));
        }),
      );
      return rows.sort((left, right) => left.zhixuId.localeCompare(right.zhixuId));
    },

    async getZhixu(zhixuId) {
      const snapshot = await store.getOrderSnapshot();
      for (const plan of Object.values(snapshot.stateMachinePlans)) {
        const schema = await explicitStoreSchemaForPlan(plan, productSchemaResolver);
        const candidateZhixuId = schema?.zhixuId ?? zhixuIdFromPlanId(plan.planId);
        if (candidateZhixuId === zhixuId) {
          const detail = schema ? zhixuDetailFromProductSchema(schema) : zhixuDetailFromPlan(plan);
          return overlayPlanPublication(detail, plan);
        }
      }
      return undefined;
    },

    async listOrders() {
      const syncState = await store.getSyncState();
      const stateMachineOrders = await store.listStateMachineOrders();
      if (stateMachineOrders.length > 0) {
        return await Promise.all(
          stateMachineOrders.map((order) =>
            productOrderFromStateMachine(
              order,
              syncState,
              productSchemaResolver,
            ),
          ),
        );
      }

      return [];
    },

    async getOrder(orderId) {
      const syncState = await store.getSyncState();
      const stateMachineOrder = await resolveProductOrder(store, orderId);
      if (stateMachineOrder) {
        return await productOrderFromStateMachine(
          stateMachineOrder,
          syncState,
          productSchemaResolver,
        );
      }

      return undefined;
    },

    async listOrderTimeline(orderId) {
      const order = await resolveProductOrder(store, orderId);
      if (!order) {
        return undefined;
      }
      return productTimelineFromStateMachine(order);
    },

    async listOrderProof(orderId) {
      const order = await resolveProductOrder(store, orderId);
      if (!order) {
        return undefined;
      }
      return productProofFromStateMachine(order);
    },

    async listTasks(query = {}) {
      const syncState = await store.getSyncState();
      const orders = await store.listStateMachineOrders();
      const stateMachineTasks = await store.listStateMachineTasks();
      const tasks = await Promise.all(
        stateMachineTasks.map((task) =>
          productTaskFromStateMachineTask(
            task,
            findStateMachineOrderForTask(orders, task),
            syncState,
            productSchemaResolver,
          ),
        ),
      );
      return tasks.filter((task) => matchesTaskQuery(task, query));
    },

    async getTask(taskId) {
      const syncState = await store.getSyncState();
      const stateMachineTask = await store.getStateMachineTask(taskId);
      if (stateMachineTask) {
        const order = findStateMachineOrderForTask(
          await store.listStateMachineOrders(),
          stateMachineTask,
        );
        return await productTaskFromStateMachineTask(
          stateMachineTask,
          order,
          syncState,
          productSchemaResolver,
        );
      }
      return undefined;
    },

    async getParticipantView(query = {}) {
      const walletAddress = query.walletAddress?.toLowerCase();
      const acceptedParticipants = walletAddress
        ? (query.acceptedParticipants ?? []).filter(
            (participant) =>
              participant.walletAddress.toLowerCase() === walletAddress,
          )
        : [];
      const syncState = await store.getSyncState();
      const orders = await store.listStateMachineOrders();
      const taskRows = await Promise.all(
        (await store.listStateMachineTasks()).map(async (task) => ({
          task,
          order: findStateMachineOrderForTask(orders, task),
          dto: await productTaskFromStateMachineTask(
            task,
            findStateMachineOrderForTask(orders, task),
            syncState,
            productSchemaResolver,
          ),
        })),
      );
      const visibleTaskRows = taskRows.filter(({ dto }) =>
        matchesTaskQuery(dto, walletAddress ? { assignee: walletAddress } : {}),
      );
      const tasks = walletAddress
        ? visibleTaskRows
            .filter(({ dto }) => dto.assigneeWallet?.toLowerCase() === walletAddress)
            .map(({ dto }) => dto)
        : [];
      const visibleOrderKeys = new Set<string>();
      for (const { task, order } of visibleTaskRows) {
        if (walletAddress && task.assigneeWallet?.toLowerCase() === walletAddress && order) {
          visibleOrderKeys.add(stateMachineOrderProjectionKey(
            order.chainId,
            order.contractAddress,
            order.planId,
            order.orderId,
          ));
        }
      }
      for (const participant of acceptedParticipants) {
        if (!participant.orderId) {
          continue;
        }
        const matchingOrders = orders.filter((order) =>
          orderIdentifierMatches(order, participant.orderId!),
        );
        // A bare order id is intentionally not enough to expose one of two
        // plans.  The accepted participant record must carry a canonical key
        // in that case, otherwise no order is returned.
        if (matchingOrders.length === 1) {
          const order = matchingOrders[0];
          if (!order) {
            continue;
          }
          visibleOrderKeys.add(stateMachineOrderProjectionKey(
            order.chainId,
            order.contractAddress,
            order.planId,
            order.orderId,
          ));
        }
      }
      const visibleOrders = await Promise.all(
        orders
          .filter((order) => visibleOrderKeys.has(stateMachineOrderProjectionKey(
            order.chainId,
            order.contractAddress,
            order.planId,
            order.orderId,
          )))
          .map((order) =>
            productOrderFromStateMachine(
              order,
              syncState,
              productSchemaResolver,
            ),
          ),
      );
      const primaryParticipant = acceptedParticipants[0];
      return {
        participant: {
          participantId:
            primaryParticipant?.participantId ??
            (walletAddress ? `wallet:${walletAddress}` : "anonymous"),
          displayName:
            primaryParticipant?.displayName ??
            (walletAddress ? `钱包 ${shortHex(walletAddress)}` : "未连接钱包"),
          ...(query.walletAddress
            ? { walletAddress: query.walletAddress }
            : {}),
          roleLabels: Array.from(
            new Set([
              ...acceptedParticipants.map(
                (participant) => participant.roleLabel,
              ),
              ...tasks.map(
                (task) => task.participantRoleLabel ?? task.assigneeRole,
              ),
            ]),
          ).sort(),
          source: primaryParticipant
            ? "accepted_participant"
            : walletAddress
              ? "wallet"
              : "anonymous",
        },
        orders: visibleOrders,
        tasks,
      };
    },

    async getActiveStateMachineDeployment() {
      const snapshot = await store.getOrderSnapshot?.();
      const activeDeploymentId = snapshot?.activeStateMachineDeploymentId;
      if (!snapshot || !activeDeploymentId) {
        return undefined;
      }
      const deployment = Object.values(snapshot.stateMachineDeployments).find(
        (item) => item.deploymentId === activeDeploymentId,
      );
      return deployment
        ? {
            deploymentId: deployment.deploymentId,
            stateMachineAddress: deployment.stateMachineAddress,
          }
        : undefined;
    },
  };
}

function zhixuDetailFromPlan(
  plan: ProjectionSnapshot["stateMachinePlans"][string],
): ZhixuDetailDTO {
  const zhixuId = zhixuIdFromPlanId(plan.planId);
  return {
    zhixuId,
    title: `链上秩序 ${shortId(plan.planId)}`,
    subtitle:
      "该秩序由链上 Plan 事件重建；业务 schema 未在 Store 登记前不提供阶段与角色解释。",
    reviewStatus: "unreviewed",
    reviewLabel: "Store 审核未登记",
    riskLevel: "以 Store 审核记录为准",
    applicableBusiness: [],
    excludedBusiness: [],
    stageCount: 0,
    roleSlotCount: 0,
    supportedPaymentMethods: [],
    maintainer: plan.publisher ?? "未登记",
    updatedAt: `block ${plan.updatedAt.blockNumber.toString()}`,
    planPublication: {
      status: "published",
      label: "Plan 已发布",
      stateMachineLabel: plan.stateMachineAddress,
      planId: plan.planId,
      planHash: plan.planHash,
      txHash: plan.proof.transactionHash,
      blockNumber: plan.proof.blockNumber.toString(),
      ...(plan.publisher ? { publisher: plan.publisher } : {}),
    },
    roleSlots: [],
    dockableModules: [],
    stages: [],
    orderPermissionTable: [],
    proofRows: proofRowsFromProof(proofFromStateMachineProof(plan.proof)),
    createOrderHint:
      "订单创建必须使用链上 planId/planHash，并由 Product API 按该 schema 解释普通用户任务。",
  };
}

async function productOrderFromStateMachine(
  order: StateMachineOrderProjection,
  syncState?: ProjectionSyncState,
  productSchemaResolver?: ProductSchemaResolver,
): Promise<ProductOrderApiDTO> {
  const tasks = await Promise.all(
    Object.values(order.tasks).map((task) =>
      productTaskFromStateMachineTask(
        task,
        order,
        syncState,
        productSchemaResolver,
      ),
    ),
  );
  const timeline = productTimelineFromStateMachine(order);
  const proof = productProofFromStateMachine(order);
  const activeTask = tasks.find((task) => task.status === "open") ?? tasks[0];
  const stages = productStagesFromStateMachine(order);
  const executorOverlays = productExecutorOverlaysByStage(order);
  const resourceRequirements = productResourceRequirementsByStage(order);
  const currentStageId = displayStageId(
    order.currentStage ??
      activeTask?.stageId ??
      stages[0]?.stageId ??
      order.orderId,
  );
  const currentStageName =
    activeTask?.stageName ??
    stages.find((stage) => stage.stageId === currentStageId)?.name ??
    displayBytes32(order.currentStage, "当前阶段");
  const orderZhixuId = await zhixuIdForOrderProjection(order, productSchemaResolver);
  const projected = orderProjectionComplete(order);

  return {
    orderId: order.orderId,
    stateMachineAddress: order.contractAddress,
    ...(order.deploymentId ? { deploymentId: order.deploymentId } : {}),
    zhixuId: orderZhixuId,
    title: `链上订单 ${shortId(order.orderId)}`,
    status: mapStateMachineOrderStatus(order.status),
    statusLabel: orderProjectionStatusLabel(order.status, projected),
    projectionStatus: projected ? "projected" : "pending",
    totalAmount: {
      amount: "0",
      currency: "N/A",
      display: "未接入资金托管",
    },
    fundingStatus: "资金托管未接入本接口",
    currentStageId,
    currentStageName,
    ...(activeTask ? { currentTaskId: activeTask.taskId } : {}),
    currentTaskTitle: activeTask?.title ?? "等待下一步链上确认",
    currentTaskSummary: activeTask?.subtitle ?? "订单已从状态机事件重建",
    stages,
    ...(Object.keys(executorOverlays).length > 0 ? { executorOverlays } : {}),
    ...(Object.keys(resourceRequirements).length > 0
      ? { resourceRequirements }
      : {}),
    participants: [],
    recentEvents: timeline
      .slice(-3)
      .reverse()
      .map(({ eventId, text, time }) => ({ eventId, text, time })),
    proofRows: proofRowsFromProof(proof[proof.length - 1]),
    planId: order.planId,
    ...(order.planHash ? { planHash: order.planHash } : {}),
    chainStatus: order.status,
    paymentConditionSummary: paymentConditionSummaryFromStateMachine(order),
    tasks,
    stageExecutorOverlays: Object.fromEntries(
      Object.entries(order.stageExecutorOverlays).map(([stageId, overlay]) => [
        stageId,
        productStageExecutorOverlayFromStateMachine(overlay),
      ]),
    ),
    stageResourceOverlays: Object.fromEntries(
      Object.entries(order.stageResourceOverlays).map(
        ([resourceOverlayId, overlay]) => [
          resourceOverlayId,
          productStageResourceOverlayFromStateMachine(overlay),
        ],
      ),
    ),
    confirmations: Object.values(order.signals).map(
      productConfirmationFromStateMachineSignal,
    ),
    conditions: Object.values(order.hooks).map(
      productConditionFromStateMachineHook,
    ),
    timeline,
    proof,
    projection: projectionMetadataFromStateMachineOrder(order, syncState),
  };
}

function findStateMachineOrderForTask(
  orders: readonly StateMachineOrderProjection[],
  task: StateMachineTaskProjection,
): StateMachineOrderProjection | undefined {
  const matches = orders.filter(
    (order) =>
      order.chainId === task.proof.chainId &&
      order.orderId.toLowerCase() === task.orderId.toLowerCase() &&
      order.contractAddress.toLowerCase() === task.stateMachineAddress.toLowerCase() &&
      (!task.planId || order.planId.toLowerCase() === task.planId.toLowerCase()) &&
      Object.prototype.hasOwnProperty.call(order.tasks, task.taskId),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function orderIdentifierMatches(
  order: StateMachineOrderProjection,
  identifier: string,
): boolean {
  if (order.orderId.toLowerCase() === identifier.toLowerCase()) {
    return true;
  }
  return stateMachineOrderProjectionKey(
    order.chainId,
    order.contractAddress,
    order.planId,
    order.orderId,
  ).toLowerCase() === identifier.toLowerCase() ||
    `${order.chainId}:${order.contractAddress.toLowerCase()}:${order.orderId.toLowerCase()}` === identifier.toLowerCase();
}

async function productTaskFromStateMachineTask(
  task: StateMachineTaskProjection,
  order?: StateMachineOrderProjection,
  syncState?: ProjectionSyncState,
  productSchemaResolver?: ProductSchemaResolver,
): Promise<ProductTaskApiDTO> {
  const decodedStageId = displayStageId(task.stageIdentifier);
  const stageName = displayBytes32(task.stageIdentifier, "阶段");
  const hookLabel = displayBytes32(task.hookName, "链上待办");
  const orderTitle = order
    ? `链上订单 ${shortId(order.orderId)}`
    : `链上订单 ${shortId(task.orderId)}`;
  const baseProof = proofWithTaskSubmitSignal(
    proofFromStateMachineProof(task.proof),
    task,
  );
  const capabilityResolution = await resolveTaskCapabilityPlugin(
    task,
    order,
    productSchemaResolver,
  );
  const proof = proofWithCapabilitySubmitSignal(
    baseProof,
    capabilityResolution,
  );
  const productStage = await resolveProductStageForTask(
    task,
    order,
    productSchemaResolver,
  );
  const stageId = productStage?.stageId ?? decodedStageId;
  const taskAddOnManifest =
    capabilityResolution?.addOnManifest ??
    (await resolveAddOnManifestForTask(
      task,
      order,
      productSchemaResolver,
      productStage?.addOnKind,
    ));
  const stageExecutorOverlay =
    order?.stageExecutorOverlays[task.stageIdentifier.toLowerCase()];
  const effectiveAssigneeWallet =
    stageExecutorOverlay?.activeExecutorWallet ??
    capabilityResolution?.submitterWallet ??
    task.assigneeWallet;
  const pluginKind = capabilityResolution?.capabilityPlugin.pluginKind;
  const requiredEvidence = capabilityResolution
    ? requiredEvidenceForCapability(capabilityResolution.capabilityPlugin)
    : (productStage?.evidence ?? []);
  // evidenceSpec：发布者携带的结构化证据要求（productDto.v1 可选字段）。
  // schema 是不透明 JSON，按结构化读取逐字段透传，缺失时缺省（消费方
  // 降级为通用证据槽位），不参与鉴权或状态判定。
  const evidenceSpec = evidenceSpecFromStage(productStage);
  const requiredInputs = capabilityResolution
    ? requiredInputsForCapability(
        capabilityResolution.capabilityPlugin,
        task.status === "submitted",
      )
    : undefined;
  const hasGenericAddOn = Boolean(productStage?.addOnKind ?? taskAddOnManifest);
  const productAddOnKind =
    productStage?.addOnKind ?? taskAddOnManifest?.addOnKind;
  const capabilityBacked = Boolean(capabilityResolution) || hasGenericAddOn;
  const baseProductStatus = capabilityBacked
    ? mapStateMachineTaskStatus(task.status)
    : ("blocked" as const);
  const protocolBlockedReason = blockedReasonForTask(
    task,
    capabilityResolution,
    hasGenericAddOn,
  );
  const blockedReason = protocolBlockedReason;
  const productStatus = blockedReason
    ? ("blocked" as const)
    : baseProductStatus;
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
    zhixuId: order ? await zhixuIdForOrderProjection(order, productSchemaResolver) : "not_found",
    title: hookLabel === "链上待办" ? "处理链上待办" : `处理${hookLabel}`,
    subtitle: `${stageName} 已满足链上触发条件，需要继续处理。`,
    assigneeRole: displayAssigneeRole(task.assigneeRole),
    ...(effectiveAssigneeWallet
      ? { assigneeWallet: effectiveAssigneeWallet }
      : {}),
    stageId,
    stageName,
    deadline: "以业务约定为准",
    fundingImpact: pluginKind
      ? fundingImpactForFulfillment(pluginKind)
      : productAddOnKind
        ? fundingImpactForAddOn(productAddOnKind)
        : "缺少履约插槽能力插件元数据，当前只能展示链上证明，不能提交业务动作",
    requiredEvidence,
    ...(evidenceSpec ? { evidenceSpec } : {}),
    status: productStatus,
    ...(capabilityResolution
      ? {
          performanceSlotId: capabilityResolution.roleSlotId,
          performanceSlotLabel: capabilityResolution.performanceSlotLabel,
          businessPersonaLabels: capabilityResolution.businessPersonaLabels,
          capabilityPlugin: capabilityResolution.capabilityPlugin,
          ...(taskAddOnManifest ? { addOnManifest: taskAddOnManifest } : {}),
          primaryActionLabel:
            capabilityResolution.capabilityPlugin.primaryActionLabel ??
            primaryActionForFulfillment(
              capabilityResolution.capabilityPlugin.pluginKind,
            ),
        }
      : {
          capabilityPlugin: missingTaskCapabilityPlugin(),
        }),
    ...(!capabilityResolution && taskAddOnManifest
      ? { addOnManifest: taskAddOnManifest }
      : {}),
    ...(requiredInputs ? { requiredInputs } : {}),
    ...(productAddOnKind ? { addOnKind: productAddOnKind } : {}),
    ...(productStage?.selectableTargets
      ? { selectableTargets: productStage.selectableTargets }
      : {}),
    ...(productExecutorOverlayDto
      ? { executorOverlay: productExecutorOverlayDto }
      : {}),
    ...(resourceRequirements.length > 0 ? { resourceRequirements } : {}),
    ...(blockedReason ? { blockedReason } : {}),
    ...(pluginKind === "payment_placeholder"
      ? { settlementPreview: paymentPlaceholderSettlementPreview() }
      : {}),
    participantRoleLabel:
      capabilityResolution?.participantRoleLabel ??
      displayAssigneeRole(task.assigneeRole),
    ...(effectiveAssigneeWallet
      ? { participantWallet: effectiveAssigneeWallet }
      : {}),
    canSubmit:
      capabilityBacked &&
      task.status === "ready" &&
      Boolean(effectiveAssigneeWallet),
    proofSummary: {
      label: task.status === "submitted" ? "已提交链上确认" : "等待提交确认",
      txHash:
        task.status === "submitted"
          ? task.proof.transactionHash
          : task.createdAt.transactionHash,
      blockNumber:
        task.status === "submitted"
          ? task.proof.blockNumber.toString()
          : task.createdAt.blockNumber.toString(),
      ...(proof.payloadHash ? { payloadHash: proof.payloadHash } : {}),
    },
    responsibilityStatements: [
      {
        title: "我确认本次处理基于真实业务事实",
        desc: "提交后会形成可追溯链上确认或触发下一步执行。",
      },
    ],
    proofRows: [
      ...proofRowsFromProof(proof),
      ...(executorOverlayDto
        ? [
            {
              label: "Stage executor patch",
              value: shortHex(executorOverlayDto.patchHash),
            },
          ]
        : []),
      ...resourceOverlayDtos.map((overlay) => ({
        label: "Stage resource patch",
        value: `${shortHex(overlay.resourceKey)} ${shortHex(overlay.patchHash)}`,
      })),
    ],
    hookId: task.hookId,
    hookName: hookLabel,
    stageIdentifier: stageId,
    chainStatus: task.status,
    readyTxHash: task.createdAt.transactionHash,
    ...(task.status === "submitted" &&
    task.proof.eventName === "SignalSubmitted"
      ? { submittedSignalTxHash: task.proof.transactionHash }
      : {}),
    ...(executorOverlayDto ? { stageExecutorOverlay: executorOverlayDto } : {}),
    ...(resourceOverlayDtos.length > 0
      ? { stageResourceOverlays: resourceOverlayDtos }
      : {}),
    proof,
    projection: projectionMetadataFromStateMachineTask(task, syncState),
  };
}

interface TaskCapabilityResolution {
  readonly roleSlotId: string;
  readonly performanceSlotLabel: string;
  readonly participantRoleLabel: string;
  readonly businessPersonaLabels: readonly string[];
  readonly capabilityPlugin: ProductTaskCapabilityPluginDTO;
  readonly addOnManifest?: NonNullable<
    ZhixuDetailDTO["roleSlots"][number]["addOnManifest"]
  >;
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
  productSchemaResolver?: ProductSchemaResolver,
): Promise<TaskCapabilityResolution | undefined> {
  if (!order) {
    return undefined;
  }
  const zhixu = await zhixuDetailForOrder(
    order,
    productSchemaResolver,
  );
  if (!zhixu || zhixu.roleSlots.length === 0) {
    return undefined;
  }

  const decodedStageId = displayStageId(task.stageIdentifier);
  const stageIds = new Set([
    decodedStageId,
    task.stageIdentifier.toLowerCase(),
  ]);
  const corroboratingRoleSlotIds = new Set(
    zhixu.orderPermissionTable
      .filter((entry) => taskStageMatches(entry.stageId, stageIds))
      .map((entry) => entry.roleSlotId),
  );
  const candidates: TaskCapabilityCandidate[] = [];

  for (const slot of zhixu.roleSlots) {
    for (const plugin of slot.capabilityPlugins ?? []) {
      if (
        !plugin.stageIds.some((stageId) => taskStageMatches(stageId, stageIds))
      ) {
        continue;
      }
      const capabilityPlugin = taskCapabilityPluginFromSlot(
        plugin,
        slot.slotId,
      );
      const submitter = submitterForCapability(
        order,
        zhixu,
        slot.slotId,
        stageIds,
      );
      candidates.push({
        roleSlotId: slot.slotId,
        performanceSlotLabel: slot.performanceSlotLabel ?? slot.label,
        participantRoleLabel: slot.label,
        businessPersonaLabels: slot.businessPersonaLabels ?? [],
        capabilityPlugin,
        ...(slot.addOnManifest ? { addOnManifest: slot.addOnManifest } : {}),
        ...(submitter
          ? {
              submitterWallet: submitter.wallet,
              submitSignal: {
                sourceId: submitter.sourceId,
                signalId: submitter.signalId,
              },
            }
          : {}),
        permissionCorroborated: corroboratingRoleSlotIds.has(slot.slotId),
      });
    }
  }

  return candidates.sort(compareTaskCapabilityCandidates)[0];
}

function submitterForCapability(
  order: StateMachineOrderProjection,
  zhixu: ZhixuDetailDTO,
  roleSlotId: string,
  stageIds: ReadonlySet<string>,
):
  | { readonly wallet: string; readonly sourceId: Hex; readonly signalId: Hex }
  | undefined {
  const entries = zhixu.orderPermissionTable
    .filter(
      (entry) =>
        entry.roleSlotId === roleSlotId &&
        entry.source.length > 0 &&
        taskStageMatches(entry.stageId, stageIds),
    )
    .sort(compareCapabilityPermissionEntries);

  for (const entry of entries) {
    const sourceId = keccak256(stringToBytes(entry.source)).toLowerCase();
    const signalId = keccak256(stringToBytes(entry.signalName)).toLowerCase();
    const authorization = Object.values(order.authorizations).find(
      (item) =>
        item.sourceId.toLowerCase() === sourceId &&
        item.signalId.toLowerCase() === signalId,
    );
    if (authorization) {
      return {
        wallet: authorization.submitter,
        sourceId: sourceId as Hex,
        signalId: signalId as Hex,
      };
    }
  }
  return undefined;
}

function proofWithCapabilitySubmitSignal(
  proof: ProductChainProofDTO,
  capabilityResolution?: TaskCapabilityResolution,
): ProductChainProofDTO {
  const submitSignal = capabilityResolution?.submitSignal;
  if (!submitSignal || (proof.sourceId && proof.signalId)) {
    return proof;
  }
  return {
    ...proof,
    ...(proof.sourceId ? {} : { sourceId: submitSignal.sourceId }),
    ...(proof.signalId ? {} : { signalId: submitSignal.signalId }),
  };
}

function proofWithTaskSubmitSignal(
  proof: ProductChainProofDTO,
  task: StateMachineTaskProjection,
): ProductChainProofDTO {
  const submitSignal = task.submitSignals?.[0];
  if (!submitSignal || (proof.sourceId && proof.signalId)) {
    return proof;
  }
  return {
    ...proof,
    ...(proof.sourceId ? {} : { sourceId: submitSignal.sourceId }),
    ...(proof.signalId ? {} : { signalId: submitSignal.signalId }),
  };
}

function compareCapabilityPermissionEntries(
  left: ZhixuDetailDTO["orderPermissionTable"][number],
  right: ZhixuDetailDTO["orderPermissionTable"][number],
): number {
  return (
    permissionSignalPriority(left.signalName) -
      permissionSignalPriority(right.signalName) ||
    left.permissionId.localeCompare(right.permissionId)
  );
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
  productSchemaResolver?: ProductSchemaResolver,
): Promise<ZhixuStageDTO | undefined> {
  if (!order) {
    return undefined;
  }
  const zhixu = await zhixuDetailForOrder(
    order,
    productSchemaResolver,
  );
  if (!zhixu) {
    return undefined;
  }
  const decodedStageId = displayStageId(task.stageIdentifier);
  const stageIds = new Set([
    decodedStageId,
    task.stageIdentifier.toLowerCase(),
  ]);
  return zhixu.stages.find((stage) =>
    taskStageMatches(stage.stageId, stageIds),
  );
}

async function resolveAddOnManifestForTask(
  task: StateMachineTaskProjection,
  order?: StateMachineOrderProjection,
  productSchemaResolver?: ProductSchemaResolver,
  preferredAddOnKind?: ZhixuStageDTO["addOnKind"],
): Promise<
  NonNullable<ZhixuDetailDTO["roleSlots"][number]["addOnManifest"]> | undefined
> {
  if (!order) {
    return undefined;
  }
  const zhixu = await zhixuDetailForOrder(
    order,
    productSchemaResolver,
  );
  if (!zhixu) {
    return undefined;
  }
  const decodedStageId = displayStageId(task.stageIdentifier);
  const stageIds = new Set([
    decodedStageId,
    decodedStageId.toLowerCase(),
    task.stageIdentifier.toLowerCase(),
  ]);
  const manifests = zhixu.roleSlots
    .map((slot) => slot.addOnManifest)
    .filter(
      (
        manifest,
      ): manifest is NonNullable<
        ZhixuDetailDTO["roleSlots"][number]["addOnManifest"]
      > =>
        Boolean(manifest) &&
        manifest!.stageBindings.some((stageId) =>
          taskStageMatches(stageId, stageIds),
        ),
    );
  return (
    manifests.find(
      (manifest) =>
        preferredAddOnKind && manifest.addOnKind === preferredAddOnKind,
    ) ?? manifests[0]
  );
}

async function zhixuDetailForOrder(
  order: StateMachineOrderProjection,
  productSchemaResolver?: ProductSchemaResolver,
): Promise<ZhixuDetailDTO | undefined> {
  const storeSchema = await productSchemaForOrder(
    order,
    productSchemaResolver,
  );
  if (storeSchema) {
    return zhixuDetailFromProductSchema(storeSchema);
  }

  // Schema 未登记时不再回退到任何内置目录；调用方按显式缺失处理。
  return undefined;
}

async function productSchemaForOrder(
  order: StateMachineOrderProjection,
  productSchemaResolver?: ProductSchemaResolver,
): Promise<StoreProductSchemaDTO | undefined> {
  const planHash = order.planHash;
  if (!productSchemaResolver || !planHash) {
    return undefined;
  }
  const schema = await productSchemaResolver.getProductSchemaByPlan(
    order.planId,
    planHash,
  );
  return schema && isExplicitStoreProductSchema(schema) ? schema : undefined;
}

function isExplicitStoreProductSchema(schema: StoreProductSchemaDTO): boolean {
  return (
    schema.validation.ok &&
    schema.roleSlots.every(
      (slot) =>
        (slot.capabilityPlugins ?? []).length > 0 &&
        (slot.capabilityPlugins ?? []).every(
          (plugin) => plugin.source === "explicit",
        ),
    )
  );
}

function zhixuDetailFromProductSchema(
  schema: StoreProductSchemaDTO,
): ZhixuDetailDTO {
  const planPublication = {
    status: "not_found",
    label: "等待 Plan 发布状态同步",
    stateMachineLabel: "UVPStateMachine",
    planId: schema.planId,
    planHash: schema.planHash,
    artifactHash: schema.artifactHash,
  } as const;
  const reviewStatus = schema.validation.ok ? "approved" : "unreviewed";
  const paymentMethods = Array.from(
    new Set(
      schema.capabilityPlugins
        .filter((plugin) => plugin.pluginKind === "payment_placeholder")
        .map(() => "ERC20 stablecoin adapter"),
    ),
  );
  const zhixuId =
    schema.zhixuId ?? zhixuIdFromPlanIdentity(schema.planId, schema.planHash);

  return {
    zhixuId,
    title: schema.title,
    subtitle:
      "该秩序来自 Store Product Schema Bundle；链上状态仍以合约事件为准。",
    reviewStatus,
    reviewLabel: schema.validation.ok
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
    planPublication,
    roleSlots: schema.roleSlots,
    dockableModules: [],
    stages: schema.stages,
    orderPermissionTable: schema.orderPermissionTable,
    ...(schema.createOrderTrigger
      ? { createOrderTrigger: schema.createOrderTrigger }
      : {}),
    proofRows: [
      { label: "秩序编号", value: zhixuId },
      { label: "Plan ID", value: schema.planId },
      { label: "Plan Hash", value: schema.planHash },
      { label: "Artifact Hash", value: schema.artifactHash },
      { label: "Schema Hash", value: schema.schemaHash },
      { label: "Schema 状态", value: schema.validation.status },
      { label: "Plan 发布状态", value: planPublication.label },
    ],
    createOrderHint:
      "订单创建必须使用链上 planId/planHash，并由 Product API 按该 schema 解释普通用户任务。",
  };
}

function zhixuIdFromPlanIdentity(planId: string, planHash: string): string {
  return `plan-${shortId(planId)}-${shortId(planHash)}`;
}

function zhixuIdFromPlanId(planId: string): string {
  return `plan-${shortId(planId)}`;
}

function taskCapabilityPluginFromSlot(
  plugin: NonNullable<
    ZhixuDetailDTO["roleSlots"][number]["capabilityPlugins"]
  >[number],
  roleSlotId: string,
): ProductTaskCapabilityPluginDTO {
  return {
    pluginKind: plugin.pluginKind,
    source: plugin.source,
    roleSlotId,
    ...(plugin.title ? { title: plugin.title } : {}),
    ...(plugin.summary ? { summary: plugin.summary } : {}),
    ...(plugin.primaryActionLabel
      ? { primaryActionLabel: plugin.primaryActionLabel }
      : {}),
    requiredEvidence: plugin.requiredEvidence,
    ...(plugin.inputPolicy ? { inputPolicy: plugin.inputPolicy } : {}),
  };
}

function taskStageMatches(
  stageId: string,
  taskStageIds: ReadonlySet<string>,
): boolean {
  const normalizedStageId = stageId.toLowerCase();
  const hashedStageId = keccak256(stringToBytes(stageId)).toLowerCase();
  return (
    taskStageIds.has(stageId) ||
    taskStageIds.has(normalizedStageId) ||
    taskStageIds.has(hashedStageId)
  );
}

function compareTaskCapabilityCandidates(
  left: TaskCapabilityCandidate,
  right: TaskCapabilityCandidate,
): number {
  if (left.permissionCorroborated !== right.permissionCorroborated) {
    return left.permissionCorroborated ? -1 : 1;
  }
  if (left.capabilityPlugin.source !== right.capabilityPlugin.source) {
    return left.capabilityPlugin.source === "explicit"
      ? -1
      : right.capabilityPlugin.source === "explicit"
        ? 1
        : 0;
  }
  return 0;
}

function requiredEvidenceForCapability(
  plugin: ProductTaskCapabilityPluginDTO,
): readonly string[] {
  return plugin.requiredEvidence.length > 0
    ? plugin.requiredEvidence
    : requiredEvidenceForFulfillment(plugin.pluginKind);
}

/**
 * ProductTaskDTO.evidenceSpec 的本仓结构镜像（productDto.v1 可选字段，
 * 不 import protocol 包，跟随 requiredEvidence 的内联定义方式）。
 */
export interface ProductTaskEvidenceSpecDTO {
  readonly key: string;
  readonly label: string;
  readonly inputKind?: "file" | "text" | "date";
  readonly accept?: readonly string[];
  readonly required?: boolean;
  readonly description?: string;
}

/**
 * schema 是不透明 JSON，发布者携带的 evidenceSpec 不在 protocol DTO 类型上；
 * 按结构化读取并做最小形状过滤（key/label 非空字符串的条目保留），
 * 避免逐字段投影静默丢掉发布者数据。
 */
export function normalizeEvidenceSpec(
  value: unknown,
): readonly ProductTaskEvidenceSpecDTO[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const entries = value.filter(isEvidenceSpecEntry) as readonly ProductTaskEvidenceSpecDTO[];
  return entries.length > 0 ? entries : undefined;
}

function isEvidenceSpecEntry(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.key === "string" &&
    record.key.trim().length > 0 &&
    typeof record.label === "string" &&
    record.label.trim().length > 0
  );
}

function evidenceSpecFromStage(
  stage: ZhixuStageDTO | undefined,
): readonly ProductTaskEvidenceSpecDTO[] | undefined {
  return normalizeEvidenceSpec(
    (stage as { readonly evidenceSpec?: unknown } | undefined)?.evidenceSpec,
  );
}

function requiredInputsForCapability(
  plugin: ProductTaskCapabilityPluginDTO,
  completed: boolean,
): NonNullable<ProductTaskDTO["requiredInputs"]> {
  if (!plugin.inputPolicy) {
    return requiredInputsForFulfillment(plugin.pluginKind, completed);
  }
  return plugin.inputPolicy.map((input) => ({
    ...input,
    completed: completed || input.completed,
  }));
}

function missingTaskCapabilityPlugin(): ProductTaskCapabilityPluginDTO {
  return {
    pluginKind: "evidence_submission",
    source: "missing",
    title: "缺少履约插件配置",
    summary: "该链上待办没有匹配到秩序 metadata 中的履约插槽能力插件。",
    requiredEvidence: [],
  };
}

function blockedReasonForTask(
  task: StateMachineTaskProjection,
  capabilityResolution: TaskCapabilityResolution | undefined,
  hasGenericAddOn = false,
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

function requiredEvidenceForFulfillment(
  kind: FulfillmentPluginKind,
): readonly string[] {
  // 商店框架化裁决：兜底文案不得携带具体业务词（单证/行业类型等），
  // 只描述"阶段凭证/确认"的通用槽位语义；具体业务词由发布者的
  // evidenceSpec/requiredEvidence 配置携带。
  switch (kind) {
    case "payment_placeholder":
      return ["付款条件确认", "资金凭证指纹"];
    case "delivery_update":
      return ["阶段交付凭证", "阶段完成确认"];
    case "validation_confirm":
      return ["检验报告", "验收确认"];
    case "dispute_material":
      return ["争议说明", "补充凭证"];
    case "evidence_submission":
      return ["凭证指纹或阶段完成确认"];
  }
}

function fundingImpactForFulfillment(kind: FulfillmentPluginKind): string {
  if (kind === "payment_placeholder") {
    return "稳定币模块占位：仅记录付款条件和凭证，不托管或划转资金";
  }
  return "条件满足后进入下一步；资金托管不在本接口处理";
}

function fundingImpactForAddOn(
  kind: NonNullable<ZhixuStageDTO["addOnKind"]>,
): string {
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
  completed: boolean,
): NonNullable<ProductTaskDTO["requiredInputs"]> {
  switch (kind) {
    case "payment_placeholder":
      return [
        {
          inputId: "payment-condition",
          label: "确认付款条件",
          inputType: "payment_placeholder",
          required: true,
          completed,
        },
        {
          inputId: "funding-evidence",
          label: "资金凭证指纹",
          inputType: "evidence",
          required: true,
          completed,
        },
      ];
    case "validation_confirm":
      return [
        {
          inputId: "validation-report",
          label: "检验或验收凭证",
          inputType: "evidence",
          required: true,
          completed,
        },
        {
          inputId: "validation-confirmation",
          label: "确认验收结果",
          inputType: "confirmation",
          required: true,
          completed,
        },
      ];
    case "dispute_material":
      return [
        {
          inputId: "dispute-statement",
          label: "争议说明",
          inputType: "text",
          required: true,
          completed,
        },
        {
          inputId: "dispute-evidence",
          label: "补充凭证",
          inputType: "evidence",
          required: false,
          completed,
        },
      ];
    case "delivery_update":
    case "evidence_submission":
      return [
        {
          inputId: "stage-evidence",
          label: kind === "delivery_update" ? "阶段交付凭证" : "阶段凭证",
          inputType: "evidence",
          required: true,
          completed,
        },
        {
          inputId: "stage-confirmation",
          label: "确认业务事实",
          inputType: "confirmation",
          required: true,
          completed,
        },
      ];
  }
}

function paymentPlaceholderSettlementPreview(): SettlementPreviewDTO {
  return {
    label: "稳定币模块占位",
    statusLabel: "等待后续 funding adapter 接入",
    adapterStatus: "placeholder",
    disclaimer:
      "当前不托管、不划转、不释放、不退款任何资金，只记录付款条件和证明。",
  };
}

function productTimelineFromStateMachine(
  order: StateMachineOrderProjection,
): readonly ProductTimelineEventApiDTO[] {
  return order.timeline.map(productTimelineEventFromStateMachine).sort(
    compareProductTimelineEvents,
  );
}

function productProofFromStateMachine(
  order: StateMachineOrderProjection,
): readonly ProductChainProofDTO[] {
  return order.proof.map(proofFromStateMachineProof).sort(compareProductProof);
}

function productTimelineEventFromStateMachine(
  event: StateMachineTimelineEventProjection,
): ProductTimelineEventApiDTO {
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
    proof,
  };
}

function productConfirmationFromStateMachineSignal(
  signal: StateMachineSignalProjection,
): ProductConfirmationDTO {
  return {
    confirmationId: `${signal.sourceId}:${signal.signalId}`,
    orderId: signal.orderId,
    sourceLabel: displayBytes32(signal.sourceId, "来源"),
    actionLabel: displayBytes32(signal.signalId, "确认动作"),
    payloadHash: signal.payloadHash,
    submitter: signal.submitter,
    submittedAt: `block ${signal.submittedAt.blockNumber.toString()}`,
    proof: proofFromStateMachineProof(signal.proof),
  };
}

function productStageExecutorOverlayFromStateMachine(
  overlay: StateMachineStageExecutorOverlayProjection,
): ProductStageExecutorOverlayApiDTO {
  return {
    orderId: overlay.orderId,
    selectorStageId: overlay.selectorStageId,
    targetStageId: overlay.targetStageId,
    selectorWallet: overlay.selectorWallet,
    activeExecutorWallet: overlay.activeExecutorWallet,
    mode: overlay.mode,
    ...(overlay.modeHash ? { modeHash: overlay.modeHash } : {}),
    ...(overlay.previousExecutor
      ? { previousExecutor: overlay.previousExecutor }
      : {}),
    ...(overlay.approvalSourceId
      ? { approvalSourceId: overlay.approvalSourceId }
      : {}),
    ...(overlay.approvalSignalId
      ? { approvalSignalId: overlay.approvalSignalId }
      : {}),
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
      ...(overlay.previousExecutor
        ? [{ label: "Previous executor", value: overlay.previousExecutor }]
        : []),
      ...(overlay.approvalSourceId && overlay.approvalSignalId
        ? [
            {
              label: "Approval signal",
              value: `${overlay.approvalSourceId}:${overlay.approvalSignalId}`,
            },
          ]
        : []),
      ...proofRowsFromProof(proofFromStateMachineProof(overlay.proof)),
    ],
    proof: proofFromStateMachineProof(overlay.proof),
    ...(overlay.activationProof
      ? { activationProof: proofFromStateMachineProof(overlay.activationProof) }
      : {}),
  };
}

function productExecutorOverlayFromStateMachine(
  overlay: StateMachineStageExecutorOverlayProjection,
): ProductExecutorOverlayDTO {
  return {
    orderId: overlay.orderId,
    selectorStageId: overlay.selectorStageId,
    targetStageId: overlay.targetStageId,
    mode: overlay.mode,
    modeLabel: executorPatchModeLabel(overlay.mode),
    selectorWallet: overlay.selectorWallet,
    ...(overlay.previousExecutor
      ? {
          previousExecutor: overlay.previousExecutor,
          previousExecutorWallet: overlay.previousExecutor,
        }
      : {}),
    activeExecutorWallet: overlay.activeExecutorWallet,
    newExecutorWallet: overlay.activeExecutorWallet,
    roleHash: overlay.roleHash,
    executorMetadataHash: overlay.executorMetadataHash,
    ...(overlay.approvalSourceId
      ? { approvalSourceId: overlay.approvalSourceId }
      : {}),
    ...(overlay.approvalSignalId
      ? { approvalSignalId: overlay.approvalSignalId }
      : {}),
    patchHash: overlay.patchHash,
    patchNonce: overlay.patchNonce,
    ...(overlay.metadataURI ? { metadataURI: overlay.metadataURI } : {}),
    proofRows: [
      { label: "Target stage", value: displayStageId(overlay.targetStageId) },
      {
        label: "Active executor",
        value: shortHex(overlay.activeExecutorWallet),
      },
      { label: "Patch nonce", value: overlay.patchNonce },
      ...proofRowsFromProof(
        proofFromStateMachineProof(overlay.activationProof ?? overlay.proof),
      ),
    ],
  };
}

function productStageResourceOverlayFromStateMachine(
  overlay: StateMachineStageResourceOverlayProjection,
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
      {
        label: "Resource key",
        value: displayBytes32(overlay.resourceKey, "资源"),
      },
      { label: "Manifest hash", value: shortHex(overlay.manifestHash) },
      { label: "Policy hash", value: shortHex(overlay.policyHash) },
      { label: "Patch nonce", value: overlay.patchNonce },
      ...proofRowsFromProof(proofFromStateMachineProof(overlay.proof)),
    ],
    proof: proofFromStateMachineProof(overlay.proof),
  };
}

function productExecutorOverlaysByStage(
  order: StateMachineOrderProjection,
): Readonly<Record<string, ProductExecutorOverlayDTO>> {
  return Object.fromEntries(
    Object.values(order.stageExecutorOverlays).map((overlay) => [
      displayStageId(overlay.targetStageId),
      productExecutorOverlayFromStateMachine(overlay),
    ]),
  );
}

function productResourceRequirementsByStage(
  order: StateMachineOrderProjection,
): Readonly<Record<string, readonly ProductResourceRequirementDTO[]>> {
  const entries = Object.values(order.stageResourceOverlays)
    .map((overlay) => displayStageId(overlay.targetStageId))
    .filter((stageId, index, stageIds) => stageIds.indexOf(stageId) === index)
    .map(
      (stageId) =>
        [stageId, productResourceRequirementsForStage(order, stageId)] as const,
    )
    .filter(([, requirements]) => requirements.length > 0);
  return Object.fromEntries(entries);
}

function productResourceRequirementsForStage(
  order: StateMachineOrderProjection,
  stageIdentifier: string,
): readonly ProductResourceRequirementDTO[] {
  const stageIds = new Set([
    stageIdentifier,
    stageIdentifier.toLowerCase(),
    displayStageId(stageIdentifier),
    displayStageId(stageIdentifier).toLowerCase(),
  ]);
  return Object.values(order.stageResourceOverlays)
    .filter(
      (overlay) =>
        stageIds.has(overlay.targetStageId) ||
        stageIds.has(overlay.targetStageId.toLowerCase()) ||
        stageIds.has(displayStageId(overlay.targetStageId)) ||
        stageIds.has(displayStageId(overlay.targetStageId).toLowerCase()),
    )
    .sort(compareStageResourceOverlayProjections)
    .map(productResourceRequirementFromStageOverlay);
}

function productResourceRequirementFromStageOverlay(
  overlay: StateMachineStageResourceOverlayProjection,
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
      createdAt: `block ${overlay.updatedAt.blockNumber.toString()}`,
    },
    accessPolicy: {
      visibility: "protected",
      readers: [],
      writers: [],
      controllers: [
        { kind: "wallet", label: "Selector", value: overlay.selectorWallet },
      ],
      policyHash: overlay.policyHash,
    },
    sourceStageId: displayStageId(overlay.selectorStageId),
    sourcePatchHash: overlay.patchHash,
    proofRows: [
      { label: "Resource key", value: resourceLabel },
      { label: "Manifest hash", value: shortHex(overlay.manifestHash) },
      { label: "Policy hash", value: shortHex(overlay.policyHash) },
      { label: "Patch nonce", value: overlay.patchNonce },
      ...proofRowsFromProof(proof),
    ],
  };
}

function productConditionFromStateMachineHook(
  hook: StateMachineHookProjection,
): ProductConditionDTO {
  return {
    conditionId: hook.hookId,
    stageId: displayStageId(hook.stageIdentifier ?? hook.hookId),
    stageName: displayBytes32(hook.stageIdentifier ?? hook.hookId, "阶段"),
    status: hook.status,
    statusLabel: mapHookStatusLabel(hook.status),
    ...(hook.dueAt ? { dueAt: hook.dueAt } : {}),
    proof: proofFromStateMachineProof(hook.proof),
  };
}

function productStagesFromStateMachine(
  order: StateMachineOrderProjection,
): readonly ZhixuStageDTO[] {
  const hooks = Object.values(order.hooks).sort(compareHooksByUpdate);
  if (hooks.length === 0) {
    const resourceRequirements = productResourceRequirementsForStage(
      order,
      order.orderId,
    );
    return [
      {
        stageId: displayStageId(order.orderId),
        index: 1,
        name: "订单创建",
        evidence: ["链上订单注册"],
        ownerRole: "系统",
        status: "done",
        updatedAt: `区块 ${order.updatedAt.blockNumber.toString()}`,
        ...(resourceRequirements.length > 0 ? { resourceRequirements } : {}),
      },
    ];
  }

  return hooks.map((hook, index) => {
    const stageIdentifier = hook.stageIdentifier ?? hook.hookId;
    const executorOverlay =
      order.stageExecutorOverlays[stageIdentifier.toLowerCase()];
    const resourceRequirements = productResourceRequirementsForStage(
      order,
      stageIdentifier,
    );
    return {
      stageId: displayStageId(stageIdentifier),
      index: index + 1,
      name: displayBytes32(stageIdentifier, "阶段"),
      evidence: ["凭证指纹或链上确认"],
      ownerRole: "待分配角色",
      status: mapHookStatusToStageStatus(hook.status),
      updatedAt: `区块 ${hook.updatedAt.blockNumber.toString()}`,
      ...(executorOverlay
        ? {
            executorOverlay:
              productExecutorOverlayFromStateMachine(executorOverlay),
          }
        : {}),
      ...(resourceRequirements.length > 0 ? { resourceRequirements } : {}),
    };
  });
}

function proofFromStateMachineProof(
  proof: StateMachineProofProjection,
): ProductChainProofDTO {
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
  const metadataURI =
    proofArgString(proof.args, "metadataURI") ??
    proofArgString(proof.args, "manifestURI");

  return {
    eventId: proof.eventId,
    chainId: proof.chainId,
    contractAddress: proof.contractAddress,
    blockNumber: proof.blockNumber.toString(),
    ...(proof.transactionIndex !== undefined
      ? { transactionIndex: proof.transactionIndex }
      : {}),
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
    ...(proof.submitter ? { submitter: proof.submitter } : {}),
  };
}

function proofRowsFromProof(
  proof: ProductChainProofDTO | undefined,
): readonly ChainProofRowDTO[] {
  if (!proof) {
    return [{ label: "链上证明", value: "等待链上事件同步" }];
  }
  return [
    {
      label: "交易编号",
      value: proof.transactionHash ? shortHex(proof.transactionHash) : "未上链",
    },
    { label: "区块高度", value: proof.blockNumber || "未同步" },
    { label: "链上事件", value: proof.eventName },
    ...(proof.targetStageId
      ? [{ label: "Target stage", value: displayStageId(proof.targetStageId) }]
      : []),
    ...(proof.patchNonce
      ? [{ label: "Patch nonce", value: proof.patchNonce }]
      : []),
    ...(proof.manifestHash
      ? [{ label: "Manifest hash", value: shortHex(proof.manifestHash) }]
      : []),
    ...(proof.policyHash
      ? [{ label: "Policy hash", value: shortHex(proof.policyHash) }]
      : []),
    ...(proof.activeExecutorWallet
      ? [
          {
            label: "Active executor",
            value: shortHex(proof.activeExecutorWallet),
          },
        ]
      : []),
    ...(proof.submitter
      ? [{ label: "提交人", value: shortHex(proof.submitter) }]
      : []),
  ];
}

function proofArgString(
  args: EventProofArgs,
  name: string,
): string | undefined {
  const value = args[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
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

function executorPatchModeLabel(
  mode: StateMachineStageExecutorOverlayProjection["mode"],
): string {
  switch (mode) {
    case "assign":
      return "指派执行方";
    case "handoff":
      return "执行方交接";
    case "replacement":
      return "替换执行方";
  }
}

function paymentConditionSummaryFromStateMachine(
  order: StateMachineOrderProjection,
): string {
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
  return zhixuIdFromPlanId(order.planId);
}

/**
 * The zhixu id of an order/task follows the Store-registered schema for its
 * plan when one exists; otherwise it falls back to the plan-derived id so the
 * id always points at a real catalog entry built from the same projection.
 */
async function zhixuIdForOrderProjection(
  order: StateMachineOrderProjection,
  productSchemaResolver?: ProductSchemaResolver,
): Promise<string> {
  const schema = await explicitStoreSchemaForPlanId(order.planId, order.planHash, productSchemaResolver);
  return schema?.zhixuId ?? zhixuIdForPlan(order);
}

/**
 * Catalog entries describe the same plan the chain published. When the plan
 * projection exists, its publication evidence overrides the schema bundle's
 * "not yet synced" placeholder.
 */
function overlayPlanPublication(
  detail: ZhixuDetailDTO,
  plan: ProjectionSnapshot["stateMachinePlans"][string] | undefined,
): ZhixuDetailDTO {
  if (!plan) {
    return detail;
  }
  return {
    ...detail,
    planPublication: {
      status: "published",
      label: "Plan 已发布",
      stateMachineLabel: plan.stateMachineAddress,
      planId: plan.planId,
      planHash: plan.planHash,
      txHash: plan.proof.transactionHash,
      blockNumber: plan.proof.blockNumber.toString(),
      ...(plan.publisher ? { publisher: plan.publisher } : {}),
      ...(detail.planPublication.artifactHash
        ? { artifactHash: detail.planPublication.artifactHash }
        : {}),
    },
  };
}

async function explicitStoreSchemaForPlan(
  plan: ProjectionSnapshot["stateMachinePlans"][string],
  productSchemaResolver?: ProductSchemaResolver,
): Promise<StoreProductSchemaDTO | undefined> {
  if (!productSchemaResolver || !plan.planHash) {
    return undefined;
  }
  const schema = await productSchemaResolver.getProductSchemaByPlan(plan.planId, plan.planHash);
  return schema && isExplicitStoreProductSchema(schema) ? schema : undefined;
}

async function explicitStoreSchemaForPlanId(
  planId: string,
  planHash: string | undefined,
  productSchemaResolver?: ProductSchemaResolver,
): Promise<StoreProductSchemaDTO | undefined> {
  if (!productSchemaResolver || !planHash) {
    return undefined;
  }
  const schema = await productSchemaResolver.getProductSchemaByPlan(planId, planHash);
  return schema && isExplicitStoreProductSchema(schema) ? schema : undefined;
}

function planKey(planId: string, planHash: string): string {
  return `${planId}:${planHash}`;
}

function matchesTaskQuery(
  task: ProductTaskDTO,
  query: ProductTaskQuery,
): boolean {
  const assigneeQuery = query.assignee?.toLowerCase();
  return (
    (!query.orderId || task.orderId === query.orderId) &&
    (!assigneeQuery ||
      task.assigneeRole === query.assignee ||
      task.assigneeWallet?.toLowerCase() === assigneeQuery) &&
    (!query.status || taskStatusMatchesQuery(task.status, query.status))
  );
}

function taskStatusMatchesQuery(
  status: ProductTaskDTO["status"],
  queryStatus: string,
): boolean {
  return (
    status === queryStatus ||
    (queryStatus === "ready" && status === "open") ||
    (queryStatus === "cancelled" && status === "blocked")
  );
}

/**
 * 协议包 OrderStatus 是冻结的单值类型（合约词表只有 registered），投影侧的
 * "unknown"/乐观提升在这里被归一为 "registered"。诚实性由 projectionStatus
 * （机器可读）与 statusLabel（pending 时"同步中"）承担，二者都以
 * registeredAt 为判据，见 orderProjectionComplete。
 */
function mapStateMachineOrderStatus(
  status: StateMachineOrderStatus,
): ProductOrderDTO["status"] {
  void status;
  return "registered";
}

/**
 * 投影完整性判据：订单行存在 ≠ 注册事件已投影。行可被任意引用该 orderId
 * 的事件先建出（SignalSubmitted/HookStatusChanged 等还会把 status 乐观提升
 * 为 "registered"），而 registeredAt 只由 OrderRegistered 事件写入——与
 * reconcile worker 判定注册投影在场的判据一致。
 */
function orderProjectionComplete(
  order: StateMachineOrderProjection,
): boolean {
  return Boolean(order.registeredAt);
}

/**
 * statusLabel 跟投影完整性走：行已建但注册投影未到时显示"同步中"，即使
 * status 字段已被乐观提升为 registered——避免读面渲染成"已注册"。
 */
function orderProjectionStatusLabel(
  status: StateMachineOrderStatus,
  projected: boolean,
): string {
  return projected
    ? mapStateMachineOrderStatusLabel(status)
    : mapStateMachineOrderStatusLabel("unknown");
}

function mapStateMachineOrderStatusLabel(
  status: StateMachineOrderStatus,
): string {
  switch (status) {
    case "registered":
      return "已注册";
    case "unknown":
      return "同步中";
  }
}

function mapStateMachineTaskStatus(
  status: StateMachineTaskStatus,
): ProductTaskDTO["status"] {
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

function mapHookStatusLabel(
  status: StateMachineHookProjection["status"],
): string {
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

function mapHookStatusToStageStatus(
  status: StateMachineHookProjection["status"],
): ZhixuStageDTO["status"] {
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
  syncState?: ProjectionSyncState,
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
    ...projectionSyncMetadata(syncState),
  };
}

function projectionMetadataFromStateMachineTask(
  task: StateMachineTaskProjection,
  syncState?: ProjectionSyncState,
): ProductProjectionMetadataDTO {
  return {
    source: "chain_projection",
    syncStatus: syncState?.syncStatus ?? "indexed",
    chainId: task.proof.chainId,
    contractAddress: task.proof.contractAddress,
    updatedAtBlock: task.updatedAt.blockNumber.toString(),
    lastEventName: task.proof.eventName,
    eventCount: 1,
    ...projectionSyncMetadata(syncState),
  };
}

function projectionSyncMetadata(
  syncState: ProjectionSyncState | undefined,
): Partial<ProductProjectionMetadataDTO> {
  if (!syncState) {
    return {};
  }
  return {
    ...(syncState.latestIndexedBlock !== undefined
      ? { latestIndexedBlock: syncState.latestIndexedBlock.toString() }
      : {}),
    ...(syncState.finalizedBlock !== undefined
      ? { finalizedBlock: syncState.finalizedBlock.toString() }
      : {}),
    confirmationDepth: syncState.confirmationDepth,
    ...(syncState.lastEventName
      ? { lastEventName: syncState.lastEventName }
      : {}),
    eventCount: syncState.eventCount,
    ...(syncState.rebuild?.status
      ? { rebuildStatus: syncState.rebuild.status }
      : {}),
    ...(syncState.degradedReason
      ? { degradedReason: syncState.degradedReason }
      : {}),
  };
}

function compareHooksByUpdate(
  left: StateMachineHookProjection,
  right: StateMachineHookProjection,
): number {
  return compareProvenance(left.updatedAt, right.updatedAt);
}

function compareStageResourceOverlays(
  left: ProductStageResourceOverlayApiDTO,
  right: ProductStageResourceOverlayApiDTO,
): number {
  return (
    left.resourceKey.localeCompare(right.resourceKey) ||
    compareProductProof(left.proof, right.proof)
  );
}

function compareStageResourceOverlayProjections(
  left: StateMachineStageResourceOverlayProjection,
  right: StateMachineStageResourceOverlayProjection,
): number {
  return (
    left.resourceKey.localeCompare(right.resourceKey) ||
    compareProvenance(left.updatedAt, right.updatedAt)
  );
}

function compareProductTimelineEvents(
  left: ProductTimelineEventApiDTO,
  right: ProductTimelineEventApiDTO,
): number {
  return compareProductProof(left.proof, right.proof);
}

function compareProductProof(
  left: ProductChainProofDTO,
  right: ProductChainProofDTO,
): number {
  const position = compareChainPointers({
    chainId: left.chainId,
    blockNumber: BigInt(left.blockNumber),
    ...(left.transactionIndex !== undefined
      ? { transactionIndex: left.transactionIndex }
      : {}),
    transactionHash: left.transactionHash as `0x${string}`,
    logIndex: left.logIndex,
  }, {
    chainId: right.chainId,
    blockNumber: BigInt(right.blockNumber),
    ...(right.transactionIndex !== undefined
      ? { transactionIndex: right.transactionIndex }
      : {}),
    transactionHash: right.transactionHash as `0x${string}`,
    logIndex: right.logIndex,
  });
  if (position !== 0) {
    return position;
  }
  return left.eventId.localeCompare(right.eventId);
}

function compareProvenance(
  left: ProjectionProvenance,
  right: ProjectionProvenance,
): number {
  return compareChainPointers(left, right);
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

function shortHex(value: string): string {
  return value.length > 18
    ? `${value.slice(0, 8)}...${value.slice(-8)}`
    : value;
}

function shortId(value: string): string {
  return value.length > 16
    ? `${value.slice(0, 8)}...${value.slice(-6)}`
    : value;
}
