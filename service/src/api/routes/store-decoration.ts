import { redactErrorMessage } from "../../security/redaction.js";
import type { StoreDecorationService } from "../../store-decoration/index.js";
import { StoreDecorationServiceError } from "../../store-decoration/index.js";
import {
  isAnchoredStoreAuthorizationResult,
  requireAnchoredStoreAddress
} from "../store-authz.js";
import type { ApiRequest, ApiResponse } from "../route-context.js";
import type { RouteModule } from "../route-module.js";

/** 装修路由：publisher（或受托成员）才可写，服务端强制。 */
export function createStoreDecorationRouteModule(options: {
  readonly decorationService: StoreDecorationService;
}): RouteModule {
  return {
    async handle(request, context) {
      if (!request.pathname.startsWith("/store/decoration") && !request.pathname.startsWith("/store/publishers")) {
        return undefined;
      }
      try {
        const decorationMatch = /^\/store\/decoration\/([^/]+)(?:\/versions(?:\/(\d+)(?:\/restore)?)?)?$/.exec(request.pathname);
        if (decorationMatch) {
          const planId: string = decodeURIComponent(decorationMatch[1] ?? "");
          if (!planId) {
            return { status: 404, body: { error: "not_found" } };
          }
          if (request.method === "GET" && !decorationMatch[2]) {
            return {
              status: 200,
              body: await options.decorationService.getDecoration(planId)
            };
          }
          if (request.method === "GET" && decorationMatch[2]) {
            const view = await options.decorationService.getDecoration(planId);
            const versionNumber = Number(decorationMatch[2]);
            const version = Number.isFinite(versionNumber)
              ? view.versions.find((record) => record.version === versionNumber)
              : undefined;
            if (!version) {
              return { status: 404, body: { error: "decoration_version_not_found" } };
            }
            return { status: 200, body: { planId: view.planId, version } };
          }
          if (request.method === "PUT" && !decorationMatch[2]) {
            const authorization = await requireAnchoredStoreAddress(context, request, { type: "store_decoration", id: planId });
            if (!isAnchoredStoreAuthorizationResult(authorization)) {
              return authorization;
            }
            return {
              status: 201,
              body: await options.decorationService.saveDecoration(
                planId,
                decorationBody(request),
                decorationActor(authorization.access, authorization.anchoredAddress, authorization.accountId),
                noteFromBody(request.body)
              )
            };
          }
          if (request.method === "POST" && decorationMatch[2] && request.pathname.endsWith("/restore")) {
            const authorization = await requireAnchoredStoreAddress(context, request, { type: "store_decoration", id: planId });
            if (!isAnchoredStoreAuthorizationResult(authorization)) {
              return authorization;
            }
            const versionNumber = Number(decorationMatch[2]);
            if (!Number.isFinite(versionNumber)) {
              return { status: 400, body: { error: "invalid_version" } };
            }
            return {
              status: 201,
              body: await options.decorationService.restoreVersion(
                planId,
                versionNumber,
                decorationActor(authorization.access, authorization.anchoredAddress, authorization.accountId),
                noteFromBody(request.body)
              )
            };
          }
        }

        const delegationListMatch = /^\/store\/publishers\/([^/]+)\/delegations$/.exec(request.pathname);
        if (delegationListMatch && request.method === "GET") {
          const authorization = await requireAnchoredStoreAddress(context, request, { type: "store_delegation", id: decodeURIComponent(delegationListMatch[1] ?? "") });
          if (!isAnchoredStoreAuthorizationResult(authorization)) {
            return authorization;
          }
          return {
            status: 200,
            body: {
              delegations: await options.decorationService.listDelegations(
                decodeURIComponent(delegationListMatch[1] ?? ""),
                decorationActor(authorization.access, authorization.anchoredAddress, authorization.accountId)
              )
            }
          };
        }

        if (request.method === "POST" && request.pathname === "/store/publishers/delegations") {
          const authorization = await requireAnchoredStoreAddress(context, request, { type: "store_delegation" });
          if (!isAnchoredStoreAuthorizationResult(authorization)) {
            return authorization;
          }
          return {
            status: 201,
            body: {
              delegations: await options.decorationService.grantDelegation(
                request.body,
                decorationActor(authorization.access, authorization.anchoredAddress, authorization.accountId)
              )
            }
          };
        }

        const delegationRevokeMatch = /^\/store\/publishers\/delegations\/([^/]+)\/revoke$/.exec(request.pathname);
        if (delegationRevokeMatch && request.method === "POST") {
          const authorization = await requireAnchoredStoreAddress(context, request, { type: "store_delegation", id: decodeURIComponent(delegationRevokeMatch[1] ?? "") });
          if (!isAnchoredStoreAuthorizationResult(authorization)) {
            return authorization;
          }
          return {
            status: 200,
            body: {
              delegations: await options.decorationService.revokeDelegation(
                decodeURIComponent(delegationRevokeMatch[1] ?? ""),
                request.body,
                decorationActor(authorization.access, authorization.anchoredAddress, authorization.accountId)
              )
            }
          };
        }
      } catch (error) {
        if (error instanceof StoreDecorationServiceError) {
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
          body: { error: "store_decoration_unavailable", message: redactErrorMessage(error) }
        };
      }
      return undefined;
    }
  };
}

function decorationActor(
  access: { readonly authMode: string },
  anchoredAddress: Parameters<StoreDecorationService["saveDecoration"]>[2]["anchoredAddress"],
  accountId?: string
): Parameters<StoreDecorationService["saveDecoration"]>[2] {
  return {
    anchoredAddress,
    ...(accountId ? { accountId } : {}),
    authMode: access.authMode
  };
}

function decorationBody(request: ApiRequest): unknown {
  const record = request.body && typeof request.body === "object" && !Array.isArray(request.body)
    ? request.body as Record<string, unknown>
    : {};
  return record.decoration ?? record;
}

function noteFromBody(body: unknown): string | undefined {
  const record = body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  const note = record.note;
  return typeof note === "string" && note.trim().length > 0 ? note.trim() : undefined;
}
