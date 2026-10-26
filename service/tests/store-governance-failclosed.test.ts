import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { keccak256, stringToBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { StoreProductSchemaDTO } from "@uvp-eth/product-dto";
import {
  EXAMPLE_ZHIXU_ID,
  exampleOnchainHookPlanArtifact,
  stagePlanIds,
  examplePlanIds,
  demoZhixuDetail
} from "./fixtures/business/index.js";
import { createApiRouter, type ApiRouter } from "../src/api/routes.js";
import { createNotificationService, createSupplierNotificationProfileConfigService, MemorySupplierNotificationProfileConfigStore } from "../src/notifications/index.js";
import { loadConfigFromEnv } from "../src/config/env.js";
import { adminPrincipalFromHeaders, createGovernanceService, InMemoryGovernanceStore } from "../src/governance/index.js";
import { PostgresGovernanceStore } from "../src/governance/postgres-store.js";
import { hashIdentityDescriptor } from "../src/governance/hashing.js";
import type { ChainEvent } from "../src/indexer/events.js";
import {
  BackupEvidenceStorage,
  LocalEvidenceStorage,
  ObjectEvidenceStorage
} from "../src/evidence/index.js";
import { verifyProofBundle } from "../src/proof-verifier/service.js";
import { createProductService } from "../src/product/application/service.js";

import {
  MemoryStoreZhixuVersionMetadataStore,
  createStoreZhixuVersionService
} from "../src/store/console/version.js";
import { PostgresStoreWalletSessionStore, createStoreSessionService } from "../src/store/sessions/index.js";
import type { StoreJoinApplicationStore } from "../src/store/join/types.js";
import {
  PostgresStorePublisherDelegationStore,
  PostgresStoreZhixuDecorationStore
} from "../src/store-access-postgres-stores.js";
import { createChainServicesStores, type ChainServicesStores } from "../src/storage/factory.js";
import { PostgresDatabase } from "../src/storage/postgres-client.js";
import type { ProjectionStore } from "../src/storage/projection-store.js";
import { createPostgresTestDatabase } from "./postgres.js";
import { exampleSchemaResolver } from "./example-schema.js";
import type { Address, Hex } from "../src/shared/types.js";

let stores: ChainServicesStores;
let failClosedDatabase: PostgresDatabase;

beforeAll(async () => {
  const databaseUrl = await createPostgresTestDatabase();
  stores = createChainServicesStores({
    database: { url: databaseUrl, migrationsAutoRun: true },
    chainId: 31337
  });
  failClosedDatabase = new PostgresDatabase({ databaseUrl });
});

beforeEach(async () => {
  // 原先每用例各建一个 Memory projection store + 各域内存件：同一克隆库内
  // 清空本文件会写入的表，保持用例间互不可见。
  await failClosedDatabase.query("DELETE FROM chain_event_log WHERE chain_id = 31337");
  await failClosedDatabase.query("DELETE FROM chain_projection_snapshot WHERE chain_id = 31337");
  await failClosedDatabase.query("DELETE FROM chain_index_cursor WHERE chain_id = 31337");
  await failClosedDatabase.query("DELETE FROM chain_projection_sync_state WHERE chain_id = 31337");
  await failClosedDatabase.query("DELETE FROM store_auth_challenge");
  await failClosedDatabase.query("DELETE FROM store_wallet_session");
  await failClosedDatabase.query("DELETE FROM store_account_address");
  await failClosedDatabase.query("DELETE FROM store_identity_descriptor_snapshot");
  await failClosedDatabase.query("DELETE FROM store_zhixu_decoration");
  await failClosedDatabase.query("DELETE FROM store_publisher_delegation");
  await failClosedDatabase.query("DELETE FROM store_zhixu_listing");
  await failClosedDatabase.query("DELETE FROM store_join_application_event");
  await failClosedDatabase.query("DELETE FROM store_join_application");
  await failClosedDatabase.query("DELETE FROM product_order_draft");
  await failClosedDatabase.query("DELETE FROM product_invite");
});

afterAll(async () => {
  await failClosedDatabase.close();
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

const contractAddress = "0x1111111111111111111111111111111111111111" as Address;
const publisherAddress = "0xaaaa000000000000000000000000000000000001" as Address;
const supplierWalletKey = "0x1111111111111111111111111111111111111111111111111111111111111111";
const supplierAccount = privateKeyToAccount(supplierWalletKey);
const supplierWallet = supplierAccount.address as Address;
const rivalWallet = "0xcccc000000000000000000000000000000000003" as Address;
const planId = examplePlanIds.planId as Hex;
const planHashFixture = examplePlanIds.planHash as Hex;
const planHash = examplePlanIds.planHash as Hex;
const roleSlotId = demoZhixuDetail.roleSlots[0]?.slotId ?? "supplier";
const adminHeaders = { "x-uvp-admin-id": "governance-admin-1", "x-uvp-admin-role": "governance_admin" };
const storeAdminHeaders = { "x-uvp-store-user-id": "store-admin-1", "x-uvp-store-role": "admin", "x-uvp-store-dev-anchored-address": publisherAddress };
const adminTokenPlaintext = "test-admin-password";
const adminTokenHash = "f7a03f48c0e2aa2d5e55ca186c20032ddbf53b7f5f93fce387d65c3f83433e8d";

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
const publisherAnchoredHeaders = {
  ...storeAdminHeaders,
  "x-uvp-store-dev-anchored-address": publisherAddress
};

const tempDirs: string[] = [];

describe("store, governance, and evidence fail-closed behaviors", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("authentication fail-closed", () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
      for (const key of ["CHAIN_SERVICES_RUNTIME_ENV", "GOVERNANCE_ADMIN_REVIEWER_IDS"] as const) {
        const value = originalEnv[key];
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    });

    it("rejects self-reported governance admin headers outside local when the whitelist is empty", () => {
      expect(adminPrincipalFromHeaders({
        "x-uvp-admin-id": "attacker",
        "x-uvp-admin-role": "governance_admin"
      }, { runtimeEnvironment: "testnet", allowedAdminIds: [] })).toBeUndefined();
      expect(adminPrincipalFromHeaders({
        "x-uvp-admin-id": "gov-reviewer-1",
        "x-uvp-admin-role": "governance_admin"
      }, { runtimeEnvironment: "testnet", allowedAdminIds: ["gov-reviewer-1"] })).toBeUndefined();
      expect(adminPrincipalFromHeaders({
        "x-uvp-admin-id": "attacker",
        "x-uvp-admin-role": "governance_admin"
      }, { runtimeEnvironment: "testnet", allowedAdminIds: ["gov-reviewer-1"], adminTokenHashes: [adminTokenHash] }))
        .toBeUndefined();
      expect(adminPrincipalFromHeaders({
        "x-uvp-admin-id": "gov-reviewer-1",
        "x-uvp-admin-role": "governance_admin",
        "x-uvp-admin-token": "wrong-password"
      }, { runtimeEnvironment: "testnet", allowedAdminIds: ["gov-reviewer-1"], adminTokenHashes: [adminTokenHash] }))
        .toBeUndefined();
      expect(adminPrincipalFromHeaders({
        "x-uvp-admin-id": "gov-reviewer-1",
        "x-uvp-admin-role": "governance_admin",
        "x-uvp-admin-token": adminTokenPlaintext
      }, { runtimeEnvironment: "testnet", allowedAdminIds: ["gov-reviewer-1"], adminTokenHashes: [adminTokenHash] }))
        .toMatchObject({ adminId: "gov-reviewer-1" });
      expect(adminPrincipalFromHeaders({
        "x-uvp-admin-id": "attacker",
        "x-uvp-admin-role": "governance_admin",
        "x-uvp-admin-token": adminTokenPlaintext
      }, { runtimeEnvironment: "testnet", allowedAdminIds: ["gov-reviewer-1"], adminTokenHashes: [adminTokenHash] }))
        .toBeUndefined();
      expect(adminPrincipalFromHeaders({
        "x-uvp-admin-id": "gov-reviewer-1",
        "x-uvp-admin-role": "governance_admin"
      }, { runtimeEnvironment: "staging", allowedAdminIds: ["gov-reviewer-1"], adminTokenHashes: [adminTokenHash] }))
        .toBeUndefined();
      expect(adminPrincipalFromHeaders({
        "x-uvp-admin-id": "gov-reviewer-1",
        "x-uvp-admin-role": "governance_admin"
      }, { runtimeEnvironment: "production", allowedAdminIds: ["gov-reviewer-1"], adminTokenHashes: [adminTokenHash] }))
        .toBeUndefined();
      expect(adminPrincipalFromHeaders({
        "x-uvp-admin-id": "dev-admin",
        "x-uvp-admin-role": "governance_admin"
      }, { runtimeEnvironment: "local", allowedAdminIds: [] })).toMatchObject({ adminId: "dev-admin" });
    });

    it("rejects testnet config without admin whitelists or an explicit auth mode", () => {
      const databaseUrl = "postgres://uvp:secret@testnet-db.internal:5432/uvp";
      const base = {
        CHAIN_SERVICES_RUNTIME_ENV: "testnet",
        CHAIN_SERVICES_DATABASE_URL: databaseUrl,
        CHAIN_SERVICES_MIGRATIONS_AUTO_RUN: "true",
        UVP_TESTNET_ALLOW_AUTO_MIGRATIONS: "1",
        UVP_INDEXER_POLL_INTERVAL_MS: "5000",
        UVP_CHAIN_ID: "84532",
        UVP_RPC_URL: "https://base-sepolia.example/rpc",
        UVP_CONTRACTS_JSON: JSON.stringify({
          UVPStateMachine: "0x1111111111111111111111111111111111111111",
          UVPIdentityRegistry: "0x1212121212121212121212121212121212121212"
        }),
        UVP_PRODUCT_BFF_REGISTRATION_ADAPTER: "anvil",
        UVP_PRODUCT_BFF_REGISTRAR_PRIVATE_KEY: "0x2222222222222222222222222222222222222222222222222222222222222222",
        UVP_STATE_MACHINE_RELAYER_PRIVATE_KEY: "0x2222222222222222222222222222222222222222222222222222222222222222",
        UVP_EVIDENCE_STORAGE_ADAPTER: "rehearsal-object",
        UVP_FINALITY_CONFIRMATIONS: "12",
        UVP_PRODUCT_BFF_WAIT_FOR_RECEIPT: "true",
        RECONCILE_WORKER_ENABLED: "true",
        RECONCILE_POLL_INTERVAL_MS: "30000"
      };
      expect(() => loadConfigFromEnv(base)).toThrow(/STORE_AUTH_MODE/);
      expect(() => loadConfigFromEnv({ ...base, STORE_AUTH_MODE: "dev_headers" }))
        .toThrow(/dev_headers is only allowed in local/);
      const withJwt = {
        ...base,
        STORE_AUTH_MODE: "jwt",
        STORE_AUTH_JWKS_URL: "https://identity.example/.well-known/jwks.json",
        STORE_AUTH_ISSUER: "https://identity.example/",
        STORE_AUTH_AUDIENCE: "uvp-store"
      };
      expect(() => loadConfigFromEnv(withJwt)).toThrow(/GOVERNANCE_ADMIN_REVIEWER_IDS is required in testnet/);
      const withWhitelists = {
        ...withJwt,
        GOVERNANCE_ADMIN_REVIEWER_IDS: "gov-reviewer-1"
      };
      expect(() => loadConfigFromEnv(withWhitelists)).toThrow(/OPS_CONSOLE_ADMIN_IDS is required in testnet/);
      expect(() => loadConfigFromEnv({
        ...withWhitelists,
        OPS_CONSOLE_ADMIN_IDS: "ops-admin-1"
      })).toThrow(/GOVERNANCE_ADMIN_TOKEN_HASHES is required in testnet/);
      expect(() => loadConfigFromEnv({
        ...withWhitelists,
        OPS_CONSOLE_ADMIN_IDS: "ops-admin-1",
        GOVERNANCE_ADMIN_TOKEN_HASHES: adminTokenHash
      })).not.toThrow();
      expect(loadConfigFromEnv({
        ...withWhitelists,
        OPS_CONSOLE_ADMIN_IDS: "ops-admin-1",
        GOVERNANCE_ADMIN_TOKEN_HASHES: adminTokenHash
      }).storeAuth?.walletSession?.devAnchoredAddressHeaderEnabled).toBe(false);
    });

    it("requires an explicit non-local RPC in production", () => {
      const base = {
        CHAIN_SERVICES_RUNTIME_ENV: "production",
        CHAIN_SERVICES_DATABASE_URL: "postgres://uvp:secret@prod-db.internal:5432/uvp",
        CHAIN_SERVICES_MIGRATIONS_AUTO_RUN: "false",
        STORE_AUTH_MODE: "jwt",
        STORE_AUTH_JWKS_URL: "https://identity.example/.well-known/jwks.json",
        STORE_AUTH_ISSUER: "https://identity.example/",
        STORE_AUTH_AUDIENCE: "uvp-store",
        UVP_CONTRACTS_JSON: JSON.stringify({
          UVPStateMachine: "0x1111111111111111111111111111111111111111",
          UVPIdentityRegistry: "0x1212121212121212121212121212121212121212"
        }),
        UVP_EVIDENCE_STORAGE_ADAPTER: "s3",
        UVP_EVIDENCE_S3_BUCKET: "uvp-production-evidence",
        UVP_EVIDENCE_S3_REGION: "us-east-1",
        UVP_EVIDENCE_S3_ACCESS_KEY_ID_ENV: "S3_KEY",
        UVP_EVIDENCE_S3_SECRET_ACCESS_KEY_ENV: "S3_SECRET",
        S3_KEY: "key",
        S3_SECRET: "secret",
        UVP_PRODUCT_BFF_REGISTRATION_ADAPTER: "anvil",
        UVP_PRODUCT_BFF_REGISTRAR_PRIVATE_KEY: "0x2222222222222222222222222222222222222222222222222222222222222222",
        UVP_STATE_MACHINE_RELAYER_PRIVATE_KEY: "0x2222222222222222222222222222222222222222222222222222222222222222",
        UVP_FINALITY_CONFIRMATIONS: "12",
        GOVERNANCE_ADMIN_REVIEWER_IDS: "gov-reviewer-1",
        OPS_CONSOLE_ADMIN_IDS: "ops-admin-1",
        GOVERNANCE_ADMIN_TOKEN_HASHES: adminTokenHash,
        UVP_PRODUCT_BFF_WAIT_FOR_RECEIPT: "true",
        RECONCILE_WORKER_ENABLED: "true",
        RECONCILE_POLL_INTERVAL_MS: "30000",
        UVP_INDEXER_POLL_INTERVAL_MS: "5000",
        UVP_CHAIN_ID: "8453"
      };
      expect(() => loadConfigFromEnv(base)).toThrow(/UVP_RPC_URL is required in production/);
      expect(() => loadConfigFromEnv({ ...base, UVP_RPC_URL: "http://127.0.0.1:8545" }))
        .toThrow(/non-local RPC/);
      expect(() => loadConfigFromEnv({ ...base, UVP_RPC_URL: "https://base-mainnet.example/rpc" }))
        .not.toThrow();
      expect(() => loadConfigFromEnv({
        ...base,
        UVP_RPC_URL: "https://base-mainnet.example/rpc",
        GOVERNANCE_ADMIN_REVIEWER_IDS: ""
      })).toThrow(/GOVERNANCE_ADMIN_REVIEWER_IDS is required in production/);
      const productionReady = { ...base, UVP_RPC_URL: "https://base-mainnet.example/rpc" };
      const { GOVERNANCE_ADMIN_TOKEN_HASHES: _tokenHashes, ...withoutAdminToken } = productionReady;
      expect(() => loadConfigFromEnv(withoutAdminToken)).toThrow(/GOVERNANCE_ADMIN_TOKEN_HASHES is required in production/);
      expect(() => loadConfigFromEnv({ ...withoutAdminToken, GOVERNANCE_ADMIN_TOKEN_HASHES: "not-hex" }))
        .toThrow(/sha256 hex/);
    });
  });

  describe("activity-feed identity", () => {
    it("requires a wallet session outside local and enforces the claimed wallet", async () => {
      const store = stores.projectionStore;
      await seedPlan(store);
      const router = createApiRouter(store, { ...requiredRouterStores(),
        productSchemaResolver: exampleSchemaResolver(),
        submissionChainId: 31337,
        submissionVerifyingContract: contractAddress,
        productRuntimeEnvironment: "testnet",
        evidenceStorage: new ObjectEvidenceStorage({ client: memoryObjectClient() }),
        storeAuthConfig: {
          mode: "jwt",
          jwksUrl: "https://identity.example/.well-known/jwks.json",
          issuer: "https://identity.example/",
          audience: "uvp-store",
          roleClaim: "roles",
          principalClaim: "sub",
          clockToleranceSeconds: 60
        }
      });
      const anonymous = await router.handle({
        method: "GET",
        pathname: "/product/me/activity-feed",
        query: { wallet: supplierWallet }
      });
      expect(anonymous).toMatchObject({ status: 401, body: { error: "wallet_identity_required" } });

      const session = await login(router, supplierAccount);
      const own = await router.handle({
        method: "GET",
        pathname: "/product/me/activity-feed",
        headers: { "x-uvp-store-session": session },
        query: { wallet: supplierWallet }
      });
      expect(own.status).toBe(200);
      const claimed = await router.handle({
        method: "GET",
        pathname: "/product/me/activity-feed",
        headers: { "x-uvp-store-session": session },
        query: { wallet: rivalWallet }
      });
      expect(claimed).toMatchObject({ status: 403, body: { error: "wrong_wallet" } });
    });
  });

  describe("join loop", () => {
    it("blocks approval when the subject is actively bound to another account (409)", async () => {
      const store = stores.projectionStore;
      await seedPlan(store, {
        foreignBinding: {
          subjectId: derivedJoinSubject(supplierWallet),
          account: rivalWallet
        }
      });
      const router = createApiRouter(store, joinRouterOptions());
      const session = await login(router, supplierAccount);
      const submitted = await router.handle({
        method: "POST",
        pathname: "/store/join-applications",
        headers: { "x-uvp-store-session": session },
        body: { planId, roleSlotId, authorizationKind: "signal_submitter" }
      });
      expect(submitted.status).toBe(201);
      const applicationId = (submitted.body as { application: { applicationId: string } }).application.applicationId;
      await router.handle({
        method: "POST",
        pathname: `/store/join-applications/${applicationId}/review-start`,
        headers: publisherAnchoredHeaders,
        body: {}
      });
      const approved = await router.handle({
        method: "POST",
        pathname: `/store/join-applications/${applicationId}/approve`,
        headers: publisherAnchoredHeaders,
        body: {}
      });
      expect(approved).toMatchObject({ status: 409, body: { error: "subject_already_bound" } });
    });

    it("requires governance-admin authority to broadcast identity registration during approval", async () => {
      const store = stores.projectionStore;
      await seedPlan(store);
      const router = createApiRouter(store, joinRouterOptions());
      const session = await login(router, supplierAccount);
      const submitted = await router.handle({
        method: "POST",
        pathname: "/store/join-applications",
        headers: { "x-uvp-store-session": session },
        body: { planId, roleSlotId, authorizationKind: "signal_submitter" }
      });
      const applicationId = (submitted.body as { application: { applicationId: string } }).application.applicationId;
      await router.handle({
        method: "POST",
        pathname: `/store/join-applications/${applicationId}/review-start`,
        headers: publisherAnchoredHeaders,
        body: {}
      });
      const approved = await router.handle({
        method: "POST",
        pathname: `/store/join-applications/${applicationId}/approve`,
        headers: publisherAnchoredHeaders,
        body: {}
      });
      expect(approved).toMatchObject({ status: 403, body: { error: "governance_admin_required" } });
    });

    it("keeps the application under review and refuses on_chain evidence when the identity registration broadcast fails", async () => {
      const store = stores.projectionStore;
      await seedPlan(store);
      const failingGovernance = createGovernanceService({
        store: new (await import("../src/governance/index.js")).InMemoryGovernanceStore(),
        adapter: {
          async registerIdentity() {
            return { status: "failed", errorCode: "governance_adapter_failed", message: "rpc down", retryable: true, simulated: false };
          },
          async revokeIdentity() {
            return { status: "failed", errorCode: "governance_adapter_failed", message: "rpc down", retryable: true, simulated: false };
          }
        }
      });
      await failingGovernance.reviewSupplier(
        { subjectId: derivedJoinSubject(supplierWallet), status: "approved_for_broadcast" },
        { adminId: "governance-admin-1", role: "governance_admin" }
      );
      const router = createApiRouter(store, { ...requiredRouterStores(),
        ...joinRouterOptions(),
        governanceService: failingGovernance
      });
      const session = await login(router, supplierAccount);
      const submitted = await router.handle({
        method: "POST",
        pathname: "/store/join-applications",
        headers: { "x-uvp-store-session": session },
        body: { planId, roleSlotId, authorizationKind: "signal_submitter" }
      });
      const applicationId = (submitted.body as { application: { applicationId: string } }).application.applicationId;
      await router.handle({
        method: "POST",
        pathname: `/store/join-applications/${applicationId}/review-start`,
        headers: publisherAnchoredHeaders,
        body: {}
      });
      const approved = await router.handle({
        method: "POST",
        pathname: `/store/join-applications/${applicationId}/approve`,
        headers: { ...publisherAnchoredHeaders, "x-uvp-admin-id": "governance-admin-1", "x-uvp-admin-role": "governance_admin" },
        body: {}
      });
      expect(approved).toMatchObject({ status: 502, body: { error: "identity_registration_broadcast_failed" } });
      const detail = await router.handle({
        method: "GET",
        pathname: `/store/join-applications/${applicationId}`,
        headers: { "x-uvp-store-session": session }
      });
      const application = (detail.body as { application: { status: string; txEvidence: readonly { status: string }[] } }).application;
      expect(application.status).toBe("under_review");
      expect(application.txEvidence).toHaveLength(0);
    });

    it("does not let a concurrent decision overwrite the terminal state after identity pairing", async () => {
      const store = stores.projectionStore;
      await seedPlan(store, { withSupplierBinding: true });
      const { PostgresStoreJoinApplicationStore } = await import("../src/store-access-postgres-stores.js");
      const realJoinStore = new PostgresStoreJoinApplicationStore({ database: failClosedDatabase });
      let doctorNextRead = false;
      const staleSnapshotStore: StoreJoinApplicationStore = {
        putApplication: (record) => realJoinStore.putApplication(record),
        updateApplicationIfStatus: (record, expected) => realJoinStore.updateApplicationIfStatus(record, expected),
        getApplication: async (applicationId) => {
          const record = await realJoinStore.getApplication(applicationId);
          if (doctorNextRead && record) {
            doctorNextRead = false;
            return { ...record, status: "under_review" as const };
          }
          return record;
        },
        listApplications: (query) => realJoinStore.listApplications(query),
        appendEvent: (record) => realJoinStore.appendEvent(record),
        listEvents: (applicationId) => realJoinStore.listEvents(applicationId)
      };
      const router = createApiRouter(store, { ...requiredRouterStores(), ...joinRouterOptions(), storeJoinApplicationStore: staleSnapshotStore });
      const session = await login(router, supplierAccount);
      const submitted = await router.handle({
        method: "POST",
        pathname: "/store/join-applications",
        headers: { "x-uvp-store-session": session },
        body: { planId, roleSlotId, authorizationKind: "signal_submitter" }
      });
      const applicationId = (submitted.body as { application: { applicationId: string } }).application.applicationId;
      await router.handle({
        method: "POST",
        pathname: `/store/join-applications/${applicationId}/review-start`,
        headers: publisherAnchoredHeaders,
        body: {}
      });
      const rejected = await router.handle({
        method: "POST",
        pathname: `/store/join-applications/${applicationId}/reject`,
        headers: publisherAnchoredHeaders,
        body: { reason: "concurrent winner" }
      });
      expect(rejected.status).toBe(200);

      doctorNextRead = true;
      const approved = await router.handle({
        method: "POST",
        pathname: `/store/join-applications/${applicationId}/approve`,
        headers: { ...publisherAnchoredHeaders, "x-uvp-admin-id": "governance-admin-1", "x-uvp-admin-role": "governance_admin" },
        body: {}
      });
      expect(approved).toMatchObject({ status: 409, body: { error: "application_decision_conflict" } });
      const detail = await router.handle({
        method: "GET",
        pathname: `/store/join-applications/${applicationId}`,
        headers: { "x-uvp-store-session": session }
      });
      expect((detail.body as { application: { status: string } }).application.status).toBe("rejected");
    });

  });

  describe("version activate", () => {
    it("rejects re-anchoring an existing version and unprojected new anchors", async () => {
      const store = stores.projectionStore;
      await seedPlan(store);
      const productService = createProductService(store, { productSchemaResolver: exampleSchemaResolver() });
      const metadataStore = new MemoryStoreZhixuVersionMetadataStore();
      const versionService = createStoreZhixuVersionService({
        productService,
        projectionStore: store,
        metadataStore
      });
      const versions = await versionService.listVersions(EXAMPLE_ZHIXU_ID);
      const versionId = versions.versions[0]?.versionId;
      expect(versionId).toBeDefined();
      const activated = await versionService.activate(EXAMPLE_ZHIXU_ID, versionId!, {});
      expect(activated.version.status).toBe("active");

      await expect(versionService.activate(EXAMPLE_ZHIXU_ID, versionId!, {
        planId: "0x0000000000000000000000000000000000000000000000000000000000000fff"
      })).rejects.toMatchObject({ code: "version_anchor_immutable" });

      await expect(versionService.activate(EXAMPLE_ZHIXU_ID, "version-fresh", {
        planId: "0x0000000000000000000000000000000000000000000000000000000000000abc",
        planHash: "0x0000000000000000000000000000000000000000000000000000000000000def"
      })).rejects.toMatchObject({ code: "plan_not_projected" });
    });

    it("keeps at most one active version per series (single-active invariant)", async () => {
      const metadataStore = new MemoryStoreZhixuVersionMetadataStore();
      const timestamp = new Date("2026-04-28T00:00:00Z").toISOString();
      const versionRecord = (versionId: string, planId: Hex) => ({
        versionId,
        zhixuId: EXAMPLE_ZHIXU_ID,
        seriesId: EXAMPLE_ZHIXU_ID,
        versionLabel: versionId,
        status: "deprecated" as const,
        planId,
        planHash: planHashFixture,
        createdAt: timestamp
      });
      await metadataStore.upsertVersion(versionRecord("version-a", planId));
      await metadataStore.upsertVersion(versionRecord("version-b", "0x0000000000000000000000000000000000000000000000000000000000000bbb"));

      await metadataStore.upsertVersion({ ...versionRecord("version-a", planId), status: "active" });
      await metadataStore.upsertVersion({ ...versionRecord("version-b", "0x0000000000000000000000000000000000000000000000000000000000000bbb"), status: "active" });

      const versions = await metadataStore.listVersions(EXAMPLE_ZHIXU_ID);
      const active = versions.filter((version) => version.status === "active");
      expect(active).toHaveLength(1);
      expect(active[0]?.versionId).toBe("version-b");
    });
  });

  describe("governance stores and hashing", () => {
    it("putReview does not overwrite created_at on conflict (postgres)", async () => {
      const governanceStore = new PostgresGovernanceStore({ database: failClosedDatabase });
      const review = {
        reviewId: "review_created_at",
        subjectType: "supplier" as const,
        subjectId: "0x0000000000000000000000000000000000000000000000000000000000003001",
        status: "submitted" as const,
        riskLevel: "unknown",
        riskTags: [],
        publicSummary: "first",
        internalNotes: "",
        policyHash: "0x" + "aa".repeat(32) as Hex,
        metadataHash: "0x" + "bb".repeat(32) as Hex,
        metadataURI: "uvp-governance://metadata/test",
        reviewer: "admin",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      };
      await governanceStore.putReview(review);
      await governanceStore.putReview({
        ...review,
        status: "approved_for_broadcast",
        publicSummary: "second",
        createdAt: "2099-12-31T00:00:00.000Z",
        updatedAt: "2026-02-02T00:00:00.000Z"
      });
      const stored = await governanceStore.getReview(review.reviewId);
      expect(stored?.createdAt).toBe("2026-01-01T00:00:00.000Z");
      expect(stored?.status).toBe("approved_for_broadcast");
      expect(stored?.updatedAt).toBe("2026-02-02T00:00:00.000Z");
      governanceStore.close();
    });

    it("persists review hash documents so descriptor hashing keeps metadata/policy material", async () => {
      const subjectId = "0x" + "31".repeat(32) as Hex;
      const account = "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" as Address;
      const admin = { adminId: "gov-reviewer-1", role: "governance_admin" as const };
      const service = createGovernanceService({
        store: new InMemoryGovernanceStore(),
        adapter: {
          registerIdentity: async () => ({ status: "simulated_tx", retryable: false, simulated: true }),
          revokeIdentity: async () => ({ status: "simulated_tx", retryable: false, simulated: true })
        }
      });
      await service.reviewSupplier({
        subjectId,
        status: "approved_for_broadcast",
        metadata: { supplierId: "s-1", wallet: account },
        policy: { workflow: "store_supplier_review" }
      }, admin);
      const registered = await service.registerIdentity({ subjectId, account }, admin);
      const descriptorHashWithDocuments = registered.request.descriptorHash;
      expect(descriptorHashWithDocuments).toMatch(/^0x[0-9a-f]{64}$/);
      const bareSubjectId = "0x" + "32".repeat(32) as Hex;
      await service.reviewSupplier({ subjectId: bareSubjectId, status: "approved_for_broadcast" }, admin);
      const bareRegistered = await service.registerIdentity({ subjectId: bareSubjectId, account }, admin);
      expect(bareRegistered.request.descriptorHash).not.toBe(descriptorHashWithDocuments);
    });

    it("rolls the review back to its prior status when the revocation broadcast fails", async () => {
      const subjectId = "0x" + "33".repeat(32) as Hex;
      const account = "0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC" as Address;
      const bindingId = "0x" + "44".repeat(32) as Hex;
      const admin = { adminId: "gov-reviewer-1", role: "governance_admin" as const };
      let failRevoke = false;
      const service = createGovernanceService({
        store: new InMemoryGovernanceStore(),
        adapter: {
          registerIdentity: async () => ({ status: "simulated_tx", retryable: false, simulated: true }),
          revokeIdentity: async () => {
            if (failRevoke) {
              return { status: "failed", errorCode: "adapter_down", retryable: false, simulated: false };
            }
            return { status: "simulated_tx", retryable: false, simulated: true };
          }
        }
      });
      await service.reviewSupplier({ subjectId, status: "approved_for_broadcast" }, admin);
      failRevoke = true;
      const revoked = await service.revokeIdentity({ subjectId, bindingId }, admin);
      expect(revoked.broadcast.status).toBe("failed");
      const reviews = await service.listReviews({ subjectType: "supplier", subjectId });
      expect(reviews[0]?.status).toBe("approved_for_broadcast");
      failRevoke = false;
      const retried = await service.revokeIdentity({ subjectId, bindingId }, admin);
      expect(retried.broadcast.status).toBe("simulated_tx");
      const finalReviews = await service.listReviews({ subjectType: "supplier", subjectId });
      expect(finalReviews[0]?.status).toBe("revoked");
    });

    it("keeps the review revoked for a retryable revocation failure (ambiguous outcome)", async () => {
      const subjectId = "0x" + "55".repeat(32) as Hex;
      const account = "0xDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD" as Address;
      const bindingId = "0x" + "66".repeat(32) as Hex;
      const admin = { adminId: "gov-reviewer-1", role: "governance_admin" as const };
      const service = createGovernanceService({
        store: new InMemoryGovernanceStore(),
        adapter: {
          registerIdentity: async () => ({ status: "simulated_tx", retryable: false, simulated: true }),
          revokeIdentity: async () => ({ status: "failed", errorCode: "adapter_down", retryable: true, simulated: false })
        }
      });
      await service.reviewSupplier({ subjectId, status: "approved_for_broadcast" }, admin);
      const revoked = await service.revokeIdentity({ subjectId, bindingId }, admin);
      expect(revoked.broadcast.status).toBe("failed");
      const reviews = await service.listReviews({ subjectType: "supplier", subjectId });
      expect(reviews[0]?.status).toBe("revoked");
    });

    it("descriptor hash covers profile/capability/reputation", () => {
      const base = {
        subjectId: "0x" + "11".repeat(32) as Hex,
        account: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        metadata: { supplierId: "s1" }
      };
      const first = hashIdentityDescriptor(base);
      expect(hashIdentityDescriptor({ ...base, profile: { displayName: "A" } })).not.toBe(first);
      expect(hashIdentityDescriptor({ ...base, capability: { tags: ["t"] } })).not.toBe(first);
      expect(hashIdentityDescriptor({ ...base, reputation: { score: 5 } })).not.toBe(first);
      expect(hashIdentityDescriptor({ ...base, profile: { displayName: "A" } }))
        .toBe(hashIdentityDescriptor({ ...base, profile: { displayName: "A" } }));
    });
  });

  describe("decoration durable store alignment", () => {
    it("rejects duplicate (planId, version) appends like the unique constraint", async () => {
      const decorationStore = new PostgresStoreZhixuDecorationStore({ database: failClosedDatabase });
      const record = {
        decorationId: "deco_1",
        planId: "0x" + "21".repeat(32) as Hex,
        version: 1,
        data: { schemaVersion: "store-zhixu-decoration.v1" as const },
        authorAddress: publisherAddress,
        createdAt: "2026-01-01T00:00:00.000Z"
      };
      await decorationStore.appendVersion(record);
      await expect(decorationStore.appendVersion({ ...record, decorationId: "deco_2" }))
        .rejects.toThrow(/unique constraint/);
    });

    it("keeps delegation grants append-only and only updates revocation fields", async () => {
      const delegationStore = new PostgresStorePublisherDelegationStore({ database: failClosedDatabase });
      await delegationStore.appendDelegation({
        delegationId: "dlg_1",
        publisherAddress: publisherAddress,
        memberAddress: supplierWallet,
        grantedByAddress: publisherAddress,
        grantedAt: "2026-01-01T00:00:00.000Z"
      });
      await delegationStore.appendDelegation({
        delegationId: "dlg_1",
        publisherAddress: rivalWallet,
        memberAddress: "0xeeee000000000000000000000000000000000005" as Address,
        grantedByAddress: rivalWallet,
        grantedAt: "2026-03-01T00:00:00.000Z",
        revokedAt: "2026-04-01T00:00:00.000Z"
      });
      const active = await delegationStore.findActiveDelegation(publisherAddress, supplierWallet);
      expect(active).toBeUndefined();
      const listed = await delegationStore.listDelegations(publisherAddress);
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({
        delegationId: "dlg_1",
        revokedAt: "2026-04-01T00:00:00.000Z"
      });
    });
  });

  describe("sessions challenge consume", () => {
    it("consumes a challenge exactly once (conditional update)", async () => {
      const store = new PostgresStoreWalletSessionStore({ database: failClosedDatabase });
      const service = createStoreSessionService({
        store,
        verifyWalletMessage: async () => true
      });
      const challenge = await service.createChallenge({ address: supplierWallet });
      const first = await service.verify({ nonce: challenge.nonce, signature: "0x" + "ab".repeat(32) });
      expect(first.token).toMatch(/^uvs_/);
      await expect(service.verify({ nonce: challenge.nonce, signature: "0x" + "ab".repeat(32) }))
        .rejects.toMatchObject({ code: "store_challenge_invalid" });
    });
  });

  describe("proof verifier", () => {
    it("treats missing hash material as invalid instead of passing", () => {
      const matched = "0x" + "cc".repeat(32) as Hex;
      expect(verifyProofBundle({
        zhixuHash: { actual: matched, expected: matched },
        metadataHash: { actual: matched, expected: matched },
        evidenceHash: { actual: matched, expected: matched }
      }).valid).toBe(true);
      expect(verifyProofBundle({}).valid).toBe(false);
      expect(verifyProofBundle({
        zhixuHash: { actual: matched, expected: matched }
      }).valid).toBe(false);
      const oneSided = verifyProofBundle({ metadataHash: { expected: matched } });
      expect(oneSided.valid).toBe(false);
      expect(oneSided.checks.find((check) => check.name === "metadataHash")?.status).toBe("mismatch");
    });
  });

  describe("evidence backup wiring", () => {
    it("translates URIs between primary and backup spaces for verify/restore", async () => {
      const objects = new Map<string, Uint8Array>();
      const primary = new ObjectEvidenceStorage({
        client: {
          async put(input) {
            const uri = `s3://primary-bucket/prefix/${input.evidenceId}`;
            objects.set(uri, input.bytes);
            return { storageURI: uri, size: input.bytes.byteLength };
          },
          async get(uri) {
            return objects.get(uri);
          },
          async exists(uri) {
            return objects.has(uri);
          },
          storageURIForEvidenceId: (evidenceId) => `s3://primary-bucket/prefix/${evidenceId}`,
          evidenceIdForStorageURI: (uri) => {
            if (!uri.startsWith("s3://primary-bucket/prefix/")) {
              throw new Error("storageURI is not managed by primary");
            }
            return uri.slice("s3://primary-bucket/prefix/".length);
          }
        }
      });
      const backup = new ObjectEvidenceStorage({
        client: {
          async put(input) {
            const uri = `s3://backup-bucket/${input.evidenceId}`;
            objects.set(uri, input.bytes);
            return { storageURI: uri, size: input.bytes.byteLength };
          },
          async get(uri) {
            return objects.get(uri);
          },
          async exists(uri) {
            return objects.has(uri);
          },
          storageURIForEvidenceId: (evidenceId) => `s3://backup-bucket/${evidenceId}`,
          evidenceIdForStorageURI: (uri) => {
            if (!uri.startsWith("s3://backup-bucket/")) {
              throw new Error("storageURI is not managed by backup");
            }
            return uri.slice("s3://backup-bucket/".length);
          }
        }
      });
      const storage = new BackupEvidenceStorage({ primary, backup });
      const put = await storage.put({ evidenceId: "ev_audit3", bytes: new TextEncoder().encode("payload") });
      expect(put.storageURI).toBe("s3://primary-bucket/prefix/ev_audit3");

      objects.delete(put.storageURI);
      const verified = await storage.verifyBackup(put.storageURI, "0x" + "aa".repeat(32));
      expect(verified).toEqual({ backupPresent: true, hashMatches: false });
      expect(await storage.restoreFromBackup(put.storageURI, "ev_audit3", "0x" + "aa".repeat(32))).toBe(false);
    });

    it("exposes admin-gated backup verify/restore endpoints", async () => {
      const store = stores.projectionStore;
      await seedPlan(store);
      const primary = new LocalEvidenceStorage({ rootDir: tempDir() });
      const backup = new LocalEvidenceStorage({ rootDir: tempDir() });
      const router = createApiRouter(store, { ...requiredRouterStores(),
        productSchemaResolver: exampleSchemaResolver(),
        submissionChainId: 31337,
        submissionVerifyingContract: contractAddress,
        productRuntimeEnvironment: "local",
        evidenceStorage: new BackupEvidenceStorage({ primary, backup })
      });
      const upload = await router.handle({
        method: "POST",
        pathname: "/product/evidence",
        headers: { "x-uvp-principal-id": "slot-b" },
        body: {
          orderId: "order-1",
          stageIdentifier: "stage-1",
          documentType: "doc-1",
          textPayload: "audit3 backup payload"
        }
      });
      expect(upload.status).toBe(201);
      const evidenceId = (upload.body as { evidence: { evidenceId: string } }).evidence.evidenceId;
      const contentHash = (upload.body as { evidence: { contentHash: string } }).evidence.contentHash;

      const ownerVerify = await router.handle({
        method: "POST",
        pathname: `/product/evidence/${evidenceId}/backup-verify`,
        headers: { "x-uvp-principal-id": "slot-b" }
      });
      expect(ownerVerify.status).toBe(403);
      expect(ownerVerify.body).toMatchObject({ error: "forbidden" });

      const ownerRestore = await router.handle({
        method: "POST",
        pathname: `/product/evidence/${evidenceId}/backup-restore`,
        headers: { "x-uvp-principal-id": "slot-b" }
      });
      expect(ownerRestore.status).toBe(403);
      expect(ownerRestore.body).toMatchObject({ error: "forbidden" });

      const adminHeaders = { "x-uvp-admin-id": "audit-admin", "x-uvp-admin-role": "admin" };
      const adminVerify = await router.handle({
        method: "POST",
        pathname: `/product/evidence/${evidenceId}/backup-verify`,
        headers: adminHeaders
      });
      expect(adminVerify.status).toBe(200);
      expect(adminVerify.body).toMatchObject({
        backup: { backupConfigured: true, backupPresent: true, hashMatches: true }
      });

      const restore = await router.handle({
        method: "POST",
        pathname: `/product/evidence/${evidenceId}/backup-restore`,
        headers: adminHeaders
      });
      expect(restore.status).toBe(200);
      expect(restore.body).toMatchObject({
        backup: { restored: true, hashMatches: true }
      });

      const anonymous = await router.handle({
        method: "POST",
        pathname: `/product/evidence/${evidenceId}/backup-verify`
      });
      expect(anonymous.status).toBe(401);
      expect(contentHash).toMatch(/^0x[0-9a-f]{64}$/);
    });
  });

  describe("store read surfaces", () => {
    it("requires store.read for /store/suppliers reads", async () => {
      const store = stores.projectionStore;
      await seedPlan(store);
      const router = createApiRouter(store, { ...requiredRouterStores(),  productRuntimeEnvironment: "local",

        productSchemaResolver: exampleSchemaResolver(),
        submissionChainId: 31337,
        submissionVerifyingContract: contractAddress
      });
      const anonymous = await router.handle({ method: "GET", pathname: "/store/suppliers" });
      expect(anonymous.status).toBe(401);
      const authorized = await router.handle({
        method: "GET",
        pathname: "/store/suppliers",
        headers: { "x-uvp-store-user-id": "operator-1", "x-uvp-store-role": "operator" }
      });
      expect(authorized.status).toBe(200);
    });

    it("filters delisted zhixus from store search for non-operators", async () => {
      const store = stores.projectionStore;
      await seedPlan(store);
      const router = createApiRouter(store, { ...requiredRouterStores(),  productRuntimeEnvironment: "local",

        productSchemaResolver: exampleSchemaResolver(),
        submissionChainId: 31337,
        submissionVerifyingContract: contractAddress,
        storeAuthConfig: devAnchoredStoreAuth
      });
      const imported = await router.handle({
        method: "POST",
        pathname: "/store/listings/import",
        headers: publisherAnchoredHeaders,
        body: { planId }
      });
      expect(imported.status).toBe(201);
      const listingId = (imported.body as { listing: { listingId: string } }).listing.listingId;
      const reviewed = await router.handle({
        method: "POST",
        pathname: `/store/listings/${listingId}/review`,
        headers: storeAdminHeaders,
        body: { decision: "approve", confirmation: {} }
      });
      expect(reviewed.status).toBe(200);
      const delisted = await router.handle({
        method: "POST",
        pathname: `/store/listings/${listingId}/delist`,
        headers: storeAdminHeaders,
        body: { reason: "audit3" }
      });
      expect(delisted.status).toBe(200);

      const zhixuIdQuery = EXAMPLE_ZHIXU_ID;
      const anonymousSearch = await router.handle({
        method: "GET",
        pathname: "/store/search",
        query: { q: zhixuIdQuery }
      });
      expect(anonymousSearch.status).toBe(200);
      const anonymousResults = (anonymousSearch.body as { results: { resultType: string; id: string }[] }).results;
      expect(anonymousResults.filter((result) => result.resultType === "zhixu")).toHaveLength(0);
      const operatorSearch = await router.handle({
        method: "GET",
        pathname: "/store/search",
        query: { q: zhixuIdQuery },
        headers: { "x-uvp-store-user-id": "operator-1", "x-uvp-store-role": "operator" }
      });
      const operatorResults = (operatorSearch.body as { results: { resultType: string }[] }).results;
      expect(operatorResults.some((result) => result.resultType === "zhixu")).toBe(true);
    });

    it("rejects unsupported store order filter status values", async () => {
      const store = stores.projectionStore;
      await seedPlan(store);
      const router = createApiRouter(store, { ...requiredRouterStores(),  productRuntimeEnvironment: "local",

        productSchemaResolver: exampleSchemaResolver(),
        submissionChainId: 31337,
        submissionVerifyingContract: contractAddress,
        storeAuthConfig: {
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
            devAnchoredAddressHeaderEnabled: true
          }
        }
      });
      const anonymous = await router.handle({
        method: "GET",
        pathname: `/store/zhixus/${EXAMPLE_ZHIXU_ID}/orders`,
        query: { status: "registered" }
      });
      expect(anonymous).toMatchObject({ status: 401, body: { error: "store_identity_missing" } });
      const anchoredPlainWallet = await router.handle({
        method: "GET",
        pathname: `/store/zhixus/${EXAMPLE_ZHIXU_ID}/orders`,
        query: { status: "registered" },
        headers: { "x-uvp-store-dev-anchored-address": publisherAddress }
      });
      expect(anchoredPlainWallet).toMatchObject({ status: 401, body: { error: "store_identity_missing" } });
      const capabilityHeaders = {
        "x-uvp-store-user-id": "reader-1",
        "x-uvp-store-role": "reader",
        "x-uvp-store-dev-anchored-address": publisherAddress
      };
      const disputed = await router.handle({
        method: "GET",
        pathname: `/store/zhixus/${EXAMPLE_ZHIXU_ID}/orders`,
        query: { status: "disputed" },
        headers: capabilityHeaders
      });
      expect(disputed).toMatchObject({ status: 400, body: { error: "invalid_query" } });
      const registered = await router.handle({
        method: "GET",
        pathname: `/store/zhixus/${EXAMPLE_ZHIXU_ID}/orders`,
        query: { status: "registered" },
        headers: capabilityHeaders
      });
      expect(registered.status).toBe(200);
    });
  });

  describe("staging readiness", () => {
    it("does not treat an unknown rebuild status as ready", async () => {
      const store = stores.projectionStore;
      await seedPlan(store);
      const router = createApiRouter(store, { ...requiredRouterStores(),  productRuntimeEnvironment: "local",

        productSchemaResolver: exampleSchemaResolver(),
        submissionChainId: 31337,
        submissionVerifyingContract: contractAddress
      });
      const response = await router.handle({ method: "GET", pathname: "/product/staging/readiness", headers: adminHeaders });
      expect(response.status).toBe(503);
      const body = response.body as { reasons: string[]; indexer: { rebuildReady: boolean; rebuildStatus: string } };
      expect(body.indexer.rebuildStatus).toBe("unknown");
      expect(body.indexer.rebuildReady).toBe(false);
      expect(body.reasons).toContain("projection_rebuild_not_complete");
    });
  });
});

function joinRouterOptions() {
  return {
    ...requiredRouterStores(),
    productRuntimeEnvironment: "local" as const,
    productSchemaResolver: exampleSchemaResolver(),
    submissionChainId: 31337,
    submissionVerifyingContract: contractAddress,
    storeAuthConfig: {
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
        devAnchoredAddressHeaderEnabled: true
      }
    }
  };
}

async function login(router: ApiRouter, account: ReturnType<typeof privateKeyToAccount>): Promise<string> {
  const challengeResponse = await router.handle({
    method: "POST",
    pathname: "/store/auth/challenge",
    body: { address: account.address }
  });
  expect(challengeResponse.status).toBe(201);
  const { nonce, message } = (challengeResponse.body as { challenge: { nonce: string; message: string } }).challenge;
  const signature = await account.signMessage({ message });
  const verify = await router.handle({
    method: "POST",
    pathname: "/store/auth/verify",
    body: { nonce, signature }
  });
  expect(verify.status).toBe(201);
  return (verify.body as { token: string }).token;
}

async function seedPlan(
  store: ProjectionStore,
  options: {
    readonly withSupplierBinding?: boolean;
    readonly foreignBinding?: { readonly subjectId: Hex; readonly account: Address };
  } = {}
): Promise<void> {
  await store.resetFromEvents({
    deploymentBlock: 0n,
    events: [
      chainEvent(1n, 0, "PlanRegistered", { planId, planHash, hookCount: 2n }),
      chainEvent(1n, 1, "PlanPublisherRecorded", { planId, publisher: publisherAddress }),
      ...(options.withSupplierBinding
        ? [chainEvent(2n, 0, "IdentityBindingRegistered", {
            bindingId: `0x${"aa".repeat(32)}`,
            subjectId: derivedJoinSubject(supplierWallet),
            account: supplierWallet,
            descriptorHash: `0x${"bb".repeat(32)}`,
            descriptorURI: "uvp-governance://metadata/test",
            registrar: publisherAddress
          })]
        : []),
      ...(options.foreignBinding
        ? [chainEvent(2n, 1, "IdentityBindingRegistered", {
            bindingId: `0x${"cc".repeat(32)}`,
            subjectId: options.foreignBinding.subjectId,
            account: options.foreignBinding.account,
            descriptorHash: `0x${"dd".repeat(32)}`,
            descriptorURI: "uvp-governance://metadata/test",
            registrar: publisherAddress
          })]
        : [])
    ]
  });
}

async function seedOrderWithAuthorization(
  store: ProjectionStore,
  submitter: Address,
  signal: { readonly sourceId: Hex; readonly signalId: Hex }
): Promise<void> {
  const orderId = "0x0000000000000000000000000000000000000000000000000000000000000909" as Hex;
  await store.resetFromEvents({
    deploymentBlock: 0n,
    events: [
      chainEvent(1n, 0, "PlanRegistered", { planId, planHash, hookCount: 2n }),
      chainEvent(1n, 1, "PlanPublisherRecorded", { planId, publisher: publisherAddress }),
      chainEvent(2n, 0, "IdentityBindingRegistered", {
        bindingId: `0x${"aa".repeat(32)}`,
        subjectId: derivedJoinSubject(supplierWallet),
        account: supplierWallet,
        descriptorHash: `0x${"bb".repeat(32)}`,
        descriptorURI: "uvp-governance://metadata/test",
        registrar: publisherAddress
      }),
      chainEvent(3n, 0, "OrderRegistered", { orderId, planId }),
      chainEvent(4n, 0, "SignalSubmitterAuthorized", {
        orderId,
        sourceId: signal.sourceId,
        signalId: signal.signalId,
        submitter,
        role: `0x${"33".repeat(32)}`,
        metadataHash: `0x${"44".repeat(32)}`
      })
    ]
  });
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "uvp-failclosed-"));
  tempDirs.push(dir);
  return dir;
}

function derivedJoinSubject(address: Address): Hex {
  return keccak256(stringToBytes(`uvp:store:join:subject:v1:${address.toLowerCase()}`)) as Hex;
}

function chainEvent(blockNumber: bigint, logIndex: number, eventName: string, args: Record<string, unknown>): ChainEvent {
  return {
    chainId: 31337,
    contractAddress: contractAddress as Address,
    blockNumber,
    transactionHash: `0x${blockNumber.toString(16).padStart(8, "0")}${"e".repeat(56)}`,
    logIndex,
    eventName,
    args
  };
}

function memoryObjectClient() {
  const objects = new Map<string, Uint8Array>();
  return {
    async put(input: { readonly evidenceId: string; readonly bytes: Uint8Array }) {
      const storageURI = `object://audit3/${encodeURIComponent(input.evidenceId)}`;
      objects.set(storageURI, input.bytes);
      return { storageURI, size: input.bytes.byteLength };
    },
    async get(storageURI: string) {
      return objects.get(storageURI);
    },
    async exists(storageURI: string) {
      return objects.has(storageURI);
    },
    storageURIForEvidenceId: (evidenceId: string) => `object://audit3/${encodeURIComponent(evidenceId)}`,
    evidenceIdForStorageURI: (storageURI: string) => {
      if (!storageURI.startsWith("object://audit3/")) {
        throw new Error("storageURI is not managed by memoryObjectClient");
      }
      return decodeURIComponent(storageURI.slice("object://audit3/".length));
    }
  };
}
