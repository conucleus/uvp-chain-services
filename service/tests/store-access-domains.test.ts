import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { keccak256, stringToBytes } from "viem";
import { CROSS_BORDER_ZHIXU_ID, crossBorderPlanIds, demoZhixuDetail } from "@uvp-eth/product-dto/fixtures";
import { createApiRouter } from "../src/api/routes.js";
import type { ChainEvent } from "../src/indexer/events.js";
import { MemoryProjectionStore } from "../src/storage/projection-store.js";
import type { ApiRouter } from "../src/api/route-context.js";
import type { Address, Hex } from "../src/shared/types.js";
import { crossBorderSchemaResolver } from "./cross-border-schema.js";
import type { StoreAuthChallengeRecord } from "../src/store/sessions/index.js";

/**
 * Store 身份与会话、加入闭环、装修权限、上架与锚核验的后端验收。
 *
 * 链侧事实全部经投影播种（PlanRegistered/PlanPublisherRecorded/
 * IdentityBindingRegistered/SignalSubmitterAuthorized …），服务端广播走
 * 模拟治理适配器（simulated_tx 带 txHash）。
 */

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
const planId = crossBorderPlanIds.planId as Hex;
const planHash = crossBorderPlanIds.planHash as Hex;
const governanceAdminHeaders = {
  "x-uvp-admin-id": "governance-admin-1",
  "x-uvp-admin-role": "governance_admin",
  // 红线：供应商写路由要求会话已锚定地址（本地联调 dev 锚定头）。
  "x-uvp-store-dev-anchored-address": publisherAddress
};
const storeOperatorHeaders = {
  "x-uvp-store-user-id": "store-operator-1",
  "x-uvp-store-role": "operator",
  // 红线：listing/供应商写路由要求会话已锚定地址（本地联调 dev 锚定头）。
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

    // 挑战一次性：重放被拒绝。
    const replay = await router.handle({
      method: "POST",
      pathname: "/store/auth/verify",
      body: { nonce: challenge.nonce, signature }
    });
    expect(replay.status).toBe(401);
    expect(replay.body).toMatchObject({ error: "store_challenge_invalid" });

    // 会话叠加到 /store/session（含锚定地址）。
    const sessionResponse = await router.handle({
      method: "GET",
      pathname: "/store/session",
      headers: { "x-uvp-store-session": verified.token }
    });
    expect(sessionResponse.status).toBe(200);
    const session = (sessionResponse.body as { session: { anchoredAddress?: string; accountId?: string; accessLevel: string } }).session;
    expect(session.anchoredAddress?.toLowerCase()).toBe(supplierWallet.toLowerCase());
    expect(session.accessLevel).toBe("store_read");

    // 错误签名被拒绝：挑战发给 outsider，却由 supplier 的钥匙签名。
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

    // 登出后会话失效。
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

  it("operator wallet list grants operator capabilities to anchored sessions", async () => {
    const router = await buildRouter({ operatorWallets: [operatorWallet] });
    const token = await login(router, operatorWallet);

    const sessionResponse = await router.handle({
      method: "GET",
      pathname: "/store/session",
      headers: { "x-uvp-store-session": token }
    });
    const session = (sessionResponse.body as { session: { accessLevel: string; capabilities: readonly string[] } }).session;
    expect(session.accessLevel).toBe("store_operator");
    expect(session.capabilities).toContain("store.listing.manage");
  });

  it("plain wallet sessions only get the public read capability, not store.audit.read", async () => {
    // 未命中运营方/管理员清单的钱包登录只证明钱包控制权——运营审计
    // （store.audit.read）是运营数据面，不得随登录默认授予。
    const router = await buildRouter({ operatorWallets: [operatorWallet] });
    const plainToken = await login(router, supplierWallet);
    const operatorToken = await login(router, operatorWallet);

    const plainSession = (await router.handle({
      method: "GET",
      pathname: "/store/session",
      headers: { "x-uvp-store-session": plainToken }
    })).body as { session: { accessLevel: string; capabilities: readonly string[] } };
    expect(plainSession.session.accessLevel).toBe("store_read");
    expect(plainSession.session.capabilities).toContain("store.read");
    expect(plainSession.session.capabilities).not.toContain("store.audit.read");

    const operatorSession = (await router.handle({
      method: "GET",
      pathname: "/store/session",
      headers: { "x-uvp-store-session": operatorToken }
    })).body as { session: { capabilities: readonly string[] } };
    expect(operatorSession.session.capabilities).toContain("store.audit.read");
  });

  it("store runtime observation reads require the store.audit.read capability", async () => {
    // 运行时观察面（summary/订单观察/回放/审计汇总）无参与者过滤，暴露
    // 全量订单的 authorizations/signals submitter、tasks assigneeWallet
    // 与参与者钱包映射：任意第三方钱包 SIWE 登录不得因"有锚定会话"即得
    // 运营数据——与 /store/audit 同能力门（store.audit.read）。
    const router = await buildRouter({ operatorWallets: [operatorWallet] });
    const plainToken = await login(router, supplierWallet);
    const operatorToken = await login(router, operatorWallet);

    const runtimePaths = [
      "/store/runtime/summary",
      `/store/zhixus/${CROSS_BORDER_ZHIXU_ID}/orders`,
      "/store/orders/0x0000000000000000000000000000000000000000000000000000000000000909/observation",
      "/store/orders/0x0000000000000000000000000000000000000000000000000000000000000909/replay",
      "/store/orders/0x0000000000000000000000000000000000000000000000000000000000000909/audit-summary"
    ];
    for (const pathname of runtimePaths) {
      // 纯钱包会话只证明钱包控制权（store.read）：403，不因锚定而放行。
      const plain = await router.handle({ method: "GET", pathname, headers: { "x-uvp-store-session": plainToken } });
      expect(plain).toMatchObject({ status: 403, body: { error: "forbidden" } });
    }
    // 运营方钱包会话持有 store.audit.read：summary/订单列表 200；具体
    // 订单缺投影时 404（不泄露存在），不再是身份层拒绝。
    const summary = await router.handle({
      method: "GET",
      pathname: "/store/runtime/summary",
      headers: { "x-uvp-store-session": operatorToken }
    });
    expect(summary.status).toBe(200);
    const orders = await router.handle({
      method: "GET",
      pathname: `/store/zhixus/${CROSS_BORDER_ZHIXU_ID}/orders`,
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
    const sessionService = createStoreSessionService();
    const base = {
      async resolve() {
        return {
          level: "anonymous_read" as const,
          roles: ["anonymous_read" as const],
          capabilities: ["store.read" as const],
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
    // testnet 是公开测试网：自报地址头不构成身份锚定。
    expect((await testnetProvider.resolve(headers)).anchoredAddress).toBeUndefined();
  });

  it("wallet sessions never receive store.draft.review (governance-only capability)", async () => {
    // 职责分离（store/console/access.ts 口径）：zhixu 草稿审核是治理动作，
    // 专属 governance_admin——钱包会话的 operator/store_admin 能力表都
    // 不得下放（JWT 侧同样刻意不映射）。
    const router = await buildRouter({ operatorWallets: [operatorWallet], adminWallets: [teamDerivedWallet] });
    const operatorToken = await login(router, operatorWallet);
    const adminToken = await login(router, teamDerivedWallet);

    for (const token of [operatorToken, adminToken]) {
      const sessionResponse = await router.handle({
        method: "GET",
        pathname: "/store/session",
        headers: { "x-uvp-store-session": token }
      });
      const session = (sessionResponse.body as { session: { accessLevel: string; capabilities: readonly string[] } }).session;
      expect(["store_operator", "store_admin"]).toContain(session.accessLevel);
      expect(session.capabilities).not.toContain("store.draft.review");
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
    // 挑战发给 teamMemberWallet，但由另一个真实密钥签名 → 地址不符被拒。
    const wrongKeyVerify = await router.handle({
      method: "POST",
      pathname: "/store/auth/verify",
      headers: { "x-uvp-store-session": firstToken },
      body: { nonce: anchorChallenge.nonce, signature: await teamAccount.signMessage({ message: anchorChallenge.message }) }
    });
    expect(wrongKeyVerify.status).toBe(401);

    // 正确流程：为派生地址签挑战。
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

    // 准备审核记录 → 身份注册（模拟广播）。
    await router.handle({
      method: "POST",
      pathname: "/store/suppliers",
      headers: governanceAdminHeaders,
      body: { supplierSubjectId: subjectId, displayName: "测试供应商", wallet: supplierWallet }
    });
    const suppliers = await router.handle({
      method: "GET",
      pathname: "/store/suppliers",
      // 读面鉴权——用已认证 store 头读取。
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

    // 篡改检测：错误的 hash 查不到快照。
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

    // 委托：publisher 授予团队成员 → 成员可写；撤销后立即失去写权限。
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

    // 版本回滚 = 新版本复制旧版本。
    const restored = await router.handle({
      method: "POST",
      pathname: `/store/decoration/${planId}/versions/1/restore`,
      headers: publisherAnchoredHeaders,
      body: {}
    });
    expect(restored.status).toBe(201);
    expect((restored.body as { current?: { version: number } }).current?.version).toBe(3);

    // 结构校验拒绝业务性/未知字段与非法 evidenceSpec。
    const businessField = await router.handle({
      method: "PUT",
      pathname: `/store/decoration/${planId}`,
      headers: publisherAnchoredHeaders,
      body: { schemaVersion: "store-zhixu-decoration.v1", theme: { displayName: "x", customsField: "报关单号" } }
    });
    expect(businessField.status).toBe(400);
    expect(businessField.body).toMatchObject({ error: "invalid_decoration_field" });

    const badSpec = await router.handle({
      method: "PUT",
      pathname: `/store/decoration/${planId}`,
      headers: publisherAnchoredHeaders,
      body: {
        schemaVersion: "store-zhixu-decoration.v1",
        taskDeclarations: [{ stageId: stageIdOfFirstStage, evidenceSpec: [{ key: "", label: "空 key" }] }]
      }
    });
    expect(badSpec.status).toBe(400);
    expect((badSpec.body as { error: string }).error).toContain("invalid_evidence_spec");
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

    // 冲突：声称一个错误的 planHash → 锚核验 conflict，公开被阻断。
    const conflictImport = await router.handle({
      method: "POST",
      pathname: "/store/listings/import",
      headers: storeOperatorHeaders,
      body: { planId: crossBorderPlanIds.planId, planHash: `0x${"ab".repeat(32)}` }
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

    // 目录可见（含该 zhixu）。
    const catalogBefore = await router.handle({ method: "GET", pathname: "/store/zhixus" });
    const zhixusBefore = (catalogBefore.body as { zhixus: { planId: string }[] }).zhixus;
    expect(zhixusBefore.some((row) => row.planId.toLowerCase() === planId.toLowerCase())).toBe(true);

    // 详情页叠加锚核验。
    const detail = await router.handle({
      method: "GET",
      pathname: `/store/zhixus/${CROSS_BORDER_ZHIXU_ID}`
    });
    expect(detail.status).toBe(200);
    const overlay = (detail.body as { storeOverlay?: { listing?: { status: string }; anchorVerification?: { status: string; checks: { id: string; outcome: string }[] } } }).storeOverlay;
    expect(overlay?.listing?.status).toBe("public");
    expect(overlay?.anchorVerification?.status).toBe("consistent");
    expect(overlay?.anchorVerification?.checks.some((check) => check.id === "plan_hash" && check.outcome === "match")).toBe(true);

    // 下架：目录与匿名读取不可见，直链显示已下架；链上事实（detail 链数据）仍在。
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

    // 详情与列表/search 同口径：delisted 对非运营方 404（不泄露存在），
    // 运营方保留治理可见性（下架状态经 overlay 可见）。
    const detailAfter = await router.handle({
      method: "GET",
      pathname: `/store/zhixus/${CROSS_BORDER_ZHIXU_ID}`
    });
    expect(detailAfter.status).toBe(404);
    expect(detailAfter.body).toMatchObject({ error: "store_zhixu_not_found" });
    const operatorDetailAfter = await router.handle({
      method: "GET",
      pathname: `/store/zhixus/${CROSS_BORDER_ZHIXU_ID}`,
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

    // 运营方仍能在目录里看到（治理观察）。
    const operatorCatalog = await router.handle({
      method: "GET",
      pathname: "/store/zhixus",
      headers: storeOperatorHeaders
    });
    const operatorZhixus = (operatorCatalog.body as { zhixus: { planId: string }[] }).zhixus;
    expect(operatorZhixus.some((row) => row.planId.toLowerCase() === planId.toLowerCase())).toBe(true);

    // 重新上架：锚核验一致才允许。
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
    const router = await buildRouter();
    // 为第二个 plan 建 listing，声称错误 planHash。
    const dockPlanId = "0x0000000000000000000000000000000000000000000000000000000000000102";
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

  it("join loop applied → under_review → authorized (identity pairing tx evidence)", async () => {
    const store = new MemoryProjectionStore();
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

    // 无锚定会话不能提交敏感操作。
    const anonymousSubmit = await router.handle({
      method: "POST",
      pathname: "/store/join-applications",
      body: { planId, roleSlotId }
    });
    expect(anonymousSubmit.status).toBe(401);

    // 非 publisher 不能审核。
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
    // 授权意向已记录（订单触发时落地链上）。
    expect(approvedBody.identityPairing.bindingStatus).toBe("active");

    // 供应商与治理审核记录成对出现（审计配对）。
    const suppliers = await router.handle({
      method: "GET",
      pathname: "/store/suppliers",
      // 读面鉴权——用已认证 store 头读取。
      headers: governanceAdminHeaders
    });
    const createdSupplier = (suppliers.body as { suppliers: { wallet?: string; reviewStatus: string; identityStatus: string }[] }).suppliers
      .find((supplier) => supplier.wallet?.toLowerCase() === supplierWallet.toLowerCase());
    expect(createdSupplier).toMatchObject({ reviewStatus: "approved_for_broadcast", identityStatus: "active" });
  });

  it("publisher approval without governance admin is rejected before any side effects", async () => {
    // 无既有 active binding 时，链上身份登记需要 governance_admin 权威：
    // 门禁前置于建供应商/翻 approved_for_broadcast/落治理 review——
    // 拒绝后不留半提交（供应商未创建、申请留在 under_review）。
    const store = new MemoryProjectionStore();
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

    // 无半提交：供应商目录里没有该申请人的记录。
    const suppliers = await router.handle({
      method: "GET",
      pathname: "/store/suppliers",
      headers: governanceAdminHeaders
    });
    const rows = (suppliers.body as { suppliers: { wallet?: string }[] }).suppliers;
    expect(rows.some((row) => row.wallet?.toLowerCase() === supplierWallet.toLowerCase())).toBe(false);

    // 申请仍在 under_review（未被翻成 authorized/失败终态）。
    const detail = await router.handle({
      method: "GET",
      pathname: `/store/join-applications/${applicationId}`,
      headers: { "x-uvp-store-session": applicantToken }
    });
    expect((detail.body as { application: { status: string } }).application.status).toBe("under_review");
  });

  it("on-chain authorization event materializes the application to active", async () => {    const store = new MemoryProjectionStore();
    await seedPlanProjection(store, { withSupplierBinding: true });
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
    const approved = await router.handle({
      method: "POST",
      pathname: `/store/join-applications/${applicationId}/approve`,
      headers: publisherAnchoredHeaders,
      body: {}
    });
    expect((approved.body as { application: { status: string } }).application.status).toBe("authorized");

    // 链上出现授权事实（SignalSubmitterAuthorized，submitter=申请人）→ 申请落为 active。
    await seedOrderWithAuthorization(store, supplierWallet);
    const detail = await router.handle({
      method: "GET",
      pathname: `/store/join-applications/${applicationId}`,
      headers: { "x-uvp-store-session": applicantToken }
    });
    const detailBody = detail.body as { application: { status: string; txEvidence: { kind: string; status: string; txHash?: string }[] }; events: { type: string }[]; identityPairing: unknown };
    expect(detailBody.application.status).toBe("active");
    expect(detailBody.application.txEvidence.some((entry) => entry.kind === "signal_submitter" && entry.status === "materialized" && entry.txHash)).toBe(true);
    expect(detailBody.events.map((event) => event.type)).toContain("activated");
  });

  it("order reads require identity and hide orders assigned to other participants", async () => {
    // 订单 DTO 内嵌全部任务（assigneeWallet/proofRows 等参与者数据）：
    // 与任务读同口径——匿名不可枚举；已指派参与者的订单只有参与者本人
    // 可见（404/列表过滤）。
    const store = new MemoryProjectionStore();
    await seedPlanProjection(store, { withSupplierBinding: true });
    const router = createApiRouter(store, routerOptions());

    // 匿名 → 401。
    await expect(router.handle({ method: "GET", pathname: "/product/orders" }))
      .resolves.toMatchObject({ status: 401, body: { error: "wallet_identity_required" } });
    await expect(router.handle({ method: "GET", pathname: "/product/orders/0x0000000000000000000000000000000000000000000000000000000000000909" }))
      .resolves.toMatchObject({ status: 401, body: { error: "wallet_identity_required" } });

    // 订单出现指派参与者：任务就绪（HookReady）+ 槽位权限上的
    // SignalSubmitterAuthorized（submitter=supplierWallet）。
    const orderId = "0x0000000000000000000000000000000000000000000000000000000000000909" as Hex;
    const permission = demoZhixuDetail.orderPermissionTable.find((entry) => entry.roleSlotId === roleSlotId)
      ?? demoZhixuDetail.orderPermissionTable[0]!;
    await store.resetFromEvents({
      deploymentBlock: 0n,
      events: [
        ...seedOrderWithAuthorizationEvents(orderId, supplierWallet, permission.stageId)
      ]
    });
    const supplierHeaders = { "x-uvp-store-dev-anchored-address": supplierWallet };
    const outsiderHeaders = { "x-uvp-store-dev-anchored-address": outsiderWallet };

    // 参与者本人可见。
    const supplierList = await router.handle({ method: "GET", pathname: "/product/orders", headers: supplierHeaders });
    expect(supplierList.status).toBe(200);
    expect(((supplierList.body as { orders: { orderId: string }[] }).orders)
      .some((order) => order.orderId.toLowerCase() === orderId.toLowerCase())).toBe(true);
    await expect(router.handle({ method: "GET", pathname: `/product/orders/${orderId}`, headers: supplierHeaders }))
      .resolves.toMatchObject({ status: 200 });

    // 无关参与者：列表不含该订单，详情 404（不可区分不存在）。
    const outsiderList = await router.handle({ method: "GET", pathname: "/product/orders", headers: outsiderHeaders });
    expect(outsiderList.status).toBe(200);
    expect(((outsiderList.body as { orders: { orderId: string }[] }).orders)
      .some((order) => order.orderId.toLowerCase() === orderId.toLowerCase())).toBe(false);
    await expect(router.handle({ method: "GET", pathname: `/product/orders/${orderId}`, headers: outsiderHeaders }))
      .resolves.toMatchObject({ status: 404, body: { error: "product_order_not_found" } });
  });

  it("order creators read their own orders without a task assignment", async () => {
    // OrderRelayerRecorded 的 creator 是订单参与者：任务全部指派给他人
    // 时，创建者无任务指派也必须读得到自己建的单（列表/详情/me 视图）。
    const store = new MemoryProjectionStore();
    await seedPlanProjection(store, { withSupplierBinding: true });
    const creatorHeaders = { "x-uvp-store-dev-anchored-address": publisherAddress };
    const orderId = "0x0000000000000000000000000000000000000000000000000000000000000a0a" as Hex;
    const permission = demoZhixuDetail.orderPermissionTable.find((entry) => entry.roleSlotId === roleSlotId)
      ?? demoZhixuDetail.orderPermissionTable[0]!;
    await store.resetFromEvents({
      deploymentBlock: 0n,
      events: [
        ...seedOrderWithAuthorizationEvents(orderId, supplierWallet, permission.stageId),
        chainEvent(6n, 0, "OrderRelayerRecorded", {
          orderId,
          planId,
          relayer: publisherAddress,
          creator: publisherAddress
        })
      ]
    });
    const router = createApiRouter(store, routerOptions());

    const creatorList = await router.handle({ method: "GET", pathname: "/product/orders", headers: creatorHeaders });
    expect(creatorList.status).toBe(200);
    expect(((creatorList.body as { orders: { orderId: string }[] }).orders)
      .some((order) => order.orderId.toLowerCase() === orderId.toLowerCase())).toBe(true);
    await expect(router.handle({ method: "GET", pathname: `/product/orders/${orderId}`, headers: creatorHeaders }))
      .resolves.toMatchObject({ status: 200 });

    const meOrders = await router.handle({ method: "GET", pathname: "/product/me/orders", headers: creatorHeaders });
    expect(meOrders.status).toBe(200);
    expect(((meOrders.body as { orders: { orderId: string }[] }).orders)
      .some((order) => order.orderId.toLowerCase() === orderId.toLowerCase())).toBe(true);

    // 非创建者/非指派的旁观者仍然不可见。
    const outsiderHeaders = { "x-uvp-store-dev-anchored-address": outsiderWallet };
    const outsiderList = await router.handle({ method: "GET", pathname: "/product/orders", headers: outsiderHeaders });
    expect(((outsiderList.body as { orders: { orderId: string }[] }).orders)
      .some((order) => order.orderId.toLowerCase() === orderId.toLowerCase())).toBe(false);
  });

it("revoking an anchored address immediately invalidates sessions for it", async () => {
    const router = await buildRouter();
    const firstToken = await login(router, supplierWallet);

    // firstToken（supplier 账号）把 team 地址锚定到自己的账号；verify 返回
    // 以 team 地址锚定的第二个会话 token（同账号）。
    const anchor = await router.handle({
      method: "POST",
      pathname: "/store/auth/challenge",
      headers: { "x-uvp-store-session": firstToken },
      body: { address: teamDerivedWallet, intent: "anchor_address" }
    });
    const anchorChallenge = (anchor.body as { challenge: { nonce: string; message: string } }).challenge;
    const anchorVerify = await router.handle({
      method: "POST",
      pathname: "/store/auth/verify",
      headers: { "x-uvp-store-session": firstToken },
      body: { nonce: anchorChallenge.nonce, signature: await teamAccount.signMessage({ message: anchorChallenge.message }) }
    });
    expect(anchorVerify.status).toBe(201);
    const teamToken = (anchorVerify.body as { token: string }).token;

    // team 地址此刻有两个可用会话；撤销该地址后两个会话都必须立即失效。
    const beforeRevoke = await router.handle({
      method: "GET",
      pathname: "/store/auth/addresses",
      headers: { "x-uvp-store-session": teamToken }
    });
    expect(beforeRevoke.status).toBe(200);

    const revoke = await router.handle({
      method: "POST",
      pathname: "/store/auth/addresses/revoke",
      headers: { "x-uvp-store-session": firstToken },
      body: { address: teamDerivedWallet }
    });
    expect(revoke.status).toBe(200);

    const teamSessionAfterRevoke = await router.handle({
      method: "GET",
      pathname: "/store/auth/addresses",
      headers: { "x-uvp-store-session": teamToken }
    });
    expect(teamSessionAfterRevoke.status).toBe(401);
  });

  it("publisher (non-operator) can self-import their own plan; join entry is suppressed while delisted", async () => {
    const store = new MemoryProjectionStore();
    await seedPlanProjection(store);
    const router = createApiRouter(store, routerOptions());
    const publisherReadHeaders = {
      "x-uvp-store-user-id": "publisher-only",
      "x-uvp-store-role": "read",
      "x-uvp-store-dev-anchored-address": publisherAddress
    };

    // publisher 自导入（非运营方、无显式 planHash）：投影可查即放行。
    const imported = await router.handle({
      method: "POST",
      pathname: "/store/listings/import",
      headers: publisherReadHeaders,
      body: { planId }
    });
    expect(imported.status).toBe(201);
    const listing = (imported.body as { listing: { listingId: string; status: string; planHashClaimed?: string } });
    expect(listing.listing.planHashClaimed?.toLowerCase()).toBe(planHash.toLowerCase());

    // 非运营方不能审核公开。
    const publishDenied = await router.handle({
      method: "POST",
      pathname: `/store/listings/${listing.listing.listingId}/review`,
      headers: publisherReadHeaders,
      body: { decision: "approve" }
    });
    expect(publishDenied.status).toBe(403);

    // 未公开 listing（imported，上架审核未完成）服务端一律拦截加入——
    // 前端被抑制的入口不得可直调 API 绕过。
    const applicantTokenEarly = await login(router, supplierWallet);
    const joinWhileImported = await router.handle({
      method: "POST",
      pathname: "/store/join-applications",
      headers: { "x-uvp-store-session": applicantTokenEarly },
      body: { planId, roleSlotId, authorizationKind: "signal_submitter" }
    });
    expect(joinWhileImported.status).toBe(409);
    expect(joinWhileImported.body).toMatchObject({ error: "join_entry_suppressed" });

    // 公开 → 下架后加入入口被服务端抑制（红线）。
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

    // 重新上架后恢复可申请。
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
    const store = new MemoryProjectionStore();
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

  it("reviewer without planId scope only sees their own applications", async () => {
    const store = new MemoryProjectionStore();
    await seedPlanProjection(store, { withSupplierBinding: true });
    const router = createApiRouter(store, routerOptions());
    const applicantToken = await login(router, supplierWallet);
    await router.handle({
      method: "POST",
      pathname: "/store/join-applications",
      headers: { "x-uvp-store-session": applicantToken },
      body: { planId, roleSlotId, authorizationKind: "signal_submitter" }
    });

    // publisher（非运营方、无 planId 过滤）只能看到自己的申请（应为空）。
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

    // 申请人（非 reviewer）即便带 planId 也只看到自己的申请。
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

  it("sqlite decoration store round-trips versions (driver-level)", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "store-decoration-sqlite-"));
    try {
      const { SqliteStoreZhixuDecorationStore } = await import("../src/store/decoration/sqlite-store.js");
      const decorations = new SqliteStoreZhixuDecorationStore({
        databaseUrl: `file:${join(dir, "decoration.db")}`,
        migrations: { autoRun: true }
      });
      await decorations.appendVersion({
        decorationId: "decor_sqlite_1",
        planId,
        version: 1,
        data: { schemaVersion: "store-zhixu-decoration.v1", theme: { displayName: "sqlite 版本" } },
        authorAddress: publisherAddress,
        createdAt: "2026-09-03T00:00:00.000Z"
      });
      const versions = await decorations.listVersions(planId);
      expect(versions).toHaveLength(1);
      expect(versions[0]?.version).toBe(1);
      expect(versions[0]?.data.theme?.displayName).toBe("sqlite 版本");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

    // 申请人能看到自己的申请；列表范围收窄到自己。
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
    // 在途查重是"先查后写"：并发双提交会同时通过前置检查。裁决必须
    // 落在存储层（内存驱动同步查判+写入原子；持久驱动在途唯一索引）
    // ——败者 409 application_exists，只留一条在途申请。
    const store = new MemoryProjectionStore();
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
    // "一 plan 一 listing"不能只靠先查后写：并发双导入若都落库，旧条
    // delist 后加入门与详情抑制会按新条放行。存储层唯一裁决 + 败者
    // 409 listing_exists（不是 503 存储故障失真）。
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

describe("store listing and join store uniqueness (sqlite driver)", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("enforces the one-open-application invariant via the partial unique index", async () => {
    const { SqliteStoreJoinApplicationStore, StoreJoinOpenApplicationExistsError } = await import("../src/store/join/index.js");
    const store = new SqliteStoreJoinApplicationStore({
      databaseUrl: sqliteUrl(),
      migrations: { autoRun: true }
    });
    const base = {
      planId,
      roleSlotId,
      authorizationKind: "signal_submitter" as const,
      applicantAddress: supplierWallet,
      applicantSubjectId: `0x${"12".repeat(32)}` as Hex,
      txEvidence: [],
      submittedAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z"
    };

    await store.putApplication({ ...base, applicationId: "join_a", status: "applied" });
    // 并发双提交的败者：同 (plan, applicant) 第二条在途申请被唯一索引拒绝。
    await expect(store.putApplication({ ...base, applicationId: "join_b", status: "applied" }))
      .rejects.toBeInstanceOf(StoreJoinOpenApplicationExistsError);
    // 同一条申请的状态推进不受影响（同 applicationId 的 upsert）。
    await store.putApplication({ ...base, applicationId: "join_a", status: "under_review" });
    await store.putApplication({ ...base, applicationId: "join_a", status: "authorized" });
    // 终态后同一申请人可再次提交新申请（部分索引只约束在途状态）。
    await store.putApplication({ ...base, applicationId: "join_c", status: "applied" });
    store.close();
  });

  it("enforces one listing per plan and maps the race loser to a typed conflict", async () => {
    const { SqliteStoreListingStore, StoreListingPlanConflictError } = await import("../src/store/listings/index.js");
    const store = new SqliteStoreListingStore({
      databaseUrl: sqliteUrl(),
      migrations: { autoRun: true }
    });
    const base = {
      planId,
      status: "imported" as const,
      importedAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z"
    };

    await store.putListing({ ...base, listingId: "listing_a" });
    await expect(store.putListing({ ...base, listingId: "listing_b" }))
      .rejects.toBeInstanceOf(StoreListingPlanConflictError);
    // 同一条 listing 的状态流转（同 listingId upsert）不受约束影响。
    await store.putListing({ ...base, listingId: "listing_a", status: "delisted" });
    expect((await store.findListingByPlanId(planId))?.status).toBe("delisted");
    store.close();
  });

  function sqliteUrl(): string {
    const dir = mkdtempSync(join(tmpdir(), "uvp-store-uniqueness-"));
    tempDirs.push(dir);
    return `sqlite://${join(dir, "store.sqlite")}`;
  }
});

function decorationBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "store-zhixu-decoration.v1",
    theme: { displayName: "跨境结算秩序", description: "展示描述", tags: ["logistics"] },
    taskDeclarations: [
      { stageId: stageIdOfFirstStage, evidenceSpec: [{ key: "invoice", label: "发票", inputKind: "file", required: true }] }
    ],
    ...overrides
  };
}

async function buildRouter(options: { readonly operatorWallets?: readonly Address[]; readonly adminWallets?: readonly Address[] } = {}): Promise<ApiRouter> {
  const store = new MemoryProjectionStore();
  await seedPlanProjection(store);
  return createApiRouter(store, routerOptions(options));
}

function routerOptions(options: { readonly operatorWallets?: readonly Address[]; readonly adminWallets?: readonly Address[] } = {}) {
  return {
    productRuntimeEnvironment: "local" as const,
    productSchemaResolver: crossBorderSchemaResolver(),
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

async function seedPlanProjection(store: MemoryProjectionStore, options: { readonly withSupplierBinding?: boolean } = {}): Promise<void> {
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

/** 与服务端 deriveSubjectForAddress 同式：keccak256("uvp:store:join:subject:v1:" + address)。 */
function derivedJoinSubject(address: Address): Hex {
  return keccak256(stringToBytes(`uvp:store:join:subject:v1:${address.toLowerCase()}`)) as Hex;
}

/** 槽位能力键：roleSlot 的首条 permission (source, signalName) 的链上 id。 */
function slotPermissionKeyForRoleSlot(slotId: string): { readonly sourceId: Hex; readonly signalId: Hex } {
  const entry = demoZhixuDetail.orderPermissionTable.find((permission) => permission.roleSlotId === slotId)
    ?? demoZhixuDetail.orderPermissionTable[0]!;
  return {
    sourceId: keccak256(stringToBytes(entry.source)) as Hex,
    signalId: keccak256(stringToBytes(entry.signalName)) as Hex
  };
}

async function seedOrderWithAuthorization(store: MemoryProjectionStore, submitter: Address): Promise<void> {
  const orderId = "0x0000000000000000000000000000000000000000000000000000000000000909" as Hex;
  await store.resetFromEvents({
    deploymentBlock: 0n,
    events: seedOrderWithAuthorizationEvents(orderId, submitter)
  });
}

/** 订单 + 槽位权限授权 + 任务就绪（任务由此携带 submitter 的 assigneeWallet）。 */
function seedOrderWithAuthorizationEvents(orderId: Hex, submitter: Address, hookStageId?: string): readonly ChainEvent[] {
  const permissionStageId = hookStageId
    ?? (demoZhixuDetail.orderPermissionTable.find((entry) => entry.roleSlotId === roleSlotId)
      ?? demoZhixuDetail.orderPermissionTable[0]!).stageId;
  return [
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
    // 授权事件的 (sourceId, signalId) 必须落在
    // 申请槽位的 orderPermissionTable 能力集合内——激活判定不再接受
    // "同 plan 任意信号"。
    chainEvent(4n, 0, "SignalSubmitterAuthorized", {
      orderId,
      ...slotPermissionKeyForRoleSlot(roleSlotId),
      submitter,
      role: `0x${"33".repeat(32)}`,
      metadataHash: `0x${"44".repeat(32)}`
    }),
    // 任务就绪（capability 解析按 stage 匹配槽位权限 → assigneeWallet）。
    // stageId 以 utf8 填充 bytes32 播种（decodedStageId 可还原显示名）。
    chainEvent(5n, 0, "HookReady", {
      orderId,
      hookId: `0x${"cc".repeat(32)}`,
      stageId: bytes32Text(permissionStageId),
      hookName: bytes32Text("confirm_stage")
    })
  ];
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
    const { createStoreSessionService, InMemoryStoreWalletSessionStore, StoreSessionServiceError } =
      await import("../src/store/sessions/index.js");
    let current = new Date("2026-04-28T00:00:00Z");
    const store = new InMemoryStoreWalletSessionStore();
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

    // 单地址同时存活的挑战有上界：第 11 个 429。
    for (let index = 0; index < 10; index += 1) {
      await expect(service.createChallenge({ address: supplierWallet })).resolves.toBeDefined();
    }
    const limited = service.createChallenge({ address: supplierWallet });
    await expect(limited).rejects.toMatchObject({
      status: 429,
      code: "store_challenge_rate_limited"
    });
    await expect(limited).rejects.toBeInstanceOf(StoreSessionServiceError);

    // 配额按地址计：别的地址不受该地址囤积影响。
    await expect(service.createChallenge({ address: outsiderWallet })).resolves.toBeDefined();

    // 过期挑战在写入时被清扫：TTL 过后配额自动释放。
    current = new Date(current.getTime() + 301_000);
    await expect(service.createChallenge({ address: supplierWallet })).resolves.toBeDefined();
  });

  it("caps a single requester across all addresses (anonymous targeted lockout bound)", async () => {
    // challenge 入口匿名且 address 自报：若无请求方维度配额，一个请求方
    // 连发 10 次即可锁死任意受害地址并按 TTL 续期。请求方桶把单个
    // 请求方可占用的总囤积量压到 30——换地址绕过地址配额不再可行。
    const { createStoreSessionService, StoreSessionServiceError } =
      await import("../src/store/sessions/index.js");
    const current = new Date(Date.UTC(2026, 8, 10, 0, 0, 0));
    const service = createStoreSessionService({
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
    // 每个地址只被签发过 1 次（远未触地址配额），但请求方桶已满：429。
    await expect(
      service.createChallenge({ address: `0x${"7".repeat(40)}` as Address }, undefined, requester)
    ).rejects.toMatchObject({ status: 429, code: "store_challenge_rate_limited" });
    await expect(
      service.createChallenge({ address: `0x${"8".repeat(40)}` as Address }, undefined, requester)
    ).rejects.toBeInstanceOf(StoreSessionServiceError);
    // 别的请求方不受该请求方囤积影响。
    await expect(
      service.createChallenge({ address: `0x${"7".repeat(40)}` as Address }, undefined, { clientAddress: "198.51.100.9" })
    ).resolves.toBeDefined();
  });

  it("keeps a hard cap on the in-memory challenge table", async () => {
    const { InMemoryStoreWalletSessionStore, MEMORY_CHALLENGE_HARD_LIMIT } =
      await import("../src/store/sessions/index.js");
    const store = new InMemoryStoreWalletSessionStore();
    const challengeAt = (index: number, expiresAt: string): StoreAuthChallengeRecord => ({
      nonce: `nonce${index.toString().padStart(6, "0")}`,
      address: `0x${(index % 100).toString(16).padStart(40, "0")}` as Address,
      requesterKey: "test-requester",
      intent: "login",
      message: "m",
      issuedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + index * 1000).toISOString(),
      expiresAt
    });

    // 到达硬上限时先清过期行：最早过期的挑战被清扫而不是顶掉最新行。
    // 配额给到不可达值——本用例专测硬上限淘汰，不与每地址/每请求方配额
    // 耦合（记录按 index%100 轮换地址，同请求方多条会先撞请求方配额）。
    const put = (record: StoreAuthChallengeRecord): Promise<boolean> =>
      store.putChallengeWithinAddressQuota(record, {
        maxLivePerAddress: Number.MAX_SAFE_INTEGER,
        maxLivePerRequester: Number.MAX_SAFE_INTEGER,
        now: "2101-01-01T00:00:00Z"
      });
    await put(challengeAt(0, "2026-01-01T00:00:00Z"));
    for (let index = 1; index < MEMORY_CHALLENGE_HARD_LIMIT; index += 1) {
      await put(challengeAt(index, "2100-01-01T00:00:00Z"));
    }
    await put(challengeAt(MEMORY_CHALLENGE_HARD_LIMIT, "2100-01-01T00:00:00Z"));
    await expect(store.getChallenge("nonce000000")).resolves.toBeUndefined();
    await expect(store.getChallenge(`nonce${MEMORY_CHALLENGE_HARD_LIMIT.toString().padStart(6, "0")}`)).resolves.toBeDefined();

    // 全部存活仍超上限：按签发序淘汰最旧行——内存不随未鉴权写入无界增长。
    await put(challengeAt(MEMORY_CHALLENGE_HARD_LIMIT + 1, "2100-01-01T00:00:00Z"));
    await expect(store.getChallenge("nonce000001")).resolves.toBeUndefined();
    await expect(store.getChallenge(`nonce${(MEMORY_CHALLENGE_HARD_LIMIT + 1).toString().padStart(6, "0")}`)).resolves.toBeDefined();
  });

  it("holds the per-address challenge quota under concurrent creation", async () => {
    // 配额判定与写入必须原子：同地址并发签发风暴不允许整体穿透
    //（32 个并发请求在"先数后写"实现下会全部读到同一旧计数）。
    const { InMemoryStoreWalletSessionStore, StoreSessionServiceError, createStoreSessionService } =
      await import("../src/store/sessions/index.js");
    const store = new InMemoryStoreWalletSessionStore();
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
