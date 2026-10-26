import { redactErrorMessage } from "../../security/redaction.js";
import {
  STORE_SESSION_HEADER,
  StoreSessionServiceError,
  type StoreSessionService
} from "../../store/sessions/index.js";
import type { StoreAccessState, StoreSessionDTO } from "../../store/console/access.js";
import { readApiHeader, type ApiRequest, type ApiResponse } from "../route-context.js";
import type { RouteModule } from "../route-module.js";
import type { ResolveWalletSessionResult } from "../../store/sessions/index.js";

export function createStoreAuthRouteModule(options: {
  readonly sessionService: StoreSessionService;
}): RouteModule {
  return {
    async handle(request, context) {
      if (request.pathname === "/store/session" && request.method === "GET") {
        const access = await context.storeIdentityProvider.resolve(request.headers);
        return {
          status: 200,
          body: { session: sessionFromAccess(access) }
        };
      }
      if (!request.pathname.startsWith("/store/auth")) {
        return undefined;
      }
      try {
        const requesterSession = await resolveRequesterSession(request, options.sessionService);

        if (request.method === "POST" && request.pathname === "/store/auth/challenge") {
          return {
            status: 201,
            body: {
              challenge: await options.sessionService.createChallenge(
                request.body,
                requesterSession,
                {
                  clientAddress: request.clientAddress,
                  domain: challengeDomainFromRequest(request)
                }
              )
            }
          };
        }

        if (request.method === "POST" && request.pathname === "/store/auth/verify") {
          return {
            status: 201,
            body: await options.sessionService.verify(request.body, requesterSession, {
              domain: challengeDomainFromRequest(request)
            })
          };
        }

        if (request.method === "POST" && request.pathname === "/store/auth/logout") {
          const token = sessionTokenFromRequest(request);
          const revoked = await options.sessionService.logout(token);
          return {
            status: 200,
            body: { revoked }
          };
        }

        if (request.method === "GET" && request.pathname === "/store/auth/addresses") {
          if (!requesterSession) {
            return sessionRequiredResponse();
          }
          return {
            status: 200,
            body: {
              accountId: requesterSession.session.accountId,
              addresses: await options.sessionService.listAccountAddresses(requesterSession.session.accountId)
            }
          };
        }

        if (request.method === "POST" && request.pathname === "/store/auth/addresses/revoke") {
          if (!requesterSession) {
            return sessionRequiredResponse();
          }
          return {
            status: 200,
            body: {
              accountId: requesterSession.session.accountId,
              addresses: await options.sessionService.revokeAccountAddress(request.body, requesterSession)
            }
          };
        }

        if (request.method === "GET" && request.pathname === "/store/auth/session") {
          if (!requesterSession) {
            return sessionRequiredResponse();
          }
          const access = await context.storeIdentityProvider.resolve(request.headers);
          return {
            status: 200,
            body: { session: requesterSession.session, access: accessSummary(access) }
          };
        }
      } catch (error) {
        if (error instanceof StoreSessionServiceError) {
          return {
            status: error.status,
            body: {
              error: error.code,
              message: redactErrorMessage(error),
              ...(error.details !== undefined ? { details: error.details } : {})
            }
          };
        }
        return {
          status: 503,
          body: { error: "store_session_unavailable", message: redactErrorMessage(error) }
        };
      }
      return undefined;
    }
  };
}

export function sessionTokenFromRequest(request: ApiRequest): string | undefined {
  return readApiHeader(request.headers, STORE_SESSION_HEADER)?.trim() || undefined;
}

function challengeDomainFromRequest(request: ApiRequest): string | undefined {
  return readApiHeader(request.headers, "host")?.trim() || undefined;
}

export async function resolveRequesterSession(
  request: ApiRequest,
  sessionService: StoreSessionService
): Promise<ResolveWalletSessionResult | undefined> {
  const token = sessionTokenFromRequest(request);
  return sessionService.resolveSessionFromToken(token);
}

export function sessionRequiredResponse(): ApiResponse {
  return {
    status: 401,
    body: {
      error: "store_session_required",
      message: "a wallet session token (x-uvp-store-session) is required"
    }
  };
}

export function accessSummary(access: StoreAccessState): {
  readonly accessLevel: string;
  readonly authMode: string;
  readonly anchoredAddress?: string;
  readonly anchorSource?: string;
  readonly canWrite: boolean;
  readonly canAdmin: boolean;
} {
  return {
    accessLevel: access.level,
    authMode: access.authMode,
    ...(access.anchoredAddress ? { anchoredAddress: access.anchoredAddress } : {}),
    ...(access.anchorSource ? { anchorSource: access.anchorSource } : {}),
    canWrite: access.canWrite,
    canAdmin: access.canAdmin
  };
}

function sessionFromAccess(access: StoreAccessState): StoreSessionDTO {
  return {
    authenticated: access.level !== "anonymous_read",
    ...(access.principalId ? { principalId: access.principalId } : {}),
    ...(access.displayName ? { displayName: access.displayName } : {}),
    accessLevel: access.level,
    roles: access.roles,
    authMode: access.authMode,
    canWrite: access.canWrite,
    canAdmin: access.canAdmin
  };
}
