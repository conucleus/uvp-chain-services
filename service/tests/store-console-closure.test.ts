import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXAMPLE_ZHIXU_ID, examplePlanIds } from "./fixtures/business/index.js";
import { createApiRouter } from "../src/api/routes.js";
import { createNotificationService, createSupplierNotificationProfileConfigService, MemorySupplierNotificationProfileConfigStore } from "../src/notifications/index.js";
import { exampleSchemaResolver, dockTargetPlanIds } from "./example-schema.js";
import type { ChainEvent } from "../src/indexer/events.js";
import { createChainServicesStores, type ChainServicesStores } from "../src/storage/factory.js";
import { createPostgresTestDatabase } from "./postgres.js";
import { MemoryStoreAuditStore } from "../src/store/console/audit.js";
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
  "x-uvp-store-user-id": "closure-operator",
  "x-uvp-store-role": "operator"
};

const readerHeaders = {
  "x-uvp-store-user-id": "closure-reader",
  "x-uvp-store-role": "read"
};

const contractAddress = "0x1111111111111111111111111111111111111111" as Address;
const submitter = "0x3333333333333333333333333333333333333333";
const metadataHash = "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const payloadHash = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const orderId = bytes32Hex("0202");
const hookId = bytes32Hex("0303");
const stageId = bytes32Text("stage-a");
const hookName = bytes32Text("example-review");

describe("Store Console closure dry-run summary", () => {
  it("covers the operator closure slice without creating authoritative state", async () => {
    const store = stores.projectionStore;
    await store.resetFromEvents({
      deploymentBlock: 0n,
      events: stateMachineOrderEvents(),
      syncState: {
        chainId: 31337,
        contractAddress,
        syncStatus: "indexed",
        latestIndexedBlock: 5n,
        finalizedBlock: 5n,
        confirmationDepth: 2,
        eventCount: 5
      }
    });
    const storeAuditStore = new MemoryStoreAuditStore();
    const router = createApiRouter(store, { ...requiredRouterStores(), productRuntimeEnvironment: "local", productSchemaResolver: exampleSchemaResolver(), submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111",
      storeAuditStore,
      now: () => new Date("2026-05-06T00:00:00.000Z")
    });

    const response = await router.handle({
      method: "GET",
      pathname: "/store/closure/dry-run",
      headers: operatorHeaders
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      summary: {
        mode: "store_console_closure_dry_run",
        dryRun: true,
        nonAuthoritative: true,
        sourceOfTruth: "contracts-and-chain-events",
        releaseClassification: "prototype",
        session: {
          principalId: "closure-operator",
          accessLevel: "store_operator",
          authMode: "dev_store_headers"
        },
        authorityBoundaries: {
          dockingDraftPublishesZhixu: false,
          auditCreatesProtocolFacts: false,
          backendCanCreateBusinessSignatures: false
        },
        checks: expect.arrayContaining([
          expect.objectContaining({ key: "session", status: "passed", classification: "prototype" }),
          expect.objectContaining({ key: "search_detail", status: "passed", sourceOfTruth: "contracts-and-chain-events" }),
          expect.objectContaining({ key: "draft_import_compile_review", status: "passed" }),
          expect.objectContaining({ key: "supplier_tag_audit_readback", status: "passed" }),
          expect.objectContaining({ key: "docking_create_validate_save", status: "passed" }),
          expect.objectContaining({ key: "runtime_proof_audit_readiness", status: "passed" }),
          expect.objectContaining({ key: "store_operator_audit_readiness", status: "passed" })
        ]),
        prototypeReasons: expect.arrayContaining([
          "dry_run_no_broadcast",
          "store_identity_not_external_oidc"
        ])
      }
    });

    const summary = (response.body as { summary: { checks: Array<{ key: string; details?: Record<string, unknown> }> } }).summary;
    const supplierAudit = summary.checks.find((check) => check.key === "supplier_tag_audit_readback");
    expect(supplierAudit?.details).toMatchObject({
      nonAuthoritative: true,
      identitySourceOfTruth: "IdentityBindingRegistered/IdentityBindingRevoked projection",
    });
    const docking = summary.checks.find((check) => check.key === "docking_create_validate_save");
    expect(docking?.details).toMatchObject({
      nonPublishing: true
    });
    const runtime = summary.checks.find((check) => check.key === "runtime_proof_audit_readiness");
    expect(runtime?.details).toMatchObject({
      replayStatus: "replayable",
      auditSummaryFound: true
    });
    const serialized = JSON.stringify(response.body);
    expect(serialized).toContain(EXAMPLE_ZHIXU_ID);
    expect(serialized).not.toContain(payloadHash);
    expect(serialized).not.toContain(orderId);
  });

  it("lets read-only Store principals view the summary while write steps fail closed", async () => {
    const store = stores.projectionStore;
    await store.resetFromEvents({ deploymentBlock: 0n, events: stateMachineOrderEvents() });
    const router = createApiRouter(store, { ...requiredRouterStores(), productRuntimeEnvironment: "local", productSchemaResolver: exampleSchemaResolver(), submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111",
      now: () => new Date("2026-05-06T00:00:00.000Z")
    });

    const response = await router.handle({
      method: "GET",
      pathname: "/store/closure/dry-run",
      headers: readerHeaders
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      summary: {
        session: {
          accessLevel: "store_read",
          capabilities: ["store.read", "store.audit.read", "store.docking.read"]
        },
        checks: expect.arrayContaining([
          expect.objectContaining({
            key: "draft_import_compile_review",
            status: "blocked",
            missingCapabilities: expect.arrayContaining(["store.draft.import", "store.draft.schema.save"])
          }),
          expect.objectContaining({
            key: "supplier_tag_audit_readback",
            status: "blocked",
            missingCapabilities: expect.arrayContaining(["store.supplier.create", "store.supplier.tags.update"])
          }),
          expect.objectContaining({
            key: "docking_create_validate_save",
            status: "blocked",
            missingCapabilities: expect.arrayContaining(["store.docking.create", "store.docking.save"])
          })
        ]),
        prototypeReasons: expect.arrayContaining([
          "draft_import_compile_review_blocked",
          "supplier_tag_audit_readback_blocked",
          "docking_create_validate_save_blocked"
        ])
      }
    });
  });

  it("requires an authenticated Store audit reader", async () => {
    const router = createApiRouter(stores.projectionStore, { ...requiredRouterStores(), productRuntimeEnvironment: "local", productSchemaResolver: exampleSchemaResolver(), submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111" });

    await expect(router.handle({
      method: "GET",
      pathname: "/store/closure/dry-run"
    })).resolves.toMatchObject({
      status: 401,
      body: {
        error: "store_identity_missing",
        requiredCapability: "store.audit.read",
        requiredAccess: "store_read"
      }
    });
  });
});

function stateMachineOrderEvents(): readonly ChainEvent[] {
  return [
    chainEvent(1n, "PlanRegistered", {
      planId: examplePlanIds.planId,
      planHash: examplePlanIds.planHash,
      hookCount: 1n
    }),
    // STORE-03：closure dry-run 的 docking 沙箱需要第二个已发布 zhixu 作 target。
    chainEvent(2n, "PlanRegistered", {
      planId: dockTargetPlanIds.planId,
      planHash: dockTargetPlanIds.planHash,
      hookCount: 1n
    }),
    chainEvent(3n, "OrderRegistered", {
      orderId,
      planId: examplePlanIds.planId
    }),
    chainEvent(4n, "SignalSubmitterAuthorized", {
      orderId,
      sourceId: stageId,
      signalId: hookName,
      submitter,
      role: bytes32Text("example-broker"),
      metadataHash
    }),
    chainEvent(5n, "HookReady", {
      orderId,
      hookId,
      stageId,
      hookName
    })
  ];
}

function chainEvent(blockNumber: bigint, eventName: string, args: Record<string, unknown>): ChainEvent {
  return {
    chainId: 31337,
    contractAddress,
    blockNumber,
    transactionHash: txHash(blockNumber),
    logIndex: 0,
    eventName,
    args
  };
}

function txHash(blockNumber: bigint): Hex {
  return `0x${blockNumber.toString(16).padStart(64, "0")}`;
}

function bytes32Text(value: string): Hex {
  return `0x${Buffer.from(value, "utf8").toString("hex").padEnd(64, "0")}`;
}

function bytes32Hex(suffix: string): Hex {
  return `0x${suffix.padStart(64, "0")}`;
}
