// Session-anchored product reads for the StageEscrow V2 projection. Order
// visibility reuses the product order gate (same 404 for missing/invisible);
// unconfigured escrow is an explicit 404, never a 500 or an empty fake order.
// A tranche is served only when its payer belongs to the order's participant
// set; payee/verifier may be third parties and are not gated by participation.

import { StorageUnavailableError } from "../../storage/errors.js";
import {
  decodePathParameter,
  InvalidPathParameterError,
  invalidPathParameterResponse,
  type ApiResponse
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
        if ("response" in visibility) {
          return visibility.response;
        }
        const normalizedOrderId = visibility.order.orderId;
        const participants = orderParticipantWallets(visibility.order);
        if (stageId !== undefined) {
          const tranche = await context.escrowService.getTranche(
            normalizedOrderId,
            stageId
          );
          if (!tranche || !participants.has(tranche.payer.toLowerCase())) {
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
          participants.has(tranche.payer.toLowerCase())
        );
        return {
          status: 200,
          body: { orderId: normalizedOrderId, tranches }
        };
      });
    }
  };
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
