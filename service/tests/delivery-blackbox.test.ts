import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { capabilitiesRootOf, supplierBindingsRootOf } from "@uvp-eth/compiler";
import { rebuildOrderProjections } from "../src/indexer/replay.js";
import { stateMachineScopedKey } from "../src/indexer/projections/index.js";
import { createChainServicesStores, type ChainServicesStores } from "../src/storage/factory.js";
import { createPostgresTestDatabase } from "./postgres.js";

let stores: ChainServicesStores;

beforeAll(async () => {
  stores = createChainServicesStores({
    database: { url: await createPostgresTestDatabase(), migrationsAutoRun: true },
    chainId: 31337
  });
});

afterAll(async () => {
  await stores.close();
});
import type { ChainEvent } from "../src/indexer/events.js";
import type { Hex } from "@uvp-eth/service-runtime";

const chainId = 31337;
const stateMachineAddress = "0x1111111111111111111111111111111111111111" as Hex;
const deploymentRegistryAddress = "0x8888888888888888888888888888888888888888" as Hex;
const signer = "0x4444444444444444444444444444444444444444" as Hex;
const zeroAddress = "0x0000000000000000000000000000000000000000" as Hex;
const emptySupplierBindingsRoot = supplierBindingsRootOf([]);
const planId = bytes32Hex("a1");
const planHash = bytes32Hex("b101");
const targetPlanId = bytes32Hex("a2");
const targetPlanHash = bytes32Hex("b102");
const firstOrderId = bytes32Hex("c1");
const targetOrderId = bytes32Hex("c2");
const hookId = bytes32Hex("d1");
const sourceId = bytes32Hex("0501");
const signalId = bytes32Hex("0502");
const payloadHash = bytes32Hex("0601");
const idempotencyKey = bytes32Hex("0602");

describe("order projection blackbox", () => {

  it("counts genuinely unknown events explicitly and keeps neighbour projections intact", async () => {
    const events: readonly ChainEvent[] = [
      ...planPublished(1n, planId, planHash),
      chainEvent(2n, 0, "OwnershipTransferred", {
        previousOwner: zeroAddress,
        newOwner: signer
      }),
      chainEvent(3n, 0, "SomeBrandNewEventV9", { planId }),
      chainEvent(3n, 1, "AnotherUnheardOfEvent", { planId }),
      chainEvent(4n, 0, "DeploymentRegistered", {
        deploymentId: bytes32Hex("7d01"),
        stateMachine: stateMachineAddress,
        artifactHash: planHash,
        abiHash: bytes32Hex("7d02"),
        deploymentBlock: 1n,
        metadataURI: "uvp-eth://deployments/blackbox"
      }, deploymentRegistryAddress),
      orderRegistered(5n, firstOrderId, planId)
    ];

    const snapshot = rebuildOrderProjections(events);
    expect(snapshot.unknownEventCount).toBe(2);
    expect(snapshot.eventCount).toBe(8);
    expect(snapshot.stateMachineDeployments[`${chainId}:${deploymentRegistryAddress}:${bytes32Hex("7d01")}`])
      .toMatchObject({ status: "candidate" });
    expect(snapshot.stateMachineOrders[stateMachineScopedKey(chainId, stateMachineAddress, planId, firstOrderId)])
      .toMatchObject({ status: "registered", planId });
  });

  it("replays the same event stream twice into deeply equal snapshots (idempotent rebuild)", async () => {
    const events: readonly ChainEvent[] = [
      ...planPublishEvents(1n, planId, planHash, capabilitiesRootOf([], [])),
      ...planPublished(2n, targetPlanId, targetPlanHash),
      orderRegistered(3n, firstOrderId, planId),
      orderRegistered(4n, targetOrderId, targetPlanId),
      hookReady(5n, firstOrderId, hookId, planId),
      signalSubmitted(6n, targetOrderId, targetPlanId, sourceId, signalId),
      chainEvent(9n, 0, "TimerPoked", {
        orderId: firstOrderId,
        planId,
        hookId,
        dueAt: 0n
      })
    ];

    const first = rebuildOrderProjections(events);
    const second = rebuildOrderProjections(events);
    expect(second).toEqual(first);

    const store = stores.projectionStore;
    const fromStoreFirst = await store.resetFromEvents({ deploymentBlock: 0n, events });
    const fromStoreSecond = await store.resetFromEvents({ deploymentBlock: 0n, events });
    expect(fromStoreSecond).toEqual(fromStoreFirst);
    expect(fromStoreFirst).toEqual(first);
  });

});

function planPublishEvents(
  startBlock: bigint,
  publishedPlanId: Hex,
  publishedPlanHash: Hex,
  capabilitiesRoot: Hex
): readonly ChainEvent[] {
  return [
    chainEvent(startBlock, 0, "PlanCommitted", {
      planId: publishedPlanId,
      planHash: publishedPlanHash,
      publisher: signer,
      hooksHash: bytes32Hex("0e01"),
      capabilitiesRoot,
      supplierBindingsRoot: emptySupplierBindingsRoot,
      hookCount: 1n
    }),
    chainEvent(startBlock, 1, "PlanPublisherRecorded", {
      planId: publishedPlanId,
      publisher: signer
    }),
    chainEvent(startBlock + 1n, 0, "PlanFinalized", {
      planId: publishedPlanId,
      planHash: publishedPlanHash,
      capabilitiesRoot
    }),
    chainEvent(startBlock + 1n, 1, "PlanRegistered", {
      planId: publishedPlanId,
      planHash: publishedPlanHash,
      hookCount: 1n
    })
  ];
}

function planPublished(block: bigint, publishedPlanId: Hex, publishedPlanHash: Hex): readonly ChainEvent[] {
  const capabilitiesRoot = capabilitiesRootOf([], []);
  return [
    chainEvent(block, 0, "PlanCommitted", {
      planId: publishedPlanId,
      planHash: publishedPlanHash,
      publisher: signer,
      hooksHash: bytes32Hex("0e01"),
      capabilitiesRoot,
      supplierBindingsRoot: emptySupplierBindingsRoot,
      hookCount: 1n
    }),
    chainEvent(block, 1, "PlanFinalized", {
      planId: publishedPlanId,
      planHash: publishedPlanHash,
      capabilitiesRoot
    }),
    chainEvent(block, 2, "PlanRegistered", {
      planId: publishedPlanId,
      planHash: publishedPlanHash,
      hookCount: 1n
    })
  ];
}

function orderRegistered(block: bigint, order: Hex, orderPlanId: Hex, logIndex = 0): ChainEvent {
  return chainEvent(block, logIndex, "OrderRegistered", { orderId: order, planId: orderPlanId });
}

function hookReady(block: bigint, order: Hex, hook: Hex, orderPlanId: Hex, logIndex = 0): ChainEvent {
  return chainEvent(block, logIndex, "HookStatusChanged", {
    orderId: order,
    planId: orderPlanId,
    hookId: hook,
    previousStatus: 0,
    newStatus: 2,
    dueAt: 0n
  });
}

function signalSubmitted(
  block: bigint,
  order: Hex,
  orderPlanId: Hex,
  factSourceId: Hex,
  factSignalId: Hex
): ChainEvent {
  return chainEvent(block, 0, "SignalSubmitted", {
    orderId: order,
    planId: orderPlanId,
    sourceId: factSourceId,
    signalId: factSignalId,
    payloadHash,
    idempotencyKey,
    submitter: signer
  });
}

function chainEvent(
  blockNumber: bigint,
  logIndex: number,
  eventName: string,
  args: Record<string, unknown>,
  eventContractAddress: Hex = stateMachineAddress
): ChainEvent {
  return {
    chainId,
    contractAddress: eventContractAddress,
    blockNumber,
    transactionHash: `0x${blockNumber.toString(16).padStart(64, "0")}` as Hex,
    logIndex,
    eventName,
    args
  };
}

function bytes32Hex(value: string): Hex {
  return `0x${value.padStart(64, "0")}` as Hex;
}

function bytes32Text(value: string): Hex {
  return `0x${Buffer.from(value, "utf8").toString("hex").padEnd(64, "0")}` as Hex;
}
