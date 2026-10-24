// Session-anchored product reads for the StageEscrow V2 projection. Order
// visibility reuses the product order gate (same 404 for missing/invisible);
// unconfigured escrow is an explicit 404, never a 500 or an empty fake order.
// A visible participant reads every tranche whose payer belongs to the order's
// participant set; payee/verifier may be third parties and are not gated by
// participation. A wallet outside the order's visibility reads only tranches
// it is payer/payee/verifier of, and only while that tranche's payer is still
// an order participant: a forged payer tranche cannot promote a third party.

import type { EscrowTrancheDTO } from "../../escrow/index.js";
import {
  ProductOrderLookupError,
  type ProductOrderApiDTO
} from "../../product/application/service.js";
import { StorageUnavailableError } from "../../storage/errors.js";
import {
  decodePathParameter,
  InvalidPathParameterError,
  invalidPathParameterResponse,
  type ApiResponse,
  type ApiRouteContext
} from "../route-context.js";
import { resolveParticipantWalletIdentity } from "../participant-identity.js";
import {
  orderParticipantWallets,
  resolveOrderVisibility
} from "../product-order-visibility.js";
import type { RouteModule } from "../route-module.js";

const ESCROW_PATH = /^\/product\/orders\/([^/]+)\/escrow(?:\/([^/]+))?$/;

export function createProductEscrowRouteModule(options: {
  readonly runtimeEnvironment?: Parameters<typeof resolveParticipantWalletIdentity>[2];
} = {}): RouteModule {
  return {
    async handle(request, context) {
      if (request.method !== "GET") {
        return undefined;
      }
      const match = ESCROW_PATH.exec(request.pathname);
      if (!match) {
        return undefined;
      }
      return withEscrowStorageGuard(async () => {
        if (!context.escrowService.configured) {
          return {
            status: 404,
            body: { error: "escrow_not_configured" }
          };
        }
        const wallet = await resolveParticipantWalletIdentity(
          request,
          context,
          options.runtimeEnvironment
        );
        if (!wallet.ok) {
          return wallet.response;
        }
        const orderId = decodePathParameter(match[1] ?? "");
        const stageId = match[2] === undefined
          ? undefined
          : decodePathParameter(match[2]);
        const visibility = await resolveOrderVisibility(
          context,
          orderId,
          wallet.identity.walletAddress
        );
        let order: ProductOrderApiDTO | undefined;
        let orderVisible = false;
        if ("order" in visibility) {
          orderVisible = true;
          order = visibility.order;
        } else if (visibility.response.status === 404) {
          const fallback = await readOrderForTrancheGate(context, orderId);
          if ("response" in fallback) {
            return fallback.response;
          }
          order = fallback.order;
        } else {
          return visibility.response;
        }
        if (!order) {
          return {
            status: 404,
            body: { error: "product_order_not_found" }
          };
        }
        const normalizedOrderId = order.orderId;
        const participants = orderParticipantWallets(order);
        const walletAddress = wallet.identity.walletAddress.toLowerCase();
        if (stageId !== undefined) {
          const tranche = await context.escrowService.getTranche(
            normalizedOrderId,
            stageId
          );
          if (
            !tranche ||
            !participants.has(tranche.payer.toLowerCase()) ||
            (!orderVisible && !trancheParty(tranche, walletAddress))
          ) {
            return {
              status: 404,
              body: { error: "escrow_tranche_not_found" }
            };
          }
          return { status: 200, body: tranche };
        }
        const tranches = (await context.escrowService.listTranches(
          normalizedOrderId
        )).filter((tranche) =>
          participants.has(tranche.payer.toLowerCase()) &&
          (orderVisible || trancheParty(tranche, walletAddress))
        );
        if (!orderVisible && tranches.length === 0) {
          return {
            status: 404,
            body: { error: "product_order_not_found" }
          };
        }
        return {
          status: 200,
          body: { orderId: normalizedOrderId, tranches }
        };
      });
    }
  };
}

// Visibility already denied this wallet; the tranche gate still needs the
// order's participant set to reject forged payer tranches, so the order is read
// again without granting a product read. An ambiguous lookup keeps its 409, a
// missing order keeps the same 404 the visibility gate returned.
async function readOrderForTrancheGate(
  context: ApiRouteContext,
  orderId: string
): Promise<
  | { readonly order: ProductOrderApiDTO }
  | { readonly response: ApiResponse }
> {
  try {
    const order = await context.productService.getOrder(orderId);
    return order
      ? { order }
      : {
        response: {
          status: 404,
          body: { error: "product_order_not_found" }
        }
      };
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
}

function trancheParty(
  tranche: EscrowTrancheDTO,
  walletAddress: string
): boolean {
  return tranche.payer.toLowerCase() === walletAddress ||
    tranche.payee.toLowerCase() === walletAddress ||
    tranche.verifier.toLowerCase() === walletAddress;
}

async function withEscrowStorageGuard(
  action: () => Promise<ApiResponse>
): Promise<ApiResponse> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof InvalidPathParameterError) {
      return invalidPathParameterResponse();
    }
    if (error instanceof StorageUnavailableError) {
      return {
        status: 503,
        body: {
          error: "product_storage_unavailable",
          message: error.message,
          retryable: true
        }
      };
    }
    throw error;
  }
}
