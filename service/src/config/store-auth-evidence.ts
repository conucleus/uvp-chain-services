import { isIP } from "node:net";
import type { ChainServicesRuntimeEnv, StoreAuthConfig } from "./env.js";

export type StoreAuthEvidenceClassification = "external_oidc" | "prototype" | "not_verified";
export type StoreAuthKeySource = "jwks_url" | "oidc_discovery_url" | "missing";
export type StoreAuthUrlEvidenceFailure = "missing" | "invalid" | "not_https" | "local_or_private";

export interface StoreAuthEvidenceAssessment {
  readonly externalIdentityEvidence: boolean;
  readonly evidenceClassification: StoreAuthEvidenceClassification;
  readonly keySource: StoreAuthKeySource;
  readonly reasons: readonly string[];
}

export function assessStoreAuthEvidence(
  config: StoreAuthConfig | undefined,
  runtimeEnvironment: ChainServicesRuntimeEnv
): StoreAuthEvidenceAssessment {
  const strictRuntime = runtimeEnvironment === "staging" || runtimeEnvironment === "production";
  if (!config) {
    return failedStoreAuthEvidence(strictRuntime, "store_auth_config_missing", "missing");
  }
  if (config.mode !== "jwt") {
    return failedStoreAuthEvidence(strictRuntime, "store_auth_dev_headers", "missing");
  }

  const reasons: string[] = [];
  pushUrlFailureReason(reasons, "store_auth_issuer", storeAuthUrlEvidenceFailure(config.issuer));
  const keySource = storeAuthKeySource(config);
  pushUrlFailureReason(
    reasons,
    "store_auth_key_source",
    storeAuthUrlEvidenceFailure(config.jwksUrl ?? config.oidcDiscoveryUrl)
  );
  if (!config.audience?.trim()) {
    reasons.push("store_auth_audience_missing");
  }
  if (!config.roleClaim?.trim()) {
    reasons.push("store_auth_role_claim_missing");
  }
  if (!config.principalClaim?.trim()) {
    reasons.push("store_auth_principal_claim_missing");
  }

  if (reasons.length === 0) {
    return {
      externalIdentityEvidence: true,
      evidenceClassification: "external_oidc",
      keySource,
      reasons: []
    };
  }
  return {
    externalIdentityEvidence: false,
    evidenceClassification: strictRuntime ? "not_verified" : "prototype",
    keySource,
    reasons
  };
}

export function storeAuthUrlEvidenceFailure(value: string | undefined): StoreAuthUrlEvidenceFailure | undefined {
  if (!value?.trim()) {
    return "missing";
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "invalid";
  }
  if (url.protocol !== "https:") {
    return "not_https";
  }
  if (isLocalOrPrivateStoreAuthHostname(url.hostname)) {
    return "local_or_private";
  }
  return undefined;
}

export function isLocalOrPrivateStoreAuthHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (
    normalized.length === 0 ||
    normalized === "localhost" ||
    normalized === "local" ||
    normalized === "0.0.0.0" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local")
  ) {
    return true;
  }

  const ipVersion = isIP(normalized);
  if (ipVersion === 4) {
    const [first = 0, second = 0] = normalized.split(".").map((part) => Number.parseInt(part, 10));
    return first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168);
  }
  if (ipVersion === 6) {
    const mappedIpv4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized)?.[1];
    return normalized === "::" ||
      normalized === "::1" ||
      (mappedIpv4 ? isLocalOrPrivateStoreAuthHostname(mappedIpv4) : false) ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe80:");
  }
  return false;
}

function failedStoreAuthEvidence(
  strictRuntime: boolean,
  reason: string,
  keySource: StoreAuthKeySource
): StoreAuthEvidenceAssessment {
  return {
    externalIdentityEvidence: false,
    evidenceClassification: strictRuntime ? "not_verified" : "prototype",
    keySource,
    reasons: [reason]
  };
}

function storeAuthKeySource(config: StoreAuthConfig): StoreAuthKeySource {
  if (config.jwksUrl?.trim()) {
    return "jwks_url";
  }
  if (config.oidcDiscoveryUrl?.trim()) {
    return "oidc_discovery_url";
  }
  return "missing";
}

function pushUrlFailureReason(
  reasons: string[],
  prefix: string,
  failure: StoreAuthUrlEvidenceFailure | undefined
): void {
  if (failure) {
    reasons.push(`${prefix}_${failure}`);
  }
}
