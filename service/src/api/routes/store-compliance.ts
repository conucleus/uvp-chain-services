import {
  COMPLIANCE_DATA_LAYERS,
  type AuthorityGrant,
  type ComplianceAccessPreviewInput,
  type ComplianceResourceRef,
  type DataLayer
} from "../../compliance/index.js";
import {
  hasStoreCapability,
  isStoreAccessAuthenticated,
  type StoreAccessState,
  type StoreCapability
} from "../../store-console/access.js";
import { recordStoreAudit, type StoreAuditResource } from "../../store-console/audit.js";
import type { ApiRequest, ApiResponse, ApiRouteContext } from "../route-context.js";
import type { RouteModule } from "../route-module.js";
import {
  authorizeStoreCapability,
  forbiddenStoreCapabilityResponse,
  isStoreAuthorizationResult,
  recordStoreCapabilityFailure,
  recordStoreCapabilitySuccess,
  unauthorizedStoreCapabilityResponse
} from "../store-authz.js";

const DATA_LAYERS = new Set<string>(COMPLIANCE_DATA_LAYERS);

export function createStoreComplianceRouteModule(): RouteModule {
  return {
    async handle(request, context) {
      if (!request.pathname.startsWith("/store/compliance")) {
        return undefined;
      }

      try {
        if (request.method === "GET" && request.pathname === "/store/compliance/capabilities") {
          const capability = "store.read";
          const resource = { type: "store_compliance" };
          const authorization = await authorizeAuthenticatedStoreCapability(context, request, capability, resource);
          if (!isAuthenticatedStoreAuthorizationResult(authorization)) {
            return authorization;
          }
          const capabilities = await context.complianceService.getCapabilities();
          await recordStoreCapabilitySuccess(context, request, authorization.access, capability, resource, {
            providerMode: capabilities.providerMode,
            configured: capabilities.configured
          });
          return {
            status: 200,
            body: { capabilities }
          };
        }

        if (request.method === "POST" && request.pathname === "/store/compliance/access-preview") {
          const capability = "store.audit.read";
          const body = normalizeAccessPreviewBody(request.body);
          const resource = storeComplianceResource(body);
          const authorization = await authorizeStoreCapability(context, request, capability, resource);
          if (!isStoreAuthorizationResult(authorization)) {
            return authorization;
          }
          if (authorization.access.level === "store_read") {
            const error = new StoreComplianceRouteError("store_compliance_preview_forbidden");
            await recordStoreCapabilityFailure(context, request, authorization.access, capability, resource, error);
            return forbiddenStoreCapabilityResponse(authorization.access, capability);
          }

          try {
            const result = await context.complianceService.previewAccess(body);
            await recordStoreCapabilitySuccess(context, request, authorization.access, capability, resource, {
              dataLayer: body.dataLayer,
              resource
            });
            return {
              status: 200,
              body: { result }
            };
          } catch (error) {
            await recordStoreCapabilityFailure(context, request, authorization.access, capability, resource, error);
            throw error;
          }
        }
      } catch (error) {
        if (error instanceof StoreComplianceRouteError) {
          return {
            status: 400,
            body: {
              error: error.code,
              message: error.message
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
  };
}

interface AuthenticatedStoreAuthorizationResult {
  readonly access: StoreAccessState;
}

function isAuthenticatedStoreAuthorizationResult(
  value: AuthenticatedStoreAuthorizationResult | ApiResponse
): value is AuthenticatedStoreAuthorizationResult {
  return "access" in value;
}

async function authorizeAuthenticatedStoreCapability(
  context: ApiRouteContext,
  request: ApiRequest,
  capability: StoreCapability,
  resource: StoreAuditResource
): Promise<AuthenticatedStoreAuthorizationResult | ApiResponse> {
  const access = await context.storeIdentityProvider.resolve(request.headers);
  if (isStoreAccessAuthenticated(access) && hasStoreCapability(access, capability)) {
    return { access };
  }
  await recordStoreAudit(context.audit, {
    action: capability,
    outcome: "blocked",
    access,
    resource,
    errorCode: isStoreAccessAuthenticated(access) ? "forbidden" : access.authenticationFailure?.code ?? "store_identity_missing",
    ...(request.headers ? { headers: request.headers } : {})
  }, { store: context.storeAuditStore, now: context.now });
  if (!isStoreAccessAuthenticated(access)) {
    return unauthorizedStoreCapabilityResponse(access, capability);
  }
  return forbiddenStoreCapabilityResponse(access, capability);
}

class StoreComplianceRouteError extends Error {
  override readonly name = "StoreComplianceRouteError";

  constructor(readonly code: string) {
    super(code);
  }
}

function normalizeAccessPreviewBody(body: unknown): ComplianceAccessPreviewInput {
  const record = requireBodyRecord(body);
  const dataLayer = requiredDataLayer(record, "dataLayer");
  return {
    ...(optionalString(record, "subject") ? { subject: optionalString(record, "subject")! } : {}),
    ...(optionalString(record, "role") ? { role: optionalString(record, "role")! } : {}),
    ...(optionalString(record, "jurisdiction") ? { jurisdiction: optionalString(record, "jurisdiction")! } : {}),
    ...(optionalString(record, "zhixuId") ? { zhixuId: optionalString(record, "zhixuId")! } : {}),
    ...(optionalString(record, "orderId") ? { orderId: optionalString(record, "orderId")! } : {}),
    ...(optionalString(record, "stageId") ? { stageId: optionalString(record, "stageId")! } : {}),
    ...(optionalString(record, "signalName") ? { signalName: optionalString(record, "signalName")! } : {}),
    dataLayer,
    ...(optionalResource(record, "resource") ? { resource: optionalResource(record, "resource")! } : {}),
    ...(optionalAuthorityGrants(record, "authorityGrants") ? { authorityGrants: optionalAuthorityGrants(record, "authorityGrants")! } : {})
  };
}

function storeComplianceResource(input: ComplianceAccessPreviewInput): StoreAuditResource {
  return {
    type: "store_compliance",
    id: input.resource?.id ?? input.zhixuId ?? input.orderId ?? input.dataLayer,
    ...(input.resource?.parentId ? { parentId: input.resource.parentId } : {})
  };
}

function requireBodyRecord(body: unknown): Record<string, unknown> {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  throw new StoreComplianceRouteError("invalid_body");
}

function requiredDataLayer(record: Readonly<Record<string, unknown>>, field: string): DataLayer {
  const value = record[field];
  if (typeof value !== "string" || !DATA_LAYERS.has(value)) {
    throw new StoreComplianceRouteError("invalid_data_layer");
  }
  return value as DataLayer;
}

function optionalString(record: Readonly<Record<string, unknown>>, field: string): string | undefined {
  const value = record[field];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function optionalResource(record: Readonly<Record<string, unknown>>, field: string): ComplianceResourceRef | undefined {
  const value = record[field];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const resource = value as Record<string, unknown>;
  const type = optionalString(resource, "type");
  if (!type) {
    return undefined;
  }
  return {
    type,
    ...(optionalString(resource, "id") ? { id: optionalString(resource, "id")! } : {}),
    ...(optionalString(resource, "parentId") ? { parentId: optionalString(resource, "parentId")! } : {})
  };
}

function optionalAuthorityGrants(record: Readonly<Record<string, unknown>>, field: string): readonly AuthorityGrant[] | undefined {
  const value = record[field];
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.flatMap((item) => normalizeAuthorityGrant(item));
}

function normalizeAuthorityGrant(value: unknown): readonly AuthorityGrant[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  const record = value as Record<string, unknown>;
  const grantId = optionalString(record, "grantId");
  const issuer = optionalString(record, "issuer");
  const subject = optionalString(record, "subject");
  const jurisdiction = optionalString(record, "jurisdiction");
  if (!grantId || !issuer || !subject || !jurisdiction) {
    return [];
  }
  return [{
    grantId,
    issuer,
    subject,
    scope: optionalStringArray(record, "scope") ?? [],
    jurisdiction,
    ...(optionalString(record, "expiresAt") ? { expiresAt: optionalString(record, "expiresAt")! } : {}),
    ...(optionalString(record, "proofRef") ? { proofRef: optionalString(record, "proofRef")! } : {})
  }];
}

function optionalStringArray(record: Readonly<Record<string, unknown>>, field: string): readonly string[] | undefined {
  const value = record[field];
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}
