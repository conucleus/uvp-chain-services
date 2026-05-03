import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import {
  createNotificationService,
  supplierNotificationProfileDataUri,
  SUPPLIER_NOTIFICATION_PROFILE_VERSION,
  type NotificationDispatchRequest,
  type NotificationDispatcher,
  type SupplierNotificationProfile
} from "../src/notifications/index.js";
import { createApiRouter } from "../src/api/routes.js";
import type { ChainEvent } from "../src/indexer/events.js";
import { MemoryProjectionStore } from "../src/storage/projection-store.js";
import type { Address, Hex } from "../src/shared/types.js";

const stateMachineAddress = "0x1111111111111111111111111111111111111111" as Address;
const trustRegistryAddress = "0x2222222222222222222222222222222222222222" as Address;
const submitter = "0x3333333333333333333333333333333333333333" as Address;
const attester = "0x4444444444444444444444444444444444444444" as Address;
const domainId = bytes32Hex("1001");
const planId = bytes32Hex("2001");
const planHash = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex;
const orderId = bytes32Hex("3001");
const hookId = bytes32Hex("4001");
const stageId = bytes32Text("export.customs");
const hookName = bytes32Text("customs-review");
const role = bytes32Text("executor");
const supplierSubjectId = bytes32Hex("5001");
const metadataHash = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Hex;
const capabilityHash = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" as Hex;
const reputationHash = "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd" as Hex;
const reasonHash = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as Hex;
const adminHeaders = {
  "x-uvp-admin-id": "admin-1",
  "x-uvp-admin-role": "admin"
};

describe("supplier-routed notifications", () => {
  it("creates one webhook delivery from finalized HookReady, authorization, and supplier profile", async () => {
    const sent: NotificationDispatchRequest[] = [];
    const store = await projectionStoreFromEvents(baseEvents());
    const dispatcher: NotificationDispatcher = {
      async send(request) {
        sent.push(request);
        return { ok: true };
      }
    };
    const service = createNotificationService({
      store,
      dispatcher,
      productTaskBaseUrl: "https://store.example"
    });

    const summary = await service.runOnce();
    const secondSummary = await service.runOnce();
    const deliveries = await service.listDeliveries();

    expect(summary).toMatchObject({ finalizedTasks: 1, deliveryIntents: 1, sent: 1, failed: 0, skipped: 0 });
    expect(secondSummary).toMatchObject({ finalizedTasks: 1, deliveryIntents: 1, sent: 1 });
    expect(sent).toHaveLength(1);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      status: "sent",
      orderId,
      hookId,
      stageId,
      submitter,
      supplierSubjectId,
      supplierWallet: submitter,
      transportType: "webhook"
    });
    expect(sent[0]?.record.payload).toMatchObject({
      version: "uvp.hookReadyNotification.v1",
      chainId: 31337,
      stateMachineAddress,
      orderId,
      hookId,
      stageId,
      proof: {
        eventName: "HookReady",
        blockNumber: "4",
        transactionHash: txHash(4n),
        logIndex: 0
      }
    });
    expect(JSON.stringify(sent[0]?.record.payload).toLowerCase()).not.toContain("evidence");
  });

  it("dispatches Slack, email, and MCP as notification transports without changing task state", async () => {
    for (const transport of [
      { type: "slack" as const, channelRef: "secret://supplier-a/slack/customs" },
      { type: "email" as const, mailboxRef: "secret://supplier-a/email/ops" },
      { type: "mcp" as const, serverRef: "secret://supplier-a/mcp/server", toolName: "uvp.handleHookReady", authRef: "secret://supplier-a/mcp/auth" }
    ]) {
      const sent: NotificationDispatchRequest[] = [];
      const store = await projectionStoreFromEvents(baseEvents());
      const service = createNotificationService({
        store,
        profileResolver: async () => ({
          version: SUPPLIER_NOTIFICATION_PROFILE_VERSION,
          transports: [transport]
        }),
        dispatcher: {
          async send(request) {
            sent.push(request);
            return {
              ok: true,
              ...(request.transport.type === "mcp" ? { activationStatus: "started" as const } : {}),
              externalReceiptRef: `receipt:${request.transport.type}`
            };
          }
        }
      });

      await service.runOnce();
      const [delivery] = await service.listDeliveries();

      expect(sent).toHaveLength(1);
      expect(delivery).toMatchObject({
        status: "sent",
        transportType: transport.type,
        externalReceiptRef: `receipt:${transport.type}`
      });
      if (transport.type === "mcp") {
        expect(delivery).toMatchObject({ activationStatus: "started" });
      }
      expect(await store.getStateMachineTask(`${stateMachineAddress}:${orderId}:${hookId}`))
        .toMatchObject({ status: "ready" });
      expect(JSON.stringify(sent[0]?.record.payload).toLowerCase()).not.toContain("evidence");
    }
  });

  it("honors executor-watch as a self-managed supplier transport without push dispatch", async () => {
    const sent: NotificationDispatchRequest[] = [];
    const store = await projectionStoreFromEvents(baseEvents());
    const service = createNotificationService({
      store,
      profileResolver: async () => ({
        version: SUPPLIER_NOTIFICATION_PROFILE_VERSION,
        transports: [
          { type: "webhook", endpointRef: "secret://supplier-a/webhook", priority: 20 },
          { type: "executor-watch", instructionsURI: "ipfs://supplier-a/watch", priority: 0 }
        ]
      }),
      dispatcher: {
        async send(request) {
          sent.push(request);
          return { ok: true };
        }
      }
    });

    await service.runOnce();

    expect(sent).toHaveLength(0);
    expect(await service.listDeliveries()).toEqual([
      expect.objectContaining({
        status: "skipped",
        reason: "executor_watch_self_managed",
        transportType: "executor-watch"
      })
    ]);
  });

  it("records skipped delivery after supplier revocation without mutating the Product task", async () => {
    const store = await projectionStoreFromEvents(baseEvents({ supplierRevoked: true }));
    const service = createNotificationService({ store });

    const summary = await service.runOnce();
    const deliveries = await service.listDeliveries();

    expect(summary).toMatchObject({ skipped: 1, sent: 0 });
    expect(deliveries).toEqual([
      expect.objectContaining({
        status: "skipped",
        reason: "supplier_revoked",
        supplierSubjectId
      })
    ]);
    expect(await store.getStateMachineTask(`${stateMachineAddress}:${orderId}:${hookId}`))
      .toMatchObject({ status: "ready", assigneeWallet: submitter });
  });

  it("keeps HookReady task routable state separate from missing authorization and profile failures", async () => {
    const missingAuthorizationStore = await projectionStoreFromEvents(baseEvents({ includeAuthorization: false }));
    const missingProfileStore = await projectionStoreFromEvents(baseEvents({ includeProfile: false }));

    const authorizationService = createNotificationService({ store: missingAuthorizationStore });
    const profileService = createNotificationService({ store: missingProfileStore });
    await authorizationService.runOnce();
    await profileService.runOnce();

    expect(await missingAuthorizationStore.getStateMachineTask(`${stateMachineAddress}:${orderId}:${hookId}`))
      .toMatchObject({ status: "ready" });
    expect(await authorizationService.listDeliveries()).toEqual([
      expect.objectContaining({ status: "skipped", reason: "authorization_not_found" })
    ]);
    expect(await profileService.listDeliveries()).toEqual([
      expect.objectContaining({ status: "skipped", reason: "notification_profile_missing" })
    ]);
  });

  it("does not create delivery records from non-finalized or removed HookReady logs", async () => {
    const nonFinalizedStore = await projectionStoreFromEvents(baseEvents(), 3n);
    const removedHookStore = await projectionStoreFromEvents(baseEvents({ hookRemoved: true }), 6n);

    const nonFinalizedService = createNotificationService({ store: nonFinalizedStore });
    const removedHookService = createNotificationService({ store: removedHookStore });
    const nonFinalizedSummary = await nonFinalizedService.runOnce();
    const removedSummary = await removedHookService.runOnce();

    expect(nonFinalizedSummary).toMatchObject({ notFinalized: 1, deliveryIntents: 0 });
    expect(await nonFinalizedService.listDeliveries()).toEqual([]);
    expect(removedSummary).toMatchObject({ tasksScanned: 0, deliveryIntents: 0 });
    expect(await removedHookService.listDeliveries()).toEqual([]);
  });

  it("exposes notification profiles and delivery controls through admin ops routes", async () => {
    const store = await projectionStoreFromEvents(baseEvents());
    const notificationService = createNotificationService({ store });
    const router = createApiRouter(store, { notificationService });

    await expect(router.handle({ method: "GET", pathname: "/admin/notifications/profiles" }))
      .resolves.toMatchObject({ status: 403 });

    const profilesResponse = await router.handle({
      method: "GET",
      pathname: "/admin/notifications/profiles",
      headers: adminHeaders
    });
    const runResponse = await router.handle({
      method: "POST",
      pathname: "/admin/notifications/run-once",
      headers: adminHeaders
    });
    const deliveriesResponse = await router.handle({
      method: "GET",
      pathname: "/admin/notifications/deliveries",
      headers: adminHeaders,
      query: { orderId }
    });
    const delivery = (deliveriesResponse.body as { deliveries: Array<{ deliveryId: Hex }> }).deliveries[0];

    expect(profilesResponse.status).toBe(200);
    expect((profilesResponse.body as { profiles: Array<{ resolved: boolean }> }).profiles)
      .toContainEqual(expect.objectContaining({ resolved: true }));
    expect(runResponse).toMatchObject({
      status: 200,
      body: { summary: expect.objectContaining({ skipped: 1 }) }
    });
    expect(deliveriesResponse.status).toBe(200);
    expect(delivery?.deliveryId).toMatch(/^0x[0-9a-f]{64}$/);

    const retryResponse = await router.handle({
      method: "POST",
      pathname: `/admin/notifications/deliveries/${delivery?.deliveryId}/retry`,
      headers: adminHeaders
    });
    expect(retryResponse).toMatchObject({
      status: 200,
      body: { delivery: expect.objectContaining({ status: "pending" }) }
    });

    const deadLetterResponse = await router.handle({
      method: "POST",
      pathname: `/admin/notifications/deliveries/${delivery?.deliveryId}/dead-letter`,
      headers: adminHeaders,
      body: { reason: "operator review" }
    });
    expect(deadLetterResponse).toMatchObject({
      status: 200,
      body: { delivery: expect.objectContaining({ status: "dead_letter", reason: "operator review" }) }
    });
  });

  it("serves participant notifications with wallet privacy, read state, and no task authority", async () => {
    const overdueAt = BigInt(Math.floor(Date.parse("2026-05-01T00:00:00.000Z") / 1000));
    const store = await projectionStoreFromEvents([
      ...baseEvents(),
      chainEvent(6n, "TimerPoked", {
        orderId,
        hookId,
        dueAt: overdueAt
      }),
      chainEvent(7n, "PlanAttested", {
        domainId,
        planId,
        planHash,
        artifactHash: capabilityHash,
        policyHash: metadataHash,
        metadataHash,
        metadataURI: "https://store.example/zhixu/revoked",
        attester
      }, trustRegistryAddress),
      chainEvent(8n, "PlanRevoked", {
        domainId,
        planId,
        reasonHash,
        reasonURI: "ipfs://plan-revoked",
        revoker: attester
      }, trustRegistryAddress)
    ], 8n);
    const notificationService = createNotificationService({
      store,
      now: () => new Date("2026-05-02T12:00:00.000Z")
    });
    const router = createApiRouter(store, { notificationService });

    const visibleResponse = await router.handle({
      method: "GET",
      pathname: "/product/me/notifications",
      query: { walletAddress: submitter }
    });
    const wrongParticipantResponse = await router.handle({
      method: "GET",
      pathname: "/product/me/notifications",
      query: { walletAddress: "0x5555555555555555555555555555555555555555" }
    });

    expect(visibleResponse.status).toBe(200);
    const visibleBody = visibleResponse.body as {
      readonly unreadCount: number;
      readonly notifications: Array<{ readonly notificationId: Hex; readonly kind: string; readonly readStatus: string; readonly privacy: string }>;
    };
    expect(visibleBody.unreadCount).toBeGreaterThan(0);
    expect(visibleBody.notifications).toContainEqual(expect.objectContaining({
      kind: "task_overdue",
      privacy: "participant_only",
      readStatus: "unread"
    }));
    expect(visibleBody.notifications).toContainEqual(expect.objectContaining({
      kind: "plan_revoked",
      privacy: "participant_only"
    }));
    expect(JSON.stringify(visibleBody).toLowerCase()).not.toContain("secret://");
    expect((wrongParticipantResponse.body as { notifications: unknown[] }).notifications).toEqual([]);

    const overdueNotification = visibleBody.notifications.find((notification) => notification.kind === "task_overdue");
    const readResponse = await router.handle({
      method: "POST",
      pathname: `/product/me/notifications/${overdueNotification?.notificationId}/read`,
      body: { walletAddress: submitter }
    });
    const afterReadResponse = await router.handle({
      method: "GET",
      pathname: "/product/me/notifications",
      query: { walletAddress: submitter }
    });

    expect(readResponse).toMatchObject({
      status: 200,
      body: { notification: expect.objectContaining({ kind: "task_overdue", readStatus: "read" }) }
    });
    expect((afterReadResponse.body as { notifications: Array<{ kind: string; readStatus: string }> }).notifications)
      .toContainEqual(expect.objectContaining({ kind: "task_overdue", readStatus: "read" }));
    expect(await store.getStateMachineTask(`${stateMachineAddress}:${orderId}:${hookId}`))
      .toMatchObject({ status: "ready", assigneeWallet: submitter });
  });

  it("prepares and saves supplier-owned notification config with wallet proof and server recomputed hashes", async () => {
    const account = privateKeyToAccount("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const router = createApiRouter(new MemoryProjectionStore());
    const notification = {
      version: SUPPLIER_NOTIFICATION_PROFILE_VERSION,
      transports: [
        { type: "slack", channelRef: "secret://supplier-a/slack/customs" },
        { type: "email", mailboxRef: "secret://supplier-a/email/ops" },
        {
          type: "mcp",
          serverRef: "secret://supplier-a/mcp/server",
          toolName: "uvp.handleHookReady",
          authRef: "secret://supplier-a/mcp/auth",
          priority: 0
        }
      ]
    };
    const body = {
      domainId,
      supplierSubjectId,
      wallet: account.address,
      profile: { name: "Supplier A" },
      metadata: { displayName: "Supplier A" },
      capability: { lanes: ["CN-US"] },
      reputation: { score: 80 },
      capabilityHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
      notification
    };

    const prepareResponse = await router.handle({
      method: "POST",
      pathname: "/supplier/notifications/profile/prepare",
      body
    });
    expect(prepareResponse.status).toBe(200);
    const prepared = (prepareResponse.body as { profileConfig: { expectedMessage: string; capabilityHash: Hex; attestSupplierInput: Record<string, unknown> } }).profileConfig;
    expect(prepared.capabilityHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(prepared.capabilityHash).not.toBe(body.capabilityHash);
    expect(prepared.attestSupplierInput).toMatchObject({
      domainId,
      supplierSubjectId,
      wallet: account.address.toLowerCase(),
      capability: expect.objectContaining({ notification })
    });

    const signature = await account.signMessage({ message: prepared.expectedMessage });
    const saveResponse = await router.handle({
      method: "POST",
      pathname: "/supplier/notifications/profile",
      body: {
        ...body,
        walletProof: {
          message: prepared.expectedMessage,
          signature
        }
      }
    });
    const listResponse = await router.handle({
      method: "GET",
      pathname: "/supplier/notifications/profile",
      query: { wallet: account.address }
    });

    expect(saveResponse).toMatchObject({
      status: 201,
      body: {
        profileConfig: expect.objectContaining({
          wallet: account.address.toLowerCase(),
          capabilityHash: prepared.capabilityHash,
          walletProofSignatureHash: expect.stringMatching(/^0x[0-9a-f]{64}$/)
        })
      }
    });
    expect((listResponse.body as { profileConfigs: Array<{ wallet: string }> }).profileConfigs)
      .toContainEqual(expect.objectContaining({ wallet: account.address.toLowerCase() }));

    await expect(router.handle({
      method: "POST",
      pathname: "/supplier/notifications/profile",
      body: {
        ...body,
        walletProof: {
          message: prepared.expectedMessage,
          signature: `0x${"11".repeat(65)}`
        }
      }
    })).resolves.toMatchObject({
      status: 403,
      body: { error: "wallet_proof_invalid" }
    });
  });
});

async function projectionStoreFromEvents(events: readonly ChainEvent[], finalizedBlock = 6n): Promise<MemoryProjectionStore> {
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

function baseEvents(options: {
  readonly includeAuthorization?: boolean;
  readonly includeProfile?: boolean;
  readonly supplierRevoked?: boolean;
  readonly hookRemoved?: boolean;
} = {}): readonly ChainEvent[] {
  const includeAuthorization = options.includeAuthorization ?? true;
  const includeProfile = options.includeProfile ?? true;
  const hookReady = chainEvent(4n, "HookReady", {
    orderId,
    hookId,
    stageId,
    hookName
  });
  return [
    chainEvent(1n, "PlanRegistered", {
      planId,
      planHash,
      hookCount: 1n
    }),
    chainEvent(2n, "OrderRegistered", {
      orderId,
      planId
    }),
    ...(includeAuthorization
      ? [
          chainEvent(3n, "SignalSubmitterAuthorized", {
            orderId,
            sourceId: stageId,
            signalId: hookName,
            submitter,
            role,
            metadataHash
          })
        ]
      : []),
    hookReady,
    ...(options.hookRemoved ? [{ ...hookReady, removed: true }] : []),
    chainEvent(5n, "SupplierAttested", {
      domainId,
      supplierSubjectId,
      wallet: submitter,
      profileHash: metadataHash,
      capabilityHash,
      reputationHash,
      metadataURI: includeProfile ? supplierNotificationProfileDataUri(notificationProfile()) : "https://profiles.example/supplier-a",
      attester
    }, trustRegistryAddress),
    ...(options.supplierRevoked
      ? [
          chainEvent(6n, "SupplierRevoked", {
            domainId,
            supplierSubjectId,
            reasonHash,
            reasonURI: "ipfs://supplier-revoked",
            revoker: attester
          }, trustRegistryAddress)
        ]
      : [])
  ];
}

function notificationProfile(): SupplierNotificationProfile {
  return {
    version: SUPPLIER_NOTIFICATION_PROFILE_VERSION,
    supplierSubjectId,
    wallet: submitter,
    productTaskUrlTemplate: "https://store.example/tasks/{taskId}",
    transports: [
      {
        type: "slack",
        channelRef: "secret://supplier-a/slack/customs",
        priority: 30
      },
      {
        type: "webhook",
        endpointRef: "secret://supplier-a/webhook",
        priority: 20
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

function txHash(blockNumber: bigint): Hex {
  return bytes32Hex(blockNumber.toString(16));
}

function bytes32Hex(suffix: string): Hex {
  return `0x${suffix.padStart(64, "0")}`;
}

function bytes32Text(value: string): Hex {
  return `0x${Buffer.from(value, "utf8").toString("hex").padEnd(64, "0")}`;
}
