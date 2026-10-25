// V3 任务读服务：先过唯一 visibility resolver，再按已接受 slot 绑定投影
// tasks。任务不写回订单；stage task view 只返回该 stage 的投影。

import type { Address } from "../shared/types.js";
import type { OrderV3VisibilitySnapshot } from "../order/v3/service.js";
import { OrderV3Error } from "../order/v3/types.js";
import type { VisibilityResolver } from "../visibility/types.js";
import { projectTasks } from "./projection.js";
import type { TaskListViewV3 } from "./types.js";

export interface TaskServiceOptions {
  readonly visibility: VisibilityResolver;
  readonly loadOrder: (orderId: string) => Promise<OrderV3VisibilitySnapshot | undefined>;
  readonly now?: () => Date;
}

export interface TaskService {
  listTasks(wallet: Address, orderId: string): Promise<TaskListViewV3>;
  listStageTasks(wallet: Address, orderId: string, stageKey: string): Promise<TaskListViewV3>;
}

export function createTaskService(options: TaskServiceOptions): TaskService {
  const now = options.now ?? (() => new Date());
  return {
    async listTasks(wallet, orderId) {
      return projection(wallet, orderId, undefined);
    },
    async listStageTasks(wallet, orderId, stageKey) {
      return projection(wallet, orderId, stageKey);
    },
  };

  async function projection(wallet: Address, orderId: string, stageKey: string | undefined): Promise<TaskListViewV3> {
    const decision = await options.visibility.resolveVisibility(orderId, stageKey, wallet);
    const snapshot = await options.loadOrder(orderId);
    if (!snapshot) {
      throw new OrderV3Error(404, "order_not_found", "order was not found");
    }
    const all = projectTasks({ decision, snapshot, now: now() });
    const items = stageKey === undefined
      ? all.items
      : all.items.filter((task) => task.stageKey === stageKey);
    const dataState = items.length === 0 ? "none" : items.some((task) => task.status === "blocked") ? "pending" : all.dataState;
    return {
      dataState,
      orderId,
      ...(stageKey !== undefined ? { stageKey } : {}),
      items,
    };
  }
}
