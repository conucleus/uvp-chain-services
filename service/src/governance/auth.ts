import { createHash, timingSafeEqual } from "node:crypto";
import type { ChainServicesRuntimeEnv } from "../config/index.js";
import type { GovernancePrincipal } from "./types.js";

const ADMIN_ROLES = new Set(["admin", "governance_admin", "governance"]);
const ADMIN_TOKEN_HEADER = "x-uvp-admin-token";

export interface GovernanceAdminAuthPolicy {
  readonly runtimeEnvironment: ChainServicesRuntimeEnv;
  readonly allowedAdminIds: readonly string[];
  readonly adminTokenHashes?: readonly string[];
}

export function governanceAdminAllowed(
  adminId: string,
  policy: GovernanceAdminAuthPolicy
): boolean {
  if (policy.allowedAdminIds.length > 0) {
    return policy.allowedAdminIds.some((allowed) => allowed === adminId);
  }
  return policy.runtimeEnvironment === "local";
}

export function adminPrincipalFromHeaders(
  headers: Readonly<Record<string, string | undefined>> | undefined,
  policy: GovernanceAdminAuthPolicy
): GovernancePrincipal | undefined {
  const adminId = readHeader(headers, "x-uvp-admin-id")?.trim();
  const role = readHeader(headers, "x-uvp-admin-role")?.trim().toLowerCase();
  if (!adminId || !role || !ADMIN_ROLES.has(role)) {
    return undefined;
  }
  if (!governanceAdminAllowed(adminId, policy)) {
    return undefined;
  }
  if (policy.runtimeEnvironment !== "local" && !adminTokenMatches(headers, policy)) {
    return undefined;
  }
  return { adminId, role };
}

function adminTokenMatches(
  headers: Readonly<Record<string, string | undefined>> | undefined,
  policy: GovernanceAdminAuthPolicy
): boolean {
  const token = readHeader(headers, ADMIN_TOKEN_HEADER)?.trim();
  if (!token) {
    return false;
  }
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const actual = Buffer.from(tokenHash, "utf8");
  return (policy.adminTokenHashes ?? []).some((expectedHex) => {
    const expected = Buffer.from(expectedHex.trim().toLowerCase(), "utf8");
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  });
}

function readHeader(
  headers: Readonly<Record<string, string | undefined>> | undefined,
  name: string
): string | undefined {
  if (!headers) {
    return undefined;
  }
  return headers[name] ?? headers[name.toLowerCase()] ?? findCaseInsensitive(headers, name);
}

function findCaseInsensitive(
  headers: Readonly<Record<string, string | undefined>>,
  name: string
): string | undefined {
  const normalized = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === normalized) {
      return value;
    }
  }
  return undefined;
}
