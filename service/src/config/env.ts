import { existsSync, readFileSync } from "node:fs";
import {
  ConfigError,
  normalizeAddress,
  normalizeBytes32,
  type Address,
  type ChainTarget,
  type Hex,
} from "../shared/types.js";
import type { StorageDriver } from "../storage/types.js";
import { storeAuthUrlEvidenceFailure } from "./store-auth-evidence.js";

export interface NetworkConfig {
  readonly chainTarget?: ChainTarget;
  readonly chainId: number;
  readonly rpcUrl: string;
  readonly deploymentBlock: bigint;
  /**
   * Finality buffer used before an event range is indexed. The indexer also
   * persists block hashes and rolls back to a common ancestor when a reorg is
   * detected; this value bounds the normal exposure window.
   */
  readonly finalityConfirmations: number;
  readonly contracts: Readonly<Record<string, Address>>;
  readonly stateMachineDeployments?: readonly StateMachineDeploymentConfig[];
  readonly activeDeploymentId?: Hex;
}

export interface StateMachineDeploymentConfig {
  readonly deploymentId: Hex;
  readonly stateMachineAddress: Address;
  readonly modules?: {
    readonly stagePatch?: Address;
    readonly derivedSignal?: Address;
    readonly docking?: Address;
    readonly planMetadata?: Address;
    readonly orderLink?: Address;
    readonly lens?: Address;
  };
  readonly status?:
    | "candidate"
    | "canary"
    | "active"
    | "deprecated"
    | "retired";
  readonly deploymentBlock?: bigint;
}

export interface DatabaseConfig {
  readonly driver: StorageDriver;
  readonly url: string;
  readonly migrationsAutoRun: boolean;
}

export interface ApiConfig {
  /** Descriptor 托管公网基址（配置后 descriptorURI 指向 /identity/descriptors/...）。 */
  readonly identityDescriptorPublicBaseUrl?: string;
  readonly host: string;
  readonly port: number;
  readonly indexerPollIntervalMs: number;
}

export interface RelayerConfig {
  readonly businessSigning: "forbidden";
  readonly broadcastEnabled: boolean;
  readonly gasSignerRef?: string;
  readonly stateMachinePrivateKeyEnv: string;
  readonly expectedGasPayer?: Address;
  readonly maxRetries: number;
}

export interface GovernanceConfig {
  readonly broadcastEnabled: boolean;
  /** 私钥所在环境变量名：GOVERNANCE_SIGNER_PRIVATE_KEY_ENV 指向的变量名，缺省即值形态默认名。 */
  readonly signerPrivateKeyEnv: string;
  readonly signerPrivateKey?: Hex;
  readonly signerAddress?: Address;
  readonly registryOwnerAddress?: Address;
  readonly rpcUrl: string;
  readonly chainId: number;
  readonly txConfirmations: number;
  readonly allowedOperators: readonly Address[];
}

export interface ProductBffConfig {
  readonly registrationAdapter: "memory-trigger" | "anvil";
  readonly registrarPrivateKeyEnv: string;
  readonly registrarAddress?: Address;
  readonly waitForReceipt: boolean;
  readonly registrationCreatorAddress?: Address;
}

export interface OperatorRoleConfig {
  readonly deployerPrivateKeyEnv: string;
  readonly deployerAddress?: Address;
  readonly stateMachineOwnerAddress?: Address;
  readonly planPublisherAddress?: Address;
  readonly orderRegistrarAddress?: Address;
  readonly relayerGasPayerAddress?: Address;
  readonly participantWallets: readonly Address[];
  readonly governanceRegistryOwnerAddress?: Address;
  readonly governanceSignerAddress?: Address;
  readonly adminReviewers: readonly string[];
  readonly opsConsoleAdmins?: readonly string[];
}

export interface ReconcileConfig {
  readonly enabled: boolean;
  readonly pollIntervalMs: number;
  readonly txTimeoutMs: number;
}

export interface DockAutomationConfig {
  readonly enabled: boolean;
  readonly pollIntervalMs: number;
  readonly maxCandidatesPerRun: number;
  readonly maxGasPerTx?: bigint;
  /**
   * 最终性窗口去重：同一 binding 广播成功后，在该窗口内
   * 不重复广播——投影要等链事件 finalize+索引后才呈现 delivery，逐轮
   * 重发是纯 gas 浪费的 no-op 交易。窗口过后仍未投影为已投递才会重试
   * （覆盖交易丢失的情形）。
   */
  readonly redeliveryWindowMs: number;
}

export interface EvidenceStorageConfig {
  readonly adapter: "local" | "rehearsal-object" | "s3";
  readonly localDir?: string;
  readonly objectRootDir?: string;
  readonly objectNamespace: string;
  readonly s3Bucket?: string;
  readonly s3Region?: string;
  readonly s3Endpoint?: string;
  readonly s3Prefix?: string;
  readonly s3ForcePathStyle?: boolean;
  readonly s3AccessKeyIdEnv?: string;
  readonly s3SecretAccessKeyEnv?: string;
  readonly s3SessionTokenEnv?: string;
  readonly s3UriMode?: "s3" | "object";
  readonly s3ObjectNamespace?: string;
  /** 可选第二副本 bucket（UVP_EVIDENCE_BACKUP_BUCKET）。 */
  readonly s3BackupBucket?: string;
}

export type ChainServicesRuntimeEnv =
  | "local"
  | "testnet"
  | "staging"
  | "production";

export type StoreAuthConfigMode = "dev_headers" | "jwt";

export interface StoreAuthConfig {
  readonly mode: StoreAuthConfigMode;
  readonly jwksUrl?: string;
  readonly oidcDiscoveryUrl?: string;
  readonly issuer?: string;
  readonly audience?: string;
  readonly roleClaim: string;
  readonly principalClaim: string;
  readonly displayNameClaim?: string;
  readonly clockToleranceSeconds: number;
  /** 钱包会话（SIWE 式登录 + 地址锚定）子配置。 */
  readonly walletSession?: StoreWalletSessionConfig;
}

/**
 * 钱包会话配置：
 * - enabled：local/testnet 默认开；staging/production 必须显式开启。
 * - operatorWallets/adminWallets：MVP 单运营方地址清单——会话锚定地址
 *   命中清单即获得对应 Store 角色能力（会话能力继承所锚地址的链上角色
 *   与 Store 委托关系的运营方子集；plan 级权限另行按 planPublisher 核验）。
 * - devAnchoredAddressHeaderEnabled：仅 local 开发头锚定，生产拒绝。
 */
export interface StoreWalletSessionConfig {
  readonly enabled: boolean;
  readonly operatorWallets: readonly Address[];
  readonly adminWallets: readonly Address[];
  readonly sessionTtlSeconds: number;
  readonly challengeTtlSeconds: number;
  readonly devAnchoredAddressHeaderEnabled: boolean;
}

export interface SecurityConfig {
  readonly environment: ChainServicesRuntimeEnv;
  readonly preflightStrict: boolean;
  readonly logRedactionEnabled: boolean;
  readonly broadcastMaxInFlightPerOrder: number;
  readonly broadcastMaxRetry: number;
  readonly broadcastRetryBaseMs: number;
  readonly broadcastRetryMaxMs: number;
  readonly broadcastReceiptTimeoutMs: number;
}

export interface NotificationsConfig {
  /** 通用 webhook transport；未配置时不装配 dispatcher（默认关）。 */
  readonly webhookUrl?: string;
  readonly webhookSecretConfigured: boolean;
}

export interface ChainServicesConfig {
  readonly network: NetworkConfig;
  readonly database: DatabaseConfig;
  readonly api: ApiConfig;
  readonly relayer: RelayerConfig;
  readonly governance: GovernanceConfig;
  readonly productBff: ProductBffConfig;
  readonly operatorRoles: OperatorRoleConfig;
  readonly reconcile: ReconcileConfig;
  readonly dockAutomation: DockAutomationConfig;
  readonly evidenceStorage: EvidenceStorageConfig;
  readonly notifications?: NotificationsConfig;
  readonly storeAuth?: StoreAuthConfig;
  readonly security: SecurityConfig;
}

type Env = Record<string, string | undefined>;

export interface PostgresDatabaseClassification {
  readonly host: string | null;
  readonly redactedHost: string | null;
  readonly isLocal: boolean;
  readonly isNonLocal: boolean;
  readonly provider:
    | "neon"
    | "supabase"
    | "railway"
    | "render"
    | "unknown"
    | null;
}

export function loadConfigFromEnv(env: Env = process.env): ChainServicesConfig {
  const gasSignerRef = optionalEnv(env, "UVP_RELAYER_TX_SIGNER_REF");
  const stateMachinePrivateKeyEnv =
    optionalEnv(env, "UVP_STATE_MACHINE_RELAYER_PRIVATE_KEY_ENV") ??
    "UVP_STATE_MACHINE_RELAYER_PRIVATE_KEY";
  const registrarPrivateKeyEnv =
    optionalEnv(env, "UVP_PRODUCT_BFF_REGISTRAR_PRIVATE_KEY_ENV") ??
    "UVP_PRODUCT_BFF_REGISTRAR_PRIVATE_KEY";
  const operatorRoles = parseOperatorRoleConfig(env);
  const manifest = parseAddressManifest(env);
  const contracts = {
    ...manifest.contracts,
    ...parseContracts(env),
  };
  const chainId = parseInteger(env, "UVP_CHAIN_ID", manifest.chainId ?? 31337);
  const rpcUrl = resolveRpcUrl(env, manifest.rpcUrlEnv);
  const databaseDriver = parseStorageDriver(
    optionalEnv(env, "CHAIN_SERVICES_DATABASE_DRIVER"),
  );
  const databaseUrl = requiredEnv(env, "CHAIN_SERVICES_DATABASE_URL");
  const registrationCreatorAddress = optionalAddressEnv(
    env,
    "UVP_PRODUCT_BFF_CREATOR_ADDRESS",
  );
  const environment = parseRuntimeEnv(env);
  const broadcastMaxRetry = parseInteger(env, "BROADCAST_MAX_RETRY_ATTEMPTS", 3);

  const config: ChainServicesConfig = {
    network: {
      chainTarget: parseChainTarget(env),
      chainId,
      rpcUrl,
      deploymentBlock: parseBigIntValue(
        env,
        "UVP_DEPLOYMENT_BLOCK",
        manifest.deploymentBlock ?? 0n,
      ),
      // 默认 1 仅供本地/测试网；production 预检要求显式配置
      // （validateProductionSafety / runProductionSafetyPreflight）。
      finalityConfirmations: parseInteger(env, "UVP_FINALITY_CONFIRMATIONS", 1),
      contracts,
      stateMachineDeployments: manifest.stateMachineDeployments,
      ...(manifest.activeDeploymentId
        ? { activeDeploymentId: manifest.activeDeploymentId }
        : {}),
    },
    database: {
      driver: databaseDriver,
      url: databaseUrl,
      migrationsAutoRun: parseBoolean(env, "CHAIN_SERVICES_MIGRATIONS_AUTO_RUN", false),
    },
    api: {
      host: optionalEnv(env, "UVP_API_HOST") ?? "127.0.0.1",
      port: parseInteger(env, "UVP_API_PORT", 8787),
      indexerPollIntervalMs: parseInteger(
        env,
        "UVP_INDEXER_POLL_INTERVAL_MS",
        5_000,
      ),
      ...(optionalEnv(env, "STORE_IDENTITY_DESCRIPTOR_PUBLIC_BASE_URL")
        ? { identityDescriptorPublicBaseUrl: optionalEnv(env, "STORE_IDENTITY_DESCRIPTOR_PUBLIC_BASE_URL")!.replace(/\/+$/, "") }
        : {}),
    },
    relayer: {
      businessSigning: "forbidden",
      broadcastEnabled: parseBoolean(
        env,
        "UVP_STATE_MACHINE_RELAYER_BROADCAST_ENABLED",
        Boolean(optionalEnv(env, stateMachinePrivateKeyEnv)),
      ),
      ...(gasSignerRef ? { gasSignerRef } : {}),
      stateMachinePrivateKeyEnv,
      ...(operatorRoles.relayerGasPayerAddress
        ? { expectedGasPayer: operatorRoles.relayerGasPayerAddress }
        : {}),
      maxRetries: broadcastMaxRetry,
    },
    governance: parseGovernanceConfig(env, { chainId, rpcUrl }),
    productBff: {
      registrationAdapter: parseProductRegistrationAdapter(env),
      registrarPrivateKeyEnv,
      ...(operatorRoles.orderRegistrarAddress
        ? { registrarAddress: operatorRoles.orderRegistrarAddress }
        : {}),
      waitForReceipt: parseBoolean(
        env,
        "UVP_PRODUCT_BFF_WAIT_FOR_RECEIPT",
        false,
      ),
      ...(registrationCreatorAddress ? { registrationCreatorAddress } : {}),
    },
    operatorRoles,
    reconcile: {
      enabled: parseBoolean(env, "RECONCILE_WORKER_ENABLED", false),
      pollIntervalMs: parseInteger(env, "RECONCILE_POLL_INTERVAL_MS", 5_000),
      txTimeoutMs: parseInteger(env, "RECONCILE_TX_TIMEOUT_MS", 30 * 60 * 1000),
    },
    dockAutomation: {
      enabled: parseBoolean(
        env,
        "UVP_DOCK_AUTOMATION_ENABLED",
        false,
      ),
      pollIntervalMs: parseInteger(env, "UVP_DOCK_AUTOMATION_POLL_INTERVAL_MS", 5_000),
      maxCandidatesPerRun: parseInteger(
        env,
        "UVP_DOCK_AUTOMATION_MAX_CANDIDATES_PER_RUN",
        4,
      ),
      ...optionalGasCap(env, "UVP_DOCK_AUTOMATION_MAX_GAS_PER_TX", 500_000n),
      redeliveryWindowMs: parseInteger(
        env,
        "UVP_DOCK_AUTOMATION_REDELIVERY_WINDOW_MS",
        120_000,
      ),
    },
    evidenceStorage: parseEvidenceStorageConfig(env),
    notifications: parseNotificationsConfig(env),
    storeAuth: parseStoreAuthConfig(env, environment),
    security: {
      environment,
      preflightStrict: parseBoolean(
        env,
        "SECURITY_PREFLIGHT_STRICT",
        environment === "production" ||
          environment === "testnet" ||
          environment === "staging",
      ),
      logRedactionEnabled: parseBoolean(env, "LOG_REDACTION_ENABLED", true),
      broadcastMaxInFlightPerOrder: parseInteger(
        env,
        "BROADCAST_MAX_IN_FLIGHT_PER_ORDER",
        1,
      ),
      broadcastMaxRetry,
      broadcastRetryBaseMs: parseInteger(env, "BROADCAST_RETRY_BASE_MS", 250),
      broadcastRetryMaxMs: parseInteger(env, "BROADCAST_RETRY_MAX_MS", 5_000),
      broadcastReceiptTimeoutMs: parseInteger(
        env,
        "BROADCAST_RECEIPT_TIMEOUT_MS",
        0,
      ),
    },
  };

  validateProductionSafety(config, env);
  return config;
}

interface ParsedAddressManifest {
  readonly chainId?: number;
  readonly rpcUrlEnv?: string;
  readonly deploymentBlock?: bigint;
  readonly contracts: Readonly<Record<string, Address>>;
  readonly stateMachineDeployments: readonly StateMachineDeploymentConfig[];
  readonly activeDeploymentId?: Hex;
}

function optionalEnv(env: Env, name: string): string | undefined {
  const value = env[name];
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseInteger(env: Env, name: string, fallback: number): number {
  const rawValue = optionalEnv(env, name);
  if (!rawValue) {
    return fallback;
  }

  const parsed = Number(rawValue);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ConfigError(`${name} must be a non-negative safe integer`);
  }

  return parsed;
}

function parseBoolean(env: Env, name: string, fallback: boolean): boolean {
  const rawValue = optionalEnv(env, name);
  if (!rawValue) {
    return fallback;
  }

  switch (rawValue.toLowerCase()) {
    case "1":
    case "true":
    case "yes":
      return true;
    case "0":
    case "false":
    case "no":
      return false;
    default:
      throw new ConfigError(`${name} must be true or false`);
  }
}

function parseChainTarget(env: Env): ChainTarget {
  const rawValue = optionalEnv(env, "UVP_CHAIN_TARGET") ?? "evm";
  if (rawValue === "evm" || rawValue === "solana") {
    return rawValue;
  }
  throw new ConfigError("UVP_CHAIN_TARGET must be evm or solana");
}

function parseRuntimeEnv(env: Env): ChainServicesRuntimeEnv {
  const rawValue = optionalEnv(env, "CHAIN_SERVICES_RUNTIME_ENV") ?? "local";
  if (
    rawValue === "local" ||
    rawValue === "testnet" ||
    rawValue === "staging" ||
    rawValue === "production"
  ) {
    return rawValue;
  }
  throw new ConfigError(
    "CHAIN_SERVICES_RUNTIME_ENV must be local, testnet, staging, or production",
  );
}

function parseProductRegistrationAdapter(
  env: Env,
): ProductBffConfig["registrationAdapter"] {
  const rawValue = optionalEnv(env, "UVP_PRODUCT_BFF_REGISTRATION_ADAPTER");
  if (!rawValue) {
    throw new ConfigError(
      "UVP_PRODUCT_BFF_REGISTRATION_ADAPTER is required (memory-trigger or anvil)",
    );
  }
  if (rawValue === "memory-trigger" || rawValue === "anvil") {
    return rawValue;
  }
  throw new ConfigError(
    "UVP_PRODUCT_BFF_REGISTRATION_ADAPTER must be memory-trigger or anvil",
  );
}

function parseEvidenceStorageConfig(env: Env): EvidenceStorageConfig {
  const adapter = parseEvidenceStorageAdapter(env);
  const localDir = optionalEnv(env, "UVP_EVIDENCE_STORAGE_DIR");
  const objectRootDir = optionalEnv(env, "UVP_EVIDENCE_OBJECT_ROOT_DIR");
  const objectNamespace = parseEvidenceObjectNamespace(env);
  const s3Bucket = optionalEnv(env, "UVP_EVIDENCE_S3_BUCKET");
  const s3Region = optionalEnv(env, "UVP_EVIDENCE_S3_REGION");
  const s3Endpoint = optionalEnv(env, "UVP_EVIDENCE_S3_ENDPOINT");
  const s3Prefix = optionalEnv(env, "UVP_EVIDENCE_S3_PREFIX");
  const s3ForcePathStyle = parseBoolean(
    env,
    "UVP_EVIDENCE_S3_FORCE_PATH_STYLE",
    false,
  );
  const s3AccessKeyIdEnv = optionalEnv(
    env,
    "UVP_EVIDENCE_S3_ACCESS_KEY_ID_ENV",
  );
  const s3SecretAccessKeyEnv = optionalEnv(
    env,
    "UVP_EVIDENCE_S3_SECRET_ACCESS_KEY_ENV",
  );
  const s3SessionTokenEnv = optionalEnv(
    env,
    "UVP_EVIDENCE_S3_SESSION_TOKEN_ENV",
  );
  const s3UriMode = parseEvidenceS3UriMode(env);
  const s3ObjectNamespace = optionalEnv(
    env,
    "UVP_EVIDENCE_S3_OBJECT_NAMESPACE",
  );
  // 可选的第二副本 bucket；未配置时 preflight 警告。
  const s3BackupBucket = optionalEnv(env, "UVP_EVIDENCE_BACKUP_BUCKET");

  return {
    adapter,
    ...(localDir ? { localDir } : {}),
    ...(objectRootDir ? { objectRootDir } : {}),
    objectNamespace,
    ...(s3Bucket ? { s3Bucket } : {}),
    ...(s3Region ? { s3Region } : {}),
    ...(s3Endpoint ? { s3Endpoint } : {}),
    ...(s3Prefix ? { s3Prefix } : {}),
    ...(adapter === "s3" ? { s3ForcePathStyle, s3UriMode } : {}),
    ...(s3AccessKeyIdEnv ? { s3AccessKeyIdEnv } : {}),
    ...(s3SecretAccessKeyEnv ? { s3SecretAccessKeyEnv } : {}),
    ...(s3SessionTokenEnv ? { s3SessionTokenEnv } : {}),
    ...(s3ObjectNamespace ? { s3ObjectNamespace } : {}),
    ...(s3BackupBucket ? { s3BackupBucket } : {}),
  };
}

function parseNotificationsConfig(env: Env): NotificationsConfig {
  const webhookUrl = optionalEnv(env, "UVP_NOTIFY_WEBHOOK_URL");
  return {
    ...(webhookUrl ? { webhookUrl } : {}),
    webhookSecretConfigured: Boolean(optionalEnv(env, "UVP_NOTIFY_WEBHOOK_SECRET"))
  };
}

function parseEvidenceStorageAdapter(
  env: Env,
): EvidenceStorageConfig["adapter"] {
  const rawValue = optionalEnv(env, "UVP_EVIDENCE_STORAGE_ADAPTER") ?? "local";
  if (
    rawValue === "local" ||
    rawValue === "rehearsal-object" ||
    rawValue === "s3"
  ) {
    return rawValue;
  }
  throw new ConfigError(
    "UVP_EVIDENCE_STORAGE_ADAPTER must be local, rehearsal-object, or s3",
  );
}

function parseEvidenceS3UriMode(
  env: Env,
): NonNullable<EvidenceStorageConfig["s3UriMode"]> {
  const rawValue = optionalEnv(env, "UVP_EVIDENCE_S3_URI_MODE") ?? "s3";
  if (rawValue === "s3" || rawValue === "object") {
    return rawValue;
  }
  throw new ConfigError("UVP_EVIDENCE_S3_URI_MODE must be s3 or object");
}

function parseEvidenceObjectNamespace(env: Env): string {
  const namespace =
    optionalEnv(env, "UVP_EVIDENCE_OBJECT_NAMESPACE") ?? "uvp-rehearsal";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,126}$/.test(namespace)) {
    throw new ConfigError(
      "UVP_EVIDENCE_OBJECT_NAMESPACE must be a private object namespace label",
    );
  }
  return namespace;
}

function parseStoreAuthConfig(
  env: Env,
  environment: ChainServicesRuntimeEnv,
): StoreAuthConfig {
  const mode = parseStoreAuthMode(env, environment);
  const jwksUrl = optionalEnv(env, "STORE_AUTH_JWKS_URL");
  const configuredOidcDiscoveryUrl = optionalEnv(
    env,
    "STORE_AUTH_OIDC_DISCOVERY_URL",
  );
  const issuer = optionalEnv(env, "STORE_AUTH_ISSUER");
  const audience = optionalEnv(env, "STORE_AUTH_AUDIENCE");
  const roleClaim = optionalEnv(env, "STORE_AUTH_ROLE_CLAIM") ?? "roles";
  const principalClaim =
    optionalEnv(env, "STORE_AUTH_PRINCIPAL_CLAIM") ?? "sub";
  const displayNameClaim =
    optionalEnv(env, "STORE_AUTH_DISPLAY_NAME_CLAIM") ?? "name";
  const clockToleranceSeconds = parseInteger(
    env,
    "STORE_AUTH_CLOCK_TOLERANCE_SECONDS",
    60,
  );

  if (
    (environment === "staging" || environment === "production") &&
    mode !== "jwt"
  ) {
    throw new ConfigError(
      "STORE_AUTH_MODE=jwt is required in staging and production",
    );
  }
  if (mode === "jwt") {
    if (!issuer) {
      throw new ConfigError(
        "STORE_AUTH_ISSUER is required when STORE_AUTH_MODE=jwt",
      );
    }
    validateStoreAuthUrl(issuer, "STORE_AUTH_ISSUER");
    const oidcDiscoveryUrl =
      configuredOidcDiscoveryUrl ??
      (!jwksUrl ? discoveryUrlFromIssuer(issuer) : undefined);
    if (!jwksUrl && !oidcDiscoveryUrl) {
      throw new ConfigError(
        "STORE_AUTH_JWKS_URL or STORE_AUTH_OIDC_DISCOVERY_URL is required when STORE_AUTH_MODE=jwt",
      );
    }
    if (jwksUrl) {
      validateStoreAuthUrl(jwksUrl, "STORE_AUTH_JWKS_URL");
    }
    if (oidcDiscoveryUrl) {
      validateStoreAuthUrl(oidcDiscoveryUrl, "STORE_AUTH_OIDC_DISCOVERY_URL");
    }
    if (!audience) {
      throw new ConfigError(
        "STORE_AUTH_AUDIENCE is required when STORE_AUTH_MODE=jwt",
      );
    }
    if (!roleClaim) {
      throw new ConfigError(
        "STORE_AUTH_ROLE_CLAIM is required when STORE_AUTH_MODE=jwt",
      );
    }
    if (!principalClaim) {
      throw new ConfigError(
        "STORE_AUTH_PRINCIPAL_CLAIM is required when STORE_AUTH_MODE=jwt",
      );
    }
    if (environment === "staging" || environment === "production") {
      validateNonLocalHttpsStoreAuthUrl(issuer, "STORE_AUTH_ISSUER");
      validateNonLocalHttpsStoreAuthUrl(
        jwksUrl ?? oidcDiscoveryUrl!,
        jwksUrl ? "STORE_AUTH_JWKS_URL" : "STORE_AUTH_OIDC_DISCOVERY_URL",
      );
    }
  }
  const oidcDiscoveryUrl =
    mode === "jwt" && issuer
      ? (configuredOidcDiscoveryUrl ??
        (!jwksUrl ? discoveryUrlFromIssuer(issuer) : undefined))
      : configuredOidcDiscoveryUrl;

  return {
    mode,
    ...(jwksUrl ? { jwksUrl } : {}),
    ...(oidcDiscoveryUrl ? { oidcDiscoveryUrl } : {}),
    ...(issuer ? { issuer } : {}),
    ...(audience ? { audience } : {}),
    roleClaim,
    principalClaim,
    ...(displayNameClaim ? { displayNameClaim } : {}),
    clockToleranceSeconds,
    walletSession: parseStoreWalletSessionConfig(env, environment),
  };
}

function parseStoreWalletSessionConfig(
  env: Env,
  environment: ChainServicesRuntimeEnv,
): StoreWalletSessionConfig {
  const strict = environment === "staging" || environment === "production";
  const enabledRaw = optionalEnv(env, "STORE_AUTH_WALLET_SESSION_ENABLED");
  const enabled = enabledRaw !== undefined
    ? parseBooleanFlag(enabledRaw, "STORE_AUTH_WALLET_SESSION_ENABLED")
    : !strict;
  const operatorWallets = parseWalletAddressList(env, "STORE_AUTH_OPERATOR_WALLETS");
  const adminWallets = parseWalletAddressList(env, "STORE_AUTH_ADMIN_WALLETS");
  const sessionTtlSeconds = parseInteger(
    env,
    "STORE_AUTH_WALLET_SESSION_TTL_SECONDS",
    43200,
  );
  const challengeTtlSeconds = parseInteger(
    env,
    "STORE_AUTH_CHALLENGE_TTL_SECONDS",
    300,
  );
  const devHeaderRaw = optionalEnv(env, "STORE_AUTH_DEV_ANCHORED_ADDRESS_HEADER");
  return {
    enabled,
    operatorWallets,
    adminWallets,
    sessionTtlSeconds,
    challengeTtlSeconds,
    // dev 锚定地址头缺省仅 local 开：非 local 环境自报地址锚定等于
    // 伪造身份。非 local 环境必须显式开启才生效（生产语义上仍会被
    // strict runtime 拒绝）。
    devAnchoredAddressHeaderEnabled: devHeaderRaw !== undefined
      ? parseBooleanFlag(devHeaderRaw, "STORE_AUTH_DEV_ANCHORED_ADDRESS_HEADER")
      : !strict && environment === "local"
  };
}

function parseWalletAddressList(env: Env, name: string): readonly Address[] {
  const raw = optionalEnv(env, name);
  if (!raw) {
    return [];
  }
  const wallets = raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map((item) => normalizeAddress(item, name));
  return [...new Set(wallets.map((wallet) => wallet.toLowerCase()))] as readonly Address[];
}

function parseBooleanFlag(value: string, name: string): boolean {
  if (value === "true" || value === "1") {
    return true;
  }
  if (value === "false" || value === "0") {
    return false;
  }
  throw new ConfigError(`${name} must be true or false`);
}

function parseStoreAuthMode(
  env: Env,
  environment: ChainServicesRuntimeEnv,
): StoreAuthConfigMode {
  // 缺省档收紧——只有 local 允许缺省 dev_headers。
  // testnet 未显式配置 STORE_AUTH_MODE 即启动失败（静默回落 dev_headers
  // 等于任何人自报 store 头即可获得运营方能力）；显式配置
  // dev_headers 在 local 之外同样拒绝。staging/production 保持必须 jwt。
  const rawValue = optionalEnv(env, "STORE_AUTH_MODE");
  if (!rawValue) {
    if (environment === "local") {
      return "dev_headers";
    }
    throw new ConfigError(
      environment === "staging" || environment === "production"
        ? "STORE_AUTH_MODE=jwt is required in staging and production"
        : "STORE_AUTH_MODE must be explicitly configured in testnet (jwt)",
    );
  }
  if (rawValue !== "dev_headers" && rawValue !== "jwt") {
    throw new ConfigError("STORE_AUTH_MODE must be dev_headers or jwt");
  }
  if (rawValue === "dev_headers" && environment !== "local") {
    throw new ConfigError(
      "STORE_AUTH_MODE=dev_headers is only allowed in local development",
    );
  }
  return rawValue;
}

function validateStoreAuthUrl(value: string, envName: string): void {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new ConfigError(`${envName} must be an HTTP(S) URL`);
    }
  } catch (error) {
    if (error instanceof ConfigError) {
      throw error;
    }
    throw new ConfigError(`${envName} must be a valid URL`);
  }
}

function validateNonLocalHttpsStoreAuthUrl(
  value: string,
  envName: string,
): void {
  const failure = storeAuthUrlEvidenceFailure(value);
  if (failure === "invalid") {
    throw new ConfigError(`${envName} must be a valid URL`);
  }
  if (failure === "not_https") {
    throw new ConfigError(`${envName} must be HTTPS in staging and production`);
  }
  if (failure === "local_or_private") {
    throw new ConfigError(
      `${envName} must not use localhost or private network hosts in staging and production`,
    );
  }
  if (failure === "missing") {
    throw new ConfigError(`${envName} is required in staging and production`);
  }
}

function discoveryUrlFromIssuer(issuer: string): string {
  return `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
}

function requiredEnv(env: Env, name: string): string {
  const value = optionalEnv(env, name);
  if (!value) {
    throw new ConfigError(`${name} is required`);
  }
  return value;
}

function parseStorageDriver(rawDriver: string | undefined): StorageDriver {
  if (!rawDriver) {
    throw new ConfigError(
      "CHAIN_SERVICES_DATABASE_DRIVER is required (memory, sqlite, or postgres)",
    );
  }
  if (
    rawDriver === "memory" ||
    rawDriver === "sqlite" ||
    rawDriver === "postgres"
  ) {
    return rawDriver;
  }
  throw new ConfigError(
    "CHAIN_SERVICES_DATABASE_DRIVER must be memory, sqlite, or postgres",
  );
}

function parseBigIntValue(env: Env, name: string, fallback: bigint): bigint {
  const rawValue = optionalEnv(env, name);
  if (!rawValue) {
    return fallback;
  }

  try {
    const parsed = BigInt(rawValue);
    if (parsed < 0n) {
      throw new ConfigError(`${name} must be non-negative`);
    }
    return parsed;
  } catch (error) {
    if (error instanceof ConfigError) {
      throw error;
    }
    throw new ConfigError(`${name} must be parseable as bigint`);
  }
}

function optionalGasCap(
  env: Env,
  name: string,
  fallback: bigint,
): { readonly maxGasPerTx?: bigint } {
  const value = parseBigIntValue(env, name, fallback);
  return value > 0n ? { maxGasPerTx: value } : {};
}

function parseGovernanceConfig(
  env: Env,
  defaults: { readonly chainId: number; readonly rpcUrl: string },
): GovernanceConfig {
  const broadcastEnabled = parseBoolean(
    env,
    "GOVERNANCE_BROADCAST_ENABLED",
    false,
  );
  const signerPrivateKeyEnv =
    optionalEnv(env, "GOVERNANCE_SIGNER_PRIVATE_KEY_ENV") ??
    "GOVERNANCE_SIGNER_PRIVATE_KEY";
  const signerPrivateKey = optionalPrivateKeyEnv(env, signerPrivateKeyEnv);
  const signerAddress = optionalAddressEnv(env, "GOVERNANCE_SIGNER_ADDRESS");
  const registryOwnerAddress = optionalAddressEnv(
    env,
    "GOVERNANCE_REGISTRY_OWNER_ADDRESS",
  );

  if (broadcastEnabled && !signerPrivateKey) {
    throw new ConfigError(
      `${signerPrivateKeyEnv} is required when GOVERNANCE_BROADCAST_ENABLED=true`,
    );
  }

  return {
    broadcastEnabled,
    signerPrivateKeyEnv,
    ...(signerPrivateKey ? { signerPrivateKey } : {}),
    ...(signerAddress ? { signerAddress } : {}),
    ...(registryOwnerAddress ? { registryOwnerAddress } : {}),
    rpcUrl: optionalEnv(env, "GOVERNANCE_RPC_URL") ?? defaults.rpcUrl,
    chainId: parseInteger(env, "GOVERNANCE_CHAIN_ID", defaults.chainId),
    txConfirmations: parseInteger(env, "GOVERNANCE_TX_CONFIRMATIONS", 1),
    allowedOperators: parseAddressList(env, "GOVERNANCE_ALLOWED_OPERATORS"),
  };
}

function parseOperatorRoleConfig(env: Env): OperatorRoleConfig {
  const deployerPrivateKeyEnv =
    optionalEnv(env, "UVP_ETH_DEPLOYER_PRIVATE_KEY_ENV") ??
    "UVP_ETH_DEPLOYER_PRIVATE_KEY";
  const deployerAddress = optionalAddressEnv(env, "UVP_ETH_DEPLOYER_ADDRESS");
  const stateMachineOwnerAddress = optionalAddressEnv(
    env,
    "UVP_STATE_MACHINE_OWNER_ADDRESS",
  );
  const planPublisherAddress = optionalAddressEnv(
    env,
    "UVP_PLAN_PUBLISHER_ADDRESS",
  );
  const orderRegistrarAddress = firstOptionalAddressEnv(env, [
    "UVP_ORDER_REGISTRAR_ADDRESS",
    "UVP_PRODUCT_BFF_REGISTRAR_ADDRESS",
  ]);
  const relayerGasPayerAddress = firstOptionalAddressEnv(env, [
    "UVP_RELAYER_GAS_PAYER_ADDRESS",
    "UVP_STATE_MACHINE_RELAYER_ADDRESS",
  ]);
  const governanceRegistryOwnerAddress = optionalAddressEnv(
    env,
    "GOVERNANCE_REGISTRY_OWNER_ADDRESS",
  );
  const governanceSignerAddress = optionalAddressEnv(
    env,
    "GOVERNANCE_SIGNER_ADDRESS",
  );

  return {
    deployerPrivateKeyEnv,
    ...(deployerAddress ? { deployerAddress } : {}),
    ...(stateMachineOwnerAddress ? { stateMachineOwnerAddress } : {}),
    ...(planPublisherAddress ? { planPublisherAddress } : {}),
    ...(orderRegistrarAddress ? { orderRegistrarAddress } : {}),
    ...(relayerGasPayerAddress ? { relayerGasPayerAddress } : {}),
    participantWallets: parseAddressList(
      env,
      "UVP_REHEARSAL_PARTICIPANT_WALLETS",
    ),
    ...(governanceRegistryOwnerAddress
      ? { governanceRegistryOwnerAddress }
      : {}),
    ...(governanceSignerAddress ? { governanceSignerAddress } : {}),
    adminReviewers: parseStringList(env, "GOVERNANCE_ADMIN_REVIEWER_IDS"),
    opsConsoleAdmins: parseStringList(env, "OPS_CONSOLE_ADMIN_IDS"),
  };
}

function optionalAddressEnv(env: Env, name: string): Address | undefined {
  const rawValue = optionalEnv(env, name);
  return rawValue ? normalizeAddress(rawValue, name) : undefined;
}

function firstOptionalAddressEnv(
  env: Env,
  names: readonly string[],
): Address | undefined {
  for (const name of names) {
    const address = optionalAddressEnv(env, name);
    if (address) {
      return address;
    }
  }
  return undefined;
}

function optionalBytes32Env(env: Env, name: string): Hex | undefined {
  const rawValue = optionalEnv(env, name);
  return rawValue ? normalizeBytes32(rawValue, name) : undefined;
}

function optionalPrivateKeyEnv(env: Env, name: string): Hex | undefined {
  const rawValue = optionalEnv(env, name);
  if (!rawValue) {
    return undefined;
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(rawValue)) {
    throw new ConfigError(`${name} must be a 32-byte 0x-prefixed hex string`);
  }
  return rawValue.toLowerCase() as Hex;
}

function parseAddressList(env: Env, name: string): readonly Address[] {
  const rawValue = optionalEnv(env, name);
  if (!rawValue) {
    return [];
  }
  return rawValue
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map((item) => normalizeAddress(item, name));
}

function parseStringList(env: Env, name: string): readonly string[] {
  const rawValue = optionalEnv(env, name);
  if (!rawValue) {
    return [];
  }
  return rawValue
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function parseContracts(env: Env): Readonly<Record<string, Address>> {
  const rawValue = optionalEnv(env, "UVP_CONTRACTS_JSON");
  if (!rawValue) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawValue);
  } catch {
    throw new ConfigError("UVP_CONTRACTS_JSON must be valid JSON");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigError("UVP_CONTRACTS_JSON must be an object");
  }

  const contracts: Record<string, Address> = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (typeof value !== "string") {
      throw new ConfigError(`contract ${name} must be an address string`);
    }
    const address = normalizeAddress(value, `contract ${name}`);
    if (address !== zeroAddress) {
      contracts[name] = address;
    }
  }

  return contracts;
}

const zeroAddress = "0x0000000000000000000000000000000000000000";

function parseAddressManifest(env: Env): ParsedAddressManifest {
  const manifestPath = optionalEnv(env, "UVP_ADDRESS_MANIFEST");
  if (!manifestPath) {
    return { contracts: {}, stateMachineDeployments: [] };
  }
  if (!existsSync(manifestPath)) {
    throw new ConfigError(`address manifest not found: ${manifestPath}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    throw new ConfigError(
      `address manifest must be valid JSON: ${manifestPath}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigError("address manifest must be an object");
  }

  const manifest = parsed as Record<string, unknown>;
  // 地址清单是输入不是猜想：schemaVersion 不符直接拒绝，避免按已作废的
  // 清单版本（如 v5）解析出口径漂移的部署记录。
  const schemaVersion = stringValue(manifest.schemaVersion);
  if (schemaVersion !== "uvp-eth.addresses.v1") {
    throw new ConfigError(
      `address manifest schemaVersion must be "uvp-eth.addresses.v1", got: ${schemaVersion || "(missing)"}`,
    );
  }
  const network = objectValue(manifest.network);
  const deployment = objectValue(manifest.deployment);
  const rawContracts = objectValue(manifest.contracts);
  const contracts: Record<string, Address> = {};
  const deploymentBlocks: bigint[] = [];
  const chainId = numberValue(network?.chainId);
  const rpcUrlEnv = stringValue(network?.rpcUrlEnv);
  const activeDeploymentId = stringValue(manifest.activeDeploymentId);
  const stateMachineDeployments = parseManifestStateMachineDeployments(
    manifest.stateMachineDeployments,
  );
  for (const deployment of stateMachineDeployments) {
    if (deployment.deploymentBlock !== undefined) {
      deploymentBlocks.push(deployment.deploymentBlock);
    }
  }

  for (const [name, rawContract] of Object.entries(rawContracts ?? {})) {
    const contract = objectValue(rawContract);
    const address = stringValue(contract?.address);
    if (!address) {
      continue;
    }
    contracts[name] = normalizeAddress(address, `manifest contract ${name}`);

    const contractDeployment = objectValue(contract?.deployment);
    const blockNumber = bigintLikeValue(contractDeployment?.blockNumber);
    if (blockNumber !== undefined) {
      deploymentBlocks.push(blockNumber);
    }
  }

  const manifestDeploymentBlock = bigintLikeValue(deployment?.blockNumber);
  if (manifestDeploymentBlock !== undefined) {
    deploymentBlocks.push(manifestDeploymentBlock);
  }

  return {
    ...(chainId !== undefined ? { chainId } : {}),
    ...(rpcUrlEnv ? { rpcUrlEnv } : {}),
    ...(deploymentBlocks.length > 0
      ? { deploymentBlock: minBigint(deploymentBlocks) }
      : {}),
    contracts,
    stateMachineDeployments,
    ...(activeDeploymentId
      ? {
          activeDeploymentId: normalizeBytes32(
            activeDeploymentId,
            "manifest.activeDeploymentId",
          ),
        }
      : {}),
  };
}

function parseManifestStateMachineDeployments(
  value: unknown,
): readonly StateMachineDeploymentConfig[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item, index) => {
    const record = objectValue(item);
    if (!record) {
      throw new ConfigError(
        `manifest stateMachineDeployments[${index}] must be an object`,
      );
    }
    const deploymentId = stringValue(record.deploymentId);
    const stateMachineAddress = stringValue(record.stateMachineAddress);
    if (!deploymentId || !stateMachineAddress) {
      throw new ConfigError(
        `manifest stateMachineDeployments[${index}] must include deploymentId and stateMachineAddress`,
      );
    }
    const deploymentBlock = bigintLikeValue(record.deploymentBlock);
    const status = stringValue(record.status);
    if (
      status &&
      !["candidate", "canary", "active", "deprecated", "retired"].includes(
        status,
      )
    ) {
      throw new ConfigError(
        `manifest stateMachineDeployments[${index}].status is invalid`,
      );
    }
    const deployment: StateMachineDeploymentConfig = {
      deploymentId: normalizeBytes32(
        deploymentId,
        `manifest stateMachineDeployments[${index}].deploymentId`,
      ),
      stateMachineAddress: normalizeAddress(
        stateMachineAddress,
        `manifest stateMachineDeployments[${index}].stateMachineAddress`,
      ),
    };
    const modules = parseStateMachineDeploymentModules(record.modules, index);
    if (modules) {
      (
        deployment as { modules?: StateMachineDeploymentConfig["modules"] }
      ).modules = modules;
    }
    if (status) {
      (
        deployment as { status?: StateMachineDeploymentConfig["status"] }
      ).status = status as StateMachineDeploymentConfig["status"];
    }
    if (deploymentBlock !== undefined) {
      (deployment as { deploymentBlock?: bigint }).deploymentBlock =
        deploymentBlock;
    }
    return [deployment];
  });
}

function parseStateMachineDeploymentModules(
  value: unknown,
  deploymentIndex: number,
): StateMachineDeploymentConfig["modules"] | undefined {
  const record = objectValue(value);
  if (!record) {
    return undefined;
  }
  const modules: Record<string, Address> = {};
  for (const key of [
    "stagePatch",
    "derivedSignal",
    "docking",
    "planMetadata",
    "orderLink",
    "lens",
  ] as const) {
    const raw = stringValue(record[key]);
    if (raw) {
      modules[key] = normalizeAddress(
        raw,
        `manifest stateMachineDeployments[${deploymentIndex}].modules.${key}`,
      );
    }
  }
  return Object.keys(modules).length > 0 ? modules : undefined;
}

function resolveRpcUrl(env: Env, manifestRpcUrlEnv?: string): string {
  const explicit = optionalEnv(env, "UVP_RPC_URL");
  if (explicit) {
    return explicit;
  }
  if (manifestRpcUrlEnv) {
    const manifestRpcUrl = optionalEnv(env, manifestRpcUrlEnv);
    if (manifestRpcUrl) {
      return manifestRpcUrl;
    }
  }
  return "http://127.0.0.1:8545";
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function bigintLikeValue(value: unknown): bigint | undefined {
  if (typeof value === "bigint") {
    return value >= 0n ? value : undefined;
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  if (typeof value === "string" && /^[0-9]+$/.test(value)) {
    return BigInt(value);
  }
  return undefined;
}

function minBigint(values: readonly bigint[]): bigint {
  return values.reduce(
    (min, value) => (value < min ? value : min),
    values[0] ?? 0n,
  );
}

function validateProductionSafety(config: ChainServicesConfig, env: Env): void {
  if (config.security.environment === "staging") {
    validateStagingSafety(config, env);
  }

  if (config.security.environment === "testnet") {
    validateTestnetSafety(config, env);
  }

  if (config.security.environment !== "production") {
    return;
  }

  if (
    !optionalEnv(env, "CHAIN_SERVICES_DATABASE_DRIVER") ||
    config.database.driver !== "postgres"
  ) {
    throw new ConfigError(
      "CHAIN_SERVICES_DATABASE_DRIVER=postgres is required in production",
    );
  }
  // production 必须显式配置 UVP_RPC_URL 且拒绝本地/回环地址——静默回落
  // 127.0.0.1:8545 会把生产指向不存在的节点（staging/testnet 同样强检）。
  if (!optionalEnv(env, "UVP_RPC_URL")) {
    throw new ConfigError("UVP_RPC_URL is required in production");
  }
  if (isLocalRpcUrl(config.network.rpcUrl, "production")) {
    throw new ConfigError(
      "UVP_RPC_URL must point to a non-local RPC endpoint in production",
    );
  }
  // admin 白名单在 production 必须显式非空——
  // 空白名单意味着任意 x-uvp-admin-id 自报即管理员（governance/auth.ts
  // 是 fail-closed 的，这里把配置错误拦在启动前）。
  if (config.operatorRoles.adminReviewers.length === 0) {
    throw new ConfigError(
      "GOVERNANCE_ADMIN_REVIEWER_IDS is required in production",
    );
  }
  if ((config.operatorRoles.opsConsoleAdmins ?? []).length === 0) {
    throw new ConfigError("OPS_CONSOLE_ADMIN_IDS is required in production");
  }
  // production 禁止静默使用 env 默认值 1。finality 确认数是索引器
  // reorg 缓冲必须显式配置为正整数；非生产保持默认 1 不变。追加前的
  // block-hash continuity check 与有界共同祖先回滚由 indexer 一并执行。
  if (
    !optionalEnv(env, "UVP_FINALITY_CONFIRMATIONS") ||
    config.network.finalityConfirmations <= 0
  ) {
    throw new ConfigError(
      "UVP_FINALITY_CONFIRMATIONS must be explicitly configured to a positive integer in production",
    );
  }
  if (!optionalEnv(env, "CHAIN_SERVICES_DATABASE_URL")) {
    throw new ConfigError(
      "CHAIN_SERVICES_DATABASE_URL is required in production",
    );
  }
  if (
    config.database.migrationsAutoRun &&
    optionalEnv(env, "UVP_PRODUCTION_ALLOW_AUTO_MIGRATIONS") !== "1"
  ) {
    throw new ConfigError(
      "CHAIN_SERVICES_MIGRATIONS_AUTO_RUN=true is forbidden in production without UVP_PRODUCTION_ALLOW_AUTO_MIGRATIONS=1",
    );
  }

  const privateKeyEnvNames = new Set([
    config.relayer.stateMachinePrivateKeyEnv,
    config.governance.signerPrivateKeyEnv,
    config.productBff.registrarPrivateKeyEnv,
    config.operatorRoles.deployerPrivateKeyEnv,
  ]);
  for (const envName of privateKeyEnvNames) {
    const privateKey = optionalEnv(env, envName)?.toLowerCase();
    if (privateKey && ANVIL_DEFAULT_PRIVATE_KEYS.has(privateKey)) {
      throw new ConfigError(
        `${envName} must not use an Anvil default private key in production`,
      );
    }
  }

  if (!config.security.preflightStrict) {
    throw new ConfigError(
      "SECURITY_PREFLIGHT_STRICT=false is forbidden in production",
    );
  }
  if (!config.security.logRedactionEnabled) {
    throw new ConfigError(
      "LOG_REDACTION_ENABLED=false is forbidden in production",
    );
  }
  if (config.governance.broadcastEnabled) {
    throw new ConfigError(
      "GOVERNANCE_BROADCAST_ENABLED=true uses env private-key governance and is forbidden in production",
    );
  }
  if (parseBoolean(env, "UVP_PRODUCT_E2E_FIXTURES", false)) {
    throw new ConfigError(
      "UVP_PRODUCT_E2E_FIXTURES=1 is forbidden in production",
    );
  }
  if (
    parseBoolean(env, "UVP_PRODUCT_PERMISSIVE_AUTH", false) ||
    isPermissiveAuthorizationRequested(env)
  ) {
    throw new ConfigError(
      "permissive Product submission authorization is forbidden in production",
    );
  }
  if (config.productBff.registrationAdapter !== "anvil") {
    throw new ConfigError(
      "UVP_PRODUCT_BFF_REGISTRATION_ADAPTER=anvil is required in production",
    );
  }
  if (!stateMachineAddress(config.network.contracts)) {
    throw new ConfigError(
      "UVPStateMachine contract address is required in production",
    );
  }
  if (!identityRegistryAddress(config.network.contracts)) {
    throw new ConfigError(
      "UVPIdentityRegistry contract address is required in production",
    );
  }
  if (!optionalEnv(env, config.relayer.stateMachinePrivateKeyEnv)) {
    throw new ConfigError(
      `${config.relayer.stateMachinePrivateKeyEnv} is required in production`,
    );
  }
  if (
    config.productBff.registrationAdapter === "anvil" &&
    !optionalEnv(env, config.productBff.registrarPrivateKeyEnv)
  ) {
    throw new ConfigError(
      `${config.productBff.registrarPrivateKeyEnv} is required when Product BFF registration adapter is anvil`,
    );
  }

  if (config.evidenceStorage.adapter !== "s3") {
    throw new ConfigError(
      "UVP_EVIDENCE_STORAGE_ADAPTER=s3 is required in production",
    );
  }
  if (!config.evidenceStorage.s3Bucket) {
    throw new ConfigError("UVP_EVIDENCE_S3_BUCKET is required in production");
  }
  if (!config.evidenceStorage.s3Region) {
    throw new ConfigError("UVP_EVIDENCE_S3_REGION is required in production");
  }
  if (!config.evidenceStorage.s3AccessKeyIdEnv) {
    throw new ConfigError(
      "UVP_EVIDENCE_S3_ACCESS_KEY_ID_ENV is required in production",
    );
  }
  if (!config.evidenceStorage.s3SecretAccessKeyEnv) {
    throw new ConfigError(
      "UVP_EVIDENCE_S3_SECRET_ACCESS_KEY_ENV is required in production",
    );
  }
}

function validateStagingSafety(config: ChainServicesConfig, env: Env): void {
  if (!config.security.preflightStrict) {
    throw new ConfigError(
      "SECURITY_PREFLIGHT_STRICT=false is forbidden in staging",
    );
  }
  if (!config.security.logRedactionEnabled) {
    throw new ConfigError(
      "LOG_REDACTION_ENABLED=false is forbidden in staging",
    );
  }

  if (
    optionalEnv(env, "CHAIN_SERVICES_DATABASE_DRIVER") !== "postgres" ||
    config.database.driver !== "postgres"
  ) {
    throw new ConfigError(
      "CHAIN_SERVICES_DATABASE_DRIVER=postgres is required in staging",
    );
  }
  if (!optionalEnv(env, "CHAIN_SERVICES_DATABASE_URL")) {
    throw new ConfigError("CHAIN_SERVICES_DATABASE_URL is required in staging");
  }
  if (
    config.database.migrationsAutoRun &&
    optionalEnv(env, "UVP_STAGING_ALLOW_AUTO_MIGRATIONS") !== "1"
  ) {
    throw new ConfigError(
      "CHAIN_SERVICES_MIGRATIONS_AUTO_RUN=true is forbidden in staging without UVP_STAGING_ALLOW_AUTO_MIGRATIONS=1",
    );
  }

  const manifestPath = optionalEnv(env, "UVP_ADDRESS_MANIFEST");
  if (!manifestPath) {
    throw new ConfigError(
      "UVP_ADDRESS_MANIFEST is required in staging",
    );
  }
  if (isExampleManifestPath(manifestPath)) {
    throw new ConfigError(
      "UVP_ADDRESS_MANIFEST must point to a curated staging address manifest, not an example manifest",
    );
  }

  const explicitRpcUrl = optionalEnv(env, "UVP_RPC_URL");
  if (!explicitRpcUrl) {
    throw new ConfigError("UVP_RPC_URL is required in staging");
  }
  if (isLocalRpcUrl(config.network.rpcUrl, "staging")) {
    throw new ConfigError(
      "UVP_RPC_URL must point to a non-local Base Sepolia or staging RPC in staging",
    );
  }
  if (
    optionalEnv(env, "UVP_CHAIN_ID") !== "84532" ||
    config.network.chainId !== 84532
  ) {
    throw new ConfigError("UVP_CHAIN_ID=84532 is required in staging");
  }
  if (
    !optionalEnv(env, "UVP_FINALITY_CONFIRMATIONS") ||
    config.network.finalityConfirmations <= 0
  ) {
    throw new ConfigError(
      "UVP_FINALITY_CONFIRMATIONS must be an explicit positive integer in staging",
    );
  }
  if (!stateMachineAddress(config.network.contracts)) {
    throw new ConfigError(
      "UVPStateMachine contract address is required in staging",
    );
  }
  if (!identityRegistryAddress(config.network.contracts)) {
    throw new ConfigError(
      "UVPIdentityRegistry contract address is required in staging",
    );
  }

  if (parseBoolean(env, "UVP_PRODUCT_E2E_FIXTURES", false)) {
    throw new ConfigError("UVP_PRODUCT_E2E_FIXTURES=1 is forbidden in staging");
  }
  if (
    parseBoolean(env, "UVP_PRODUCT_PERMISSIVE_AUTH", false) ||
    isPermissiveAuthorizationRequested(env)
  ) {
    throw new ConfigError(
      "permissive Product submission authorization is forbidden in staging",
    );
  }

  if (config.productBff.registrationAdapter !== "anvil") {
    throw new ConfigError(
      "UVP_PRODUCT_BFF_REGISTRATION_ADAPTER=anvil is required in staging",
    );
  }
  if (!optionalEnv(env, "UVP_PRODUCT_BFF_REGISTRAR_PRIVATE_KEY_ENV")) {
    throw new ConfigError(
      "UVP_PRODUCT_BFF_REGISTRAR_PRIVATE_KEY_ENV is required in staging",
    );
  }
  if (!optionalEnv(env, config.productBff.registrarPrivateKeyEnv)) {
    throw new ConfigError(
      `${config.productBff.registrarPrivateKeyEnv} is required when Product BFF registration adapter is anvil`,
    );
  }
  if (!config.productBff.registrarAddress) {
    throw new ConfigError("UVP_ORDER_REGISTRAR_ADDRESS is required in staging");
  }
  if (!config.productBff.waitForReceipt) {
    throw new ConfigError(
      "UVP_PRODUCT_BFF_WAIT_FOR_RECEIPT=true is required in staging",
    );
  }

  if (!config.relayer.broadcastEnabled) {
    throw new ConfigError(
      "UVP_STATE_MACHINE_RELAYER_BROADCAST_ENABLED=true is required in staging",
    );
  }
  if (!optionalEnv(env, "UVP_STATE_MACHINE_RELAYER_PRIVATE_KEY_ENV")) {
    throw new ConfigError(
      "UVP_STATE_MACHINE_RELAYER_PRIVATE_KEY_ENV is required in staging",
    );
  }
  if (!optionalEnv(env, config.relayer.stateMachinePrivateKeyEnv)) {
    throw new ConfigError(
      `${config.relayer.stateMachinePrivateKeyEnv} is required in staging`,
    );
  }
  if (!config.relayer.expectedGasPayer) {
    throw new ConfigError(
      "UVP_RELAYER_GAS_PAYER_ADDRESS is required in staging",
    );
  }

  if (config.evidenceStorage.adapter !== "s3") {
    throw new ConfigError(
      "UVP_EVIDENCE_STORAGE_ADAPTER=s3 is required in staging",
    );
  }
  if (!config.evidenceStorage.s3Bucket) {
    throw new ConfigError("UVP_EVIDENCE_S3_BUCKET is required in staging");
  }
  if (!config.evidenceStorage.s3Region) {
    throw new ConfigError("UVP_EVIDENCE_S3_REGION is required in staging");
  }
  if (!config.evidenceStorage.s3AccessKeyIdEnv) {
    throw new ConfigError(
      "UVP_EVIDENCE_S3_ACCESS_KEY_ID_ENV is required in staging",
    );
  }
  if (!config.evidenceStorage.s3SecretAccessKeyEnv) {
    throw new ConfigError(
      "UVP_EVIDENCE_S3_SECRET_ACCESS_KEY_ENV is required in staging",
    );
  }
  if (
    config.evidenceStorage.s3UriMode === "object" &&
    !config.evidenceStorage.s3ObjectNamespace
  ) {
    throw new ConfigError(
      "UVP_EVIDENCE_S3_OBJECT_NAMESPACE is required when UVP_EVIDENCE_S3_URI_MODE=object in staging",
    );
  }
  if (!optionalEnv(env, config.evidenceStorage.s3AccessKeyIdEnv)) {
    throw new ConfigError(
      `${config.evidenceStorage.s3AccessKeyIdEnv} is required in staging`,
    );
  }
  if (!optionalEnv(env, config.evidenceStorage.s3SecretAccessKeyEnv)) {
    throw new ConfigError(
      `${config.evidenceStorage.s3SecretAccessKeyEnv} is required in staging`,
    );
  }

  if (!optionalEnv(env, "UVP_ETH_DEPLOYER_PRIVATE_KEY_ENV")) {
    throw new ConfigError(
      "UVP_ETH_DEPLOYER_PRIVATE_KEY_ENV is required in staging",
    );
  }
  if (!optionalEnv(env, config.operatorRoles.deployerPrivateKeyEnv)) {
    throw new ConfigError(
      `${config.operatorRoles.deployerPrivateKeyEnv} is required in staging`,
    );
  }
  if (!config.operatorRoles.deployerAddress) {
    throw new ConfigError("UVP_ETH_DEPLOYER_ADDRESS is required in staging");
  }
  if (!config.operatorRoles.stateMachineOwnerAddress) {
    throw new ConfigError(
      "UVP_STATE_MACHINE_OWNER_ADDRESS is required in staging",
    );
  }
  if (!config.operatorRoles.planPublisherAddress) {
    throw new ConfigError("UVP_PLAN_PUBLISHER_ADDRESS is required in staging");
  }
  if (config.operatorRoles.participantWallets.length === 0) {
    throw new ConfigError(
      "UVP_REHEARSAL_PARTICIPANT_WALLETS is required in staging",
    );
  }
  if (!config.governance.registryOwnerAddress) {
    throw new ConfigError(
      "GOVERNANCE_REGISTRY_OWNER_ADDRESS is required in staging",
    );
  }
  if (!config.governance.signerAddress) {
    throw new ConfigError("GOVERNANCE_SIGNER_ADDRESS is required in staging");
  }
  if (!optionalEnv(env, "GOVERNANCE_SIGNER_PRIVATE_KEY_ENV")) {
    throw new ConfigError(
      "GOVERNANCE_SIGNER_PRIVATE_KEY_ENV is required in staging",
    );
  }
  if (!config.governance.signerPrivateKey) {
    throw new ConfigError(
      `${config.governance.signerPrivateKeyEnv} is required in staging`,
    );
  }
  if (config.operatorRoles.adminReviewers.length === 0) {
    throw new ConfigError(
      "GOVERNANCE_ADMIN_REVIEWER_IDS is required in staging",
    );
  }
  if ((config.operatorRoles.opsConsoleAdmins ?? []).length === 0) {
    throw new ConfigError("OPS_CONSOLE_ADMIN_IDS is required in staging");
  }
  if (!config.reconcile.enabled) {
    throw new ConfigError(
      "RECONCILE_WORKER_ENABLED=true is required in staging",
    );
  }
  validateManagedDatabaseCostSafety(config, env, "staging");

  const privateKeyEnvNames = new Set([
    config.relayer.stateMachinePrivateKeyEnv,
    config.governance.signerPrivateKeyEnv,
    config.productBff.registrarPrivateKeyEnv,
    config.operatorRoles.deployerPrivateKeyEnv,
  ]);
  for (const envName of privateKeyEnvNames) {
    const privateKey = optionalEnv(env, envName)?.toLowerCase();
    if (privateKey && ANVIL_DEFAULT_PRIVATE_KEYS.has(privateKey)) {
      throw new ConfigError(
        `${envName} must not use an Anvil default private key in staging`,
      );
    }
  }

  for (const participantWallet of config.operatorRoles.participantWallets) {
    if (ANVIL_DEFAULT_ADDRESSES.has(participantWallet)) {
      throw new ConfigError(
        "UVP_REHEARSAL_PARTICIPANT_WALLETS must not include Anvil default wallet addresses in staging",
      );
    }
  }
}

function validateTestnetSafety(config: ChainServicesConfig, env: Env): void {
  if (optionalEnv(env, "CHAIN_SERVICES_DATABASE_DRIVER") !== "postgres") {
    throw new ConfigError(
      "CHAIN_SERVICES_DATABASE_DRIVER=postgres is required in testnet",
    );
  }
  if (config.database.driver !== "postgres") {
    throw new ConfigError(
      "CHAIN_SERVICES_DATABASE_DRIVER=postgres is required in testnet",
    );
  }
  const databaseUrl = optionalEnv(env, "CHAIN_SERVICES_DATABASE_URL");
  if (!databaseUrl) {
    throw new ConfigError("CHAIN_SERVICES_DATABASE_URL is required in testnet");
  }
  if (!/^postgres(?:ql)?:\/\//.test(config.database.url)) {
    throw new ConfigError(
      "CHAIN_SERVICES_DATABASE_URL must point to a Postgres database in testnet",
    );
  }

  const explicitRpcUrl = optionalEnv(env, "UVP_RPC_URL");
  if (!explicitRpcUrl) {
    throw new ConfigError("UVP_RPC_URL is required in testnet");
  }
  if (isLocalRpcUrl(config.network.rpcUrl, "testnet")) {
    throw new ConfigError(
      "UVP_RPC_URL must point to a non-local Base Sepolia RPC in testnet",
    );
  }
  if (
    optionalEnv(env, "UVP_CHAIN_ID") !== "84532" ||
    config.network.chainId !== 84532
  ) {
    throw new ConfigError("UVP_CHAIN_ID=84532 is required in testnet");
  }
  if (!stateMachineAddress(config.network.contracts)) {
    throw new ConfigError(
      "UVPStateMachine contract address is required in testnet",
    );
  }
  if (!identityRegistryAddress(config.network.contracts)) {
    throw new ConfigError(
      "UVPIdentityRegistry contract address is required in testnet",
    );
  }
  // testnet 同样强制 admin 白名单非空——空白名单等于任意自报 admin 通过。
  if (config.operatorRoles.adminReviewers.length === 0) {
    throw new ConfigError(
      "GOVERNANCE_ADMIN_REVIEWER_IDS is required in testnet",
    );
  }
  if ((config.operatorRoles.opsConsoleAdmins ?? []).length === 0) {
    throw new ConfigError("OPS_CONSOLE_ADMIN_IDS is required in testnet");
  }

  if (!config.security.preflightStrict) {
    throw new ConfigError(
      "SECURITY_PREFLIGHT_STRICT=false is forbidden in testnet",
    );
  }
  if (!config.security.logRedactionEnabled) {
    throw new ConfigError(
      "LOG_REDACTION_ENABLED=false is forbidden in testnet",
    );
  }
  if (parseBoolean(env, "UVP_PRODUCT_E2E_FIXTURES", false)) {
    throw new ConfigError("UVP_PRODUCT_E2E_FIXTURES=1 is forbidden in testnet");
  }
  if (
    parseBoolean(env, "UVP_PRODUCT_PERMISSIVE_AUTH", false) ||
    isPermissiveAuthorizationRequested(env)
  ) {
    throw new ConfigError(
      "permissive Product submission authorization is forbidden in testnet",
    );
  }
  if (config.productBff.registrationAdapter !== "anvil") {
    throw new ConfigError(
      "UVP_PRODUCT_BFF_REGISTRATION_ADAPTER=anvil is required in testnet",
    );
  }
  if (config.evidenceStorage.adapter !== "rehearsal-object") {
    throw new ConfigError(
      "UVP_EVIDENCE_STORAGE_ADAPTER=rehearsal-object is required in testnet",
    );
  }

  const privateKeyEnvNames = new Set([
    config.relayer.stateMachinePrivateKeyEnv,
    "GOVERNANCE_SIGNER_PRIVATE_KEY",
    config.productBff.registrarPrivateKeyEnv,
    config.operatorRoles.deployerPrivateKeyEnv,
  ]);
  for (const envName of privateKeyEnvNames) {
    const privateKey = optionalEnv(env, envName)?.toLowerCase();
    if (privateKey && ANVIL_DEFAULT_PRIVATE_KEYS.has(privateKey)) {
      throw new ConfigError(
        `${envName} must not use an Anvil default private key in testnet`,
      );
    }
  }

  if (!optionalEnv(env, config.relayer.stateMachinePrivateKeyEnv)) {
    throw new ConfigError(
      `${config.relayer.stateMachinePrivateKeyEnv} is required in testnet`,
    );
  }
  if (!config.relayer.broadcastEnabled) {
    throw new ConfigError(
      "UVP_STATE_MACHINE_RELAYER_BROADCAST_ENABLED=false is forbidden in testnet",
    );
  }
  if (!optionalEnv(env, config.productBff.registrarPrivateKeyEnv)) {
    throw new ConfigError(
      `${config.productBff.registrarPrivateKeyEnv} is required when Product BFF registration adapter is anvil`,
    );
  }
  if (
    config.governance.broadcastEnabled &&
    config.governance.chainId !== 84532
  ) {
    throw new ConfigError(
      "GOVERNANCE_CHAIN_ID=84532 is required in testnet when governance broadcast is enabled",
    );
  }
  validateManagedDatabaseCostSafety(config, env, "testnet");
}

function validateManagedDatabaseCostSafety(
  config: ChainServicesConfig,
  env: Env,
  environment: "staging" | "testnet",
): void {
  if (config.database.driver !== "postgres") {
    return;
  }
  const classification = classifyPostgresDatabaseUrl(config.database.url);
  if (!classification.isNonLocal) {
    return;
  }
  const host = classification.redactedHost ?? "non-local Postgres";
  // 受管 PG 上不强制 poll=0（那会让外部参与方事件永不入投影、
  // reconcile 永卡，只能人工 rebuild）。要求 poll 间隔显式配置；允许 0，
  // 但 =0 必须同时显式确认知情键 UVP_INDEXER_POLL_DISABLED_ACK=1。
  const pollExplicit = env.UVP_INDEXER_POLL_INTERVAL_MS?.trim() !== undefined && env.UVP_INDEXER_POLL_INTERVAL_MS?.trim() !== "";
  if (!pollExplicit) {
    throw new ConfigError(
      `UVP_INDEXER_POLL_INTERVAL_MS must be explicitly configured when CHAIN_SERVICES_DATABASE_URL points to ${host} in ${environment} (a mild positive interval such as 5000 is recommended)`,
    );
  }
  if (
    config.api.indexerPollIntervalMs <= 0 &&
    env.UVP_INDEXER_POLL_DISABLED_ACK?.trim() !== "1"
  ) {
    throw new ConfigError(
      `UVP_INDEXER_POLL_DISABLED_ACK=1 is required to acknowledge the consequences of UVP_INDEXER_POLL_INTERVAL_MS=0 (external participants' events will never enter the projection; reconcile stalls; recovery needs a manual rebuild) when CHAIN_SERVICES_DATABASE_URL points to ${host} in ${environment}`,
    );
  }
  if (
    config.reconcile.enabled &&
    config.reconcile.pollIntervalMs > 0 &&
    config.reconcile.pollIntervalMs < 30_000
  ) {
    throw new ConfigError(
      `RECONCILE_POLL_INTERVAL_MS must be 0 or at least 30000 when CHAIN_SERVICES_DATABASE_URL points to ${host} in ${environment}`,
    );
  }
}

export function classifyPostgresDatabaseUrl(
  value: string | undefined,
): PostgresDatabaseClassification {
  if (!value || !/^postgres(?:ql)?:\/\//.test(value)) {
    return {
      host: null,
      redactedHost: null,
      isLocal: false,
      isNonLocal: false,
      provider: null,
    };
  }
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    const isLocal = isLocalPostgresHost(host);
    return {
      host,
      redactedHost: parsed.port ? `${host}:${parsed.port}` : host,
      isLocal,
      isNonLocal: !isLocal,
      provider: postgresProvider(host),
    };
  } catch {
    return {
      host: null,
      redactedHost: null,
      isLocal: false,
      isNonLocal: false,
      provider: null,
    };
  }
}

function isLocalPostgresHost(host: string): boolean {
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host.startsWith("127.") ||
    host === "::1" ||
    host === "[::1]" ||
    host === "0.0.0.0" ||
    host === "host.docker.internal"
  );
}

function postgresProvider(
  host: string,
): PostgresDatabaseClassification["provider"] {
  if (host.includes("neon.tech") || host.includes("neon.com")) {
    return "neon";
  }
  if (host.includes("supabase.co")) {
    return "supabase";
  }
  if (host.includes("railway.app")) {
    return "railway";
  }
  if (host.includes("render.com") || host.includes("render-postgres")) {
    return "render";
  }
  return "unknown";
}

function isPermissiveAuthorizationRequested(env: Env): boolean {
  const rawValue = optionalEnv(
    env,
    "UVP_PRODUCT_SUBMISSION_AUTHORIZATION",
  )?.toLowerCase();
  return rawValue === "permissive" || rawValue === "product_projection_demo";
}

function stateMachineAddress(
  contracts: Readonly<Record<string, Address>>,
): Address | undefined {
  const address = contracts.UVPStateMachine;
  return address && address !== zeroAddress ? address : undefined;
}

function identityRegistryAddress(
  contracts: Readonly<Record<string, Address>>,
): Address | undefined {
  const address = contracts.UVPIdentityRegistry;
  return address && address !== zeroAddress ? address : undefined;
}

function isExampleManifestPath(manifestPath: string): boolean {
  return (
    /(^|[/\\])[^/\\]*example[^/\\]*\.(json|ya?ml)$/i.test(manifestPath) ||
    /(^|[/\\])examples?([/\\]|$)/i.test(manifestPath)
  );
}

function isLocalRpcUrl(
  rpcUrl: string,
  environment: ChainServicesRuntimeEnv,
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rpcUrl);
  } catch {
    throw new ConfigError(`UVP_RPC_URL must be a valid URL in ${environment}`);
  }

  const hostname = parsed.hostname.toLowerCase();
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "0.0.0.0" ||
    hostname === "::1" ||
    hostname === "[::1]" ||
    hostname.endsWith(".local")
  );
}

const ANVIL_DEFAULT_PRIVATE_KEYS = new Set([
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f094538864e17c8b7e37a2c115d7e4cc795fb0c1",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
  "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
  "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356",
  "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97",
  "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6",
]);

const ANVIL_DEFAULT_ADDRESSES = new Set<Address>([
  "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
  "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
  "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc",
  "0x90f79bf6eb2c4f870365e785982e1f101e93b906",
  "0x15d34aaf54267db7d7c367839aaf71a00a2c6a65",
  "0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc",
  "0x976ea74026e726554db657fa54763abd0c3a0aa9",
  "0x14dc79964da2c08b23698b3d3cc7ca32193d9955",
  "0x23618e81e3f5cdf7f54c3d65f7fbc0abf5b21e8f",
  "0xa0ee7a142d267c1f36714e4a8f75612f20a79720",
  "0xbcd4042de499d14e55001ccbb24a551f3b954096",
]);
