import { decodePathParameter, type ApiResponse } from "../route-context.js";
import type { RouteModule } from "../route-module.js";
import {
  canAccessDockingSession,
  StoreDockingServiceError,
  type StoreDockingSessionCreateDTO,
  type StoreDockingSessionDTO,
  type StoreDraftSignalMapEntryDTO
} from "../../store/console/docking.js";
import {
  authorizeStoreCapability,
  isAnchoredStoreAuthorizationResult,
  isStoreAuthorizationResult,
  recordStoreCapabilityFailure,
  recordStoreCapabilitySuccess,
  requireAnchoredStoreAddress
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
          // 红线：对接草案写操作要求会话已锚定地址。
          const anchored = await requireAnchoredStoreAddress(context, request, { type: "store_docking_session" });
          if (!isAnchoredStoreAuthorizationResult(anchored)) {
            return anchored;
          }
          try {
            // 归属由服务端锚定地址派生：创建者即会话租户，不从请求体取。
            const session = await context.storeDockingService.createSession(
              parseStoreDockingCreateBody(request.body),
              { anchoredAddress: anchored.anchoredAddress }
            );
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
          const sessionId = decodePathParameter(sessionMatch[1] ?? "");
          // 会话档案含草稿信号映射，与 create/validate/save 同门：按 id 读
          // 也要求已认证的 Store 身份（store.docking.read），匿名不可枚举。
          const resource = { type: "store_docking_session" as const, id: sessionId };
          const authorization = await authorizeStoreCapability(context, request, "store.docking.read", resource);
          if (!isStoreAuthorizationResult(authorization)) {
            return authorization;
          }
          try {
            const session = await context.storeDockingService.getSession(sessionId);
            // 归属断言：非本租户会话与不存在同响应（404），不向他人
            // reader 泄露会话存在性；管理员保留跨租户治理可见性。
            if (!session || !canAccessDockingSession(session, authorization.access)) {
              const denied = new StoreDockingServiceError(
                404,
                "docking_session_not_found",
                "docking session was not found",
                { sessionId }
              );
              await recordStoreCapabilityFailure(context, request, authorization.access, "store.docking.read", resource, denied);
              return {
                status: 404,
                body: { error: "docking_session_not_found" }
              };
            }
            await recordStoreCapabilitySuccess(context, request, authorization.access, "store.docking.read", resource);
            return {
              status: 200,
              body: { session }
            };
          } catch (error) {
            await recordStoreCapabilityFailure(context, request, authorization.access, "store.docking.read", resource, error);
            throw error;
          }
        }

        const validateMatch = /^\/store\/docking-sessions\/([^/]+)\/validate$/.exec(request.pathname);
        if (request.method === "POST" && validateMatch) {
          const sessionId = decodePathParameter(validateMatch[1] ?? "");
          const capability = "store.docking.validate";
          const resource = { type: "store_docking_session", id: sessionId };
          const authorization = await authorizeStoreCapability(context, request, capability, resource);
          if (!isStoreAuthorizationResult(authorization)) {
            return authorization;
          }
          const anchored = await requireAnchoredStoreAddress(context, request, resource);
          if (!isAnchoredStoreAuthorizationResult(anchored)) {
            return anchored;
          }
          const ownership = await dockingSessionOwnership(context, sessionId, authorization.access);
          if ("response" in ownership) {
            await recordStoreCapabilityFailure(context, request, authorization.access, capability, resource, ownership.error);
            return ownership.response;
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
          const sessionId = decodePathParameter(saveMatch[1] ?? "");
          const capability = "store.docking.save";
          const resource = { type: "store_docking_session", id: sessionId };
          const authorization = await authorizeStoreCapability(context, request, capability, resource);
          if (!isStoreAuthorizationResult(authorization)) {
            return authorization;
          }
          const anchored = await requireAnchoredStoreAddress(context, request, resource);
          if (!isAnchoredStoreAuthorizationResult(anchored)) {
            return anchored;
          }
          const ownership = await dockingSessionOwnership(context, sessionId, authorization.access);
          if ("response" in ownership) {
            await recordStoreCapabilityFailure(context, request, authorization.access, capability, resource, ownership.error);
            return ownership.response;
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

/**
 * 写路径（validate/save-draft-map）的租户归属断言：写者已过能力门与
 * 锚定门，403 明示"不是你的会话"（与装修面 not_plan_publisher 同口径），
 * 不与 404 混淆——写者身份已知，掩盖存在性没有意义。
 */
async function dockingSessionOwnership(
  context: Parameters<RouteModule["handle"]>[1],
  sessionId: string,
  access: Parameters<typeof canAccessDockingSession>[1]
): Promise<{ readonly session: StoreDockingSessionDTO } | { readonly response: ApiResponse; readonly error: StoreDockingServiceError }> {
  const session = await context.storeDockingService.getSession(sessionId);
  if (session && canAccessDockingSession(session, access)) {
    return { session };
  }
  const notFound = session === undefined;
  const error = notFound
    ? new StoreDockingServiceError(404, "docking_session_not_found", "docking session was not found", { sessionId })
    : new StoreDockingServiceError(403, "docking_session_access_forbidden", "docking session belongs to another store tenant", { sessionId });
  return {
    error,
    response: {
      status: notFound ? 404 : 403,
      body: { error: error.code, message: error.message, ...(error.details !== undefined ? { details: error.details } : {}) }
    }
  };
}

function parseStoreDockingCreateBody(body: unknown): StoreDockingSessionCreateDTO {
  const record = requireStoreDockingBodyRecord(body);
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
  const targetInterfaceName = optionalStoreDockingString(record, "targetInterfaceName");
  const orderMode = optionalStoreDockingOrderMode(record);
  return {
    sourceZhixuId,
    targetZhixuId,
    ...(targetInterfaceName !== undefined ? { targetInterfaceName } : {}),
    ...(orderMode !== undefined ? { orderMode } : {})
  };
}

function optionalStoreDockingOrderMode(record: Record<string, unknown>): "new" | "existing" | undefined {
  if (!Object.hasOwn(record, "orderMode") || record.orderMode === null) {
    return undefined;
  }
  const value = record.orderMode;
  if (value !== "new" && value !== "existing") {
    throw new StoreDockingServiceError(400, "invalid_body", "orderMode must be \"new\" or \"existing\"");
  }
  return value;
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
    const bindingKind = entry.bindingKind;
    if (bindingKind !== "input" && bindingKind !== "output") {
      throw new StoreDockingServiceError(
        400,
        "invalid_body",
        `draftSignalMap[${index}].bindingKind must be "input" or "output"`
      );
    }
    return {
      ...(entryId !== undefined ? { entryId } : {}),
      bindingKind,
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
