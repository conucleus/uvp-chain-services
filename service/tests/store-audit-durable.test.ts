import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createApiRouter } from "../src/api/routes.js";
import { InMemoryAuditSink } from "../src/security/index.js";
import { createChainServicesStores, type ChainServicesStores } from "../src/storage/factory.js";
import { recordStoreAudit } from "../src/store-console/audit.js";

const operatorHeaders = {
  "x-uvp-store-operator-id": "audit-operator",
  "x-uvp-store-operator-role": "store_operator"
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
  const tempDirs: string[] = [];
  const openedStores: ChainServicesStores[] = [];

  afterEach(async () => {
    for (const store of openedStores.splice(0)) {
      await store.close();
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists Store audit rows and exposes filtered GET /store/audit", async () => {
    const audit = new InMemoryAuditSink();
    const databaseUrl = sqliteUrl(tempDirs);
    const first = openStores(databaseUrl, openedStores);
    const router = createApiRouter(first.projectionStore, {
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
    const reopenedRouter = createApiRouter(reopened.projectionStore, {
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
      headers: readerHeaders
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

  it("redacts sensitive audit metadata before durable storage", async () => {
    const stores = openStores(sqliteUrl(tempDirs), openedStores);

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
        evidencePlaintext: "invoice plaintext",
        safeCount: 1
      }
    }, { store: stores.storeAuditStore, now: () => new Date("2026-04-30T00:00:00.000Z") });

    const records = await stores.storeAuditStore.query({ resourceId: "draft-sensitive" });
    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain("aaaaaaaaaaaaaaaa");
    expect(serialized).not.toContain("ey.secret");
    expect(serialized).not.toContain("invoice plaintext");
    expect(records[0]?.metadata).toMatchObject({
      privateKey: "[redacted]",
      jwt: "[redacted]",
      rawSignature: "[redacted]",
      evidencePlaintext: "[redacted]",
      safeCount: 1
    });
  });

  it("classifies duplicate and rejected Store outcomes in durable audit", async () => {
    const stores = openStores(sqliteUrl(tempDirs), openedStores);
    const router = createApiRouter(stores.projectionStore, {
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
      headers: readerHeaders
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

function openStores(databaseUrl: string, openedStores: ChainServicesStores[]): ChainServicesStores {
  const stores = createChainServicesStores({
    database: {
      driver: "sqlite",
      url: databaseUrl,
      migrationsAutoRun: true
    },
    chainId: 31337,
    migrationsDirectory: migrationsDirectory()
  });
  openedStores.push(stores);
  return stores;
}

function sqliteUrl(tempDirs: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "uvp-store-audit-"));
  tempDirs.push(dir);
  return `sqlite://${join(dir, "audit.sqlite")}`;
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
    capabilityTags: ["logistics"],
    supportedRoleSlotIds: ["delivery"],
    supportedStageIds: ["shipping"],
    registryAddresses: [registryAddress]
  };
}
