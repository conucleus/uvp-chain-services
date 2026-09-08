import type { ChainServicesRuntimeEnv } from "../config/index.js";
import type { GovernancePrincipal } from "./types.js";

const ADMIN_ROLES = new Set(["admin", "governance_admin", "governance"]);

/**
 * 管理员鉴权策略（唯一注入通道）：运行环境与白名单都来自装配层
 * 注入的 config，本模块绝不读 process.env——否则程序化启动（不设
 * env）时注入 config 与环境变量成为双真源，staging 会被按 local
 * 放行。
 */
export interface GovernanceAdminAuthPolicy {
  readonly runtimeEnvironment: ChainServicesRuntimeEnv;
  /** GOVERNANCE_ADMIN_REVIEWER_IDS（env 校验/preflight 在非 local 强制非空）。 */
  readonly allowedAdminIds: readonly string[];
}

// 管理员白名单是鉴权真源——配置非空时，自报 admin id 必须命中白名单
// 才算管理员。白名单为空不放行：仅显式 local 允许自报 admin（本地
// 联调缺省），非 local 一律 fail-closed。env 校验与 preflight 同时
// 强制非 local 环境必须显式配置白名单，这里的运行时拒绝是纵深防御。
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
  return governanceAdminAllowed(adminId, policy)
    ? { adminId, role }
    : undefined;
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
