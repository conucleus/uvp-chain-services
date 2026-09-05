import { createHash, randomBytes, randomUUID } from "node:crypto";
import { verifyMessage } from "viem";
import type { ChainServicesRuntimeEnv } from "../config/index.js";
import type { StoreWalletSessionConfig } from "../config/index.js";
import { normalizeAddress, type Address, type Hex } from "../shared/types.js";
import type {
  StoreAccessLevel,
  StoreAccessState,
  StoreCapability,
  StoreIdentityProvider,
  StoreRole,
  StoreSessionDTO
} from "../store-console/access.js";
import {
  InMemoryStoreWalletSessionStore
} from "./memory-store.js";
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

/**
 * 会话配对：登录会话 ↔ 钱包地址（SIWE 式 personal_sign 证明）。
 *
 * - 挑战一次性、带 TTL；签名用 viem verifyMessage 校验（服务端不接触私钥）。
 * - 会话 token 只下发一次，库中仅存 SHA-256 哈希。
 * - 会话能力继承所锚地址的 Store 运营方角色（MVP 单运营方地址清单）；
 *   plan 级权限（publisher/委托）在装修与加入路由内按 plan 核验。
 */

export interface StoreSessionServiceOptions {
  readonly store?: StoreWalletSessionStore;
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
  /** 请求头里出现的原始 token 对应的会话记录（已通过有效期与撤销检查）。 */
  readonly record: StoreWalletSessionRecord;
}

export interface StoreSessionService {
  createChallenge(input: unknown, requesterSession?: ResolveWalletSessionResult): Promise<StoreWalletSessionChallengeDTO>;
  verify(input: unknown, requesterSession?: ResolveWalletSessionResult): Promise<StoreWalletSessionVerifyResult>;
  resolveSessionFromToken(token: string | undefined): Promise<ResolveWalletSessionResult | undefined>;
  logout(token: string | undefined): Promise<boolean>;
  listAccountAddresses(accountId: string): Promise<readonly StoreAccountAddressView[]>;
  revokeAccountAddress(input: unknown, requesterSession: ResolveWalletSessionResult): Promise<readonly StoreAccountAddressView[]>;
  sessionView(record: StoreWalletSessionRecord): Promise<StoreWalletSessionView>;
}

export const STORE_SESSION_TOKEN_PREFIX = "uvs_";
export const STORE_SESSION_HEADER = "x-uvp-store-session";
export const STORE_DEV_ANCHORED_ADDRESS_HEADER = "x-uvp-store-dev-anchored-address";

export function createStoreSessionService(options: StoreSessionServiceOptions = {}): StoreSessionService {
  const store = options.store ?? new InMemoryStoreWalletSessionStore();
  const config = options.config ?? defaultWalletSessionConfig();
  const now = options.now ?? (() => new Date());
  const verifyWalletMessage = options.verifyWalletMessage ?? defaultVerifyWalletMessage;

  return {
    async createChallenge(input, requesterSession) {
      if (!config.enabled) {
        throw new StoreSessionServiceError(403, "store_wallet_session_disabled", "wallet sessions are not enabled for this deployment");
      }
      const record = requireBodyRecord(input);
      const address = normalizeAddress(requiredString(record, "address"), "address");
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
      const nonce = randomBytes(16).toString("hex");
      const issuedAt = timestamp.toISOString();
      const expiresAt = new Date(timestamp.getTime() + config.challengeTtlSeconds * 1000).toISOString();
      const chainId = optionalString(record, "chainId");
      const message = buildStoreLoginMessage({
        address,
        intent,
        ...(accountId ? { accountId } : {}),
        ...(chainId ? { chainId } : {}),
        nonce,
        issuedAt,
        expirationTime: expiresAt
      });
      const challenge: StoreAuthChallengeRecord = {
        nonce,
        address,
        intent,
        ...(accountId ? { accountId } : {}),
        message,
        issuedAt,
        expiresAt
      };
      await store.putChallenge(challenge);
      return {
        nonce,
        address,
        message,
        issuedAt,
        expiresAt
      };
    },

    async verify(input, requesterSession) {
      if (!config.enabled) {
        throw new StoreSessionServiceError(403, "store_wallet_session_disabled", "wallet sessions are not enabled for this deployment");
      }
      const record = requireBodyRecord(input);
      const nonce = requiredString(record, "nonce");
      const signature = requiredString(record, "signature") as Hex;
      const challenge = await store.getChallenge(nonce);
      if (!challenge || challenge.consumedAt) {
        throw new StoreSessionServiceError(401, "store_challenge_invalid", "challenge is unknown or already used");
      }
      if (challenge.expiresAt < now().toISOString()) {
        throw new StoreSessionServiceError(401, "store_challenge_expired", "challenge has expired");
      }
      const address = challenge.address;
      // 挑战单次使用：条件 UPDATE 原子占位
      //（burn-on-attempt）：并发重放同一 nonce 只有一个请求能通过；
      // 签名失败可重新取挑战，代价可接受。
      const consumed = store.consumeChallenge
        ? await store.consumeChallenge(nonce, now().toISOString())
        : await consumeChallengeByReadWrite(store, challenge, now);
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
      const session: StoreWalletSessionRecord = {
        sessionId: `sess_${randomUUID()}`,
        tokenHash: sha256Hex(token),
        accountId,
        anchoredAddress: address,
        createdAt: timestamp,
        expiresAt: new Date(new Date(timestamp).getTime() + config.sessionTtlSeconds * 1000).toISOString(),
        lastSeenAt: timestamp
      };
      await store.putSession(session);
      if (!existing) {
        await store.putAccountAddress({
          accountId,
          address,
          status: "active",
          anchoredAt: timestamp,
          anchorSessionId: session.sessionId
        });
      }
      return {
        token,
        session: await this.sessionView(session),
        linkedToExistingAccount: Boolean(anchorToAccountId)
      };
    },

    async resolveSessionFromToken(token) {
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
      // 地址撤销即时收敛：锚定地址不再是账号的 active 地址时会话立即失效
      //（含运营方/管理员地址清单带来的能力）。
      const activeAnchor = await store.findActiveAccountAddress(record.anchoredAddress);
      if (!activeAnchor || activeAnchor.accountId !== record.accountId) {
        await store.updateSession({
          ...record,
          revokedAt: now().toISOString(),
          revokedReason: "anchor_address_revoked"
        });
        return undefined;
      }
      const refreshed = { ...record, lastSeenAt: now().toISOString() };
      await store.updateSession(refreshed);
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
      await store.updateSession({ ...record, revokedAt: now().toISOString(), revokedReason: "logout" });
      return true;
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
      await store.putAccountAddress({
        ...active,
        status: "revoked",
        revokedAt: timestamp,
        revokedBySessionId: requesterSession.record.sessionId
      });
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

/**
 * 把钱包会话叠加到既有 StoreAccessState 上：
 * - 未配置/未启用时原样返回（fail-closed，不放大权限）。
 * - 钱包地址命中运营方/管理员清单时提升 level；否则至少 store_read。
 * - local + dev_headers 模式允许 dev 锚定地址头（显式仅供本地联调，staging/prod 拒绝）。
 */
export function createWalletSessionStoreIdentityProvider(options: {
  readonly base: StoreIdentityProvider;
  readonly sessionService: StoreSessionService;
  readonly config?: StoreWalletSessionConfig;
  readonly runtimeEnvironment?: ChainServicesRuntimeEnv;
}): StoreIdentityProvider {
  const config = options.config ?? defaultWalletSessionConfig();
  const runtimeEnvironment = options.runtimeEnvironment ?? "local";
  const strictRuntime = runtimeEnvironment === "staging" || runtimeEnvironment === "production";
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
        "store.draft.review",
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
        "store.draft.review",
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
      return storeReadCapabilities();
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
    // 程序化默认关闭 dev 锚定头；env 解析在 local 环境默认开启。
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

/**
 * 可选能力回退：store 未实现条件占位 consumeChallenge 时，退化为
 * 读-判-写（非原子）。这是当前接口的可选能力语义，不是旧版本兼容。
 */
async function consumeChallengeByReadWrite(
  store: StoreWalletSessionStore,
  challenge: NonNullable<Awaited<ReturnType<StoreWalletSessionStore["getChallenge"]>>>,
  now: () => Date
): Promise<unknown> {
  await store.updateChallenge({ ...challenge, consumedAt: now().toISOString() });
  return challenge;
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
