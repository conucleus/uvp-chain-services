import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createApiRouter } from "../src/api/routes.js";
import { createNotificationService, createSupplierNotificationProfileConfigService, MemorySupplierNotificationProfileConfigStore } from "../src/notifications/index.js";
import { InMemoryAuditSink } from "../src/security/index.js";
import { createChainServicesStores, type ChainServicesStores } from "../src/storage/factory.js";
import { createPostgresTestDatabase } from "./postgres.js";
import { recordStoreAudit } from "../src/store/console/audit.js";

const operatorHeaders = {
  "x-uvp-store-operator-id": "audit-operator",
  "x-uvp-store-operator-role": "store_operator",
  "x-uvp-store-dev-anchored-address": "0x1234567890123456789012345678901234567890"
};

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

const readerHeaders = {
  "x-uvp-store-user-id": "audit-reader",
  "x-uvp-store-role": "read"
};

const adminHeaders = {
  "x-uvp-admin-id": "audit-admin",
  "x-uvp-admin-role": "admin"
};

const registryAddress = "0x5555555555555555555555555555555555555555";
const supplierSubjectId = "0x0000000000000000000000000000000000000000000000000000000000007001";
const supplierWallet = "0x4444444444444444444444444444444444444444";

describe("durable Store operator audit", () => {
  const openedStores: ChainServicesStores[] = [];

  afterEach(async () => {
    for (const store of openedStores.splice(0)) {
      await store.close();
    }
  });

  it("persists Store audit rows and exposes filtered GET /store/audit", async () => {
    const audit = new InMemoryAuditSink();
    const databaseUrl = await createPostgresTestDatabase();
    const first = openStores(databaseUrl, openedStores);
    const router = createApiRouter(first.projectionStore, { ...requiredRouterStores(first), productRuntimeEnvironment: "local", submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111", storeAuthConfig: devAnchoredStoreAuth,
      audit,
      storeAuditStore: first.storeAuditStore,
      storeZhixuDraftStore: first.storeZhixuDraftStore
    });

    const importResponse = await router.handle({
      method: "POST",
      pathname: "/store/zhixu-drafts/import",
      headers: {
        ...operatorHeaders,
        "x-uvp-request-id": "req-durable-audit-1"
      },
      body: {
        sourceKind: "zhixu_yaml",
        content: "apiVersion: uvp/v0\nkind: Zhixu\nmetadata:\n  name: durable-audit\n",
        title: "Durable audit"
      }
    });
    expect(importResponse.status).toBe(201);
    await first.close();
    openedStores.splice(openedStores.indexOf(first), 1);

    const reopened = openStores(databaseUrl, openedStores);
    const reopenedRouter = createApiRouter(reopened.projectionStore, { ...requiredRouterStores(reopened), productRuntimeEnvironment: "local", submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111", storeAuthConfig: devAnchoredStoreAuth,
      storeAuditStore: reopened.storeAuditStore
    });
    const auditResponse = await reopenedRouter.handle({
      method: "GET",
      pathname: "/store/audit",
      query: {
        actor: "audit-operator",
        action: "store.draft.import",
        outcome: "succeeded",
        limit: "10"
      },
      headers: adminHeaders
    });

    expect(auditResponse.status).toBe(200);
    expect(auditResponse.body).toMatchObject({
      records: [
        expect.objectContaining({
          actor: "audit-operator",
          action: "store.draft.import",
          outcome: "succeeded",
          resourceType: "store_zhixu_draft",
          accessLevel: "store_operator",
          requestId: "req-durable-audit-1"
        })
      ]
    });
    expect(audit.list()).toContainEqual(expect.objectContaining({
      type: "store.operator",
      action: "store.draft.import",
      outcome: "succeeded"
    }));
  });

  it("isolates the audit stream per acting tenant (U5)", async () => {
    const audit = new InMemoryAuditSink();
    const stores = openStores(await createPostgresTestDatabase(), openedStores);
    const router = createApiRouter(stores.projectionStore, { ...requiredRouterStores(stores), productRuntimeEnvironment: "local", submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111", storeAuthConfig: devAnchoredStoreAuth,
      audit,
      storeAuditStore: stores.storeAuditStore
    });

    const importResponse = await router.handle({
      method: "POST",
      pathname: "/store/zhixu-drafts/import",
      headers: { ...operatorHeaders, "x-uvp-request-id": "req-audit-tenant-1" },
      body: {
        sourceKind: "zhixu_yaml",
        content: "apiVersion: uvp/v0\nkind: Zhixu\nmetadata:\n  name: tenant-isolated\n",
        title: "Tenant isolated"
      }
    });
    expect(importResponse.status).toBe(201);

    const readerStream = await router.handle({
      method: "GET",
      pathname: "/store/audit",
      headers: readerHeaders
    });
    expect(readerStream.status).toBe(200);
    expect(((readerStream.body as { records: { actor: string }[] }).records)
      .every((record) => record.actor === "audit-reader")).toBe(true);
    expect((readerStream.body as { records: unknown[] }).records).toHaveLength(0);

    await expect(router.handle({
      method: "GET",
      pathname: "/store/audit",
      query: { actor: "audit-operator" },
      headers: readerHeaders
    })).resolves.toMatchObject({ status: 403, body: { error: "store_audit_actor_forbidden" } });

    const operatorStream = await router.handle({
      method: "GET",
      pathname: "/store/audit",
      headers: operatorHeaders
    });
    expect(operatorStream.status).toBe(200);
    expect(((operatorStream.body as { records: { actor: string }[] }).records)
      .every((record) => record.actor === "audit-operator")).toBe(true);
    expect(((operatorStream.body as { records: { requestId?: string }[] }).records)
      .some((record) => record.requestId === "req-audit-tenant-1")).toBe(true);

    const adminStream = await router.handle({
      method: "GET",
      pathname: "/store/audit",
      headers: adminHeaders
    });
    expect(adminStream.status).toBe(200);
    expect(((adminStream.body as { records: { actor: string }[] }).records)
      .some((record) => record.actor === "audit-operator")).toBe(true);
  });

  it("redacts sensitive audit metadata before durable storage", async () => {
    const stores = openStores(await createPostgresTestDatabase(), openedStores);

    await recordStoreAudit(new InMemoryAuditSink(), {
      action: "store.draft.import",
      outcome: "failed",
      access: {
        level: "store_operator",
        principalId: "audit-operator",
        roles: ["store_operator"],
        capabilities: ["store.read", "store.audit.read", "store.draft.import"],
        authMode: "dev_store_headers",
        canWrite: true,
        canAdmin: false
      },
      resource: { type: "store_zhixu_draft", id: "draft-sensitive" },
      metadata: {
        privateKey: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        jwt: "ey.secret",
        rawSignature: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        evidencePlaintext: "doc-1 plaintext",
        safeCount: 1
      }
    }, { store: stores.storeAuditStore, now: () => new Date("2026-04-30T00:00:00.000Z") });

    const records = await stores.storeAuditStore.query({ resourceId: "draft-sensitive" });
    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain("aaaaaaaaaaaaaaaa");
    expect(serialized).not.toContain("ey.secret");
    expect(serialized).not.toContain("doc-1 plaintext");
    expect(records[0]?.metadata).toMatchObject({
      privateKey: "[redacted]",
      jwt: "[redacted]",
      rawSignature: "[redacted]",
      evidencePlaintext: "[redacted]",
      safeCount: 1
    });
  });

  it("classifies duplicate and rejected Store outcomes in durable audit", async () => {
    const stores = openStores(await createPostgresTestDatabase(), openedStores);
    const router = createApiRouter(stores.projectionStore, { ...requiredRouterStores(stores), productRuntimeEnvironment: "local", submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111", storeAuthConfig: devAnchoredStoreAuth,
      storeAuditStore: stores.storeAuditStore,
      storeSupplierMetadataStore: stores.storeSupplierMetadataStore
    });

    await expect(router.handle({
      method: "POST",
      pathname: "/store/suppliers",
      headers: operatorHeaders,
      body: supplierBody()
    })).resolves.toMatchObject({ status: 201 });

    await expect(router.handle({
      method: "POST",
      pathname: "/store/suppliers",
      headers: operatorHeaders,
      body: supplierBody()
    })).resolves.toMatchObject({
      status: 409,
      body: { error: "supplier_id_exists" }
    });

    await expect(router.handle({
      method: "GET",
      pathname: "/store/audit",
      query: {
        action: "store.supplier.create",
        outcome: "duplicate"
      },
      headers: adminHeaders
    })).resolves.toMatchObject({
      status: 200,
      body: {
        records: [
          expect.objectContaining({
            action: "store.supplier.create",
            outcome: "duplicate",
            errorCode: "supplier_id_exists"
          })
        ]
      }
    });

  });
});

function requiredRouterStores(stores: ChainServicesStores) {
  return {
    storeSupplierMetadataStore: stores.storeSupplierMetadataStore,
    storeEntityRegistrationStore: stores.storeEntityRegistrationStore,
    storeWalletSessionStore: stores.storeWalletSessionStore,
    storeDecorationStore: stores.storeDecorationStore,
    storePublisherDelegationStore: stores.storePublisherDelegationStore,
    identityDescriptorSnapshots: stores.identityDescriptorSnapshots,
    storeListingStore: stores.storeListingStore,
    storeJoinApplicationStore: stores.storeJoinApplicationStore,
    productBffStore: stores.productBffStore,
    orderStore: stores.orderStore,
    orderRequirementsStore: stores.orderRequirementsStore,
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
    })
  };
}

function openStores(databaseUrl: string, openedStores: ChainServicesStores[]): ChainServicesStores {
  const stores = createChainServicesStores({
    database: {
      url: databaseUrl,
      migrationsAutoRun: true
    },
    chainId: 31337,
    migrationsDirectory: migrationsDirectory()
  });
  openedStores.push(stores);
  return stores;
}

function migrationsDirectory(): string {
  return fileURLToPath(new URL("../migrations", import.meta.url));
}

function supplierBody(): Record<string, unknown> {
  return {
    supplierId: "supplier-durable-audit",
    supplierSubjectId,
    displayName: "Durable Audit Supplier",
    wallet: supplierWallet,
    capabilityTags: ["tag-1"],
    supportedRoleSlotIds: ["slot-a"],
    supportedStageIds: ["stage-1"],
    registryAddresses: [registryAddress]
  };
}
