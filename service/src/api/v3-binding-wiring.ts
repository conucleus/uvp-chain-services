// V3 binding 接线适配器：把唯一可见性 resolver 映射为 BindingScopeResolver，
// 把 order-domain 的已接受 stage 条款映射为 AcceptedStageTermsProvider。
// 不重写 binding/visibility 语义；缺数据一律 undefined（deposit 侧 fail-closed）。

import type {
  AcceptedStageTerms,
  AcceptedStageTermsProvider,
  BindingScopeResolver,
} from "../binding/types.js";
import { OrderV3Error, canonicalStageTerms, stageTermsHash, type OrderV3Store } from "../order/v3/index.js";
import type { VisibilityResolver } from "../visibility/types.js";
import type { Address, Hex } from "../shared/types.js";

export function createBindingScopeResolver(visibility: VisibilityResolver): BindingScopeResolver {
  return {
    async resolveBindingScope(orderId: string, walletAddress: Address) {
      try {
        const decision = await visibility.resolveVisibility(orderId, undefined, walletAddress);
        return {
          kind:
            decision.scope === "buyer"
              ? "buyer"
              : decision.scope === "operator"
                ? "operator"
                : "stage",
          stages: decision.stageKeys,
        };
      } catch (error) {
        // Visibility resolver 对陌生人统一 404（不泄露订单存在性）；binding
        // 读面用 stranger 表达同一事实，route 再统一 404。
        if (error instanceof OrderV3Error && error.status === 404) {
          return { kind: "stranger", stages: new Set<string>() };
        }
        throw error;
      }
    },
  };
}

export function createOrderAcceptedTermsProvider(
  store: OrderV3Store | undefined,
): AcceptedStageTermsProvider {
  return {
    async getAcceptedStageTerms(orderId: string, stageKey: string): Promise<AcceptedStageTerms | undefined> {
      if (!store) {
        return undefined;
      }
      const order = await store.getOrder(orderId).catch(() => undefined);
      if (!order) {
        return undefined;
      }
      const draft = await store.getDraft(order.draftId);
      if (!draft) {
        return undefined;
      }
      const stage = await store.getStage(order.draftId, stageKey);
      if (!stage || stage.status === "skipped" || stage.amount === "0") {
        return undefined;
      }
      const slots = await store.listSlots(order.draftId);
      const accepted = slots.filter(
        (slot) => slot.stageKey === stageKey && slot.status === "accepted",
      );
      const payer = order.buyerWallet;
      const payee = accepted.find(
        (slot) => slot.slotKey === (stage.payeeSlot ?? "performer"),
      )?.wallet;
      const verifier =
        accepted.find((slot) => slot.slotKey === (stage.verifierSlot ?? "verifier"))?.wallet ??
        stage.verifierWallet;
      const feeRecipient = stage.feeRecipient;
      if (!payee || !verifier || !feeRecipient) {
        return undefined;
      }
      const stageTerms = canonicalStageTerms({
        orderDraftId: order.draftId,
        configId: draft.configId,
        configVersion: draft.configVersion,
        configHash: draft.configHash,
        stageKey,
        stageId: stage.stageId,
        payer,
        payee,
        verifier,
        amount: stage.amount,
        feeBps: stage.feeBps,
        feeRecipient,
        ...(stage.standard ? { standard: stage.standard } : {}),
        finalStandardHash: stage.finalStandardHash,
        inviteDeadline: stage.inviteDeadline,
        workDeadline: stage.workDeadline,
      });
      return {
        orderId: order.orderId as Hex,
        stageKey,
        stageId: stage.stageId,
        payer,
        payee,
        verifier,
        amount: stage.amount,
        feeBps: stage.feeBps,
        feeRecipient,
        stageTerms,
        termsHash: stageTermsHash(stageTerms),
      };
    },
  };
}
