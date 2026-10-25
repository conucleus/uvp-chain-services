// 共享的产品订单可见性判定：list/detail/task 各读路径对「哪个钱包能
// 看到订单」必须一致。键是 (planId, orderId)，裸 orderId 复用不能泄漏
// 别的 plan 的订单；无可判定参与者的订单对任何人不可见。

import {
  ProductOrderLookupError,
  type ProductOrderApiDTO
} from "../product/application/service.js";
import type { ApiResponse, ApiRouteContext } from "./route-context.js";

export function orderTaskVisibilityKey(
  planId: string | undefined,
  orderId: string | undefined
): string | undefined {
  if (!orderId || !planId) {
    return undefined;
  }
  return `${planId.toLowerCase()}:${orderId.toLowerCase()}`;
}

export async function acceptedParticipantOrderKeys(
  context: ApiRouteContext,
  walletAddress: string
): Promise<Set<string>> {
  const assignments = await context.productBffService.listParticipantAssignments(
    walletAddress
  );
  return new Set(assignments.flatMap((assignment) => {
    const orderId = assignment.trigger?.orderId ?? assignment.draft.triggeredOrderId;
    const planId = assignment.trigger?.planId ?? assignment.draft.planId;
    const key = orderTaskVisibilityKey(planId, orderId);
    return key ? [key] : [];
  }));
}

export async function resolveOrderVisibility(
  context: ApiRouteContext,
  orderId: string,
  walletAddress: string
): Promise<
  | { readonly order: ProductOrderApiDTO }
  | { readonly response: ApiResponse }
> {
  let order: ProductOrderApiDTO | undefined;
  try {
    order = await context.productService.getOrder(orderId);
  } catch (error) {
    if (error instanceof ProductOrderLookupError) {
      return {
        response: {
          status: 409,
          body: { error: error.code, details: error.details }
        }
      };
    }
    throw error;
  }
  if (!order || !orderVisibleToParticipant(
    order,
    walletAddress.toLowerCase(),
    await acceptedParticipantOrderKeys(context, walletAddress)
  )) {
    return {
      response: {
        status: 404,
        body: { error: "product_order_not_found" }
      }
    };
  }
  return { order };
}

export function orderParticipantWallets(
  order: ProductOrderApiDTO
): ReadonlySet<string> {
  const participants = new Set<string>();
  for (const task of order.tasks ?? []) {
    if (task.assigneeWallet) {
      participants.add(task.assigneeWallet.toLowerCase());
    }
    const overlayWallet = task.stageExecutorOverlay?.activeExecutorWallet;
    if (overlayWallet) {
      participants.add(overlayWallet.toLowerCase());
    }
  }
  for (const overlay of Object.values(order.stageExecutorOverlays ?? {})) {
    participants.add(overlay.activeExecutorWallet.toLowerCase());
  }
  for (const overlay of Object.values(order.executorOverlays ?? {})) {
    if (overlay.activeExecutorWallet) {
      participants.add(overlay.activeExecutorWallet.toLowerCase());
    }
  }
  if (order.creatorWallet) {
    participants.add(order.creatorWallet.toLowerCase());
  }
  return participants;
}

export function orderVisibleToParticipant(
  order: ProductOrderApiDTO,
  walletAddress: string,
  acceptedOrderKeys: ReadonlySet<string>
): boolean {
  const participants = orderParticipantWallets(order);
  if (participants.size === 0) {
    return false;
  }
  if (participants.has(walletAddress)) {
    return true;
  }
  const acceptedKey = orderTaskVisibilityKey(order.planId, order.orderId);
  return acceptedKey !== undefined && acceptedOrderKeys.has(acceptedKey);
}
