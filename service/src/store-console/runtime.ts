import {
  type ChainProofRowDTO,
  type ProductTimelineEventDTO,
  type StoreOrderAuditSummaryDTO,
  type StoreOrderObservationDTO,
  type StoreOrderReplayStatus,
  type StoreOrderSupplierObservationDTO,
  type StoreOrderStageObservationDTO,
  type StoreRuntimeSummaryDTO,
} from "@uvp-eth/product-dto";
import {
  signalAuthorizationMatchesHook,
  type StateMachineOrderProjection,
  type StateMachineProofProjection,
  type StateMachineSignalAuthorizationProjection,
  type StateMachineSignalProjection,
  type StateMachineTaskProjection,
} from "../indexer/projections.js";
import type {
  IdentityBindingProjection,
  IdentityProjectionSnapshot,
} from "../indexer/identity-projections.js";
import type {
  ProductChainProofDTO,
  ProductOrderApiDTO,
  ProductService,
  ProductTaskApiDTO,
  ProductTimelineEventApiDTO,
} from "../product/service.js";
import type {
  ProjectionStore,
  ProjectionSyncState,
} from "../storage/projection-store.js";

export interface StoreRuntimeService {
  getSummary(): Promise<StoreRuntimeSummaryDTO>;
  listZhixuOrders(
    zhixuId: string,
    query?: StoreZhixuOrderQuery,
  ): Promise<StoreZhixuOrdersDTO>;
  getOrderObservation(
    orderId: string,
  ): Promise<StoreOrderObservationDTO | undefined>;
  getOrderReplay(orderId: string): Promise<StoreOrderReplayDTO | undefined>;
  getOrderAuditSummary(
    orderId: string,
  ): Promise<StoreOrderAuditSummaryDTO | undefined>;
}

export interface StoreZhixuOrderQuery {
  readonly status?: string;
}

export interface StoreZhixuOrdersDTO {
  readonly sourceOfTruth: "contracts-and-chain-events";
  readonly zhixuId: string;
  readonly statusFilter?: string;
  readonly orders: readonly StoreOrderObservationDTO[];
}

export interface StoreOrderReplayDTO {
  readonly sourceOfTruth: "contracts-and-chain-events";
  readonly orderId: string;
  readonly planId: string;
  readonly planHash?: string;
  readonly replayStatus: StoreOrderReplayStatus;
  readonly orderStatus: StateMachineOrderProjection["status"];
  readonly currentStage?: string;
  readonly eventCount: number;
  readonly authorizations: readonly StoreReplayAuthorizationDTO[];
  readonly signals: readonly StoreReplaySignalDTO[];
  readonly hooks: readonly StoreReplayHookDTO[];
  readonly tasks: readonly StoreReplayTaskDTO[];
  readonly timeline: readonly ProductTimelineEventApiDTO[];
  readonly proof: readonly ProductChainProofDTO[];
  readonly generatedAt: string;
}

export interface StoreReplayAuthorizationDTO {
  readonly sourceId: string;
  readonly signalId: string;
  readonly submitter: string;
  readonly role: string;
  readonly metadataHash: string;
  readonly blockNumber: string;
  readonly transactionHash: string;
}

export interface StoreReplaySignalDTO {
  readonly sourceId: string;
  readonly signalId: string;
  readonly payloadHash: string;
  readonly idempotencyKey: string;
  readonly submitter: string;
  readonly blockNumber: string;
  readonly transactionHash: string;
}

export interface StoreReplayHookDTO {
  readonly hookId: string;
  readonly status: string;
  readonly stageIdentifier?: string;
  readonly hookName?: string;
  readonly blockNumber: string;
  readonly transactionHash: string;
}

export interface StoreReplayTaskDTO {
  readonly taskId: string;
  readonly hookId: string;
  readonly status: string;
  readonly assigneeWallet?: string;
  readonly blockNumber: string;
  readonly transactionHash: string;
}

export class StoreRuntimeError extends Error {
  override readonly name = "StoreRuntimeError";

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export function createStoreRuntimeService(options: {
  readonly productService: ProductService;
  readonly store: ProjectionStore;
  readonly now?: () => Date;
}): StoreRuntimeService {
  const now = options.now ?? (() => new Date());

  return {
    async getSummary() {
      const [zhixus, orders, tasks, syncState] =
        await Promise.all([
          options.productService.listZhixu(),
          options.productService.listOrders(),
          options.productService.listTasks(),
          options.store.getSyncState(),
        ]);
      const warnings = await Promise.all(
        orders.map(async (order) =>
          lifecycleWarningsForOrder({
            order,
            tasks:
              order.tasks ??
              (await options.productService.listTasks({
                orderId: order.orderId,
              })),
            ...optionalRawOrder(
              await findStateMachineOrder(options.store, order.orderId),
            ),
            ...optionalSyncState(syncState),
          }),
        ),
      );

      return {
        sourceOfTruth: "contracts-and-chain-events",
        activeZhixuCount: zhixus.length,
        runningOrderCount: orders.filter(
          (order) => order.status === "registered",
        ).length,
        openTaskCount: tasks.filter((task) => task.status === "open").length,
        blockedOrderCount: orders.filter(
          (_order, index) => (warnings[index]?.length ?? 0) > 0,
        ).length,
        indexerStatus: storeIndexerStatus(syncState),
        updatedAt: syncState?.updatedAt ?? now().toISOString(),
      };
    },

    async listZhixuOrders(zhixuId, query = {}) {
      const orders = await options.productService.listOrders();
      const observations = await Promise.all(
        orders
          .filter((order) => order.zhixuId === zhixuId)
          .map((order) =>
            buildOrderObservation({
              order,
              productService: options.productService,
              store: options.store,
            }),
          ),
      );
      const filtered = observations.filter((observation) =>
        matchesStoreOrderFilter(observation, query.status),
      );
      return {
        sourceOfTruth: "contracts-and-chain-events",
        zhixuId,
        ...(query.status ? { statusFilter: query.status } : {}),
        orders: filtered,
      };
    },

    async getOrderObservation(orderId) {
      const order = await options.productService.getOrder(orderId);
      if (!order) {
        return undefined;
      }
      return buildOrderObservation({
        order,
        productService: options.productService,
        store: options.store,
      });
    },

    async getOrderReplay(orderId) {
      const rawOrder = await findStateMachineOrder(options.store, orderId, {
        failOnAmbiguous: true,
      });
      if (!rawOrder) {
        return undefined;
      }
      const [timeline, proof, syncState] = await Promise.all([
        options.productService.listOrderTimeline(orderId),
        options.productService.listOrderProof(orderId),
        options.store.getSyncState(),
      ]);
      return {
        sourceOfTruth: "contracts-and-chain-events",
        orderId: rawOrder.orderId,
        planId: rawOrder.planId,
        ...(rawOrder.planHash ? { planHash: rawOrder.planHash } : {}),
        replayStatus: replayStatusFromSync(syncState),
        orderStatus: rawOrder.status,
        ...(rawOrder.currentStage
          ? { currentStage: rawOrder.currentStage }
          : {}),
        eventCount: rawOrder.proof.length,
        authorizations: Object.values(rawOrder.authorizations).map(
          replayAuthorization,
        ),
        signals: Object.values(rawOrder.signals).map(replaySignal),
        hooks: Object.values(rawOrder.hooks).map((hook) => ({
          hookId: hook.hookId,
          status: hook.status,
          ...(hook.stageIdentifier
            ? { stageIdentifier: hook.stageIdentifier }
            : {}),
          ...(hook.hookName ? { hookName: hook.hookName } : {}),
          blockNumber: hook.updatedAt.blockNumber.toString(),
          transactionHash: hook.updatedAt.transactionHash,
        })),
        tasks: Object.values(rawOrder.tasks).map(replayTask),
        timeline: timeline ?? [],
        proof: proof ?? [],
        generatedAt: now().toISOString(),
      };
    },

    async getOrderAuditSummary(orderId) {
      const order = await options.productService.getOrder(orderId);
      const observation = order
        ? await buildOrderObservation({
            order,
            productService: options.productService,
            store: options.store,
          })
        : undefined;
      if (!observation) {
        return undefined;
      }
      return {
        sourceOfTruth: "contracts-and-chain-events",
        orderId: observation.orderId,
        zhixuId: observation.zhixuId,
        title: observation.title,
        status: observation.status,
        planId: observation.planId,
        planHash: observation.planHash,
        lifecycleWarnings: observation.lifecycleWarnings,
        stageSummary: observation.stages.map(
          (stage) => `${stage.index}. ${stage.name}: ${stage.status}`,
        ),
        taskSummary: observation.tasks.map(
          (task) => `${task.title}: ${task.status}`,
        ),
        supplierSummary: observation.suppliers.map(
          (supplier) =>
            `${supplier.wallet ?? supplier.supplierSubjectId ?? "unknown"}: ${supplier.identityStatus}`,
        ),
        timelineSummary: observation.timeline.map(
          ({ eventId, text, time }) => ({ eventId, text, time }),
        ),
        proofRows: observation.proofRows,
        redactionNotice:
          "Audit summary omits raw event args, signatures, payload bodies, and evidence plaintext.",
        generatedAt: now().toISOString(),
      };
    },
  };
}

async function buildOrderObservation(input: {
  readonly order: ProductOrderApiDTO;
  readonly productService: ProductService;
  readonly store: ProjectionStore;
}): Promise<StoreOrderObservationDTO> {
  const [tasks, timeline, rawOrder, identitySnapshot, syncState] =
    await Promise.all([
      input.order.tasks
        ? Promise.resolve(input.order.tasks)
        : input.productService.listTasks({ orderId: input.order.orderId }),
      input.order.timeline
        ? Promise.resolve(input.order.timeline)
        : input.productService.listOrderTimeline(input.order.orderId),
      findStateMachineOrder(input.store, input.order.orderId),
      input.store.getIdentitySnapshot(),
      input.store.getSyncState(),
    ]);
  const lifecycleWarnings = lifecycleWarningsForOrder({
    order: input.order,
    tasks,
    ...optionalRawOrder(rawOrder),
    ...optionalSyncState(syncState),
  });

  return {
    orderId: input.order.orderId,
    zhixuId: input.order.zhixuId,
    title: input.order.title,
    status: input.order.status,
    planId: input.order.planId ?? rawOrder?.planId ?? "",
    planHash: input.order.planHash ?? rawOrder?.planHash ?? "",
    lifecycleWarnings,
    stages: input.order.stages.map(
      (stage): StoreOrderStageObservationDTO => ({
        stageId: stage.stageId,
        index: stage.index,
        name: stage.name,
        status: stage.status,
        ...(stage.updatedAt ? { updatedAt: stage.updatedAt } : {}),
        proofRows: input.order.proofRows,
      }),
    ),
    tasks,
    suppliers: suppliersFromTasks(identitySnapshot, tasks),
    timeline: timeline ?? [],
    proofRows: input.order.proofRows,
    replayStatus: rawOrder ? replayStatusFromSync(syncState) : "not_found",
  };
}

function optionalRawOrder(
  rawOrder: StateMachineOrderProjection | undefined,
): { readonly rawOrder: StateMachineOrderProjection } | Record<string, never> {
  return rawOrder ? { rawOrder } : {};
}

function optionalSyncState(
  syncState: ProjectionSyncState | undefined,
): { readonly syncState: ProjectionSyncState } | Record<string, never> {
  return syncState ? { syncState } : {};
}

function lifecycleWarningsForOrder(input: {
  readonly order: ProductOrderApiDTO;
  readonly tasks: readonly ProductTaskApiDTO[];
  readonly rawOrder?: StateMachineOrderProjection;
  readonly syncState?: ProjectionSyncState;
}): readonly string[] {
  const warnings = new Set<string>();
  const indexerStatus = storeIndexerStatus(input.syncState);
  if (indexerStatus === "syncing") {
    warnings.add("indexer_syncing");
  }
  if (indexerStatus === "rebuilding") {
    warnings.add("indexer_rebuilding");
  }
  if (indexerStatus === "degraded") {
    warnings.add("indexer_degraded");
  }

  if (
    !input.rawOrder?.registeredAt &&
    !input.rawOrder?.proof.some(
      (proof) => proof.eventName === "OrderRegistered",
    )
  ) {
    warnings.add("chain_registration_proof_missing");
  }

  if (input.rawOrder) {
    for (const task of Object.values(input.rawOrder.tasks)) {
      if (
        task.status !== "ready" ||
        hasMatchingAuthorization(input.rawOrder, task)
      ) {
        continue;
      }
      warnings.add("open_task_authorization_missing");
      break;
    }
  }

  if (
    input.rawOrder &&
    proofBelowFinality(input.rawOrder.proof, input.syncState)
  ) {
    warnings.add("proof_finality_below_confirmation_depth");
  }

  return [...warnings];
}

async function findStateMachineOrder(
  store: ProjectionStore,
  orderId: string,
  options: { readonly failOnAmbiguous?: boolean } = {},
): Promise<StateMachineOrderProjection | undefined> {
  const matches = await store.findStateMachineOrdersByOrderId(orderId);
  if (matches.length > 1 && !orderId.includes(":") && options.failOnAmbiguous) {
    throw new StoreRuntimeError(
      409,
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
  return matches.length === 1
    ? matches[0]
    : await store.getStateMachineOrder(orderId);
}

function matchesStoreOrderFilter(
  observation: StoreOrderObservationDTO,
  status: string | undefined,
): boolean {
  if (!status) {
    return true;
  }
  switch (status) {
    case "blocked":
      return (
        observation.lifecycleWarnings.length > 0 ||
        observation.tasks.some((task) => task.status === "blocked")
      );
    case "disputed":
      return observation.status === "in_dispute";
    default:
      return observation.status === status;
  }
}

function storeIndexerStatus(
  syncState: ProjectionSyncState | undefined,
): StoreRuntimeSummaryDTO["indexerStatus"] {
  if (syncState?.syncStatus === "degraded" || syncState?.degradedReason) {
    return "degraded";
  }
  if (
    syncState?.syncStatus === "rebuilding" ||
    syncState?.rebuild?.status === "running"
  ) {
    return "rebuilding";
  }
  if (
    syncState?.syncStatus === "syncing" ||
    syncState?.syncStatus === "stale"
  ) {
    return "syncing";
  }
  return "ready";
}

function replayStatusFromSync(
  syncState: ProjectionSyncState | undefined,
): StoreOrderReplayStatus {
  const indexerStatus = storeIndexerStatus(syncState);
  if (indexerStatus === "rebuilding") {
    return "rebuild_required";
  }
  if (indexerStatus === "syncing" || indexerStatus === "degraded") {
    return "syncing";
  }
  return "replayable";
}

function hasMatchingAuthorization(
  order: StateMachineOrderProjection,
  task: StateMachineTaskProjection,
): boolean {
  return Object.values(order.authorizations).some((authorization) =>
    signalAuthorizationMatchesHook(authorization, {
      stageIdentifier: task.stageIdentifier,
      hookId: task.hookId,
      hookName: task.hookName,
    }),
  );
}

function proofBelowFinality(
  proof: readonly StateMachineProofProjection[],
  syncState: ProjectionSyncState | undefined,
): boolean {
  if (!syncState || syncState.confirmationDepth <= 0 || proof.length === 0) {
    return false;
  }
  if (syncState.finalizedBlock === undefined) {
    return true;
  }
  return proof.some((item) => item.blockNumber > syncState.finalizedBlock!);
}

function suppliersFromTasks(
  identitySnapshot: IdentityProjectionSnapshot,
  tasks: readonly ProductTaskApiDTO[],
): readonly StoreOrderSupplierObservationDTO[] {
  const suppliers = new Map<string, StoreOrderSupplierObservationDTO>();
  for (const task of tasks) {
    const wallet = task.assigneeWallet;
    const identity = wallet
      ? identityForWallet(identitySnapshot, wallet)
      : undefined;
    const key = identity?.subjectId ?? wallet;
    if (!key || suppliers.has(key)) {
      continue;
    }
    const identityStatus = identity?.status ?? "not_found";
    suppliers.set(key, {
      ...(identity?.subjectId ? { supplierSubjectId: identity.subjectId } : {}),
      ...(wallet
        ? { wallet }
        : identity?.account
          ? { wallet: identity.account }
          : {}),
      identityStatus,
      ...(identity?.descriptorURI
        ? { metadataURI: identity.descriptorURI }
        : {}),
      ...(identity?.revokeReasonURI
        ? { revokedReasonURI: identity.revokeReasonURI }
        : {}),
    });
  }
  return [...suppliers.values()];
}

function identityForWallet(
  identitySnapshot: IdentityProjectionSnapshot,
  wallet: string,
): IdentityBindingProjection | undefined {
  const normalizedWallet = wallet.toLowerCase();
  return Object.values(identitySnapshot.bindings)
    .filter((identity) => identity.account.toLowerCase() === normalizedWallet)
    .sort(compareIdentity)[0];
}

function compareIdentity(
  left: IdentityBindingProjection,
  right: IdentityBindingProjection,
): number {
  if (left.status !== right.status) {
    return left.status === "active" ? -1 : 1;
  }
  if (left.updatedAt.blockNumber !== right.updatedAt.blockNumber) {
    return left.updatedAt.blockNumber > right.updatedAt.blockNumber ? -1 : 1;
  }
  return left.subjectId.localeCompare(right.subjectId);
}

function replayAuthorization(
  authorization: StateMachineSignalAuthorizationProjection,
): StoreReplayAuthorizationDTO {
  return {
    sourceId: authorization.sourceId,
    signalId: authorization.signalId,
    submitter: authorization.submitter,
    role: authorization.role,
    metadataHash: authorization.metadataHash,
    blockNumber: authorization.authorizedAt.blockNumber.toString(),
    transactionHash: authorization.authorizedAt.transactionHash,
  };
}

function replaySignal(
  signal: StateMachineSignalProjection,
): StoreReplaySignalDTO {
  return {
    sourceId: signal.sourceId,
    signalId: signal.signalId,
    payloadHash: signal.payloadHash,
    idempotencyKey: signal.idempotencyKey,
    submitter: signal.submitter,
    blockNumber: signal.submittedAt.blockNumber.toString(),
    transactionHash: signal.submittedAt.transactionHash,
  };
}

function replayTask(task: StateMachineTaskProjection): StoreReplayTaskDTO {
  return {
    taskId: task.taskId,
    hookId: task.hookId,
    status: task.status,
    ...(task.assigneeWallet ? { assigneeWallet: task.assigneeWallet } : {}),
    blockNumber: task.updatedAt.blockNumber.toString(),
    transactionHash: task.updatedAt.transactionHash,
  };
}
