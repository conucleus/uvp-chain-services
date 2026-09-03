import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { keccak256, stringToBytes } from "viem";
import { CROSS_BORDER_ZHIXU_ID, crossBorderPlanIds, demoZhixuDetail } from "@uvp-eth/product-dto/fixtures";
import { createApiRouter } from "../src/api/routes.js";
import type { ChainEvent } from "../src/indexer/events.js";
import { MemoryProjectionStore } from "../src/storage/projection-store.js";
import type { ApiRouter } from "../src/api/route-context.js";
import type { Address, Hex } from "../src/shared/types.js";
import { crossBorderSchemaResolver } from "./cross-border-schema.js";

/**
 * PRD89-92：Store 身份与会话、加入闭环、装修权限、上架与锚核验的后端验收。
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
  "x-uvp-admin-role": "governance_admin"
};
const storeOperatorHeaders = {
  "x-uvp-store-user-id": "store-operator-1",
  "x-uvp-store-role": "operator"
};
const publisherAnchoredHeaders = {
  ...storeOperatorHeaders,
  "x-uvp-store-dev-anchored-address": publisherAddress
};

const roleSlotId = demoZhixuDetail.roleSlots[0]?.slotId ?? "supplier";
const stageIdOfFirstStage = demoZhixuDetail.stages[0]?.stageId ?? "stage-1";

describe("PRD89-92 store access domains", () => {
  it("PRD89: wallet challenge → personal_sign verify → session with anchored address", async () => {
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

  it("PRD89: operator wallet list grants operator capabilities to anchored sessions", async () => {
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

  it("PRD89: anchoring an additional address links it to the same account; revocation removes it", async () => {
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

  it("PRD89: descriptor snapshots are append-only and verifiable via descriptorHash", async () => {
    const router = await buildRouter();
    const subjectId = "0x0000000000000000000000000000000000000000000000000000000000007777" as Hex;

    // 准备审核记录 → 身份注册（模拟广播）。
    await router.handle({
      method: "POST",
      pathname: "/store/suppliers",
      headers: governanceAdminHeaders,
      body: { supplierSubjectId: subjectId, displayName: "测试供应商", wallet: supplierWallet }
    });
    const suppliers = await router.handle({ method: "GET", pathname: "/store/suppliers" });
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

  it("PRD91: only the plan publisher (or an active delegate) can save decoration data", async () => {
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

  it("PRD92: listing import → anchor verification → review publish → delist hides catalog", async () => {
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

    const detailAfter = await router.handle({
      method: "GET",
      pathname: `/store/zhixus/${CROSS_BORDER_ZHIXU_ID}`
    });
    expect(detailAfter.status).toBe(200);
    expect((detailAfter.body as { storeOverlay?: { listing?: { status: string } } }).storeOverlay?.listing?.status).toBe("delisted");

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

  it("PRD92: conflicted anchors block publication (mismatched planHash claim)", async () => {
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

  it("PRD90: join loop applied → under_review → authorized (identity pairing tx evidence)", async () => {
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
    const suppliers = await router.handle({ method: "GET", pathname: "/store/suppliers" });
    const createdSupplier = (suppliers.body as { suppliers: { wallet?: string; reviewStatus: string; identityStatus: string }[] }).suppliers
      .find((supplier) => supplier.wallet?.toLowerCase() === supplierWallet.toLowerCase());
    expect(createdSupplier).toMatchObject({ reviewStatus: "approved_for_broadcast", identityStatus: "active" });
  });

  it("PRD90: on-chain authorization event materializes the application to active", async () => {
    const store = new MemoryProjectionStore();
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

it("PRD89: revoking an anchored address immediately invalidates sessions for it", async () => {
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

  it("PRD92: publisher (non-operator) can self-import their own plan; join entry is suppressed while delisted", async () => {
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

  it("PRD92: configured chain read failure blocks publication (fail-closed)", async () => {
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
    expect(verification.status).toBe(200);
    expect((verification.body as { anchorVerification: { chainReadFailed?: boolean } }).anchorVerification.chainReadFailed).toBe(true);
    const publish = await router.handle({
      method: "POST",
      pathname: `/store/listings/${listing.listing.listingId}/review`,
      headers: storeOperatorHeaders,
      body: { decision: "approve" }
    });
    expect(publish.status).toBe(409);
    expect(publish.body).toMatchObject({ error: "anchor_verification_failed" });
  });

  it("PRD90: reviewer without planId scope only sees their own applications", async () => {
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

  it("PRD91: sqlite decoration store round-trips versions (driver-level)", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "store-decoration-sqlite-"));
    try {
      const { SqliteStoreZhixuDecorationStore } = await import("../src/store-decoration/sqlite-store.js");
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

  it("PRD90: reject leaves an audited trail with reason and reviewer session", async () => {
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

async function buildRouter(options: { readonly operatorWallets?: readonly Address[] } = {}): Promise<ApiRouter> {
  const store = new MemoryProjectionStore();
  await seedPlanProjection(store);
  return createApiRouter(store, routerOptions(options));
}

function routerOptions(options: { readonly operatorWallets?: readonly Address[] } = {}) {
  return {
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
        adminWallets: [],
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

async function seedOrderWithAuthorization(store: MemoryProjectionStore, submitter: Address): Promise<void> {
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
        sourceId: `0x${"11".repeat(32)}`,
        signalId: `0x${"22".repeat(32)}`,
        submitter,
        role: `0x${"33".repeat(32)}`,
        metadataHash: `0x${"44".repeat(32)}`
      })
    ]
  });
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
