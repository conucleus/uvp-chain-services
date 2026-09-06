import type { ChainServicesRuntimeEnv } from "../config/index.js";
import { adminPrincipalFromHeaders } from "../governance/index.js";
import { principalFromHeaders, type EvidencePrincipal } from "../evidence/index.js";
import { normalizeAddress, type Address } from "../shared/types.js";
import type { ApiRequest, ApiResponse, ApiRouteContext } from "./route-context.js";

/**
 * 参与者面身份收口。
 *
 * - 身份 = 会话锚定地址（钱包会话签名证明，或 local 显式开启的
 *   dev 锚定头）。自报钱包只允许作为"与锚定地址一致性"的校验对象，
 *   不一致即 403；不得把 query/body/header 自报钱包当作唯一身份，
 *   否则可读任意人活动流、代标已读、代任意 owner 上传证据。
 * - local 保留自报回退，且必须显式声明（runtimeEnvironment === "local"）；
 *   缺省环境不再是 local——组装层未传入运行环境时按 fail-closed 拒绝，
 *   否则任何漏传配置的调用点都会静默退化为自报身份可信。
 */
export interface ParticipantWalletIdentity {
  readonly walletAddress: Address;
  readonly accountId?: string;
  readonly source: "wallet_session" | "dev_header" | "local_self_reported";
}

export type ParticipantWalletIdentityResult =
  | { readonly ok: true; readonly identity: ParticipantWalletIdentity }
  | { readonly ok: false; readonly response: ApiResponse };

export function selfReportedWalletFromRequest(
  request: ApiRequest,
  options: { readonly includeBodyWallet?: boolean } = {}
): string | undefined {
  return request.query?.wallet ??
    request.query?.walletAddress ??
    (options.includeBodyWallet === false ? undefined : readBodyWallet(request.body)) ??
    readHeader(request, "x-uvp-wallet-address") ??
    readHeader(request, "x-uvp-session-wallet-address") ??
    readHeader(request, "x-wallet-address");
}

export async function resolveParticipantWalletIdentity(
  request: ApiRequest,
  context: ApiRouteContext,
  runtimeEnvironment?: ChainServicesRuntimeEnv,
  options: { readonly includeBodyWallet?: boolean } = {}
): Promise<ParticipantWalletIdentityResult> {
  const access = await context.storeIdentityProvider.resolve(request.headers);
  if (access.anchoredAddress) {
    const claimed = selfReportedWalletFromRequest(request, options);
    if (claimed) {
      let claimedAddress: Address;
      try {
        claimedAddress = normalizeAddress(claimed, "wallet");
      } catch {
        return {
          ok: false,
          response: {
            status: 400,
            body: { error: "invalid_wallet", message: "claimed wallet must be a valid EVM address" }
          }
        };
      }
      if (claimedAddress.toLowerCase() !== access.anchoredAddress.toLowerCase()) {
        return {
          ok: false,
          response: {
            status: 403,
            body: {
              error: "wrong_wallet",
              message: "claimed wallet does not match the session-anchored address",
              anchoredAddress: access.anchoredAddress,
              walletAddress: claimedAddress
            }
          }
        };
      }
    }
    return {
      ok: true,
      identity: {
        walletAddress: access.anchoredAddress,
        ...(access.walletAccountId ? { accountId: access.walletAccountId } : {}),
        source: access.anchorSource ?? "wallet_session"
      }
    };
  }

  // 仅显式 local 允许自报钱包；环境缺省（组装层漏传）按 fail-closed
  // 拒绝，不给"未配置"留宽松兜底。
  if (runtimeEnvironment === "local") {
    const claimed = selfReportedWalletFromRequest(request, options);
    if (claimed) {
      try {
        return {
          ok: true,
          identity: {
            walletAddress: normalizeAddress(claimed, "wallet"),
            source: "local_self_reported"
          }
        };
      } catch {
        return {
          ok: false,
          response: {
            status: 400,
            body: { error: "invalid_wallet", message: "wallet must be a valid EVM address" }
          }
        };
      }
    }
  }

  return {
    ok: false,
    response: {
      status: 401,
      body: {
        error: "wallet_identity_required",
        message: "a wallet session (or a locally anchored dev address) is required to read participant-scoped resources"
      }
    }
  };
}

/**
 * evidence 身份取值——治理白名单口径的 admin（governance/
 * auth.ts 已收口：非 local 空白名单 fail-closed）或钱包会话锚定地址；
 * 非 local 无会话即拒绝（service 的 requireAuthenticated 抛 401）。
 */
export async function resolveEvidencePrincipal(
  request: ApiRequest,
  context: ApiRouteContext,
  runtimeEnvironment?: ChainServicesRuntimeEnv
): Promise<EvidencePrincipal> {
  const access = await context.storeIdentityProvider.resolve(request.headers);
  const governance = access.governancePrincipal ?? adminPrincipalFromHeaders(request.headers);
  if (governance) {
    return { id: governance.adminId.toLowerCase(), role: "admin" };
  }
  if (access.anchoredAddress) {
    return {
      id: access.anchoredAddress.toLowerCase(),
      role: "participant"
    };
  }
  // 仅显式 local 允许自报 principal 头；环境缺省 fail-closed（同上）。
  if (runtimeEnvironment === "local") {
    return principalFromHeaders(request.headers);
  }
  return { role: "anonymous" };
}

function readBodyWallet(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return undefined;
  }
  const walletAddress = (body as Record<string, unknown>).walletAddress;
  return typeof walletAddress === "string" ? walletAddress : undefined;
}

function readHeader(request: ApiRequest, name: string): string | undefined {
  if (!request.headers) {
    return undefined;
  }
  return request.headers[name] ?? request.headers[name.toLowerCase()] ?? Object.entries(request.headers)
    .find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}
