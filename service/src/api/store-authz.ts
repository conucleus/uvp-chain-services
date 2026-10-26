import type { ApiRequest, ApiResponse, ApiRouteContext } from "./route-context.js";
import {
  isStoreAccessAuthenticated,
  storeAccessIsAdmin,
  storeAccessIsOperator,
  storeAccessIsReader,
  type StoreAccessLevel,
  type StoreAccessState
} from "../store/console/access.js";
import {
  recordStoreAudit,
  type StoreAuditResource
} from "../store/console/audit.js";
import type { AuditOutcome } from "../security/audit.js";
import type { Address } from "../shared/types.js";
import type { GovernancePrincipal } from "../governance/index.js";

export interface StoreAuthorizationResult {
  readonly access: StoreAccessState;
}

export interface GovernanceStoreAuthorizationResult {
  readonly access: StoreAccessState;
  readonly governancePrincipal: GovernancePrincipal;
}

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

export async function authorizeStoreAuthenticated(
  context: ApiRouteContext,
  request: ApiRequest,
  action: string,
  resource: StoreAuditResource
): Promise<StoreAuthorizationResult | ApiResponse> {
  return authorizeStoreGate(context, request, "store_read", isStoreAccessAuthenticated, action, resource);
}

export async function authorizeStoreRead(
  context: ApiRouteContext,
  request: ApiRequest,
  action: string,
  resource: StoreAuditResource
): Promise<StoreAuthorizationResult | ApiResponse> {
  return authorizeStoreGate(context, request, "store_read", storeAccessIsReader, action, resource);
}

export async function authorizeStoreWrite(
  context: ApiRouteContext,
  request: ApiRequest,
  action: string,
  resource: StoreAuditResource
): Promise<StoreAuthorizationResult | ApiResponse> {
  return authorizeStoreGate(context, request, "store_operator", storeAccessIsOperator, action, resource);
}

export async function authorizeStoreAdmin(
  context: ApiRouteContext,
  request: ApiRequest,
  action: string,
  resource: StoreAuditResource
): Promise<StoreAuthorizationResult | ApiResponse> {
  return authorizeStoreGate(context, request, "store_admin", storeAccessIsAdmin, action, resource);
}

export async function authorizeStoreGovernance(
  context: ApiRouteContext,
  request: ApiRequest,
  action: string,
  resource: StoreAuditResource
): Promise<GovernanceStoreAuthorizationResult | ApiResponse> {
  const access = await context.storeIdentityProvider.resolve(request.headers);
  if (access.governancePrincipal) {
    return { access, governancePrincipal: access.governancePrincipal };
  }
  await recordStoreAudit(context.audit, {
    action,
    outcome: "blocked",
    access,
    resource,
    errorCode: isStoreAccessAuthenticated(access) ? "forbidden" : access.authenticationFailure?.code ?? "store_identity_missing",
    ...(request.headers ? { headers: request.headers } : {})
  }, { store: context.storeAuditStore, now: context.now });
  if (!isStoreAccessAuthenticated(access)) {
    return unauthorizedStoreAccessResponse(access, "governance_admin");
  }
  return forbiddenStoreAccessResponse(access, "governance_admin");
}

export async function recordStoreAccessSuccess(
  context: ApiRouteContext,
  request: ApiRequest,
  access: StoreAccessState,
  action: string,
  resource: StoreAuditResource,
  metadata?: Readonly<Record<string, unknown>>
): Promise<void> {
  await recordStoreAudit(context.audit, {
    action,
    outcome: "succeeded",
    access,
    resource,
    ...(request.headers ? { headers: request.headers } : {}),
    ...(metadata ? { metadata } : {})
  }, { store: context.storeAuditStore, now: context.now });
}

export async function recordStoreAccessFailure(
  context: ApiRouteContext,
  request: ApiRequest,
  access: StoreAccessState,
  action: string,
  resource: StoreAuditResource,
  error: unknown
): Promise<void> {
  await recordStoreAudit(context.audit, {
    action,
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

export function forbiddenStoreAccessResponse(
  access: StoreAccessState,
  requiredAccess: StoreAccessLevel | "governance_admin"
): ApiResponse {
  return {
    status: 403,
    body: {
      error: "forbidden",
      requiredAccess,
      accessLevel: access.level,
      authMode: access.authMode
    }
  };
}

export function unauthorizedStoreAccessResponse(
  access: StoreAccessState,
  requiredAccess: StoreAccessLevel | "governance_admin"
): ApiResponse {
  return {
    status: 401,
    body: {
      error: access.authenticationFailure?.code ?? "store_identity_missing",
      message: access.authenticationFailure?.message ?? "Store identity is required",
      requiredAccess,
      accessLevel: access.level,
      authMode: access.authMode
    }
  };
}

async function authorizeStoreGate(
  context: ApiRouteContext,
  request: ApiRequest,
  requiredAccess: StoreAccessLevel,
  allows: (access: StoreAccessState) => boolean,
  action: string,
  resource: StoreAuditResource
): Promise<StoreAuthorizationResult | ApiResponse> {
  const access = await context.storeIdentityProvider.resolve(request.headers);
  if (allows(access)) {
    return { access };
  }
  await recordStoreAudit(context.audit, {
    action,
    outcome: "blocked",
    access,
    resource,
    errorCode: isStoreAccessAuthenticated(access) ? "forbidden" : access.authenticationFailure?.code ?? "store_identity_missing",
    ...(request.headers ? { headers: request.headers } : {})
  }, { store: context.storeAuditStore, now: context.now });
  if (!isStoreAccessAuthenticated(access)) {
    return unauthorizedStoreAccessResponse(access, requiredAccess);
  }
  return forbiddenStoreAccessResponse(access, requiredAccess);
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
