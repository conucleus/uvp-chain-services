import { GovernanceServiceError } from "../../governance/index.js";
import { SupplierNotificationConfigError } from "../../notifications/index.js";
import { redactErrorMessage } from "../../security/redaction.js";
import { ConfigError } from "../../shared/types.js";
import {
  StoreSupplierServiceError,
  type StoreOperatorPrincipal,
  type StoreSupplierListQuery
} from "../../store-suppliers/service.js";
import type { StoreAccessState, StoreCapability } from "../../store-console/access.js";
import { cleanQuery, type ApiRequest, type ApiResponse } from "../route-context.js";
import type { RouteModule } from "../route-module.js";
import {
  authorizeStoreCapability,
  isStoreAuthorizationResult,
  recordStoreCapabilityFailure,
  recordStoreCapabilitySuccess,
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
          return {
            status: 200,
            body: await context.storeSupplierService.listSuppliers(parsedQuery.query)
          };
        }

        if (request.method === "POST" && request.pathname === "/store/suppliers") {
          const capability = "store.supplier.create";
          const authorization = await authorizeStoreCapability(context, request, capability, { type: "store_supplier" });
          if (!isStoreAuthorizationResult(authorization)) {
            return authorization;
          }
          try {
            const body = await context.storeSupplierService.createSupplier(
              request.body,
              storeOperatorPrincipalFromAccess(authorization.access)
            );
            const createdSupplierId = supplierIdFromBody(body);
            await recordStoreCapabilitySuccess(context, request, authorization.access, capability, {
              type: "store_supplier",
              ...(createdSupplierId ? { id: createdSupplierId } : {})
            });
            return {
              status: 201,
              body
            };
          } catch (error) {
            await recordStoreCapabilityFailure(context, request, authorization.access, capability, { type: "store_supplier" }, error);
            throw error;
          }
        }

        const supplierAuditMatch = /^\/store\/suppliers\/([^/]+)\/audits$/.exec(request.pathname);
        if (request.method === "GET" && supplierAuditMatch) {
          const supplierId = decodeURIComponent(supplierAuditMatch[1] ?? "");
          const capability = "store.audit.read";
          const resource = { type: "store_supplier", id: supplierId };
          const authorization = await authorizeStoreCapability(context, request, capability, resource);
          if (!isStoreAuthorizationResult(authorization)) {
            return authorization;
          }
          const body = await context.storeSupplierService.listSupplierAudits(supplierId);
          await recordStoreCapabilitySuccess(context, request, authorization.access, capability, resource, {
            resultCount: body.records.length
          });
          return {
            status: 200,
            body
          };
        }

        const notificationProfileMatch = /^\/store\/suppliers\/([^/]+)\/notification-profile(?:\/(prepare))?$/.exec(request.pathname);
        if (request.method === "POST" && notificationProfileMatch) {
          const supplierId = decodeURIComponent(notificationProfileMatch[1] ?? "");
          const action = notificationProfileMatch[2];
          // 与同模块其余写路由同口径：通知配置可改写供应商钱包与 webhook，
          // 必须走 store capability 鉴权——裸 wallet 证明只证明"签名者控制
          // 请求体里的新 wallet"，与供应商既有身份无关。
          const profileCapability: StoreCapability = "store.supplier.notification_profile.update";
          const profileResource = { type: "store_supplier", id: supplierId };
          const profileAuthorization = await authorizeStoreCapability(context, request, profileCapability, profileResource);
          if (!isStoreAuthorizationResult(profileAuthorization)) {
            return profileAuthorization;
          }
          if (action === "prepare") {
            return {
              status: 200,
              body: await context.storeSupplierService.prepareNotificationProfile(supplierId, request.body)
            };
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

        const supplierId = decodeURIComponent(supplierMatch[1] ?? "");
        const action = supplierMatch[2];

        if (request.method === "GET" && !action) {
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
          const capability = supplierCapability(action);
          const resource = { type: "store_supplier", id: supplierId };
          const authorization = await authorizeStoreCapability(context, request, capability, resource);
          if (!isStoreAuthorizationResult(authorization)) {
            return authorization;
          }
          if (action === "review" && bodyHasSupplierCapabilityEditField(request.body)) {
            const tagAuthorization = await authorizeStoreCapability(context, request, "store.supplier.tags.update", resource);
            if (!isStoreAuthorizationResult(tagAuthorization)) {
              return tagAuthorization;
            }
          }
          const confirmationError = await supplierConfirmationError(context, request, supplierId, action);
          if (confirmationError) {
            await recordStoreCapabilityFailure(context, request, authorization.access, capability, resource, confirmationError);
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
                await recordStoreCapabilitySuccess(context, request, authorization.access, capability, resource);
                if (bodyHasSupplierCapabilityEditField(request.body)) {
                  await recordStoreCapabilitySuccess(context, request, authorization.access, "store.supplier.tags.update", resource);
                }
                return { status: 200, body };
              } catch (error) {
                await recordStoreCapabilityFailure(context, request, authorization.access, capability, resource, error);
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
                await recordStoreCapabilitySuccess(context, request, authorization.access, capability, resource);
                return { status: 202, body };
              } catch (error) {
                await recordStoreCapabilityFailure(context, request, authorization.access, capability, resource, error);
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
                await recordStoreCapabilitySuccess(context, request, authorization.access, capability, resource);
                return { status: 202, body };
              } catch (error) {
                await recordStoreCapabilityFailure(context, request, authorization.access, capability, resource, error);
                throw error;
              }
            }
          }
        }
      } catch (error) {
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
      tag: query?.tag,
      identity
    }) as StoreSupplierListQuery
  };
}

function supplierCapability(action: string): StoreCapability {
  switch (action) {
    case "review":
      return "store.supplier.review";
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
    operatorId: access.principalId ?? "unknown-store-principal",
    role: access.roles.includes("governance_admin") ? "governance_admin" : access.level
  };
}

function bodyHasField(body: unknown, field: string): boolean {
  return Boolean(body && typeof body === "object" && !Array.isArray(body) && Object.hasOwn(body, field));
}

function bodyHasSupplierCapabilityEditField(body: unknown): boolean {
  return bodyHasField(body, "capabilityTags") ||
    bodyHasField(body, "supportedRoleSlotIds") ||
    bodyHasField(body, "supportedStageIds");
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
