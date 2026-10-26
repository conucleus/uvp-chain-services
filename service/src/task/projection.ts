// 任务投影：只根据配置 stage/slot、已接受的 slot 绑定、chain 派生的 stage
// 状态与窗口期限派生待办；不写回订单，不引入第二套状态词表。stage 未上链
// 时履约待办是 blocked（不是永远 open），上链后 open，链上任务提交后 done。

import type { StageTaskKind } from "@uvp-eth/product-dto";
import { FINAL_STAGE_STATUSES } from "../order/chain-status.js";
import type { OrderStageRecord, OrderStageSlotRecord } from "../order/types.js";
import type { TaskListView, TaskProjectionInput, TaskView } from "./types.js";

const OPEN_STAGE_STATUS = "active";

export function projectTasks(input: TaskProjectionInput): TaskListView {
  const { decision, snapshot } = input;
  if (decision.scope === "operator") {
    return { dataState: "none", orderId: snapshot.order.orderId, items: [] };
  }
  const stages = snapshot.stages.filter((stage) => decision.stageKeys.has(stage.stageKey));
  const tasks: TaskView[] = [];
  for (const stage of stages) {
    const stageSlots = snapshot.slots.filter((slot) => slot.stageKey === stage.stageKey);
    if (decision.scope === "buyer") {
      tasks.push(...ownerTasks(snapshot.order.orderId, decision.wallet, stage, stageSlots));
    } else {
      tasks.push(...executorTasks(snapshot.order.orderId, decision.wallet, stage, stageSlots));
    }
  }
  tasks.sort(compareTasks);
  return {
    dataState: tasks.length === 0 ? "none" : tasks.some((task) => task.status === "blocked") ? "pending" : "ok",
    orderId: snapshot.order.orderId,
    items: tasks,
  };
}

function ownerTasks(
  orderId: string,
  wallet: string,
  stage: OrderStageRecord,
  slots: readonly OrderStageSlotRecord[],
): readonly TaskView[] {
  if (FINAL_STAGE_STATUSES.has(stage.status)) {
    return [];
  }
  return slots
    .filter((slot) => slot.status === "uninvited" || slot.status === "invited")
    .map((slot) => task(orderId, wallet, stage, slot.slotKey, "accept_invite", "open", "邀请参与者", {
      actionRef: `invite:${slot.slotKey}`,
      ...(stage.inviteDeadline !== undefined ? { dueAt: stage.inviteDeadline } : {}),
    }));
}

function executorTasks(
  orderId: string,
  wallet: string,
  stage: OrderStageRecord,
  slots: readonly OrderStageSlotRecord[],
): readonly TaskView[] {
  const invited = slots.find(
    (slot) => slot.status === "invited" && slot.wallet?.toLowerCase() === wallet,
  );
  if (invited) {
    return [
      task(orderId, wallet, stage, invited.slotKey, "accept_invite", "open", "接受邀请", {
        actionRef: `accept:${invited.slotKey}`,
      }),
    ];
  }
  const own = slots.find(
    (slot) => slot.status === "accepted" && slot.wallet?.toLowerCase() === wallet,
  );
  if (!own || FINAL_STAGE_STATUSES.has(stage.status)) {
    return [];
  }
  const open = stage.status === OPEN_STAGE_STATUS;
  return [
    task(orderId, wallet, stage, own.slotKey, "perform_stage", open ? "open" : "blocked", "履约/提交", {
      ...(stage.workDeadline !== undefined ? { dueAt: stage.workDeadline } : {}),
      actionRef: `perform:${stage.stageKey}`,
      ...(open ? {} : { blockedBy: [`stage:${stage.status}`] }),
    }),
  ];
}

function task(
  orderId: string,
  wallet: string,
  stage: OrderStageRecord,
  slotKey: string,
  kind: StageTaskKind,
  status: TaskView["status"],
  nextAction: string,
  extra: Pick<TaskView, "dueAt" | "actionRef" | "blockedBy">,
): TaskView {
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

function compareTasks(left: TaskView, right: TaskView): number {
  const leftDue = left.dueAt ?? "";
  const rightDue = right.dueAt ?? "";
  return leftDue.localeCompare(rightDue) || left.stageKey.localeCompare(right.stageKey) || left.kind.localeCompare(right.kind);
}
