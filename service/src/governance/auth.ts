import type { GovernancePrincipal } from "./types.js";

const ADMIN_ROLES = new Set(["admin", "governance_admin", "governance"]);

// 管理员白名单（GOVERNANCE_ADMIN_REVIEWER_IDS，preflight 在
// staging 强制非空）是鉴权真源——配置非空时，自报
// admin id 必须命中白名单才算管理员。
//
// 白名单为空不放行。local 之外的运行环境
// （staging/testnet/production）白名单为空时 fail-closed——自报 admin
// 头一律拒绝。env 校验与 preflight 同时强制这些环境必须显式配置白名单，
// 这里的运行时拒绝是纵深防御（配置在进程启动后被卸载也一样安全）。
// 环境变量在每次解析时读取（而非模块加载时快照），保证与进程内配置
// 变更和测试注入一致。
function allowedAdminIds(): Set<string> {
  return new Set(
    (process.env.GOVERNANCE_ADMIN_REVIEWER_IDS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean)
  );
}

function runtimeEnvironment(): "local" | "non-local" {
  const value = process.env.CHAIN_SERVICES_RUNTIME_ENV;
  return value === "local" || value === undefined ? "local" : "non-local";
}

export function adminPrincipalFromHeaders(
  headers: Readonly<Record<string, string | undefined>> | undefined
): GovernancePrincipal | undefined {
  const adminId = readHeader(headers, "x-uvp-admin-id")?.trim();
  const role = readHeader(headers, "x-uvp-admin-role")?.trim().toLowerCase();
  if (!adminId || !role || !ADMIN_ROLES.has(role)) {
    return undefined;
  }
  const allowed = allowedAdminIds();
  if (allowed.size > 0) {
    return allowed.has(adminId)
      ? { adminId, role }
      : undefined;
  }
  // 白名单未配置：仅 local（或未声明环境，视为本地开发）允许自报 admin；
  // 其余环境 fail-closed。
  return runtimeEnvironment() === "local" ? { adminId, role } : undefined;
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
