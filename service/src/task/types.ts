// 任务投影类型：tasks 是从订单/stage/slot/window/事实状态派生的读模型，
// 不是新的状态机；拒绝写回或推进订单。

import type { StageTaskKind, StageTaskStatus } from "@uvp-eth/product-dto";
import type { OrderVisibilitySnapshot } from "../order/service.js";
import type { VisibilityDecision } from "../visibility/types.js";

export interface TaskView {
  readonly taskId: string;
  readonly orderId: string;
  readonly stageKey: string;
  readonly slotKey: string;
  readonly wallet: string;
  readonly kind: StageTaskKind;
  readonly status: StageTaskStatus;
  readonly nextAction: string;
  readonly dueAt?: string;
  readonly actionRef?: string;
  readonly blockedBy?: readonly string[];
}

export interface TaskListView {
  readonly dataState: "ok" | "none" | "pending" | "unknown";
  readonly orderId?: string;
  readonly stageKey?: string;
  readonly items: readonly TaskView[];
}

export interface TaskProjectionInput {
  readonly decision: VisibilityDecision;
  readonly snapshot: OrderVisibilitySnapshot;
  readonly now: Date;
}
