import {
  adminPrincipalFromHeaders,
  GovernanceServiceError
} from "../../governance/index.js";
import { redactErrorMessage } from "../../security/redaction.js";
import { ConfigError, normalizeAddress, normalizeBytes32 } from "../../shared/types.js";
import { cleanQuery, type ApiRequest, type ApiResponse } from "../route-context.js";
import type { RouteModule } from "../route-module.js";

type ParsedIdentityQuery =
  | { readonly ok: true; readonly query: Record<string, string> }
  | { readonly ok: false; readonly response: ApiResponse };

export function createGovernanceRouteModule(): RouteModule {
  return {
    async handle(request, context) {
      const adminResponse = await handleGovernanceRequest(request, context);
      if (adminResponse) {
        return adminResponse;
      }
      return handleIdentityProjectionRequest(request, context);
    }
  };
}

async function handleGovernanceRequest(
  request: ApiRequest,
  context: Parameters<RouteModule["handle"]>[1]
): Promise<ApiResponse | undefined> {
  if (!request.pathname.startsWith("/admin/governance")) {
    return undefined;
  }

  const principal = adminPrincipalFromHeaders(request.headers);
  if (!principal) {
    return {
      status: 403,
      body: { error: "forbidden" }
    };
  }

  try {
    if (request.method === "GET" && request.pathname === "/admin/governance/reviews") {
      return {
        status: 200,
        body: { reviews: await context.governanceService.listReviews(request.query) }
      };
    }

    const txMatch = /^\/admin\/governance\/tx\/([^/]+)$/.exec(request.pathname);
    if (request.method === "GET" && txMatch) {
      const txLogId = decodeURIComponent(txMatch[1] ?? "");
      const txLog = await context.governanceService.getTxLog(txLogId);
      if (!txLog) {
        return {
          status: 404,
          body: { error: "governance_tx_not_found" }
        };
      }
      return {
        status: 200,
        body: { txLog }
      };
    }

    if (request.method === "POST" && request.pathname === "/admin/governance/review-zhixu") {
      return {
        status: 200,
        body: await context.governanceService.reviewZhixu(request.body, principal)
      };
    }

    if (request.method === "POST" && request.pathname === "/admin/governance/review-supplier") {
      return {
        status: 200,
        body: await context.governanceService.reviewSupplier(request.body, principal)
      };
    }

    if (request.method === "POST" && request.pathname === "/admin/governance/register-identity") {
      return {
        status: 202,
        body: await context.governanceService.registerIdentity(request.body, principal)
      };
    }

    if (request.method === "POST" && request.pathname === "/admin/governance/revoke-identity") {
      return {
        status: 202,
        body: await context.governanceService.revokeIdentity(request.body, principal)
      };
    }
  } catch (error) {
    if (error instanceof GovernanceServiceError) {
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

  return {
    status: 404,
    body: { error: "not_found" }
  };
}

async function handleIdentityProjectionRequest(
  request: ApiRequest,
  context: Parameters<RouteModule["handle"]>[1]
): Promise<ApiResponse | undefined> {
  if (request.method === "GET" && request.pathname === "/identity/bindings") {
    const parsedQuery = parseIdentityBindingQuery(request.query);
    if (!parsedQuery.ok) {
      return parsedQuery.response;
    }
    return {
      status: 200,
      body: {
        bindings: await context.store.listIdentityBindings(parsedQuery.query)
      }
    };
  }

  return undefined;
}

function parseIdentityBindingQuery(query: ApiRequest["query"]): ParsedIdentityQuery {
  const activeOnly = query?.activeOnly;
  if (activeOnly && activeOnly !== "true" && activeOnly !== "false") {
    return {
      ok: false,
      response: { status: 400, body: { error: "invalid_query", message: "activeOnly must be true or false" } }
    };
  }
  const parsed = validateIdentityQuery(
    cleanQuery({
      registryAddress: query?.registryAddress,
      bindingId: query?.bindingId,
      subjectId: query?.subjectId,
      account: query?.account
    }),
    {
      registryAddress: "address",
      bindingId: "bytes32",
      subjectId: "bytes32",
      account: "address"
    }
  );
  if (!parsed.ok || !activeOnly) {
    return parsed;
  }
  return { ok: true, query: { ...parsed.query, activeOnly } };
}

function validateIdentityQuery(
  query: Record<string, string>,
  fields: Readonly<Record<string, "address" | "bytes32">>
): ParsedIdentityQuery {
  try {
    for (const [field, kind] of Object.entries(fields)) {
      const value = query[field];
      if (!value) {
        continue;
      }
      query[field] = kind === "address" ? normalizeAddress(value, field) : normalizeBytes32(value, field);
    }
    return { ok: true, query };
  } catch (error) {
    if (error instanceof ConfigError) {
      return {
        ok: false,
        response: {
          status: 400,
          body: {
            error: "invalid_query",
            message: error.message
          }
        }
      };
    }
    throw error;
  }
}
