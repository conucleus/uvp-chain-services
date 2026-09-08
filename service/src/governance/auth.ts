import { createHash, timingSafeEqual } from "node:crypto";
import type { ChainServicesRuntimeEnv } from "../config/index.js";
import type { GovernancePrincipal } from "./types.js";

const ADMIN_ROLES = new Set(["admin", "governance_admin", "governance"]);
/** 管理面口令因子头（明文口令只走请求头，库/日志侧只落哈希）。 */
const ADMIN_TOKEN_HEADER = "x-uvp-admin-token";

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
  /**
   * GOVERNANCE_ADMIN_TOKEN_HASHES（sha256 hex）：非 local 管理面的
   * 口令因子。管理面生产基线（bug_audit #12）：明文白名单自报头仅限
   * local 档，非 local 的自报 admin 头必须叠加口令因子才是完整凭据。
   */
  readonly adminTokenHashes?: readonly string[];
}

// 管理员白名单是身份允许清单——配置非空时，自报 admin id 必须命中
// 白名单才算管理员身份。白名单为空不放行：仅显式 local 允许自报
// admin（本地联调缺省），非 local 一律 fail-closed。env 校验与
// preflight 同时强制非 local 环境必须显式配置白名单，这里的运行时
// 拒绝是纵深防御。注意：白名单只回答"身份是谁"，不构成凭据——
// 非 local 的明文自报头还必须叠加口令因子（见 adminTokenMatches）。
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
  // 管理面生产基线（bug_audit #12）：明文白名单自报头仅限 local 档。
  // 非 local 的自报 admin 头不是完整凭据——必须携带口令因子
  //（x-uvp-admin-token，sha256 哈希 + timingSafeEqual 比对）。未配置
  // 口令哈希的非 local 一律 fail-closed（env 校验/preflight 已拦截
  // 配置缺失，这里是运行时纵深防御）。
  if (policy.runtimeEnvironment !== "local" && !adminTokenMatches(headers, policy)) {
    return undefined;
  }
  return { adminId, role };
}

/**
 * 口令因子校验：x-uvp-admin-token 的 sha256 与配置哈希逐一
 * timingSafeEqual。未配置哈希（非 local）返回 false——缺配置不放行。
 */
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
