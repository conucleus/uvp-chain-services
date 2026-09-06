import { keccak256, stringToBytes } from "viem";
import {
  assertOnchainHookPlanArtifact,
  onchainSignalId,
  onchainSignalKey,
  type OnchainCompiledHook,
  type OnchainHookPlanArtifact
} from "@uvp-eth/compiler";
import {
  signalAuthorizationMatchesHook,
  stateMachineOrderProjectionKey,
  type StateMachineOrderProjection,
  type StateMachineSignalAuthorizationProjection,
  type StateMachineSignalProjection,
  type StateMachineTaskProjection
} from "../indexer/projections.js";
import { chainEventKey, filterActiveChainEvents, type ChainEvent } from "../indexer/events.js";
import type { ProjectionStore } from "../storage/projection-store.js";
import { redactErrorMessage } from "../security/redaction.js";
import { compareChainPointers, type Address, type Hex } from "../shared/types.js";
import type { ProductSchemaResolver } from "../product/service.js";
import type { StoreSupplierMetadataRecord, StoreSupplierMetadataStore } from "../store-suppliers/types.js";
import {
  type SupplierNotificationProfile,
  type SupplierNotificationTransport
} from "./profile.js";

export type NotificationDeliveryStatus = "pending" | "sent" | "failed" | "skipped" | "dead_letter";
export type NotificationActivationStatus = "accepted" | "started" | "rejected";

export type NotificationSkippedReason =
  | "not_finalized"
  | "order_projection_missing"
  | "signal_projection_missing"
  | "artifact_mapping_missing"
  | "receiver_not_found"
  | "receiver_ambiguous"
  | "store_supplier_not_found"
  | "store_supplier_ambiguous"
  | "notification_profile_missing"
  | "transport_not_supported"
  | "executor_watch_self_managed"
  | "transport_adapter_missing";

export interface SignalNotificationPayload {
  readonly version: "uvp.signalReceivedNotification.v1";
  readonly chainId: number;
  readonly stateMachineAddress: Address;
  readonly orderId: Hex;
  readonly sourceId: Hex;
  readonly signalId: Hex;
  readonly payloadHash: Hex;
  readonly idempotencyKey: Hex;
  readonly signalSubmitter: Address;
  readonly receiverHookId: Hex;
  readonly receiverStageId: Hex;
  readonly receiverSupplierSubjectId: Hex;
  readonly receiverWallet: Address;
  readonly proof: SignalNotificationProof;
}

export interface SignalNotificationProof {
  readonly eventName: "SignalSubmitted";
  readonly chainId: number;
  readonly contractAddress: Address;
  readonly blockNumber: string;
  readonly transactionIndex?: number;
  readonly transactionHash: Hex;
  readonly logIndex: number;
  readonly blockHash?: Hex;
}

export type NotificationPayload = SignalNotificationPayload;
export type NotificationDeliveryKind = "signal_received";

export interface NotificationDeliveryRecord {
  readonly deliveryId: Hex;
  readonly kind: NotificationDeliveryKind;
  readonly status: NotificationDeliveryStatus;
  readonly taskId?: string;
  readonly orderId: Hex;
  readonly receiverHookId?: Hex;
  readonly receiverStageId?: Hex;
  readonly sourceId?: Hex;
  readonly signalId?: Hex;
  readonly payloadHash?: Hex;
  readonly idempotencyKey?: Hex;
  readonly chainId: number;
  readonly stateMachineAddress: Address;
  readonly submitter?: Address;
  readonly supplierSubjectId?: Hex;
  readonly supplierWallet?: Address;
  readonly transportType?: string;
  readonly activationStatus?: NotificationActivationStatus;
  readonly externalReceiptRef?: string;
  readonly reason?: NotificationSkippedReason | string;
  readonly payload: NotificationPayload;
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
  | "signal_submitted"
  | "submission_confirmed"
  | "submission_failed"
  | "task_revoked";

export type ParticipantNotificationSeverity = "info" | "action" | "warning" | "critical" | "success";
export type ParticipantNotificationReadStatus = "read" | "unread";

export interface ParticipantNotificationProof {
  readonly eventName: string;
  readonly chainId: number;
  readonly contractAddress: Address;
  readonly blockNumber: string;
  readonly transactionIndex?: number;
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

export type NotificationRedactedEvidenceStatus = "verified" | "not-verified";
export type NotificationRecipientClassificationKind = "ready_task" | "submission" | "blocked" | "dead_letter";
export type NotificationRecipientClassificationSource =
  | "product_task_projection"
  | "notification_delivery_with_product_task_projection";

export interface NotificationRedactedEvidenceQuery {
  readonly orderId?: string;
  readonly taskId?: string;
  readonly walletAddress?: Address | string;
}

export interface NotificationRecipientClassification {
  readonly kind: NotificationRecipientClassificationKind;
  readonly source: NotificationRecipientClassificationSource;
  readonly orderId: Hex;
  readonly taskId: string;
  readonly taskStatus: StateMachineTaskProjection["status"];
  readonly recipientRole: string;
  readonly recipientWallet?: Address;
  readonly stageId: Hex;
  readonly hookId: Hex;
  readonly proof: ParticipantNotificationProof;
  readonly deliveryId?: Hex;
  readonly deliveryStatus?: NotificationDeliveryStatus;
  readonly deliveryReasonCode?: string;
  readonly deliveryProof?: ParticipantNotificationProof;
}

export interface NotificationRedactedEvidence {
  readonly schemaVersion: "uvp.notification-redacted-evidence.v1";
  readonly generatedAt: string;
  readonly status: NotificationRedactedEvidenceStatus;
  readonly sourceOfTruth: "chain-product-task-projection-and-notification-delivery-workflow";
  readonly query: NotificationRedactedEvidenceQuery;
  readonly counts: {
    readonly totalClassifications: number;
    readonly readyTaskRecipients: number;
    readonly submissionRecipients: number;
    readonly blockedRecipients: number;
    readonly deadLetterRecipients: number;
    readonly deliveryRowsWithoutTaskProjection: number;
  };
  readonly classifications: readonly NotificationRecipientClassification[];
  readonly notes: readonly string[];
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
  readonly supplier: StoreSupplierMetadataRecord;
  readonly profile?: SupplierNotificationProfile;
  readonly resolved: boolean;
  readonly reason?: string;
}

export interface NotificationRunSummary {
  readonly signalsProcessed: number;
  readonly receiverHooksMatched: number;
  readonly deliveryIntents: number;
  readonly sent: number;
  readonly failed: number;
  readonly skipped: number;
  readonly existing: number;
}

export type NotificationProcessSummary = NotificationRunSummary;

export interface NotificationService {
  processSignalSubmittedEvents(events: readonly ChainEvent[]): Promise<NotificationProcessSummary>;
  listProfiles(): Promise<readonly NotificationProfileResolution[]>;
  listDeliveries(query?: NotificationDeliveryQuery): Promise<readonly NotificationDeliveryRecord[]>;
  retryDelivery(deliveryId: Hex): Promise<NotificationDeliveryRecord | undefined>;
  deadLetterDelivery(deliveryId: Hex, reason?: string): Promise<NotificationDeliveryRecord | undefined>;
  listParticipantNotifications(query?: ParticipantNotificationQuery): Promise<ParticipantNotificationList>;
  markParticipantNotificationRead(input: ParticipantNotificationReadInput): Promise<ParticipantNotificationRecord | undefined>;
  buildRedactedEvidence(query?: NotificationRedactedEvidenceQuery): Promise<NotificationRedactedEvidence>;
}

export interface CreateNotificationServiceOptions {
  readonly store: ProjectionStore;
  readonly supplierMetadataStore?: StoreSupplierMetadataStore;
  readonly productSchemaResolver?: ProductSchemaResolver;
  readonly planArtifactResolver?: (order: StateMachineOrderProjection) => Promise<OnchainHookPlanArtifact | undefined>;
  readonly deliveryStore?: NotificationDeliveryStore;
  readonly participantReadStateStore?: ParticipantNotificationReadStateStore;
  readonly dispatcher?: NotificationDispatcher;
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
  const now = () => (options.now ?? (() => new Date()))().toISOString();

  return {
    async processSignalSubmittedEvents(events) {
      const syncState = await options.store.getSyncState();
      const finalizedBlock = syncState?.finalizedBlock;
      const summary: MutableNotificationRunSummary = {
        signalsProcessed: 0,
        receiverHooksMatched: 0,
        deliveryIntents: 0,
        sent: 0,
        failed: 0,
        skipped: 0,
        existing: 0
      };

      const signalEvents = finalizedSignalSubmittedEvents(events, finalizedBlock);
      for (const event of signalEvents) {
        const orderId = bytes32Arg(event, "orderId");
        const planId = bytes32Arg(event, "planId");
        const sourceId = bytes32Arg(event, "sourceId");
        const signalId = bytes32Arg(event, "signalId");
        // SignalSubmitted is plan-scoped on the frozen state-machine ABI.
        // An event without a decodable planId is isolated like the indexer's
        // undecodable logs (skipped without a delivery record): bare order
        // ids never resolve, so two plans reusing the same orderId cannot
        // receive each other's notification.
        if (!planId || !orderId) {
          continue;
        }
        const order = await options.store.getStateMachineOrder(
          stateMachineOrderProjectionKey(event.chainId, event.contractAddress, planId, orderId)
        );
        if (!order) {
          updateIntentSummary(summary, await saveSkippedSignalDelivery({
            deliveryStore,
            event,
            order: undefined,
            signal: undefined,
            receiverHook: undefined,
            supplierMetadata: undefined,
            reason: "order_projection_missing",
            transportType: undefined,
            now
          }));
          continue;
        }
        const signal = sourceId && signalId ? order.signals[`${sourceId}:${signalId}`] : undefined;
        if (!signal) {
          updateIntentSummary(summary, await saveSkippedSignalDelivery({
            deliveryStore,
            event,
            order,
            signal: undefined,
            receiverHook: undefined,
            supplierMetadata: undefined,
            reason: "signal_projection_missing",
            transportType: undefined,
            now
          }));
          continue;
        }
        summary.signalsProcessed += 1;
        const supplierRows = await options.supplierMetadataStore?.listSuppliers() ?? [];
        const artifact = await resolvePlanArtifact(options, order);
        if (!artifact) {
          updateIntentSummary(summary, await saveSkippedSignalDelivery({
            deliveryStore,
            event,
            order,
            signal,
            receiverHook: undefined,
            supplierMetadata: undefined,
            reason: "artifact_mapping_missing",
            transportType: undefined,
            now
          }));
          continue;
        }

        const receiverHooks = [...receiverHooksForSignal(artifact, signal)].sort(compareReceiverHooks);
        summary.receiverHooksMatched += receiverHooks.length;
        for (const receiverHook of receiverHooks) {
          const resolution = resolveReceiverSupplier(order, receiverHook, supplierRows);
          if (resolution.status !== "ok") {
            updateIntentSummary(summary, await saveSkippedSignalDelivery({
              deliveryStore,
              event,
              order,
              signal,
              receiverHook,
              supplierMetadata: resolution.supplierMetadata,
              reason: resolution.reason,
              transportType: undefined,
              now
            }));
            continue;
          }
          const profile = resolution.supplierMetadata.notificationProfile;
          if (!profile) {
            updateIntentSummary(summary, await saveSkippedSignalDelivery({
              deliveryStore,
              event,
              order,
              signal,
              receiverHook,
              supplierMetadata: resolution.supplierMetadata,
              reason: "notification_profile_missing",
              transportType: undefined,
              now
            }));
            continue;
          }
          const transport = chooseTransport(profile);
          if (!transport) {
            updateIntentSummary(summary, await saveSkippedSignalDelivery({
              deliveryStore,
              event,
              order,
              signal,
              receiverHook,
              supplierMetadata: resolution.supplierMetadata,
              reason: "transport_not_supported",
              transportType: undefined,
              now
            }));
            continue;
          }
          if (transport.type === "executor-watch") {
            updateIntentSummary(summary, await saveSkippedSignalDelivery({
              deliveryStore,
              event,
              order,
              signal,
              receiverHook,
              supplierMetadata: resolution.supplierMetadata,
              reason: "executor_watch_self_managed",
              transportType: transport.type,
              now
            }));
            continue;
          }
          if (!isPushTransport(transport)) {
            updateIntentSummary(summary, await saveSkippedSignalDelivery({
              deliveryStore,
              event,
              order,
              signal,
              receiverHook,
              supplierMetadata: resolution.supplierMetadata,
              reason: "transport_not_supported",
              transportType: transport.type,
              now
            }));
            continue;
          }
          const record = await dispatchSignalTransportDelivery({
            deliveryStore,
            ...(options.dispatcher ? { dispatcher: options.dispatcher } : {}),
            event,
            order,
            signal,
            receiverHook,
            supplierMetadata: resolution.supplierMetadata,
            profile,
            transport,
            now
          });
          updateIntentSummary(summary, record);
        }
      }

      return summary;
    },

    async listProfiles() {
      const supplierRows = await options.supplierMetadataStore?.listSuppliers() ?? [];
      return supplierRows.map((supplier) => {
        const profile = supplier.notificationProfile;
        return {
          supplier,
          ...(profile ? { profile } : {}),
          resolved: Boolean(profile),
          ...(profile ? {} : { reason: "notification_profile_missing" })
        };
      });
    },

    async listDeliveries(query = {}) {
      return deliveryStore.listDeliveries(query);
    },

    async retryDelivery(deliveryId) {
      const existing = await deliveryStore.getDelivery(deliveryId);
      // Sent and dead-lettered rows are terminal until an operator explicitly
      // reopens them; a skipped row (for example, no configured dispatcher)
      // is safe to retry after the missing dependency is restored.
      if (!existing || existing.status === "sent" || existing.status === "dead_letter") {
        return existing;
      }
      const { reason: _reason, lastError: _lastError, ...rest } = existing;
      const pending = await deliveryStore.saveDelivery({
        ...rest,
        status: "pending",
        updatedAt: now()
      });
      const resolved = await resolveRetryTransport(options, pending);
      if (resolved.status !== "ok") {
        return deliveryStore.saveDelivery({
          ...pending,
          status: "skipped",
          reason: resolved.reason,
          updatedAt: now()
        });
      }
      return dispatchPreparedDelivery({
        deliveryStore,
        ...(options.dispatcher ? { dispatcher: options.dispatcher } : {}),
        pending,
        profile: resolved.profile,
        transport: resolved.transport,
        now
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
    },

    async buildRedactedEvidence(query = {}) {
      return buildNotificationRedactedEvidence({
        store: options.store,
        deliveryStore,
        query,
        now: options.now ?? (() => new Date())
      });
    }
  };
}

async function buildNotificationRedactedEvidence(input: {
  readonly store: ProjectionStore;
  readonly deliveryStore: NotificationDeliveryStore;
  readonly query: NotificationRedactedEvidenceQuery;
  readonly now: () => Date;
}): Promise<NotificationRedactedEvidence> {
  const participantKey = participantKeyFromWallet(input.query.walletAddress);
  const [tasks, deliveries] = await Promise.all([
    input.store.listStateMachineTasks(),
    input.deliveryStore.listDeliveries()
  ]);
  const matchingTasks = tasks
    .filter((task) => taskMatchesNotificationEvidenceQuery(task, input.query, participantKey))
    .sort(compareTasksForParticipantNotifications);
  const classifications: NotificationRecipientClassification[] = [];

  for (const task of matchingTasks) {
    if (task.status === "ready") {
      classifications.push(taskRecipientClassification("ready_task", task));
    } else if (task.status === "submitted") {
      classifications.push(taskRecipientClassification("submission", task));
    }
  }

  let deliveryRowsWithoutTaskProjection = 0;
  for (const delivery of [...deliveries].sort(compareDeliveryRecords)) {
    if (!deliveryStatusRequiresRecipientEvidence(delivery.status)) {
      continue;
    }
    if (!deliveryMatchesNotificationEvidenceQuery(delivery, input.query, participantKey)) {
      continue;
    }
    const task = delivery.taskId
      ? uniqueTaskForDelivery(tasks, delivery)
      : undefined;
    if (!task || !taskMatchesNotificationEvidenceQuery(task, input.query, participantKey)) {
      deliveryRowsWithoutTaskProjection += 1;
      continue;
    }
    classifications.push(deliveryRecipientClassification(delivery, task));
  }

  const counts = {
    totalClassifications: classifications.length,
    readyTaskRecipients: classifications.filter((item) => item.kind === "ready_task").length,
    submissionRecipients: classifications.filter((item) => item.kind === "submission").length,
    blockedRecipients: classifications.filter((item) => item.kind === "blocked").length,
    deadLetterRecipients: classifications.filter((item) => item.kind === "dead_letter").length,
    deliveryRowsWithoutTaskProjection
  };
  return {
    schemaVersion: "uvp.notification-redacted-evidence.v1",
    generatedAt: input.now().toISOString(),
    status: classifications.length > 0 && deliveryRowsWithoutTaskProjection === 0 ? "verified" : "not-verified",
    sourceOfTruth: "chain-product-task-projection-and-notification-delivery-workflow",
    query: redactedEvidenceQuery(input.query),
    counts,
    classifications,
    notes: [
      "Recipient classification is derived from chain-rebuilt Product task projections.",
      "Notification delivery rows only contribute blocked/dead-letter workflow status when they resolve to a projected task.",
      "This evidence omits notification payloads, transport endpoints, external receipts, raw errors, signatures, bearer tokens, and plaintext evidence."
    ]
  };
}

function taskRecipientClassification(
  kind: "ready_task" | "submission",
  task: StateMachineTaskProjection
): NotificationRecipientClassification {
  return {
    kind,
    source: "product_task_projection",
    orderId: task.orderId,
    taskId: task.taskId,
    taskStatus: task.status,
    recipientRole: task.assigneeRole,
    ...(task.assigneeWallet ? { recipientWallet: task.assigneeWallet } : {}),
    stageId: task.stageIdentifier,
    hookId: task.hookId,
    proof: notificationProof(task.proof)
  };
}

function deliveryRecipientClassification(
  delivery: NotificationDeliveryRecord,
  task: StateMachineTaskProjection
): NotificationRecipientClassification {
  return {
    kind: delivery.status === "dead_letter" ? "dead_letter" : "blocked",
    source: "notification_delivery_with_product_task_projection",
    orderId: task.orderId,
    taskId: task.taskId,
    taskStatus: task.status,
    recipientRole: task.assigneeRole,
    ...(task.assigneeWallet ? { recipientWallet: task.assigneeWallet } : {}),
    stageId: task.stageIdentifier,
    hookId: task.hookId,
    proof: notificationProof(task.proof),
    deliveryId: delivery.deliveryId,
    deliveryStatus: delivery.status,
    ...(delivery.reason ? { deliveryReasonCode: redactedDeliveryReasonCode(delivery.reason) } : {}),
    deliveryProof: signalPayloadNotificationProof(delivery.payload.proof)
  };
}

function redactedEvidenceQuery(query: NotificationRedactedEvidenceQuery): NotificationRedactedEvidenceQuery {
  return {
    ...(query.orderId ? { orderId: query.orderId } : {}),
    ...(query.taskId ? { taskId: query.taskId } : {}),
    ...(query.walletAddress ? { walletAddress: query.walletAddress } : {})
  };
}

function taskMatchesNotificationEvidenceQuery(
  task: StateMachineTaskProjection,
  query: NotificationRedactedEvidenceQuery,
  participantKey: string | undefined
): boolean {
  return (!query.orderId || task.orderId.toLowerCase() === query.orderId.toLowerCase()) &&
    (!query.taskId || task.taskId === query.taskId) &&
    (!participantKey || task.assigneeWallet?.toLowerCase() === participantKey);
}

function deliveryMatchesNotificationEvidenceQuery(
  delivery: NotificationDeliveryRecord,
  query: NotificationRedactedEvidenceQuery,
  participantKey: string | undefined
): boolean {
  return (!query.orderId || delivery.orderId.toLowerCase() === query.orderId.toLowerCase()) &&
    (!query.taskId || delivery.taskId === query.taskId) &&
    (!participantKey ||
      delivery.supplierWallet?.toLowerCase() === participantKey ||
      delivery.submitter?.toLowerCase() === participantKey);
}

function deliveryStatusRequiresRecipientEvidence(status: NotificationDeliveryStatus): boolean {
  return status === "failed" || status === "skipped" || status === "dead_letter";
}

function redactedDeliveryReasonCode(reason: string): string {
  return isNotificationSkippedReason(reason) ? reason : "redacted_operator_reason";
}

function isNotificationSkippedReason(reason: string): reason is NotificationSkippedReason {
  return [
    "not_finalized",
    "order_projection_missing",
    "signal_projection_missing",
    "artifact_mapping_missing",
    "receiver_not_found",
    "receiver_ambiguous",
    "store_supplier_not_found",
    "store_supplier_ambiguous",
    "notification_profile_missing",
    "transport_not_supported",
    "executor_watch_self_managed",
    "transport_adapter_missing"
  ].includes(reason);
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

  const [tasks, orders, deliveries] = await Promise.all([
    input.store.listStateMachineTasks(),
    input.store.listStateMachineOrders(),
    input.deliveryStore.listDeliveries({ supplier: participantKey })
  ]);
  const taskRows = tasks.map((task) => ({
    task,
    order: findOrderForTask(orders, task)
  }));
  const visibleTaskRows = taskRows
    .filter(({ task }) => task.assigneeWallet?.toLowerCase() === participantKey)
    .sort((left, right) => compareTasksForParticipantNotifications(left.task, right.task));
  const notifications = new Map<Hex, ParticipantNotificationRecord>();

  for (const { task, order } of visibleTaskRows) {
    const taskNotification = participantTaskNotification(task, order, input.now());
    if (taskNotification) {
      notifications.set(taskNotification.notificationId, taskNotification);
    }
  }

  for (const order of orders.filter((item) => participantCanSeeOrderSignals(item, participantKey))) {
    for (const signal of Object.values(order.signals)) {
      const signalNotification = participantSignalNotification(signal, order);
      notifications.set(signalNotification.notificationId, signalNotification);
    }
  }

  for (const delivery of deliveries) {
    if (delivery.status !== "failed") {
      continue;
    }
    const task = delivery.taskId ? uniqueTaskForDelivery(tasks, delivery) : undefined;
    const order = task
      ? findOrderForTask(orders, task)
      : uniqueOrderForDelivery(orders, delivery);
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

function participantSignalNotification(
  signal: StateMachineSignalProjection,
  order: StateMachineOrderProjection
): ParticipantNotificationRecord {
  const sourceLabel = displayBytes32(signal.sourceId, "来源");
  const signalLabel = displayBytes32(signal.signalId, "链上信号");
  return {
    readStatus: "unread",
    notificationId: participantNotificationId(
      "signal_submitted",
      signal.orderId,
      signal.sourceId,
      signal.signalId,
      signal.proof.eventId
    ),
    kind: "signal_submitted",
    severity: "info",
    orderId: signal.orderId,
    orderTitle: orderTitle(order),
    stageId: signal.sourceId,
    stageLabel: sourceLabel,
    eventLabel: "链上信号已提交",
    message: `${sourceLabel} 的 ${signalLabel} 已写入链上索引。`,
    actionHref: `/product/orders/${encodeURIComponent(signal.orderId)}`,
    proofHref: `/product/orders/${encodeURIComponent(signal.orderId)}/proof`,
    proof: signalNotificationProof(signal.proof),
    createdAt: provenanceTime(signal.submittedAt),
    source: "chain_projection",
    privacy: "participant_only"
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
  const stageId = delivery.receiverStageId ?? delivery.sourceId;
  return {
    readStatus: "unread",
    orderId: delivery.orderId,
    orderTitle: orderTitle(order ?? delivery),
    ...(delivery.taskId ? { taskId: delivery.taskId } : {}),
    taskTitle: delivery.kind === "signal_received" ? "链上信号触达" : "处理链上待办",
    ...(stageId ? { stageId: displayBytes32(stageId, stageId) } : {}),
    stageLabel: displayBytes32(stageId, "当前阶段"),
    actionHref: delivery.taskId
      ? `/product/orders/${encodeURIComponent(delivery.orderId)}#task=${encodeURIComponent(delivery.taskId)}`
      : `/product/orders/${encodeURIComponent(delivery.orderId)}`,
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
    ...(proof.transactionIndex !== undefined ? { transactionIndex: proof.transactionIndex } : {}),
    transactionHash: proof.transactionHash,
    logIndex: proof.logIndex
  };
}

function signalNotificationProof(proof: StateMachineSignalProjection["proof"]): ParticipantNotificationProof {
  return {
    eventName: proof.eventName,
    chainId: proof.chainId,
    contractAddress: proof.contractAddress,
    blockNumber: proof.blockNumber.toString(),
    ...(proof.transactionIndex !== undefined ? { transactionIndex: proof.transactionIndex } : {}),
    transactionHash: proof.transactionHash,
    logIndex: proof.logIndex
  };
}

function signalPayloadNotificationProof(proof: SignalNotificationProof): ParticipantNotificationProof {
  return {
    eventName: proof.eventName,
    chainId: proof.chainId,
    contractAddress: proof.contractAddress,
    blockNumber: proof.blockNumber,
    ...(proof.transactionIndex !== undefined ? { transactionIndex: proof.transactionIndex } : {}),
    transactionHash: proof.transactionHash,
    logIndex: proof.logIndex
  };
}

function participantCanSeeOrderSignals(order: StateMachineOrderProjection, participantKey: string): boolean {
  return Object.values(order.authorizations).some((authorization) =>
    authorization.submitter.toLowerCase() === participantKey
  ) ||
    Object.values(order.signals).some((signal) => signal.submitter.toLowerCase() === participantKey) ||
    Object.values(order.tasks).some((task) => task.assigneeWallet?.toLowerCase() === participantKey) ||
    Object.values(order.stageExecutorOverlays).some((overlay) =>
      overlay.selectorWallet.toLowerCase() === participantKey ||
      overlay.activeExecutorWallet.toLowerCase() === participantKey
    );
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

/** M-5：failed 投递的自动重投上限；超过即转 dead_letter（人工可重开）。 */
const MAX_AUTOMATIC_DELIVERY_ATTEMPTS = 5;

type ReceiverResolution =
  | {
      readonly status: "ok";
      readonly supplierMetadata: StoreSupplierMetadataRecord;
    }
  | {
      readonly status: "skipped";
      readonly reason: NotificationSkippedReason;
      readonly supplierMetadata?: StoreSupplierMetadataRecord;
    };

type SupplierMetadataResolution =
  | {
      readonly status: "ok";
      readonly supplierMetadata: StoreSupplierMetadataRecord;
    }
  | {
      readonly status: "skipped";
      readonly reason: NotificationSkippedReason;
      readonly supplierMetadata?: StoreSupplierMetadataRecord;
    };

function finalizedSignalSubmittedEvents(
  events: readonly ChainEvent[],
  finalizedBlock: bigint | undefined
): readonly ChainEvent[] {
  return filterActiveChainEvents(events).filter((event) =>
    event.eventName === "SignalSubmitted" &&
    (finalizedBlock === undefined || event.blockNumber <= finalizedBlock)
  );
}

async function resolvePlanArtifact(
  options: CreateNotificationServiceOptions,
  order: StateMachineOrderProjection
): Promise<OnchainHookPlanArtifact | undefined> {
  const customArtifact = await options.planArtifactResolver?.(order);
  if (customArtifact) {
    return customArtifact;
  }
  if (!options.productSchemaResolver || !order.planHash) {
    return undefined;
  }
  const schema = await options.productSchemaResolver.getProductSchemaByPlan(
    order.planId,
    order.planHash
  );
  const artifact = (schema as { readonly onchainHookPlanArtifact?: unknown } | undefined)?.onchainHookPlanArtifact;
  if (!artifact) {
    return undefined;
  }
  assertOnchainHookPlanArtifact(artifact);
  return artifact;
}

function receiverHooksForSignal(
  artifact: OnchainHookPlanArtifact,
  signal: StateMachineSignalProjection
): readonly OnchainCompiledHook[] {
  const signalKey = onchainSignalKey(signal.sourceId, signal.signalId);
  const indexedHookIds = new Set((artifact.dependencyIndex[signalKey] ?? []).map((hookId) => hookId.toLowerCase()));
  const candidates = indexedHookIds.size > 0
    ? artifact.compiledHooks.filter((hook) => indexedHookIds.has(hook.hookId.toLowerCase()))
    : artifact.compiledHooks;
  return candidates.filter((hook) =>
    hook.kind === "receive" &&
    hook.dependencies.some((dependency) =>
      dependency.sourceId.toLowerCase() === signal.sourceId.toLowerCase() &&
      dependency.signalId.toLowerCase() === signal.signalId.toLowerCase()
    )
  );
}

function compareReceiverHooks(left: OnchainCompiledHook, right: OnchainCompiledHook): number {
  const stageCompare = left.stageId.localeCompare(right.stageId);
  if (stageCompare !== 0) {
    return stageCompare;
  }
  return left.hookId.localeCompare(right.hookId);
}

function resolveReceiverSupplier(
  order: StateMachineOrderProjection,
  receiverHook: OnchainCompiledHook,
  supplierRows: readonly StoreSupplierMetadataRecord[]
): ReceiverResolution {
  const overlay = order.stageExecutorOverlays[receiverHook.stageId.toLowerCase()];
  const receiverWallet = overlay?.activeExecutorWallet ?? receiverAuthorizationWallet(order, receiverHook);
  const metadataResolution = receiverWallet
    ? supplierMetadataByWallet(supplierRows, receiverWallet)
    : supplierMetadataByStage(supplierRows, receiverHook.stageId);

  if (metadataResolution.status !== "ok") {
    return metadataResolution;
  }

  return {
    status: "ok",
    supplierMetadata: metadataResolution.supplierMetadata
  };
}

function supplierMetadataByWallet(
  supplierRows: readonly StoreSupplierMetadataRecord[],
  wallet: Address
): SupplierMetadataResolution {
  const matches = supplierRows
    .filter((supplier) => supplier.wallet?.toLowerCase() === wallet.toLowerCase())
    .sort(compareSupplierMetadataForDelivery);
  if (matches.length === 0) {
    return { status: "skipped", reason: "store_supplier_not_found" };
  }
  const first = matches[0];
  if (matches.length > 1) {
    return first
      ? { status: "skipped", reason: "store_supplier_ambiguous", supplierMetadata: first }
      : { status: "skipped", reason: "store_supplier_ambiguous" };
  }
  return first
    ? { status: "ok", supplierMetadata: first }
    : { status: "skipped", reason: "store_supplier_not_found" };
}

function supplierMetadataByStage(
  supplierRows: readonly StoreSupplierMetadataRecord[],
  stageId: string
): SupplierMetadataResolution {
  const normalizedStageId = stageId.toLowerCase();
  const matches = supplierRows
    .filter((supplier) =>
      supplier.supportedStageIds.some((supportedStageId) => supportedStageId.toLowerCase() === normalizedStageId)
    )
    .sort(compareSupplierMetadataForDelivery);
  if (matches.length === 0) {
    return { status: "skipped", reason: "receiver_not_found" };
  }
  const first = matches[0];
  if (matches.length > 1) {
    return first
      ? { status: "skipped", reason: "receiver_ambiguous", supplierMetadata: first }
      : { status: "skipped", reason: "receiver_ambiguous" };
  }
  return first
    ? { status: "ok", supplierMetadata: first }
    : { status: "skipped", reason: "receiver_not_found" };
}

function receiverAuthorizationWallet(
  order: StateMachineOrderProjection,
  receiverHook: OnchainCompiledHook
): Address | undefined {
  const hookName = onchainSignalId(receiverHook.hookName) as Hex;
  return Object.values(order.authorizations)
    .sort(compareSignalAuthorizationsForDelivery)
    .find((authorization) => signalAuthorizationMatchesHook(authorization, {
      stageIdentifier: receiverHook.stageId as Hex,
      hookId: receiverHook.hookId as Hex,
      hookName
    }))?.submitter;
}

function bytes32Arg(event: ChainEvent, name: string): Hex | undefined {
  const value = event.args[name];
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/u.test(value)
    ? value.toLowerCase() as Hex
    : undefined;
}

function addressArg(event: ChainEvent, name: string): Address | undefined {
  const value = event.args[name];
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/u.test(value)
    ? value.toLowerCase() as Address
    : undefined;
}

async function dispatchSignalTransportDelivery(input: {
  readonly deliveryStore: NotificationDeliveryStore;
  readonly dispatcher?: NotificationDispatcher;
  readonly event: ChainEvent;
  readonly order: StateMachineOrderProjection;
  readonly signal: StateMachineSignalProjection;
  readonly receiverHook: OnchainCompiledHook;
  readonly supplierMetadata: StoreSupplierMetadataRecord;
  readonly profile: SupplierNotificationProfile;
  readonly transport: SupplierNotificationTransport;
  readonly now: () => string;
}): Promise<NotificationDeliveryRecord> {
  const deliveryId = signalDeliveryIdFor(input.event, input.order, input.signal, input.receiverHook, input.supplierMetadata);
  const existing = await input.deliveryStore.getDelivery(deliveryId);
  if (existing && existing.status !== "pending" && existing.status !== "failed") {
    return existing;
  }
  // M-5：自动补投预算。重建/重放会对 failed 行自动重投；无上限的重启
  // 重投会无界重复外部投递（每次 webhook 最多一个超时周期）。超过预算
  // 转 dead_letter 终态，人工 retryDelivery 仍可显式重开。
  if (existing && existing.status === "failed" && existing.attempts >= MAX_AUTOMATIC_DELIVERY_ATTEMPTS) {
    return input.deliveryStore.saveDelivery({
      ...existing,
      status: "dead_letter",
      reason: "delivery_attempts_exhausted",
      updatedAt: input.now()
    });
  }

  const pending = await input.deliveryStore.saveDelivery({
    ...(existing ?? baseSignalDeliveryRecord(
      input.event,
      input.order,
      input.signal,
      input.receiverHook,
      input.supplierMetadata,
      input.transport.type,
      input.now
    )),
    status: "pending",
    updatedAt: input.now()
  });

  return dispatchPreparedDelivery({
    deliveryStore: input.deliveryStore,
    ...(input.dispatcher ? { dispatcher: input.dispatcher } : {}),
    pending,
    profile: input.profile,
    transport: input.transport,
    now: input.now
  });
}

async function dispatchPreparedDelivery(input: {
  readonly deliveryStore: NotificationDeliveryStore;
  readonly dispatcher?: NotificationDispatcher;
  readonly pending: NotificationDeliveryRecord;
  readonly profile: SupplierNotificationProfile;
  readonly transport: SupplierNotificationTransport;
  readonly now: () => string;
}): Promise<NotificationDeliveryRecord> {
  if (!input.dispatcher) {
    return input.deliveryStore.saveDelivery({
      ...input.pending,
      // No delivery attempt was made. Keep this distinct from a transport
      // failure so retry budgets and operator evidence do not count a missing
      // adapter as an exhausted send attempt.
      status: "skipped",
      reason: "transport_adapter_missing",
      updatedAt: input.now()
    });
  }

  try {
    const result = await input.dispatcher.send({
      record: input.pending,
      profile: input.profile,
      transport: input.transport
    });
    return input.deliveryStore.saveDelivery({
      ...input.pending,
      status: result.ok ? "sent" : "failed",
      attempts: input.pending.attempts + 1,
      ...activationStatusForResult(input.transport, result),
      ...(result.externalReceiptRef ? { externalReceiptRef: result.externalReceiptRef } : {}),
      // L-10：错误消息先脱敏再持久化（对齐兄弟路径），防 transport 异常
      // 文本把端点/凭证带进投递台账。
      ...(result.error ? { lastError: redactErrorMessage(result.error) } : {}),
      updatedAt: input.now()
    });
  } catch (error) {
    return input.deliveryStore.saveDelivery({
      ...input.pending,
      status: "failed",
      attempts: input.pending.attempts + 1,
      lastError: error instanceof Error ? redactErrorMessage(error) : "notification dispatch failed",
      updatedAt: input.now()
    });
  }
}

type RetryTransportResolution =
  | {
      readonly status: "ok";
      readonly profile: SupplierNotificationProfile;
      readonly transport: SupplierNotificationTransport;
    }
  | {
      readonly status: "skipped";
      readonly reason: NotificationSkippedReason;
    };

async function resolveRetryTransport(
  options: CreateNotificationServiceOptions,
  delivery: NotificationDeliveryRecord
): Promise<RetryTransportResolution> {
  const supplierRows = await options.supplierMetadataStore?.listSuppliers() ?? [];
  const matches = supplierRows.filter((supplier) =>
    (!delivery.supplierSubjectId || supplier.supplierSubjectId === delivery.supplierSubjectId) &&
    (!delivery.supplierWallet || supplier.wallet?.toLowerCase() === delivery.supplierWallet.toLowerCase())
  ).sort(compareSupplierMetadataForDelivery);
  if (matches.length === 0) {
    return { status: "skipped", reason: "store_supplier_not_found" };
  }
  if (matches.length > 1) {
    return { status: "skipped", reason: "store_supplier_ambiguous" };
  }
  const supplierMetadata = matches[0];
  if (!supplierMetadata) {
    return { status: "skipped", reason: "store_supplier_not_found" };
  }
  const profile = supplierMetadata.notificationProfile;
  if (!profile) {
    return { status: "skipped", reason: "notification_profile_missing" };
  }
  const transport = chooseTransportForRetry(profile, delivery.transportType);
  if (!transport) {
    return { status: "skipped", reason: "transport_not_supported" };
  }
  if (transport.type === "executor-watch") {
    return { status: "skipped", reason: "executor_watch_self_managed" };
  }
  if (!isPushTransport(transport)) {
    return { status: "skipped", reason: "transport_not_supported" };
  }
  return { status: "ok", profile, transport };
}

async function saveSkippedSignalDelivery(input: {
  readonly deliveryStore: NotificationDeliveryStore;
  readonly event: ChainEvent;
  readonly order: StateMachineOrderProjection | undefined;
  readonly signal: StateMachineSignalProjection | undefined;
  readonly receiverHook: OnchainCompiledHook | undefined;
  readonly supplierMetadata: StoreSupplierMetadataRecord | undefined;
  readonly reason: NotificationSkippedReason;
  readonly transportType: string | undefined;
  readonly now: () => string;
}): Promise<NotificationDeliveryRecord> {
  const deliveryId = signalDeliveryIdFor(input.event, input.order, input.signal, input.receiverHook, input.supplierMetadata);
  const existing = await input.deliveryStore.getDelivery(deliveryId);
  if (existing && existing.status !== "pending") {
    return existing;
  }
  return input.deliveryStore.saveDelivery({
    ...baseSignalDeliveryRecord(
      input.event,
      input.order,
      input.signal,
      input.receiverHook,
      input.supplierMetadata,
      input.transportType,
      input.now
    ),
    status: "skipped",
    reason: input.reason,
    updatedAt: input.now()
  });
}

function baseSignalDeliveryRecord(
  event: ChainEvent,
  order: StateMachineOrderProjection | undefined,
  signal: StateMachineSignalProjection | undefined,
  receiverHook: OnchainCompiledHook | undefined,
  supplierMetadata: StoreSupplierMetadataRecord | undefined,
  transportType: string | undefined,
  now: () => string
): NotificationDeliveryRecord {
  const createdAt = now();
  const orderId = signal?.orderId ?? bytes32Arg(event, "orderId") ?? "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex;
  const sourceId = signal?.sourceId ?? bytes32Arg(event, "sourceId");
  const signalId = signal?.signalId ?? bytes32Arg(event, "signalId");
  const payloadHash = signal?.payloadHash ?? bytes32Arg(event, "payloadHash");
  const idempotencyKey = signal?.idempotencyKey ?? bytes32Arg(event, "idempotencyKey");
  const signalSubmitter = signal?.submitter ?? addressArg(event, "submitter");
  const receiverTask = taskForReceiverHook(order, receiverHook);
  return {
    deliveryId: signalDeliveryIdFor(event, order, signal, receiverHook, supplierMetadata),
    kind: "signal_received",
    status: "pending",
    ...(receiverTask ? { taskId: receiverTask.taskId } : {}),
    orderId,
    ...(receiverHook ? { receiverHookId: receiverHook.hookId as Hex, receiverStageId: receiverHook.stageId as Hex } : {}),
    ...(sourceId ? { sourceId } : {}),
    ...(signalId ? { signalId } : {}),
    ...(payloadHash ? { payloadHash } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
    chainId: event.chainId,
    stateMachineAddress: order?.contractAddress ?? event.contractAddress,
    ...(signalSubmitter ? { submitter: signalSubmitter } : {}),
    ...(supplierMetadata ? {
      supplierSubjectId: supplierMetadata.supplierSubjectId,
      ...(supplierMetadata.wallet ? { supplierWallet: supplierMetadata.wallet } : {})
    } : {}),
    ...(transportType ? { transportType } : {}),
    payload: payloadForSignal(event, order, signal, receiverHook, supplierMetadata),
    attempts: 0,
    createdAt,
    updatedAt: createdAt
  };
}

function payloadForSignal(
  event: ChainEvent,
  order: StateMachineOrderProjection | undefined,
  signal: StateMachineSignalProjection | undefined,
  receiverHook: OnchainCompiledHook | undefined,
  supplierMetadata: StoreSupplierMetadataRecord | undefined
): SignalNotificationPayload {
  const orderId = signal?.orderId ?? bytes32Arg(event, "orderId") ?? "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex;
  const sourceId = signal?.sourceId ?? bytes32Arg(event, "sourceId") ?? "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex;
  const signalId = signal?.signalId ?? bytes32Arg(event, "signalId") ?? "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex;
  const payloadHash = signal?.payloadHash ?? bytes32Arg(event, "payloadHash") ?? "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex;
  const idempotencyKey = signal?.idempotencyKey ?? bytes32Arg(event, "idempotencyKey") ?? "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex;
  const signalSubmitter = signal?.submitter ?? addressArg(event, "submitter") ?? "0x0000000000000000000000000000000000000000" as Address;
  const receiverHookId = receiverHook?.hookId as Hex | undefined ?? "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex;
  const receiverStageId = receiverHook?.stageId as Hex | undefined ?? "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex;
  const receiverSupplierSubjectId = supplierMetadata?.supplierSubjectId ?? "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex;
  const receiverWallet = supplierMetadata?.wallet ?? "0x0000000000000000000000000000000000000000" as Address;
  return {
    version: "uvp.signalReceivedNotification.v1",
    chainId: event.chainId,
    stateMachineAddress: order?.contractAddress ?? event.contractAddress,
    orderId,
    sourceId,
    signalId,
    payloadHash,
    idempotencyKey,
    signalSubmitter,
    receiverHookId,
    receiverStageId,
    receiverSupplierSubjectId,
    receiverWallet,
    proof: {
      eventName: "SignalSubmitted",
      chainId: event.chainId,
      contractAddress: event.contractAddress,
      blockNumber: event.blockNumber.toString(),
      ...(event.transactionIndex !== undefined ? { transactionIndex: event.transactionIndex } : {}),
      transactionHash: event.transactionHash,
      logIndex: event.logIndex,
      ...(event.blockHash ? { blockHash: event.blockHash } : {})
    }
  };
}

function chooseTransport(profile: SupplierNotificationProfile): SupplierNotificationTransport | undefined {
  const enabled = profile.transports
    .map((transport, index) => ({ transport, index }))
    .filter(({ transport }) => transport.enabled !== false)
    .sort(compareTransportPreference);
  return enabled.find(({ transport }) => isPushTransport(transport) || transport.type === "executor-watch")?.transport ??
    enabled[0]?.transport;
}

function chooseTransportForRetry(
  profile: SupplierNotificationProfile,
  transportType: string | undefined
): SupplierNotificationTransport | undefined {
  const enabled = profile.transports
    .filter((transport) => transport.enabled !== false);
  return (transportType ? enabled.find((transport) => transport.type === transportType) : undefined) ??
    chooseTransport(profile);
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

function findOrderForTask(
  orders: readonly StateMachineOrderProjection[],
  task: StateMachineTaskProjection
): StateMachineOrderProjection | undefined {
  const matches = orders.filter((order) =>
    order.chainId === task.createdAt.chainId &&
    order.orderId.toLowerCase() === task.orderId.toLowerCase() &&
    order.contractAddress.toLowerCase() === task.stateMachineAddress.toLowerCase() &&
    (!task.planId || order.planId.toLowerCase() === task.planId.toLowerCase()) &&
    Object.hasOwn(order.tasks, task.taskId)
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function uniqueTaskForDelivery(
  tasks: readonly StateMachineTaskProjection[],
  delivery: NotificationDeliveryRecord
): StateMachineTaskProjection | undefined {
  if (!delivery.taskId) {
    return undefined;
  }
  const normalizedTaskId = delivery.taskId.toLowerCase();
  const matches = tasks.filter((task) =>
    task.taskId.toLowerCase() === normalizedTaskId &&
    task.orderId.toLowerCase() === delivery.orderId.toLowerCase() &&
    task.stateMachineAddress.toLowerCase() === delivery.stateMachineAddress.toLowerCase() &&
    task.createdAt.chainId === delivery.chainId
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function uniqueOrderForDelivery(
  orders: readonly StateMachineOrderProjection[],
  delivery: NotificationDeliveryRecord
): StateMachineOrderProjection | undefined {
  const matches = orders.filter((order) =>
    order.chainId === delivery.chainId &&
    order.orderId.toLowerCase() === delivery.orderId.toLowerCase() &&
    order.contractAddress.toLowerCase() === delivery.stateMachineAddress.toLowerCase()
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function taskForReceiverHook(
  order: StateMachineOrderProjection | undefined,
  receiverHook: OnchainCompiledHook | undefined
): StateMachineTaskProjection | undefined {
  if (!order || !receiverHook) {
    return undefined;
  }
  return Object.values(order.tasks)
    .sort(compareTasksForParticipantNotifications)
    .find((task) =>
      task.hookId.toLowerCase() === receiverHook.hookId.toLowerCase() &&
      task.stageIdentifier.toLowerCase() === receiverHook.stageId.toLowerCase()
    );
}

function signalDeliveryIdFor(
  event: ChainEvent,
  order: StateMachineOrderProjection | undefined,
  signal: StateMachineSignalProjection | undefined,
  receiverHook: OnchainCompiledHook | undefined,
  supplierMetadata: StoreSupplierMetadataRecord | undefined
): Hex {
  return keccak256(stringToBytes([
    "uvp:signal-received-notification-delivery:v1",
    event.chainId.toString(),
    (order?.contractAddress ?? event.contractAddress).toLowerCase(),
    order?.planId ?? bytes32Arg(event, "planId") ?? "unknown-plan",
    signal?.orderId ?? bytes32Arg(event, "orderId") ?? "unknown-order",
    signal?.sourceId ?? bytes32Arg(event, "sourceId") ?? "unknown-source",
    signal?.signalId ?? bytes32Arg(event, "signalId") ?? "unknown-signal",
    chainEventId(event),
    receiverHook?.hookId ?? "unresolved-hook",
    supplierMetadata?.supplierSubjectId ?? "unresolved-supplier",
    supplierMetadata?.wallet?.toLowerCase() ?? "unresolved-wallet"
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

function compareSupplierMetadataForDelivery(
  left: StoreSupplierMetadataRecord,
  right: StoreSupplierMetadataRecord
): number {
  if (left.updatedAt !== right.updatedAt) {
    return right.updatedAt.localeCompare(left.updatedAt);
  }
  return left.supplierId.localeCompare(right.supplierId);
}

function compareSignalAuthorizationsForDelivery(
  left: StateMachineSignalAuthorizationProjection,
  right: StateMachineSignalAuthorizationProjection
): number {
  const position = compareChainPointers(left.authorizedAt, right.authorizedAt);
  if (position !== 0) {
    return position;
  }
  return left.submitter.localeCompare(right.submitter);
}

function chainEventId(event: ChainEvent): string {
  return chainEventKey(event);
}
