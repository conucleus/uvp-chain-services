// V3 订单/阶段状态与任务投影的聚焦用例：状态只从链投影派生（未上链 pending、
// StageMaterialized 后 active、链任务全部 submitted 后 done），履约待办随
// 派生状态 blocked → open → done，不再停在静态 draft 上。

import { describe, expect, it } from "vitest";
import type { ConfigBundle } from "@uvp-eth/product-dto";
import {
  deriveOrderChainStatus,
  FINAL_STAGE_STATUSES,
  type ChainOrderProjection,
  type OrderDraftRecord,
  type OrderRecord,
  type OrderStageRecord,
  type OrderStageSlotRecord,
} from "../src/order/index.js";
import type { OrderVisibilitySnapshot } from "../src/order/service.js";
import { createTaskService } from "../src/task/index.js";
import { createVisibilityResolver } from "../src/visibility/index.js";
import type { Address, Hex } from "../src/shared/types.js";

const orderId = `0x${"31".repeat(32)}`;
const planId = `0x${"32".repeat(32)}`;
const alphaStageId = `0x${"33".repeat(32)}`;
const betaStageId = `0x${"34".repeat(32)}`;
const buyerWallet = `0x${"35".repeat(20)}` as Address;
const performerWallet = `0x${"36".repeat(20)}` as Address;
const createdAt = "2026-10-20T00:00:00.000Z";
const termsHash = `0x${"37".repeat(32)}` as Hex;

const order: OrderRecord = {
  orderId,
  draftId: "draft-1",
  planId,
  stateMachine: `0x${"38".repeat(20)}` as Address,
  chainId: 31337,
  buyerWallet,
  termsHash,
  status: "unknown",
  createdAt,
  updatedAt: createdAt
};

const draft: OrderDraftRecord = {
  draftId: "draft-1",
  configId: "test/flow",
  configVersion: "1.0.0",
  configHash: `0x${"39".repeat(32)}` as Hex,
  buyerWallet,
  chainId: 31337,
  stateMachine: order.stateMachine,
  title: "Order",
  currency: "tok-1",
  stageSubset: ["alpha", "beta"],
  status: "triggered",
  createdAt,
  updatedAt: createdAt
};

const config = {
  configId: "test/flow",
  version: "1.0.0",
  status: "published",
  title: "Flow",
  currency: "tok-1",
  slots: [{ key: "performer", kind: "participant" }],
  stages: [
    { key: "alpha", name: "Alpha", index: 1, funded: true, slots: { performer: "performer" } },
    { key: "beta", name: "Beta", index: 2, funded: true, slots: { performer: "performer" } }
  ]
} as unknown as ConfigBundle;

function stage(
  stageKey: string,
  stageId: string,
  index: number,
  overrides: Partial<OrderStageRecord> = {}
): OrderStageRecord {
  return {
    draftId: draft.draftId,
    stageKey,
    stageId: stageId as Hex,
    stageIndex: index,
    amount: "1000000",
    slots: { performer: performerWallet },
    finalStandardHash: `0x${"40".repeat(32)}` as Hex,
    inviteDeadline: "2026-11-01T00:00:00.000Z",
    workDeadline: "2026-11-20T00:00:00.000Z",
    termsHash,
    status: "draft",
    createdAt,
    updatedAt: createdAt,
    ...overrides
  };
}

const sketchStages = [
  stage("alpha", alphaStageId, 1),
  stage("beta", betaStageId, 2)
];

const performerSlot: OrderStageSlotRecord = {
  draftId: draft.draftId,
  stageKey: "alpha",
  slotKey: "performer",
  required: true,
  wallet: performerWallet,
  status: "accepted",
  createdAt,
  updatedAt: createdAt
};

function chainOrder(overrides: Partial<ChainOrderProjection> = {}): ChainOrderProjection {
  return {
    orderId,
    planId,
    status: "registered",
    stageMaterializations: { [alphaStageId]: { stageId: alphaStageId } },
    tasks: {},
    ...overrides
  };
}

function snapshotWithStatuses(statuses: readonly string[]): OrderVisibilitySnapshot {
  return {
    order,
    draft,
    config,
    stages: sketchStages.map((item, index) => ({ ...item, status: statuses[index] ?? "draft" })),
    slots: [performerSlot]
  };
}

describe("chain-derived order status", () => {
  it("derives pending/active/done/skipped from chain projection instead of the static row status", () => {
    const unmaterialized = deriveOrderChainStatus({ order, stages: sketchStages, chainOrders: [] });
    expect(unmaterialized.order.status).toBe("unknown");
    expect(unmaterialized.stages.map((item) => item.status)).toEqual(["pending", "pending"]);

    const materialized = deriveOrderChainStatus({ order, stages: sketchStages, chainOrders: [chainOrder()] });
    expect(materialized.order.status).toBe("registered");
    expect(materialized.stages.map((item) => item.status)).toEqual(["active", "pending"]);

    const submitted = deriveOrderChainStatus({
      order,
      stages: sketchStages,
      chainOrders: [chainOrder({
        tasks: {
          "alpha-task": { stageIdentifier: alphaStageId, status: "submitted" }
        }
      })]
    });
    expect(submitted.stages[0]!.status).toBe("done");
    expect(FINAL_STAGE_STATUSES.has("done")).toBe(true);

    const skipped = deriveOrderChainStatus({
      order,
      stages: [stage("alpha", alphaStageId, 1, { amount: "0" }), stage("beta", betaStageId, 2)],
      chainOrders: [chainOrder({
        stageMaterializations: { [betaStageId]: { stageId: betaStageId } }
      })]
    });
    expect(skipped.stages.map((item) => item.status)).toEqual(["skipped", "active"]);
  });
});

describe("task projection follows the derived stage status", () => {
  async function listPerformTask(stageStatuses: readonly string[]) {
    const snapshot = snapshotWithStatuses(stageStatuses);
    const tasks = createTaskService({
      visibility: createVisibilityResolver({ loadOrder: async () => snapshot }),
      loadOrder: async () => snapshot,
      now: () => new Date("2026-10-25T00:00:00.000Z")
    });
    return tasks.listStageTasks(performerWallet, orderId, "alpha");
  }

  it("blocks the perform task before materialization and opens it once active", async () => {
    const pending = await listPerformTask(["pending", "pending"]);
    expect(pending.items).toHaveLength(1);
    expect(pending.items[0]).toMatchObject({
      kind: "perform_stage",
      status: "blocked",
      blockedBy: ["stage:pending"]
    });
    expect(pending.dataState).toBe("pending");

    const active = await listPerformTask(["active", "pending"]);
    expect(active.items).toHaveLength(1);
    expect(active.items[0]).toMatchObject({
      kind: "perform_stage",
      status: "open",
      actionRef: "perform:alpha"
    });
    expect(active.items[0]!.blockedBy).toBeUndefined();
  });

  it("drops the perform task when the chain reports the stage tasks submitted", async () => {
    const done = await listPerformTask(["done", "active"]);
    expect(done.items).toEqual([]);
    expect(done.dataState).toBe("none");
  });
});
