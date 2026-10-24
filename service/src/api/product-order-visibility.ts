// Shared product order visibility: list/detail/task reads and the escrow
// routes must agree on which wallet can see an order. Keys are (planId,
// orderId) so a reused bare order id cannot leak another plan's order.

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

export function orderVisibleToParticipant(
  order: ProductOrderApiDTO,
  walletAddress: string,
  acceptedOrderKeys: ReadonlySet<string>
): boolean {
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
  const acceptedKey = orderTaskVisibilityKey(order.planId, order.orderId);
  return participants.size === 0 ||
    participants.has(walletAddress) ||
    (acceptedKey !== undefined && acceptedOrderKeys.has(acceptedKey));
}
