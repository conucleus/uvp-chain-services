import { describe, expect, it } from "vitest";
import { crossBorderPlanIds } from "@uvp-eth/product-dto/fixtures";
import type { ChainEvent } from "../src/indexer/events.js";
import { createProductService } from "../src/product/service.js";
import { createStoreRuntimeService } from "../src/store-console/runtime.js";
import {
  createStoreZhixuVersionService,
  MemoryStoreZhixuVersionMetadataStore,
  type StoreZhixuVersionRecord,
} from "../src/store-console/version.js";
import { MemoryProjectionStore } from "../src/storage/projection-store.js";
import type { Address, Hex } from "../src/shared/types.js";

const stateMachine = "0x1111111111111111111111111111111111111111" as Address;
const orderId = bytes32("1001");
const hookId = bytes32("1002");
const stageId = bytes32Text("export.customs");
const hookName = bytes32Text("customs-review");
const planIdV2 = bytes32("2001");
const planHashV2 = bytes32("2002");

describe("Store runtime and version selection", () => {
  it("summarizes StateMachine orders and projection health", async () => {
    const store = new MemoryProjectionStore();
    await store.resetFromEvents({
      deploymentBlock: 0n,
      events: [
        event(1n, "PlanRegistered", {
          planId: crossBorderPlanIds.planId,
          planHash: crossBorderPlanIds.planHash,
          hookCount: 1n,
        }),
        event(2n, "OrderRegistered", { orderId, planId: crossBorderPlanIds.planId }),
        event(3n, "SignalCapabilityRegistered", {
          planId: crossBorderPlanIds.planId,
          stageId,
          targetSourceId: stageId,
          signalId: hookName,
          targetOrderRelation: 0,
        }),
        event(4n, "SignalSubmitterAuthorized", {
          orderId,
          sourceId: stageId,
          signalId: hookName,
          submitter: stateMachine,
          role: bytes32("1005"),
          metadataHash: bytes32("1006"),
        }),
        event(5n, "HookReady", { orderId, hookId, stageId, hookName }),
      ],
    });
    await store.saveSyncState({
      chainId: 31337,
      contractAddress: stateMachine,
      syncStatus: "indexed",
      latestIndexedBlock: 5n,
      finalizedBlock: 5n,
      confirmationDepth: 0,
      eventCount: 5,
    });

    const summary = await createStoreRuntimeService({
      productService: createProductService(store),
      store,
    }).getSummary();

    expect(summary).toMatchObject({
      sourceOfTruth: "contracts-and-chain-events",
      activeZhixuCount: 1,
      runningOrderCount: 1,
      openTaskCount: 1,
      indexerStatus: "ready",
    });
  });

  it("activates a published version and deprecates the previous active version", async () => {
    const store = new MemoryProjectionStore();
    await store.resetFromEvents({
      deploymentBlock: 0n,
      events: [
        event(1n, "PlanRegistered", {
          planId: crossBorderPlanIds.planId,
          planHash: crossBorderPlanIds.planHash,
          hookCount: 1n,
        }),
        event(2n, "PlanRegistered", { planId: planIdV2, planHash: planHashV2, hookCount: 1n }),
      ],
    });
    const metadata = new MemoryStoreZhixuVersionMetadataStore();
    await metadata.upsertVersion(version("v1", "active", crossBorderPlanIds.planId, crossBorderPlanIds.planHash));
    await metadata.upsertVersion(version("v2", "candidate", planIdV2, planHashV2));
    const service = createStoreZhixuVersionService({
      productService: createProductService(store),
      projectionStore: store,
      metadataStore: metadata,
      now: () => new Date("2026-07-15T00:00:00.000Z"),
    });

    const result = await service.activate("series-1", "v2");

    expect(result.version).toMatchObject({
      versionId: "v2",
      status: "active",
      publicationStatus: "published",
    });
    expect(result.versions).toEqual(expect.arrayContaining([
      expect.objectContaining({ versionId: "v1", status: "deprecated" }),
      expect.objectContaining({ versionId: "v2", status: "active" }),
    ]));
  });

  it("requires StateMachine publication before activation", async () => {
    const store = new MemoryProjectionStore();
    const metadata = new MemoryStoreZhixuVersionMetadataStore();
    await metadata.upsertVersion(version("v2", "candidate", planIdV2, planHashV2));
    const service = createStoreZhixuVersionService({
      productService: createProductService(store),
      projectionStore: store,
      metadataStore: metadata,
    });

    await expect(service.activate("series-1", "v2")).rejects.toMatchObject({
      code: "plan_not_published",
      status: 409,
    });
  });
});

function version(
  versionId: string,
  status: StoreZhixuVersionRecord["status"],
  planId: string,
  planHash: string,
): StoreZhixuVersionRecord {
  return {
    versionId,
    zhixuId: "series-1",
    seriesId: "series-1",
    versionLabel: versionId,
    status,
    planId: planId as Hex,
    planHash: planHash as Hex,
    createdAt: `2026-07-1${versionId === "v1" ? "3" : "4"}T00:00:00.000Z`,
  };
}

function event(blockNumber: bigint, eventName: string, args: Record<string, unknown>): ChainEvent {
  return {
    chainId: 31337,
    contractAddress: stateMachine,
    blockNumber,
    transactionHash: bytes32(blockNumber.toString()),
    logIndex: 0,
    eventName,
    args,
  };
}

function bytes32(seed: string): Hex {
  return `0x${seed.padStart(64, "0")}` as Hex;
}

function bytes32Text(value: string): Hex {
  return `0x${Buffer.from(value, "utf8").toString("hex").padEnd(64, "0")}` as Hex;
}
