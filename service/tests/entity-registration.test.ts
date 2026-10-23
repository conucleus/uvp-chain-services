import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createApiRouter } from "../src/api/routes.js";
import { MemoryProjectionStore } from "../src/storage/projection-store.js";
import { openSqliteDatabase } from "../src/storage/sqlite.js";
import { InMemoryStoreEntityRegistrationStore } from "../src/store/registration/memory-store.js";
import { createStoreEntityRegistrationService } from "../src/store/registration/service.js";
import { SqliteStoreEntityRegistrationStore } from "../src/store/registration/sqlite-store.js";
import { InMemoryStoreSupplierMetadataStore } from "../src/store/suppliers/service.js";
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

const migrationsDirectory = fileURLToPath(new URL("../migrations", import.meta.url));
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempSqliteUrl(): string {
  const dir = mkdtempSync(join(tmpdir(), "uvp-entity-registration-"));
  tempDirs.push(dir);
  return `sqlite://${join(dir, "registration.sqlite")}`;
}

function createRouter(options: {
  readonly storeEntityRegistrationStore?: CreateApiRouterOptions["storeEntityRegistrationStore"];
  readonly storeSupplierMetadataStore?: CreateApiRouterOptions["storeSupplierMetadataStore"];
} = {}) {
  return createApiRouter(new MemoryProjectionStore(), {
    productRuntimeEnvironment: "local",
    submissionChainId: 84532,
    submissionVerifyingContract: "0x1111111111111111111111111111111111111111",
    storeAuthConfig: devAnchoredStoreAuth,
    ...(options.storeEntityRegistrationStore
      ? { storeEntityRegistrationStore: options.storeEntityRegistrationStore }
      : {}),
    ...(options.storeSupplierMetadataStore
      ? { storeSupplierMetadataStore: options.storeSupplierMetadataStore }
      : {}),
  });
}

const validBody = {
  legalName: "中亚二手车出口有限公司",
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
    const registrationStore = new InMemoryStoreEntityRegistrationStore();
    const supplierStore = new InMemoryStoreSupplierMetadataStore();
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

    // 只存链下档案：不创建供应商记录。
    await expect(supplierStore.listSuppliers()).resolves.toEqual([]);

    // 读回同一账号的最新登记；另一个账号读不到。
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
    const registrationStore = new InMemoryStoreEntityRegistrationStore();
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
      body: { ...validBody, legalName: "中亚二手车出口（更名）有限公司", contactName: "李经理" },
    });

    const firstRegistration = (first.body as { registration: { registrationId: string; createdAt: string } }).registration;
    const secondRegistration = (second.body as {
      registration: { registrationId: string; createdAt: string; updatedAt: string; legalName: string };
    }).registration;
    expect(secondRegistration.registrationId).toBe(firstRegistration.registrationId);
    expect(secondRegistration.createdAt).toBe(firstRegistration.createdAt);
    expect(secondRegistration.legalName).toBe("中亚二手车出口（更名）有限公司");
    expect(secondRegistration.updatedAt >= firstRegistration.createdAt).toBe(true);

    const stored = await registrationStore.getRegistrationByAccount(
      anchoredAccount.toLowerCase() as `0x${string}`
    );
    expect(stored).toMatchObject({
      registrationId: firstRegistration.registrationId,
      legalName: "中亚二手车出口（更名）有限公司",
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

describe("entity registration persistence store", () => {
  it("persists one row per account in sqlite and reads it back after reopen", async () => {
    const databaseUrl = tempSqliteUrl();
    const store = new SqliteStoreEntityRegistrationStore({
      databaseUrl,
      migrations: { autoRun: true, directory: migrationsDirectory },
    });
    let tick = 0;
    const service = createStoreEntityRegistrationService({
      store,
      now: () => new Date(Date.UTC(2026, 9, 23, 12, 0, tick++)),
    });

    const first = await service.registerEntity(validBody, {
      accountAddress: anchoredAccount,
      accountId: "account-1",
    });
    const second = await service.registerEntity(
      { ...validBody, legalName: "中亚二手车出口（更名）有限公司" },
      { accountAddress: anchoredAccount, accountId: "account-1" },
    );
    expect(second.registrationId).toBe(first.registrationId);
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt >= first.updatedAt).toBe(true);
    expect(second.verified).toBe(false);
    expect(second.chainWritten).toBe(false);
    store.close();

    const reopened = new SqliteStoreEntityRegistrationStore({ databaseUrl });
    const readBack = await reopened.getRegistrationByAccount(anchoredAccount);
    expect(readBack).toMatchObject({
      registrationId: first.registrationId,
      accountAddress: anchoredAccount.toLowerCase(),
      accountId: "account-1",
      legalName: "中亚二手车出口（更名）有限公司",
      status: "self_declared",
      createdAt: first.createdAt,
    });
    reopened.close();

    // 单账号单活跃记录：库里只有一行。
    const database = openSqliteDatabase(databaseUrl);
    const count = database.prepare(
      `SELECT COUNT(*) AS total FROM store_entity_registration`
    ).get() as { total: number };
    database.close();
    expect(count.total).toBe(1);
  });
});
