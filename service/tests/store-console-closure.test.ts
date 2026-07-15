import { describe, expect, it } from "vitest";
import { CROSS_BORDER_ZHIXU_ID, crossBorderPlanIds } from "@uvp-eth/product-dto/fixtures";
import { createApiRouter } from "../src/api/routes.js";
import type { ChainEvent } from "../src/indexer/events.js";
import { MemoryProjectionStore } from "../src/storage/projection-store.js";
import { MemoryStoreAuditStore } from "../src/store-console/audit.js";
import type { Address, Hex } from "../src/shared/types.js";

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
const stageId = bytes32Text("export.customs");
const hookName = bytes32Text("customs-review");

describe("Store Console closure dry-run summary", () => {
  it("covers the operator closure slice without creating authoritative state", async () => {
    const store = new MemoryProjectionStore();
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
    const router = createApiRouter(store, {
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
          "store_identity_not_external_oidc",
          "store_metadata_memory_only"
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
    expect(serialized).toContain(CROSS_BORDER_ZHIXU_ID);
    expect(serialized).not.toContain(payloadHash);
    expect(serialized).not.toContain(orderId);
  });

  it("lets read-only Store principals view the summary while write steps fail closed", async () => {
    const store = new MemoryProjectionStore();
    await store.resetFromEvents({ deploymentBlock: 0n, events: stateMachineOrderEvents() });
    const router = createApiRouter(store, {
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
          capabilities: ["store.read", "store.audit.read"]
        },
        checks: expect.arrayContaining([
          expect.objectContaining({
            key: "draft_import_compile_review",
            status: "blocked",
            missingCapabilities: expect.arrayContaining(["store.draft.import", "store.draft.review"])
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
    const router = createApiRouter(new MemoryProjectionStore());

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
      planId: crossBorderPlanIds.planId,
      planHash: crossBorderPlanIds.planHash,
      hookCount: 1n
    }),
    chainEvent(3n, "OrderRegistered", {
      orderId,
      planId: crossBorderPlanIds.planId
    }),
    chainEvent(4n, "SignalSubmitterAuthorized", {
      orderId,
      sourceId: stageId,
      signalId: hookName,
      submitter,
      role: bytes32Text("customs-broker"),
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
