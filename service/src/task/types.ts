// V3 任务投影类型：tasks 是从订单/stage/slot/window/事实状态派生的读模型，
// 不是新的状态机；拒绝写回或推进订单。

import type { StageTaskKindV3, StageTaskStatusV3 } from "@uvp-eth/product-dto";
import type { OrderV3VisibilitySnapshot } from "../order/v3/service.js";
import type { VisibilityDecision } from "../visibility/types.js";

export interface TaskViewV3 {
  readonly taskId: string;
  readonly orderId: string;
  readonly stageKey: string;
  readonly slotKey: string;
  readonly wallet: string;
  readonly kind: StageTaskKindV3;
  readonly status: StageTaskStatusV3;
  readonly nextAction: string;
  readonly dueAt?: string;
  readonly actionRef?: string;
  readonly blockedBy?: readonly string[];
}

export interface TaskListViewV3 {
  readonly dataState: "ok" | "none" | "pending" | "unknown";
  readonly orderId?: string;
  readonly stageKey?: string;
  readonly items: readonly TaskViewV3[];
}

export interface TaskProjectionInput {
  readonly decision: VisibilityDecision;
  readonly snapshot: OrderV3VisibilitySnapshot;
  readonly now: Date;
}
