import { redactErrorMessage } from "../../security/redaction.js";
import { StorageUnavailableError } from "../../storage/errors.js";
import { StoreEntityRegistrationServiceError } from "../../store/registration/index.js";
import { resolveParticipantWalletIdentity } from "../participant-identity.js";
import type { ApiResponse } from "../route-context.js";
import type { RouteModule } from "../route-module.js";

export function createProductRegistrationRouteModule(options: {
  readonly runtimeEnvironment?: Parameters<typeof resolveParticipantWalletIdentity>[2];
} = {}): RouteModule {
  return {
    async handle(request, context) {
      if (request.method === "POST" && request.pathname === "/product/registration") {
        return withStorageGuard(async () => {
          const identity = await resolveParticipantWalletIdentity(
            request,
            context,
            options.runtimeEnvironment,
            { includeBodyWallet: false }
          );
          if (!identity.ok) {
            return identity.response;
          }
          try {
            const registration = await context.storeEntityRegistrationService.registerEntity(
              request.body,
              {
                accountAddress: identity.identity.walletAddress,
                ...(identity.identity.accountId !== undefined
                  ? { accountId: identity.identity.accountId }
                  : {})
              }
            );
            return {
              status: 201,
              body: { registration }
            };
          } catch (error) {
            return registrationErrorResponse(error);
          }
        });
      }

      if (request.method === "GET" && request.pathname === "/product/registration/me") {
        return withStorageGuard(async () => {
          const identity = await resolveParticipantWalletIdentity(
            request,
            context,
            options.runtimeEnvironment,
            { includeBodyWallet: false }
          );
          if (!identity.ok) {
            return identity.response;
          }
          try {
            const registration = await context.storeEntityRegistrationService.getMyRegistration(
              identity.identity.walletAddress
            );
            return {
              status: 200,
              body: { registration: registration ?? null }
            };
          } catch (error) {
            return registrationErrorResponse(error);
          }
        });
      }

      return undefined;
    }
  };
}

function registrationErrorResponse(error: unknown): ApiResponse {
  if (error instanceof StoreEntityRegistrationServiceError) {
    return {
      status: error.status,
      body: {
        error: error.code,
        message: redactErrorMessage(error),
        ...(error.details !== undefined ? { details: error.details } : {})
      }
    };
  }
  throw error;
}

async function withStorageGuard(action: () => Promise<ApiResponse>): Promise<ApiResponse> {
  try {
    return await action();
  } catch (error) {
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
