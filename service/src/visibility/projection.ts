// V3 字段级读投影：按 VisibilityDecision 裁剪 order/stage/slot/标准/句柄。所有裁剪在服务端完成；DTO 允许字段由 scope 决定，调用方不得
// 把未授权字段“删掉后当 empty”返回。locator/URI 永不出现在句柄列表。

import type { ConfigFileResourceRefV3, ConfigStageV3 } from "@uvp-eth/product-dto";
import type { OrderV3VisibilitySnapshot } from "../order/v3/service.js";
import type { OrderStageRecord, OrderStageSlotRecord } from "../order/v3/types.js";
import { OrderV3Error } from "../order/v3/types.js";
import type {
  HandleViewV3,
  OperatorOrderViewV3,
  OrderViewV3,
  ResourceListViewV3,
  SlotViewV3,
  StageViewResponseV3,
  StageViewV3,
  StandardViewV3,
  VisibilityDecision,
} from "./types.js";

export function projectOrder(decision: VisibilityDecision, snapshot: OrderV3VisibilitySnapshot): OrderViewV3 {
  const stages = snapshot.stages
    .filter((stage) => decision.stageKeys.has(stage.stageKey))
    .map((stage) => projectStageView(decision, snapshot, stage));
  const base: OrderViewV3 = {
    orderId: snapshot.order.orderId,
    dataState: "ok",
    stages,
  };
  if (decision.scope === "operator") {
    return {
      ...base,
      planId: snapshot.order.planId,
      status: snapshot.order.status,
    };
  }
  const withOrder = {
    ...base,
    planId: snapshot.order.planId,
    chainId: snapshot.order.chainId,
    stateMachine: snapshot.order.stateMachine,
    status: snapshot.order.status,
  };
  if (decision.scope !== "buyer") {
    return withOrder;
  }
  return {
    ...withOrder,
    title: snapshot.draft.title,
    currency: snapshot.draft.currency,
    buyerWallet: snapshot.order.buyerWallet,
    termsHash: snapshot.order.termsHash,
    ...(snapshot.order.txHash !== undefined ? { txHash: snapshot.order.txHash } : {}),
    draftId: snapshot.order.draftId,
  };
}

export function projectStage(
  decision: VisibilityDecision,
  snapshot: OrderV3VisibilitySnapshot,
  stage: OrderStageRecord,
): StageViewResponseV3 {
  return {
    order: projectOrder(decision, snapshot),
    stage: projectStageView(decision, snapshot, stage),
    dataState: "ok",
  };
}

export function projectResources(
  decision: VisibilityDecision,
  stageKey: string,
  stageConfig: ConfigStageV3 | undefined,
): ResourceListViewV3 {
  if (!decision.allowed.evidenceHandles || decision.scope === "operator") {
    throw new OrderV3Error(403, "visibility_denied", "the current scope cannot read stage file handles", {
      resource: "file_resources",
      stageKey,
    });
  }
  const items = (stageConfig?.fileResources ?? []).map(handleView);
  return items.length === 0
    ? { dataState: "none", stageKey, items: [] }
    : { dataState: "ok", stageKey, items };
}

export function projectOperatorOrder(
  decision: VisibilityDecision,
  snapshot: OrderV3VisibilitySnapshot,
): OperatorOrderViewV3 {
  if (decision.scope !== "operator") {
    throw new OrderV3Error(404, "order_not_found", "order was not found");
  }
  return {
    orderId: snapshot.order.orderId,
    planId: snapshot.order.planId,
    status: snapshot.order.status,
    dataState: "ok",
    stages: snapshot.stages.map((stage) => ({
      stageKey: stage.stageKey,
      index: stage.stageIndex,
      status: stage.status,
    })),
    exceptions: [],
  };
}

function projectStageView(
  decision: VisibilityDecision,
  snapshot: OrderV3VisibilitySnapshot,
  stage: OrderStageRecord,
): StageViewV3 {
  if (decision.scope === "operator") {
    return {
      stageKey: stage.stageKey,
      stageId: stage.stageId,
      index: stage.stageIndex,
      status: stage.status,
    };
  }
  const full = decision.scope === "buyer";
  const stageConfig = snapshot.config.stages.find((candidate) => candidate.key === stage.stageKey);
  const stageSlots = snapshot.slots.filter((slot) => slot.stageKey === stage.stageKey);
  const termsVisible = full || decision.allowed.amounts;
  return {
    stageKey: stage.stageKey,
    stageId: stage.stageId,
    index: stage.stageIndex,
    status: stage.status,
    ...(decision.allowed.amounts ? { amount: stage.amount, feeBps: stage.feeBps } : {}),
    ...(termsVisible
      ? {
          acceptanceMode: stage.acceptanceMode,
          verifierMode: stage.verifierMode,
          finalStandardHash: stage.finalStandardHash,
          inviteDeadline: stage.inviteDeadline,
          workDeadline: stage.workDeadline,
          ...(stage.standard ? { standard: standardView(stage.standard) } : {}),
        }
      : {}),
    slots: full
      ? stageSlots.map((slot) => slotView(slot, true))
      : stageSlots.map((slot) =>
          slot.status === "accepted" && slot.wallet?.toLowerCase() === decision.wallet
            ? slotView(slot, true)
            : slotView(slot, false),
        ),
    ...(decision.allowed.evidenceHandles
      ? { fileResources: (stageConfig?.fileResources ?? []).map(handleView) }
      : {}),
  };
}

function slotView(slot: OrderStageSlotRecord, full: boolean): SlotViewV3 {
  return {
    slotKey: slot.slotKey,
    required: slot.required,
    status: slot.status,
    ...(slot.subjectLabel !== undefined ? { subjectLabel: slot.subjectLabel } : {}),
    ...(full && slot.wallet !== undefined ? { wallet: slot.wallet } : {}),
    ...(full && slot.contactRef !== undefined ? { contactRef: slot.contactRef } : {}),
  };
}

function standardView(standard: NonNullable<OrderStageRecord["standard"]>): StandardViewV3 {
  return {
    name: standard.name,
    ...(standard.version !== undefined ? { version: standard.version } : {}),
    hash: standard.hash,
  };
}

function handleView(resource: ConfigFileResourceRefV3 | string): HandleViewV3 {
  if (typeof resource === "string") {
    return { handleKey: resource };
  }
  return {
    handleKey: resource.name ?? resource.ref,
    ...(resource.version !== undefined ? { version: resource.version } : {}),
    ...(resource.hash !== undefined ? { hash: resource.hash } : {}),
  };
}
