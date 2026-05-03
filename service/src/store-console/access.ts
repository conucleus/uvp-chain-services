import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { adminPrincipalFromHeaders } from "../governance/index.js";
import type { ChainServicesRuntimeEnv, StoreAuthConfig } from "../config/index.js";
import type { GovernancePrincipal } from "../governance/index.js";

export type StoreAccessLevel = "anonymous_read" | "store_read" | "store_operator" | "store_admin";

export type StoreAuthMode =
  | "anonymous"
  | "dev_store_headers"
  | "dev_governance_admin_headers"
  | "dev_headers_disabled"
  | "jwt";

export type StoreRole = StoreAccessLevel | "store_reader" | "governance_admin";

export type StoreCapability =
  | "store.read"
  | "store.audit.read"
  | "store.draft.import"
  | "store.draft.compile"
  | "store.draft.schema.save"
  | "store.draft.review"
  | "store.draft.attestation.request"
  | "store.version.activate"
  | "store.version.deprecate"
  | "store.version.revocation.request"
  | "store.supplier.create"
  | "store.supplier.review"
  | "store.supplier.tags.update"
  | "store.supplier.attestation.request"
  | "store.supplier.revocation.request"
  | "store.docking.create"
  | "store.docking.validate"
  | "store.docking.save";

export interface StoreAccessState {
  readonly level: StoreAccessLevel;
  readonly principalId?: string;
  readonly roles: readonly StoreRole[];
  readonly capabilities: readonly StoreCapability[];
  readonly authMode: StoreAuthMode;
  readonly displayName?: string;
  readonly authenticationFailure?: StoreAuthenticationFailure;
  readonly governancePrincipal?: GovernancePrincipal;
  readonly canWrite: boolean;
  readonly canAdmin: boolean;
}

export interface StoreAuthenticationFailure {
  readonly code: "store_identity_missing" | "store_identity_invalid";
  readonly message: string;
}

export interface StoreSessionDTO {
  readonly authenticated: boolean;
  readonly principalId?: string;
  readonly displayName?: string;
  readonly accessLevel: StoreAccessLevel;
  readonly roles: readonly StoreRole[];
  readonly capabilities: readonly StoreCapability[];
  readonly authMode: StoreAuthMode;
}

export interface StoreIdentityProvider {
  resolve(headers: Readonly<Record<string, string | undefined>> | undefined): Promise<StoreAccessState>;
}

export interface StoreIdentityProviderOptions {
  readonly runtimeEnvironment?: ChainServicesRuntimeEnv;
  readonly authConfig?: StoreAuthConfig;
}

const STORE_PUBLIC_READ_CAPABILITIES = ["store.read"] as const satisfies readonly StoreCapability[];
const STORE_READ_CAPABILITIES = [
  ...STORE_PUBLIC_READ_CAPABILITIES,
  "store.audit.read"
] as const satisfies readonly StoreCapability[];

const STORE_OPERATOR_CAPABILITIES = [
  ...STORE_READ_CAPABILITIES,
  "store.draft.import",
  "store.draft.compile",
  "store.draft.schema.save",
  "store.draft.review",
  "store.supplier.create",
  "store.supplier.review",
  "store.supplier.tags.update",
  "store.docking.create",
  "store.docking.validate",
  "store.docking.save"
] as const satisfies readonly StoreCapability[];

const STORE_ADMIN_CAPABILITIES = [
  ...STORE_OPERATOR_CAPABILITIES,
  "store.version.activate",
  "store.version.deprecate"
] as const satisfies readonly StoreCapability[];

const GOVERNANCE_ADMIN_CAPABILITIES = [
  ...STORE_ADMIN_CAPABILITIES,
  "store.draft.attestation.request",
  "store.version.revocation.request",
  "store.supplier.attestation.request",
  "store.supplier.revocation.request"
] as const satisfies readonly StoreCapability[];

const JWT_GOVERNANCE_ADMIN_CAPABILITIES = [
  ...STORE_READ_CAPABILITIES,
  "store.draft.attestation.request",
  "store.version.revocation.request",
  "store.supplier.attestation.request",
  "store.supplier.revocation.request"
] as const satisfies readonly StoreCapability[];

export async function storeAccessFromHeaders(
  headers: Readonly<Record<string, string | undefined>> | undefined
): Promise<StoreAccessState> {
  return createStoreIdentityProvider().resolve(headers);
}

export function createStoreIdentityProvider(options: StoreIdentityProviderOptions = {}): StoreIdentityProvider {
  const runtimeEnvironment = options.runtimeEnvironment ?? "local";
  const authConfig = options.authConfig ?? defaultStoreAuthConfig();
  const devHeaderAuthEnabled = authConfig.mode === "dev_headers" &&
    runtimeEnvironment !== "staging" &&
    runtimeEnvironment !== "production";
  const jwtVerifier = authConfig.mode === "jwt" ? createJwtVerifier(authConfig) : undefined;
  return {
    async resolve(headers) {
      if (jwtVerifier) {
        return resolveStoreAccessFromJwt(headers, jwtVerifier);
      }
      return resolveStoreAccessFromHeaders(headers, devHeaderAuthEnabled);
    }
  };
}

export function storeSessionFromAccess(access: StoreAccessState): StoreSessionDTO {
  return {
    authenticated: Boolean(access.principalId),
    ...(access.principalId ? { principalId: access.principalId } : {}),
    ...(access.displayName ? { displayName: access.displayName } : {}),
    accessLevel: access.level,
    roles: access.roles,
    capabilities: access.capabilities,
    authMode: access.authMode
  };
}

export function isStoreAccessAuthenticated(access: StoreAccessState): boolean {
  return Boolean(access.principalId);
}

export function hasStoreCapability(access: StoreAccessState, capability: StoreCapability): boolean {
  return access.capabilities.includes(capability);
}

export function storeAccessRequiredLevel(capability: StoreCapability): StoreAccessLevel | "governance_admin" {
  switch (capability) {
    case "store.draft.attestation.request":
    case "store.version.revocation.request":
    case "store.supplier.attestation.request":
    case "store.supplier.revocation.request":
      return "governance_admin";
    case "store.version.activate":
    case "store.version.deprecate":
      return "store_admin";
    case "store.read":
    case "store.audit.read":
      return "store_read";
    default:
      return "store_operator";
  }
}

function resolveStoreAccessFromHeaders(
  headers: Readonly<Record<string, string | undefined>> | undefined,
  devHeaderAuthEnabled: boolean
): StoreAccessState {
  if (!devHeaderAuthEnabled) {
    const headerPresent = Boolean(
      readHeader(headers, "x-uvp-store-role") ??
      readHeader(headers, "x-uvp-store-operator-role") ??
      readHeader(headers, "x-uvp-admin-role")
    );
    return anonymousAccess(headerPresent ? "dev_headers_disabled" : "anonymous");
  }

  const admin = adminPrincipalFromHeaders(headers);
  if (admin) {
    return {
      level: "store_admin",
      principalId: admin.adminId,
      roles: ["store_admin", "governance_admin"],
      capabilities: GOVERNANCE_ADMIN_CAPABILITIES,
      authMode: "dev_governance_admin_headers",
      governancePrincipal: admin,
      canWrite: true,
      canAdmin: true
    };
  }

  const role = (
    readHeader(headers, "x-uvp-store-role") ??
    readHeader(headers, "x-uvp-store-operator-role")
  )?.trim().toLowerCase();
  const principalId = (
    readHeader(headers, "x-uvp-store-user-id") ??
    readHeader(headers, "x-uvp-store-operator-id")
  )?.trim();
  if (!role || !principalId) {
    return anonymousAccess("anonymous");
  }

  if (role === "admin" || role === "store_admin") {
    return {
      level: "store_admin",
      principalId,
      roles: ["store_admin"],
      capabilities: STORE_ADMIN_CAPABILITIES,
      authMode: "dev_store_headers",
      canWrite: true,
      canAdmin: true
    };
  }

  if (role === "operator" || role === "store_operator") {
    return {
      level: "store_operator",
      principalId,
      roles: ["store_operator"],
      capabilities: STORE_OPERATOR_CAPABILITIES,
      authMode: "dev_store_headers",
      canWrite: true,
      canAdmin: false
    };
  }

  return {
    level: "store_read",
    principalId,
    roles: ["store_read"],
    capabilities: STORE_READ_CAPABILITIES,
    authMode: "dev_store_headers",
    canWrite: false,
    canAdmin: false
  };
}

interface JwtVerifier {
  readonly config: RequiredJwtStoreAuthConfig;
  readonly jwks: ReturnType<typeof createRemoteJWKSet>;
}

interface RequiredJwtStoreAuthConfig extends StoreAuthConfig {
  readonly jwksUrl: string;
  readonly issuer: string;
  readonly audience: string;
}

function createJwtVerifier(config: StoreAuthConfig): JwtVerifier {
  const jwtConfig = requireJwtStoreAuthConfig(config);
  return {
    config: jwtConfig,
    jwks: createRemoteJWKSet(new URL(jwtConfig.jwksUrl))
  };
}

function requireJwtStoreAuthConfig(config: StoreAuthConfig): RequiredJwtStoreAuthConfig {
  if (!config.jwksUrl || !config.issuer || !config.audience) {
    throw new Error("STORE_AUTH_JWKS_URL, STORE_AUTH_ISSUER, and STORE_AUTH_AUDIENCE are required when STORE_AUTH_MODE=jwt");
  }
  return config as RequiredJwtStoreAuthConfig;
}

async function resolveStoreAccessFromJwt(
  headers: Readonly<Record<string, string | undefined>> | undefined,
  verifier: JwtVerifier
): Promise<StoreAccessState> {
  const token = bearerTokenFromHeaders(headers);
  if (!token) {
    return anonymousAccess("jwt", {
      code: "store_identity_missing",
      message: "Authorization Bearer token is required"
    });
  }

  try {
    const result = await jwtVerify(token, verifier.jwks, {
      issuer: verifier.config.issuer,
      audience: verifier.config.audience,
      clockTolerance: verifier.config.clockToleranceSeconds
    });
    return storeAccessFromJwtPayload(result.payload, verifier.config);
  } catch {
    return anonymousAccess("jwt", {
      code: "store_identity_invalid",
      message: "Authorization Bearer token is invalid"
    });
  }
}

function storeAccessFromJwtPayload(payload: JWTPayload, config: RequiredJwtStoreAuthConfig): StoreAccessState {
  const principalId = stringClaim(payload, config.principalClaim);
  if (!principalId) {
    return anonymousAccess("jwt", {
      code: "store_identity_invalid",
      message: "JWT principal claim is missing"
    });
  }

  const jwtRoles = normalizeJwtRoles(claimValue(payload, config.roleClaim));
  const roles = canonicalStoreRoles(jwtRoles);
  const capabilities = capabilitiesForStoreRoles(roles);
  const level = accessLevelForStoreRoles(roles);
  const displayName = stringClaim(payload, config.displayNameClaim);
  const governancePrincipal = roles.includes("governance_admin")
    ? { adminId: principalId, role: "governance_admin" }
    : undefined;

  return {
    level,
    principalId,
    ...(displayName ? { displayName } : {}),
    roles,
    capabilities,
    authMode: "jwt",
    ...(governancePrincipal ? { governancePrincipal } : {}),
    canWrite: capabilities.some((capability) => capability !== "store.read" && capability !== "store.audit.read"),
    canAdmin: roles.includes("store_admin") || roles.includes("governance_admin")
  };
}

function canonicalStoreRoles(roles: readonly string[]): readonly StoreRole[] {
  const normalized = new Set(roles.map((role) => role.trim().toLowerCase()).filter((role) => role.length > 0));
  const mapped: StoreRole[] = [];
  if (hasAny(normalized, ["store_reader", "store_read", "reader", "read"])) {
    mapped.push("store_reader");
  }
  if (hasAny(normalized, ["store_operator", "operator"])) {
    mapped.push("store_operator");
  }
  if (hasAny(normalized, ["store_admin", "admin"])) {
    mapped.push("store_admin");
  }
  if (hasAny(normalized, ["governance_admin", "governance"])) {
    mapped.push("governance_admin");
  }
  return mapped;
}

function capabilitiesForStoreRoles(roles: readonly StoreRole[]): readonly StoreCapability[] {
  const capabilities = new Set<StoreCapability>(STORE_READ_CAPABILITIES);
  if (roles.includes("store_operator")) {
    addCapabilities(capabilities, STORE_OPERATOR_CAPABILITIES);
  }
  if (roles.includes("store_admin")) {
    addCapabilities(capabilities, STORE_ADMIN_CAPABILITIES);
  }
  if (roles.includes("governance_admin")) {
    addCapabilities(capabilities, JWT_GOVERNANCE_ADMIN_CAPABILITIES);
  }
  return [...capabilities];
}

function accessLevelForStoreRoles(roles: readonly StoreRole[]): StoreAccessLevel {
  if (roles.includes("store_admin")) {
    return "store_admin";
  }
  if (roles.includes("store_operator")) {
    return "store_operator";
  }
  return "store_read";
}

function addCapabilities(capabilities: Set<StoreCapability>, values: readonly StoreCapability[]): void {
  for (const value of values) {
    capabilities.add(value);
  }
}

function hasAny(values: ReadonlySet<string>, candidates: readonly string[]): boolean {
  return candidates.some((candidate) => values.has(candidate));
}

function normalizeJwtRoles(value: unknown): readonly string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => normalizeJwtRoles(item));
  }
  if (typeof value === "string") {
    return value
      .split(/[\s,]+/)
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }
  return [];
}

function stringClaim(payload: JWTPayload, claimName: string | undefined): string | undefined {
  if (!claimName) {
    return undefined;
  }
  const value = claimValue(payload, claimName);
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function claimValue(payload: JWTPayload, claimName: string): unknown {
  const record = payload as Record<string, unknown>;
  if (Object.hasOwn(record, claimName)) {
    return record[claimName];
  }

  let current: unknown = record;
  for (const segment of claimName.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function bearerTokenFromHeaders(headers: Readonly<Record<string, string | undefined>> | undefined): string | undefined {
  const authorization = readHeader(headers, "authorization")?.trim();
  const match = /^Bearer\s+(.+)$/i.exec(authorization ?? "");
  return match?.[1]?.trim();
}

function defaultStoreAuthConfig(): StoreAuthConfig {
  return {
    mode: "dev_headers",
    roleClaim: "roles",
    principalClaim: "sub",
    displayNameClaim: "name",
    clockToleranceSeconds: 60
  };
}

function anonymousAccess(authMode: StoreAuthMode, authenticationFailure?: StoreAuthenticationFailure): StoreAccessState {
  return {
    level: "anonymous_read",
    roles: ["anonymous_read"],
    capabilities: STORE_PUBLIC_READ_CAPABILITIES,
    authMode,
    ...(authenticationFailure ? { authenticationFailure } : {}),
    canWrite: false,
    canAdmin: false
  };
}

function readHeader(
  headers: Readonly<Record<string, string | undefined>> | undefined,
  name: string
): string | undefined {
  if (!headers) {
    return undefined;
  }
  return headers[name] ?? headers[name.toLowerCase()] ?? Object.entries(headers)
    .find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}
