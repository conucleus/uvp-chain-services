// V3 任务投影：只根据配置 stage/slot、已接受的 slot 绑定、stage 状态与
// 窗口期限派生待办；不写回订单，不引入第二套状态词表。未知状态不产生动作。

import type { StageTaskKindV3 } from "@uvp-eth/product-dto";
import type { OrderStageRecord, OrderStageSlotRecord } from "../order/v3/types.js";
import type { TaskListViewV3, TaskProjectionInput, TaskViewV3 } from "./types.js";

const PRE_WORK_STATES = new Set(["draft", "ready"]);
const DONE_STATES = new Set(["completed", "skipped"]);

export function projectTasks(input: TaskProjectionInput): TaskListViewV3 {
  const { decision, snapshot } = input;
  if (decision.scope === "operator") {
    return { dataState: "none", orderId: snapshot.order.orderId, items: [] };
  }
  const stages = snapshot.stages.filter((stage) => decision.stageKeys.has(stage.stageKey));
  const tasks: TaskViewV3[] = [];
  for (const stage of stages) {
    const stageSlots = snapshot.slots.filter((slot) => slot.stageKey === stage.stageKey);
    if (decision.scope === "buyer") {
      tasks.push(...buyerTasks(snapshot.order.orderId, decision.wallet, stage, stageSlots));
    } else if (decision.scope === "performer") {
      tasks.push(...performerTasks(snapshot.order.orderId, decision.wallet, stage, stageSlots));
    } else {
      tasks.push(...verifierTasks(snapshot.order.orderId, decision.wallet, stage, stageSlots));
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
): readonly TaskViewV3[] {
  const payerSlot = slots.find((slot) => slot.slotKey === stage.payerSlot);
  if (!payerSlot || payerSlot.status === "accepted" || DONE_STATES.has(stage.status)) {
    return [];
  }
  return [
    task(orderId, wallet, stage, payerSlot.slotKey, "accept_invite", "open", "确认条款", {
      actionRef: `accept:${payerSlot.slotKey}`,
      ...(stage.inviteDeadline !== undefined ? { dueAt: stage.inviteDeadline } : {}),
    }),
  ];
}

function performerTasks(
  orderId: string,
  wallet: string,
  stage: OrderStageRecord,
  slots: readonly OrderStageSlotRecord[],
): readonly TaskViewV3[] {
  const payeeSlot = slots.find(
    (slot) => slot.slotKey === stage.payeeSlot && slot.status === "accepted" && slot.wallet?.toLowerCase() === wallet,
  );
  if (!payeeSlot || DONE_STATES.has(stage.status)) {
    return [];
  }
  return [
    task(
      orderId,
      wallet,
      stage,
      payeeSlot.slotKey,
      "perform_stage",
      PRE_WORK_STATES.has(stage.status) ? "blocked" : "open",
      "履约/提交",
      {
        ...(stage.workDeadline !== undefined ? { dueAt: stage.workDeadline } : {}),
        actionRef: `perform:${stage.stageKey}`,
        ...(PRE_WORK_STATES.has(stage.status) ? { blockedBy: [`stage:${stage.status}`] } : {}),
      },
    ),
  ];
}

function verifierTasks(
  orderId: string,
  wallet: string,
  stage: OrderStageRecord,
  slots: readonly OrderStageSlotRecord[],
): readonly TaskViewV3[] {
  const verifierSlot = slots.find(
    (slot) => slot.slotKey === stage.verifierSlot && slot.status === "accepted" && slot.wallet?.toLowerCase() === wallet,
  );
  if (!verifierSlot || DONE_STATES.has(stage.status)) {
    return [];
  }
  return [
    task(orderId, wallet, stage, verifierSlot.slotKey, "verify_stage", "blocked", "验收", {
      ...(stage.workDeadline !== undefined ? { dueAt: stage.workDeadline } : {}),
      actionRef: `verify:${stage.stageKey}`,
      blockedBy: [`perform:${stage.stageKey}`],
    }),
  ];
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
