// Legacy prepare routes anchor a wallet claim without the app-side session
// store. Outside local development they fail closed until client-signed
// operations replace the prepare surface.
import type { ChainServicesRuntimeEnv } from "../config/index.js";
import { normalizeAddress, type Address } from "../shared/types.js";
import type { ApiRequest, ApiResponse } from "./route-context.js";

export interface WalletClaim {
  readonly walletAddress: Address;
  readonly source: "local_self_reported";
}

export type WalletClaimResult =
  | { readonly ok: true; readonly identity: WalletClaim }
  | { readonly ok: false; readonly response: ApiResponse };

export function resolveChainWalletClaim(
  request: ApiRequest,
  runtimeEnvironment: ChainServicesRuntimeEnv | undefined,
  options: { readonly includeBodyWallet?: boolean } = {}
): WalletClaimResult {
  if (runtimeEnvironment !== "local") {
    return {
      ok: false,
      response: {
        status: 401,
        body: {
          error: "wallet_identity_required",
          message: "wallet sessions are served by uvp-app-backend; chain-services prepare only accepts a locally anchored wallet"
        }
      }
    };
  }
  const claimed = selfReportedWalletFromRequest(request, options);
  if (!claimed) {
    return {
      ok: false,
      response: {
        status: 401,
        body: {
          error: "wallet_identity_required",
          message: "a locally anchored wallet is required to prepare on chain-services"
        }
      }
    };
  }
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

function selfReportedWalletFromRequest(
  request: ApiRequest,
  options: { readonly includeBodyWallet?: boolean }
): string | undefined {
  return request.query?.wallet ??
    request.query?.walletAddress ??
    (options.includeBodyWallet === false ? undefined : readBodyWallet(request.body)) ??
    readHeader(request, "x-uvp-wallet-address") ??
    readHeader(request, "x-uvp-session-wallet-address") ??
    readHeader(request, "x-wallet-address");
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
