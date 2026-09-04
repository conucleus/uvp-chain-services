import { describe, expect, it } from "vitest";
import { createProductService } from "../src/product/service.js";
import {
  rebuildOrderProjections,
  stateMachineScopedKey,
  stateMachineTaskProjectionKey,
} from "../src/indexer/projections.js";
import type { ChainEvent } from "../src/indexer/events.js";
import { MemoryProjectionStore } from "../src/storage/projection-store.js";
import type { Address, Hex } from "../src/shared/types.js";

const stateMachineAddress = "0x1111111111111111111111111111111111111111" as Address;
const walletA = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Address;
const walletB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Address;
const planA = word("a1");
const planB = word("b1");
const orderId = word("c1");
const hookId = word("d1");
const stageId = word("e1");
const sourceId = word("f1");
const signalId = word("f2");

describe("plan-scoped state-machine identities", () => {
  it("keeps reused order and hook ids separate and rejects bare lookups", async () => {
    const events = collisionEvents();
    const snapshot = rebuildOrderProjections(events);
    const orderKeyA = stateMachineScopedKey(31337, stateMachineAddress, planA, orderId);
    const orderKeyB = stateMachineScopedKey(31337, stateMachineAddress, planB, orderId);
    const taskKeyA = stateMachineTaskProjectionKey(31337, stateMachineAddress, planA, orderId, hookId);
    const taskKeyB = stateMachineTaskProjectionKey(31337, stateMachineAddress, planB, orderId, hookId);

    expect(Object.keys(snapshot.stateMachineOrders).sort()).toEqual([orderKeyA, orderKeyB].sort());
    expect(snapshot.stateMachineOrders[orderKeyA]?.signals[`${sourceId}:${signalId}`]?.payloadHash).toBe(word("a2"));
    expect(snapshot.stateMachineOrders[orderKeyB]?.signals[`${sourceId}:${signalId}`]?.payloadHash).toBe(word("b2"));
    expect(Object.keys(snapshot.stateMachineTasks).sort()).toEqual([taskKeyA, taskKeyB].sort());
    expect(snapshot.stateMachineTasks[taskKeyA]?.planId).toBe(planA);
    expect(snapshot.stateMachineTasks[taskKeyB]?.planId).toBe(planB);

    const store = new MemoryProjectionStore();
    await store.resetFromEvents({ deploymentBlock: 0n, events });
    await expect(store.getStateMachineOrder(orderId)).resolves.toBeUndefined();
    await expect(store.getStateMachineOrder(orderKeyA)).resolves.toMatchObject({ planId: planA });
    await expect(store.getStateMachineTask(`${stateMachineAddress}:${orderId}:${hookId}`)).resolves.toBeUndefined();
    await expect(store.getStateMachineTask(taskKeyB)).resolves.toMatchObject({ planId: planB });
    await expect(store.listStateMachineOrders()).resolves.toHaveLength(2);
    await expect(store.listStateMachineTasks()).resolves.toHaveLength(2);
  });

  it("does not leak a plan when participant visibility starts with a bare accepted order id", async () => {
    const events = collisionEvents();
    const store = new MemoryProjectionStore();
    await store.resetFromEvents({ deploymentBlock: 0n, events });
    const product = createProductService(store);

    const ambiguous = await product.getParticipantView({
      walletAddress: walletA,
      acceptedParticipants: [{
        participantId: "participant-a",
        displayName: "Participant A",
        walletAddress: walletA,
        roleLabel: "执行方",
        roleSlotId: "slot-a",
        draftId: "draft-a",
        draftTitle: "Draft A",
        orderId,
      }],
    });
    expect(ambiguous.orders).toHaveLength(1);
    expect(ambiguous.orders[0]?.planId).toBe(planA);
    expect(ambiguous.tasks).toHaveLength(1);
    expect(ambiguous.tasks[0]?.assigneeWallet).toBe(walletA);

    const canonical = await product.getParticipantView({
      walletAddress: "0xcccccccccccccccccccccccccccccccccccccccc",
      acceptedParticipants: [{
        participantId: "participant-c",
        displayName: "Participant C",
        walletAddress: "0xcccccccccccccccccccccccccccccccccccccccc",
        roleLabel: "查看方",
        roleSlotId: "slot-c",
        draftId: "draft-c",
        draftTitle: "Draft C",
        orderId: stateMachineScopedKey(31337, stateMachineAddress, planB, orderId),
      }],
    });
    expect(canonical.orders).toHaveLength(1);
    expect(canonical.orders[0]?.planId).toBe(planB);
    expect(canonical.tasks).toHaveLength(0);
  });
});

function collisionEvents(): readonly ChainEvent[] {
  return [
    event(1n, "PlanRegistered", { planId: planA, planHash: word("a0"), hookCount: 1n }),
    event(2n, "PlanRegistered", { planId: planB, planHash: word("b0"), hookCount: 1n }),
    event(3n, "OrderRegistered", { orderId, planId: planA }),
    event(4n, "OrderRegistered", { orderId, planId: planB }),
    event(5n, "SignalCapabilityRegistered", {
      planId: planA,
      stageId,
      targetSourceId: hookId,
      signalId: hookId,
      targetOrderRelation: 0,
    }),
    event(6n, "SignalCapabilityRegistered", {
      planId: planB,
      stageId,
      targetSourceId: hookId,
      signalId: hookId,
      targetOrderRelation: 0,
    }),
    event(7n, "SignalSubmitterAuthorized", {
      planId: planA,
      orderId,
      sourceId: hookId,
      signalId: hookId,
      submitter: walletA,
      role: word("ra"),
      metadataHash: word("ma"),
    }),
    event(8n, "SignalSubmitterAuthorized", {
      planId: planB,
      orderId,
      sourceId: hookId,
      signalId: hookId,
      submitter: walletB,
      role: word("rb"),
      metadataHash: word("mb"),
    }),
    event(9n, "HookReady", { planId: planA, orderId, hookId, stageId, hookName: word("ha") }),
    event(10n, "HookReady", { planId: planB, orderId, hookId, stageId, hookName: word("hb") }),
    event(11n, "SignalSubmitted", {
      planId: planA,
      orderId,
      sourceId,
      signalId,
      payloadHash: word("a2"),
      idempotencyKey: word("a3"),
      submitter: walletA,
    }),
    event(12n, "SignalSubmitted", {
      planId: planB,
      orderId,
      sourceId,
      signalId,
      payloadHash: word("b2"),
      idempotencyKey: word("b3"),
      submitter: walletB,
    }),
  ];
}

function event(
  blockNumber: bigint,
  eventName: string,
  args: Record<string, unknown>,
): ChainEvent {
  return {
    chainId: 31337,
    contractAddress: stateMachineAddress,
    blockNumber,
    blockHash: word(`b${blockNumber}`),
    transactionHash: word(`t${blockNumber}`),
    transactionIndex: 0,
    logIndex: 0,
    eventName,
    args,
  };
}

function word(value: string): Hex {
  return `0x${Buffer.from(value, "utf8").toString("hex").padStart(64, "0").slice(-64)}` as Hex;
}
