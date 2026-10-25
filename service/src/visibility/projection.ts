// 字段级读投影：按 VisibilityDecision 裁剪 order/stage/slot/标准/句柄。所有裁剪在服务端完成；DTO 允许字段由 scope 决定，调用方不得
// 把未授权字段“删掉后当 empty”返回。locator/URI 永不出现在句柄列表。

import type { ConfigFileResourceRef, ConfigStage } from "@uvp-eth/product-dto";
import type { OrderVisibilitySnapshot } from "../order/service.js";
import type { OrderStageRecord, OrderStageSlotRecord } from "../order/types.js";
import { OrderError } from "../order/types.js";
import type {
  HandleView,
  OperatorOrderView,
  OrderView,
  ResourceListView,
  SlotView,
  StageViewResponse,
  StageView,
  StandardView,
  VisibilityDecision,
} from "./types.js";

export function projectOrder(decision: VisibilityDecision, snapshot: OrderVisibilitySnapshot): OrderView {
  const stages = snapshot.stages
    .filter((stage) => decision.stageKeys.has(stage.stageKey))
    .map((stage) => projectStageView(decision, snapshot, stage));
  const base: OrderView = {
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
  snapshot: OrderVisibilitySnapshot,
  stage: OrderStageRecord,
): StageViewResponse {
  return {
    order: projectOrder(decision, snapshot),
    stage: projectStageView(decision, snapshot, stage),
    dataState: "ok",
  };
}

export function projectResources(
  decision: VisibilityDecision,
  stageKey: string,
  stageConfig: ConfigStage | undefined,
): ResourceListView {
  if (!decision.allowed.evidenceHandles || decision.scope === "operator") {
    throw new OrderError(403, "visibility_denied", "the current scope cannot read stage file handles", {
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
  snapshot: OrderVisibilitySnapshot,
): OperatorOrderView {
  if (decision.scope !== "operator") {
    throw new OrderError(404, "order_not_found", "order was not found");
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
  snapshot: OrderVisibilitySnapshot,
  stage: OrderStageRecord,
): StageView {
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
    ...(decision.allowed.amounts ? { amount: stage.amount } : {}),
    ...(termsVisible
      ? {
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

function slotView(slot: OrderStageSlotRecord, full: boolean): SlotView {
  return {
    slotKey: slot.slotKey,
    required: slot.required,
    status: slot.status,
    ...(slot.subjectLabel !== undefined ? { subjectLabel: slot.subjectLabel } : {}),
    ...(full && slot.wallet !== undefined ? { wallet: slot.wallet } : {}),
    ...(full && slot.contactRef !== undefined ? { contactRef: slot.contactRef } : {}),
  };
}

function standardView(standard: NonNullable<OrderStageRecord["standard"]>): StandardView {
  return {
    name: standard.name,
    ...(standard.version !== undefined ? { version: standard.version } : {}),
    hash: standard.hash,
  };
}

function handleView(resource: ConfigFileResourceRef | string): HandleView {
  if (typeof resource === "string") {
    return { handleKey: resource };
  }
  return {
    handleKey: resource.name ?? resource.ref,
    ...(resource.version !== undefined ? { version: resource.version } : {}),
    ...(resource.hash !== undefined ? { hash: resource.hash } : {}),
  };
}
