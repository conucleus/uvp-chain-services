import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { capabilitiesRootOf } from "@uvp-eth/compiler";
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
const dockingModuleAddress = "0x6666666666666666666666666666666666666666" as Hex;
const deploymentRegistryAddress = "0x8888888888888888888888888888888888888888" as Hex;
const signer = "0x4444444444444444444444444444444444444444" as Hex;
const zeroAddress = "0x0000000000000000000000000000000000000000" as Hex;
const zeroBytes32 = ("0x" + "00".repeat(32)) as Hex;
const planId = bytes32Hex("a1");
const planHash = bytes32Hex("b101");
const targetPlanId = bytes32Hex("a2");
const targetPlanHash = bytes32Hex("b102");
const unregisteredPlanId = bytes32Hex("a3");
const parentOrderId = bytes32Hex("c1");
const targetOrderId = bytes32Hex("c2");
const hookId = bytes32Hex("d1");
const secondHookId = bytes32Hex("d2");
const thirdHookId = bytes32Hex("d3");
const dockInstanceId = bytes32Hex("e1");
const routeId = bytes32Hex("f1");
const targetStageId = bytes32Text("stage-b");
const sourceId = bytes32Hex("0501");
const signalId = bytes32Hex("0502");
const otherSourceId = bytes32Hex("0503");
const otherSignalId = bytes32Hex("0504");
const thirdSourceId = bytes32Hex("0505");
const thirdSignalId = bytes32Hex("0506");
const payloadHash = bytes32Hex("0601");
const idempotencyKey = bytes32Hex("0602");

describe("dock projection blackbox", () => {

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
      orderRegistered(5n, parentOrderId, planId)
    ];

    const snapshot = rebuildOrderProjections(events);
    expect(snapshot.unknownEventCount).toBe(2);
    expect(snapshot.eventCount).toBe(8);
    expect(snapshot.stateMachineDeployments[`${chainId}:${deploymentRegistryAddress}:${bytes32Hex("7d01")}`])
      .toMatchObject({ status: "candidate" });
    expect(snapshot.stateMachineOrders[stateMachineScopedKey(chainId, stateMachineAddress, planId, parentOrderId)])
      .toMatchObject({ status: "registered", planId });
  });

  it("projects OrderForked lineage and keeps the fork order an ordinary order that accepts signals", async () => {
    const forkOrderId = bytes32Hex("c5");
    const events: readonly ChainEvent[] = [
      ...planPublished(1n, planId, planHash),
      orderRegistered(2n, parentOrderId, planId),
      orderRegistered(3n, forkOrderId, planId),
      chainEvent(4n, 0, "OrderForked", {
        planId,
        orderId: forkOrderId,
        parentOrderId,
        approvalSourceId: bytes32Hex("8101"),
        approvalSignalId: bytes32Hex("8102"),
        initiator: signer
      }),
      signalSubmitted(5n, forkOrderId, planId, sourceId, signalId)
    ];

    const snapshot = rebuildOrderProjections(events);
    const fork = snapshot.stateMachineOrders[stateMachineScopedKey(chainId, stateMachineAddress, planId, forkOrderId)];
    expect(fork?.forkLineage).toMatchObject({
      orderId: forkOrderId,
      parentOrderId,
      approvalSourceId: bytes32Hex("8101"),
      approvalSignalId: bytes32Hex("8102"),
      initiator: signer
    });
    expect(fork?.status).toBe("registered");
    expect(fork?.signals[`${sourceId}:${signalId}`]).toMatchObject({ payloadHash, submitter: signer });
    const timelineNames = fork?.timeline.map((item) => item.eventName);
    expect(timelineNames).toContain("OrderRegistered");
    expect(timelineNames).toContain("OrderForked");
    expect(timelineNames).toContain("SignalSubmitted");

    const parent = snapshot.stateMachineOrders[stateMachineScopedKey(chainId, stateMachineAddress, planId, parentOrderId)];
    expect(parent?.forkLineage).toBeUndefined();
    expect(snapshot.unknownEventCount).toBe(0);
  });

  it("replays the same event stream twice into deeply equal snapshots (idempotent rebuild)", async () => {
    const forkOrderId = bytes32Hex("c6");
    const events: readonly ChainEvent[] = [
      ...planPublishEvents(1n, planId, planHash, capabilitiesRootOf([], [])),
      ...planPublished(2n, targetPlanId, targetPlanHash),
      orderRegistered(3n, parentOrderId, planId),
      orderRegistered(4n, targetOrderId, targetPlanId),
      moduleSet(5n),
      hookReady(6n, parentOrderId, hookId, planId),
      dockAttached(7n, dockInstanceId, parentOrderId, targetOrderId, routeId),
      chainEvent(8n, 0, "DockInputSubmitted", {
        dockInstanceId,
        linkedOrderId: targetOrderId,
        inputBindingHash: bindingHash("0e"),
        localPlanId: planId,
        localOrderId: parentOrderId,
        targetPlanId,
        targetSignalId: signalId,
        payloadHash,
        submitter: signer
      }, dockingModuleAddress),
      signalSubmitted(9n, targetOrderId, targetPlanId, sourceId, signalId),
      chainEvent(10n, 0, "DockOutputSubmitted", {
        dockInstanceId,
        linkedOrderId: targetOrderId,
        outputBindingHash: bindingHash("0f"),
        localPlanId: planId,
        localOrderId: parentOrderId,
        targetPlanId,
        targetSignalId: signalId,
        localSignalId: signalId,
        payloadHash,
        submitter: signer
      }, dockingModuleAddress),
      chainEvent(11n, 0, "OrderForked", {
        planId,
        orderId: forkOrderId,
        parentOrderId,
        approvalSourceId: bytes32Hex("8101"),
        approvalSignalId: bytes32Hex("8102"),
        initiator: signer
      }),
      signalSubmitted(12n, forkOrderId, planId, otherSourceId, otherSignalId),
      chainEvent(13n, 0, "TimerPoked", {
        orderId: parentOrderId,
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

  it("drops a fork order that exists only through OrderForked when the birth log is reorged away", async () => {
    const forkOrderId = bytes32Hex("c7");
    const forkedEvent = chainEvent(3n, 0, "OrderForked", {
      planId,
      orderId: forkOrderId,
      parentOrderId,
      approvalSourceId: bytes32Hex("8101"),
      approvalSignalId: bytes32Hex("8102"),
      initiator: signer
    });
    const base: readonly ChainEvent[] = [
      ...planPublished(1n, planId, planHash),
      orderRegistered(2n, parentOrderId, planId)
    ];

    const withFork = rebuildOrderProjections([...base, forkedEvent]);
    const forkKey = stateMachineScopedKey(chainId, stateMachineAddress, planId, forkOrderId);
    expect(withFork.stateMachineOrders[forkKey]).toMatchObject({
      status: "registered",
      forkLineage: expect.objectContaining({ parentOrderId })
    });

    const rolled = rebuildOrderProjections([...base, forkedEvent, { ...forkedEvent, removed: true }]);
    expect(rolled.stateMachineOrders[forkKey]).toBeUndefined();
    expect(rolled.eventCount).toBe(4);
  });

  it("keeps the fork lineage when OrderForked arrives before the fork order's own OrderRegistered", async () => {
    const forkOrderId = bytes32Hex("c8");
    const events: readonly ChainEvent[] = [
      ...planPublished(1n, planId, planHash),
      orderRegistered(2n, parentOrderId, planId),
      chainEvent(3n, 0, "OrderForked", {
        planId,
        orderId: forkOrderId,
        parentOrderId,
        approvalSourceId: bytes32Hex("8101"),
        approvalSignalId: bytes32Hex("8102"),
        initiator: signer
      }),
      orderRegistered(4n, forkOrderId, planId)
    ];

    const snapshot = rebuildOrderProjections(events);
    const fork = snapshot.stateMachineOrders[stateMachineScopedKey(chainId, stateMachineAddress, planId, forkOrderId)];
    expect(fork?.forkLineage).toMatchObject({ orderId: forkOrderId, parentOrderId });
    expect(fork?.status).toBe("registered");
    const timelineNames = fork?.timeline.map((item) => item.eventName);
    expect(timelineNames).toContain("OrderForked");
    expect(timelineNames).toContain("OrderRegistered");
  });

  it("counts delivery events for an unborn dock instance instead of silently dropping them", async () => {
    const unknownDockInstance = bytes32Hex("e9");
    const childOrderId = bytes32Hex("c9");
    const events: readonly ChainEvent[] = [
      ...planPublished(1n, planId, planHash),
      ...planPublished(2n, targetPlanId, targetPlanHash),
      orderRegistered(3n, parentOrderId, planId),
      moduleSet(4n),
      chainEvent(5n, 0, "DockInputSubmitted", {
        dockInstanceId: unknownDockInstance,
        linkedOrderId: targetOrderId,
        inputBindingHash: bindingHash("10"),
        localPlanId: planId,
        localOrderId: parentOrderId,
        targetPlanId,
        targetSignalId: signalId,
        payloadHash,
        submitter: signer
      }, dockingModuleAddress),
      chainEvent(5n, 1, "DockOutputSubmitted", {
        dockInstanceId: unknownDockInstance,
        linkedOrderId: targetOrderId,
        outputBindingHash: bindingHash("11"),
        localPlanId: planId,
        localOrderId: parentOrderId,
        targetPlanId,
        targetSignalId: signalId,
        localSignalId: signalId,
        payloadHash,
        submitter: signer
      }, dockingModuleAddress),
      chainEvent(5n, 2, "DockOutputSatisfied", {
        dockInstanceId: unknownDockInstance,
        linkedOrderId: targetOrderId,
        outputBindingHash: bindingHash("12"),
        localPlanId: planId,
        localOrderId: parentOrderId,
        targetPlanId,
        targetSignalId: signalId,
        localSignalId: signalId,
        payloadHash,
        submitter: signer
      }, dockingModuleAddress),
      chainEvent(6n, 0, "DockOpened", {
        dockInstanceId: bytes32Hex("e8"),
        localOrderId: parentOrderId,
        linkedOrderId: childOrderId,
        interfaceNameId: bytes32Text("production_service"),
        localPlanId: planId,
        targetPlanId: unregisteredPlanId,
        routeId,
        routeHash: bytes32Hex("aa01"),
        depth: 1n,
        opener: signer
      }, dockingModuleAddress)
    ];

    const snapshot = rebuildOrderProjections(events);
    expect(snapshot.unresolvedDockEventCount).toBe(3);
    expect(snapshot.unresolvedDockTargetDeploymentCount).toBe(1);
    expect(snapshot.unresolvedModuleOrderEventCount).toBe(0);
    expect(snapshot.stateMachineDocks[stateMachineScopedKey(chainId, stateMachineAddress, unknownDockInstance)])
      .toBeUndefined();
    expect(snapshot.stateMachineDocks[stateMachineScopedKey(chainId, stateMachineAddress, bytes32Hex("e8"))])
      .toMatchObject({ mode: "new", targetPlanId: unregisteredPlanId });
    expect(snapshot.stateMachineOrders[stateMachineScopedKey(chainId, stateMachineAddress, planId, parentOrderId)])
      .toBeDefined();
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
      hookCount: 1n,
      dockRoutesRoot: bytes32Hex("0e03"),
      dockInterfaceRoot: bytes32Hex("0e04")
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
      hookCount: 1n,
      dockRoutesRoot: bytes32Hex("0e03"),
      dockInterfaceRoot: bytes32Hex("0e04")
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

function moduleSet(block: bigint): ChainEvent {
  return chainEvent(block, 0, "StateMachineModuleSet", {
    moduleId: bytes32Text("uvp.module.docking.v1"),
    previousModule: zeroAddress,
    newModule: dockingModuleAddress
  });
}

function dockAttached(
  block: bigint,
  instance: Hex,
  localOrder: Hex,
  linkedOrder: Hex,
  attachedRouteId: Hex,
  logIndex = 0
): ChainEvent {
  return chainEvent(block, logIndex, "DockAttached", {
    dockInstanceId: instance,
    localOrderId: localOrder,
    linkedOrderId: linkedOrder,
    interfaceNameId: bytes32Text("production_service"),
    localPlanId: planId,
    targetPlanId,
    routeId: attachedRouteId,
    routeHash: bytes32Hex("aa01"),
    depth: 1n,
    attacher: signer
  }, dockingModuleAddress);
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

function bindingHash(tag: string): Hex {
  return bytes32Hex(tag);
}

function bytes32Hex(value: string): Hex {
  return `0x${value.padStart(64, "0")}` as Hex;
}

function bytes32Text(value: string): Hex {
  return `0x${Buffer.from(value, "utf8").toString("hex").padEnd(64, "0")}` as Hex;
}
