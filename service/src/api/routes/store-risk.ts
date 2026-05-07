import {
  RISK_GRAPH_SUPPORTED_SUBJECTS,
  type RiskAuthorityGrant,
  type RiskGraphAssessmentInput,
  type RiskGraphSubjectType
} from "../../risk/index.js";
import type { StoreAuditResource } from "../../store-console/audit.js";
import type { RouteModule } from "../route-module.js";
import {
  authorizeStoreCapability,
  isStoreAuthorizationResult,
  recordStoreCapabilityFailure,
  recordStoreCapabilitySuccess
} from "../store-authz.js";

const SUBJECT_TYPES = new Set<string>(RISK_GRAPH_SUPPORTED_SUBJECTS);

export function createStoreRiskRouteModule(): RouteModule {
  return {
    async handle(request, context) {
      if (!request.pathname.startsWith("/store/risk")) {
        return undefined;
      }

      try {
        if (request.method === "GET" && request.pathname === "/store/risk/capabilities") {
          const capability = "store.audit.read";
          const resource = { type: "store_risk" };
          const authorization = await authorizeStoreCapability(context, request, capability, resource);
          if (!isStoreAuthorizationResult(authorization)) {
            return authorization;
          }

          const capabilities = await context.riskGraphService.getCapabilities();
          await recordStoreCapabilitySuccess(context, request, authorization.access, capability, resource, {
            providerMode: capabilities.providerMode,
            configured: capabilities.configured
          });
          return {
            status: 200,
            body: { capabilities }
          };
        }

        if (request.method === "POST" && request.pathname === "/store/risk/assess") {
          const capability = "store.audit.read";
          const body = normalizeAssessmentBody(request.body);
          const resource = storeRiskResource(body);
          const authorization = await authorizeStoreCapability(context, request, capability, resource);
          if (!isStoreAuthorizationResult(authorization)) {
            return authorization;
          }

          try {
            const result = await context.riskGraphService.assess(body);
            await recordStoreCapabilitySuccess(context, request, authorization.access, capability, resource, {
              subjectType: body.subjectType,
              subject: subjectId(body),
              providerMode: result.providerMode,
              configured: result.configured
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
        if (error instanceof StoreRiskRouteError) {
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

class StoreRiskRouteError extends Error {
  override readonly name = "StoreRiskRouteError";

  constructor(readonly code: string) {
    super(code);
  }
}

function normalizeAssessmentBody(body: unknown): RiskGraphAssessmentInput {
  const record = requireBodyRecord(body);
  const subjectType = requiredSubjectType(record, "subjectType");
  return {
    subjectType,
    ...(optionalString(record, "zhixuId") ? { zhixuId: optionalString(record, "zhixuId")! } : {}),
    ...(optionalString(record, "orderId") ? { orderId: optionalString(record, "orderId")! } : {}),
    ...(optionalString(record, "entityId") ? { entityId: optionalString(record, "entityId")! } : {}),
    ...(Object.hasOwn(record, "riskSemantics") ? { riskSemantics: record.riskSemantics } : {}),
    ...(optionalAuthorityGrants(record, "authorityGrants") ? { authorityGrants: optionalAuthorityGrants(record, "authorityGrants")! } : {}),
    metadataOnly: true
  };
}

function storeRiskResource(input: RiskGraphAssessmentInput): StoreAuditResource {
  return {
    type: "store_risk",
    id: subjectId(input) ?? input.subjectType
  };
}

function subjectId(input: RiskGraphAssessmentInput): string | undefined {
  switch (input.subjectType) {
    case "zhixu":
      return input.zhixuId;
    case "order":
      return input.orderId;
    case "entity":
      return input.entityId;
  }
}

function requireBodyRecord(body: unknown): Record<string, unknown> {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  throw new StoreRiskRouteError("invalid_body");
}

function requiredSubjectType(record: Readonly<Record<string, unknown>>, field: string): RiskGraphSubjectType {
  const value = record[field];
  if (typeof value !== "string" || !SUBJECT_TYPES.has(value)) {
    throw new StoreRiskRouteError("invalid_subject_type");
  }
  return value as RiskGraphSubjectType;
}

function optionalString(record: Readonly<Record<string, unknown>>, field: string): string | undefined {
  const value = record[field];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function optionalAuthorityGrants(record: Readonly<Record<string, unknown>>, field: string): readonly RiskAuthorityGrant[] | undefined {
  const value = record[field];
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.flatMap((item) => normalizeAuthorityGrant(item));
}

function normalizeAuthorityGrant(value: unknown): readonly RiskAuthorityGrant[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  const record = value as Record<string, unknown>;
  const grantId = optionalString(record, "grantId");
  const issuer = optionalString(record, "issuer");
  const subject = optionalString(record, "subject");
  if (!grantId || !issuer || !subject) {
    return [];
  }
  return [{
    grantId,
    issuer,
    subject,
    scope: optionalStringArray(record, "scope") ?? [],
    ...(optionalString(record, "jurisdiction") ? { jurisdiction: optionalString(record, "jurisdiction")! } : {}),
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
