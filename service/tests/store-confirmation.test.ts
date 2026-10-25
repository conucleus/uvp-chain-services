import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiRouter } from "../src/api/routes.js";
import { createNotificationService, createSupplierNotificationProfileConfigService, MemorySupplierNotificationProfileConfigStore } from "../src/notifications/index.js";
import { createChainServicesStores, type ChainServicesStores } from "../src/storage/factory.js";
import { createPostgresTestDatabase } from "./postgres.js";
import type { Address, Hex } from "../src/shared/types.js";

let stores: ChainServicesStores;

beforeAll(async () => {
  stores = createChainServicesStores({
    database: { url: await createPostgresTestDatabase(), migrationsAutoRun: true }
  });
});

afterAll(async () => {
  await stores.close();
});

function requiredRouterStores() {
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

const operatorHeaders = {
  "x-uvp-store-operator-id": "operator-confirm",
  "x-uvp-store-operator-role": "store_operator",
  "x-uvp-store-dev-anchored-address": "0x1234567890123456789012345678901234567890"
};

const adminHeaders = {
  "x-uvp-admin-id": "governance-confirm",
  "x-uvp-admin-role": "admin",
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

const registryAddress = "0x5555555555555555555555555555555555555555" as Address;
const supplierSubjectId = "0x0000000000000000000000000000000000000000000000000000000000007001" as Hex;
const supplierWallet = "0x4444444444444444444444444444444444444444" as Address;

describe("Store sensitive action confirmation", () => {
  it("requires exact confirmation before supplier approval and governance handoff side effects", async () => {
    const router = createApiRouter(stores.projectionStore, { ...requiredRouterStores(), productRuntimeEnvironment: "local", submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111", storeAuthConfig: devAnchoredStoreAuth });

    await expect(router.handle({
      method: "POST",
      pathname: "/store/suppliers",
      headers: operatorHeaders,
      body: supplierBody()
    })).resolves.toMatchObject({ status: 201 });

    await expect(router.handle({
      method: "POST",
      pathname: "/store/suppliers/supplier-confirm/review",
      headers: operatorHeaders,
      body: {
        reviewStatus: "approved_for_broadcast",
        capabilityTags: ["tag-2"]
      }
    })).resolves.toMatchObject({
      status: 400,
      body: { error: "store_confirmation_required" }
    });

    await expect(router.handle({
      method: "POST",
      pathname: "/store/suppliers/supplier-confirm/review",
      headers: operatorHeaders,
      body: {
        reviewStatus: "submitted",
        capabilityTags: ["tag-2"]
      }
    })).resolves.toMatchObject({ status: 200 });

    await expect(router.handle({
      method: "POST",
      pathname: "/store/suppliers/supplier-confirm/review",
      headers: operatorHeaders,
      body: {
        reviewStatus: "approved_for_broadcast",
        capabilityTags: ["tag-2"],
        confirmation: { supplierId: "wrong-supplier" }
      }
    })).resolves.toMatchObject({
      status: 400,
      body: { error: "store_confirmation_mismatch" }
    });

    await expect(router.handle({
      method: "POST",
      pathname: "/store/suppliers/supplier-confirm/review",
      headers: operatorHeaders,
      body: {
        reviewStatus: "approved_for_broadcast",
        capabilityTags: ["tag-2"],
        confirmation: { supplierId: "supplier-confirm" }
      }
    })).resolves.toMatchObject({ status: 200 });

    await expect(router.handle({
      method: "POST",
      pathname: "/store/suppliers/supplier-confirm/request-identity-registration",
      headers: adminHeaders,
      body: {}
    })).resolves.toMatchObject({
      status: 400,
      body: { error: "store_confirmation_required" }
    });
  });
});

function supplierBody(): Record<string, unknown> {
  return {
    supplierId: "supplier-confirm",
    supplierSubjectId,
    displayName: "Confirmation Supplier",
    wallet: supplierWallet,
    capabilityTags: ["tag-1"],
    supportedRoleSlotIds: ["slot-a"],
    supportedStageIds: ["stage-1"],
    registryAddresses: [registryAddress]
  };
}
