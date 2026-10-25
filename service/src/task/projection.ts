// V3 任务投影：只根据配置 stage/slot、已接受的 slot 绑定、stage 状态与
// 窗口期限派生待办；不写回订单，不引入第二套状态词表。未知状态不产生动作。

import type { StageTaskKindV3 } from "@uvp-eth/product-dto";
import type { OrderStageRecord, OrderStageSlotRecord } from "../order/v3/types.js";
import type { TaskListViewV3, TaskProjectionInput, TaskViewV3 } from "./types.js";

const BUYER_FUND_STATES = new Set(["draft", "inviting", "terms_frozen", "deposit_pending"]);
const PERFORMER_WAIT_STATES = new Set(["draft", "inviting", "terms_frozen", "deposit_pending"]);
const PERFORMED_STATES = new Set(["performed", "submitted"]);
const PERFORMER_OPEN_STATES = new Set(["funded", "deposit_confirmed"]);
const SETTLE_STATES = new Set(["verified", "accepted", "disputed"]);

export function projectTasks(input: TaskProjectionInput): TaskListViewV3 {
  const { decision, snapshot, now } = input;
  if (decision.scope === "operator") {
    return { dataState: "none", orderId: snapshot.order.orderId, items: [] };
  }
  const stages = snapshot.stages.filter((stage) => decision.stageKeys.has(stage.stageKey));
  const tasks: TaskViewV3[] = [];
  for (const stage of stages) {
    const stageSlots = snapshot.slots.filter((slot) => slot.stageKey === stage.stageKey);
    if (decision.scope === "buyer") {
      tasks.push(...buyerTasks(snapshot.order.orderId, decision.wallet, stage, stageSlots, now));
    } else if (decision.scope === "performer") {
      tasks.push(...performerTasks(snapshot.order.orderId, decision.wallet, stage, stageSlots, now));
    } else {
      tasks.push(...verifierTasks(snapshot.order.orderId, decision.wallet, stage, stageSlots, now));
    }
  }
  tasks.sort(compareTasks);
  return {
    dataState: tasks.length === 0 ? "none" : tasks.some((task) => task.status === "blocked") ? "pending" : "ok",
    orderId: snapshot.order.orderId,
    items: tasks,
  };
}

function buyerTasks(
  orderId: string,
  wallet: string,
  stage: OrderStageRecord,
  slots: readonly OrderStageSlotRecord[],
  now: Date,
): readonly TaskViewV3[] {
  if (!BUYER_FUND_STATES.has(stage.status)) {
    if (SETTLE_STATES.has(stage.status)) {
      return [task(orderId, wallet, stage, stage.payerSlot, "settle_stage", "open", "处理结算/争议", {
        actionRef: `settle:${stage.stageKey}`,
        ...(stage.workDeadline !== undefined ? { dueAt: stage.workDeadline } : {}),
      })];
    }
    return [];
  }
  const requiredPayees = slots.filter(
    (slot) => slot.required && slot.slotKey !== stage.payerSlot && slot.status !== "accepted",
  );
  const blockedBy = requiredPayees.map((slot) => `accept:${slot.slotKey}`);
  return [
    task(orderId, wallet, stage, stage.payerSlot, "fund_stage", blockedBy.length > 0 ? "blocked" : "open", "冻款", {
      ...(stage.inviteDeadline !== undefined ? { dueAt: stage.inviteDeadline } : {}),
      actionRef: `fund:${stage.stageKey}`,
      ...(blockedBy.length > 0 ? { blockedBy } : {}),
    }),
  ];
}

function performerTasks(
  orderId: string,
  wallet: string,
  stage: OrderStageRecord,
  slots: readonly OrderStageSlotRecord[],
  _now: Date,
): readonly TaskViewV3[] {
  const payeeSlot = slots.find(
    (slot) => slot.slotKey === stage.payeeSlot && slot.status === "accepted" && slot.wallet?.toLowerCase() === wallet,
  );
  if (!payeeSlot) {
    return [];
  }
  if (SETTLE_STATES.has(stage.status)) {
    return [task(orderId, wallet, stage, payeeSlot.slotKey, "settle_stage", "open", "处理结算/争议", {
      actionRef: `settle:${stage.stageKey}`,
    })];
  }
  if (PERFORMED_STATES.has(stage.status)) {
    return [];
  }
  if (!PERFORMER_WAIT_STATES.has(stage.status) && !PERFORMER_OPEN_STATES.has(stage.status)) {
    return [];
  }
  return [
    task(orderId, wallet, stage, payeeSlot.slotKey, "perform_stage", PERFORMER_WAIT_STATES.has(stage.status) ? "blocked" : "open", "履约/提交", {
      ...(stage.workDeadline !== undefined ? { dueAt: stage.workDeadline } : {}),
      actionRef: `perform:${stage.stageKey}`,
      ...(PERFORMER_WAIT_STATES.has(stage.status) ? { blockedBy: [`fund:${stage.stageKey}`] } : {}),
    }),
  ];
}

function verifierTasks(
  orderId: string,
  wallet: string,
  stage: OrderStageRecord,
  slots: readonly OrderStageSlotRecord[],
  _now: Date,
): readonly TaskViewV3[] {
  const verifierSlot = slots.find(
    (slot) => slot.slotKey === stage.verifierSlot && slot.status === "accepted" && slot.wallet?.toLowerCase() === wallet,
  );
  if (!verifierSlot) {
    return [];
  }
  if (SETTLE_STATES.has(stage.status)) {
    return [task(orderId, wallet, stage, verifierSlot.slotKey, "settle_stage", "open", "处理结算/争议", {
      actionRef: `settle:${stage.stageKey}`,
    })];
  }
  if (PERFORMED_STATES.has(stage.status)) {
    return [task(orderId, wallet, stage, verifierSlot.slotKey, "verify_stage", "open", "验收", {
      ...(stage.workDeadline !== undefined ? { dueAt: stage.workDeadline } : {}),
      actionRef: `verify:${stage.stageKey}`,
    })];
  }
  return [task(orderId, wallet, stage, verifierSlot.slotKey, "verify_stage", "blocked", "验收", {
    ...(stage.workDeadline !== undefined ? { dueAt: stage.workDeadline } : {}),
    actionRef: `verify:${stage.stageKey}`,
    blockedBy: [`perform:${stage.stageKey}`],
  })];
}

function task(
  orderId: string,
  wallet: string,
  stage: OrderStageRecord,
  slotKey: string,
  kind: StageTaskKindV3,
  status: TaskViewV3["status"],
  nextAction: string,
  extra: Pick<TaskViewV3, "dueAt" | "actionRef" | "blockedBy">,
): TaskViewV3 {
  return {
    taskId: `task:${orderId}:${stage.stageKey}:${slotKey}:${kind}`,
    orderId,
    stageKey: stage.stageKey,
    slotKey,
    wallet,
    kind,
    status,
    nextAction,
    ...(extra.dueAt !== undefined ? { dueAt: extra.dueAt } : {}),
    ...(extra.actionRef !== undefined ? { actionRef: extra.actionRef } : {}),
    ...(extra.blockedBy !== undefined ? { blockedBy: extra.blockedBy } : {}),
  };
}

function compareTasks(left: TaskViewV3, right: TaskViewV3): number {
  const leftDue = left.dueAt ?? "";
  const rightDue = right.dueAt ?? "";
  return leftDue.localeCompare(rightDue) || left.stageKey.localeCompare(right.stageKey) || left.kind.localeCompare(right.kind);
}
