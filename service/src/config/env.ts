import { existsSync, readFileSync } from "node:fs";
import {
  ConfigError,
  normalizeAddress,
  normalizeBytes32,
  type Address,
  type ChainTarget,
  type Hex,
} from "../shared/types.js";
import { ANVIL_DEFAULT_PRIVATE_KEYS } from "./anvil-defaults.js";

export type FinalityAnchor = "finalized" | "confirmations";

export interface NetworkConfig {
  readonly chainTarget?: ChainTarget;
  readonly chainId: number;
  readonly rpcUrl: string;
  readonly deploymentBlock: bigint;
  readonly finalityAnchor: FinalityAnchor;
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
  readonly url: string;
  readonly migrationsAutoRun: boolean;
}

export interface ApiConfig {
  readonly host: string;
  readonly port: number;
  readonly indexerPollIntervalMs: number;
}

export interface RelayerConfig {
  readonly businessSigning: "forbidden";
  readonly broadcastEnabled: boolean;
  readonly stateMachinePrivateKeyEnv: string;
  readonly expectedGasPayer?: Address;
  readonly maxRetries: number;
}

export interface OperatorRoleConfig {
  readonly relayerGasPayerAddress?: Address;
  readonly opsConsoleAdmins?: readonly string[];
  readonly adminTokenHashes?: readonly string[];
}

export interface ReconcileConfig {
  readonly enabled: boolean;
  readonly pollIntervalMs: number;
  readonly txTimeoutMs: number;
}

export type ChainServicesRuntimeEnv =
  | "local"
  | "testnet"
  | "staging"
  | "production";

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

export interface ChainServicesConfig {
  readonly network: NetworkConfig;
  readonly database: DatabaseConfig;
  readonly api: ApiConfig;
  readonly relayer: RelayerConfig;
  readonly operatorRoles: OperatorRoleConfig;
  readonly reconcile: ReconcileConfig;
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
  const stateMachinePrivateKeyEnv =
    optionalEnv(env, "UVP_STATE_MACHINE_RELAYER_PRIVATE_KEY_ENV") ??
    "UVP_STATE_MACHINE_RELAYER_PRIVATE_KEY";
  const operatorRoles = parseOperatorRoleConfig(env);
  const manifest = parseAddressManifest(env);
  const contracts = {
    ...manifest.contracts,
    ...parseContracts(env),
  };
  const chainId = parseInteger(env, "UVP_CHAIN_ID", manifest.chainId ?? 31337);
  const environment = parseRuntimeEnv(env);
  const rpcUrl = resolveRpcUrl(env, manifest.rpcUrlEnv, environment);
  const databaseUrl = requiredDatabaseUrl(env);
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
      finalityAnchor: parseFinalityAnchor(env),
      finalityConfirmations: parseInteger(env, "UVP_FINALITY_CONFIRMATIONS", 1),
      contracts,
      stateMachineDeployments: manifest.stateMachineDeployments,
      ...(manifest.activeDeploymentId
        ? { activeDeploymentId: manifest.activeDeploymentId }
        : {}),
    },
    database: {
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
    },
    relayer: {
      businessSigning: "forbidden",
      broadcastEnabled: parseBoolean(
        env,
        "UVP_STATE_MACHINE_RELAYER_BROADCAST_ENABLED",
        Boolean(optionalEnv(env, stateMachinePrivateKeyEnv)),
      ),
      stateMachinePrivateKeyEnv,
      ...(operatorRoles.relayerGasPayerAddress
        ? { expectedGasPayer: operatorRoles.relayerGasPayerAddress }
        : {}),
      maxRetries: broadcastMaxRetry,
    },
    operatorRoles,
    reconcile: {
      enabled: parseBoolean(env, "RECONCILE_WORKER_ENABLED", false),
      pollIntervalMs: parseInteger(env, "RECONCILE_POLL_INTERVAL_MS", 5_000),
      txTimeoutMs: parseInteger(env, "RECONCILE_TX_TIMEOUT_MS", 30 * 60 * 1000),
    },
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

  validateProductionSafety(config, env, {
    chainIdExplicit:
      optionalEnv(env, "UVP_CHAIN_ID") !== undefined || manifest.chainId !== undefined
  });
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

function parseFinalityAnchor(env: Env): FinalityAnchor {
  const rawValue = optionalEnv(env, "UVP_FINALITY_ANCHOR") ?? "finalized";
  if (rawValue === "finalized" || rawValue === "confirmations") {
    return rawValue;
  }
  throw new ConfigError("UVP_FINALITY_ANCHOR must be finalized or confirmations");
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
  const rawValue = optionalEnv(env, "CHAIN_SERVICES_RUNTIME_ENV");
  if (!rawValue) {
    throw new ConfigError("CHAIN_SERVICES_RUNTIME_ENV is required (local, testnet, staging, or production)");
  }
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

function validateNonLocalHttpsEndpointUrl(value: string, envName: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigError(`${envName} must be a valid URL`);
  }
  if (parsed.protocol === "https:") {
    return;
  }
  if (parsed.protocol === "http:" && isLoopbackEndpointHost(parsed.hostname.toLowerCase())) {
    return;
  }
  throw new ConfigError(
    `${envName} must use https outside local development (http is only allowed for loopback hosts)`,
  );
}

function isLoopbackEndpointHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]" ||
    hostname.endsWith(".local")
  );
}

function discoveryUrlFromIssuer(issuer: string): string {
  return `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
}

function requiredDatabaseUrl(env: Env): string {
  const value = optionalEnv(env, "CHAIN_SERVICES_DATABASE_URL");
  if (!value) {
    throw new ConfigError(
      "CHAIN_SERVICES_DATABASE_URL is required: storage is Postgres-only. " +
        "For local runs start the bundled container with `./scripts/with-postgres.sh` " +
        "(or `pnpm test`, which starts it automatically) and point the URL at it, " +
        "e.g. postgres://uvp:uvp@127.0.0.1:5432/uvp_chain_services"
    );
  }
  if (!/^postgres(?:ql)?:\/\//.test(value)) {
    throw new ConfigError(
      "CHAIN_SERVICES_DATABASE_URL must be a postgres:// (or postgresql://) DSN"
    );
  }
  return value;
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

function parseOperatorRoleConfig(env: Env): OperatorRoleConfig {
  const relayerGasPayerAddress = firstOptionalAddressEnv(env, [
    "UVP_RELAYER_GAS_PAYER_ADDRESS",
    "UVP_STATE_MACHINE_RELAYER_ADDRESS",
  ]);
  return {
    ...(relayerGasPayerAddress ? { relayerGasPayerAddress } : {}),
    opsConsoleAdmins: parseStringList(env, "OPS_CONSOLE_ADMIN_IDS"),
    adminTokenHashes: parseAdminTokenHashes(env),
  };
}

function parseAdminTokenHashes(env: Env): readonly string[] {
  const hashes = parseStringList(env, "CHAIN_SERVICES_ADMIN_TOKEN_HASHES")
    .map((hash) => hash.toLowerCase());
  for (const hash of hashes) {
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      throw new ConfigError(
        "CHAIN_SERVICES_ADMIN_TOKEN_HASHES entries must be 64-character sha256 hex strings",
      );
    }
  }
  return hashes;
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

export function listContractJsonOverrides(env: Env): readonly string[] {
  const jsonContracts = parseContracts(env);
  const overridden = Object.keys(jsonContracts).filter((name) => {
    try {
      const manifest = parseAddressManifest(env);
      const manifestAddress = manifest.contracts[name];
      const jsonAddress = jsonContracts[name];
      return Boolean(
        manifestAddress &&
        jsonAddress &&
        manifestAddress.toLowerCase() !== jsonAddress.toLowerCase()
      );
    } catch {
      return false;
    }
  });
  return overridden;
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

function resolveRpcUrl(
  env: Env,
  manifestRpcUrlEnv: string | undefined,
  environment: ChainServicesRuntimeEnv
): string {
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
  if (environment === "local") {
    console.warn(
      "[chain-services config] UVP_RPC_URL is not set; falling back to http://127.0.0.1:8545 (local Anvil default)"
    );
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

function validateProductionSafety(
  config: ChainServicesConfig,
  env: Env,
  options: { readonly chainIdExplicit: boolean }
): void {
  if (config.security.environment === "staging") {
    validateStagingSafety(config, env);
  }

  if (config.security.environment === "testnet") {
    validateTestnetSafety(config, env);
  }

  if (config.security.environment !== "production") {
    return;
  }

  validateManagedDatabaseCostSafety(config, env, "production");
  if (!options.chainIdExplicit) {
    throw new ConfigError(
      "UVP_CHAIN_ID must be explicitly configured in production (env var or address manifest network.chainId); refusing the 31337 fallback",
    );
  }
  if (!optionalEnv(env, "UVP_RPC_URL")) {
    throw new ConfigError("UVP_RPC_URL is required in production");
  }
  if (isLocalRpcUrl(config.network.rpcUrl, "production")) {
    throw new ConfigError(
      "UVP_RPC_URL must point to a non-local RPC endpoint in production",
    );
  }
  validateNonLocalHttpsEndpointUrl(config.network.rpcUrl, "UVP_RPC_URL");
  if ((config.operatorRoles.opsConsoleAdmins ?? []).length === 0) {
    throw new ConfigError("OPS_CONSOLE_ADMIN_IDS is required in production");
  }
  if ((config.operatorRoles.adminTokenHashes ?? []).length === 0) {
    throw new ConfigError("CHAIN_SERVICES_ADMIN_TOKEN_HASHES is required in production");
  }
  if (
    config.network.finalityAnchor === "confirmations" &&
    (!optionalEnv(env, "UVP_FINALITY_CONFIRMATIONS") ||
      config.network.finalityConfirmations <= 0)
  ) {
    throw new ConfigError(
      "UVP_FINALITY_CONFIRMATIONS must be explicitly configured to a positive integer in production when UVP_FINALITY_ANCHOR=confirmations",
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

  const privateKeyEnvNames = new Set([config.relayer.stateMachinePrivateKeyEnv]);
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
  if (!config.reconcile.enabled) {
    throw new ConfigError(
      "RECONCILE_WORKER_ENABLED=true is required in production",
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
  validateNonLocalHttpsEndpointUrl(config.network.rpcUrl, "UVP_RPC_URL");
  if (
    optionalEnv(env, "UVP_CHAIN_ID") !== "84532" ||
    config.network.chainId !== 84532
  ) {
    throw new ConfigError("UVP_CHAIN_ID=84532 is required in staging");
  }
  if (
    config.network.finalityAnchor === "confirmations" &&
    (!optionalEnv(env, "UVP_FINALITY_CONFIRMATIONS") ||
      config.network.finalityConfirmations <= 0)
  ) {
    throw new ConfigError(
      "UVP_FINALITY_CONFIRMATIONS must be an explicit positive integer in staging when UVP_FINALITY_ANCHOR=confirmations",
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

  if (!config.relayer.broadcastEnabled) {
    throw new ConfigError(
      "UVP_STATE_MACHINE_RELAYER_BROADCAST_ENABLED=true is required in staging",
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

  if ((config.operatorRoles.opsConsoleAdmins ?? []).length === 0) {
    throw new ConfigError("OPS_CONSOLE_ADMIN_IDS is required in staging");
  }
  if ((config.operatorRoles.adminTokenHashes ?? []).length === 0) {
    throw new ConfigError("CHAIN_SERVICES_ADMIN_TOKEN_HASHES is required in staging");
  }
  if (!config.reconcile.enabled) {
    throw new ConfigError(
      "RECONCILE_WORKER_ENABLED=true is required in staging",
    );
  }
  validateManagedDatabaseCostSafety(config, env, "staging");

  const privateKeyEnvNames = new Set([config.relayer.stateMachinePrivateKeyEnv]);
  for (const envName of privateKeyEnvNames) {
    const privateKey = optionalEnv(env, envName)?.toLowerCase();
    if (privateKey && ANVIL_DEFAULT_PRIVATE_KEYS.has(privateKey)) {
      throw new ConfigError(
        `${envName} must not use an Anvil default private key in staging`,
      );
    }
  }
}

function validateTestnetSafety(config: ChainServicesConfig, env: Env): void {
  const databaseUrl = optionalEnv(env, "CHAIN_SERVICES_DATABASE_URL");
  if (!databaseUrl) {
    throw new ConfigError("CHAIN_SERVICES_DATABASE_URL is required in testnet");
  }
  if (!/^postgres(?:ql)?:\/\//.test(config.database.url)) {
    throw new ConfigError(
      "CHAIN_SERVICES_DATABASE_URL must point to a Postgres database in testnet",
    );
  }
  if (
    config.database.migrationsAutoRun &&
    optionalEnv(env, "UVP_TESTNET_ALLOW_AUTO_MIGRATIONS") !== "1"
  ) {
    throw new ConfigError(
      "CHAIN_SERVICES_MIGRATIONS_AUTO_RUN=true is forbidden in testnet without UVP_TESTNET_ALLOW_AUTO_MIGRATIONS=1",
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
  validateNonLocalHttpsEndpointUrl(config.network.rpcUrl, "UVP_RPC_URL");
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
  if (
    config.network.finalityAnchor === "confirmations" &&
    (!optionalEnv(env, "UVP_FINALITY_CONFIRMATIONS") ||
      config.network.finalityConfirmations <= 0)
  ) {
    throw new ConfigError(
      "UVP_FINALITY_CONFIRMATIONS must be explicitly configured to a positive integer in testnet when UVP_FINALITY_ANCHOR=confirmations",
    );
  }
  if ((config.operatorRoles.opsConsoleAdmins ?? []).length === 0) {
    throw new ConfigError("OPS_CONSOLE_ADMIN_IDS is required in testnet");
  }
  if ((config.operatorRoles.adminTokenHashes ?? []).length === 0) {
    throw new ConfigError("CHAIN_SERVICES_ADMIN_TOKEN_HASHES is required in testnet");
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
  if (!config.reconcile.enabled) {
    throw new ConfigError(
      "RECONCILE_WORKER_ENABLED=true is required in testnet",
    );
  }

  const privateKeyEnvNames = new Set([config.relayer.stateMachinePrivateKeyEnv]);
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
  validateManagedDatabaseCostSafety(config, env, "testnet");
}

function validateManagedDatabaseCostSafety(
  config: ChainServicesConfig,
  env: Env,
  environment: "staging" | "testnet" | "production",
): void {
  const classification = classifyPostgresDatabaseUrl(config.database.url);
  if (!classification.isNonLocal) {
    return;
  }
  const host = classification.redactedHost ?? "non-local Postgres";
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
