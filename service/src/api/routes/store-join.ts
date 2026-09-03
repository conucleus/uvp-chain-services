import { redactErrorMessage } from "../../security/redaction.js";
import { normalizeAddress, normalizeBytes32, type Address, type Hex } from "../../shared/types.js";
import type { StoreJoinService } from "../../store-join/index.js";
import { StoreJoinServiceError, type StoreJoinActor } from "../../store-join/index.js";
import {
  isAnchoredStoreAuthorizationResult,
  requireAnchoredStoreAddress
} from "../store-authz.js";
import type { ApiResponse } from "../route-context.js";
import type { RouteModule } from "../route-module.js";

/** PRD90 加入闭环路由。提交/读取要求锚定会话；审核要求 publisher/委托。 */
export function createStoreJoinRouteModule(options: {
  readonly joinService: StoreJoinService;
}): RouteModule {
  return {
    async handle(request, context) {
      if (!request.pathname.startsWith("/store/join-applications")) {
        return undefined;
      }
      try {
        if (request.method === "POST" && request.pathname === "/store/join-applications") {
          const authorization = await requireAnchoredStoreAddress(context, request, { type: "store_join_application" });
          if (!isAnchoredStoreAuthorizationResult(authorization)) {
            return authorization;
          }
          return {
            status: 201,
            body: await options.joinService.submitApplication(request.body, joinActor(authorization.access, authorization.anchoredAddress, authorization.accountId))
          };
        }

        if (request.method === "GET" && request.pathname === "/store/join-applications") {
          const authorization = await requireAnchoredStoreAddress(context, request, { type: "store_join_application" });
          if (!isAnchoredStoreAuthorizationResult(authorization)) {
            return authorization;
          }
          const actor = joinActor(authorization.access, authorization.anchoredAddress, authorization.accountId);
          const applications = await options.joinService.listApplications({
            ...(request.query?.planId ? { planId: parsePlanIdQuery(request.query.planId) } : {}),
            ...(request.query?.applicantAddress ? { applicantAddress: parseAddressQuery(request.query.applicantAddress) } : {}),
            ...(request.query?.status ? { status: parseStatusQuery(request.query.status) } : {})
          }, actor);
          return {
            status: 200,
            body: {
              applications,
              scope: request.query?.planId ? "plan" : "viewer"
            }
          };
        }

        const applicationMatch = /^\/store\/join-applications\/([^/]+)(?:\/(review-start|approve|reject|revoke))?$/.exec(request.pathname);
        if (!applicationMatch) {
          return { status: 404, body: { error: "not_found" } };
        }
        const applicationId = decodeURIComponent(applicationMatch[1] ?? "");
        const action = applicationMatch[2];

        if (request.method === "GET" && !action) {
          const authorization = await requireAnchoredStoreAddress(context, request, { type: "store_join_application", id: applicationId });
          if (!isAnchoredStoreAuthorizationResult(authorization)) {
            return authorization;
          }
          return {
            status: 200,
            body: await options.joinService.getApplication(
              applicationId,
              joinActor(authorization.access, authorization.anchoredAddress, authorization.accountId)
            )
          };
        }

        if (request.method === "POST" && action) {
          const authorization = await requireAnchoredStoreAddress(context, request, { type: "store_join_application", id: applicationId });
          if (!isAnchoredStoreAuthorizationResult(authorization)) {
            return authorization;
          }
          const actor = joinActor(authorization.access, authorization.anchoredAddress, authorization.accountId);
          switch (action) {
            case "review-start":
              return ok(await options.joinService.startReview(applicationId, actor));
            case "approve":
              return ok(await options.joinService.approveApplication(applicationId, request.body, actor));
            case "reject":
              return ok(await options.joinService.rejectApplication(applicationId, request.body, actor));
            case "revoke":
              return ok(await options.joinService.revokeApplication(applicationId, request.body, actor));
          }
        }
      } catch (error) {
        if (error instanceof StoreJoinServiceError) {
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
          body: { error: "store_join_unavailable", message: redactErrorMessage(error) }
        };
      }
      return { status: 404, body: { error: "not_found" } };
    }
  };
}

function ok(body: unknown): ApiResponse {
  return { status: 200, body };
}

function joinActor(
  access: { readonly authMode: string; readonly level: string; readonly principalId?: string },
  anchoredAddress: Address,
  accountId?: string
): StoreJoinActor {
  return {
    anchoredAddress,
    ...(accountId ? { accountId } : {}),
    authMode: access.authMode,
    accessLevel: access.level,
    ...(access.principalId ? { principalId: access.principalId } : {})
  };
}

function parsePlanIdQuery(value: string): Hex {
  return normalizeBytes32(value.trim(), "planId");
}

function parseAddressQuery(value: string): Address {
  return normalizeAddress(value.trim(), "applicantAddress");
}

function parseStatusQuery(value: string): NonNullable<Parameters<StoreJoinService["listApplications"]>[0]["status"]> {
  const allowed = ["applied", "under_review", "authorized", "active", "rejected", "revoked"] as const;
  const match = allowed.find((candidate) => candidate === value);
  if (!match) {
    throw new StoreJoinServiceError(400, "invalid_query", "status is not a supported application status");
  }
  return match;
}
