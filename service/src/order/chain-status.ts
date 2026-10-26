// 订单/阶段状态的链上派生：order_stage_v3.status 与 order_v3.status 是开单
// 时的静态行，触发后不再推进；读面一律以链投影派生（StageMaterialized /
// hook task），stage 走 pending → active → done，金额为 0 的段保持 skipped。
// 本模块只做投影到状态词的映射，不写库、不补事实；投影缺失时保持未知。

import type { StageStatus } from "@uvp-eth/product-dto";
import type { ChainOrderProjection } from "./ports.js";
import type { OrderRecord, OrderStageRecord } from "./types.js";

export type DerivedStageStatus = StageStatus | "skipped";

export const FINAL_STAGE_STATUSES: ReadonlySet<string> = new Set(["done", "skipped"]);

export interface OrderChainStatusInput {
  readonly order: OrderRecord;
  readonly stages: readonly OrderStageRecord[];
  readonly chainOrders: readonly ChainOrderProjection[];
}

export interface OrderChainStatus {
  readonly order: OrderRecord;
  readonly stages: readonly OrderStageRecord[];
}

export function deriveOrderChainStatus(input: OrderChainStatusInput): OrderChainStatus {
  const chainOrder = matchChainOrder(input.order, input.chainOrders);
  return {
    order: {
      ...input.order,
      status: chainOrder ? chainOrder.status : "unknown"
    },
    stages: input.stages.map((stage) => ({
      ...stage,
      status: deriveStageStatus(stage, chainOrder)
    }))
  };
}

function matchChainOrder(
  order: OrderRecord,
  chainOrders: readonly ChainOrderProjection[]
): ChainOrderProjection | undefined {
  const planId = order.planId.toLowerCase();
  return chainOrders.find((candidate) => candidate.planId.toLowerCase() === planId);
}

function deriveStageStatus(
  stage: OrderStageRecord,
  chainOrder: ChainOrderProjection | undefined
): DerivedStageStatus {
  if (stage.amount === "0") {
    return "skipped";
  }
  if (!chainOrder) {
    return "pending";
  }
  const stageId = stage.stageId.toLowerCase();
  if (!stageIsMaterialized(chainOrder, stageId)) {
    return "pending";
  }
  const tasks = Object.values(chainOrder.tasks).filter(
    (task) => task.stageIdentifier?.toLowerCase() === stageId
  );
  return tasks.length > 0 && tasks.every((task) => task.status === "submitted")
    ? "done"
    : "active";
}

function stageIsMaterialized(chainOrder: ChainOrderProjection, stageId: string): boolean {
  if (chainOrder.currentStage?.toLowerCase() === stageId) {
    return true;
  }
  return Object.values(chainOrder.stageMaterializations).some(
    (entry) => entry.stageId.toLowerCase() === stageId
  );
}
