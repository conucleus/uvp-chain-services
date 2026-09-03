import type { ApiRequest, ApiResponse, ApiRouteContext } from "./route-context.js";
import {
  hasStoreCapability,
  isStoreAccessAuthenticated,
  storeAccessRequiredLevel,
  type StoreAccessState,
  type StoreCapability
} from "../store-console/access.js";
import {
  recordStoreAudit,
  type StoreAuditResource
} from "../store-console/audit.js";
import type { AuditOutcome } from "../security/audit.js";
import type { Address } from "../shared/types.js";

export interface StoreAuthorizationResult {
  readonly access: StoreAccessState;
}

/**
 * PRD89 红线：敏感操作（授权、装修、审核写操作）要求会话已锚定地址。
 * 锚定来源：钱包会话（签名证明）或 local 开发头；服务端强制。
 */
export interface AnchoredStoreAuthorizationResult {
  readonly access: StoreAccessState;
  readonly anchoredAddress: Address;
  readonly accountId?: string;
}

export function isAnchoredStoreAuthorizationResult(
  value: AnchoredStoreAuthorizationResult | ApiResponse
): value is AnchoredStoreAuthorizationResult {
  return "anchoredAddress" in value;
}

export async function requireAnchoredStoreAddress(
  context: ApiRouteContext,
  request: ApiRequest,
  resource: StoreAuditResource
): Promise<AnchoredStoreAuthorizationResult | ApiResponse> {
  const access = await context.storeIdentityProvider.resolve(request.headers);
  if (access.anchoredAddress) {
    return {
      access,
      anchoredAddress: access.anchoredAddress,
      ...(access.walletAccountId ? { accountId: access.walletAccountId } : {})
    };
  }
  await recordStoreAudit(context.audit, {
    action: "store.address_anchor_required",
    outcome: "blocked",
    access,
    resource,
    errorCode: isStoreAccessAuthenticated(access) ? "store_address_anchor_required" : access.authenticationFailure?.code ?? "store_identity_missing",
    ...(request.headers ? { headers: request.headers } : {})
  }, { store: context.storeAuditStore, now: context.now });
  return {
    status: isStoreAccessAuthenticated(access) ? 403 : 401,
    body: {
      error: isStoreAccessAuthenticated(access) ? "store_address_anchor_required" : (access.authenticationFailure?.code ?? "store_identity_missing"),
      message: isStoreAccessAuthenticated(access)
        ? "this action requires a session anchored to a wallet address (log in with a wallet session)"
        : (access.authenticationFailure?.message ?? "Store identity is required"),
      accessLevel: access.level,
      authMode: access.authMode
    }
  };
}

export async function authorizeStoreCapability(
  context: ApiRouteContext,
  request: ApiRequest,
  capability: StoreCapability,
  resource: StoreAuditResource
): Promise<StoreAuthorizationResult | ApiResponse> {
  const access = await context.storeIdentityProvider.resolve(request.headers);
  if (hasStoreCapability(access, capability)) {
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

export async function recordStoreCapabilitySuccess(
  context: ApiRouteContext,
  request: ApiRequest,
  access: StoreAccessState,
  capability: StoreCapability,
  resource: StoreAuditResource,
  metadata?: Readonly<Record<string, unknown>>
): Promise<void> {
  await recordStoreAudit(context.audit, {
    action: capability,
    outcome: "succeeded",
    access,
    resource,
    ...(request.headers ? { headers: request.headers } : {}),
    ...(metadata ? { metadata } : {})
  }, { store: context.storeAuditStore, now: context.now });
}

export async function recordStoreCapabilityFailure(
  context: ApiRouteContext,
  request: ApiRequest,
  access: StoreAccessState,
  capability: StoreCapability,
  resource: StoreAuditResource,
  error: unknown
): Promise<void> {
  await recordStoreAudit(context.audit, {
    action: capability,
    outcome: storeFailureAuditOutcome(error),
    access,
    resource,
    errorCode: errorCode(error),
    ...(request.headers ? { headers: request.headers } : {})
  }, { store: context.storeAuditStore, now: context.now });
}

export function isStoreAuthorizationResult(value: StoreAuthorizationResult | ApiResponse): value is StoreAuthorizationResult {
  return "access" in value;
}

export function forbiddenStoreCapabilityResponse(access: StoreAccessState, capability: StoreCapability): ApiResponse {
  const requiredAccess = storeAccessRequiredLevel(capability);
  return {
    status: 403,
    body: {
      error: "forbidden",
      requiredCapability: capability,
      requiredAccess,
      accessLevel: access.level,
      authMode: access.authMode
    }
  };
}

export function unauthorizedStoreCapabilityResponse(access: StoreAccessState, capability: StoreCapability): ApiResponse {
  const requiredAccess = storeAccessRequiredLevel(capability);
  return {
    status: 401,
    body: {
      error: access.authenticationFailure?.code ?? "store_identity_missing",
      message: access.authenticationFailure?.message ?? "Store identity is required",
      requiredCapability: capability,
      requiredAccess,
      accessLevel: access.level,
      authMode: access.authMode
    }
  };
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  if (error && typeof error === "object" && "name" in error && typeof error.name === "string") {
    return error.name;
  }
  return "store_action_failed";
}

function storeFailureAuditOutcome(error: unknown): AuditOutcome {
  if (error instanceof StoreConfirmationError) {
    return "rejected";
  }
  const code = errorCode(error);
  if (/duplicate|already|exists/i.test(code)) {
    return "duplicate";
  }
  return "failed";
}

export class StoreConfirmationError extends Error {
  override readonly name = "StoreConfirmationError";

  constructor(
    readonly code: "store_confirmation_required" | "store_confirmation_mismatch",
    message: string,
    readonly details?: unknown
  ) {
    super(message);
  }
}

export function requireStoreConfirmation(
  body: unknown,
  expected: Readonly<Record<string, string | undefined>>
): void {
  const requiredEntries = Object.entries(expected)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0);
  const bodyRecord = body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : undefined;
  const confirmation = bodyRecord?.confirmation;
  if (!confirmation || typeof confirmation !== "object" || Array.isArray(confirmation)) {
    throw new StoreConfirmationError(
      "store_confirmation_required",
      "sensitive Store action requires a confirmation object",
      { requiredFields: requiredEntries.map(([field]) => field) }
    );
  }
  const confirmationRecord = confirmation as Record<string, unknown>;
  for (const [field, value] of requiredEntries) {
    if (confirmationRecord[field] !== value) {
      throw new StoreConfirmationError(
        "store_confirmation_mismatch",
        `confirmation.${field} must match ${field}`,
        { field }
      );
    }
  }
}

export function storeConfirmationErrorResponse(error: StoreConfirmationError): ApiResponse {
  return {
    status: 400,
    body: {
      error: error.code,
      message: error.message,
      ...(error.details !== undefined ? { details: error.details } : {})
    }
  };
}
