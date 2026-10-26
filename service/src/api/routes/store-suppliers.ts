import { GovernanceServiceError } from "../../governance/index.js";
import { SupplierNotificationConfigError } from "../../notifications/index.js";
import { redactErrorMessage } from "../../security/redaction.js";
import { ConfigError } from "../../shared/types.js";
import {
  StoreSupplierServiceError,
  type StoreOperatorPrincipal,
  type StoreSupplierListQuery
} from "../../store/suppliers/service.js";
import type { StoreAccessState } from "../../store/console/access.js";
import { cleanQuery, decodePathParameter, InvalidPathParameterError, invalidPathParameterResponse, type ApiRequest, type ApiResponse } from "../route-context.js";
import type { RouteModule } from "../route-module.js";
import {
  authorizeStoreAuthenticated,
  authorizeStoreGovernance,
  authorizeStoreRead,
  authorizeStoreWrite,
  isAnchoredStoreAuthorizationResult,
  isStoreAuthorizationResult,
  recordStoreAccessFailure,
  recordStoreAccessSuccess,
  requireAnchoredStoreAddress,
  requireStoreConfirmation,
  StoreConfirmationError,
  storeConfirmationErrorResponse
} from "../store-authz.js";

type ParsedStoreSupplierQuery =
  | { readonly ok: true; readonly query: StoreSupplierListQuery }
  | { readonly ok: false; readonly response: ApiResponse };

export function createStoreSuppliersRouteModule(): RouteModule {
  return {
    async handle(request, context) {
      if (!request.pathname.startsWith("/store/suppliers")) {
        return undefined;
      }

      try {
        if (request.method === "GET" && request.pathname === "/store/suppliers") {
          const parsedQuery = parseStoreSupplierQuery(request.query);
          if (!parsedQuery.ok) {
            return parsedQuery.response;
          }
          const resource = { type: "store_supplier" };
          const authorization = await authorizeStoreAuthenticated(context, request, "store.read", resource);
          if (!isStoreAuthorizationResult(authorization)) {
            return authorization;
          }
          return {
            status: 200,
            body: await context.storeSupplierService.listSuppliers(parsedQuery.query)
          };
        }

        if (request.method === "POST" && request.pathname === "/store/suppliers") {
          const auditAction = "store.supplier.create";
          const resource = { type: "store_supplier" };
          const authorization = await authorizeStoreWrite(context, request, auditAction, resource);
          if (!isStoreAuthorizationResult(authorization)) {
            return authorization;
          }
          const anchored = await requireAnchoredStoreAddress(context, request, resource);
          if (!isAnchoredStoreAuthorizationResult(anchored)) {
            return anchored;
          }
          try {
            const body = await context.storeSupplierService.createSupplier(
              request.body,
              storeOperatorPrincipalFromAccess(authorization.access)
            );
            const createdSupplierId = supplierIdFromBody(body);
            await recordStoreAccessSuccess(context, request, authorization.access, auditAction, {
              type: "store_supplier",
              ...(createdSupplierId ? { id: createdSupplierId } : {})
            });
            return {
              status: 201,
              body
            };
          } catch (error) {
            await recordStoreAccessFailure(context, request, authorization.access, auditAction, { type: "store_supplier" }, error);
            throw error;
          }
        }

        const supplierAuditMatch = /^\/store\/suppliers\/([^/]+)\/audits$/.exec(request.pathname);
        if (request.method === "GET" && supplierAuditMatch) {
          const supplierId = decodePathParameter(supplierAuditMatch[1] ?? "");
          const auditAction = "store.audit.read";
          const resource = { type: "store_supplier", id: supplierId };
          const authorization = await authorizeStoreRead(context, request, auditAction, resource);
          if (!isStoreAuthorizationResult(authorization)) {
            return authorization;
          }
          const body = await context.storeSupplierService.listSupplierAudits(supplierId);
          await recordStoreAccessSuccess(context, request, authorization.access, auditAction, resource, {
            resultCount: body.records.length
          });
          return {
            status: 200,
            body
          };
        }

        const notificationProfileMatch = /^\/store\/suppliers\/([^/]+)\/notification-profile(?:\/(prepare))?$/.exec(request.pathname);
        if (request.method === "POST" && notificationProfileMatch) {
          const supplierId = decodePathParameter(notificationProfileMatch[1] ?? "");
          const action = notificationProfileMatch[2];
          const profileResource = { type: "store_supplier", id: supplierId };
          const profileAuthorization = await authorizeStoreWrite(context, request, "store.supplier.notification_profile.update", profileResource);
          if (!isStoreAuthorizationResult(profileAuthorization)) {
            return profileAuthorization;
          }
          if (action === "prepare") {
            return {
              status: 200,
              body: await context.storeSupplierService.prepareNotificationProfile(supplierId, request.body)
            };
          }
          const profileAnchored = await requireAnchoredStoreAddress(context, request, profileResource);
          if (!isAnchoredStoreAuthorizationResult(profileAnchored)) {
            return profileAnchored;
          }
          return {
            status: 201,
            body: await context.storeSupplierService.saveNotificationProfile(supplierId, request.body)
          };
        }

        const supplierMatch = /^\/store\/suppliers\/([^/]+)(?:\/(review|request-identity-registration|request-identity-revocation))?$/.exec(request.pathname);
        if (!supplierMatch) {
          return {
            status: 404,
            body: { error: "not_found" }
          };
        }

        const supplierId = decodePathParameter(supplierMatch[1] ?? "");
        const action = supplierMatch[2];

        if (request.method === "GET" && !action) {
          const readAuthorization = await authorizeStoreAuthenticated(context, request, "store.read", { type: "store_supplier", id: supplierId });
          if (!isStoreAuthorizationResult(readAuthorization)) {
            return readAuthorization;
          }
          const supplier = await context.storeSupplierService.getSupplier(supplierId);
          if (!supplier) {
            return {
              status: 404,
              body: { error: "store_supplier_not_found" }
            };
          }
          return {
            status: 200,
            body: { supplier }
          };
        }

        if (request.method === "POST" && action) {
          const auditAction = supplierAuditAction(action);
          const resource = { type: "store_supplier", id: supplierId };
          const authorization = action === "review"
            ? await authorizeStoreWrite(context, request, auditAction, resource)
            : await authorizeStoreGovernance(context, request, auditAction, resource);
          if (!isStoreAuthorizationResult(authorization)) {
            return authorization;
          }
          const anchored = await requireAnchoredStoreAddress(context, request, resource);
          if (!isAnchoredStoreAuthorizationResult(anchored)) {
            return anchored;
          }
          const confirmationError = await supplierConfirmationError(context, request, supplierId, action);
          if (confirmationError) {
            await recordStoreAccessFailure(context, request, authorization.access, auditAction, resource, confirmationError);
            return storeConfirmationErrorResponse(confirmationError);
          }
          switch (action) {
            case "review": {
              try {
                const body = await context.storeSupplierService.reviewSupplier(
                  supplierId,
                  request.body,
                  storeOperatorPrincipalFromAccess(authorization.access)
                );
                await recordStoreAccessSuccess(context, request, authorization.access, auditAction, resource);
                return { status: 200, body };
              } catch (error) {
                await recordStoreAccessFailure(context, request, authorization.access, auditAction, resource, error);
                throw error;
              }
            }
            case "request-identity-registration": {
              try {
                const body = await context.storeSupplierService.requestIdentityRegistration(
                  supplierId,
                  request.body,
                  storeOperatorPrincipalFromAccess(authorization.access)
                );
                await recordStoreAccessSuccess(context, request, authorization.access, auditAction, resource);
                return { status: 202, body };
              } catch (error) {
                await recordStoreAccessFailure(context, request, authorization.access, auditAction, resource, error);
                throw error;
              }
            }
            case "request-identity-revocation": {
              try {
                const body = await context.storeSupplierService.requestIdentityRevocation(
                  supplierId,
                  request.body,
                  storeOperatorPrincipalFromAccess(authorization.access)
                );
                await recordStoreAccessSuccess(context, request, authorization.access, auditAction, resource);
                return { status: 202, body };
              } catch (error) {
                await recordStoreAccessFailure(context, request, authorization.access, auditAction, resource, error);
                throw error;
              }
            }
          }
        }
      } catch (error) {
        if (error instanceof InvalidPathParameterError) {
          return invalidPathParameterResponse();
        }
        if (error instanceof StoreSupplierServiceError) {
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
        if (error instanceof SupplierNotificationConfigError) {
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
        return {
          status: 503,
          body: {
            error: "store_metadata_unavailable",
            message: redactErrorMessage(error)
          }
        };
      }

      return {
        status: 404,
        body: { error: "not_found" }
      };
    }
  };
}

function parseStoreSupplierQuery(query: ApiRequest["query"]): ParsedStoreSupplierQuery {
  const identity = query?.identity;
  if (identity && identity !== "active" && identity !== "revoked" && identity !== "not_found") {
    return {
      ok: false,
      response: {
        status: 400,
        body: { error: "invalid_query", message: "identity must be active, revoked, or not_found" }
      }
    };
  }
  return {
    ok: true,
    query: cleanQuery({
      query: query?.query,
      identity
    }) as StoreSupplierListQuery
  };
}

function supplierAuditAction(action: string): string {
  switch (action) {
    case "request-identity-registration":
      return "store.supplier.identity.register";
    case "request-identity-revocation":
      return "store.supplier.identity.revoke";
    default:
      return "store.supplier.review";
  }
}

async function supplierConfirmationError(
  context: Parameters<RouteModule["handle"]>[1],
  request: ApiRequest,
  supplierId: string,
  action: string
): Promise<StoreConfirmationError | undefined> {
  try {
    const body = bodyRecord(request.body);
    if (action === "review" && !isSensitiveReviewStatus(optionalString(body, "reviewStatus"))) {
      return undefined;
    }
    requireStoreConfirmation(request.body, {
      supplierId
    });
    return undefined;
  } catch (error) {
    if (error instanceof StoreConfirmationError) {
      return error;
    }
    throw error;
  }
}

function isSensitiveReviewStatus(status: string | undefined): boolean {
  return status === "approved_for_broadcast" || status === "rejected";
}

function storeOperatorPrincipalFromAccess(access: StoreAccessState): StoreOperatorPrincipal {
  return {
    operatorId: access.principalId ?? (access.anchoredAddress ? `wallet:${access.anchoredAddress}` : "unauthenticated"),
    role: access.roles.includes("governance_admin") ? "governance_admin" : access.level
  };
}

function bodyRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
}

function optionalString(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function supplierIdFromBody(body: unknown): string | undefined {
  const record = body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : undefined;
  const supplier = record?.supplier;
  if (supplier && typeof supplier === "object" && !Array.isArray(supplier)) {
    const supplierId = (supplier as Record<string, unknown>).supplierId;
    if (typeof supplierId === "string" && supplierId.trim().length > 0) {
      return supplierId.trim();
    }
  }
  return undefined;
}
