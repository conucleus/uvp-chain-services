import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { keccak256, stringToBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { StoreProductSchemaDTO } from "@uvp-eth/product-dto";
import {
  CROSS_BORDER_ZHIXU_ID,
  customsOnchainHookPlanArtifact,
  customsPlanIds,
  crossBorderPlanIds,
  demoZhixuDetail
} from "@uvp-eth/product-dto/fixtures";
import { createApiRouter, type ApiRouter } from "../src/api/routes.js";
import { loadConfigFromEnv } from "../src/config/env.js";
import { adminPrincipalFromHeaders, createGovernanceService } from "../src/governance/index.js";
import { SqliteGovernanceStore } from "../src/governance/sqlite-store.js";
import { hashIdentityDescriptor } from "../src/governance/hashing.js";
import type { ChainEvent } from "../src/indexer/events.js";
import {
  BackupEvidenceStorage,
  InMemoryEvidenceStorage,
  ObjectEvidenceStorage
} from "../src/evidence/index.js";
import { verifyProofBundle } from "../src/proof-verifier/service.js";
import { createProductService } from "../src/product/service.js";
import {
  InMemoryStoreZhixuDecorationStore,
  InMemoryStorePublisherDelegationStore
} from "../src/store-decoration/memory-store.js";
import {
  MemoryStoreZhixuVersionMetadataStore,
  createStoreZhixuVersionService
} from "../src/store-console/version.js";
import { InMemoryStoreWalletSessionStore, createStoreSessionService } from "../src/store-sessions/index.js";
import { MemoryProjectionStore } from "../src/storage/projection-store.js";
import { openSqliteDatabase } from "../src/storage/sqlite.js";
import { runSqliteMigrations } from "../src/storage/migrations.js";
import { crossBorderSchemaResolver } from "./cross-border-schema.js";
import type { Address, Hex } from "../src/shared/types.js";

const contractAddress = "0x1111111111111111111111111111111111111111" as Address;
const publisherAddress = "0xaaaa000000000000000000000000000000000001" as Address;
const supplierWalletKey = "0x1111111111111111111111111111111111111111111111111111111111111111";
const supplierAccount = privateKeyToAccount(supplierWalletKey);
const supplierWallet = supplierAccount.address as Address;
const rivalWallet = "0xcccc000000000000000000000000000000000003" as Address;
const planId = crossBorderPlanIds.planId as Hex;
const planHash = crossBorderPlanIds.planHash as Hex;
const roleSlotId = demoZhixuDetail.roleSlots[0]?.slotId ?? "supplier";
const adminHeaders = { "x-uvp-admin-id": "governance-admin-1", "x-uvp-admin-role": "governance_admin" };
const storeAdminHeaders = { "x-uvp-store-user-id": "store-admin-1", "x-uvp-store-role": "admin" };
const publisherAnchoredHeaders = {
  ...storeAdminHeaders,
  "x-uvp-store-dev-anchored-address": publisherAddress
};

describe("audit round 3 path-5 fixes", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("cluster C: authentication fail-closed", () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
      process.env.CHAIN_SERVICES_RUNTIME_ENV = originalEnv.CHAIN_SERVICES_RUNTIME_ENV;
      process.env.GOVERNANCE_ADMIN_REVIEWER_IDS = originalEnv.GOVERNANCE_ADMIN_REVIEWER_IDS;
    });

    it("rejects self-reported governance admin headers outside local when the whitelist is empty", () => {
      delete process.env.GOVERNANCE_ADMIN_REVIEWER_IDS;
      process.env.CHAIN_SERVICES_RUNTIME_ENV = "testnet";
      // 空白名单 + 非 local：自报 admin 头 fail-closed。
      expect(adminPrincipalFromHeaders({
        "x-uvp-admin-id": "attacker",
        "x-uvp-admin-role": "governance_admin"
      })).toBeUndefined();
      // 白名单非空：命中放行、未命中拒绝。
      process.env.GOVERNANCE_ADMIN_REVIEWER_IDS = "gov-reviewer-1";
      expect(adminPrincipalFromHeaders({
        "x-uvp-admin-id": "gov-reviewer-1",
        "x-uvp-admin-role": "governance_admin"
      })).toMatchObject({ adminId: "gov-reviewer-1" });
      expect(adminPrincipalFromHeaders({
        "x-uvp-admin-id": "attacker",
        "x-uvp-admin-role": "governance_admin"
      })).toBeUndefined();
      // local 保持自报（dev 便利）。
      process.env.CHAIN_SERVICES_RUNTIME_ENV = "local";
      delete process.env.GOVERNANCE_ADMIN_REVIEWER_IDS;
      expect(adminPrincipalFromHeaders({
        "x-uvp-admin-id": "dev-admin",
        "x-uvp-admin-role": "governance_admin"
      })).toMatchObject({ adminId: "dev-admin" });
    });

    it("rejects testnet config without admin whitelists or an explicit auth mode", () => {
      const databaseUrl = "postgres://uvp:secret@testnet-db.internal:5432/uvp";
      const base = {
        CHAIN_SERVICES_RUNTIME_ENV: "testnet",
        CHAIN_SERVICES_DATABASE_DRIVER: "postgres",
        CHAIN_SERVICES_DATABASE_URL: databaseUrl,
        CHAIN_SERVICES_MIGRATIONS_AUTO_RUN: "true",
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
        UVP_EVIDENCE_STORAGE_ADAPTER: "rehearsal-object"
      };
      // STORE_AUTH_MODE 缺省（此前静默 dev_headers）→ 启动失败。
      expect(() => loadConfigFromEnv(base)).toThrow(/STORE_AUTH_MODE/);
      // 显式 dev_headers 在 testnet 同样拒绝。
      expect(() => loadConfigFromEnv({ ...base, STORE_AUTH_MODE: "dev_headers" }))
        .toThrow(/dev_headers is only allowed in local/);
      // dev 锚定地址头在 testnet 缺省关闭。
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
      })).not.toThrow();
      expect(loadConfigFromEnv({
        ...withWhitelists,
        OPS_CONSOLE_ADMIN_IDS: "ops-admin-1"
      }).storeAuth?.walletSession?.devAnchoredAddressHeaderEnabled).toBe(false);
    });

    it("requires an explicit non-local RPC in production", () => {
      const base = {
        CHAIN_SERVICES_RUNTIME_ENV: "production",
        CHAIN_SERVICES_DATABASE_DRIVER: "postgres",
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
        OPS_CONSOLE_ADMIN_IDS: "ops-admin-1"
      };
      // 无 UVP_RPC_URL：不再静默回落 127.0.0.1:8545。
      expect(() => loadConfigFromEnv(base)).toThrow(/UVP_RPC_URL is required in production/);
      expect(() => loadConfigFromEnv({ ...base, UVP_RPC_URL: "http://127.0.0.1:8545" }))
        .toThrow(/non-local RPC/);
      expect(() => loadConfigFromEnv({ ...base, UVP_RPC_URL: "https://base-mainnet.example/rpc" }))
        .not.toThrow();
      // 空白名单在 production 同样拦截。
      expect(() => loadConfigFromEnv({
        ...base,
        UVP_RPC_URL: "https://base-mainnet.example/rpc",
        GOVERNANCE_ADMIN_REVIEWER_IDS: ""
      })).toThrow(/GOVERNANCE_ADMIN_REVIEWER_IDS is required in production/);
    });
  });

  describe("cluster C: activity-feed identity", () => {
    it("requires a wallet session outside local and enforces the claimed wallet", async () => {
      const store = new MemoryProjectionStore();
      await seedPlan(store);
      const router = createApiRouter(store, {
        productSchemaResolver: crossBorderSchemaResolver(),
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
      // 无会话（自报 query/header 钱包不再是身份）→ 401。
      const anonymous = await router.handle({
        method: "GET",
        pathname: "/product/me/activity-feed",
        query: { wallet: supplierWallet }
      });
      expect(anonymous).toMatchObject({ status: 401, body: { error: "wallet_identity_required" } });

      // 会话锚定后可读；声称他人钱包 → 403。
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

  describe("cluster D: invite token", () => {
    it("rejects invite accept/reject without the one-time token", async () => {
      const store = new MemoryProjectionStore();
      await seedPlan(store);
      const router = createApiRouter(store, {
        productSchemaResolver: crossBorderSchemaResolver(),
        submissionChainId: 31337,
        submissionVerifyingContract: contractAddress
      });
      const draft = await createDraft(router);
      const invite = await router.handle({
        method: "POST",
        pathname: `/product/orders/${draft.draftId}/invites`,
        body: { roleSlotId: "funds", contact: "funds@example.com" }
      });
      expect(invite.status).toBe(201);
      const inviteId = (invite.body as { invite: { inviteId: string } }).invite.inviteId;
      const inviteToken = (invite.body as { inviteToken?: string }).inviteToken;
      // token 存在且未泄露 tokenHash。
      expect(typeof inviteToken).toBe("string");
      expect(invite.body).not.toHaveProperty(["invite", "tokenHash"]);

      const missing = await router.handle({
        method: "POST",
        pathname: `/product/invites/${inviteId}/accept`,
        headers: { "x-uvp-wallet-address": supplierWallet },
        body: {
          displayName: "Funds",
          walletAddress: supplierWallet,
          contact: "funds@example.com"
        }
      });
      expect(missing).toMatchObject({ status: 400, body: { error: "invalid_body" } });

      const wrong = await router.handle({
        method: "POST",
        pathname: `/product/invites/${inviteId}/accept`,
        headers: { "x-uvp-wallet-address": supplierWallet },
        body: {
          displayName: "Funds",
          walletAddress: supplierWallet,
          contact: "funds@example.com",
          token: "not-the-token"
        }
      });
      expect(wrong).toMatchObject({ status: 403, body: { error: "invite_token_mismatch" } });

      const accepted = await router.handle({
        method: "POST",
        pathname: `/product/invites/${inviteId}/accept`,
        headers: { "x-uvp-wallet-address": supplierWallet },
        body: {
          displayName: "Funds",
          walletAddress: supplierWallet,
          contact: "funds@example.com",
          token: inviteToken
        }
      });
      expect(accepted.status).toBe(200);

      // 已接受的 invite 再拒绝也要求 token（哈希比对）。
      const rejectWithoutToken = await router.handle({
        method: "POST",
        pathname: `/product/invites/${inviteId}/reject`,
        body: { token: "wrong" }
      });
      expect(rejectWithoutToken.status).toBe(409);
    });
  });

  describe("cluster D: join loop", () => {
    it("blocks approval when the subject is actively bound to another account (409)", async () => {
      const store = new MemoryProjectionStore();
      // rival 账号占用同一 subject（subjectId→account 方向冲突）。
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
      const store = new MemoryProjectionStore();
      // 无 active binding：审批需要触发 registerIdentity。
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
      // publisher 审批（无 governance_admin 角色）→ 登记 403，申请留审。
      const approved = await router.handle({
        method: "POST",
        pathname: `/store/join-applications/${applicationId}/approve`,
        headers: publisherAnchoredHeaders,
        body: {}
      });
      expect(approved).toMatchObject({ status: 403, body: { error: "governance_admin_required" } });
    });

    it("does not materialize activation from a signal outside the applied-for slot", async () => {
      const store = new MemoryProjectionStore();
      await seedPlan(store, { withSupplierBinding: true });
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
      expect((approved.body as { application: { status: string } }).application.status).toBe("authorized");

      // 其他槽位的信号授权（submitter 相同、(source, signal) 不在槽位能力集）→ 不激活。
      await seedOrderWithAuthorization(store, supplierWallet, {
        sourceId: keccak256(stringToBytes("unrelated-source")) as Hex,
        signalId: keccak256(stringToBytes("unrelated-signal")) as Hex
      });
      const detail = await router.handle({
        method: "GET",
        pathname: `/store/join-applications/${applicationId}`,
        headers: { "x-uvp-store-session": session }
      });
      expect((detail.body as { application: { status: string } }).application.status).toBe("authorized");
    });
  });

  describe("cluster D: version activate", () => {
    it("rejects re-anchoring an existing version and unprojected new anchors", async () => {
      const store = new MemoryProjectionStore();
      await seedPlan(store);
      const productService = createProductService(store, { productSchemaResolver: crossBorderSchemaResolver() });
      const metadataStore = new MemoryStoreZhixuVersionMetadataStore();
      const versionService = createStoreZhixuVersionService({
        productService,
        projectionStore: store,
        metadataStore
      });
      const versions = await versionService.listVersions(CROSS_BORDER_ZHIXU_ID);
      const versionId = versions.versions[0]?.versionId;
      expect(versionId).toBeDefined();
      const activated = await versionService.activate(CROSS_BORDER_ZHIXU_ID, versionId!, {});
      expect(activated.version.status).toBe("active");

      // 改锚（planId 换成另一个 plan）→ 409。
      await expect(versionService.activate(CROSS_BORDER_ZHIXU_ID, versionId!, {
        planId: "0x0000000000000000000000000000000000000000000000000000000000000fff"
      })).rejects.toMatchObject({ code: "version_anchor_immutable" });

      // 凭空登记未投影 plan 的新版本 → 409。
      await expect(versionService.activate(CROSS_BORDER_ZHIXU_ID, "version-fresh", {
        planId: "0x0000000000000000000000000000000000000000000000000000000000000abc",
        planHash: "0x0000000000000000000000000000000000000000000000000000000000000def"
      })).rejects.toMatchObject({ code: "plan_not_projected" });
    });
  });

  describe("cluster N: governance stores and hashing", () => {
    it("putReview does not overwrite created_at on conflict (sqlite)", async () => {
      const dir = mkdtempSync(join(tmpdir(), "uvp-audit3-governance-"));
      tempDirs.push(dir);
      const database = openSqliteDatabase(join(dir, "governance.db"));
      runSqliteMigrations({ database, migrationsDirectory: migrationsDirectory() });
      const governanceStore = new SqliteGovernanceStore({ database });
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
      // 调用方误传新 createdAt：库内 created_at 必须保持初值。
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
        adapter: {
          registerIdentity: async () => ({ status: "simulated_tx", retryable: false, simulated: true }),
          revokeIdentity: async () => ({ status: "simulated_tx", retryable: false, simulated: true })
        }
      });
      // 带 metadata/policy 的 review：registerIdentity 的 descriptor 哈希材料
      // 必须包含原文（此前按 null 重建，两处口径分叉）。
      await service.reviewSupplier({
        subjectId,
        status: "approved_for_broadcast",
        metadata: { supplierId: "s-1", wallet: account },
        policy: { workflow: "store_supplier_review" }
      }, admin);
      const registered = await service.registerIdentity({ subjectId, account }, admin);
      const descriptorHashWithDocuments = registered.request.descriptorHash;
      expect(descriptorHashWithDocuments).toMatch(/^0x[0-9a-f]{64}$/);
      // 对照：无 metadata/policy 的 subject 得到不同 descriptor 哈希——
      // 材料原文确实参与哈希。
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
        adapter: {
          registerIdentity: async () => ({ status: "simulated_tx", retryable: false, simulated: true }),
          revokeIdentity: async () => {
            if (failRevoke) {
              return { status: "failed", errorCode: "adapter_down", retryable: true, simulated: false };
            }
            return { status: "simulated_tx", retryable: false, simulated: true };
          }
        }
      });
      await service.reviewSupplier({ subjectId, status: "approved_for_broadcast" }, admin);
      failRevoke = true;
      const revoked = await service.revokeIdentity({ subjectId, bindingId }, admin);
      expect(revoked.broadcast.status).toBe("failed");
      // 广播失败：review 不得停留在 revoked（前置状态回退）。
      const reviews = await service.listReviews({ subjectType: "supplier", subjectId });
      expect(reviews[0]?.status).toBe("approved_for_broadcast");
      // 广播恢复成功后：review 落 revoked。
      failRevoke = false;
      const retried = await service.revokeIdentity({ subjectId, bindingId }, admin);
      expect(retried.broadcast.status).toBe("simulated_tx");
      const finalReviews = await service.listReviews({ subjectType: "supplier", subjectId });
      expect(finalReviews[0]?.status).toBe("revoked");
    });

    it("descriptor hash covers profile/capability/reputation", () => {
      const base = {
        subjectId: "0x" + "11".repeat(32) as Hex,
        account: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        metadata: { supplierId: "s1" }
      };
      const first = hashIdentityDescriptor(base);
      // 替换 profile/capability/reputation 任一主体 → descriptorHash 变化。
      expect(hashIdentityDescriptor({ ...base, profile: { displayName: "A" } })).not.toBe(first);
      expect(hashIdentityDescriptor({ ...base, capability: { tags: ["t"] } })).not.toBe(first);
      expect(hashIdentityDescriptor({ ...base, reputation: { score: 5 } })).not.toBe(first);
      // 相同材料 → 稳定哈希。
      expect(hashIdentityDescriptor({ ...base, profile: { displayName: "A" } }))
        .toBe(hashIdentityDescriptor({ ...base, profile: { displayName: "A" } }));
    });
  });

  describe("cluster N: decoration memory store alignment", () => {
    it("rejects duplicate (planId, version) appends like the sqlite unique constraint", async () => {
      const decorationStore = new InMemoryStoreZhixuDecorationStore();
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
      const delegationStore = new InMemoryStorePublisherDelegationStore();
      await delegationStore.appendDelegation({
        delegationId: "dlg_1",
        publisherAddress: publisherAddress,
        memberAddress: supplierWallet,
        grantedByAddress: publisherAddress,
        grantedAt: "2026-01-01T00:00:00.000Z"
      });
      // 同 delegationId 再写：只更新撤销字段，publisher/member 不可被改写。
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

  describe("cluster N: sessions challenge consume", () => {
    it("consumes a challenge exactly once (conditional update)", async () => {
      const store = new InMemoryStoreWalletSessionStore();
      const service = createStoreSessionService({
        store,
        verifyWalletMessage: async () => true
      });
      const challenge = await service.createChallenge({ address: supplierWallet });
      const first = await service.verify({ nonce: challenge.nonce, signature: "0x" + "ab".repeat(32) });
      expect(first.token).toMatch(/^uvs_/);
      // 重放同一 nonce：条件占位失败（此前读-判-写竞态会双通过）。
      await expect(service.verify({ nonce: challenge.nonce, signature: "0x" + "ab".repeat(32) }))
        .rejects.toMatchObject({ code: "store_challenge_invalid" });
    });
  });

  describe("cluster N: proof verifier", () => {
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
      // 单侧缺失按 mismatch 记。
      const oneSided = verifyProofBundle({ metadataHash: { expected: matched } });
      expect(oneSided.valid).toBe(false);
      expect(oneSided.checks.find((check) => check.name === "metadataHash")?.status).toBe("mismatch");
    });
  });

  describe("cluster N: evidence backup wiring", () => {
    it("translates URIs between primary and backup spaces for verify/restore", async () => {
      // 主存储 s3://primary-bucket/prefix/...，备份 s3://backup-bucket/...——
      // 两边 URI 字符串不同，直传主 URI 会抛 "not managed by"。
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

      // 主副本损坏后：verify 定位到备份对象、restore 写回主存储。
      objects.delete(put.storageURI);
      const verified = await storage.verifyBackup(put.storageURI, "0x" + "aa".repeat(32));
      expect(verified).toEqual({ backupPresent: true, hashMatches: false });
      expect(await storage.restoreFromBackup(put.storageURI, "ev_audit3", "0x" + "aa".repeat(32))).toBe(false);
    });

    it("exposes admin-gated backup verify/restore endpoints", async () => {
      const store = new MemoryProjectionStore();
      await seedPlan(store);
      const primary = new InMemoryEvidenceStorage();
      const backup = new InMemoryEvidenceStorage();
      const router = createApiRouter(store, {
        productSchemaResolver: crossBorderSchemaResolver(),
        submissionChainId: 31337,
        submissionVerifyingContract: contractAddress,
        evidenceStorage: new BackupEvidenceStorage({ primary, backup })
      });
      const upload = await router.handle({
        method: "POST",
        pathname: "/product/evidence",
        headers: { "x-uvp-principal-id": "seller" },
        body: {
          orderId: "order-1",
          stageIdentifier: "export-documents",
          documentType: "invoice",
          textPayload: "audit3 backup payload"
        }
      });
      expect(upload.status).toBe(201);
      const evidenceId = (upload.body as { evidence: { evidenceId: string } }).evidence.evidenceId;
      const contentHash = (upload.body as { evidence: { contentHash: string } }).evidence.contentHash;

      // owner（非 admin）读自己的备份状态：verify 端点允许 reader 读。
      const ownerVerify = await router.handle({
        method: "POST",
        pathname: `/product/evidence/${evidenceId}/backup-verify`,
        headers: { "x-uvp-principal-id": "seller" }
      });
      expect(ownerVerify.status).toBe(200);
      expect(ownerVerify.body).toMatchObject({
        backup: { backupConfigured: true, backupPresent: true, hashMatches: true }
      });

      const restore = await router.handle({
        method: "POST",
        pathname: `/product/evidence/${evidenceId}/backup-restore`,
        headers: { "x-uvp-principal-id": "seller" }
      });
      expect(restore.status).toBe(200);
      expect(restore.body).toMatchObject({
        backup: { restored: true, hashMatches: true }
      });

      // 无身份 → 401。
      const anonymous = await router.handle({
        method: "POST",
        pathname: `/product/evidence/${evidenceId}/backup-verify`
      });
      expect(anonymous.status).toBe(401);
      expect(contentHash).toMatch(/^0x[0-9a-f]{64}$/);
    });
  });

  describe("cluster N: store read surfaces", () => {
    it("requires store.read for /store/suppliers reads", async () => {
      const store = new MemoryProjectionStore();
      await seedPlan(store);
      const router = createApiRouter(store, {
        productSchemaResolver: crossBorderSchemaResolver(),
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
      const store = new MemoryProjectionStore();
      await seedPlan(store);
      const router = createApiRouter(store, {
        productSchemaResolver: crossBorderSchemaResolver(),
        submissionChainId: 31337,
        submissionVerifyingContract: contractAddress
      });
      // 上架后下架同一 plan。
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

      const zhixuIdQuery = CROSS_BORDER_ZHIXU_ID;
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
      const store = new MemoryProjectionStore();
      await seedPlan(store);
      const router = createApiRouter(store, {
        productSchemaResolver: crossBorderSchemaResolver(),
        submissionChainId: 31337,
        submissionVerifyingContract: contractAddress
      });
      // 死词 "disputed" 已从词表移除：400 而不是静默空集。
      const disputed = await router.handle({
        method: "GET",
        pathname: `/store/zhixus/${CROSS_BORDER_ZHIXU_ID}/orders`,
        query: { status: "disputed" }
      });
      expect(disputed).toMatchObject({ status: 400, body: { error: "invalid_query" } });
      const registered = await router.handle({
        method: "GET",
        pathname: `/store/zhixus/${CROSS_BORDER_ZHIXU_ID}/orders`,
        query: { status: "registered" }
      });
      expect(registered.status).toBe(200);
    });
  });

  describe("cluster N: product schema guards", () => {
    it("rejects malformed roleSlots, covers onchainHookPlanArtifact in the hash, and blocks edits of published plans", async () => {
      const store = new MemoryProjectionStore();
      // 投影里放入 customs plan（draft 将编译到同一 planId）。
      await store.resetFromEvents({
        deploymentBlock: 0n,
        events: [
          chainEvent(1n, 0, "PlanRegistered", {
            planId: customsPlanIds.planId,
            planHash: customsPlanIds.planHash,
            hookCount: 2n
          }),
          chainEvent(1n, 1, "PlanPublisherRecorded", { planId: customsPlanIds.planId, publisher: publisherAddress })
        ]
      });
      const router = createApiRouter(store, {
        productSchemaResolver: crossBorderSchemaResolver(),
        submissionChainId: 31337,
        submissionVerifyingContract: contractAddress
      });
      const operatorHeaders = { "x-uvp-store-user-id": "operator-1", "x-uvp-store-role": "operator" };
      const importResponse = await router.handle({
        method: "POST",
        pathname: "/store/zhixu-drafts/import",
        headers: operatorHeaders,
        body: { sourceKind: "onchain_hook_plan_manifest", content: JSON.stringify(customsOnchainHookPlanArtifact) }
      });
      expect(importResponse.status).toBe(201);
      const draftId = (importResponse.body as { draft: { draftId: string } }).draft.draftId;
      const compiled = await router.handle({
        method: "POST",
        pathname: `/store/zhixu-drafts/${draftId}/compile-preview`,
        headers: operatorHeaders
      });
      expect(compiled.status).toBe(200);
      const schema = (compiled.body as { draft: { productSchema?: StoreProductSchemaDTO } }).draft.productSchema;
      expect(schema).toBeDefined();

      // roleSlots 类型校验：非对象条目 400（此前 TypeError 500）。用未发布
      // plan 的草稿验证（已发布 plan 的草稿先命中 409 守卫）。
      const unprojectedStore = new MemoryProjectionStore();
      const unprojectedRouter = createApiRouter(unprojectedStore, {
        productSchemaResolver: crossBorderSchemaResolver(),
        submissionChainId: 31337,
        submissionVerifyingContract: contractAddress
      });
      const unprojectedImport = await unprojectedRouter.handle({
        method: "POST",
        pathname: "/store/zhixu-drafts/import",
        headers: operatorHeaders,
        body: { sourceKind: "onchain_hook_plan_manifest", content: JSON.stringify(customsOnchainHookPlanArtifact) }
      });
      expect(unprojectedImport.status).toBe(201);
      const unprojectedDraftId = (unprojectedImport.body as { draft: { draftId: string } }).draft.draftId;
      const unprojectedCompiled = await unprojectedRouter.handle({
        method: "POST",
        pathname: `/store/zhixu-drafts/${unprojectedDraftId}/compile-preview`,
        headers: operatorHeaders
      });
      expect(unprojectedCompiled.status).toBe(200);
      const unprojectedSchema = (unprojectedCompiled.body as { draft: { productSchema?: StoreProductSchemaDTO } }).draft.productSchema;
      expect(unprojectedSchema).toBeDefined();
      const malformed = await unprojectedRouter.handle({
        method: "PUT",
        pathname: `/store/zhixu-drafts/${unprojectedDraftId}/product-schema`,
        headers: operatorHeaders,
        body: {
          ...unprojectedSchema,
          roleSlots: ["not-an-object"]
        }
      });
      expect(malformed).toMatchObject({ status: 400, body: { error: "invalid_product_schema" } });

      // 簇 N 修正（审计三轮）：onchainHookPlanArtifact 主体进 schemaHash——
      // 只改产物内部字段（不镜像到 planId/planHash/artifactHash 字段）也必须
      // 改变 schemaHash，否则产物本体可被无感替换。
      const tamperedArtifact = {
        ...JSON.parse(JSON.stringify(customsOnchainHookPlanArtifact)),
        zhixuName: `${(customsOnchainHookPlanArtifact as { readonly zhixuName: string }).zhixuName} (tampered)`
      };
      const tampered = await unprojectedRouter.handle({
        method: "PUT",
        pathname: `/store/zhixu-drafts/${unprojectedDraftId}/product-schema`,
        headers: operatorHeaders,
        body: {
          ...unprojectedSchema,
          onchainHookPlanArtifact: tamperedArtifact
        }
      });
      expect(tampered.status).toBe(200);
      const tamperedSchema = (tampered.body as { productSchema: StoreProductSchemaDTO }).productSchema;
      expect(tamperedSchema.schemaHash).not.toBe(unprojectedSchema?.schemaHash);
      expect(tamperedSchema.planId).toBe(unprojectedSchema?.planId);
      expect(tamperedSchema.planHash).toBe(unprojectedSchema?.planHash);

      // 编译产物的 plan 已在投影中（已发布）→ schema 原地改写 409；
      // 携带被替换的 onchainHookPlanArtifact 主体也一样被拒。
      const mutation = await router.handle({
        method: "PUT",
        pathname: `/store/zhixu-drafts/${draftId}/product-schema`,
        headers: operatorHeaders,
        body: {
          ...schema,
          onchainHookPlanArtifact: {
            ...customsOnchainHookPlanArtifact,
            planHash: "0x0000000000000000000000000000000000000000000000000000000000000eee"
          }
        }
      });
      expect(mutation).toMatchObject({ status: 409, body: { error: "product_schema_new_version_required" } });
    });
  });

  describe("cluster N: staging readiness", () => {
    it("does not treat an unknown rebuild status as ready", async () => {
      const store = new MemoryProjectionStore();
      await seedPlan(store);
      const router = createApiRouter(store, {
        productSchemaResolver: crossBorderSchemaResolver(),
        submissionChainId: 31337,
        submissionVerifyingContract: contractAddress
      });
      const response = await router.handle({ method: "GET", pathname: "/product/staging/readiness" });
      expect(response.status).toBe(503);
      const body = response.body as { reasons: string[]; indexer: { rebuildReady: boolean; rebuildStatus: string } };
      // 重建状态未知（无 rebuild 记录）→ rebuildReady=false + 明确 reason。
      expect(body.indexer.rebuildStatus).toBe("unknown");
      expect(body.indexer.rebuildReady).toBe(false);
      expect(body.reasons).toContain("projection_rebuild_not_complete");
    });
  });
});

function joinRouterOptions() {
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

async function createDraft(router: ApiRouter): Promise<{ readonly draftId: string }> {
  const response = await router.handle({
    method: "POST",
    pathname: "/product/order-drafts",
    body: {
      zhixuId: CROSS_BORDER_ZHIXU_ID,
      title: "audit3 draft",
      businessType: "parallel-export",
      totalAmount: "100",
      currency: "USDC"
    }
  });
  expect(response.status).toBe(201);
  return (response.body as { draft: { draftId: string } }).draft;
}

async function seedPlan(
  store: MemoryProjectionStore,
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
  store: MemoryProjectionStore,
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

function migrationsDirectory(): string {
  return join(process.cwd(), "migrations");
}

/** testnet/production 边界可接受的内存对象存储客户端。 */
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
