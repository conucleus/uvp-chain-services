// V3 唯一可见性 resolver：从已发布 config 的 slot visibility、订单 stage/
// slot 绑定与订单状态推导 scope + allowed fields。所有 V3 读路由必须先过
// 这里；route 不允许再做局部放行判断。陌生人一律 404，已知订单但越段 403。

import type { ConfigSlotVisibilityV3 } from "@uvp-eth/product-dto";
import { normalizeAddress } from "../shared/types.js";
import { OrderV3Error } from "../order/v3/types.js";
import type { OrderStageRecord, OrderStageSlotRecord } from "../order/v3/types.js";
import type {
  VisibilityDecision,
  VisibilityFields,
  VisibilityResolver,
  VisibilityResolverOptions,
  VisibilityScope,
} from "./types.js";

export function createVisibilityResolver(options: VisibilityResolverOptions): VisibilityResolver {
  const operators = new Set((options.operatorWallets ?? []).map((wallet) => wallet.toLowerCase()));
  return {
    async resolveVisibility(orderId, stageKey, wallet) {
      const actor = normalizeAddress(wallet, "wallet").toLowerCase();
      const snapshot = await options.loadOrder(orderId);
      if (!snapshot) {
        throw new OrderV3Error(404, "order_not_found", "order was not found");
      }
      const decision = resolveDecision(orderId, actor, snapshot.order.buyerWallet, snapshot.stages, snapshot.slots, snapshot.config.slots, operators);
      if (!decision) {
        // 陌生人：不泄露订单存在性，也不泄露其 stage 是否存在。
        throw new OrderV3Error(404, "order_not_found", "order was not found");
      }
      if (stageKey !== undefined) {
        const stage = snapshot.stages.find((candidate) => candidate.stageKey === stageKey);
        if (!stage) {
          throw new OrderV3Error(404, "stage_not_found", "stage was not found on this order");
        }
        if (!decision.stageKeys.has(stage.stageKey)) {
          throw new OrderV3Error(403, "wallet_scope_forbidden", "the session wallet can only read its own stage", {
            stageKey,
            scope: decision.scope,
          });
        }
      }
      return decision;
    },
  };
}

function resolveDecision(
  orderId: string,
  wallet: string,
  buyerWallet: string,
  stages: readonly OrderStageRecord[],
  slots: readonly OrderStageSlotRecord[],
  configSlots: readonly {
    readonly key: string;
    readonly kind?: string;
    readonly visibility?: ConfigSlotVisibilityV3;
  }[],
  operators: ReadonlySet<string>,
): VisibilityDecision | undefined {
  const allStageKeys = new Set(stages.map((stage) => stage.stageKey));
  if (buyerWallet.toLowerCase() === wallet) {
    return {
      orderId,
      wallet,
      scope: "buyer",
      allowed: buyerFields(),
      stageKeys: allStageKeys,
      slotKeysByStage: new Map(),
    };
  }

  const accepted = slots.filter((slot) => slot.status === "accepted" && slot.wallet?.toLowerCase() === wallet);
  if (accepted.length > 0) {
    const slotKeysByStage = new Map<string, string>();
    for (const slot of accepted) {
      const stage = stages.find((candidate) => candidate.stageKey === slot.stageKey);
      if (!stage) {
        continue;
      }
      if (!slotKeysByStage.has(stage.stageKey)) {
        slotKeysByStage.set(stage.stageKey, slot.slotKey);
      }
    }
    if (slotKeysByStage.size === 0) {
      return undefined;
    }
    const ownSlot = accepted[0]!;
    const disclosure = configSlots.find((slot) => slot.key === ownSlot.slotKey)?.visibility;
    return {
      orderId,
      wallet,
      scope: "stage-executor",
      allowed: participantFields("stage-executor", disclosure),
      stageKeys: new Set(slotKeysByStage.keys()),
      slotKeysByStage,
    };
  }

  if (operators.has(wallet)) {
    return {
      orderId,
      wallet,
      scope: "operator",
      allowed: operatorFields(),
      stageKeys: allStageKeys,
      slotKeysByStage: new Map(),
    };
  }
  return undefined;
}

function buyerFields(): VisibilityFields {
  return {
    orderTitle: true,
    orderStatus: true,
    stageList: "all",
    amounts: true,
    walletAddresses: true,
    contactRefs: true,
    evidenceHandles: true,
  };
}

function participantFields(scope: VisibilityScope, disclosure?: ConfigSlotVisibilityV3): VisibilityFields {
  return {
    orderTitle: false,
    orderStatus: true,
    stageList: "own",
    amounts: disclosure?.amounts !== false,
    walletAddresses: false,
    contactRefs: false,
    evidenceHandles: true,
  };
}

function operatorFields(): VisibilityFields {
  return {
    orderTitle: false,
    orderStatus: true,
    stageList: "summary",
    amounts: false,
    walletAddresses: false,
    contactRefs: false,
    evidenceHandles: false,
  };
}

