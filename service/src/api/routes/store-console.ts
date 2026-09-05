import { ProductBffError } from "../../product/bff/service.js";
import { ProductOrderLookupError } from "../../product/service.js";
import { GovernanceServiceError, type GovernancePrincipal } from "../../governance/index.js";
import { redactErrorMessage } from "../../security/redaction.js";
import type { AuditOutcome } from "../../security/audit.js";
import { ConfigError } from "../../shared/types.js";
import { storeSessionFromAccess, type StoreAccessState, type StoreCapability } from "../../store-console/access.js";
import type { StoreAuditQuery } from "../../store-console/audit.js";
import { buildStoreClosureDryRunSummary } from "../../store-console/closure.js";
import {
  StoreRuntimeError,
  isSupportedStoreOrderFilterStatus
} from "../../store-console/runtime.js";
import {
  StoreZhixuDraftWorkflowError
} from "../../store-console/zhixu-drafts.js";
import {
  StoreZhixuVersionError,
  type StoreZhixuVersionMutationInput
} from "../../store-console/version.js";
import {
  type StoreConsoleListQuery,
  type StoreSearchQuery
} from "../../store-console/service.js";
import { cleanQuery, type ApiRequest, type ApiResponse } from "../route-context.js";
import type { RouteModule } from "../route-module.js";
import {
  STORE_SESSION_HEADER,
  storeSessionDtoWithWalletOverlay,
  type StoreSessionService,
  type StoreWalletSessionView
} from "../../store-sessions/index.js";
import type { StoreDecorationService } from "../../store-decoration/index.js";
import type { StoreListingService } from "../../store-listings/index.js";
import { normalizeBytes32 } from "../../shared/types.js";
import {
  authorizeStoreCapability,
  isStoreAuthorizationResult,
  recordStoreCapabilityFailure,
  recordStoreCapabilitySuccess,
  requireStoreConfirmation,
  StoreConfirmationError,
  storeConfirmationErrorResponse
} from "../store-authz.js";

type ParsedStoreAuditQuery =
  | { readonly ok: true; readonly query: StoreAuditQuery }
  | { readonly ok: false; readonly response: ApiResponse };

export function createStoreConsoleRouteModule(): RouteModule {
  return {
    async handle(request, context) {
      if (request.method === "GET" && request.pathname === "/store/session") {
        const access = await context.storeIdentityProvider.resolve(request.headers);
        let session = storeSessionFromAccess(access);
        // 有钱包会话时叠加锚定地址与账号地址表。
        const walletSession = await resolveWalletSessionView(request, context.sessionService);
        if (walletSession && access.anchoredAddress) {
          session = storeSessionDtoWithWalletOverlay(session, {
            sessionId: walletSession.sessionId,
            accountId: walletSession.accountId,
            anchoredAddress: walletSession.anchoredAddress,
            createdAt: walletSession.createdAt,
            expiresAt: walletSession.expiresAt,
            addresses: walletSession.addresses
          });
        }
        return {
          status: 200,
          body: {
            session,
            ...(access.anchoredAddress ? { anchoredAddress: access.anchoredAddress } : {}),
            ...(access.anchorSource ? { anchorSource: access.anchorSource } : {})
          }
        };
      }

      if (request.method === "GET" && request.pathname === "/store/search") {
        const body = await context.storeConsoleService.search(parseStoreSearchQuery(request.query));
        // search 过滤已下架——与 /store/zhixus 的
        // 口径一致（运营方可见，便于治理观察）。
        return {
          status: 200,
          body: await filterDelistedSearchResults(request, context, body)
        };
      }

      if (request.method === "GET" && request.pathname === "/store/audit") {
        const parsedQuery = parseStoreAuditQuery(request.query);
        if (!parsedQuery.ok) {
          return parsedQuery.response;
        }
        const capability = "store.audit.read";
        const resource = { type: "store_audit" };
        const authorization = await authorizeStoreCapability(context, request, capability, resource);
        if (!isStoreAuthorizationResult(authorization)) {
          return authorization;
        }
        const records = await context.storeAuditStore.query(parsedQuery.query);
        await recordStoreCapabilitySuccess(context, request, authorization.access, capability, resource, {
          resultCount: records.length
        });
        return {
          status: 200,
          body: { records }
        };
      }

      if (request.method === "GET" && request.pathname === "/store/closure/dry-run") {
        const capability = "store.audit.read";
        const resource = { type: "store_closure_dry_run" };
        const authorization = await authorizeStoreCapability(context, request, capability, resource);
        if (!isStoreAuthorizationResult(authorization)) {
          return authorization;
        }
        try {
          const summary = await buildStoreClosureDryRunSummary({
            access: authorization.access,
            productService: context.productService,
            projectionStore: context.store,
            storeConsoleService: context.storeConsoleService,
            storeRuntimeService: context.storeRuntimeService,
            storeAuditStore: context.storeAuditStore,
            buildDiagnostics: context.buildDiagnostics,
            now: context.now
          });
          await recordStoreCapabilitySuccess(context, request, authorization.access, capability, resource, {
            releaseClassification: summary.releaseClassification,
            checkCount: summary.checks.length
          });
          return {
            status: 200,
            body: { summary }
          };
        } catch (error) {
          await recordStoreCapabilityFailure(context, request, authorization.access, capability, resource, error);
          throw error;
        }
      }

      if (request.method === "GET" && request.pathname === "/store/zhixus") {
        const body = await context.storeConsoleService.listZhixus(parseStoreZhixuListQuery(request.query));
        return {
          status: 200,
          body: await filterDelistedZhixus(request, context, body)
        };
      }

      const storeOrderCandidatesMatch = /^\/store\/orders\/([^/]+)\/candidates$/.exec(request.pathname);
      if (request.method === "GET" && storeOrderCandidatesMatch) {
        return {
          status: 200,
          body: await context.storeConsoleService.listOrderCandidates(decodeURIComponent(storeOrderCandidatesMatch[1] ?? ""))
        };
      }

      const productSchemaMatch = /^\/store\/product-schemas\/([^/]+)\/([^/]+)$/.exec(request.pathname);
      if (request.method === "GET" && productSchemaMatch) {
        const productSchema = await context.storeZhixuDraftWorkflowService.getProductSchemaByPlan(
          decodeURIComponent(productSchemaMatch[1] ?? ""),
          decodeURIComponent(productSchemaMatch[2] ?? ""),
          request.query?.artifactHash
        );
        if (!productSchema) {
          return {
            status: 404,
            body: { error: "store_product_schema_not_found" }
          };
        }
        return {
          status: 200,
          body: { productSchema }
        };
      }

      const storeRuntimeResponse = await handleStoreRuntimeRequest(request, context);
      if (storeRuntimeResponse) {
        return storeRuntimeResponse;
      }

      const storeVersionResponse = await handleStoreZhixuVersionRequest(request, context);
      if (storeVersionResponse) {
        return storeVersionResponse;
      }

      const storeDraftResponse = await handleStoreZhixuDraftRequest(request, context);
      if (storeDraftResponse) {
        return storeDraftResponse;
      }

      const storeZhixuMatch = /^\/store\/zhixus\/([^/]+)$/.exec(request.pathname);
      if (request.method === "GET" && storeZhixuMatch) {
        const zhixuId = decodeURIComponent(storeZhixuMatch[1] ?? "");
        const zhixu = await context.storeConsoleService.getZhixu(zhixuId);
        if (!zhixu) {
          return {
            status: 404,
            body: { error: "store_zhixu_not_found" }
          };
        }
        // 详情页叠加锚核验 + listing 状态 + 装修数据。
        const overlay = await buildStoreZhixuOverlay(request, context, zhixu.planId);
        return {
          status: 200,
          body: { zhixu, ...(overlay ? { storeOverlay: overlay } : {}) }
        };
      }

      return undefined;
    }
  };
}

async function handleStoreRuntimeRequest(
  request: ApiRequest,
  context: Parameters<RouteModule["handle"]>[1]
) {
  try {
    if (request.method === "GET" && request.pathname === "/store/runtime/summary") {
      return {
        status: 200,
        body: await context.storeRuntimeService.getSummary()
      };
    }

    const zhixuOrdersMatch = /^\/store\/zhixus\/([^/]+)\/orders$/.exec(request.pathname);
    if (request.method === "GET" && zhixuOrdersMatch) {
      const zhixuId = decodeURIComponent(zhixuOrdersMatch[1] ?? "");
      // status 过滤词表校验——未知 status 400，
      // 不静默返回空集。
      if (request.query?.status && !isSupportedStoreOrderFilterStatus(request.query.status)) {
        return {
          status: 400,
          body: {
            error: "invalid_query",
            message: `status must be one of registered, blocked`
          }
        };
      }
      return {
        status: 200,
        body: await context.storeRuntimeService.listZhixuOrders(zhixuId, {
          ...(request.query?.status ? { status: request.query.status } : {})
        })
      };
    }

    const observationMatch = /^\/store\/orders\/([^/]+)\/observation$/.exec(request.pathname);
    if (request.method === "GET" && observationMatch) {
      const orderId = decodeURIComponent(observationMatch[1] ?? "");
      const observation = await context.storeRuntimeService.getOrderObservation(orderId);
      if (!observation) {
        return {
          status: 404,
          body: { error: "store_order_not_found" }
        };
      }
      return {
        status: 200,
        body: { observation }
      };
    }

    const replayMatch = /^\/store\/orders\/([^/]+)\/replay$/.exec(request.pathname);
    if (request.method === "GET" && replayMatch) {
      const orderId = decodeURIComponent(replayMatch[1] ?? "");
      const replay = await context.storeRuntimeService.getOrderReplay(orderId);
      if (!replay) {
        return {
          status: 404,
          body: { error: "store_order_not_found" }
        };
      }
      return {
        status: 200,
        body: { replay }
      };
    }

    const auditSummaryMatch = /^\/store\/orders\/([^/]+)\/audit-summary$/.exec(request.pathname);
    if (request.method === "GET" && auditSummaryMatch) {
      const orderId = decodeURIComponent(auditSummaryMatch[1] ?? "");
      const auditSummary = await context.storeRuntimeService.getOrderAuditSummary(orderId);
      if (!auditSummary) {
        return {
          status: 404,
          body: { error: "store_order_not_found" }
        };
      }
      return {
        status: 200,
        body: { auditSummary }
      };
    }
  } catch (error) {
    if (error instanceof StoreRuntimeError) {
      return {
        status: error.status,
        body: {
          error: error.code,
          message: error.message,
          ...(error.details !== undefined ? { details: error.details } : {})
        }
      };
    }
    if (error instanceof ProductOrderLookupError) {
      return {
        status: 409,
        body: {
          error: error.code,
          details: error.details
        }
      };
    }
    throw error;
  }

  return undefined;
}

async function handleStoreZhixuVersionRequest(
  request: ApiRequest,
  context: Parameters<RouteModule["handle"]>[1]
) {
  try {
    const listMatch = /^\/store\/zhixu-series\/([^/]+)\/versions$/.exec(request.pathname);
    if (request.method === "GET" && listMatch) {
      const seriesId = decodeURIComponent(listMatch[1] ?? "");
      return {
        status: 200,
        body: await context.storeZhixuVersionService.listVersions(seriesId)
      };
    }

    const actionMatch = /^\/store\/zhixu-series\/([^/]+)\/versions\/([^/]+)\/(activate|deprecate)$/
      .exec(request.pathname);
    if (request.method === "POST" && actionMatch) {
      const seriesId = decodeURIComponent(actionMatch[1] ?? "");
      const versionId = decodeURIComponent(actionMatch[2] ?? "");
      const action = actionMatch[3];
      const capability = versionCapability(action);
      const resource = { type: "store_zhixu_version", id: versionId, parentId: seriesId };
      const authorization = await authorizeStoreCapability(context, request, capability, resource);
      if (!isStoreAuthorizationResult(authorization)) {
        return authorization;
      }
      const confirmationError = await storeVersionConfirmationError(context, request, seriesId, versionId, action);
      if (confirmationError) {
        await recordStoreCapabilityFailure(context, request, authorization.access, capability, resource, confirmationError);
        return storeConfirmationErrorResponse(confirmationError);
      }
      if (action === "activate") {
        try {
          const body = await context.storeZhixuVersionService.activate(seriesId, versionId, parseStoreVersionMutationBody(request.body));
          await recordStoreCapabilitySuccess(context, request, authorization.access, capability, resource);
          return { status: 200, body };
        } catch (error) {
          await recordStoreCapabilityFailure(context, request, authorization.access, capability, resource, error);
          throw error;
        }
      }
      if (action === "deprecate") {
        try {
          const body = await context.storeZhixuVersionService.deprecate(seriesId, versionId, parseStoreVersionMutationBody(request.body));
          await recordStoreCapabilitySuccess(context, request, authorization.access, capability, resource);
          return { status: 200, body };
        } catch (error) {
          await recordStoreCapabilityFailure(context, request, authorization.access, capability, resource, error);
          throw error;
        }
      }
    }
  } catch (error) {
    if (error instanceof StoreZhixuVersionError) {
      return {
        status: error.status,
        body: {
          error: error.code,
          message: error.message,
          ...(error.details !== undefined ? { details: error.details } : {})
        }
      };
    }
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
    if (error instanceof ConfigError) {
      return {
        status: 400,
        body: {
          error: "invalid_store_version_input",
          message: error.message
        }
      };
    }
    if (error instanceof ProductBffError) {
      return {
        status: error.status,
        body: {
          error: error.code,
          message: redactErrorMessage(error)
        }
      };
    }
    return storeMetadataUnavailableResponse(error);
  }

  return undefined;
}

async function handleStoreZhixuDraftRequest(
  request: ApiRequest,
  context: Parameters<RouteModule["handle"]>[1]
) {
  if (!request.pathname.startsWith("/store/zhixu-drafts")) {
    return undefined;
  }

  try {
    if (request.method === "POST" && request.pathname === "/store/zhixu-drafts/import") {
      const authorization = await authorizeStoreCapability(context, request, "store.draft.import", {
        type: "store_zhixu_draft"
      });
      if (!isStoreAuthorizationResult(authorization)) {
        return authorization;
      }
      try {
        const draft = await context.storeZhixuDraftWorkflowService.importDraft(request.body);
        await recordStoreCapabilitySuccess(context, request, authorization.access, "store.draft.import", {
          type: "store_zhixu_draft",
          id: draft.draftId
        });
        return {
          status: 201,
          body: { draft }
        };
      } catch (error) {
        await recordStoreCapabilityFailure(context, request, authorization.access, "store.draft.import", {
          type: "store_zhixu_draft"
        }, error);
        throw error;
      }
    }

    const productSchemaMatch = /^\/store\/zhixu-drafts\/([^/]+)\/product-schema(?:\/(validate))?$/.exec(
      request.pathname
    );
    if (productSchemaMatch) {
      const draftId = decodeURIComponent(productSchemaMatch[1] ?? "");
      const action = productSchemaMatch[2];
      if (request.method === "GET" && !action) {
        const productSchema = await context.storeZhixuDraftWorkflowService.getProductSchema(draftId);
        if (!productSchema) {
          return {
            status: 404,
            body: { error: "store_product_schema_not_found" }
          };
        }
        return {
          status: 200,
          body: { productSchema }
        };
      }
      if (request.method === "PUT" && !action) {
        const capability = "store.draft.schema.save";
        const resource = { type: "store_zhixu_draft", id: draftId };
        const authorization = await authorizeStoreCapability(context, request, capability, resource);
        if (!isStoreAuthorizationResult(authorization)) {
          return authorization;
        }
        try {
          const body = await context.storeZhixuDraftWorkflowService.updateProductSchema(draftId, request.body);
          await recordStoreCapabilitySuccess(context, request, authorization.access, capability, resource);
          return { status: 200, body };
        } catch (error) {
          await recordStoreCapabilityFailure(context, request, authorization.access, capability, resource, error);
          throw error;
        }
      }
      if (request.method === "POST" && action === "validate") {
        return {
          status: 200,
          body: {
            validation: await context.storeZhixuDraftWorkflowService.validateProductSchema(draftId, request.body)
          }
        };
      }
    }

    const draftMatch = /^\/store\/zhixu-drafts\/([^/]+)(?:\/(compile-preview|submit-review))?$/.exec(
      request.pathname
    );
    if (!draftMatch) {
      return {
        status: 404,
        body: { error: "not_found" }
      };
    }

    const draftId = decodeURIComponent(draftMatch[1] ?? "");
    const action = draftMatch[2];

    if (request.method === "GET" && !action) {
      const draft = await context.storeZhixuDraftWorkflowService.getDraft(draftId);
      if (!draft) {
        return {
          status: 404,
          body: { error: "store_zhixu_draft_not_found" }
        };
      }
      return {
        status: 200,
        body: { draft }
      };
    }

    if (request.method === "POST" && action === "compile-preview") {
      const capability = "store.draft.compile";
      const resource = { type: "store_zhixu_draft", id: draftId };
      const authorization = await authorizeStoreCapability(context, request, capability, resource);
      if (!isStoreAuthorizationResult(authorization)) {
        return authorization;
      }
      try {
        const draft = await context.storeZhixuDraftWorkflowService.compilePreview(draftId);
        await recordStoreCapabilitySuccess(context, request, authorization.access, capability, resource);
        return {
          status: 200,
          body: { draft }
        };
      } catch (error) {
        await recordStoreCapabilityFailure(context, request, authorization.access, capability, resource, error);
        throw error;
      }
    }

    if (request.method === "POST" && action === "submit-review") {
      const capability = "store.draft.review";
      const resource = { type: "store_zhixu_draft", id: draftId };
      const authorization = await authorizeStoreCapability(context, request, capability, resource);
      if (!isStoreAuthorizationResult(authorization)) {
        return authorization;
      }
      try {
        const result = await context.storeZhixuDraftWorkflowService.submitReview(
          draftId,
          request.body,
          storeAccessGovernancePrincipal(authorization.access)
        );
        await recordStoreCapabilitySuccess(context, request, authorization.access, capability, resource);
        return {
          status: 200,
          body: result
        };
      } catch (error) {
        await recordStoreCapabilityFailure(context, request, authorization.access, capability, resource, error);
        throw error;
      }
    }

  } catch (error) {
    if (error instanceof StoreZhixuDraftWorkflowError) {
      return {
        status: error.status,
        body: {
          error: error.code,
          message: redactErrorMessage(error),
          ...(error.details !== undefined ? { details: error.details } : {})
        }
      };
    }
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
    if (error instanceof ConfigError) {
      return {
        status: 400,
        body: {
          error: "invalid_body",
          message: redactErrorMessage(error)
        }
      };
    }
    return storeMetadataUnavailableResponse(error);
  }

  return {
    status: 404,
    body: { error: "not_found" }
  };
}

function storeMetadataUnavailableResponse(error: unknown): ApiResponse {
  return {
    status: 503,
    body: {
      error: "store_metadata_unavailable",
      message: redactErrorMessage(error)
    }
  };
}

async function storeVersionConfirmationError(
  context: Parameters<RouteModule["handle"]>[1],
  request: ApiRequest,
  seriesId: string,
  versionId: string,
  action: string | undefined
): Promise<StoreConfirmationError | undefined> {
  try {
    const body = optionalBodyRecord(request.body);
    const version = (await context.storeZhixuVersionService.listVersions(seriesId))
      .versions.find((item) => item.versionId === versionId);
    requireStoreConfirmation(request.body, {
      versionId,
      planId: optionalString(body, "planId") ?? version?.planId,
      planHash: optionalString(body, "planHash") ?? version?.planHash
    });
    return undefined;
  } catch (error) {
    if (error instanceof StoreConfirmationError) {
      return error;
    }
    throw error;
  }
}

function parseStoreSearchQuery(query: ApiRequest["query"]): StoreSearchQuery {
  const type = parseStoreSearchType(query?.type);
  const limit = parsePositiveInteger(query?.limit);
  return {
    query: query?.q ?? query?.query ?? "",
    ...(type ? { type } : {}),
    ...(limit !== undefined ? { limit } : {})
  };
}

function parseStoreAuditQuery(query: ApiRequest["query"]): ParsedStoreAuditQuery {
  const limit = parseStoreAuditLimit(query?.limit);
  if (limit === null) {
    return {
      ok: false,
      response: {
        status: 400,
        body: { error: "invalid_query", message: "limit must be a positive integer no greater than 500" }
      }
    };
  }
  const outcome = parseAuditOutcome(query?.outcome);
  if (query?.outcome && !outcome) {
    return {
      ok: false,
      response: {
        status: 400,
        body: { error: "invalid_query", message: "outcome is not a supported audit outcome" }
      }
    };
  }
  return {
    ok: true,
    query: {
      ...cleanQuery({
        resourceType: query?.resourceType,
        resourceId: query?.resourceId,
        actor: query?.actor,
        action: query?.action
      }),
      ...(outcome ? { outcome } : {}),
      ...(limit !== undefined ? { limit } : {})
    }
  };
}

function parseStoreZhixuListQuery(query: ApiRequest["query"]): StoreConsoleListQuery {
  return cleanQuery({
    query: query?.query,
    lifecycle: query?.lifecycle,
    review: query?.review,
    publication: query?.publication
  }) as StoreConsoleListQuery;
}

function versionCapability(action: string | undefined): StoreCapability {
  switch (action) {
    case "activate":
      return "store.version.activate";
    case "deprecate":
      return "store.version.deprecate";
    default:
      return "store.version.activate";
  }
}

function storeAccessGovernancePrincipal(access: StoreAccessState): GovernancePrincipal {
  return access.governancePrincipal ?? {
    adminId: access.principalId ?? "unknown-store-principal",
    role: access.roles[0] ?? access.level
  };
}

function parseStoreSearchType(value: string | undefined): StoreSearchQuery["type"] | undefined {
  switch (value) {
    case "all":
    case "zhixu":
    case "order":
    case "supplier":
      return value;
    default:
      return undefined;
  }
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseStoreAuditLimit(value: string | undefined): number | undefined | null {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 500) {
    return null;
  }
  return parsed;
}

function parseAuditOutcome(value: string | undefined): AuditOutcome | undefined {
  switch (value) {
    case "accepted":
    case "blocked":
    case "failed":
    case "succeeded":
    case "duplicate":
    case "rejected":
    case "retry":
      return value;
    default:
      return undefined;
  }
}

function parseStoreVersionMutationBody(body: unknown): StoreZhixuVersionMutationInput {
  const record = optionalBodyRecord(body);
  const zhixuId = optionalString(record, "zhixuId");
  const versionLabel = optionalString(record, "versionLabel");
  const planId = optionalString(record, "planId");
  const planHash = optionalString(record, "planHash");
  const artifactHash = optionalString(record, "artifactHash");
  const cutoverReason = optionalString(record, "cutoverReason");
  return {
    ...(zhixuId !== undefined ? { zhixuId } : {}),
    ...(versionLabel !== undefined ? { versionLabel } : {}),
    ...(planId !== undefined ? { planId } : {}),
    ...(planHash !== undefined ? { planHash } : {}),
    ...(artifactHash !== undefined ? { artifactHash } : {}),
    ...(cutoverReason !== undefined ? { cutoverReason } : {})
  };
}

function requireBodyRecord(body: unknown): Record<string, unknown> {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  throw new ProductBffError(400, "invalid_body", "request body must be a JSON object");
}

function optionalBodyRecord(body: unknown): Record<string, unknown> {
  return body === undefined || body === null ? {} : requireBodyRecord(body);
}

function optionalString(record: Record<string, unknown>, field: string): string | undefined {
  if (!Object.hasOwn(record, field)) {
    return undefined;
  }
  const value = record[field];
  if (value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new ProductBffError(400, "invalid_body", `${field} must be a string`);
  }
  return value.trim();
}


async function resolveWalletSessionView(
  request: ApiRequest,
  sessionService: StoreSessionService | undefined
): Promise<StoreWalletSessionView | undefined> {
  if (!sessionService) {
    return undefined;
  }
  const token = request.headers?.[STORE_SESSION_HEADER] ?? request.headers?.[STORE_SESSION_HEADER.toLowerCase()];
  const resolved = await sessionService.resolveSessionFromToken(token?.trim() || undefined);
  return resolved?.session;
}

/** 下架 listing 在目录中不可见（运营方除外，便于治理观察）。 */
async function filterDelistedZhixus(
  request: ApiRequest,
  context: Parameters<RouteModule["handle"]>[1],
  body: unknown
): Promise<unknown> {
  if (!context.listingService) {
    return body;
  }
  const access = await context.storeIdentityProvider.resolve(request.headers);
  const isOperator = access.level === "store_operator" || access.level === "store_admin";
  const delisted = new Set(
    (await context.listingService.listListings("delisted"))
      .map((listing) => listing.planId.toLowerCase())
  );
  if (delisted.size === 0) {
    return body;
  }
  const record = body as { readonly zhixus?: readonly { readonly planId?: string }[] };
  if (!record?.zhixus) {
    return body;
  }
  const zhixus = isOperator
    ? record.zhixus
    : record.zhixus.filter((row) => !row.planId || !delisted.has(row.planId.toLowerCase()));
  return { ...record, zhixus, ...(isOperator ? { delistedPlanIds: [...delisted] } : {}) };
}

/** search 结果中的 zhixu 命中同样过滤已下架（非运营方）。 */
async function filterDelistedSearchResults(
  request: ApiRequest,
  context: Parameters<RouteModule["handle"]>[1],
  body: unknown
): Promise<unknown> {
  if (!context.listingService) {
    return body;
  }
  const access = await context.storeIdentityProvider.resolve(request.headers);
  const isOperator = access.level === "store_operator" || access.level === "store_admin";
  if (isOperator) {
    return body;
  }
  const delisted = new Set(
    (await context.listingService.listListings("delisted"))
      .map((listing) => listing.planId.toLowerCase())
  );
  if (delisted.size === 0) {
    return body;
  }
  const record = body as { readonly results?: readonly { readonly resultType?: string; readonly id?: string }[] };
  if (!record?.results?.length) {
    return body;
  }
  const zhixuPlanIds = await context.productService.listZhixu();
  const planIdByZhixuId = new Map(zhixuPlanIds.map((zhixu) => [zhixu.zhixuId, zhixu.planPublication.planId.toLowerCase()]));
  const results = record.results.filter((result) => {
    if (result.resultType !== "zhixu") {
      return true;
    }
    const planId = result.id ? planIdByZhixuId.get(result.id) : undefined;
    return !planId || !delisted.has(planId);
  });
  return { ...record, results };
}

function isPlanNotProjectedError(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" && "code" in error &&
    (error as { readonly code?: unknown }).code === "plan_not_found"
  );
}

interface StoreZhixuOverlayDTO {
  readonly listing?: unknown;
  readonly anchorVerification?: unknown;
  readonly decoration?: unknown;
  readonly viewerPermission?: unknown;
}

async function buildStoreZhixuOverlay(
  request: ApiRequest,
  context: Parameters<RouteModule["handle"]>[1],
  planId: string
): Promise<StoreZhixuOverlayDTO | undefined> {
  if (!context.listingService && !context.decorationService) {
    return undefined;
  }
  let normalizedPlanId: string;
  try {
    normalizedPlanId = normalizeBytes32(planId, "planId");
  } catch {
    return undefined;
  }
  let listingBlock: Pick<StoreZhixuOverlayDTO, "listing" | "anchorVerification"> | undefined;
  if (context.listingService) {
    const listingDetail = await context.listingService.findListingByPlanId(normalizedPlanId);
    if (listingDetail) {
      listingBlock = {
        listing: listingDetail.listing,
        anchorVerification: listingDetail.anchorVerification
      };
    }
  }
  let decorationBlock: Pick<StoreZhixuOverlayDTO, "decoration" | "viewerPermission"> | undefined;
  if (context.decorationService) {
    // 展示层叠加：plan 尚未投影时静默缺省（详情本身仍是链投影视图），
    // 不得因为装修域查不到 plan 而 404 掉整个详情页。
    try {
      const access = await context.storeIdentityProvider.resolve(request.headers);
      decorationBlock = {
        decoration: await context.decorationService.getDecoration(normalizedPlanId),
        viewerPermission: await context.decorationService.getPermissionView(normalizedPlanId, access.anchoredAddress)
      };
    } catch (error) {
      if (!isPlanNotProjectedError(error)) {
        throw error;
      }
    }
  }
  return {
    ...(listingBlock ?? {}),
    ...(decorationBlock ?? {})
  };
}
