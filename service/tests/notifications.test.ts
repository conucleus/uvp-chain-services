import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import {
  customsOnchainHookPlanArtifact,
  customsPlanIds,
  customsStoreProductSchema
} from "@uvp-eth/product-dto/fixtures";
import {
  createNotificationService,
  MemoryNotificationDeliveryStore,
  SUPPLIER_NOTIFICATION_PROFILE_VERSION,
  type NotificationDispatchRequest,
  type NotificationDispatcher,
  type SupplierNotificationProfile
} from "../src/notifications/index.js";
import { createApiRouter } from "../src/api/routes.js";
import type { ChainEvent } from "../src/indexer/events.js";
import { InMemoryStoreSupplierMetadataStore } from "../src/store-suppliers/service.js";
import { MemoryProjectionStore } from "../src/storage/projection-store.js";
import type { Address, Hex } from "../src/shared/types.js";

const stateMachineAddress = "0x1111111111111111111111111111111111111111" as Address;
const identityRegistryAddress = "0x2222222222222222222222222222222222222222" as Address;
const signalSubmitter = "0x3333333333333333333333333333333333333333" as Address;
const supplierWallet = "0x4444444444444444444444444444444444444444" as Address;
const orderId = bytes32Hex("3001");
const supplierSubjectId = bytes32Hex("5001");
const payloadHash = bytes32Hex("7001");
const idempotencyKey = bytes32Hex("6001");
const metadataHash = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Hex;
const registeredDependency = customsOnchainHookPlanArtifact.compiledHooks[0]?.dependencies[0];
const resourceHook = customsOnchainHookPlanArtifact.compiledHooks[0];
const customsHook = customsOnchainHookPlanArtifact.compiledHooks.find((hook) => hook.hookName === "customs_ready");
const customsDependencyA = customsHook?.dependencies[0];
const customsDependencyB = customsHook?.dependencies[1];
const adminHeaders = {
  "x-uvp-admin-id": "admin-1",
  "x-uvp-admin-role": "admin"
};

describe("signal-routed notifications", () => {
  it("delivers finalized SignalSubmitted to every receive hook depending on that signal", async () => {
    const sent: NotificationDispatchRequest[] = [];
    const event = signalEvent(6n, requiredDependency(registeredDependency));
    const { store, supplierStore } = await notificationStore({
      supportedStageIds: customsOnchainHookPlanArtifact.compiledHooks
        .filter((hook) => hook.dependencies.some((dependency) => dependency.signalId === registeredDependency?.signalId))
        .map((hook) => hook.stageId),
      events: [event]
    });
    const service = serviceFor(store, supplierStore, sent);

    const summary = await service.processSignalSubmittedEvents([event]);
    const deliveries = await service.listDeliveries();

    expect(summary).toMatchObject({
      signalsProcessed: 1,
      receiverHooksMatched: 2,
      deliveryIntents: 2,
      sent: 2,
      failed: 0,
      skipped: 0
    });
    expect(sent).toHaveLength(2);
    expect(deliveries).toHaveLength(2);
    expect(deliveries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "signal_received",
        status: "sent",
        orderId,
        sourceId: registeredDependency?.sourceId,
        signalId: registeredDependency?.signalId,
        submitter: signalSubmitter,
        supplierSubjectId,
        supplierWallet,
        transportType: "webhook"
      })
    ]));
    expect(sent.map((request) => request.record.payload.version)).toEqual([
      "uvp.signalReceivedNotification.v1",
      "uvp.signalReceivedNotification.v1"
    ]);
    expect(sent.every((request) => request.record.payload.receiverWallet === supplierWallet)).toBe(true);
  });

  it("notifies A and B dependencies of an A & B hook without evaluating business readiness", async () => {
    const sent: NotificationDispatchRequest[] = [];
    const { store, supplierStore } = await notificationStore({
      supportedStageIds: [requiredHook(customsHook).stageId],
      events: [
        signalEvent(6n, requiredDependency(customsDependencyA)),
        signalEvent(7n, requiredDependency(customsDependencyB), bytes32Hex("6002"))
      ],
      finalizedBlock: 7n
    });
    const service = serviceFor(store, supplierStore, sent);

    const summary = await service.processSignalSubmittedEvents([
      signalEvent(6n, requiredDependency(customsDependencyA)),
      signalEvent(7n, requiredDependency(customsDependencyB), bytes32Hex("6002"))
    ]);

    expect(summary).toMatchObject({
      signalsProcessed: 2,
      receiverHooksMatched: 2,
      deliveryIntents: 2,
      sent: 2
    });
    expect(sent.map((request) => request.record.receiverHookId)).toEqual([
      requiredHook(customsHook).hookId,
      requiredHook(customsHook).hookId
    ]);
  });

  it("fails instead of treating an invalid stored plan artifact as missing", async () => {
    const event = signalEvent(6n, requiredDependency(registeredDependency));
    const { store, supplierStore } = await notificationStore({
      supportedStageIds: customsOnchainHookPlanArtifact.compiledHooks.map((hook) => hook.stageId),
      events: [event]
    });
    const service = createNotificationService({
      store,
      supplierMetadataStore: supplierStore,
      productSchemaResolver: {
        async getProductSchemaByPlan() {
          return {
            ...customsStoreProductSchema,
            onchainHookPlanArtifact: { schemaVersion: "invalid" }
          } as unknown as typeof customsStoreProductSchema;
        }
      }
    });

    await expect(service.processSignalSubmittedEvents([event])).rejects.toThrow();
  });

  it("does not notify the signal submitter unless they resolve as a receiver supplier", async () => {
    const sent: NotificationDispatchRequest[] = [];
    const { store, supplierStore } = await notificationStore({
      supportedStageIds: [requiredHook(customsHook).stageId],
      events: [signalEvent(6n, requiredDependency(customsDependencyA))]
    });
    const service = serviceFor(store, supplierStore, sent);

    await service.processSignalSubmittedEvents([signalEvent(6n, requiredDependency(customsDependencyA))]);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.record.submitter).toBe(signalSubmitter);
    expect(sent[0]?.record.supplierWallet).toBe(supplierWallet);
    expect(signalSubmitter).not.toBe(supplierWallet);
  });

  it("requires Store supplier metadata and a notification profile", async () => {
    const missingProfile = await notificationStore({
      supportedStageIds: [requiredHook(customsHook).stageId],
      includeProfile: false,
      events: [signalEvent(6n, requiredDependency(customsDependencyA))]
    });
    const noStoreSupplier = await notificationStore({
      supportedStageIds: [],
      includeStoreSupplier: false,
      events: [signalEvent(6n, requiredDependency(customsDependencyA))]
    });

    const missingProfileService = serviceFor(missingProfile.store, missingProfile.supplierStore);
    const noStoreSupplierService = serviceFor(noStoreSupplier.store, noStoreSupplier.supplierStore);
    await missingProfileService.processSignalSubmittedEvents([signalEvent(6n, requiredDependency(customsDependencyA))]);
    await noStoreSupplierService.processSignalSubmittedEvents([signalEvent(6n, requiredDependency(customsDependencyA))]);

    await expect(missingProfileService.listDeliveries()).resolves.toEqual([
      expect.objectContaining({ status: "skipped", reason: "notification_profile_missing" })
    ]);
    await expect(noStoreSupplierService.listDeliveries()).resolves.toEqual([
      expect.objectContaining({ status: "skipped", reason: "receiver_not_found" })
    ]);
  });

  it("builds redacted ready-task and submission recipient evidence only from task projections", async () => {
    const readyHook = requiredHook(resourceHook);
    const submittedHook = requiredHook(customsHook);
    const { store, supplierStore } = await notificationStore({
      supportedStageIds: [readyHook.stageId, submittedHook.stageId],
      events: [
        signalCapabilityEvent(3n, readyHook),
        signalCapabilityEvent(3n, submittedHook, 1),
        authorizationEvent(4n, readyHook, supplierWallet),
        hookReadyEvent(5n, readyHook),
        authorizationEvent(6n, submittedHook, supplierWallet),
        hookReadyEvent(7n, submittedHook),
        signalEvent(8n, { sourceId: submittedHook.hookId, signalId: submittedHook.hookId }, bytes32Hex("6003"))
      ],
      finalizedBlock: 8n
    });
    const service = serviceFor(store, supplierStore);

    const evidence = await service.buildRedactedEvidence({ walletAddress: supplierWallet, orderId });
    const serialized = JSON.stringify(evidence);

    expect(evidence).toMatchObject({
      schemaVersion: "uvp.notification-redacted-evidence.v1",
      status: "verified",
      sourceOfTruth: "chain-product-task-projection-and-notification-delivery-workflow",
      counts: {
        readyTaskRecipients: 1,
        submissionRecipients: 1,
        blockedRecipients: 0,
        deadLetterRecipients: 0,
        deliveryRowsWithoutTaskProjection: 0
      }
    });
    expect(evidence.classifications.map((item) => item.kind).sort()).toEqual(["ready_task", "submission"]);
    expect(evidence.classifications.every((item) =>
      item.source === "product_task_projection" &&
      item.recipientWallet === supplierWallet &&
      item.proof.transactionHash.match(/^0x[0-9a-f]{64}$/u)
    )).toBe(true);
    expect(serialized).not.toContain("secret://supplier-a/webhook");
    expect(serialized).not.toMatch(/"payload"\s*:/u);
    expect(serialized).not.toMatch(/"signature"\s*:/u);
    expect(serialized).not.toContain("Bearer ");
  });

  it("classifies blocked and dead-letter delivery evidence only when delivery rows resolve to a projected task", async () => {
    const deliveryStore = new MemoryNotificationDeliveryStore();
    const { store, supplierStore } = await notificationStore({
      supportedStageIds: [requiredHook(customsHook).stageId],
      events: [
        signalCapabilityEvent(3n, requiredHook(customsHook)),
        authorizationEvent(4n, requiredHook(customsHook), supplierWallet),
        hookReadyEvent(5n, requiredHook(customsHook)),
        signalEvent(6n, requiredDependency(customsDependencyA))
      ]
    });
    const service = createNotificationService({
      store,
      supplierMetadataStore: supplierStore,
      productSchemaResolver: {
        async getProductSchemaByPlan() {
          return customsStoreProductSchema;
        }
      },
      deliveryStore
    });

    await service.processSignalSubmittedEvents([signalEvent(6n, requiredDependency(customsDependencyA))]);
    const [delivery] = await service.listDeliveries();
    expect(delivery).toMatchObject({
      status: "failed",
      reason: "transport_adapter_missing",
      taskId: expect.stringContaining(orderId)
    });

    const blocked = await service.buildRedactedEvidence({ walletAddress: supplierWallet, orderId });
    expect(blocked).toMatchObject({
      status: "verified",
      counts: {
        readyTaskRecipients: 1,
        blockedRecipients: 1,
        deadLetterRecipients: 0,
        deliveryRowsWithoutTaskProjection: 0
      }
    });
    expect(blocked.classifications).toContainEqual(expect.objectContaining({
      kind: "blocked",
      source: "notification_delivery_with_product_task_projection",
      deliveryStatus: "failed",
      deliveryReasonCode: "transport_adapter_missing"
    }));

    const router = createApiRouter(store, { submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111", notificationService: service, storeSupplierMetadataStore: supplierStore });
    await expect(router.handle({
      method: "GET",
      pathname: "/admin/notifications/redacted-evidence",
      headers: adminHeaders,
      query: { orderId, walletAddress: supplierWallet }
    })).resolves.toMatchObject({
      status: 200,
      body: {
        notificationEvidence: expect.objectContaining({
          schemaVersion: "uvp.notification-redacted-evidence.v1",
          status: "verified",
          counts: expect.objectContaining({ blockedRecipients: 1 })
        })
      }
    });

    await service.deadLetterDelivery(delivery!.deliveryId, "operator pasted sensitive review details");
    const deadLetter = await service.buildRedactedEvidence({ walletAddress: supplierWallet, orderId });
    const serialized = JSON.stringify(deadLetter);

    expect(deadLetter).toMatchObject({
      status: "verified",
      counts: {
        deadLetterRecipients: 1,
        deliveryRowsWithoutTaskProjection: 0
      }
    });
    expect(deadLetter.classifications).toContainEqual(expect.objectContaining({
      kind: "dead_letter",
      deliveryStatus: "dead_letter",
      deliveryReasonCode: "redacted_operator_reason"
    }));
    expect(serialized).not.toContain("operator pasted sensitive review details");
    expect(serialized).not.toContain("secret://supplier-a/webhook");
    expect(serialized).not.toContain("externalReceiptRef");
  });

  it("lists, retries, and dead-letters notification deliveries", async () => {
    const sent: NotificationDispatchRequest[] = [];
    const { store, supplierStore } = await notificationStore({
      supportedStageIds: [requiredHook(customsHook).stageId],
      events: [signalEvent(6n, requiredDependency(customsDependencyA))]
    });
    const deliveryStore = new MemoryNotificationDeliveryStore();
    const failedService = createNotificationService({
      store,
      supplierMetadataStore: supplierStore,
      productSchemaResolver: {
        async getProductSchemaByPlan() {
          return customsStoreProductSchema;
        }
      },
      deliveryStore
    });
    await failedService.processSignalSubmittedEvents([signalEvent(6n, requiredDependency(customsDependencyA))]);
    const notificationService = createNotificationService({
      store,
      supplierMetadataStore: supplierStore,
      productSchemaResolver: {
        async getProductSchemaByPlan() {
          return customsStoreProductSchema;
        }
      },
      deliveryStore,
      dispatcher: {
        async send(request) {
          sent.push(request);
          return { ok: true, externalReceiptRef: "retry-receipt" };
        }
      }
    });
    const router = createApiRouter(store, { submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111", notificationService, storeSupplierMetadataStore: supplierStore });

    const deliveriesResponse = await router.handle({
      method: "GET",
      pathname: "/admin/notifications/deliveries",
      headers: adminHeaders,
      query: { orderId }
    });
    const delivery = (deliveriesResponse.body as { deliveries: Array<{ deliveryId: Hex }> }).deliveries[0];

    expect(deliveriesResponse.status).toBe(200);
    expect(delivery?.deliveryId).toMatch(/^0x[0-9a-f]{64}$/u);

    await expect(router.handle({
      method: "POST",
      pathname: `/admin/notifications/deliveries/${delivery?.deliveryId}/retry`,
      headers: adminHeaders
    })).resolves.toMatchObject({
      status: 200,
      body: { delivery: expect.objectContaining({ status: "sent", externalReceiptRef: "retry-receipt" }) }
    });
    expect(sent).toHaveLength(1);

    await expect(router.handle({
      method: "POST",
      pathname: `/admin/notifications/deliveries/${delivery?.deliveryId}/dead-letter`,
      headers: adminHeaders,
      body: { reason: "operator review" }
    })).resolves.toMatchObject({
      status: 200,
      body: { delivery: expect.objectContaining({ status: "dead_letter", reason: "operator review" }) }
    });
  });

  it("serves task and signal activity through /product/me/activity-feed", async () => {
    const { store, supplierStore } = await notificationStore({
      supportedStageIds: [requiredHook(customsHook).stageId],
      events: [
        signalCapabilityEvent(3n, requiredHook(customsHook)),
        chainEvent(4n, "SignalSubmitterAuthorized", {
          orderId,
          sourceId: requiredHook(customsHook).hookId,
          signalId: requiredHook(customsHook).hookId,
          submitter: supplierWallet,
          role: bytes32Text("executor"),
          metadataHash
        }),
        chainEvent(5n, "HookReady", {
          orderId,
          hookId: requiredHook(customsHook).hookId,
          stageId: requiredHook(customsHook).stageId,
          hookName: bytes32Text(requiredHook(customsHook).hookName)
        }),
        signalEvent(6n, requiredDependency(customsDependencyA))
      ]
    });
    const router = createApiRouter(store, { submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111",
      notificationService: serviceFor(store, supplierStore),
      storeSupplierMetadataStore: supplierStore
    });

    const visibleResponse = await router.handle({
      method: "GET",
      pathname: "/product/me/activity-feed",
      query: { walletAddress: supplierWallet }
    });
    expect(visibleResponse.status).toBe(200);
    const visibleBody = visibleResponse.body as {
      readonly notifications: Array<{ readonly notificationId: Hex; readonly kind: string; readonly readStatus: string }>;
    };
    expect(visibleBody.notifications).toContainEqual(expect.objectContaining({ kind: "task_ready" }));
    expect(visibleBody.notifications).toContainEqual(expect.objectContaining({ kind: "signal_submitted" }));

    const ready = visibleBody.notifications.find((notification) => notification.kind === "task_ready");
    await expect(router.handle({
      method: "POST",
      pathname: `/product/me/activity-feed/${ready?.notificationId}/read`,
      body: { walletAddress: supplierWallet }
    })).resolves.toMatchObject({
      status: 200,
      body: { notification: expect.objectContaining({ kind: "task_ready", readStatus: "read" }) }
    });
  });

  it("prepares and saves notification profile on Store supplier metadata with wallet proof", async () => {
    const account = privateKeyToAccount("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const store = new MemoryProjectionStore();
    const supplierStore = new InMemoryStoreSupplierMetadataStore();
    await supplierStore.putSupplier({
      supplierId: "supplier-a",
      supplierSubjectId,
      displayName: "Supplier A",
      capabilityTags: [],
      supportedRoleSlotIds: [],
      supportedStageIds: [requiredHook(customsHook).stageId],
      registryAddresses: [identityRegistryAddress],
      reviewStatus: "approved_for_broadcast",
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-05-01T00:00:00.000Z"
    });
    const router = createApiRouter(store, { submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111", storeSupplierMetadataStore: supplierStore });
    const notification = notificationProfile(account.address.toLowerCase() as Address);
    const body = {
      wallet: account.address,
      notification
    };

    // 通知配置写路由已挂 store capability 鉴权（模-5）：请求需携带
    // operator 身份头。
    const operatorHeaders = {
      "x-uvp-store-operator-id": "store-operator-1",
      "x-uvp-store-operator-role": "store_operator"
    };
    const prepareResponse = await router.handle({
      method: "POST",
      pathname: "/store/suppliers/supplier-a/notification-profile/prepare",
      headers: operatorHeaders,
      body
    });
    expect(prepareResponse.status).toBe(200);
    const prepared = (prepareResponse.body as { profileConfig: { expectedMessage: string; notificationHash: Hex } }).profileConfig;
    const signature = await account.signMessage({ message: prepared.expectedMessage });

    const saveResponse = await router.handle({
      method: "POST",
      pathname: "/store/suppliers/supplier-a/notification-profile",
      headers: operatorHeaders,
      body: {
        ...body,
        walletProof: {
          message: prepared.expectedMessage,
          signature
        }
      }
    });
    const supplier = await supplierStore.getSupplier("supplier-a");

    expect(saveResponse).toMatchObject({
      status: 201,
      body: {
        profileConfig: expect.objectContaining({
          wallet: account.address.toLowerCase(),
          notificationHash: prepared.notificationHash
        })
      }
    });
    expect(supplier?.notificationProfileHash).toBe(prepared.notificationHash);
    expect(supplier?.notificationProfile).toMatchObject(notification);

    await expect(router.handle({
      method: "POST",
      pathname: "/supplier/notifications/profile/prepare",
      body
    })).resolves.toMatchObject({ status: 404 });
  });
});

function serviceFor(
  store: MemoryProjectionStore,
  supplierStore: InMemoryStoreSupplierMetadataStore,
  sent: NotificationDispatchRequest[] = []
) {
  const dispatcher: NotificationDispatcher = {
    async send(request) {
      sent.push(request);
      return { ok: true, externalReceiptRef: "receipt:webhook" };
    }
  };
  return createNotificationService({
    store,
    supplierMetadataStore: supplierStore,
    productSchemaResolver: {
      async getProductSchemaByPlan() {
        return customsStoreProductSchema;
      }
    },
    dispatcher
  });
}

async function notificationStore(options: {
  readonly supportedStageIds: readonly string[];
  readonly events?: readonly ChainEvent[];
  readonly finalizedBlock?: bigint;
  readonly includeStoreSupplier?: boolean;
  readonly includeProfile?: boolean;
}): Promise<{ readonly store: MemoryProjectionStore; readonly supplierStore: InMemoryStoreSupplierMetadataStore }> {
  const events = [
    chainEvent(1n, "PlanRegistered", {
      planId: customsPlanIds.planId,
      planHash: customsPlanIds.planHash,
      hookCount: BigInt(customsOnchainHookPlanArtifact.compiledHooks.length)
    }),
    chainEvent(2n, "OrderRegistered", {
      orderId,
      planId: customsPlanIds.planId
    }),
    ...(options.events ?? [])
  ];
  const store = await projectionStoreFromEvents(events, options.finalizedBlock ?? 8n);
  const supplierStore = new InMemoryStoreSupplierMetadataStore();
  if (options.includeStoreSupplier !== false) {
    await supplierStore.putSupplier({
      supplierId: "supplier-a",
      supplierSubjectId,
      displayName: "Supplier A",
      wallet: supplierWallet,
      ...(options.includeProfile === false
        ? {}
        : {
            notificationProfile: notificationProfile(supplierWallet),
            notificationProfileHash: metadataHash
          }),
      notificationUpdatedAt: "2026-05-01T00:00:00.000Z",
      capabilityTags: [],
      supportedRoleSlotIds: [],
      supportedStageIds: options.supportedStageIds,
      registryAddresses: [identityRegistryAddress],
      reviewStatus: "approved_for_broadcast",
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-05-01T00:00:00.000Z"
    });
  }
  return { store, supplierStore };
}

async function projectionStoreFromEvents(events: readonly ChainEvent[], finalizedBlock: bigint): Promise<MemoryProjectionStore> {
  const store = new MemoryProjectionStore();
  await store.resetFromEvents({
    deploymentBlock: 0n,
    events,
    syncState: {
      chainId: 31337,
      contractAddress: stateMachineAddress,
      syncStatus: "indexed",
      finalizedBlock,
      confirmationDepth: 2,
      eventCount: events.length
    }
  });
  return store;
}

function signalEvent(
  blockNumber: bigint,
  dependency: { readonly sourceId: string; readonly signalId: string },
  key: Hex = idempotencyKey
): ChainEvent {
  return chainEvent(blockNumber, "SignalSubmitted", {
    orderId,
    sourceId: dependency.sourceId,
    signalId: dependency.signalId,
    payloadHash,
    idempotencyKey: key,
    submitter: signalSubmitter
  });
}

function authorizationEvent(
  blockNumber: bigint,
  hook: { readonly hookId: string },
  submitter: Address
): ChainEvent {
  return chainEvent(blockNumber, "SignalSubmitterAuthorized", {
    orderId,
    sourceId: hook.hookId,
    signalId: hook.hookId,
    submitter,
    role: bytes32Text("executor"),
    metadataHash
  });
}

function signalCapabilityEvent(
  blockNumber: bigint,
  hook: { readonly hookId: string; readonly stageId: string },
  logIndex = 0
): ChainEvent {
  return {
    ...chainEvent(blockNumber, "SignalCapabilityRegistered", {
      planId: customsPlanIds.planId,
      stageId: hook.stageId,
      targetSourceId: hook.hookId,
      signalId: hook.hookId,
      targetOrderRelation: 0
    }),
    logIndex
  };
}

function hookReadyEvent(
  blockNumber: bigint,
  hook: { readonly hookId: string; readonly stageId: string; readonly hookName: string }
): ChainEvent {
  return chainEvent(blockNumber, "HookReady", {
    orderId,
    hookId: hook.hookId,
    stageId: hook.stageId,
    hookName: bytes32Text(hook.hookName)
  });
}

function notificationProfile(wallet: Address): SupplierNotificationProfile {
  return {
    version: SUPPLIER_NOTIFICATION_PROFILE_VERSION,
    supplierSubjectId,
    wallet,
    transports: [
      {
        type: "webhook",
        endpointRef: "secret://supplier-a/webhook",
        priority: 10
      }
    ]
  };
}

function chainEvent(
  blockNumber: bigint,
  eventName: string,
  args: Record<string, unknown>,
  contractAddress = stateMachineAddress
): ChainEvent {
  return {
    chainId: 31337,
    contractAddress,
    blockNumber,
    blockHash: bytes32Hex(blockNumber.toString(16)),
    transactionHash: txHash(blockNumber),
    logIndex: 0,
    eventName,
    args
  };
}

function requiredDependency<TValue>(value: TValue | undefined): TValue {
  if (!value) {
    throw new Error("fixture dependency missing");
  }
  return value;
}

function requiredHook<TValue>(value: TValue | undefined): TValue {
  if (!value) {
    throw new Error("fixture hook missing");
  }
  return value;
}

function txHash(blockNumber: bigint): Hex {
  return bytes32Hex(blockNumber.toString(16));
}

function bytes32Hex(suffix: string): Hex {
  return `0x${suffix.padStart(64, "0")}`;
}

function bytes32Text(value: string): Hex {
  return `0x${Buffer.from(value, "utf8").toString("hex").padEnd(64, "0")}`;
}
