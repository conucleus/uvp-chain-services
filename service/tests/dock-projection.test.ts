// Bug prevented: UVPDockController event replay dropping 1:N fan-out edges,
// mis-wiring bidirectional bindLinkPair incoming/outgoing directions, losing
// DockOutputSubmitted facts, or diverging under out-of-order / reorg replay.
import { describe, expect, it } from "vitest";
import {
  decodeOrderDockLinkWire,
  decodeOrderWire,
  toWire
} from "@uvp-eth/chain-read-contract";
import type { Address, Hex } from "@uvp-eth/service-runtime";
import type { ChainEvent } from "../src/indexer/events.js";
import { stateMachineScopedKey } from "../src/indexer/projections/index.js";
import { rebuildOrderProjections } from "../src/indexer/replay.js";

const CHAIN_ID = 31337;
const STATE_MACHINE = "0x1111111111111111111111111111111111111111" as Address;
const DOCK_CONTROLLER = "0x7777777777777777777777777777777777777777" as Address;
const PUBLISHER = "0x2222222222222222222222222222222222222222" as Address;
const CONSENT_A = "0x3333333333333333333333333333333333333333" as Address;
const CONSENT_B = "0x4444444444444444444444444444444444444444" as Address;

const PLAN_A = bytes32("10");
const PLAN_B = bytes32("20");
const ORDER_SHIP = bytes32("a0");
const ORDER_CAR_1 = bytes32("b1");
const ORDER_CAR_2 = bytes32("b2");
const ORDER_UNLINKED = bytes32("b9");
const DKID_A2B = bytes32("d1");
const DKID_B2A = bytes32("d2");
const LINK_1 = bytes32("e1");
const LINK_2 = bytes32("e2");
const LINK_B2A = bytes32("e3");
const FROM_SOURCE = bytes32("51");
const TO_STAGE = bytes32("52");
const TO_SOURCE = bytes32("53");
const CONSENT_STAGE = bytes32("54");
const DOC_HASH = bytes32("55");
const SIGNAL_0 = bytes32("60");
const SIGNAL_1 = bytes32("61");
const PAYLOAD_HASH_0 = bytes32("70");
const PAYLOAD_HASH_1 = bytes32("71");
const IDEM_0 = bytes32("80");
const IDEM_1 = bytes32("81");

describe("UVPDockController replay projection", () => {
  it("projects 1:N fan-out outgoing links on source order and incoming links on each target order", () => {
    const events: ChainEvent[] = [
      orderRegisteredEvent(10n, 0, PLAN_A, ORDER_SHIP),
      orderRegisteredEvent(10n, 1, PLAN_B, ORDER_CAR_1),
      orderRegisteredEvent(10n, 2, PLAN_B, ORDER_CAR_2),
      orderRegisteredEvent(10n, 3, PLAN_B, ORDER_UNLINKED),
      dockRegisteredEvent(11n, 0, DKID_A2B, PLAN_A, PLAN_B),
      dockLinkBoundEvent(12n, 0, {
        linkId: LINK_1,
        dkid: DKID_A2B,
        fromPlanId: PLAN_A,
        fromOrderId: ORDER_SHIP,
        toPlanId: PLAN_B,
        toOrderId: ORDER_CAR_1,
        toStageId: TO_STAGE,
        toConsentStageId: CONSENT_STAGE,
        toConsent: CONSENT_A
      }),
      dockLinkBoundEvent(12n, 1, {
        linkId: LINK_2,
        dkid: DKID_A2B,
        fromPlanId: PLAN_A,
        fromOrderId: ORDER_SHIP,
        toPlanId: PLAN_B,
        toOrderId: ORDER_CAR_2,
        toStageId: TO_STAGE,
        toConsentStageId: CONSENT_STAGE,
        toConsent: CONSENT_B
      })
    ];

    const snapshot = rebuildOrderProjections(events);
    const shipOrder = snapshot.stateMachineOrders[stateMachineScopedKey(CHAIN_ID, STATE_MACHINE, PLAN_A, ORDER_SHIP)];
    const car1Order = snapshot.stateMachineOrders[stateMachineScopedKey(CHAIN_ID, STATE_MACHINE, PLAN_B, ORDER_CAR_1)];
    const car2Order = snapshot.stateMachineOrders[stateMachineScopedKey(CHAIN_ID, STATE_MACHINE, PLAN_B, ORDER_CAR_2)];
    const unlinkedOrder = snapshot.stateMachineOrders[stateMachineScopedKey(CHAIN_ID, STATE_MACHINE, PLAN_B, ORDER_UNLINKED)];

    expect(snapshot.unknownEventCount).toBe(0);
    expect(shipOrder?.dockLinks?.incoming).toEqual([]);
    expect(shipOrder?.dockLinks?.outgoing.map((link) => link.linkId)).toEqual([LINK_1, LINK_2]);
    expect(car1Order?.dockLinks?.incoming.map((link) => link.linkId)).toEqual([LINK_1]);
    expect(car1Order?.dockLinks?.outgoing).toEqual([]);
    expect(car2Order?.dockLinks?.incoming.map((link) => link.linkId)).toEqual([LINK_2]);
    expect(car2Order?.dockLinks?.outgoing).toEqual([]);
    expect(unlinkedOrder?.dockLinks).toBeUndefined();

    expect(() => decodeOrderWire(toWire(shipOrder))).not.toThrow();
    expect(() => decodeOrderWire(toWire(car1Order))).not.toThrow();
    expect(() => decodeOrderDockLinkWire(toWire(snapshot.dockLinks?.[LINK_1]))).not.toThrow();
  });

  it("projects bidirectional bindLinkPair onto both incoming and outgoing of each order", () => {
    const events: ChainEvent[] = [
      orderRegisteredEvent(10n, 0, PLAN_A, ORDER_SHIP),
      orderRegisteredEvent(10n, 1, PLAN_B, ORDER_CAR_1),
      dockLinkBoundEvent(15n, 0, {
        linkId: LINK_1,
        dkid: DKID_A2B,
        fromPlanId: PLAN_A,
        fromOrderId: ORDER_SHIP,
        toPlanId: PLAN_B,
        toOrderId: ORDER_CAR_1,
        toStageId: TO_STAGE,
        toConsentStageId: CONSENT_STAGE,
        toConsent: CONSENT_B
      }),
      dockLinkBoundEvent(15n, 1, {
        linkId: LINK_B2A,
        dkid: DKID_B2A,
        fromPlanId: PLAN_B,
        fromOrderId: ORDER_CAR_1,
        toPlanId: PLAN_A,
        toOrderId: ORDER_SHIP,
        toStageId: TO_STAGE,
        toConsentStageId: CONSENT_STAGE,
        toConsent: CONSENT_A
      })
    ];

    const snapshot = rebuildOrderProjections(events);
    const orderA = snapshot.stateMachineOrders[stateMachineScopedKey(CHAIN_ID, STATE_MACHINE, PLAN_A, ORDER_SHIP)];
    const orderB = snapshot.stateMachineOrders[stateMachineScopedKey(CHAIN_ID, STATE_MACHINE, PLAN_B, ORDER_CAR_1)];

    expect(orderA?.dockLinks?.outgoing.map((link) => link.linkId)).toEqual([LINK_1]);
    expect(orderA?.dockLinks?.incoming.map((link) => link.linkId)).toEqual([LINK_B2A]);
    expect(orderB?.dockLinks?.incoming.map((link) => link.linkId)).toEqual([LINK_1]);
    expect(orderB?.dockLinks?.outgoing.map((link) => link.linkId)).toEqual([LINK_B2A]);

    expect(() => decodeOrderWire(toWire(orderA))).not.toThrow();
    expect(() => decodeOrderWire(toWire(orderB))).not.toThrow();
  });

  it("projects DockRegistered and DockOutputSubmitted and converges across out-of-order, duplicate, and reorged events", () => {
    const canonicalEvents: ChainEvent[] = [
      orderRegisteredEvent(10n, 0, PLAN_A, ORDER_SHIP),
      orderRegisteredEvent(10n, 1, PLAN_B, ORDER_CAR_1),
      dockRegisteredEvent(11n, 0, DKID_A2B, PLAN_A, PLAN_B),
      dockLinkBoundEvent(12n, 0, {
        linkId: LINK_1,
        dkid: DKID_A2B,
        fromPlanId: PLAN_A,
        fromOrderId: ORDER_SHIP,
        toPlanId: PLAN_B,
        toOrderId: ORDER_CAR_1,
        toStageId: TO_STAGE,
        toConsentStageId: CONSENT_STAGE,
        toConsent: CONSENT_A
      }),
      dockOutputSubmittedEvent(13n, 0, {
        linkId: LINK_1,
        outputIndex: 1n,
        toPlanId: PLAN_B,
        toOrderId: ORDER_CAR_1,
        toSourceId: TO_SOURCE,
        signalId: SIGNAL_1,
        payloadHash: PAYLOAD_HASH_1,
        idempotencyKey: IDEM_1
      }),
      dockOutputSubmittedEvent(14n, 0, {
        linkId: LINK_1,
        outputIndex: 0n,
        toPlanId: PLAN_B,
        toOrderId: ORDER_CAR_1,
        toSourceId: TO_SOURCE,
        signalId: SIGNAL_0,
        payloadHash: PAYLOAD_HASH_0,
        idempotencyKey: IDEM_0
      }),
      {
        chainId: CHAIN_ID,
        contractAddress: DOCK_CONTROLLER,
        blockNumber: 14n,
        transactionHash: bytes32("98"),
        transactionIndex: 0,
        logIndex: 1,
        eventName: "DockLinkReconciled",
        args: { linkId: LINK_1, emittedCount: 1n }
      },
      {
        chainId: CHAIN_ID,
        contractAddress: DOCK_CONTROLLER,
        blockNumber: 14n,
        transactionHash: bytes32("98"),
        transactionIndex: 0,
        logIndex: 2,
        eventName: "DockOutputDeferred",
        args: { linkId: LINK_1, outputIndex: 2n, signalId: SIGNAL_1, admissionVerdict: 1, dueAt: 0n }
      }
    ];

    const reorgedLinkEvent = dockLinkBoundEvent(15n, 0, {
      linkId: LINK_2,
      dkid: DKID_A2B,
      fromPlanId: PLAN_A,
      fromOrderId: ORDER_SHIP,
      toPlanId: PLAN_B,
      toOrderId: ORDER_CAR_1,
      toStageId: TO_STAGE,
      toConsentStageId: CONSENT_STAGE,
      toConsent: CONSENT_B
    });

    const canonical = rebuildOrderProjections(canonicalEvents);
    const shuffledWithReorg = rebuildOrderProjections([
      ...canonicalEvents.slice().reverse(),
      canonicalEvents[3]!,
      reorgedLinkEvent,
      { ...reorgedLinkEvent, removed: true }
    ]);

    expect(canonical.unknownEventCount).toBe(0);
    expect(canonical.dockSpecs?.[DKID_A2B]).toMatchObject({
      dkid: DKID_A2B,
      fromPlanId: PLAN_A,
      toPlanId: PLAN_B,
      publisher: PUBLISHER,
      outputs: [
        { outputIndex: 0, signalId: SIGNAL_0, relation: 0 },
        { outputIndex: 1, signalId: SIGNAL_1, relation: 0 }
      ]
    });
    expect(canonical.dockLinks?.[LINK_1]?.submittedOutputs.map((out) => out.outputIndex)).toEqual([0, 1]);
    expect(canonical.dockLinks?.[LINK_1]?.submittedOutputs[0]).toMatchObject({
      signalId: SIGNAL_0,
      payloadHash: PAYLOAD_HASH_0,
      idempotencyKey: IDEM_0
    });
    expect(canonical.dockLinks?.[LINK_2]).toBeUndefined();
    expect(shuffledWithReorg).toEqual(canonical);
  });
});

function bytes32(byte: string): Hex {
  return `0x${byte.repeat(32)}` as Hex;
}

function orderRegisteredEvent(
  blockNumber: bigint,
  logIndex: number,
  planId: Hex,
  orderId: Hex
): ChainEvent {
  return {
    chainId: CHAIN_ID,
    contractAddress: STATE_MACHINE,
    blockNumber,
    transactionHash: bytes32("a1"),
    transactionIndex: 0,
    logIndex,
    eventName: "OrderRegistered",
    args: { orderId, planId }
  };
}

function dockRegisteredEvent(
  blockNumber: bigint,
  logIndex: number,
  dkid: Hex,
  fromPlanId: Hex,
  toPlanId: Hex
): ChainEvent {
  return {
    chainId: CHAIN_ID,
    contractAddress: DOCK_CONTROLLER,
    blockNumber,
    transactionHash: bytes32("a2"),
    transactionIndex: 0,
    logIndex,
    eventName: "DockRegistered",
    args: {
      dkid,
      fromPlanId,
      toPlanId,
      fromSourceId: FROM_SOURCE,
      toStageId: TO_STAGE,
      toSourceId: TO_SOURCE,
      docHash: DOC_HASH,
      publisher: PUBLISHER,
      outputs: [
        { signalId: SIGNAL_0, relation: 0, atoms: [], window: [] },
        { signalId: SIGNAL_1, relation: 0, atoms: [], window: [] }
      ]
    }
  };
}

function dockLinkBoundEvent(
  blockNumber: bigint,
  logIndex: number,
  args: {
    readonly linkId: Hex;
    readonly dkid: Hex;
    readonly fromPlanId: Hex;
    readonly fromOrderId: Hex;
    readonly toPlanId: Hex;
    readonly toOrderId: Hex;
    readonly toStageId: Hex;
    readonly toConsentStageId: Hex;
    readonly toConsent: Address;
  }
): ChainEvent {
  return {
    chainId: CHAIN_ID,
    contractAddress: DOCK_CONTROLLER,
    blockNumber,
    transactionHash: bytes32("a3"),
    transactionIndex: 0,
    logIndex,
    eventName: "DockLinkBound",
    args
  };
}

function dockOutputSubmittedEvent(
  blockNumber: bigint,
  logIndex: number,
  args: {
    readonly linkId: Hex;
    readonly outputIndex: bigint;
    readonly toPlanId: Hex;
    readonly toOrderId: Hex;
    readonly toSourceId: Hex;
    readonly signalId: Hex;
    readonly payloadHash: Hex;
    readonly idempotencyKey: Hex;
  }
): ChainEvent {
  return {
    chainId: CHAIN_ID,
    contractAddress: DOCK_CONTROLLER,
    blockNumber,
    transactionHash: bytes32("a4"),
    transactionIndex: 0,
    logIndex,
    eventName: "DockOutputSubmitted",
    args
  };
}
