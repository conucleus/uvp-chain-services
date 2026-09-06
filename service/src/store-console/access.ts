import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { adminPrincipalFromHeaders } from "../governance/index.js";
import type { ChainServicesRuntimeEnv, StoreAuthConfig } from "../config/index.js";
import { assessStoreAuthEvidence } from "../config/index.js";
import type { GovernancePrincipal } from "../governance/index.js";
import type { Address } from "../shared/types.js";

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
  | "store.version.activate"
  | "store.version.deprecate"
  | "store.listing.manage"
  | "store.supplier.create"
  | "store.supplier.review"
  | "store.supplier.tags.update"
  | "store.supplier.identity.register"
  | "store.supplier.identity.revoke"
  | "store.supplier.notification_profile.update"
  | "store.docking.create"
  | "store.docking.validate"
  | "store.docking.save";

/**
 * 会话锚定地址。锚定来源只能是钱包会话（签名证明）或
 * local 开发头（devAnchoredAddressHeaderEnabled，staging/prod 拒绝）。
 */
export type StoreAnchorSource = "wallet_session" | "dev_header";

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
  /** 会话已证明控制的钱包地址（会话配对）。 */
  readonly anchoredAddress?: Address;
  readonly anchorSource?: StoreAnchorSource;
  readonly walletAccountId?: string;
  readonly walletSessionId?: string;
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
  "store.listing.manage",
  "store.supplier.create",
  "store.supplier.review",
  "store.supplier.tags.update",
  "store.supplier.notification_profile.update",
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
  "store.draft.review",
  "store.supplier.identity.register",
  "store.supplier.identity.revoke"
] as const satisfies readonly StoreCapability[];

// JWT governance_admin 不继承 store_admin 全量——治理权威只映射到治理
// 动作（zhixu 草稿审核 + 链上身份登记/撤销）与读；store.draft.review
// 在此补齐，否则 JWT 治理管理员无法执行 submit-review。
const JWT_GOVERNANCE_ADMIN_CAPABILITIES = [
  ...STORE_READ_CAPABILITIES,
  "store.draft.review",
  "store.supplier.identity.register",
  "store.supplier.identity.revoke"
] as const satisfies readonly StoreCapability[];

export async function storeAccessFromHeaders(
  headers: Readonly<Record<string, string | undefined>> | undefined
): Promise<StoreAccessState> {
  return createStoreIdentityProvider().resolve(headers);
}

export function createStoreIdentityProvider(options: StoreIdentityProviderOptions = {}): StoreIdentityProvider {
  const runtimeEnvironment = options.runtimeEnvironment ?? "local";
  const authConfig = options.authConfig ?? defaultStoreAuthConfig();
  const strictRuntime = runtimeEnvironment === "staging" || runtimeEnvironment === "production";
  const authEvidence = assessStoreAuthEvidence(authConfig, runtimeEnvironment);
  const jwtConfigBlocked = authConfig.mode === "jwt" && strictRuntime && !authEvidence.externalIdentityEvidence;
  const devHeaderAuthEnabled = authConfig.mode === "dev_headers" &&
    !strictRuntime;
  const jwtVerifier = authConfig.mode === "jwt" && !jwtConfigBlocked ? createJwtVerifier(authConfig) : undefined;
  return {
    async resolve(headers) {
      if (jwtConfigBlocked) {
        return anonymousAccess("jwt", {
          code: "store_identity_invalid",
          message: "External HTTPS OIDC/JWKS Store identity configuration is required in staging and production"
        });
      }
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
    case "store.supplier.identity.register":
    case "store.supplier.identity.revoke":
    case "store.draft.review":
      // zhixu 草稿审核是治理动作（governance review 落库），
      // 不下放给 operator 级——提交者与审核者职责分离。
      return "governance_admin";
    case "store.version.activate":
    case "store.version.deprecate":
      return "store_admin";
    case "store.listing.manage":
      return "store_operator";
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
  jwks?: ReturnType<typeof createRemoteJWKSet>;
  jwksPromise?: Promise<ReturnType<typeof createRemoteJWKSet>>;
}

interface RequiredJwtStoreAuthConfig extends StoreAuthConfig {
  readonly issuer: string;
  readonly audience: string;
}

function createJwtVerifier(config: StoreAuthConfig): JwtVerifier {
  const jwtConfig = requireJwtStoreAuthConfig(config);
  return {
    config: jwtConfig,
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
    const result = await jwtVerify(token, await jwksForVerifier(verifier), {
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

async function jwksForVerifier(verifier: JwtVerifier): Promise<ReturnType<typeof createRemoteJWKSet>> {
  if (verifier.jwks) {
    return verifier.jwks;
  }
  verifier.jwksPromise ??= discoverStoreAuthJwks(verifier.config);
  verifier.jwks = await verifier.jwksPromise;
  return verifier.jwks;
}

async function discoverStoreAuthJwks(config: RequiredJwtStoreAuthConfig): Promise<ReturnType<typeof createRemoteJWKSet>> {
  const discoveryUrl = config.oidcDiscoveryUrl ?? `${config.issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
  const response = await fetch(discoveryUrl, {
    headers: { accept: "application/json" }
  });
  if (!response.ok) {
    throw new Error("OIDC discovery request failed");
  }
  const metadata = await response.json() as unknown;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("OIDC discovery response must be a JSON object");
  }
  const record = metadata as Record<string, unknown>;
  if (typeof record.issuer === "string" && record.issuer !== config.issuer) {
    throw new Error("OIDC discovery issuer does not match STORE_AUTH_ISSUER");
  }
  if (typeof record.jwks_uri !== "string" || record.jwks_uri.trim().length === 0) {
    throw new Error("OIDC discovery response is missing jwks_uri");
  }
  return createRemoteJWKSet(new URL(record.jwks_uri));
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
  // 零角色 JWT 不并入 store.audit.read——匿名
  // 语义的 token 只拿到公共读（store.read）；audit.read 随 store_reader
  // 及以上角色授予。
  const capabilities = new Set<StoreCapability>(STORE_PUBLIC_READ_CAPABILITIES);
  if (roles.includes("store_reader")) {
    addCapabilities(capabilities, STORE_READ_CAPABILITIES);
  }
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
