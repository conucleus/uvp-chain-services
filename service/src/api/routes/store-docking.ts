import type { RouteModule } from "../route-module.js";
import {
  StoreDockingServiceError,
  type StoreDockingSessionCreateDTO,
  type StoreDraftSignalMapEntryDTO
} from "../../store-console/docking.js";
import {
  authorizeStoreCapability,
  isStoreAuthorizationResult,
  recordStoreCapabilityFailure,
  recordStoreCapabilitySuccess
} from "../store-authz.js";
import { redactErrorMessage } from "../../security/redaction.js";

export function createStoreDockingRouteModule(): RouteModule {
  return {
    async handle(request, context) {
      if (!request.pathname.startsWith("/store/docking-sessions")) {
        return undefined;
      }

      try {
        if (request.method === "POST" && request.pathname === "/store/docking-sessions") {
          const capability = "store.docking.create";
          const authorization = await authorizeStoreCapability(context, request, capability, { type: "store_docking_session" });
          if (!isStoreAuthorizationResult(authorization)) {
            return authorization;
          }
          try {
            const session = await context.storeDockingService.createSession(parseStoreDockingCreateBody(request.body));
            await recordStoreCapabilitySuccess(context, request, authorization.access, capability, {
              type: "store_docking_session",
              id: session.sessionId
            });
            return {
              status: 201,
              body: { session }
            };
          } catch (error) {
            await recordStoreCapabilityFailure(context, request, authorization.access, capability, {
              type: "store_docking_session"
            }, error);
            throw error;
          }
        }

        const sessionMatch = /^\/store\/docking-sessions\/([^/]+)$/.exec(request.pathname);
        if (request.method === "GET" && sessionMatch) {
          const sessionId = decodeURIComponent(sessionMatch[1] ?? "");
          const session = await context.storeDockingService.getSession(sessionId);
          if (!session) {
            return {
              status: 404,
              body: { error: "docking_session_not_found" }
            };
          }
          return {
            status: 200,
            body: { session }
          };
        }

        const validateMatch = /^\/store\/docking-sessions\/([^/]+)\/validate$/.exec(request.pathname);
        if (request.method === "POST" && validateMatch) {
          const sessionId = decodeURIComponent(validateMatch[1] ?? "");
          const capability = "store.docking.validate";
          const resource = { type: "store_docking_session", id: sessionId };
          const authorization = await authorizeStoreCapability(context, request, capability, resource);
          if (!isStoreAuthorizationResult(authorization)) {
            return authorization;
          }
          try {
            const session = await context.storeDockingService.validateSession(
              sessionId,
              parseStoreDraftSignalMapBody(request.body)
            );
            await recordStoreCapabilitySuccess(context, request, authorization.access, capability, resource);
            return {
              status: 200,
              body: { session }
            };
          } catch (error) {
            await recordStoreCapabilityFailure(context, request, authorization.access, capability, resource, error);
            throw error;
          }
        }

        const saveMatch = /^\/store\/docking-sessions\/([^/]+)\/save-draft-map$/.exec(request.pathname);
        if (request.method === "POST" && saveMatch) {
          const sessionId = decodeURIComponent(saveMatch[1] ?? "");
          const capability = "store.docking.save";
          const resource = { type: "store_docking_session", id: sessionId };
          const authorization = await authorizeStoreCapability(context, request, capability, resource);
          if (!isStoreAuthorizationResult(authorization)) {
            return authorization;
          }
          try {
            const session = await context.storeDockingService.saveDraftMap(
              sessionId,
              parseStoreDraftSignalMapBody(request.body)
            );
            await recordStoreCapabilitySuccess(context, request, authorization.access, capability, resource);
            return {
              status: 200,
              body: { session }
            };
          } catch (error) {
            await recordStoreCapabilityFailure(context, request, authorization.access, capability, resource, error);
            throw error;
          }
        }
      } catch (error) {
        if (error instanceof StoreDockingServiceError) {
          return {
            status: error.status,
            body: {
              error: error.code,
              message: error.message,
              ...(error.details !== undefined ? { details: error.details } : {})
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

function parseStoreDockingCreateBody(body: unknown): StoreDockingSessionCreateDTO {
  const record = requireStoreDockingBodyRecord(body);
  const sourceVersionId = optionalStoreDockingString(record, "sourceVersionId");
  const targetVersionId = optionalStoreDockingString(record, "targetVersionId");
  const sourceZhixuId = requiredStoreDockingString(record, "sourceZhixuId");
  const targetZhixuId = requiredStoreDockingString(record, "targetZhixuId");
  // STORE-03：路由层快速拦截 self-docking（服务层为权威校验）。
  if (sourceZhixuId === targetZhixuId) {
    throw new StoreDockingServiceError(
      422,
      "self_docking_forbidden",
      "sourceZhixuId and targetZhixuId must be different zhixu definitions",
      { sourceZhixuId, targetZhixuId }
    );
  }
  return {
    sourceZhixuId,
    targetZhixuId,
    ...(sourceVersionId !== undefined ? { sourceVersionId } : {}),
    ...(targetVersionId !== undefined ? { targetVersionId } : {})
  };
}

function parseStoreDraftSignalMapBody(body: unknown): readonly StoreDraftSignalMapEntryDTO[] {
  const record = requireStoreDockingBodyRecord(body);
  const value = record.draftSignalMap;
  if (!Array.isArray(value)) {
    throw new StoreDockingServiceError(400, "invalid_body", "draftSignalMap must be an array");
  }
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new StoreDockingServiceError(400, "invalid_body", `draftSignalMap[${index}] must be an object`);
    }
    const entry = item as Record<string, unknown>;
    const note = optionalStoreDockingString(entry, "note");
    const entryId = optionalStoreDockingString(entry, "entryId");
    return {
      ...(entryId !== undefined ? { entryId } : {}),
      sourceSignalId: requiredStoreDockingString(entry, "sourceSignalId"),
      targetSignalId: requiredStoreDockingString(entry, "targetSignalId"),
      ...(note !== undefined ? { note } : {})
    };
  });
}

function requireStoreDockingBodyRecord(body: unknown): Record<string, unknown> {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  throw new StoreDockingServiceError(400, "invalid_body", "request body must be a JSON object");
}

function requiredStoreDockingString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new StoreDockingServiceError(400, "invalid_body", `${field} must be a non-empty string`);
  }
  return value.trim();
}

function optionalStoreDockingString(record: Record<string, unknown>, field: string): string | undefined {
  if (!Object.hasOwn(record, field) || record[field] === null) {
    return undefined;
  }
  const value = record[field];
  if (typeof value !== "string") {
    throw new StoreDockingServiceError(400, "invalid_body", `${field} must be a string`);
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
