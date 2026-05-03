import type { GovernancePrincipal } from "./types.js";

const ADMIN_ROLES = new Set(["admin", "governance_admin", "governance"]);

export function adminPrincipalFromHeaders(
  headers: Readonly<Record<string, string | undefined>> | undefined
): GovernancePrincipal | undefined {
  const adminId = readHeader(headers, "x-uvp-admin-id")?.trim();
  const role = readHeader(headers, "x-uvp-admin-role")?.trim().toLowerCase();
  if (!adminId || !role || !ADMIN_ROLES.has(role)) {
    return undefined;
  }
  return { adminId, role };
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
