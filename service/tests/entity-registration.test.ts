import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiRouter } from "../src/api/routes.js";
import { createNotificationService, createSupplierNotificationProfileConfigService, MemorySupplierNotificationProfileConfigStore } from "../src/notifications/index.js";
import { createChainServicesStores, type ChainServicesStores } from "../src/storage/factory.js";
import { createPostgresTestDatabase } from "./postgres.js";
import type { CreateApiRouterOptions } from "../src/api/route-context.js";

const anchoredAccount = "0x1234567890123456789012345678901234567890";
const otherAccount = "0x9999999999999999999999999999999999999999";

const devAnchoredStoreAuth = {
  mode: "dev_headers" as const,
  roleClaim: "roles",
  principalClaim: "sub",
  clockToleranceSeconds: 60,
  walletSession: {
    enabled: true,
    operatorWallets: [],
    adminWallets: [],
    sessionTtlSeconds: 43200,
    challengeTtlSeconds: 300,
    devAnchoredAddressHeaderEnabled: true,
  },
};

const sessionHeaders = { "x-uvp-store-dev-anchored-address": anchoredAccount };
const otherSessionHeaders = { "x-uvp-store-dev-anchored-address": otherAccount };

let stores: ChainServicesStores;

beforeAll(async () => {
  stores = createChainServicesStores({
    database: { url: await createPostgresTestDatabase(), migrationsAutoRun: true }
  });
});

afterAll(async () => {
  await stores.close();
});

function createRouter(options: {
  readonly storeEntityRegistrationStore?: CreateApiRouterOptions["storeEntityRegistrationStore"];
  readonly storeSupplierMetadataStore?: CreateApiRouterOptions["storeSupplierMetadataStore"];
} = {}) {
  return createApiRouter(stores.projectionStore, {
    productRuntimeEnvironment: "local",
    submissionChainId: 84532,
    submissionVerifyingContract: "0x1111111111111111111111111111111111111111",
    storeAuthConfig: devAnchoredStoreAuth,
    storeEntityRegistrationStore:
      options.storeEntityRegistrationStore ?? stores.storeEntityRegistrationStore,
    storeSupplierMetadataStore:
      options.storeSupplierMetadataStore ?? stores.storeSupplierMetadataStore,
    storeWalletSessionStore: stores.storeWalletSessionStore,
    storeDecorationStore: stores.storeDecorationStore,
    storePublisherDelegationStore: stores.storePublisherDelegationStore,
    identityDescriptorSnapshots: stores.identityDescriptorSnapshots,
    storeListingStore: stores.storeListingStore,
    storeJoinApplicationStore: stores.storeJoinApplicationStore,
    productBffStore: stores.productBffStore,
    orderStore: stores.orderStore,
    evidenceMetadataStore: stores.evidenceMetadataStore,
    submissionStore: stores.submissionStore,
    governanceStore: stores.governanceStore,
    stageExecutorPatchStore: stores.stageExecutorPatchStore,
    stageResourcePatchStore: stores.stageResourcePatchStore,
    storeZhixuDraftStore: stores.storeZhixuDraftStore,
    storeZhixuVersionMetadataStore: stores.storeZhixuVersionMetadataStore,
    storeDockingSessionStore: stores.storeDockingSessionStore,
    storeAuditStore: stores.storeAuditStore,
    notificationService: createNotificationService({
      store: stores.projectionStore,
      supplierMetadataStore: stores.storeSupplierMetadataStore,
      deliveryStore: stores.notificationStateStore,
      participantReadStateStore: stores.notificationStateStore
    }),
    supplierNotificationConfigService: createSupplierNotificationProfileConfigService({
      store: new MemorySupplierNotificationProfileConfigStore()
    }),
  });
}

const validBody = {
  legalName: "示例示例示例流程有限公司",
  registrationNumber: "91310000MA1K000000",
  contactName: "张经理",
};

describe("participant entity registration routes", () => {
  it("requires a session-anchored wallet for both write and read", async () => {
    const router = createRouter();

    await expect(router.handle({
      method: "POST",
      pathname: "/product/registration",
      body: validBody,
    })).resolves.toMatchObject({
      status: 401,
      body: { error: "wallet_identity_required" },
    });

    await expect(router.handle({
      method: "GET",
      pathname: "/product/registration/me",
    })).resolves.toMatchObject({
      status: 401,
      body: { error: "wallet_identity_required" },
    });
  });

  it("anchors the account address from the session and stores an unverified off-chain declaration", async () => {
    const registrationStore = stores.storeEntityRegistrationStore;
    const supplierStore = stores.storeSupplierMetadataStore;
    const router = createRouter({
      storeEntityRegistrationStore: registrationStore,
      storeSupplierMetadataStore: supplierStore,
    });

    const created = await router.handle({
      method: "POST",
      pathname: "/product/registration",
      headers: sessionHeaders,
      body: validBody,
    });
    expect(created.status).toBe(201);
    const registration = (created.body as { registration: Record<string, unknown> }).registration;
    expect(registration).toMatchObject({
      accountAddress: anchoredAccount.toLowerCase(),
      legalName: validBody.legalName,
      registrationNumber: validBody.registrationNumber,
      contactName: validBody.contactName,
      status: "self_declared",
      verified: false,
      chainWritten: false,
    });
    expect(String(registration.registrationId)).toMatch(/^registration_/);
    expect(String(registration.createdAt)).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    await expect(supplierStore.listSuppliers()).resolves.toEqual([]);

    const mine = await router.handle({
      method: "GET",
      pathname: "/product/registration/me",
      headers: sessionHeaders,
    });
    expect(mine.status).toBe(200);
    expect((mine.body as { registration: unknown }).registration).toMatchObject({
      registrationId: registration.registrationId,
      legalName: validBody.legalName,
    });

    const anonymousOther = await router.handle({
      method: "GET",
      pathname: "/product/registration/me",
      headers: otherSessionHeaders,
    });
    expect(anonymousOther).toEqual({ status: 200, body: { registration: null } });
  });

  it("updates the single active record on resubmission instead of appending history", async () => {
    const registrationStore = stores.storeEntityRegistrationStore;
    const router = createRouter({ storeEntityRegistrationStore: registrationStore });

    const first = await router.handle({
      method: "POST",
      pathname: "/product/registration",
      headers: sessionHeaders,
      body: validBody,
    });
    const second = await router.handle({
      method: "POST",
      pathname: "/product/registration",
      headers: sessionHeaders,
      body: { ...validBody, legalName: "示例示例示例流程（更名）有限公司", contactName: "李经理" },
    });

    const firstRegistration = (first.body as { registration: { registrationId: string; createdAt: string } }).registration;
    const secondRegistration = (second.body as {
      registration: { registrationId: string; createdAt: string; updatedAt: string; legalName: string };
    }).registration;
    expect(secondRegistration.registrationId).toBe(firstRegistration.registrationId);
    expect(secondRegistration.createdAt).toBe(firstRegistration.createdAt);
    expect(secondRegistration.legalName).toBe("示例示例示例流程（更名）有限公司");
    expect(secondRegistration.updatedAt >= firstRegistration.createdAt).toBe(true);

    const stored = await registrationStore.getRegistrationByAccount(
      anchoredAccount.toLowerCase() as `0x${string}`
    );
    expect(stored).toMatchObject({
      registrationId: firstRegistration.registrationId,
      legalName: "示例示例示例流程（更名）有限公司",
      contactName: "李经理",
    });
  });

  it("rejects client-supplied identity/verification fields and invalid declarations", async () => {
    const router = createRouter();

    for (const field of ["account", "accountAddress", "walletAddress", "status", "verified"]) {
      const response = await router.handle({
        method: "POST",
        pathname: "/product/registration",
        headers: sessionHeaders,
        body: { ...validBody, [field]: field === "verified" ? true : "0xabc" },
      });
      expect(response).toMatchObject({ status: 400, body: { error: "immutable_field" } });
    }

    await expect(router.handle({
      method: "POST",
      pathname: "/product/registration",
      headers: sessionHeaders,
      body: { legalName: "  ", registrationNumber: "9131", contactName: "张经理" },
    })).resolves.toMatchObject({ status: 400, body: { error: "invalid_body" } });

    await expect(router.handle({
      method: "POST",
      pathname: "/product/registration",
      headers: sessionHeaders,
      body: { ...validBody, registrationNumber: "x".repeat(65) },
    })).resolves.toMatchObject({ status: 400, body: { error: "invalid_body" } });

    await expect(router.handle({
      method: "POST",
      pathname: "/product/registration",
      headers: sessionHeaders,
      body: undefined,
    })).resolves.toMatchObject({ status: 400, body: { error: "invalid_body" } });
  });
});
