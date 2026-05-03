import { keccak256, stringToBytes } from "viem";
import {
  signalAuthorizationMatchesHook,
  type StateMachineOrderProjection,
  type StateMachineSignalAuthorizationProjection,
  type StateMachineTaskProjection
} from "../indexer/projections.js";
import type {
  PlanTrustProjection,
  SupplierTrustProjection,
  TrustProjectionSnapshot
} from "../indexer/trust-projections.js";
import type { ProjectionStore } from "../storage/projection-store.js";
import type { Address, Hex } from "../shared/types.js";
import {
  resolveSupplierNotificationProfileFromUri,
  type SupplierNotificationProfile,
  type SupplierNotificationTransport
} from "./profile.js";

export type NotificationDeliveryStatus = "pending" | "sent" | "failed" | "skipped" | "dead_letter";
export type NotificationActivationStatus = "accepted" | "started" | "rejected";

export type NotificationSkippedReason =
  | "not_finalized"
  | "order_projection_missing"
  | "authorization_not_found"
  | "artifact_mapping_missing"
  | "supplier_trust_not_found"
  | "supplier_revoked"
  | "notification_profile_missing"
  | "transport_not_supported"
  | "executor_watch_self_managed"
  | "transport_adapter_missing";

export interface HookReadyNotificationPayload {
  readonly version: "uvp.hookReadyNotification.v1";
  readonly chainId: number;
  readonly stateMachineAddress: Address;
  readonly orderId: Hex;
  readonly hookId: Hex;
  readonly stageId: Hex;
  readonly taskId: string;
  readonly productTaskUrl?: string;
  readonly proof: HookReadyNotificationProof;
}

export interface HookReadyNotificationProof {
  readonly eventName: "HookReady";
  readonly chainId: number;
  readonly contractAddress: Address;
  readonly blockNumber: string;
  readonly transactionHash: Hex;
  readonly logIndex: number;
  readonly blockHash?: Hex;
}

export interface NotificationDeliveryRecord {
  readonly deliveryId: Hex;
  readonly status: NotificationDeliveryStatus;
  readonly taskId: string;
  readonly orderId: Hex;
  readonly hookId: Hex;
  readonly stageId: Hex;
  readonly chainId: number;
  readonly stateMachineAddress: Address;
  readonly submitter?: Address;
  readonly supplierSubjectId?: Hex;
  readonly supplierWallet?: Address;
  readonly transportType?: string;
  readonly activationStatus?: NotificationActivationStatus;
  readonly externalReceiptRef?: string;
  readonly reason?: NotificationSkippedReason | string;
  readonly payload: HookReadyNotificationPayload;
  readonly attempts: number;
  readonly lastError?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NotificationDeliveryQuery {
  readonly orderId?: string;
  readonly taskId?: string;
  readonly supplier?: string;
  readonly status?: NotificationDeliveryStatus;
}

export type ParticipantNotificationKind =
  | "task_ready"
  | "task_near_deadline"
  | "task_overdue"
  | "submission_confirmed"
  | "submission_failed"
  | "task_revoked"
  | "plan_revoked"
  | "supplier_revoked";

export type ParticipantNotificationSeverity = "info" | "action" | "warning" | "critical" | "success";
export type ParticipantNotificationReadStatus = "read" | "unread";

export interface ParticipantNotificationProof {
  readonly eventName: string;
  readonly chainId: number;
  readonly contractAddress: Address;
  readonly blockNumber: string;
  readonly transactionHash: Hex;
  readonly logIndex: number;
}

export interface ParticipantNotificationRecord {
  readonly notificationId: Hex;
  readonly kind: ParticipantNotificationKind;
  readonly severity: ParticipantNotificationSeverity;
  readonly readStatus: ParticipantNotificationReadStatus;
  readonly orderId: Hex;
  readonly orderTitle: string;
  readonly taskId?: string;
  readonly taskTitle?: string;
  readonly stageId?: string;
  readonly stageLabel?: string;
  readonly participantRole?: string;
  readonly eventLabel: string;
  readonly message: string;
  readonly actionHref: string;
  readonly proofHref?: string;
  readonly proof?: ParticipantNotificationProof;
  readonly createdAt: string;
  readonly readAt?: string;
  readonly source: "chain_projection" | "notification_delivery";
  readonly privacy: "participant_only";
}

export interface ParticipantNotificationQuery {
  readonly walletAddress?: Address | string;
}

export interface ParticipantNotificationReadInput {
  readonly walletAddress?: Address | string;
  readonly notificationId: Hex;
}

export interface ParticipantNotificationList {
  readonly notifications: readonly ParticipantNotificationRecord[];
  readonly unreadCount: number;
  readonly sourceOfTruth: "product-projection-and-notification-read-state";
}

export interface ParticipantNotificationReadState {
  readonly participantKey: string;
  readonly notificationId: Hex;
  readonly readAt: string;
}

export interface ParticipantNotificationReadStateStore {
  getReadState(participantKey: string, notificationId: Hex): Promise<ParticipantNotificationReadState | undefined>;
  markRead(state: ParticipantNotificationReadState): Promise<ParticipantNotificationReadState>;
}

export interface NotificationDeliveryStore {
  getDelivery(deliveryId: Hex): Promise<NotificationDeliveryRecord | undefined>;
  saveDelivery(record: NotificationDeliveryRecord): Promise<NotificationDeliveryRecord>;
  listDeliveries(query?: NotificationDeliveryQuery): Promise<readonly NotificationDeliveryRecord[]>;
}

export interface NotificationDispatchRequest {
  readonly record: NotificationDeliveryRecord;
  readonly profile: SupplierNotificationProfile;
  readonly transport: SupplierNotificationTransport;
}

export interface NotificationDispatchResult {
  readonly ok: boolean;
  readonly activationStatus?: NotificationActivationStatus;
  readonly externalReceiptRef?: string;
  readonly error?: string;
}

export interface NotificationDispatcher {
  send(request: NotificationDispatchRequest): Promise<NotificationDispatchResult>;
}

export interface NotificationProfileResolution {
  readonly supplier: SupplierTrustProjection;
  readonly profile?: SupplierNotificationProfile;
  readonly resolved: boolean;
  readonly reason?: string;
}

export interface NotificationRunSummary {
  readonly tasksScanned: number;
  readonly finalizedTasks: number;
  readonly deliveryIntents: number;
  readonly sent: number;
  readonly failed: number;
  readonly skipped: number;
  readonly existing: number;
  readonly notFinalized: number;
}

export interface NotificationService {
  runOnce(): Promise<NotificationRunSummary>;
  listProfiles(): Promise<readonly NotificationProfileResolution[]>;
  listDeliveries(query?: NotificationDeliveryQuery): Promise<readonly NotificationDeliveryRecord[]>;
  retryDelivery(deliveryId: Hex): Promise<NotificationDeliveryRecord | undefined>;
  deadLetterDelivery(deliveryId: Hex, reason?: string): Promise<NotificationDeliveryRecord | undefined>;
  listParticipantNotifications(query?: ParticipantNotificationQuery): Promise<ParticipantNotificationList>;
  markParticipantNotificationRead(input: ParticipantNotificationReadInput): Promise<ParticipantNotificationRecord | undefined>;
}

export interface CreateNotificationServiceOptions {
  readonly store: ProjectionStore;
  readonly deliveryStore?: NotificationDeliveryStore;
  readonly participantReadStateStore?: ParticipantNotificationReadStateStore;
  readonly dispatcher?: NotificationDispatcher;
  readonly profileResolver?: (metadataURI: string, supplier: SupplierTrustProjection) => Promise<SupplierNotificationProfile | undefined>;
  readonly productTaskBaseUrl?: string;
  readonly now?: () => Date;
}

export class MemoryNotificationDeliveryStore implements NotificationDeliveryStore {
  #deliveries = new Map<Hex, NotificationDeliveryRecord>();

  async getDelivery(deliveryId: Hex): Promise<NotificationDeliveryRecord | undefined> {
    return this.#deliveries.get(deliveryId);
  }

  async saveDelivery(record: NotificationDeliveryRecord): Promise<NotificationDeliveryRecord> {
    this.#deliveries.set(record.deliveryId, record);
    return record;
  }

  async listDeliveries(query: NotificationDeliveryQuery = {}): Promise<readonly NotificationDeliveryRecord[]> {
    const supplier = query.supplier?.toLowerCase();
    return [...this.#deliveries.values()]
      .filter((record) =>
        (!query.orderId || record.orderId.toLowerCase() === query.orderId.toLowerCase()) &&
        (!query.taskId || record.taskId === query.taskId) &&
        (!supplier ||
          record.supplierWallet?.toLowerCase() === supplier ||
          record.supplierSubjectId?.toLowerCase() === supplier) &&
        (!query.status || record.status === query.status)
      )
      .sort(compareDeliveryRecords);
  }
}

export class MemoryParticipantNotificationReadStateStore implements ParticipantNotificationReadStateStore {
  #states = new Map<string, ParticipantNotificationReadState>();

  async getReadState(participantKey: string, notificationId: Hex): Promise<ParticipantNotificationReadState | undefined> {
    return this.#states.get(readStateKey(participantKey, notificationId));
  }

  async markRead(state: ParticipantNotificationReadState): Promise<ParticipantNotificationReadState> {
    this.#states.set(readStateKey(state.participantKey, state.notificationId), state);
    return state;
  }
}

export function createNotificationService(options: CreateNotificationServiceOptions): NotificationService {
  const deliveryStore = options.deliveryStore ?? new MemoryNotificationDeliveryStore();
  const participantReadStateStore = options.participantReadStateStore ?? new MemoryParticipantNotificationReadStateStore();
  const resolveProfile = options.profileResolver ?? ((metadataURI: string) => resolveSupplierNotificationProfileFromUri(metadataURI));
  const now = () => (options.now ?? (() => new Date()))().toISOString();

  return {
    async runOnce() {
      const syncState = await options.store.getSyncState();
      const finalizedBlock = syncState?.finalizedBlock;
      const tasks = await options.store.listStateMachineTasks();
      const orders = await options.store.listStateMachineOrders();
      const suppliers = Object.values((await options.store.getTrustSnapshot()).suppliers);
      const summary: MutableNotificationRunSummary = {
        tasksScanned: tasks.length,
        finalizedTasks: 0,
        deliveryIntents: 0,
        sent: 0,
        failed: 0,
        skipped: 0,
        existing: 0,
        notFinalized: 0
      };

      for (const task of tasks) {
        if (finalizedBlock === undefined || task.createdAt.blockNumber > finalizedBlock) {
          summary.notFinalized += 1;
          continue;
        }
        summary.finalizedTasks += 1;

        const order = findOrderForTask(orders, task);
        if (!order) {
          await saveSkippedDelivery(
            deliveryStore,
            task,
            undefined,
            undefined,
            "order_projection_missing",
            undefined,
            options.productTaskBaseUrl,
            now
          );
          summary.deliveryIntents += 1;
          summary.skipped += 1;
          continue;
        }

        const authorizations = Object.values(order.authorizations);
        const matchingAuthorizations = authorizations.filter((authorization) => signalAuthorizationMatchesHook(authorization, task));
        if (matchingAuthorizations.length === 0) {
          const reason: NotificationSkippedReason = authorizations.length === 0
            ? "authorization_not_found"
            : "artifact_mapping_missing";
          const record = await saveSkippedDelivery(
            deliveryStore,
            task,
            undefined,
            undefined,
            reason,
            undefined,
            options.productTaskBaseUrl,
            now
          );
          updateIntentSummary(summary, record);
          continue;
        }

        for (const authorization of matchingAuthorizations.sort(compareAuthorizations)) {
          const supplierResolution = resolveSupplierForSubmitter(suppliers, authorization.submitter);
          if (supplierResolution.status === "not_found") {
            const record = await saveSkippedDelivery(
              deliveryStore,
              task,
              authorization,
              undefined,
              "supplier_trust_not_found",
              undefined,
              options.productTaskBaseUrl,
              now
            );
            updateIntentSummary(summary, record);
            continue;
          }
          if (supplierResolution.status === "revoked") {
            const record = await saveSkippedDelivery(
              deliveryStore,
              task,
              authorization,
              supplierResolution.supplier,
              "supplier_revoked",
              undefined,
              options.productTaskBaseUrl,
              now
            );
            updateIntentSummary(summary, record);
            continue;
          }

          const supplier = supplierResolution.supplier;
          const profile = await resolveProfile(supplier.metadataURI, supplier);
          if (!profile) {
            const record = await saveSkippedDelivery(
              deliveryStore,
              task,
              authorization,
              supplier,
              "notification_profile_missing",
              undefined,
              options.productTaskBaseUrl,
              now
            );
            updateIntentSummary(summary, record);
            continue;
          }

          const transport = chooseTransport(profile);
          if (!transport) {
            const record = await saveSkippedDelivery(
              deliveryStore,
              task,
              authorization,
              supplier,
              "transport_not_supported",
              undefined,
              options.productTaskBaseUrl,
              now
            );
            updateIntentSummary(summary, record);
            continue;
          }

          if (transport.type === "executor-watch") {
            const record = await saveSkippedDelivery(
              deliveryStore,
              task,
              authorization,
              supplier,
              "executor_watch_self_managed",
              transport.type,
              options.productTaskBaseUrl,
              now
            );
            updateIntentSummary(summary, record);
            continue;
          }

          if (!isPushTransport(transport)) {
            const record = await saveSkippedDelivery(
              deliveryStore,
              task,
              authorization,
              supplier,
              "transport_not_supported",
              transport.type,
              options.productTaskBaseUrl,
              now
            );
            updateIntentSummary(summary, record);
            continue;
          }

          if (!options.dispatcher) {
            const record = await saveSkippedDelivery(
              deliveryStore,
              task,
              authorization,
              supplier,
              "transport_adapter_missing",
              transport.type,
              options.productTaskBaseUrl,
              now
            );
            updateIntentSummary(summary, record);
            continue;
          }

          const record = await dispatchTransportDelivery({
            deliveryStore,
            dispatcher: options.dispatcher,
            task,
            authorization,
            supplier,
            profile,
            transport,
            ...(options.productTaskBaseUrl ? { productTaskBaseUrl: options.productTaskBaseUrl } : {}),
            now
          });
          updateIntentSummary(summary, record);
        }
      }

      return summary;
    },

    async listProfiles() {
      const suppliers = Object.values((await options.store.getTrustSnapshot()).suppliers);
      return Promise.all(suppliers.map(async (supplier) => {
        const profile = await resolveProfile(supplier.metadataURI, supplier);
        return {
          supplier,
          ...(profile ? { profile } : {}),
          resolved: Boolean(profile),
          ...(profile ? {} : { reason: "notification_profile_missing" })
        };
      }));
    },

    async listDeliveries(query = {}) {
      return deliveryStore.listDeliveries(query);
    },

    async retryDelivery(deliveryId) {
      const existing = await deliveryStore.getDelivery(deliveryId);
      if (!existing || existing.status === "sent") {
        return existing;
      }
      const { reason: _reason, lastError: _lastError, ...rest } = existing;
      return deliveryStore.saveDelivery({
        ...rest,
        status: "pending",
        updatedAt: now()
      });
    },

    async deadLetterDelivery(deliveryId, reason) {
      const existing = await deliveryStore.getDelivery(deliveryId);
      if (!existing) {
        return undefined;
      }
      return deliveryStore.saveDelivery({
        ...existing,
        status: "dead_letter",
        ...(reason ? { reason } : existing.reason ? { reason: existing.reason } : {}),
        updatedAt: now()
      });
    },

    async listParticipantNotifications(query = {}) {
      return buildParticipantNotificationList({
        store: options.store,
        deliveryStore,
        readStateStore: participantReadStateStore,
        query,
        now: options.now ?? (() => new Date())
      });
    },

    async markParticipantNotificationRead(input) {
      const participantKey = participantKeyFromWallet(input.walletAddress);
      if (!participantKey) {
        return undefined;
      }
      const readAt = now();
      await participantReadStateStore.markRead({
        participantKey,
        notificationId: input.notificationId,
        readAt
      });
      const list = await buildParticipantNotificationList({
        store: options.store,
        deliveryStore,
        readStateStore: participantReadStateStore,
        query: {
          ...(input.walletAddress ? { walletAddress: input.walletAddress } : {})
        },
        now: options.now ?? (() => new Date())
      });
      return list.notifications.find((notification) => notification.notificationId === input.notificationId);
    }
  };
}

async function buildParticipantNotificationList(input: {
  readonly store: ProjectionStore;
  readonly deliveryStore: NotificationDeliveryStore;
  readonly readStateStore: ParticipantNotificationReadStateStore;
  readonly query: ParticipantNotificationQuery;
  readonly now: () => Date;
}): Promise<ParticipantNotificationList> {
  const participantKey = participantKeyFromWallet(input.query.walletAddress);
  if (!participantKey) {
    return emptyParticipantNotificationList();
  }

  const [tasks, orders, trustSnapshot, deliveries] = await Promise.all([
    input.store.listStateMachineTasks(),
    input.store.listStateMachineOrders(),
    input.store.getTrustSnapshot(),
    input.deliveryStore.listDeliveries({ supplier: participantKey })
  ]);
  const visibleTasks = tasks
    .filter((task) => task.assigneeWallet?.toLowerCase() === participantKey)
    .sort(compareTasksForParticipantNotifications);
  const notifications = new Map<Hex, ParticipantNotificationRecord>();

  for (const task of visibleTasks) {
    const order = findOrderForTask(orders, task);
    const taskNotification = participantTaskNotification(task, order, input.now());
    if (taskNotification) {
      notifications.set(taskNotification.notificationId, taskNotification);
    }

    const planTrust = order ? revokedPlanTrustForOrder(trustSnapshot, order) : undefined;
    if (planTrust) {
      const planNotification = participantPlanRevokedNotification(task, order, planTrust);
      notifications.set(planNotification.notificationId, planNotification);
    }

    const supplierTrust = task.assigneeWallet ? revokedSupplierTrustForWallet(trustSnapshot, task.assigneeWallet) : undefined;
    if (supplierTrust) {
      const supplierNotification = participantSupplierRevokedNotification(task, order, supplierTrust);
      notifications.set(supplierNotification.notificationId, supplierNotification);
    }
  }

  for (const delivery of deliveries) {
    if (delivery.status !== "failed") {
      continue;
    }
    const task = tasks.find((item) => item.taskId === delivery.taskId);
    const order = task ? findOrderForTask(orders, task) : orders.find((item) => item.orderId === delivery.orderId);
    const failed = participantDeliveryFailedNotification(delivery, task, order);
    notifications.set(failed.notificationId, failed);
  }

  const withReadState: ParticipantNotificationRecord[] = [];
  for (const notification of notifications.values()) {
    const readState = await input.readStateStore.getReadState(participantKey, notification.notificationId);
    withReadState.push(readState
      ? {
          ...notification,
          readStatus: "read",
          readAt: readState.readAt
        }
      : notification);
  }
  const sorted = withReadState.sort(compareParticipantNotifications);
  return {
    notifications: sorted,
    unreadCount: sorted.filter((notification) => notification.readStatus === "unread").length,
    sourceOfTruth: "product-projection-and-notification-read-state"
  };
}

function emptyParticipantNotificationList(): ParticipantNotificationList {
  return {
    notifications: [],
    unreadCount: 0,
    sourceOfTruth: "product-projection-and-notification-read-state"
  };
}

function participantTaskNotification(
  task: StateMachineTaskProjection,
  order: StateMachineOrderProjection | undefined,
  now: Date
): ParticipantNotificationRecord | undefined {
  const hook = order?.hooks[task.hookId];
  const dueAt = dueAtDate(hook?.dueAt);
  const dueLabel = dueAt ? `，截止 ${formatDueAt(dueAt)}` : "";
  const base = participantNotificationBase(task, order);

  if (task.status === "submitted") {
    return {
      ...base,
      notificationId: participantNotificationId("submission_confirmed", task.taskId),
      kind: "submission_confirmed",
      severity: "success",
      eventLabel: "提交已确认",
      message: `${base.stageLabel ?? "当前阶段"} 的确认已写入链上索引。`,
      createdAt: provenanceTime(task.updatedAt),
      proof: notificationProof(task.proof)
    };
  }

  if (task.status === "cancelled") {
    return {
      ...base,
      notificationId: participantNotificationId("task_revoked", task.taskId),
      kind: "task_revoked",
      severity: "critical",
      eventLabel: "任务已撤销",
      message: `${base.stageLabel ?? "当前阶段"} 的链上条件已撤销，请在订单证明中核对原因。`,
      createdAt: provenanceTime(task.updatedAt),
      proof: notificationProof(task.proof)
    };
  }

  if (task.status !== "ready") {
    return undefined;
  }

  if (dueAt && dueAt.getTime() < now.getTime()) {
    return {
      ...base,
      notificationId: participantNotificationId("task_overdue", task.taskId, hook?.dueAt ?? ""),
      kind: "task_overdue",
      severity: "critical",
      eventLabel: "任务已逾期",
      message: `${base.participantRole ?? "当前参与方"} 负责的 ${base.stageLabel ?? "当前阶段"} 已超过 SLA${dueLabel}。`,
      createdAt: provenanceTime(task.updatedAt),
      proof: notificationProof(task.proof)
    };
  }

  if (dueAt && dueAt.getTime() - now.getTime() <= 24 * 60 * 60 * 1000) {
    return {
      ...base,
      notificationId: participantNotificationId("task_near_deadline", task.taskId, hook?.dueAt ?? ""),
      kind: "task_near_deadline",
      severity: "warning",
      eventLabel: "即将到期",
      message: `${base.participantRole ?? "当前参与方"} 负责的 ${base.stageLabel ?? "当前阶段"} 接近 SLA${dueLabel}。`,
      createdAt: provenanceTime(task.updatedAt),
      proof: notificationProof(task.proof)
    };
  }

  return {
    ...base,
    notificationId: participantNotificationId("task_ready", task.taskId),
    kind: "task_ready",
    severity: "action",
    eventLabel: "任务已就绪",
    message: `${base.participantRole ?? "当前参与方"} 需要处理 ${base.stageLabel ?? "当前阶段"}。`,
    createdAt: provenanceTime(task.createdAt),
    proof: notificationProof(task.proof)
  };
}

function participantPlanRevokedNotification(
  task: StateMachineTaskProjection,
  order: StateMachineOrderProjection | undefined,
  trust: PlanTrustProjection
): ParticipantNotificationRecord {
  return {
    ...participantNotificationBase(task, order),
    notificationId: participantNotificationId("plan_revoked", task.orderId, trust.planId, task.assigneeWallet ?? ""),
    kind: "plan_revoked",
    severity: "critical",
    eventLabel: "秩序背书已撤销",
    message: "当前订单关联的秩序背书已被撤销，继续处理前请核对订单证明和运营指引。",
    createdAt: provenanceTime(trust.revokedAt ?? trust.updatedAt),
    proof: {
      eventName: "PlanRevoked",
      chainId: trust.revokedAt?.chainId ?? trust.updatedAt.chainId,
      contractAddress: trust.revokedAt?.contractAddress ?? trust.updatedAt.contractAddress,
      blockNumber: (trust.revokedAt?.blockNumber ?? trust.updatedAt.blockNumber).toString(),
      transactionHash: trust.revokedAt?.transactionHash ?? trust.updatedAt.transactionHash,
      logIndex: trust.revokedAt?.logIndex ?? trust.updatedAt.logIndex
    }
  };
}

function participantSupplierRevokedNotification(
  task: StateMachineTaskProjection,
  order: StateMachineOrderProjection | undefined,
  trust: SupplierTrustProjection
): ParticipantNotificationRecord {
  return {
    ...participantNotificationBase(task, order),
    notificationId: participantNotificationId("supplier_revoked", trust.supplierSubjectId, task.orderId),
    kind: "supplier_revoked",
    severity: "critical",
    eventLabel: "参与方背书已撤销",
    message: "与你的钱包匹配的供应方背书已撤销；该提醒不改变任务状态，请以链上订单和运营审核为准。",
    createdAt: provenanceTime(trust.revokedAt ?? trust.updatedAt),
    proof: {
      eventName: "SupplierRevoked",
      chainId: trust.revokedAt?.chainId ?? trust.updatedAt.chainId,
      contractAddress: trust.revokedAt?.contractAddress ?? trust.updatedAt.contractAddress,
      blockNumber: (trust.revokedAt?.blockNumber ?? trust.updatedAt.blockNumber).toString(),
      transactionHash: trust.revokedAt?.transactionHash ?? trust.updatedAt.transactionHash,
      logIndex: trust.revokedAt?.logIndex ?? trust.updatedAt.logIndex
    }
  };
}

function participantDeliveryFailedNotification(
  delivery: NotificationDeliveryRecord,
  task: StateMachineTaskProjection | undefined,
  order: StateMachineOrderProjection | undefined
): ParticipantNotificationRecord {
  const base = task
    ? participantNotificationBase(task, order)
    : participantNotificationBaseFromDelivery(delivery, order);
  return {
    ...base,
    notificationId: participantNotificationId("submission_failed", delivery.deliveryId),
    kind: "submission_failed",
    severity: "warning",
    eventLabel: "外部通知失败",
    message: "外部渠道未确认收到提醒；任务和订单状态仍以链上索引为准。",
    createdAt: delivery.updatedAt,
    source: "notification_delivery"
  };
}

function participantNotificationBase(
  task: StateMachineTaskProjection,
  order: StateMachineOrderProjection | undefined
): Omit<ParticipantNotificationRecord, "notificationId" | "kind" | "severity" | "eventLabel" | "message" | "createdAt"> {
  const stageLabel = displayBytes32(task.stageIdentifier, "当前阶段");
  return {
    readStatus: "unread",
    orderId: task.orderId,
    orderTitle: orderTitle(order ?? task),
    taskId: task.taskId,
    taskTitle: taskTitle(task),
    stageId: displayBytes32(task.stageIdentifier, task.stageIdentifier),
    stageLabel,
    participantRole: displayParticipantRole(task.assigneeRole),
    actionHref: `/product/orders/${encodeURIComponent(task.orderId)}#task=${encodeURIComponent(task.taskId)}`,
    proofHref: `/product/orders/${encodeURIComponent(task.orderId)}/proof`,
    source: "chain_projection",
    privacy: "participant_only"
  };
}

function participantNotificationBaseFromDelivery(
  delivery: NotificationDeliveryRecord,
  order: StateMachineOrderProjection | undefined
): Omit<ParticipantNotificationRecord, "notificationId" | "kind" | "severity" | "eventLabel" | "message" | "createdAt"> {
  return {
    readStatus: "unread",
    orderId: delivery.orderId,
    orderTitle: orderTitle(order ?? delivery),
    taskId: delivery.taskId,
    taskTitle: "处理链上待办",
    stageId: displayBytes32(delivery.stageId, delivery.stageId),
    stageLabel: displayBytes32(delivery.stageId, "当前阶段"),
    actionHref: `/product/orders/${encodeURIComponent(delivery.orderId)}#task=${encodeURIComponent(delivery.taskId)}`,
    proofHref: `/product/orders/${encodeURIComponent(delivery.orderId)}/proof`,
    source: "notification_delivery",
    privacy: "participant_only"
  };
}

function participantNotificationId(kind: ParticipantNotificationKind, ...parts: readonly string[]): Hex {
  return keccak256(stringToBytes(["uvp:participant-notification:v1", kind, ...parts].join("|"))) as Hex;
}

function participantKeyFromWallet(walletAddress: Address | string | undefined): string | undefined {
  const trimmed = walletAddress?.trim().toLowerCase();
  return trimmed && /^0x[0-9a-f]{40}$/u.test(trimmed) ? trimmed : undefined;
}

function readStateKey(participantKey: string, notificationId: Hex): string {
  return `${participantKey}:${notificationId}`;
}

function dueAtDate(dueAt: string | undefined): Date | undefined {
  if (!dueAt) {
    return undefined;
  }
  const asNumber = Number(dueAt);
  if (Number.isFinite(asNumber) && asNumber > 0) {
    return new Date(asNumber * 1000);
  }
  const parsed = Date.parse(dueAt);
  return Number.isNaN(parsed) ? undefined : new Date(parsed);
}

function formatDueAt(date: Date): string {
  return date.toISOString().replace("T", " ").slice(0, 16);
}

function notificationProof(proof: StateMachineTaskProjection["proof"]): ParticipantNotificationProof {
  return {
    eventName: proof.eventName,
    chainId: proof.chainId,
    contractAddress: proof.contractAddress,
    blockNumber: proof.blockNumber.toString(),
    transactionHash: proof.transactionHash,
    logIndex: proof.logIndex
  };
}

function revokedPlanTrustForOrder(
  trustSnapshot: TrustProjectionSnapshot,
  order: StateMachineOrderProjection
): PlanTrustProjection | undefined {
  const matches = Object.values(trustSnapshot.plans).filter((trust) =>
    trust.planId === order.planId &&
    (!order.planHash || trust.planHash === order.planHash)
  );
  if (matches.some((trust) => !trust.revoked)) {
    return undefined;
  }
  return matches.find((trust) => trust.revoked);
}

function revokedSupplierTrustForWallet(
  trustSnapshot: TrustProjectionSnapshot,
  wallet: Address
): SupplierTrustProjection | undefined {
  const matches = Object.values(trustSnapshot.suppliers)
    .filter((trust) => trust.wallet.toLowerCase() === wallet.toLowerCase())
    .sort(compareSuppliersForDelivery);
  if (matches.some((trust) => !trust.revoked)) {
    return undefined;
  }
  return matches.find((trust) => trust.revoked);
}

function orderTitle(input: StateMachineOrderProjection | StateMachineTaskProjection | NotificationDeliveryRecord): string {
  return `链上订单 ${shortId(input.orderId)}`;
}

function taskTitle(task: StateMachineTaskProjection): string {
  const hookLabel = displayBytes32(task.hookName, "链上待办");
  return hookLabel === "链上待办" ? "处理链上待办" : `处理${hookLabel}`;
}

function displayParticipantRole(role: string): string {
  switch (role) {
    case "authorized_submitter":
      return "链上授权执行方";
    case "unknown":
      return "待分配角色";
    default:
      return role;
  }
}

function displayBytes32(value: string | undefined, fallback: string): string {
  if (!value) {
    return fallback;
  }
  if (!/^0x[0-9a-fA-F]{64}$/u.test(value)) {
    return value;
  }
  const hex = value.slice(2);
  const bytes = Buffer.from(hex, "hex");
  const end = bytes.indexOf(0);
  const text = bytes.slice(0, end >= 0 ? end : undefined).toString("utf8").trim();
  return text.length > 0 && /^[\p{Letter}\p{Number}\p{Punctuation}\p{Separator}]+$/u.test(text)
    ? text
    : shortId(value);
}

function shortId(value: string): string {
  return value.length > 18 ? `${value.slice(0, 10)}...${value.slice(-6)}` : value;
}

function provenanceTime(provenance: {
  readonly blockNumber: bigint;
}): string {
  return `block ${provenance.blockNumber.toString()}`;
}

function compareTasksForParticipantNotifications(
  left: StateMachineTaskProjection,
  right: StateMachineTaskProjection
): number {
  if (left.updatedAt.blockNumber !== right.updatedAt.blockNumber) {
    return left.updatedAt.blockNumber > right.updatedAt.blockNumber ? -1 : 1;
  }
  return left.taskId.localeCompare(right.taskId);
}

function compareParticipantNotifications(
  left: ParticipantNotificationRecord,
  right: ParticipantNotificationRecord
): number {
  const severity = severityRank(right.severity) - severityRank(left.severity);
  if (severity !== 0) {
    return severity;
  }
  if (left.createdAt !== right.createdAt) {
    return right.createdAt.localeCompare(left.createdAt);
  }
  return left.notificationId.localeCompare(right.notificationId);
}

function severityRank(severity: ParticipantNotificationSeverity): number {
  switch (severity) {
    case "critical":
      return 4;
    case "warning":
      return 3;
    case "action":
      return 2;
    case "success":
      return 1;
    case "info":
      return 0;
  }
}

type MutableNotificationRunSummary = {
  -readonly [TKey in keyof NotificationRunSummary]: NotificationRunSummary[TKey];
};

type SupplierResolution =
  | { readonly status: "attested" | "revoked"; readonly supplier: SupplierTrustProjection }
  | { readonly status: "not_found" };

async function dispatchTransportDelivery(input: {
  readonly deliveryStore: NotificationDeliveryStore;
  readonly dispatcher: NotificationDispatcher;
  readonly task: StateMachineTaskProjection;
  readonly authorization: StateMachineSignalAuthorizationProjection;
  readonly supplier: SupplierTrustProjection;
  readonly profile: SupplierNotificationProfile;
  readonly transport: SupplierNotificationTransport;
  readonly productTaskBaseUrl?: string;
  readonly now: () => string;
}): Promise<NotificationDeliveryRecord> {
  const deliveryId = deliveryIdFor(input.task, input.authorization);
  const existing = await input.deliveryStore.getDelivery(deliveryId);
  if (existing && existing.status !== "pending" && existing.status !== "failed") {
    return existing;
  }

  const pending = await input.deliveryStore.saveDelivery({
    ...(existing ?? baseDeliveryRecord(
      input.task,
      input.authorization,
      input.supplier,
      input.transport.type,
      input.productTaskBaseUrl,
      input.profile,
      input.now
    )),
    status: "pending",
    updatedAt: input.now()
  });

  try {
    const result = await input.dispatcher.send({
      record: pending,
      profile: input.profile,
      transport: input.transport
    });
    return input.deliveryStore.saveDelivery({
      ...pending,
      status: result.ok ? "sent" : "failed",
      attempts: pending.attempts + 1,
      ...activationStatusForResult(input.transport, result),
      ...(result.externalReceiptRef ? { externalReceiptRef: result.externalReceiptRef } : {}),
      ...(result.error ? { lastError: result.error } : {}),
      updatedAt: input.now()
    });
  } catch (error) {
    return input.deliveryStore.saveDelivery({
      ...pending,
      status: "failed",
      attempts: pending.attempts + 1,
      lastError: error instanceof Error ? error.message : "notification dispatch failed",
      updatedAt: input.now()
    });
  }
}

async function saveSkippedDelivery(
  deliveryStore: NotificationDeliveryStore,
  task: StateMachineTaskProjection,
  authorization: StateMachineSignalAuthorizationProjection | undefined,
  supplier: SupplierTrustProjection | undefined,
  reason: NotificationSkippedReason,
  transportType: string | undefined,
  productTaskBaseUrl: string | undefined,
  now: () => string
): Promise<NotificationDeliveryRecord> {
  const deliveryId = deliveryIdFor(task, authorization);
  const existing = await deliveryStore.getDelivery(deliveryId);
  if (existing && existing.status !== "pending") {
    return existing;
  }
  return deliveryStore.saveDelivery({
    ...baseDeliveryRecord(task, authorization, supplier, transportType, productTaskBaseUrl, undefined, now),
    status: "skipped",
    reason,
    updatedAt: now()
  });
}

function baseDeliveryRecord(
  task: StateMachineTaskProjection,
  authorization: StateMachineSignalAuthorizationProjection | undefined,
  supplier: SupplierTrustProjection | undefined,
  transportType: string | undefined,
  productTaskBaseUrl: string | undefined,
  profile: SupplierNotificationProfile | undefined,
  now: () => string
): NotificationDeliveryRecord {
  const createdAt = now();
  return {
    deliveryId: deliveryIdFor(task, authorization),
    status: "pending",
    taskId: task.taskId,
    orderId: task.orderId,
    hookId: task.hookId,
    stageId: task.stageIdentifier,
    chainId: task.proof.chainId,
    stateMachineAddress: task.stateMachineAddress,
    ...(authorization ? { submitter: authorization.submitter } : {}),
    ...(supplier ? { supplierSubjectId: supplier.supplierSubjectId, supplierWallet: supplier.wallet } : {}),
    ...(transportType ? { transportType } : {}),
    payload: payloadForTask(task, productTaskBaseUrl, profile),
    attempts: 0,
    createdAt,
    updatedAt: createdAt
  };
}

function payloadForTask(
  task: StateMachineTaskProjection,
  productTaskBaseUrl: string | undefined,
  profile: SupplierNotificationProfile | undefined
): HookReadyNotificationPayload {
  const productTaskUrl = productTaskUrlForTask(task, productTaskBaseUrl, profile);
  return {
    version: "uvp.hookReadyNotification.v1",
    chainId: task.proof.chainId,
    stateMachineAddress: task.stateMachineAddress,
    orderId: task.orderId,
    hookId: task.hookId,
    stageId: task.stageIdentifier,
    taskId: task.taskId,
    ...(productTaskUrl ? { productTaskUrl } : {}),
    proof: {
      eventName: "HookReady",
      chainId: task.proof.chainId,
      contractAddress: task.proof.contractAddress,
      blockNumber: task.proof.blockNumber.toString(),
      transactionHash: task.proof.transactionHash,
      logIndex: task.proof.logIndex,
      ...(task.proof.blockHash ? { blockHash: task.proof.blockHash } : {})
    }
  };
}

function productTaskUrlForTask(
  task: StateMachineTaskProjection,
  productTaskBaseUrl: string | undefined,
  profile: SupplierNotificationProfile | undefined
): string | undefined {
  if (profile?.productTaskUrlTemplate) {
    return profile.productTaskUrlTemplate
      .replaceAll("{taskId}", encodeURIComponent(task.taskId))
      .replaceAll("{orderId}", encodeURIComponent(task.orderId))
      .replaceAll(":taskId", encodeURIComponent(task.taskId))
      .replaceAll(":orderId", encodeURIComponent(task.orderId));
  }
  return productTaskBaseUrl
    ? `${productTaskBaseUrl.replace(/\/$/u, "")}/product/tasks/${encodeURIComponent(task.taskId)}`
    : undefined;
}

function chooseTransport(profile: SupplierNotificationProfile): SupplierNotificationTransport | undefined {
  const enabled = profile.transports
    .map((transport, index) => ({ transport, index }))
    .filter(({ transport }) => transport.enabled !== false)
    .sort(compareTransportPreference);
  return enabled.find(({ transport }) => isPushTransport(transport) || transport.type === "executor-watch")?.transport ??
    enabled[0]?.transport;
}

function isPushTransport(transport: SupplierNotificationTransport): boolean {
  return transport.type === "webhook" ||
    transport.type === "slack" ||
    transport.type === "email" ||
    transport.type === "mcp";
}

function activationStatusForResult(
  transport: SupplierNotificationTransport,
  result: NotificationDispatchResult
): Partial<NotificationDeliveryRecord> {
  if (result.activationStatus) {
    return { activationStatus: result.activationStatus };
  }
  if (transport.type === "mcp" && result.ok) {
    return { activationStatus: "accepted" };
  }
  if (transport.type === "mcp" && !result.ok) {
    return { activationStatus: "rejected" };
  }
  return {};
}

function compareTransportPreference(
  left: { readonly transport: SupplierNotificationTransport; readonly index: number },
  right: { readonly transport: SupplierNotificationTransport; readonly index: number }
): number {
  const leftPriority = left.transport.priority ?? Number.MAX_SAFE_INTEGER;
  const rightPriority = right.transport.priority ?? Number.MAX_SAFE_INTEGER;
  return leftPriority === rightPriority ? left.index - right.index : leftPriority - rightPriority;
}

function resolveSupplierForSubmitter(
  suppliers: readonly SupplierTrustProjection[],
  submitter: Address
): SupplierResolution {
  const matches = suppliers
    .filter((supplier) => supplier.wallet.toLowerCase() === submitter.toLowerCase())
    .sort(compareSuppliersForDelivery);
  const active = matches.find((supplier) => !supplier.revoked);
  if (active) {
    return { status: "attested", supplier: active };
  }
  const revoked = matches[0];
  return revoked ? { status: "revoked", supplier: revoked } : { status: "not_found" };
}

function findOrderForTask(
  orders: readonly StateMachineOrderProjection[],
  task: StateMachineTaskProjection
): StateMachineOrderProjection | undefined {
  return orders.find((order) =>
    order.orderId === task.orderId &&
    order.contractAddress === task.stateMachineAddress &&
    Object.hasOwn(order.tasks, task.taskId)
  );
}

function deliveryIdFor(
  task: StateMachineTaskProjection,
  authorization: StateMachineSignalAuthorizationProjection | undefined
): Hex {
  return keccak256(stringToBytes([
    "uvp:notification-delivery:v1",
    task.proof.chainId.toString(),
    task.stateMachineAddress.toLowerCase(),
    task.taskId,
    authorization?.submitter.toLowerCase() ?? "unroutable"
  ].join("|"))) as Hex;
}

function updateIntentSummary(
  summary: MutableNotificationRunSummary,
  record: NotificationDeliveryRecord
): void {
  summary.deliveryIntents += 1;
  switch (record.status) {
    case "sent":
      summary.sent += 1;
      return;
    case "failed":
      summary.failed += 1;
      return;
    case "skipped":
      summary.skipped += 1;
      return;
    case "pending":
      return;
    case "dead_letter":
      summary.existing += 1;
      return;
  }
}

function compareDeliveryRecords(left: NotificationDeliveryRecord, right: NotificationDeliveryRecord): number {
  if (left.createdAt !== right.createdAt) {
    return left.createdAt.localeCompare(right.createdAt);
  }
  return left.deliveryId.localeCompare(right.deliveryId);
}

function compareAuthorizations(
  left: StateMachineSignalAuthorizationProjection,
  right: StateMachineSignalAuthorizationProjection
): number {
  if (left.authorizedAt.blockNumber !== right.authorizedAt.blockNumber) {
    return left.authorizedAt.blockNumber < right.authorizedAt.blockNumber ? -1 : 1;
  }
  if (left.authorizedAt.logIndex !== right.authorizedAt.logIndex) {
    return left.authorizedAt.logIndex - right.authorizedAt.logIndex;
  }
  return left.submitter.localeCompare(right.submitter);
}

function compareSuppliersForDelivery(left: SupplierTrustProjection, right: SupplierTrustProjection): number {
  if (left.revoked !== right.revoked) {
    return left.revoked ? 1 : -1;
  }
  if (left.updatedAt.blockNumber !== right.updatedAt.blockNumber) {
    return left.updatedAt.blockNumber > right.updatedAt.blockNumber ? -1 : 1;
  }
  return left.supplierSubjectId.localeCompare(right.supplierSubjectId);
}
