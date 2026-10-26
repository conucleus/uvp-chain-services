// Chain identity projection read: `GET /identity/bindings` is the only
// governance-adjacent endpoint kept on chain-services. It reads indexer
// projections only (no reviews, descriptors, or tx signing).
import type { IdentityBindingQuery } from "../../indexer/identity-projections.js";
import { ConfigError, normalizeAddress, normalizeBytes32 } from "../../shared/types.js";
import { cleanQuery, type ApiRequest, type ApiResponse } from "../route-context.js";
import type { RouteModule } from "../route-module.js";

type ParsedIdentityQuery =
  | { readonly ok: true; readonly query: IdentityBindingQuery }
  | { readonly ok: false; readonly response: ApiResponse };

export function createIdentityBindingsRouteModule(): RouteModule {
  return {
    async handle(request, context) {
      if (request.method !== "GET" || request.pathname !== "/identity/bindings") {
        return undefined;
      }
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
  };
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
  return { ok: true, query: { ...parsed.query, activeOnly: activeOnly === "true" } };
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
