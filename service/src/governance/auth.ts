import type { GovernancePrincipal } from "./types.js";

const ADMIN_ROLES = new Set(["admin", "governance_admin", "governance"]);

// 模-5 裁决：管理员白名单（GOVERNANCE_ADMIN_REVIEWER_IDS，preflight 在
// staging 强制非空）从"只解析不消费"改为鉴权真源——配置非空时，自报
// admin id 必须命中白名单才算管理员；未配置（本地开发）保持放行。
const ALLOWED_ADMIN_IDS = new Set(
  (process.env.GOVERNANCE_ADMIN_REVIEWER_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
);

export function adminPrincipalFromHeaders(
  headers: Readonly<Record<string, string | undefined>> | undefined
): GovernancePrincipal | undefined {
  const adminId = readHeader(headers, "x-uvp-admin-id")?.trim();
  const role = readHeader(headers, "x-uvp-admin-role")?.trim().toLowerCase();
  if (!adminId || !role || !ADMIN_ROLES.has(role)) {
    return undefined;
  }
  if (ALLOWED_ADMIN_IDS.size > 0 && !ALLOWED_ADMIN_IDS.has(adminId)) {
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
