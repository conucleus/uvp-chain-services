// V3 字段级读投影：按 VisibilityDecision 裁剪 order/stage/slot/标准/句柄/
// 托管字段。所有裁剪在服务端完成；DTO 允许字段由 scope 决定，调用方不得
// 把未授权字段“删掉后当 empty”返回。locator/URI 永不出现在句柄列表。

import type { ConfigFileResourceRefV3, ConfigStageV3 } from "@uvp-eth/product-dto";
import type { EscrowTrancheDTO } from "../escrow/types.js";
import type { TrancheBindingRecord } from "../binding/types.js";
import type { SettlementInstructionRecord } from "../settlement/types.js";
import type { OrderV3VisibilitySnapshot } from "../order/v3/service.js";
import type { OrderStageRecord, OrderStageSlotRecord } from "../order/v3/types.js";
import { OrderV3Error } from "../order/v3/types.js";
import type {
  EscrowViewV3,
  HandleViewV3,
  InstructionListViewV3,
  InstructionViewV3,
  BindingViewV3,
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

export function projectEscrow(
  decision: VisibilityDecision,
  stageKey: string,
  tranche: EscrowTrancheDTO | undefined,
): EscrowViewV3 {
  if (!tranche) {
    return { dataState: "none", stageKey };
  }
  if (decision.scope === "operator") {
    return {
      dataState: "ok",
      stageKey,
      funded: true,
      state: tranche.state,
    };
  }
  if (decision.scope === "verifier") {
    return {
      dataState: "ok",
      stageKey,
      trancheId: tranche.trancheId,
      state: tranche.state,
      updatedAt: tranche.updatedAt,
    };
  }
  if (decision.scope === "performer") {
    return {
      dataState: "ok",
      stageKey,
      trancheId: tranche.trancheId,
      state: tranche.state,
      ...(decision.allowed.escrowAmounts ? { amount: tranche.amount, feeBps: tranche.feeBps } : {}),
      updatedAt: tranche.updatedAt,
    };
  }
  return {
    dataState: "ok",
    stageKey,
    trancheId: tranche.trancheId,
    state: tranche.state,
    amount: tranche.amount,
    feeBps: tranche.feeBps,
    payer: tranche.payer,
    payee: tranche.payee,
    verifier: tranche.verifier,
    feeRecipient: tranche.feeRecipient,
    observationDays: tranche.observationDays,
    updatedAt: tranche.updatedAt,
  };
}

export function projectBinding(
  decision: VisibilityDecision,
  snapshot: OrderV3VisibilitySnapshot,
  stage: OrderStageRecord,
): BindingViewV3 {
  const base: BindingViewV3 = {
    dataState: "ok",
    stageKey: stage.stageKey,
    stageId: stage.stageId,
    status: stage.status,
  };
  if (decision.scope === "operator") {
    return base;
  }
  const full = decision.scope === "buyer";
  const stageSlots = snapshot.slots.filter((slot) => slot.stageKey === stage.stageKey);
  return {
    ...base,
    payerSlot: stage.payerSlot,
    ...(stage.payeeSlot !== undefined ? { payeeSlot: stage.payeeSlot } : {}),
    ...(stage.verifierSlot !== undefined ? { verifierSlot: stage.verifierSlot } : {}),
    termsHash: stage.termsHash,
    ...(decision.allowed.amounts ? { amount: stage.amount } : {}),
    ...(full || decision.allowed.amounts ? { acceptanceMode: stage.acceptanceMode, verifierMode: stage.verifierMode } : {}),
    slots: full
      ? stageSlots.map((slot) => slotView(slot, true))
      : stageSlots.map((slot) =>
          slot.status === "accepted" && slot.wallet?.toLowerCase() === decision.wallet
            ? slotView(slot, true)
            : slotView(slot, false),
        ),
  };
}

export function projectInstructions(
  decision: VisibilityDecision,
  stageKey: string,
  rows: readonly SettlementInstructionRecord[],
  dataState: "ok" | "none" | "pending" | "unknown",
  reason?: string,
): InstructionListViewV3 {
  if (!decision.allowed.instructions) {
    throw new OrderV3Error(403, "visibility_denied", "the current scope cannot read settlement instructions", {
      resource: "settlement_instructions",
      stageKey,
    });
  }
  const verifierScope = decision.scope === "verifier";
  const items = rows.map((row): InstructionViewV3 => ({
    instructionId: row.instructionId,
    kind: row.kind,
    status: row.status,
    trancheId: row.trancheId,
    instructionRef: row.instructionRef,
    ...(!verifierScope
      ? { payerAmount: row.payerAmount, payeeAmount: row.payeeAmount }
      : {}),
    requiredSigners: row.requiredSigners,
    signedRoles: row.signatures.map((signature) => signature.role),
    ...(row.executeEligibleAt !== undefined ? { executeEligibleAt: row.executeEligibleAt } : {}),
    ...(row.blockedByDispute === true ? { blockedByDispute: true } : {}),
    ...(row.txHash !== undefined ? { txHash: row.txHash } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
  return {
    dataState,
    stageKey,
    items,
    ...(reason !== undefined ? { reason } : {}),
  };
}

export function projectEscrowBinding(
  decision: VisibilityDecision,
  stageKey: string,
  binding: TrancheBindingRecord | undefined,
  dataState: "ok" | "none" | "pending" | "unknown",
  reason?: string,
): EscrowViewV3 {
  if (dataState !== "ok" || binding === undefined) {
    return {
      dataState,
      stageKey,
      ...(reason !== undefined ? { reason } : {}),
    };
  }
  const funded = binding.state !== "foreign";
  if (decision.scope === "operator") {
    return { dataState: "ok", stageKey, funded, state: binding.state };
  }
  if (decision.scope === "verifier") {
    return {
      dataState: "ok",
      stageKey,
      trancheId: binding.trancheId,
      state: binding.state,
      funded,
      updatedAt: binding.updatedAt,
    };
  }
  if (decision.scope === "performer") {
    return {
      dataState: "ok",
      stageKey,
      trancheId: binding.trancheId,
      state: binding.state,
      funded,
      ...(decision.allowed.escrowAmounts ? { amount: binding.amount, feeBps: binding.feeBps } : {}),
      updatedAt: binding.updatedAt,
    };
  }
  return {
    dataState: "ok",
    stageKey,
    trancheId: binding.trancheId,
    state: binding.state,
    amount: binding.amount,
    feeBps: binding.feeBps,
    payer: binding.payer,
    payee: binding.payee,
    ...(binding.verifier !== undefined ? { verifier: binding.verifier } : {}),
    feeRecipient: binding.feeRecipient,
    funded,
    updatedAt: binding.updatedAt,
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
