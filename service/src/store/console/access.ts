import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { adminPrincipalFromHeaders, governanceAdminAllowed, type GovernanceAdminAuthPolicy } from "../../governance/index.js";
import type { ChainServicesRuntimeEnv, StoreAuthConfig } from "../../config/index.js";
import { assessStoreAuthEvidence } from "../../config/index.js";
import { storeAuthUrlEvidenceFailure } from "../../config/store-auth-evidence.js";
import type { GovernancePrincipal } from "../../governance/index.js";
import type { Address } from "../../shared/types.js";

export type StoreAccessLevel = "anonymous_read" | "store_read" | "store_operator" | "store_admin";

export type StoreAuthMode =
  | "anonymous"
  | "dev_store_headers"
  | "dev_governance_admin_headers"
  | "dev_headers_disabled"
  | "jwt";

export type StoreRole = StoreAccessLevel | "store_reader" | "governance_admin";

export type StoreAnchorSource = "wallet_session" | "dev_header";

export interface StoreAccessState {
  readonly level: StoreAccessLevel;
  readonly principalId?: string;
  readonly roles: readonly StoreRole[];
  readonly authMode: StoreAuthMode;
  readonly displayName?: string;
  readonly authenticationFailure?: StoreAuthenticationFailure;
  readonly governancePrincipal?: GovernancePrincipal;
  readonly canWrite: boolean;
  readonly canAdmin: boolean;
  readonly anchoredAddress?: Address;
  readonly anchorSource?: StoreAnchorSource;
  readonly walletAccountId?: string;
  readonly walletSessionId?: string;
}

export interface StoreAuthenticationFailure {
  readonly code: "store_identity_missing" | "store_identity_invalid" | "store_identity_unavailable";
  readonly message: string;
}

export interface StoreSessionDTO {
  readonly authenticated: boolean;
  readonly principalId?: string;
  readonly displayName?: string;
  readonly accessLevel: StoreAccessLevel;
  readonly roles: readonly StoreRole[];
  readonly authMode: StoreAuthMode;
  readonly canWrite: boolean;
  readonly canAdmin: boolean;
}

export interface StoreIdentityProvider {
  resolve(headers: Readonly<Record<string, string | undefined>> | undefined): Promise<StoreAccessState>;
}

export interface StoreIdentityProviderOptions {
  readonly runtimeEnvironment: ChainServicesRuntimeEnv;
  readonly authConfig?: StoreAuthConfig;
  readonly governanceAdminIds?: readonly string[];
  readonly governanceAdminTokenHashes?: readonly string[];
}

const STORE_READ_ROLES: readonly StoreRole[] = [
  "store_read",
  "store_reader",
  "store_operator",
  "store_admin",
  "governance_admin"
];
const STORE_OPERATE_ROLES: readonly StoreRole[] = ["store_operator", "store_admin"];

export function createStoreIdentityProvider(options: StoreIdentityProviderOptions): StoreIdentityProvider {
  const runtimeEnvironment = options.runtimeEnvironment;
  const authConfig = options.authConfig ?? defaultStoreAuthConfig();
  const strictRuntime = runtimeEnvironment !== "local";
  const governanceAdminPolicy: GovernanceAdminAuthPolicy = {
    runtimeEnvironment,
    allowedAdminIds: options.governanceAdminIds ?? [],
    ...(options.governanceAdminTokenHashes && options.governanceAdminTokenHashes.length > 0
      ? { adminTokenHashes: options.governanceAdminTokenHashes }
      : {})
  };
  const authEvidence = assessStoreAuthEvidence(authConfig, runtimeEnvironment);
  const jwtConfigBlocked = authConfig.mode === "jwt" && strictRuntime && !authEvidence.externalIdentityEvidence;
  const devHeaderAuthEnabled = authConfig.mode === "dev_headers" &&
    !strictRuntime;
  const jwtVerifier = authConfig.mode === "jwt" && !jwtConfigBlocked ? createJwtVerifier(authConfig, strictRuntime) : undefined;
  return {
    async resolve(headers) {
      if (jwtConfigBlocked) {
        return anonymousAccess("jwt", {
          code: "store_identity_invalid",
          message: "External HTTPS OIDC/JWKS Store identity configuration is required outside local development"
        });
      }
      if (jwtVerifier) {
        return resolveStoreAccessFromJwt(headers, jwtVerifier, governanceAdminPolicy);
      }
      return resolveStoreAccessFromHeaders(headers, devHeaderAuthEnabled, governanceAdminPolicy);
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
    authMode: access.authMode,
    canWrite: access.canWrite,
    canAdmin: access.canAdmin
  };
}

export function isStoreAccessAuthenticated(access: StoreAccessState): boolean {
  return Boolean(access.principalId);
}

export function storeAccessIsReader(access: StoreAccessState): boolean {
  return access.roles.some((role) => STORE_READ_ROLES.includes(role));
}

export function storeAccessIsOperator(access: StoreAccessState): boolean {
  return access.roles.some((role) => STORE_OPERATE_ROLES.includes(role));
}

export function storeAccessIsAdmin(access: StoreAccessState): boolean {
  return access.roles.includes("store_admin");
}

export function storeAccessIsGovernanceAdmin(access: StoreAccessState): boolean {
  return Boolean(access.governancePrincipal);
}

function resolveStoreAccessFromHeaders(
  headers: Readonly<Record<string, string | undefined>> | undefined,
  devHeaderAuthEnabled: boolean,
  governanceAdminPolicy: GovernanceAdminAuthPolicy
): StoreAccessState {
  if (!devHeaderAuthEnabled) {
    const headerPresent = Boolean(
      readHeader(headers, "x-uvp-store-role") ??
      readHeader(headers, "x-uvp-store-operator-role") ??
      readHeader(headers, "x-uvp-admin-role")
    );
    return anonymousAccess(headerPresent ? "dev_headers_disabled" : "anonymous");
  }

  const admin = adminPrincipalFromHeaders(headers, governanceAdminPolicy);
  if (admin) {
    return {
      level: "store_admin",
      principalId: admin.adminId,
      roles: ["store_admin", "governance_admin"],
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
      authMode: "dev_store_headers",
      canWrite: true,
      canAdmin: false
    };
  }

  return {
    level: "store_read",
    principalId,
    roles: ["store_read"],
    authMode: "dev_store_headers",
    canWrite: false,
    canAdmin: false
  };
}

interface JwtVerifier {
  readonly config: RequiredJwtStoreAuthConfig;
  readonly strictRuntime: boolean;
  jwks?: ReturnType<typeof createRemoteJWKSet>;
  jwksPromise?: Promise<ReturnType<typeof createRemoteJWKSet>> | undefined;
}

interface RequiredJwtStoreAuthConfig extends StoreAuthConfig {
  readonly issuer: string;
  readonly audience: string;
}

function createJwtVerifier(config: StoreAuthConfig, strictRuntime: boolean): JwtVerifier {
  const jwtConfig = requireJwtStoreAuthConfig(config);
  return {
    config: jwtConfig,
    strictRuntime,
    ...(jwtConfig.jwksUrl ? { jwks: createRemoteJWKSet(new URL(jwtConfig.jwksUrl)) } : {})
  };
}

function requireJwtStoreAuthConfig(config: StoreAuthConfig): RequiredJwtStoreAuthConfig {
  if (!config.issuer || !config.audience) {
    throw new Error("STORE_AUTH_ISSUER and STORE_AUTH_AUDIENCE are required when STORE_AUTH_MODE=jwt");
  }
  return config as RequiredJwtStoreAuthConfig;
}

async function resolveStoreAccessFromJwt(
  headers: Readonly<Record<string, string | undefined>> | undefined,
  verifier: JwtVerifier,
  governanceAdminPolicy: GovernanceAdminAuthPolicy
): Promise<StoreAccessState> {
  const token = bearerTokenFromHeaders(headers);
  if (!token) {
    return anonymousAccess("jwt", {
      code: "store_identity_missing",
      message: "Authorization Bearer token is required"
    });
  }

  try {
    const result = await jwtVerify(token, await jwksForVerifier(verifier), {
      issuer: verifier.config.issuer,
      audience: verifier.config.audience,
      clockTolerance: verifier.config.clockToleranceSeconds
    });
    return storeAccessFromJwtPayload(result.payload, verifier.config, governanceAdminPolicy);
  } catch (error) {
    if (isJwksDiscoveryFailure(error)) {
      return anonymousAccess("jwt", {
        code: "store_identity_unavailable",
        message: `Store identity provider discovery failed: ${error instanceof Error ? error.message : String(error)}`
      });
    }
    return anonymousAccess("jwt", {
      code: "store_identity_invalid",
      message: "Authorization Bearer token is invalid"
    });
  }
}

const JWKS_DISCOVERY_FAILURE = "StoreAuthJwksDiscoveryFailure";

async function jwksForVerifier(verifier: JwtVerifier): Promise<ReturnType<typeof createRemoteJWKSet>> {
  if (verifier.jwks) {
    return verifier.jwks;
  }
  if (!verifier.jwksPromise) {
    verifier.jwksPromise = discoverStoreAuthJwks(verifier.config, verifier.strictRuntime);
  }
  try {
    verifier.jwks = await verifier.jwksPromise;
  } catch (error) {
    verifier.jwksPromise = undefined;
    throw error;
  }
  return verifier.jwks;
}

function isJwksDiscoveryFailure(error: unknown): boolean {
  return error instanceof Error && error.name === JWKS_DISCOVERY_FAILURE;
}

async function discoverStoreAuthJwks(config: RequiredJwtStoreAuthConfig, strictRuntime: boolean): Promise<ReturnType<typeof createRemoteJWKSet>> {
  const discoveryUrl = config.oidcDiscoveryUrl ?? `${config.issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
  let response: Response;
  try {
    response = await fetch(discoveryUrl, {
      headers: { accept: "application/json" }
    });
  } catch (cause) {
    throw namedDiscoveryError("OIDC discovery request failed", cause);
  }
  if (!response.ok) {
    throw namedDiscoveryError(`OIDC discovery request failed with status ${response.status}`);
  }
  let metadata: unknown;
  try {
    metadata = await response.json();
  } catch (cause) {
    throw namedDiscoveryError("OIDC discovery response is not valid JSON", cause);
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw namedDiscoveryError("OIDC discovery response must be a JSON object");
  }
  const record = metadata as Record<string, unknown>;
  if (typeof record.issuer === "string" && record.issuer !== config.issuer) {
    throw namedDiscoveryError("OIDC discovery issuer does not match STORE_AUTH_ISSUER");
  }
  if (typeof record.jwks_uri !== "string" || record.jwks_uri.trim().length === 0) {
    throw namedDiscoveryError("OIDC discovery response is missing jwks_uri");
  }
  if (strictRuntime && storeAuthUrlEvidenceFailure(record.jwks_uri)) {
    throw namedDiscoveryError("OIDC discovery jwks_uri must be HTTPS on a non-private host outside local development");
  }
  try {
    return createRemoteJWKSet(new URL(record.jwks_uri));
  } catch (cause) {
    throw namedDiscoveryError("OIDC discovery jwks_uri is invalid", cause);
  }
}

function namedDiscoveryError(message: string, cause?: unknown): Error {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.name = JWKS_DISCOVERY_FAILURE;
  return error;
}

function storeAccessFromJwtPayload(
  payload: JWTPayload,
  config: RequiredJwtStoreAuthConfig,
  governanceAdminPolicy: GovernanceAdminAuthPolicy
): StoreAccessState {
  const principalId = stringClaim(payload, config.principalClaim);
  if (!principalId) {
    return anonymousAccess("jwt", {
      code: "store_identity_invalid",
      message: "JWT principal claim is missing"
    });
  }

  const jwtRoles = normalizeJwtRoles(claimValue(payload, config.roleClaim));
  const roles = canonicalStoreRoles(jwtRoles).filter((role) =>
    role !== "governance_admin" || governanceAdminAllowed(principalId, governanceAdminPolicy)
  );
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
    authMode: "jwt",
    ...(governancePrincipal ? { governancePrincipal } : {}),
    canWrite: storeRoleCanWrite(roles),
    canAdmin: storeRoleCanAdmin(roles)
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

function storeRoleCanWrite(roles: readonly StoreRole[]): boolean {
  return roles.includes("store_operator") ||
    roles.includes("store_admin") ||
    roles.includes("governance_admin");
}

function storeRoleCanAdmin(roles: readonly StoreRole[]): boolean {
  return roles.includes("store_admin") || roles.includes("governance_admin");
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
