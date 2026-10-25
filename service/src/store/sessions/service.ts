import { createHash, randomBytes, randomUUID } from "node:crypto";
import { verifyMessage } from "viem";
import type { ChainServicesRuntimeEnv } from "../../config/index.js";
import type { StoreWalletSessionConfig } from "../../config/index.js";
import { normalizeAddress, type Address, type Hex } from "../../shared/types.js";
import type {
  StoreAccessLevel,
  StoreAccessState,
  StoreCapability,
  StoreIdentityProvider,
  StoreRole,
  StoreSessionDTO
} from "../console/access.js";
import type {
  StoreAccountAddressView,
  StoreAuthChallengeRecord,
  StoreWalletSessionChallengeDTO,
  StoreWalletSessionRecord,
  StoreWalletSessionStore,
  StoreWalletSessionVerifyResult,
  StoreWalletSessionView
} from "./types.js";
import { StoreSessionServiceError } from "./types.js";

export interface StoreSessionServiceOptions {
  readonly store: StoreWalletSessionStore;
  readonly config?: StoreWalletSessionConfig;
  readonly now?: () => Date;
  readonly verifyWalletMessage?: (input: {
    readonly address: Address;
    readonly message: string;
    readonly signature: Hex;
  }) => Promise<boolean>;
}

export interface ResolveWalletSessionResult {
  readonly session: StoreWalletSessionView;
  readonly record: StoreWalletSessionRecord;
}

export interface StoreChallengeRequesterContext {
  readonly clientAddress?: string | undefined;
  readonly domain?: string | undefined;
}

export interface StoreSessionService {
  createChallenge(
    input: unknown,
    requesterSession?: ResolveWalletSessionResult,
    requester?: StoreChallengeRequesterContext
  ): Promise<StoreWalletSessionChallengeDTO>;
  verify(
    input: unknown,
    requesterSession?: ResolveWalletSessionResult,
    requester?: StoreChallengeRequesterContext
  ): Promise<StoreWalletSessionVerifyResult>;
  resolveSessionFromToken(token: string | undefined): Promise<ResolveWalletSessionResult | undefined>;
  logout(token: string | undefined): Promise<boolean>;
  listAccountAddresses(accountId: string): Promise<readonly StoreAccountAddressView[]>;
  revokeAccountAddress(input: unknown, requesterSession: ResolveWalletSessionResult): Promise<readonly StoreAccountAddressView[]>;
  sessionView(record: StoreWalletSessionRecord): Promise<StoreWalletSessionView>;
}

export const STORE_SESSION_TOKEN_PREFIX = "uvs_";
export const STORE_SESSION_HEADER = "x-uvp-store-session";
export const STORE_DEV_ANCHORED_ADDRESS_HEADER = "x-uvp-store-dev-anchored-address";

export function createStoreSessionService(options: StoreSessionServiceOptions): StoreSessionService {
  const store = options.store;
  const config = options.config ?? defaultWalletSessionConfig();
  const now = options.now ?? (() => new Date());
  const verifyWalletMessage = options.verifyWalletMessage ?? defaultVerifyWalletMessage;

  return {
    async createChallenge(input, requesterSession, requester) {
      if (!config.enabled) {
        throw new StoreSessionServiceError(403, "store_wallet_session_disabled", "wallet sessions are not enabled for this deployment");
      }
      const record = requireBodyRecord(input);
      const address = normalizeAddress(requiredString(record, "address"), "address");
      const requesterKey = requester?.clientAddress?.trim() || FALLBACK_CHALLENGE_REQUESTER_KEY;
      const intentValue = optionalString(record, "intent") ?? "login";
      if (intentValue !== "login" && intentValue !== "anchor_address") {
        throw new StoreSessionServiceError(400, "invalid_body", "intent must be login or anchor_address");
      }
      const intent = intentValue;
      if (intent === "anchor_address" && !requesterSession) {
        throw new StoreSessionServiceError(401, "store_session_required", "anchoring an additional address requires an existing session");
      }
      const accountId = requesterSession?.session.accountId;
      const timestamp = now();
      await store.deleteExpiredChallenges(timestamp.toISOString());
      await store.deleteExpiredSessions(timestamp.toISOString());
      const nonce = randomBytes(16).toString("hex");
      const issuedAt = timestamp.toISOString();
      const expiresAt = new Date(timestamp.getTime() + config.challengeTtlSeconds * 1000).toISOString();
      const chainId = boundedOptionalString(record, "chainId", CHALLENGE_CHAIN_ID_PATTERN, CHALLENGE_INPUT_MAX_LENGTH);
      const domain = challengeDomainFromRequester(requester);
      const message = buildStoreLoginMessage({
        address,
        intent,
        ...(accountId ? { accountId } : {}),
        ...(chainId ? { chainId } : {}),
        ...(domain ? { domain } : {}),
        nonce,
        issuedAt,
        expirationTime: expiresAt
      });
      const challenge: StoreAuthChallengeRecord = {
        nonce,
        address,
        requesterKey,
        intent,
        ...(accountId ? { accountId } : {}),
        message,
        issuedAt,
        expiresAt
      };
      const accepted = await store.putChallengeWithinAddressQuota(challenge, {
        maxLivePerAddress: MAX_LIVE_CHALLENGES_PER_ADDRESS,
        maxLivePerRequester: MAX_LIVE_CHALLENGES_PER_REQUESTER,
        now: timestamp.toISOString()
      });
      if (!accepted) {
        throw new StoreSessionServiceError(
          429,
          "store_challenge_rate_limited",
          "too many live challenges for this address or from this requester; wait for them to expire or consume one",
          {
            address,
            limit: MAX_LIVE_CHALLENGES_PER_ADDRESS,
            requesterLimit: MAX_LIVE_CHALLENGES_PER_REQUESTER
          }
        );
      }
      return {
        nonce,
        address,
        message,
        issuedAt,
        expiresAt
      };
    },

    async verify(input, requesterSession, requester) {
      if (!config.enabled) {
        throw new StoreSessionServiceError(403, "store_wallet_session_disabled", "wallet sessions are not enabled for this deployment");
      }
      const record = requireBodyRecord(input);
      const nonce = boundedRequiredString(record, "nonce", /^[0-9a-f]+$/, CHALLENGE_INPUT_MAX_LENGTH);
      const signature = boundedRequiredString(record, "signature", /^0x[0-9a-fA-F]+$/, 132) as Hex;
      const challenge = await store.getChallenge(nonce);
      if (!challenge || challenge.consumedAt) {
        throw new StoreSessionServiceError(401, "store_challenge_invalid", "challenge is unknown or already used");
      }
      if (challenge.expiresAt < now().toISOString()) {
        throw new StoreSessionServiceError(401, "store_challenge_expired", "challenge has expired");
      }
      const verifyDomain = challengeDomainFromRequester(requester);
      const challengeDomain = challengeDomainFromMessage(challenge.message);
      if (challengeDomain !== verifyDomain) {
        throw new StoreSessionServiceError(
          401,
          "store_challenge_domain_mismatch",
          "challenge was issued for a different domain",
          { challengeDomain: challengeDomain || undefined, verifyDomain: verifyDomain || undefined }
        );
      }
      const address = challenge.address;
      const consumed = await store.consumeChallenge(nonce, now().toISOString());
      if (!consumed) {
        throw new StoreSessionServiceError(401, "store_challenge_invalid", "challenge is unknown or already used");
      }
      const valid = await verifyWalletMessage({ address, message: challenge.message, signature });
      if (!valid) {
        throw new StoreSessionServiceError(401, "store_challenge_signature_invalid", "signature does not prove control of the address");
      }

      const anchorToAccountId = challenge.intent === "anchor_address" && challenge.accountId
        ? challenge.accountId
        : undefined;
      if (anchorToAccountId && requesterSession?.session.accountId !== anchorToAccountId) {
        throw new StoreSessionServiceError(403, "store_account_mismatch", "challenge was issued for a different account");
      }

      const existing = await store.findActiveAccountAddress(address);
      const accountId = anchorToAccountId ?? existing?.accountId ?? `acct_${randomUUID()}`;
      if (anchorToAccountId && existing && existing.accountId !== anchorToAccountId) {
        throw new StoreSessionServiceError(
          409,
          "store_address_already_anchored",
          "address is already anchored to another account",
          { accountId: existing.accountId }
        );
      }
      const timestamp = now().toISOString();
      const token = `${STORE_SESSION_TOKEN_PREFIX}${randomBytes(32).toString("hex")}`;
      const sessionId = `sess_${randomUUID()}`;
      const claimed = existing
        ? undefined
        : await store.claimActiveAccountAddress({
          accountId,
          address,
          status: "active",
          anchoredAt: timestamp,
          anchorSessionId: sessionId
        });
      if (claimed && claimed.accountId !== accountId) {
        throw new StoreSessionServiceError(
          409,
          "store_address_already_anchored",
          "address is already anchored to another account",
          { accountId: claimed.accountId }
        );
      }
      const session: StoreWalletSessionRecord = {
        sessionId,
        tokenHash: sha256Hex(token),
        accountId: claimed?.accountId ?? accountId,
        anchoredAddress: address,
        createdAt: timestamp,
        expiresAt: new Date(new Date(timestamp).getTime() + config.sessionTtlSeconds * 1000).toISOString(),
        lastSeenAt: timestamp
      };
      await store.putSession(session);
      return {
        token,
        session: await this.sessionView(session),
        linkedToExistingAccount: Boolean(anchorToAccountId) || Boolean(claimed)
      };
    },

    async resolveSessionFromToken(token) {
      if (!config.enabled) {
        return undefined;
      }
      if (!token || !token.startsWith(STORE_SESSION_TOKEN_PREFIX)) {
        return undefined;
      }
      const record = await store.findSessionByTokenHash(sha256Hex(token));
      if (!record || record.revokedAt) {
        return undefined;
      }
      if (record.expiresAt < now().toISOString()) {
        return undefined;
      }
      const activeAnchor = await store.findActiveAccountAddress(record.anchoredAddress);
      if (!activeAnchor || activeAnchor.accountId !== record.accountId) {
        await store.revokeSession(record.sessionId, now().toISOString(), "anchor_address_revoked");
        return undefined;
      }
      const lastSeenAt = now().toISOString();
      if (!(await store.touchSession(record.sessionId, lastSeenAt))) {
        return undefined;
      }
      const refreshed = { ...record, lastSeenAt };
      return { session: await this.sessionView(refreshed), record: refreshed };
    },

    async logout(token) {
      if (!token) {
        return false;
      }
      const record = await store.findSessionByTokenHash(sha256Hex(token));
      if (!record || record.revokedAt) {
        return false;
      }
      return store.revokeSession(record.sessionId, now().toISOString(), "logout");
    },

    async listAccountAddresses(accountId) {
      const records = await store.listAccountAddresses(accountId);
      return records.map(accountAddressView);
    },

    async revokeAccountAddress(input, requesterSession) {
      const record = requireBodyRecord(input);
      const address = normalizeAddress(requiredString(record, "address"), "address");
      const active = await store.findActiveAccountAddress(address);
      if (!active || active.accountId !== requesterSession.session.accountId) {
        throw new StoreSessionServiceError(404, "store_account_address_not_found", "address is not anchored to this account");
      }
      if (requesterSession.record.anchoredAddress.toLowerCase() === address.toLowerCase()) {
        throw new StoreSessionServiceError(
          409,
          "store_address_in_use",
          "the current session's anchored address cannot be revoked; log in with another address first"
        );
      }
      const timestamp = now().toISOString();
      const revoked = await store.revokeActiveAccountAddress({
        address,
        accountId: requesterSession.session.accountId,
        revokedAt: timestamp,
        revokedBySessionId: requesterSession.record.sessionId
      });
      if (!revoked) {
        const latest = await store.findActiveAccountAddress(address);
        if (latest && latest.accountId === requesterSession.session.accountId) {
          throw new StoreSessionServiceError(
            409,
            "store_address_anchor_conflict",
            "address anchor changed concurrently; retry the revocation",
            { address }
          );
        }
      }
      return this.listAccountAddresses(requesterSession.session.accountId);
    },

    async sessionView(record) {
      const addresses = await store.listAccountAddresses(record.accountId);
      return {
        sessionId: record.sessionId,
        accountId: record.accountId,
        anchoredAddress: record.anchoredAddress,
        createdAt: record.createdAt,
        expiresAt: record.expiresAt,
        addresses: addresses.map(accountAddressView)
      };
    }
  };
}

export function createWalletSessionStoreIdentityProvider(options: {
  readonly base: StoreIdentityProvider;
  readonly sessionService: StoreSessionService;
  readonly config?: StoreWalletSessionConfig;
  readonly runtimeEnvironment: ChainServicesRuntimeEnv;
}): StoreIdentityProvider {
  const config = options.config ?? defaultWalletSessionConfig();
  const runtimeEnvironment = options.runtimeEnvironment;
  const strictRuntime = runtimeEnvironment !== "local";
  return {
    async resolve(headers) {
      const base = await options.base.resolve(headers);
      const token = readHeader(headers, STORE_SESSION_HEADER)?.trim();
      const resolved = await options.sessionService.resolveSessionFromToken(token);
      if (resolved) {
        return mergeWalletSessionIntoAccess(base, resolved.session, "wallet_session", config);
      }
      const devAnchored = strictRuntime
        ? undefined
        : parseOptionalAddress(readHeader(headers, STORE_DEV_ANCHORED_ADDRESS_HEADER));
      if (devAnchored && config.devAnchoredAddressHeaderEnabled) {
        return {
          ...base,
          anchoredAddress: devAnchored,
          anchorSource: "dev_header"
        };
      }
      return base;
    }
  };
}

export function mergeWalletSessionIntoAccess(
  base: StoreAccessState,
  session: StoreWalletSessionView,
  anchorSource: "wallet_session",
  config: StoreWalletSessionConfig
): StoreAccessState {
  const walletLevel = walletSessionAccessLevel(session.anchoredAddress, config);
  const level = maxAccessLevel(base.level, walletLevel);
  const capabilities = unionCapabilities(base.capabilities, capabilitiesForAccessLevel(walletLevel));
  return {
    ...base,
    level,
    principalId: base.principalId ?? `wallet:${session.accountId}`,
    roles: unionRoles(base.roles, walletLevel),
    capabilities,
    canWrite: base.canWrite || walletLevel === "store_operator" || walletLevel === "store_admin",
    canAdmin: base.canAdmin || walletLevel === "store_admin",
    anchoredAddress: session.anchoredAddress,
    anchorSource,
    walletAccountId: session.accountId,
    walletSessionId: session.sessionId
  };
}

export function storeSessionDtoWithWalletOverlay(
  session: StoreSessionDTO,
  view: StoreWalletSessionView
): StoreSessionDTO & {
  readonly anchoredAddress?: Address;
  readonly anchorSource?: string;
  readonly accountId?: string;
  readonly accountAddresses?: readonly StoreAccountAddressView[];
} {
  return {
    ...session,
    anchoredAddress: view.anchoredAddress,
    anchorSource: "wallet_session",
    accountId: view.accountId,
    accountAddresses: view.addresses
  };
}

export function walletSessionAccessLevel(address: Address, config: StoreWalletSessionConfig): StoreAccessLevel {
  if (config.adminWallets.some((wallet) => wallet.toLowerCase() === address.toLowerCase())) {
    return "store_admin";
  }
  if (config.operatorWallets.some((wallet) => wallet.toLowerCase() === address.toLowerCase())) {
    return "store_operator";
  }
  return "store_read";
}

function capabilitiesForAccessLevel(level: StoreAccessLevel): readonly StoreCapability[] {
  switch (level) {
    case "store_admin":
      return [
        ...storeReadCapabilities(),
        "store.draft.import",
        "store.draft.compile",
        "store.draft.schema.save",
        "store.supplier.create",
        "store.supplier.review",
        "store.supplier.tags.update",
        "store.supplier.notification_profile.update",
        "store.docking.create",
        "store.docking.validate",
        "store.docking.save",
        "store.version.activate",
        "store.version.deprecate",
        "store.listing.manage"
      ];
    case "store_operator":
      return [
        ...storeReadCapabilities(),
        "store.draft.import",
        "store.draft.compile",
        "store.draft.schema.save",
        "store.supplier.create",
        "store.supplier.review",
        "store.supplier.tags.update",
        "store.supplier.notification_profile.update",
        "store.docking.create",
        "store.docking.validate",
        "store.docking.save",
        "store.listing.manage"
      ];
    case "store_read":
      return ["store.read"];
    case "anonymous_read":
      return ["store.read"];
  }
}

function storeReadCapabilities(): readonly StoreCapability[] {
  return ["store.read", "store.audit.read"];
}

function maxAccessLevel(left: StoreAccessLevel, right: StoreAccessLevel): StoreAccessLevel {
  const rank: Record<StoreAccessLevel, number> = {
    anonymous_read: 0,
    store_read: 1,
    store_operator: 2,
    store_admin: 3
  };
  return rank[left] >= rank[right] ? left : right;
}

function unionCapabilities(left: readonly StoreCapability[], right: readonly StoreCapability[]): readonly StoreCapability[] {
  return [...new Set([...left, ...right])];
}

function unionRoles(left: readonly string[], level: StoreAccessLevel): readonly StoreRole[] {
  const merged = new Set<string>(left);
  if (level === "store_operator") {
    merged.add("store_operator");
  }
  if (level === "store_admin") {
    merged.add("store_admin");
  }
  return [...merged] as readonly StoreRole[];
}

export function buildStoreLoginMessage(input: {
  readonly address: Address;
  readonly intent: "login" | "anchor_address";
  readonly accountId?: string;
  readonly chainId?: string;
  readonly domain?: string;
  readonly nonce?: string;
  readonly issuedAt: string;
  readonly expirationTime: string;
}): string {
  const lines = [
    "uvp-store wants you to sign in with your EVM account:",
    input.address,
    "",
    "By signing you prove control of this address and accept the store session terms.",
    "This signature establishes a store session only; it never authorizes chain actions.",
    "",
    input.intent === "anchor_address"
      ? `Session intent: anchor this address to store account ${input.accountId}`
      : "Session intent: store login",
    ...(input.domain ? [`Domain: ${input.domain}`] : []),
    "Version: 1",
    ...(input.chainId ? [`Chain ID: ${input.chainId}`] : []),
    `Nonce: ${input.nonce ?? ""}`,
    `Issued At: ${input.issuedAt}`,
    `Expiration Time: ${input.expirationTime}`
  ];
  return lines.join("\n");
}

export function defaultWalletSessionConfig(): StoreWalletSessionConfig {
  return {
    enabled: true,
    operatorWallets: [],
    adminWallets: [],
    sessionTtlSeconds: 43200,
    challengeTtlSeconds: 300,
    devAnchoredAddressHeaderEnabled: false
  };
}

async function defaultVerifyWalletMessage(input: {
  readonly address: Address;
  readonly message: string;
  readonly signature: Hex;
}): Promise<boolean> {
  try {
    return await verifyMessage({
      address: input.address,
      message: input.message,
      signature: input.signature
    });
  } catch {
    return false;
  }
}

function accountAddressView(record: { readonly address: Address; readonly status: "active" | "revoked"; readonly anchoredAt: string }): StoreAccountAddressView {
  return {
    address: record.address,
    status: record.status,
    anchoredAt: record.anchoredAt
  };
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function requireBodyRecord(body: unknown): Record<string, unknown> {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  throw new StoreSessionServiceError(400, "invalid_body", "request body must be a JSON object");
}

function requiredString(record: Record<string, unknown>, field: string): string {
  const value = optionalString(record, field);
  if (!value) {
    throw new StoreSessionServiceError(400, "invalid_body", `${field} must be a non-empty string`);
  }
  return value;
}

function optionalString(record: Record<string, unknown>, field: string): string | undefined {
  if (!Object.hasOwn(record, field)) {
    return undefined;
  }
  const value = record[field];
  if (value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new StoreSessionServiceError(400, "invalid_body", `${field} must be a string`);
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

const CHALLENGE_INPUT_MAX_LENGTH = 128;
const CHALLENGE_CHAIN_ID_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._:-]*$/;
const MAX_LIVE_CHALLENGES_PER_ADDRESS = 10;
const MAX_LIVE_CHALLENGES_PER_REQUESTER = 30;
const FALLBACK_CHALLENGE_REQUESTER_KEY = "";
const CHALLENGE_MESSAGE_DOMAIN_PREFIX = "Domain: ";
const CHALLENGE_DOMAIN_PATTERN = /^[a-z0-9.\-:\[\]]+$/;
const CHALLENGE_DOMAIN_MAX_LENGTH = 255;

function challengeDomainFromRequester(requester: StoreChallengeRequesterContext | undefined): string {
  const domain = requester?.domain?.trim().toLowerCase() ?? "";
  if (domain.length > CHALLENGE_DOMAIN_MAX_LENGTH) {
    throw new StoreSessionServiceError(400, "store_challenge_domain_invalid", "requester domain is too long");
  }
  if (domain && !CHALLENGE_DOMAIN_PATTERN.test(domain)) {
    throw new StoreSessionServiceError(400, "store_challenge_domain_invalid", "requester domain contains unsupported characters");
  }
  return domain;
}

function challengeDomainFromMessage(message: string): string {
  const line = message
    .split("\n")
    .find((candidate) => candidate.startsWith(CHALLENGE_MESSAGE_DOMAIN_PREFIX));
  return line ? line.slice(CHALLENGE_MESSAGE_DOMAIN_PREFIX.length).trim() : "";
}

function boundedOptionalString(
  record: Record<string, unknown>,
  field: string,
  pattern: RegExp,
  maxLength: number
): string | undefined {
  const value = optionalString(record, field);
  if (value === undefined) {
    return undefined;
  }
  if (value.length > maxLength || !pattern.test(value)) {
    throw new StoreSessionServiceError(
      400,
      "invalid_body",
      `${field} must match ${String(pattern)} and be at most ${maxLength} characters`
    );
  }
  return value;
}

function boundedRequiredString(
  record: Record<string, unknown>,
  field: string,
  pattern: RegExp,
  maxLength: number
): string {
  const value = boundedOptionalString(record, field, pattern, maxLength);
  if (!value) {
    throw new StoreSessionServiceError(400, "invalid_body", `${field} must be a non-empty string`);
  }
  return value;
}

function parseOptionalAddress(value: string | undefined): Address | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return normalizeAddress(value.trim(), "devAnchoredAddress");
  } catch {
    return undefined;
  }
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
