import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { keccak256, stringToBytes } from "viem";
import { EXAMPLE_ZHIXU_ID, examplePlanIds, demoZhixuDetail } from "./fixtures/business/index.js";
import { createApiRouter } from "../src/api/routes.js";
import { createNotificationService, createSupplierNotificationProfileConfigService, MemorySupplierNotificationProfileConfigStore } from "../src/notifications/index.js";
import type { ChainEvent } from "../src/indexer/events.js";
import { createChainServicesStores, type ChainServicesStores } from "../src/storage/factory.js";
import { PostgresDatabase } from "../src/storage/postgres-client.js";
import type { ProjectionStore } from "../src/storage/projection-store.js";
import { createPostgresTestDatabase } from "./postgres.js";
import type { ApiRouter } from "../src/api/route-context.js";
import type { Address, Hex } from "../src/shared/types.js";
import { exampleSchemaResolver } from "./example-schema.js";
import { PostgresStoreWalletSessionStore } from "../src/store/sessions/index.js";
import { PostgresStoreListingStore } from "../src/store-access-postgres-stores.js";

let stores: ChainServicesStores;
let accessDatabase: PostgresDatabase;

beforeAll(async () => {
  const databaseUrl = await createPostgresTestDatabase();
  stores = createChainServicesStores({
    database: { url: databaseUrl, migrationsAutoRun: true },
    chainId: 31337
  });
  accessDatabase = new PostgresDatabase({ databaseUrl });
});

beforeEach(async () => {
  // 原先每用例各建一个 Memory projection store + 路由内新建各域内存件：
  // 同一克隆库内清空本文件会写入的 store-access 域表，保持用例间互不可见。
  await accessDatabase.query("DELETE FROM chain_event_log WHERE chain_id = 31337");
  await accessDatabase.query("DELETE FROM chain_projection_snapshot WHERE chain_id = 31337");
  await accessDatabase.query("DELETE FROM chain_index_cursor WHERE chain_id = 31337");
  await accessDatabase.query("DELETE FROM chain_projection_sync_state WHERE chain_id = 31337");
  await accessDatabase.query("DELETE FROM store_auth_challenge");
  await accessDatabase.query("DELETE FROM store_wallet_session");
  await accessDatabase.query("DELETE FROM store_account_address");
  await accessDatabase.query("DELETE FROM store_identity_descriptor_snapshot");
  await accessDatabase.query("DELETE FROM store_zhixu_decoration");
  await accessDatabase.query("DELETE FROM store_publisher_delegation");
  await accessDatabase.query("DELETE FROM store_zhixu_listing");
  await accessDatabase.query("DELETE FROM store_join_application_event");
  await accessDatabase.query("DELETE FROM store_join_application");
  // join 审批通过会经 supplier service 落 store_supplier_metadata/audit：
  // 不清会把上一用例创建的供应商带进本用例的 /store/suppliers 读回。
  await accessDatabase.query("DELETE FROM store_supplier_audit");
  await accessDatabase.query("DELETE FROM store_supplier_metadata");
});

afterAll(async () => {
  await accessDatabase.close();
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

const contractAddress: Address = "0x1111111111111111111111111111111111111111";
const publisherAddress = "0xaaaa000000000000000000000000000000000001" as Address;
const supplierWalletKey = "0x1111111111111111111111111111111111111111111111111111111111111111";
const supplierAccount = privateKeyToAccount(supplierWalletKey);
const supplierWallet = supplierAccount.address as Address;
const operatorAccount = privateKeyToAccount("0x4444444444444444444444444444444444444444444444444444444444444444");
const operatorWallet = operatorAccount.address as Address;
const teamAccount = privateKeyToAccount("0x3333333333333333333333333333333333333333333333333333333333333333");
const teamDerivedWallet = teamAccount.address as Address;
const teamMemberWallet = "0xcccc000000000000000000000000000000000003" as Address;
const outsiderWallet = "0xdddd000000000000000000000000000000000004" as Address;
const planId = examplePlanIds.planId as Hex;
const planHash = examplePlanIds.planHash as Hex;
const governanceAdminHeaders = {
  "x-uvp-admin-id": "governance-admin-1",
  "x-uvp-admin-role": "governance_admin",
  "x-uvp-store-dev-anchored-address": publisherAddress
};
const storeOperatorHeaders = {
  "x-uvp-store-user-id": "store-operator-1",
  "x-uvp-store-role": "operator",
  "x-uvp-store-dev-anchored-address": publisherAddress
};
const publisherAnchoredHeaders = {
  ...storeOperatorHeaders,
  "x-uvp-store-dev-anchored-address": publisherAddress
};

const roleSlotId = demoZhixuDetail.roleSlots[0]?.slotId ?? "supplier";
const stageIdOfFirstStage = demoZhixuDetail.stages[0]?.stageId ?? "stage-1";

describe("store access domains (sessions, descriptors, decoration, listings, join)", () => {
  it("wallet challenge → personal_sign verify → session with anchored address", async () => {
    const router = await buildRouter();

    const challengeResponse = await router.handle({
      method: "POST",
      pathname: "/store/auth/challenge",
      body: { address: supplierWallet }
    });
    expect(challengeResponse.status).toBe(201);
    const challenge = (challengeResponse.body as { challenge: { nonce: string; message: string; address: string } }).challenge;
    expect(challenge.message).toContain(supplierWallet.toLowerCase());

    const signature = await supplierAccount.signMessage({ message: challenge.message });
    const verifyResponse = await router.handle({
      method: "POST",
      pathname: "/store/auth/verify",
      body: { nonce: challenge.nonce, signature }
    });
    expect(verifyResponse.status).toBe(201);
    const verified = verifyResponse.body as { token: string; session: { anchoredAddress: string; accountId: string; addresses: { address: string }[] } };
    expect(verified.token).toMatch(/^uvs_/);
    expect(verified.session.anchoredAddress.toLowerCase()).toBe(supplierWallet.toLowerCase());
    expect(verified.session.addresses).toHaveLength(1);

    const replay = await router.handle({
      method: "POST",
      pathname: "/store/auth/verify",
      body: { nonce: challenge.nonce, signature }
    });
    expect(replay.status).toBe(401);
    expect(replay.body).toMatchObject({ error: "store_challenge_invalid" });

    const sessionResponse = await router.handle({
      method: "GET",
      pathname: "/store/session",
      headers: { "x-uvp-store-session": verified.token }
    });
    expect(sessionResponse.status).toBe(200);
    const session = (sessionResponse.body as { session: { anchoredAddress?: string; accountId?: string; accessLevel: string } }).session;
    expect(session.anchoredAddress?.toLowerCase()).toBe(supplierWallet.toLowerCase());
    expect(session.accessLevel).toBe("store_read");

    const forgedChallenge = await router.handle({
      method: "POST",
      pathname: "/store/auth/challenge",
      body: { address: outsiderWallet }
    });
    const forged = (forgedChallenge.body as { challenge: { nonce: string; message: string } }).challenge;
    const forgedVerify = await router.handle({
      method: "POST",
      pathname: "/store/auth/verify",
      body: { nonce: forged.nonce, signature: await supplierAccount.signMessage({ message: forged.message }) }
    });
    expect(forgedVerify.status).toBe(401);
    expect(forgedVerify.body).toMatchObject({ error: "store_challenge_signature_invalid" });

    const logout = await router.handle({
      method: "POST",
      pathname: "/store/auth/logout",
      headers: { "x-uvp-store-session": verified.token }
    });
    expect(logout.status).toBe(200);
    const afterLogout = await router.handle({
      method: "GET",
      pathname: "/store/auth/addresses",
      headers: { "x-uvp-store-session": verified.token }
    });
    expect(afterLogout.status).toBe(401);
  });

  it("operator wallet list grants store_operator level to anchored sessions", async () => {
    const router = await buildRouter({ operatorWallets: [operatorWallet] });
    const token = await login(router, operatorWallet);

    const sessionResponse = await router.handle({
      method: "GET",
      pathname: "/store/session",
      headers: { "x-uvp-store-session": token }
    });
    const session = (sessionResponse.body as { session: { accessLevel: string; canWrite: boolean } }).session;
    expect(session.accessLevel).toBe("store_operator");
    expect(session.canWrite).toBe(true);
  });

  it("plain wallet sessions get store_read level without a Store read role", async () => {
    const router = await buildRouter({ operatorWallets: [operatorWallet] });
    const plainToken = await login(router, supplierWallet);
    const operatorToken = await login(router, operatorWallet);

    const plainSession = (await router.handle({
      method: "GET",
      pathname: "/store/session",
      headers: { "x-uvp-store-session": plainToken }
    })).body as { session: { accessLevel: string; roles: readonly string[]; canWrite: boolean } };
    expect(plainSession.session.accessLevel).toBe("store_read");
    expect(plainSession.session.roles).toEqual(["anonymous_read"]);
    expect(plainSession.session.canWrite).toBe(false);

    const operatorSession = (await router.handle({
      method: "GET",
      pathname: "/store/session",
      headers: { "x-uvp-store-session": operatorToken }
    })).body as { session: { roles: readonly string[] } };
    expect(operatorSession.session.roles).toContain("store_operator");
  });

  it("store runtime observation reads require a Store read role", async () => {
    const router = await buildRouter({ operatorWallets: [operatorWallet] });
    const plainToken = await login(router, supplierWallet);
    const operatorToken = await login(router, operatorWallet);

    const runtimePaths = [
      "/store/runtime/summary",
      `/store/zhixus/${EXAMPLE_ZHIXU_ID}/orders`,
      "/store/orders/0x0000000000000000000000000000000000000000000000000000000000000909/observation",
      "/store/orders/0x0000000000000000000000000000000000000000000000000000000000000909/replay",
      "/store/orders/0x0000000000000000000000000000000000000000000000000000000000000909/audit-summary"
    ];
    for (const pathname of runtimePaths) {
      const plain = await router.handle({ method: "GET", pathname, headers: { "x-uvp-store-session": plainToken } });
      expect(plain).toMatchObject({ status: 403, body: { error: "forbidden" } });
    }
    const summary = await router.handle({
      method: "GET",
      pathname: "/store/runtime/summary",
      headers: { "x-uvp-store-session": operatorToken }
    });
    expect(summary.status).toBe(200);
    const orders = await router.handle({
      method: "GET",
      pathname: `/store/zhixus/${EXAMPLE_ZHIXU_ID}/orders`,
      headers: { "x-uvp-store-session": operatorToken }
    });
    expect(orders.status).toBe(200);
    const observation = await router.handle({
      method: "GET",
      pathname: "/store/orders/0x0000000000000000000000000000000000000000000000000000000000000909/observation",
      headers: { "x-uvp-store-session": operatorToken }
    });
    expect(observation).toMatchObject({ status: 404, body: { error: "store_order_not_found" } });
  });

  it("ignores the dev anchored address header outside local runtime", async () => {
    const { createWalletSessionStoreIdentityProvider } = await import("../src/store/sessions/index.js");
    const { createStoreSessionService } = await import("../src/store/sessions/index.js");
    const sessionService = createStoreSessionService({ store: stores.storeWalletSessionStore });
    const base = {
      async resolve() {
        return {
          level: "anonymous_read" as const,
          roles: ["anonymous_read" as const],
          authMode: "anonymous" as const,
          canWrite: false,
          canAdmin: false
        };
      }
    };
    const headers = { "x-uvp-store-dev-anchored-address": supplierWallet };
    const localProvider = createWalletSessionStoreIdentityProvider({
      base,
      sessionService,
      config: {
        enabled: true,
        operatorWallets: [],
        adminWallets: [],
        sessionTtlSeconds: 43200,
        challengeTtlSeconds: 300,
        devAnchoredAddressHeaderEnabled: true
      },
      runtimeEnvironment: "local"
    });
    expect((await localProvider.resolve(headers))?.anchoredAddress?.toLowerCase()).toBe(supplierWallet.toLowerCase());

    const testnetProvider = createWalletSessionStoreIdentityProvider({
      base,
      sessionService,
      config: {
        enabled: true,
        operatorWallets: [],
        adminWallets: [],
        sessionTtlSeconds: 43200,
        challengeTtlSeconds: 300,
        devAnchoredAddressHeaderEnabled: true
      },
      runtimeEnvironment: "testnet"
    });
    expect((await testnetProvider.resolve(headers)).anchoredAddress).toBeUndefined();
  });

  it("wallet sessions never receive the governance_admin role", async () => {
    const router = await buildRouter({ operatorWallets: [operatorWallet], adminWallets: [teamDerivedWallet] });
    const operatorToken = await login(router, operatorWallet);
    const adminToken = await login(router, teamDerivedWallet);

    for (const token of [operatorToken, adminToken]) {
      const sessionResponse = await router.handle({
        method: "GET",
        pathname: "/store/session",
        headers: { "x-uvp-store-session": token }
      });
      const session = (sessionResponse.body as { session: { accessLevel: string; roles: readonly string[] } }).session;
      expect(["store_operator", "store_admin"]).toContain(session.accessLevel);
      expect(session.roles).not.toContain("governance_admin");
    }
  });

  it("anchoring an additional address links it to the same account; revocation removes it", async () => {
    const router = await buildRouter();
    const firstToken = await login(router, supplierWallet);

    const challenge = await router.handle({
      method: "POST",
      pathname: "/store/auth/challenge",
      headers: { "x-uvp-store-session": firstToken },
      body: { address: teamMemberWallet, intent: "anchor_address" }
    });
    expect(challenge.status).toBe(201);
    const anchorChallenge = (challenge.body as { challenge: { nonce: string; message: string } }).challenge;
    const wrongKeyVerify = await router.handle({
      method: "POST",
      pathname: "/store/auth/verify",
      headers: { "x-uvp-store-session": firstToken },
      body: { nonce: anchorChallenge.nonce, signature: await teamAccount.signMessage({ message: anchorChallenge.message }) }
    });
    expect(wrongKeyVerify.status).toBe(401);

    const properAddress = teamDerivedWallet;
    const properChallenge = await router.handle({
      method: "POST",
      pathname: "/store/auth/challenge",
      headers: { "x-uvp-store-session": firstToken },
      body: { address: properAddress, intent: "anchor_address" }
    });
    const proper = (properChallenge.body as { challenge: { nonce: string; message: string } }).challenge;
    const properVerify = await router.handle({
      method: "POST",
      pathname: "/store/auth/verify",
      headers: { "x-uvp-store-session": firstToken },
      body: { nonce: proper.nonce, signature: await teamAccount.signMessage({ message: proper.message }) }
    });
    expect(properVerify.status).toBe(201);
    const linked = properVerify.body as { session: { accountId: string; addresses: { address: string }[] } };
    expect(linked.session.addresses.map((entry) => entry.address.toLowerCase())).toContain(properAddress.toLowerCase());

    const addresses = await router.handle({
      method: "GET",
      pathname: "/store/auth/addresses",
      headers: { "x-uvp-store-session": firstToken }
    });
    const list = (addresses.body as { accountId: string; addresses: { address: string; status: string }[] }).addresses;
    expect(list.filter((entry) => entry.status === "active")).toHaveLength(2);

    const revoke = await router.handle({
      method: "POST",
      pathname: "/store/auth/addresses/revoke",
      headers: { "x-uvp-store-session": firstToken },
      body: { address: properAddress }
    });
    expect(revoke.status).toBe(200);
    const afterRevoke = (revoke.body as { addresses: { address: string; status: string }[] }).addresses;
    expect(afterRevoke.find((entry) => entry.address.toLowerCase() === properAddress.toLowerCase())?.status).toBe("revoked");
  });

  it("descriptor snapshots are append-only and verifiable via descriptorHash", async () => {
    const router = await buildRouter();
    const subjectId = "0x0000000000000000000000000000000000000000000000000000000000007777" as Hex;

    await router.handle({
      method: "POST",
      pathname: "/store/suppliers",
      headers: governanceAdminHeaders,
      body: { supplierSubjectId: subjectId, displayName: "测试供应商", wallet: supplierWallet }
    });
    const suppliers = await router.handle({
      method: "GET",
      pathname: "/store/suppliers",
      headers: governanceAdminHeaders
    });
    const supplierId = (suppliers.body as { suppliers: { supplierId: string }[] }).suppliers[0]!.supplierId;
    await router.handle({
      method: "POST",
      pathname: `/store/suppliers/${supplierId}/review`,
      headers: governanceAdminHeaders,
      body: { reviewStatus: "approved_for_broadcast", confirmation: { supplierId } }
    });
    const registration = await router.handle({
      method: "POST",
      pathname: `/store/suppliers/${supplierId}/request-identity-registration`,
      headers: governanceAdminHeaders,
      body: { wallet: supplierWallet, confirmation: { supplierId } }
    });
    expect(registration.status).toBe(202);
    const descriptorHash = ((registration.body as { governance: { request: { descriptorHash: string } } }).governance.request.descriptorHash);

    const snapshotList = await router.handle({
      method: "GET",
      pathname: `/identity/descriptors/${subjectId}`
    });
    expect(snapshotList.status).toBe(200);
    const listed = (snapshotList.body as { snapshots: { descriptorHash: string }[] }).snapshots;
    expect(listed.map((entry) => entry.descriptorHash)).toContain(descriptorHash);

    const snapshot = await router.handle({
      method: "GET",
      pathname: `/identity/descriptors/${subjectId}/${descriptorHash}`
    });
    expect(snapshot.status).toBe(200);
    const dto = snapshot.body as { descriptorHash: string; verification: { matches: boolean; recomputedDescriptorHash: string }; descriptor: { subjectId: string; account: string } };
    expect(dto.verification.matches).toBe(true);
    expect(dto.verification.recomputedDescriptorHash).toBe(descriptorHash);
    expect(dto.descriptor.account.toLowerCase()).toBe(supplierWallet.toLowerCase());

    const missing = await router.handle({
      method: "GET",
      pathname: `/identity/descriptors/${subjectId}/0x${"f".repeat(64)}`
    });
    expect(missing.status).toBe(404);
  });

  it("only the plan publisher (or an active delegate) can save decoration data", async () => {
    const router = await buildRouter();

    const denied = await router.handle({
      method: "PUT",
      pathname: `/store/decoration/${planId}`,
      headers: { "x-uvp-store-dev-anchored-address": outsiderWallet },
      body: decorationBody()
    });
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ error: "not_plan_publisher" });

    const saved = await router.handle({
      method: "PUT",
      pathname: `/store/decoration/${planId}`,
      headers: publisherAnchoredHeaders,
      body: decorationBody()
    });
    expect(saved.status).toBe(201);
    const view = (saved.body as { current?: { version: number }; versions: { version: number }[] });
    expect(view.current?.version).toBe(1);

    const delegation = await router.handle({
      method: "POST",
      pathname: "/store/publishers/delegations",
      headers: publisherAnchoredHeaders,
      body: { publisherAddress, memberAddress: teamMemberWallet }
    });
    expect(delegation.status).toBe(201);
    const memberWrite = await router.handle({
      method: "PUT",
      pathname: `/store/decoration/${planId}`,
      headers: { "x-uvp-store-dev-anchored-address": teamMemberWallet },
      body: decorationBody({ theme: { displayName: "成员修订版" } })
    });
    expect(memberWrite.status).toBe(201);
    expect((memberWrite.body as { current?: { version: number } }).current?.version).toBe(2);

    const delegations = (delegation.body as { delegations: { delegationId: string; memberAddress: string; revokedAt?: string }[] }).delegations;
    const revoke = await router.handle({
      method: "POST",
      pathname: `/store/publishers/delegations/${delegations[0]!.delegationId}/revoke`,
      headers: publisherAnchoredHeaders,
      body: { reason: "rotation" }
    });
    expect(revoke.status).toBe(200);
    const memberBlocked = await router.handle({
      method: "PUT",
      pathname: `/store/decoration/${planId}`,
      headers: { "x-uvp-store-dev-anchored-address": teamMemberWallet },
      body: decorationBody()
    });
    expect(memberBlocked.status).toBe(403);

    const restored = await router.handle({
      method: "POST",
      pathname: `/store/decoration/${planId}/versions/1/restore`,
      headers: publisherAnchoredHeaders,
      body: {}
    });
    expect(restored.status).toBe(201);
    expect((restored.body as { current?: { version: number } }).current?.version).toBe(3);

    const businessField = await router.handle({
      method: "PUT",
      pathname: `/store/decoration/${planId}`,
      headers: publisherAnchoredHeaders,
      body: { schemaVersion: "store-zhixu-decoration.v1", theme: { displayName: "x", exampleField: "示例单号" } }
    });
    expect(businessField.status).toBe(400);
    expect(businessField.body).toMatchObject({ error: "invalid_decoration_field" });

  });

  it("listing import → anchor verification → review publish → delist hides catalog", async () => {
    const router = await buildRouter();

    const imported = await router.handle({
      method: "POST",
      pathname: "/store/listings/import",
      headers: storeOperatorHeaders,
      body: { planId, planHash }
    });
    expect(imported.status).toBe(201);
    const listing = (imported.body as { listing: { listingId: string; status: string }; anchorVerification: { status: string } });
    expect(listing.listing.status).toBe("imported");
    expect(listing.anchorVerification.status).toBe("consistent");

    const conflictImport = await router.handle({
      method: "POST",
      pathname: "/store/listings/import",
      headers: storeOperatorHeaders,
      body: { planId: examplePlanIds.planId, planHash: `0x${"ab".repeat(32)}` }
    });
    expect(conflictImport.status).toBe(409);
    expect(conflictImport.body).toMatchObject({ error: "listing_exists" });

    const approved = await router.handle({
      method: "POST",
      pathname: `/store/listings/${listing.listing.listingId}/review`,
      headers: storeOperatorHeaders,
      body: { decision: "approve" }
    });
    expect(approved.status).toBe(200);
    expect((approved.body as { listing: { status: string } }).listing.status).toBe("public");

    const publicAnchorVerification = await router.handle({
      method: "GET",
      pathname: `/store/listings/${listing.listing.listingId}/anchor-verification`
    });
    expect(publicAnchorVerification.status).toBe(200);
    expect((publicAnchorVerification.body as { anchorVerification: { status: string } }).anchorVerification.status).toBe("consistent");

    const catalogBefore = await router.handle({ method: "GET", pathname: "/store/zhixus" });
    const zhixusBefore = (catalogBefore.body as { zhixus: { planId: string }[] }).zhixus;
    expect(zhixusBefore.some((row) => row.planId.toLowerCase() === planId.toLowerCase())).toBe(true);

    const detail = await router.handle({
      method: "GET",
      pathname: `/store/zhixus/${EXAMPLE_ZHIXU_ID}`
    });
    expect(detail.status).toBe(200);
    const overlay = (detail.body as { storeOverlay?: { listing?: { status: string }; anchorVerification?: { status: string; checks: { id: string; outcome: string }[] } } }).storeOverlay;
    expect(overlay?.listing?.status).toBe("public");
    expect(overlay?.anchorVerification?.status).toBe("consistent");
    expect(overlay?.anchorVerification?.checks.some((check) => check.id === "plan_hash" && check.outcome === "match")).toBe(true);

    const delisted = await router.handle({
      method: "POST",
      pathname: `/store/listings/${listing.listing.listingId}/delist`,
      headers: storeOperatorHeaders,
      body: { reason: "governance decision" }
    });
    expect(delisted.status).toBe(200);
    const catalogAfter = await router.handle({ method: "GET", pathname: "/store/zhixus" });
    const zhixusAfter = (catalogAfter.body as { zhixus: { planId: string }[] }).zhixus;
    expect(zhixusAfter.some((row) => row.planId.toLowerCase() === planId.toLowerCase())).toBe(false);

    const detailAfter = await router.handle({
      method: "GET",
      pathname: `/store/zhixus/${EXAMPLE_ZHIXU_ID}`
    });
    expect(detailAfter.status).toBe(404);
    expect(detailAfter.body).toMatchObject({ error: "store_zhixu_not_found" });
    const operatorDetailAfter = await router.handle({
      method: "GET",
      pathname: `/store/zhixus/${EXAMPLE_ZHIXU_ID}`,
      headers: storeOperatorHeaders
    });
    expect(operatorDetailAfter.status).toBe(200);
    expect((operatorDetailAfter.body as { storeOverlay?: { listing?: { status: string } } }).storeOverlay?.listing?.status).toBe("delisted");

    const hiddenAnchorVerification = await router.handle({
      method: "GET",
      pathname: `/store/listings/${listing.listing.listingId}/anchor-verification`
    });
    expect(hiddenAnchorVerification.status).toBe(404);
    expect(hiddenAnchorVerification.body).toMatchObject({ error: "listing_not_found" });

    const operatorCatalog = await router.handle({
      method: "GET",
      pathname: "/store/zhixus",
      headers: storeOperatorHeaders
    });
    const operatorZhixus = (operatorCatalog.body as { zhixus: { planId: string }[] }).zhixus;
    expect(operatorZhixus.some((row) => row.planId.toLowerCase() === planId.toLowerCase())).toBe(true);

    const relisted = await router.handle({
      method: "POST",
      pathname: `/store/listings/${listing.listing.listingId}/relist`,
      headers: storeOperatorHeaders,
      body: {}
    });
    expect(relisted.status).toBe(200);
    expect((relisted.body as { listing: { status: string } }).listing.status).toBe("public");
  });

  it("conflicted anchors block publication (mismatched planHash claim)", async () => {
    const dockPlanId = "0x0000000000000000000000000000000000000000000000000000000000000102";
    const dockPlanHash = `0x${"ab".repeat(32)}` as Hex;
    const store = stores.projectionStore;
    await store.resetFromEvents({
      deploymentBlock: 0n,
      events: [
        chainEvent(1n, 0, "PlanRegistered", { planId: dockPlanId, planHash: dockPlanHash, hookCount: 2n })
      ]
    });
    const router = createApiRouter(store, routerOptions());
    const imported = await router.handle({
      method: "POST",
      pathname: "/store/listings/import",
      headers: storeOperatorHeaders,
      body: { planId: dockPlanId, planHash: `0x${"cd".repeat(32)}` }
    });
    expect(imported.status).toBe(201);
    const body = imported.body as { listing: { listingId: string }; anchorVerification: { status: string } };
    expect(body.anchorVerification.status).toBe("conflict");

    const publish = await router.handle({
      method: "POST",
      pathname: `/store/listings/${body.listing.listingId}/review`,
      headers: storeOperatorHeaders,
      body: { decision: "approve" }
    });
    expect(publish.status).toBe(409);
    expect(publish.body).toMatchObject({ error: "anchor_verification_failed" });
  });

  it("a listing transition racing a concurrent decision converges on one winner", async () => {
    const { createStoreListingService } = await import("../src/store/listings/index.js");
    let armed = false;
    class RacingRejectStore extends PostgresStoreListingStore {
      override async getListing(listingId: string) {
        const listing = await super.getListing(listingId);
        if (armed && listing?.status === "imported") {
          armed = false;
          const save = await super.putListing(
            { ...listing, status: "rejected", updatedAt: "2026-09-01T00:00:01.000Z" },
            { status: "imported" }
          );
          expect(save.applied).toBe(true);
        }
        return listing;
      }
    }
    const listingStore = new RacingRejectStore({ database: accessDatabase });
    const projectionStore = stores.projectionStore;
    await seedPlanProjection(projectionStore);
    const audits: { action: string; outcome: string }[] = [];
    const service = createStoreListingService({
      projectionStore,
      listingStore,
      now: () => new Date("2026-09-01T00:00:00Z"),
      audit: async (event) => { audits.push(event); }
    });
    const actor = { accessLevel: "store_admin", anchoredAddress: publisherAddress };
    const imported = await service.importListing({ planId }, actor);
    armed = true;

    await expect(service.reviewListing(imported.listing.listingId, { decision: "approve" }, actor))
      .rejects.toMatchObject({ status: 409, code: "listing_transition_conflict" });

    expect((await service.getListing(imported.listing.listingId)).listing.status).toBe("rejected");
    expect(audits.filter((event) => event.outcome === "succeeded" && event.action === "listing.reviewed")).toHaveLength(0);
  });

  it("join loop applied → under_review → authorized (identity pairing tx evidence)", async () => {
    const store = stores.projectionStore;
    await seedPlanProjection(store, { withSupplierBinding: true });
    const router = createApiRouter(store, routerOptions());
    const applicantToken = await login(router, supplierWallet);

    const submitted = await router.handle({
      method: "POST",
      pathname: "/store/join-applications",
      headers: { "x-uvp-store-session": applicantToken },
      body: { planId, roleSlotId, authorizationKind: "signal_submitter", displayName: "申请方一号" }
    });
    expect(submitted.status).toBe(201);
    const application = (submitted.body as { application: { applicationId: string; status: string; applicantAddress: string } });
    expect(application.application.status).toBe("applied");

    const anonymousSubmit = await router.handle({
      method: "POST",
      pathname: "/store/join-applications",
      body: { planId, roleSlotId }
    });
    expect(anonymousSubmit.status).toBe(401);

    const outsiderReview = await router.handle({
      method: "POST",
      pathname: `/store/join-applications/${application.application.applicationId}/review-start`,
      headers: { "x-uvp-store-dev-anchored-address": outsiderWallet },
      body: {}
    });
    expect(outsiderReview.status).toBe(403);

    const reviewStarted = await router.handle({
      method: "POST",
      pathname: `/store/join-applications/${application.application.applicationId}/review-start`,
      headers: publisherAnchoredHeaders,
      body: {}
    });
    expect(reviewStarted.status).toBe(200);
    expect((reviewStarted.body as { application: { status: string } }).application.status).toBe("under_review");

    const approved = await router.handle({
      method: "POST",
      pathname: `/store/join-applications/${application.application.applicationId}/approve`,
      headers: publisherAnchoredHeaders,
      body: { note: "资质通过" }
    });
    expect(approved.status).toBe(200);
    const approvedBody = approved.body as {
      application: { status: string; txEvidence: { kind: string; txHash?: string; status: string }[]; supplierId?: string };
      events: { type: string }[];
      identityPairing: { bindingStatus: string };
    };
    expect(approvedBody.application.status).toBe("authorized");
    expect(approvedBody.application.txEvidence.some((entry) => entry.kind === "identity_binding" && entry.txHash && entry.txHash.startsWith("0x"))).toBe(true);
    expect(approvedBody.events.map((event) => event.type)).toContain("authorized");
    expect(approvedBody.identityPairing.bindingStatus).toBe("active");

    const suppliers = await router.handle({
      method: "GET",
      pathname: "/store/suppliers",
      headers: governanceAdminHeaders
    });
    const createdSupplier = (suppliers.body as { suppliers: { wallet?: string; reviewStatus: string; identityStatus: string }[] }).suppliers
      .find((supplier) => supplier.wallet?.toLowerCase() === supplierWallet.toLowerCase());
    expect(createdSupplier).toMatchObject({ reviewStatus: "approved_for_broadcast", identityStatus: "active" });
  });

  it("publisher approval without governance admin is rejected before any side effects", async () => {
    const store = stores.projectionStore;
    await seedPlanProjection(store);
    const router = createApiRouter(store, routerOptions());
    const applicantToken = await login(router, supplierWallet);

    const submitted = await router.handle({
      method: "POST",
      pathname: "/store/join-applications",
      headers: { "x-uvp-store-session": applicantToken },
      body: { planId, roleSlotId, authorizationKind: "signal_submitter" }
    });
    const applicationId = (submitted.body as { application: { applicationId: string } }).application.applicationId;
    await router.handle({
      method: "POST",
      pathname: `/store/join-applications/${applicationId}/review-start`,
      headers: publisherAnchoredHeaders,
      body: {}
    });

    const denied = await router.handle({
      method: "POST",
      pathname: `/store/join-applications/${applicationId}/approve`,
      headers: publisherAnchoredHeaders,
      body: { note: "publisher-only approval" }
    });
    expect(denied).toMatchObject({
      status: 403,
      body: { error: "governance_admin_required" }
    });

    const suppliers = await router.handle({
      method: "GET",
      pathname: "/store/suppliers",
      headers: governanceAdminHeaders
    });
    const rows = (suppliers.body as { suppliers: { wallet?: string }[] }).suppliers;
    expect(rows.some((row) => row.wallet?.toLowerCase() === supplierWallet.toLowerCase())).toBe(false);

    const detail = await router.handle({
      method: "GET",
      pathname: `/store/join-applications/${applicationId}`,
      headers: { "x-uvp-store-session": applicantToken }
    });
    expect((detail.body as { application: { status: string } }).application.status).toBe("under_review");
  });

  it("publisher (non-operator) can self-import their own plan; join entry is suppressed while delisted", async () => {
    const store = stores.projectionStore;
    await seedPlanProjection(store);
    const router = createApiRouter(store, routerOptions());
    const publisherReadHeaders = {
      "x-uvp-store-user-id": "publisher-only",
      "x-uvp-store-role": "read",
      "x-uvp-store-dev-anchored-address": publisherAddress
    };

    const imported = await router.handle({
      method: "POST",
      pathname: "/store/listings/import",
      headers: publisherReadHeaders,
      body: { planId }
    });
    expect(imported.status).toBe(201);
    const listing = (imported.body as { listing: { listingId: string; status: string; planHashClaimed?: string } });
    expect(listing.listing.planHashClaimed?.toLowerCase()).toBe(planHash.toLowerCase());

    const publishDenied = await router.handle({
      method: "POST",
      pathname: `/store/listings/${listing.listing.listingId}/review`,
      headers: publisherReadHeaders,
      body: { decision: "approve" }
    });
    expect(publishDenied.status).toBe(403);

    const applicantTokenEarly = await login(router, supplierWallet);
    const joinWhileImported = await router.handle({
      method: "POST",
      pathname: "/store/join-applications",
      headers: { "x-uvp-store-session": applicantTokenEarly },
      body: { planId, roleSlotId, authorizationKind: "signal_submitter" }
    });
    expect(joinWhileImported.status).toBe(409);
    expect(joinWhileImported.body).toMatchObject({ error: "join_entry_suppressed" });

    await router.handle({
      method: "POST",
      pathname: `/store/listings/${listing.listing.listingId}/review`,
      headers: storeOperatorHeaders,
      body: { decision: "approve" }
    });
    await router.handle({
      method: "POST",
      pathname: `/store/listings/${listing.listing.listingId}/delist`,
      headers: storeOperatorHeaders,
      body: { reason: "test delist" }
    });

    const applicantToken = await login(router, supplierWallet);
    const joinDenied = await router.handle({
      method: "POST",
      pathname: "/store/join-applications",
      headers: { "x-uvp-store-session": applicantToken },
      body: { planId, roleSlotId, authorizationKind: "signal_submitter" }
    });
    expect(joinDenied.status).toBe(409);
    expect(joinDenied.body).toMatchObject({ error: "join_entry_suppressed" });

    await router.handle({
      method: "POST",
      pathname: `/store/listings/${listing.listing.listingId}/relist`,
      headers: storeOperatorHeaders,
      body: {}
    });
    const joinAllowed = await router.handle({
      method: "POST",
      pathname: "/store/join-applications",
      headers: { "x-uvp-store-session": applicantToken },
      body: { planId, roleSlotId, authorizationKind: "signal_submitter" }
    });
    expect(joinAllowed.status).toBe(201);
  });

  it("configured chain read failure blocks publication (fail-closed)", async () => {
    const store = stores.projectionStore;
    await seedPlanProjection(store);
    const router = createApiRouter(store, {
      ...routerOptions(),
      listingAnchorChainView: {
        readPlanAnchors: async () => {
          throw new Error("rpc unavailable");
        }
      }
    });
    const imported = await router.handle({
      method: "POST",
      pathname: "/store/listings/import",
      headers: storeOperatorHeaders,
      body: { planId, planHash }
    });
    expect(imported.status).toBe(201);
    const listing = (imported.body as { listing: { listingId: string } });
    const verification = await router.handle({
      method: "GET",
      pathname: `/store/listings/${listing.listing.listingId}/anchor-verification`
    });
    expect(verification.status).toBe(404);
    expect(verification.body).toMatchObject({ error: "listing_not_found" });

    const operatorVerification = await router.handle({
      method: "GET",
      pathname: `/store/listings/${listing.listing.listingId}/anchor-verification`,
      headers: storeOperatorHeaders
    });
    expect(operatorVerification.status).toBe(200);
    expect((operatorVerification.body as { anchorVerification: { chainReadFailed?: boolean } }).anchorVerification.chainReadFailed).toBe(true);

    const publish = await router.handle({
      method: "POST",
      pathname: `/store/listings/${listing.listing.listingId}/review`,
      headers: storeOperatorHeaders,
      body: { decision: "approve" }
    });
    expect(publish.status).toBe(409);
    expect(publish.body).toMatchObject({ error: "anchor_verification_failed" });
  });

  it("join gate fails closed on listing read failure and chain read failure", async () => {
    const { createStoreJoinService, StoreJoinServiceError } = await import("../src/store/join/index.js");
    const joinService = (listingGate: NonNullable<Parameters<typeof createStoreJoinService>[0]["listingGate"]>) =>
      createStoreJoinService({
        projectionStore: { listIdentityBindings: async () => [] } as unknown as Parameters<typeof createStoreJoinService>[0]["projectionStore"],
        productService: {
          listZhixu: async () => [{ zhixuId: "zx-join-gate", planPublication: { planId } }],
          getZhixu: async () => ({ roleSlots: [{ slotId: roleSlotId }], stages: [] })
        } as unknown as Parameters<typeof createStoreJoinService>[0]["productService"],
        supplierService: {} as Parameters<typeof createStoreJoinService>[0]["supplierService"],
        publisherAccess: { hasPublisherWriteAccess: async () => false },
        joinStore: stores.storeJoinApplicationStore,
        listingGate
      });
    const actor = { anchoredAddress: supplierWallet, authMode: "dev_store_headers", accessLevel: "store_read" };
    const application = { planId, roleSlotId, authorizationKind: "signal_submitter" as const };

    await expect(joinService({
      getListingForPlan: async () => {
        throw new Error("listing store unavailable");
      }
    }).submitApplication(application, actor)).rejects.toMatchObject({
      status: 503,
      code: "listing_gate_unavailable"
    } satisfies Partial<InstanceType<typeof StoreJoinServiceError>>);

    await expect(joinService({
      getListingForPlan: async () => ({
        status: "public",
        anchorVerification: { status: "consistent", chainReadFailed: true }
      })
    }).submitApplication(application, actor)).rejects.toMatchObject({
      status: 409,
      code: "join_entry_suppressed"
    } satisfies Partial<InstanceType<typeof StoreJoinServiceError>>);

    await expect(joinService({
      getListingForPlan: async () => ({
        status: "public",
        anchorVerification: { status: "consistent" }
      })
    }).submitApplication(application, actor)).resolves.toMatchObject({
      application: { status: "applied" }
    });
  });

  it("join rejects a planId that matches multiple catalog deployments (fail-closed)", async () => {
    const { createStoreJoinService, StoreJoinServiceError } = await import("../src/store/join/index.js");
    const joinService = createStoreJoinService({
      projectionStore: { listIdentityBindings: async () => [] } as unknown as Parameters<typeof createStoreJoinService>[0]["projectionStore"],
      productService: {
        listZhixu: async () => [
          { zhixuId: "zx-join-dup-a", planPublication: { planId } },
          { zhixuId: "zx-join-dup-b", planPublication: { planId } }
        ],
        getZhixu: async () => ({ roleSlots: [{ slotId: roleSlotId }], stages: [] })
      } as unknown as Parameters<typeof createStoreJoinService>[0]["productService"],
      supplierService: {} as Parameters<typeof createStoreJoinService>[0]["supplierService"],
      publisherAccess: { hasPublisherWriteAccess: async () => false },
      joinStore: stores.storeJoinApplicationStore
    });
    await expect(joinService.submitApplication(
      { planId, roleSlotId, authorizationKind: "signal_submitter" },
      { anchoredAddress: supplierWallet, authMode: "dev_store_headers", accessLevel: "store_read" }
    )).rejects.toMatchObject({
      status: 409,
      code: "plan_projection_ambiguous"
    } satisfies Partial<InstanceType<typeof StoreJoinServiceError>>);
  });

  it("reviewer without planId scope only sees their own applications", async () => {
    const store = stores.projectionStore;
    await seedPlanProjection(store, { withSupplierBinding: true });
    const router = createApiRouter(store, routerOptions());
    const applicantToken = await login(router, supplierWallet);
    await router.handle({
      method: "POST",
      pathname: "/store/join-applications",
      headers: { "x-uvp-store-session": applicantToken },
      body: { planId, roleSlotId, authorizationKind: "signal_submitter" }
    });

    const publisherReadHeaders = {
      "x-uvp-store-user-id": "publisher-only",
      "x-uvp-store-role": "read",
      "x-uvp-store-dev-anchored-address": publisherAddress
    };
    const publisherList = await router.handle({
      method: "GET",
      pathname: "/store/join-applications",
      headers: publisherReadHeaders
    });
    expect(publisherList.status).toBe(200);
    expect((publisherList.body as { applications: unknown[] }).applications).toHaveLength(0);

    const applicantScoped = await router.handle({
      method: "GET",
      pathname: "/store/join-applications",
      headers: { "x-uvp-store-session": applicantToken },
      query: { planId }
    });
    expect(applicantScoped.status).toBe(200);
    const scoped = (applicantScoped.body as { applications: { application: { applicantAddress: string } }[] }).applications;
    expect(scoped.every((entry) => entry.application.applicantAddress.toLowerCase() === supplierWallet.toLowerCase())).toBe(true);
    expect(scoped).toHaveLength(1);
  });

  it("reject leaves an audited trail with reason and reviewer session", async () => {
    const router = await buildRouter();
    const applicantToken = await login(router, supplierWallet);
    const submitted = await router.handle({
      method: "POST",
      pathname: "/store/join-applications",
      headers: { "x-uvp-store-session": applicantToken },
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
      body: { reason: "资料不完整" }
    });
    expect(rejected.status).toBe(200);
    const rejectedBody = rejected.body as { application: { status: string; rejectionReason?: string }; events: { type: string; reason?: string; actorAddress?: string }[] };
    expect(rejectedBody.application.status).toBe("rejected");
    expect(rejectedBody.application.rejectionReason).toBe("资料不完整");
    const rejectEvent = rejectedBody.events.find((event) => event.type === "rejected");
    expect(rejectEvent?.actorAddress?.toLowerCase()).toBe(publisherAddress.toLowerCase());

    const myList = await router.handle({
      method: "GET",
      pathname: "/store/join-applications",
      headers: { "x-uvp-store-session": applicantToken }
    });
    expect(myList.status).toBe(200);
    const listBody = myList.body as { applications: { application: { applicationId: string } }[] };
    expect(listBody.applications.every((entry) => entry.application.applicationId === applicationId)).toBe(true);
  });

  it("concurrent join submissions leave exactly one open application", async () => {
    const store = stores.projectionStore;
    await seedPlanProjection(store, { withSupplierBinding: true });
    const router = createApiRouter(store, routerOptions());
    const applicantToken = await login(router, supplierWallet);

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => router.handle({
        method: "POST",
        pathname: "/store/join-applications",
        headers: { "x-uvp-store-session": applicantToken },
        body: { planId, roleSlotId, authorizationKind: "signal_submitter" }
      }))
    );
    const responses = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
    expect(responses).toHaveLength(8);
    expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
    for (const conflict of responses.filter((response) => response.status === 409)) {
      expect(conflict.body).toMatchObject({ error: "application_exists" });
    }
    const list = await router.handle({
      method: "GET",
      pathname: "/store/join-applications",
      headers: { "x-uvp-store-session": applicantToken }
    });
    expect((list.body as { applications: unknown[] }).applications).toHaveLength(1);
  });

  it("concurrent listing imports for one plan leave exactly one listing (409 for the loser)", async () => {
    const router = await buildRouter();

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => router.handle({
        method: "POST",
        pathname: "/store/listings/import",
        headers: storeOperatorHeaders,
        body: { planId, planHash }
      }))
    );
    const responses = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
    expect(responses).toHaveLength(8);
    expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
    for (const conflict of responses.filter((response) => response.status === 409)) {
      expect(conflict.body).toMatchObject({ error: "listing_exists" });
    }
    const catalog = await router.handle({
      method: "GET",
      pathname: "/store/listings",
      headers: storeOperatorHeaders
    });
    const listings = (catalog.body as { listings: { planId: string }[] }).listings;
    expect(listings.filter((listing) => listing.planId.toLowerCase() === planId.toLowerCase())).toHaveLength(1);
  });
});


function decorationBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "store-zhixu-decoration.v1",
    theme: { displayName: "示例展示主题", description: "展示描述", tags: ["tag-1"] },
    taskDeclarations: [{ stageId: stageIdOfFirstStage }],
    ...overrides
  };
}

async function buildRouter(options: { readonly operatorWallets?: readonly Address[]; readonly adminWallets?: readonly Address[] } = {}): Promise<ApiRouter> {
  const store = stores.projectionStore;
  await seedPlanProjection(store);
  return createApiRouter(store, routerOptions(options));
}

function routerOptions(options: { readonly operatorWallets?: readonly Address[]; readonly adminWallets?: readonly Address[] } = {}) {
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
        operatorWallets: options.operatorWallets ?? [],
        adminWallets: options.adminWallets ?? [],
        sessionTtlSeconds: 43200,
        challengeTtlSeconds: 300,
        devAnchoredAddressHeaderEnabled: true
      }
    }
  };
}

async function seedPlanProjection(store: ProjectionStore, options: { readonly withSupplierBinding?: boolean } = {}): Promise<void> {
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
        : [])
    ]
  });
}

function derivedJoinSubject(address: Address): Hex {
  return keccak256(stringToBytes(`uvp:store:join:subject:v1:${address.toLowerCase()}`)) as Hex;
}

function bytes32Text(value: string): Hex {
  return `0x${Buffer.from(value, "utf8").toString("hex").padEnd(64, "0")}` as Hex;
}

async function login(router: ApiRouter, address: Address): Promise<string> {
  const challenge = await router.handle({
    method: "POST",
    pathname: "/store/auth/challenge",
    body: { address }
  });
  expect(challenge.status).toBe(201);
  const { nonce, message } = (challenge.body as { challenge: { nonce: string; message: string } }).challenge;
  const account = address.toLowerCase() === supplierWallet.toLowerCase()
    ? supplierAccount
    : privateKeyToAccount(keyForAddress(address));
  const signature = await account.signMessage({ message });
  const verify = await router.handle({
    method: "POST",
    pathname: "/store/auth/verify",
    body: { nonce, signature }
  });
  expect(verify.status).toBe(201);
  return (verify.body as { token: string }).token;
}

const addressKeyMap = new Map<string, `0x${string}`>([
  [supplierWallet.toLowerCase(), supplierWalletKey],
  [operatorWallet.toLowerCase(), "0x4444444444444444444444444444444444444444444444444444444444444444"],
  [teamDerivedWallet.toLowerCase(), "0x3333333333333333333333333333333333333333333333333333333333333333"]
]);

describe("store auth challenge resource bounds", () => {
  it("rate-limits live challenges per address and sweeps expired ones on write", async () => {
    const { createStoreSessionService, StoreSessionServiceError } =
      await import("../src/store/sessions/index.js");
    let current = new Date("2026-04-28T00:00:00Z");
    const store = new PostgresStoreWalletSessionStore({ database: accessDatabase });
    const service = createStoreSessionService({
      store,
      config: {
        enabled: true,
        operatorWallets: [],
        adminWallets: [],
        sessionTtlSeconds: 43200,
        challengeTtlSeconds: 300,
        devAnchoredAddressHeaderEnabled: false
      },
      now: () => current
    });

    for (let index = 0; index < 10; index += 1) {
      await expect(service.createChallenge({ address: supplierWallet })).resolves.toBeDefined();
    }
    const limited = service.createChallenge({ address: supplierWallet });
    await expect(limited).rejects.toMatchObject({
      status: 429,
      code: "store_challenge_rate_limited"
    });
    await expect(limited).rejects.toBeInstanceOf(StoreSessionServiceError);

    await expect(service.createChallenge({ address: outsiderWallet })).resolves.toBeDefined();

    current = new Date(current.getTime() + 301_000);
    await expect(service.createChallenge({ address: supplierWallet })).resolves.toBeDefined();
  });

  it("caps a single requester across all addresses (anonymous targeted lockout bound)", async () => {
    const { createStoreSessionService, StoreSessionServiceError } =
      await import("../src/store/sessions/index.js");
    const current = new Date(Date.UTC(2026, 8, 10, 0, 0, 0));
    const service = createStoreSessionService({
      store: new PostgresStoreWalletSessionStore({ database: accessDatabase }),
      config: {
        enabled: true,
        operatorWallets: [],
        adminWallets: [],
        sessionTtlSeconds: 43200,
        challengeTtlSeconds: 300,
        devAnchoredAddressHeaderEnabled: false
      },
      now: () => current
    });
    const requester = { clientAddress: "203.0.113.7" };
    for (let index = 0; index < 30; index += 1) {
      const address = `0x${(0x1000 + index).toString(16).padStart(40, "0")}` as Address;
      await expect(service.createChallenge({ address }, undefined, requester)).resolves.toBeDefined();
    }
    await expect(
      service.createChallenge({ address: `0x${"7".repeat(40)}` as Address }, undefined, requester)
    ).rejects.toMatchObject({ status: 429, code: "store_challenge_rate_limited" });
    await expect(
      service.createChallenge({ address: `0x${"8".repeat(40)}` as Address }, undefined, requester)
    ).rejects.toBeInstanceOf(StoreSessionServiceError);
    await expect(
      service.createChallenge({ address: `0x${"7".repeat(40)}` as Address }, undefined, { clientAddress: "198.51.100.9" })
    ).resolves.toBeDefined();
  });

  it("holds the per-address challenge quota under concurrent creation", async () => {
    const { StoreSessionServiceError, createStoreSessionService } =
      await import("../src/store/sessions/index.js");
    const store = new PostgresStoreWalletSessionStore({ database: accessDatabase });
    const current = new Date(Date.UTC(2026, 8, 10, 0, 0, 0));
    const service = createStoreSessionService({
      store,
      config: {
        enabled: true,
        operatorWallets: [],
        adminWallets: [],
        sessionTtlSeconds: 43200,
        challengeTtlSeconds: 300,
        devAnchoredAddressHeaderEnabled: false
      },
      now: () => current
    });
    const stormWallet = `0x${"9".repeat(40)}` as Address;
    const results = await Promise.allSettled(
      Array.from({ length: 32 }, () => service.createChallenge({ address: stormWallet }))
    );
    const accepted = results.filter((result) => result.status === "fulfilled").length;
    expect(accepted).toBe(10);
    const rejected = results.filter((result) => result.status === "rejected");
    expect(rejected.every((result) => result.reason instanceof StoreSessionServiceError && result.reason.status === 429)).toBe(true);
  });
});

function keyForAddress(address: Address): `0x${string}` {
  const key = addressKeyMap.get(address.toLowerCase());
  if (!key) {
    throw new Error(`no test key registered for ${address}`);
  }
  return key;
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
