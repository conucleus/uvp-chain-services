import { createPublicClient, http, parseAbi, type Address as ViemAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { ChainServicesConfig } from "./env.js";
import { ConfigError, normalizeAddress, type Address, type Hex } from "../shared/types.js";
import { redactErrorMessage } from "../security/redaction.js";

type Env = Record<string, string | undefined>;

export type ConfigPreflightStatus = "passed" | "failed" | "skipped";

export interface ConfigDiagnosticCheck {
  readonly name: string;
  readonly status: ConfigPreflightStatus;
  readonly message?: string;
}

export interface ConfigDiagnostics {
  readonly environment: ChainServicesConfig["security"]["environment"];
  readonly demoMode: boolean;
  readonly e2eControls: boolean;
  readonly storageDriver: string;
  readonly relayerConfigured: boolean;
  readonly network: {
    readonly chainId: number;
    readonly deploymentBlock: string;
    readonly finalityConfirmations: number;
    readonly reorgBufferBlocks: number;
    readonly contracts: Readonly<Record<string, Address>>;
    readonly stateMachineConfigured: boolean;
    readonly trustRegistryConfigured: boolean;
  };
  readonly warnings: readonly string[];
  readonly preflight: {
    readonly strict: boolean;
    readonly status: ConfigPreflightStatus;
    readonly checks: readonly ConfigDiagnosticCheck[];
  };
  readonly relayer: {
    readonly broadcastEnabled: boolean;
    readonly configured: boolean;
    readonly contractConfigured: boolean;
    readonly privateKeyConfigured: boolean;
    readonly gasPayer?: Address;
    readonly expectedGasPayer?: Address;
    readonly maxRetries: number;
  };
  readonly governance: {
    readonly broadcastEnabled: boolean;
    readonly configured: boolean;
    readonly contractConfigured: boolean;
    readonly domainConfigured: boolean;
    readonly signerConfigured: boolean;
    readonly signerAddress?: Address;
    readonly expectedSignerAddress?: Address;
    readonly expectedDomainOwnerAddress?: Address;
    readonly allowedOperatorCount: number;
  };
  readonly operatorRoles: {
    readonly deployer: PrivateKeyRoleDiagnostics;
    readonly stateMachineOwner: AddressRoleDiagnostics;
    readonly planPublisher: AddressRoleDiagnostics;
    readonly orderRegistrar: PrivateKeyRoleDiagnostics;
    readonly relayerGasPayer: PrivateKeyRoleDiagnostics;
    readonly participantWallet: {
      readonly configuredCount: number;
      readonly backendBusinessSigning: "forbidden";
    };
    readonly governanceDomainOwner: AddressRoleDiagnostics;
    readonly governanceSigner: PrivateKeyRoleDiagnostics;
    readonly governanceAdminReviewer: {
      readonly configuredCount: number;
      readonly publicTrustAuthority: false;
    };
    readonly opsConsoleAdmin: {
      readonly configuredCount: number;
    };
  };
  readonly storage: {
    readonly driver: string;
    readonly durable: boolean;
    readonly migrationsAutoRun: boolean;
  };
  readonly evidenceStorage: {
    readonly adapter: ChainServicesConfig["evidenceStorage"]["adapter"];
    readonly objectNamespace?: string;
    readonly s3?: {
      readonly bucketConfigured: boolean;
      readonly regionConfigured: boolean;
      readonly endpointConfigured: boolean;
      readonly prefixConfigured: boolean;
      readonly forcePathStyle: boolean;
      readonly uriMode: "s3" | "object";
      readonly objectNamespaceConfigured: boolean;
      readonly accessKeyIdEnv?: string;
      readonly secretAccessKeyEnv?: string;
      readonly sessionTokenEnv?: string;
    };
  };
  readonly storeAuth: {
    readonly mode: NonNullable<ChainServicesConfig["storeAuth"]>["mode"];
    readonly jwtConfigured: boolean;
    readonly jwksUrlConfigured: boolean;
    readonly issuerConfigured: boolean;
    readonly audienceConfigured: boolean;
    readonly roleClaim: string;
    readonly principalClaim: string;
    readonly displayNameClaimConfigured: boolean;
    readonly clockToleranceSeconds: number;
  };
  readonly product: {
    readonly demoMode: boolean;
    readonly e2eControls: boolean;
    readonly registrationAdapter: ChainServicesConfig["productBff"]["registrationAdapter"];
    readonly permissiveAuthorizationRequested: boolean;
  };
  readonly security: {
    readonly logRedactionEnabled: boolean;
  };
  readonly lastReconcileError: string | null;
}

export interface PreflightPublicClient {
  getChainId(): Promise<number>;
  getBytecode?(parameters: { readonly address: ViemAddress }): Promise<Hex | undefined>;
  readContract?(parameters: {
    readonly address: ViemAddress;
    readonly abi: unknown;
    readonly functionName: "domainOwner";
    readonly args: readonly unknown[];
  }): Promise<unknown>;
}

interface PrivateKeyRoleDiagnostics {
  readonly privateKeyEnv: string;
  readonly privateKeyConfigured: boolean;
  readonly address?: Address;
  readonly expectedAddress?: Address;
  readonly addressMatches?: boolean;
}

interface AddressRoleDiagnostics {
  readonly configured: boolean;
  readonly address?: Address;
}

export interface RunConfigPreflightOptions {
  readonly env?: Env;
  readonly clients?: {
    readonly network?: PreflightPublicClient;
    readonly governance?: PreflightPublicClient;
  };
}

const trustRegistryOwnerAbi = parseAbi([
  "function domainOwner(bytes32 domainId) view returns (address)"
]);

const zeroAddress = "0x0000000000000000000000000000000000000000";

export async function runConfigPreflight(
  config: ChainServicesConfig,
  options: RunConfigPreflightOptions = {}
): Promise<ConfigDiagnostics> {
  const env = options.env ?? process.env;
  const checks: ConfigDiagnosticCheck[] = [];
  const errors: string[] = [];

  runStaticPreflight(config, env, checks, errors);

  if (config.security.preflightStrict) {
    await runRpcPreflight(config, options.clients, checks, errors);
  }

  const status: ConfigPreflightStatus = errors.length > 0
    ? "failed"
    : config.security.preflightStrict
      ? "passed"
      : "skipped";
  const diagnostics = buildConfigDiagnostics(config, {
    env,
    preflight: { status, checks }
  });

  if (errors.length > 0) {
    throw new ConfigError(`chain-services config preflight failed: ${errors.map((message) => redactErrorMessage(message)).join("; ")}`);
  }

  return diagnostics;
}

export function buildConfigDiagnostics(
  config: ChainServicesConfig,
  options: {
    readonly env?: Env;
    readonly preflight?: {
      readonly status: ConfigPreflightStatus;
      readonly checks: readonly ConfigDiagnosticCheck[];
    };
    readonly lastReconcileError?: string | null;
  } = {}
): ConfigDiagnostics {
  const env = options.env ?? process.env;
  const stateMachine = stateMachineAddress(config.network.contracts);
  const trustRegistry = trustRegistryAddress(config.network.contracts);
  const relayerPrivateKeyConfigured = Boolean(env[config.relayer.stateMachinePrivateKeyEnv]?.trim());
  const relayerGasPayer = privateKeyAddress(env[config.relayer.stateMachinePrivateKeyEnv], "relayer gas payer");
  const relayerConfigured = Boolean(config.relayer.broadcastEnabled && stateMachine && relayerPrivateKeyConfigured);
  const governanceSignerConfigured = Boolean(config.governance.signerPrivateKey);
  const governanceSignerAddress = config.governance.signerPrivateKey
    ? privateKeyAddress(config.governance.signerPrivateKey, "governance signer")
    : undefined;
  const governanceDomainConfigured = Boolean(config.governance.domainId);
  const governanceContractConfigured = Boolean(trustRegistry);
  const demoMode = enabledEnv(env, "UVP_PRODUCT_DEMO_MODE");
  const e2eControls = enabledEnv(env, "UVP_PRODUCT_E2E_FIXTURES");
  const permissiveAuthorizationRequested = enabledEnv(env, "UVP_PRODUCT_PERMISSIVE_AUTH") ||
    isPermissiveAuthorizationRequested(env);
  const storeAuth = effectiveStoreAuthConfig(config);
  const preflight = options.preflight ?? {
    status: config.security.preflightStrict ? "skipped" : "skipped",
    checks: []
  };

  return {
    environment: config.security.environment,
    demoMode,
    e2eControls,
    storageDriver: config.database.driver,
    relayerConfigured,
    network: {
      chainId: config.network.chainId,
      deploymentBlock: config.network.deploymentBlock.toString(),
      finalityConfirmations: config.network.finalityConfirmations,
      reorgBufferBlocks: config.network.reorgBufferBlocks,
      contracts: config.network.contracts,
      stateMachineConfigured: Boolean(stateMachine),
      trustRegistryConfigured: Boolean(trustRegistry)
    },
    warnings: diagnosticWarnings(config, {
      relayerConfigured,
      relayerPrivateKeyConfigured,
      demoMode,
      e2eControls,
      permissiveAuthorizationRequested
    }),
    preflight: {
      strict: config.security.preflightStrict,
      status: preflight.status,
      checks: preflight.checks
    },
    relayer: {
      broadcastEnabled: config.relayer.broadcastEnabled,
      configured: relayerConfigured,
      contractConfigured: Boolean(stateMachine),
      privateKeyConfigured: relayerPrivateKeyConfigured,
      ...(relayerGasPayer ? { gasPayer: relayerGasPayer } : {}),
      ...(config.relayer.expectedGasPayer ? { expectedGasPayer: config.relayer.expectedGasPayer } : {}),
      maxRetries: config.relayer.maxRetries
    },
    governance: {
      broadcastEnabled: config.governance.broadcastEnabled,
      configured: config.governance.broadcastEnabled &&
        governanceContractConfigured &&
        governanceDomainConfigured &&
        governanceSignerConfigured,
      contractConfigured: governanceContractConfigured,
      domainConfigured: governanceDomainConfigured,
      signerConfigured: governanceSignerConfigured,
      ...(governanceSignerAddress ? { signerAddress: governanceSignerAddress } : {}),
      ...(config.governance.signerAddress ? { expectedSignerAddress: config.governance.signerAddress } : {}),
      ...(config.governance.domainOwnerAddress ? { expectedDomainOwnerAddress: config.governance.domainOwnerAddress } : {}),
      allowedOperatorCount: config.governance.allowedOperators.length
    },
    operatorRoles: operatorRoleDiagnostics(config, env),
    storage: {
      driver: config.database.driver,
      durable: config.database.driver !== "memory",
      migrationsAutoRun: config.database.migrationsAutoRun
    },
    evidenceStorage: {
      adapter: config.evidenceStorage.adapter,
      ...(config.evidenceStorage.adapter === "rehearsal-object"
        ? { objectNamespace: config.evidenceStorage.objectNamespace }
        : {}),
      ...(config.evidenceStorage.adapter === "s3"
        ? {
            s3: {
              bucketConfigured: Boolean(config.evidenceStorage.s3Bucket),
              regionConfigured: Boolean(config.evidenceStorage.s3Region),
              endpointConfigured: Boolean(config.evidenceStorage.s3Endpoint),
              prefixConfigured: Boolean(config.evidenceStorage.s3Prefix),
              forcePathStyle: config.evidenceStorage.s3ForcePathStyle ?? false,
              uriMode: config.evidenceStorage.s3UriMode ?? "s3",
              objectNamespaceConfigured: Boolean(config.evidenceStorage.s3ObjectNamespace),
              ...(config.evidenceStorage.s3AccessKeyIdEnv ? { accessKeyIdEnv: config.evidenceStorage.s3AccessKeyIdEnv } : {}),
              ...(config.evidenceStorage.s3SecretAccessKeyEnv ? { secretAccessKeyEnv: config.evidenceStorage.s3SecretAccessKeyEnv } : {}),
              ...(config.evidenceStorage.s3SessionTokenEnv ? { sessionTokenEnv: config.evidenceStorage.s3SessionTokenEnv } : {})
            }
          }
        : {})
    },
    storeAuth: {
      mode: storeAuth.mode,
      jwtConfigured: storeAuthJwtConfigured(config),
      jwksUrlConfigured: Boolean(storeAuth.jwksUrl),
      issuerConfigured: Boolean(storeAuth.issuer),
      audienceConfigured: Boolean(storeAuth.audience),
      roleClaim: storeAuth.roleClaim,
      principalClaim: storeAuth.principalClaim,
      displayNameClaimConfigured: Boolean(storeAuth.displayNameClaim),
      clockToleranceSeconds: storeAuth.clockToleranceSeconds
    },
    product: {
      demoMode,
      e2eControls,
      registrationAdapter: config.productBff.registrationAdapter,
      permissiveAuthorizationRequested
    },
    security: {
      logRedactionEnabled: config.security.logRedactionEnabled
    },
    lastReconcileError: options.lastReconcileError ? redactErrorMessage(options.lastReconcileError) : null
  };
}

function runStaticPreflight(
  config: ChainServicesConfig,
  env: Env,
  checks: ConfigDiagnosticCheck[],
  errors: string[]
): void {
  const stateMachine = stateMachineAddress(config.network.contracts);
  const relayerPrivateKey = env[config.relayer.stateMachinePrivateKeyEnv]?.trim();

  runProductionSafetyPreflight(config, env, checks, errors);
  runTestnetSafetyPreflight(config, env, checks, errors);
  runStagingSafetyPreflight(config, env, checks, errors);
  runStoreAuthPreflight(config, env, checks, errors);
  runNonLocalRoleSafetyPreflight(config, env, checks, errors);

  if (config.relayer.broadcastEnabled) {
    if (!stateMachine) {
      fail(checks, errors, "relayer.contract", "UVPStateMachine contract address is required when relayer broadcast is configured");
    } else {
      pass(checks, "relayer.contract");
    }
    if (!relayerPrivateKey) {
      fail(checks, errors, "relayer.configured", `${config.relayer.stateMachinePrivateKeyEnv} is required when relayer broadcast is enabled`);
    } else if (!/^0x[0-9a-fA-F]{64}$/.test(relayerPrivateKey)) {
      fail(checks, errors, "relayer.private_key", `${config.relayer.stateMachinePrivateKeyEnv} must be a 32-byte private key`);
    } else {
      try {
        const gasPayer = normalizeAddress(privateKeyToAccount(relayerPrivateKey as Hex).address, "relayer gas payer");
        if (gasPayer === zeroAddress) {
          fail(checks, errors, "relayer.gas_payer", "relayer gas payer address must not be zero");
        } else if (config.relayer.expectedGasPayer && gasPayer !== config.relayer.expectedGasPayer) {
          fail(checks, errors, "relayer.gas_payer", "relayer private key does not match configured relayer gas payer address");
        } else {
          pass(checks, "relayer.gas_payer");
        }
      } catch (error) {
        fail(checks, errors, "relayer.gas_payer", redactErrorMessage(error));
      }
    }
  } else {
    if (config.security.environment === "production" || config.security.environment === "testnet") {
      fail(checks, errors, "relayer.configured", `${config.relayer.stateMachinePrivateKeyEnv} is required in ${config.security.environment}`);
    } else {
      skip(checks, "relayer.configured", "relayer private key is not configured");
    }
  }

  runProductRegistrationPreflight(config, env, checks, errors);

  if (config.governance.broadcastEnabled) {
    const trustRegistry = trustRegistryAddress(config.network.contracts);
    if (!trustRegistry) {
      fail(checks, errors, "governance.contract", "ZhixuTrustRegistry contract address is required when governance broadcast is enabled");
    } else {
      pass(checks, "governance.contract");
    }
    if (!config.governance.domainId) {
      fail(checks, errors, "governance.domain", "GOVERNANCE_DOMAIN_ID is required when governance broadcast is enabled");
    } else {
      pass(checks, "governance.domain");
    }
    if (!config.governance.signerPrivateKey) {
      fail(checks, errors, "governance.signer", "GOVERNANCE_SIGNER_PRIVATE_KEY is required when governance broadcast is enabled");
    } else {
      const signer = privateKeyAddress(config.governance.signerPrivateKey, "governance signer");
      if (config.governance.signerAddress && signer && signer !== config.governance.signerAddress) {
        fail(checks, errors, "governance.signer", "GOVERNANCE_SIGNER_PRIVATE_KEY does not match GOVERNANCE_SIGNER_ADDRESS");
      } else {
        pass(checks, "governance.signer");
      }
    }
  } else {
    skip(checks, "governance.configured", "governance broadcast is disabled");
  }
}

function runStoreAuthPreflight(
  config: ChainServicesConfig,
  env: Env,
  checks: ConfigDiagnosticCheck[],
  errors: string[]
): void {
  const envMode = env.STORE_AUTH_MODE?.trim();
  const mode = envMode === "dev_headers" || envMode === "jwt" ? envMode : effectiveStoreAuthConfig(config).mode;
  const strictRuntime = config.security.environment === "staging" || config.security.environment === "production";

  if (strictRuntime && mode !== "jwt") {
    fail(checks, errors, "store_auth.mode", "STORE_AUTH_MODE=jwt is required in staging and production");
  } else if (mode === "jwt") {
    pass(checks, "store_auth.mode");
  } else {
    pass(checks, "store_auth.dev_headers");
  }

  if (mode !== "jwt") {
    return;
  }

  if (storeAuthJwtConfigured(config)) {
    pass(checks, "store_auth.jwt_configured");
  } else {
    fail(checks, errors, "store_auth.jwt_configured", "STORE_AUTH_JWKS_URL, STORE_AUTH_ISSUER, and STORE_AUTH_AUDIENCE are required when STORE_AUTH_MODE=jwt");
  }
}

function storeAuthJwtConfigured(config: ChainServicesConfig): boolean {
  const storeAuth = effectiveStoreAuthConfig(config);
  return Boolean(
    storeAuth.jwksUrl &&
    storeAuth.issuer &&
    storeAuth.audience &&
    storeAuth.roleClaim &&
    storeAuth.principalClaim
  );
}

function effectiveStoreAuthConfig(config: ChainServicesConfig): NonNullable<ChainServicesConfig["storeAuth"]> {
  return config.storeAuth ?? {
    mode: "dev_headers",
    roleClaim: "roles",
    principalClaim: "sub",
    displayNameClaim: "name",
    clockToleranceSeconds: 60
  };
}

function runProductionSafetyPreflight(
  config: ChainServicesConfig,
  env: Env,
  checks: ConfigDiagnosticCheck[],
  errors: string[]
): void {
  if (config.security.environment !== "production") {
    return;
  }

  const stateMachine = stateMachineAddress(config.network.contracts);
  const trustRegistry = trustRegistryAddress(config.network.contracts);

  if (config.security.preflightStrict) {
    pass(checks, "security.preflight_strict");
  } else {
    fail(checks, errors, "security.preflight_strict", "SECURITY_PREFLIGHT_STRICT=false is forbidden in production");
  }

  if (config.security.logRedactionEnabled) {
    pass(checks, "security.log_redaction");
  } else {
    fail(checks, errors, "security.log_redaction", "LOG_REDACTION_ENABLED=false is forbidden in production");
  }

  if (config.database.driver === "postgres") {
    pass(checks, "storage.driver");
  } else {
    fail(checks, errors, "storage.driver", "CHAIN_SERVICES_DATABASE_DRIVER=postgres is required in production");
  }
  requireDurableStoreMetadata(config, checks, errors, "production");
  if (config.database.migrationsAutoRun && env.UVP_PRODUCTION_ALLOW_AUTO_MIGRATIONS?.trim() !== "1") {
    fail(checks, errors, "storage.migrations_auto_run", "CHAIN_SERVICES_MIGRATIONS_AUTO_RUN=true is forbidden in production without UVP_PRODUCTION_ALLOW_AUTO_MIGRATIONS=1");
  } else {
    pass(checks, "storage.migrations_auto_run");
  }

  if (config.productBff.registrationAdapter === "memory") {
    fail(checks, errors, "product.registration_adapter", "UVP_PRODUCT_BFF_REGISTRATION_ADAPTER=memory is forbidden in production");
  } else {
    pass(checks, "product.registration_adapter");
  }

  if (enabledEnv(env, "UVP_PRODUCT_DEMO_MODE")) {
    fail(checks, errors, "product.demo_mode", "UVP_PRODUCT_DEMO_MODE=1 is forbidden in production");
  } else {
    pass(checks, "product.demo_mode");
  }

  if (enabledEnv(env, "UVP_PRODUCT_E2E_FIXTURES")) {
    fail(checks, errors, "product.e2e_controls", "UVP_PRODUCT_E2E_FIXTURES=1 is forbidden in production");
  } else {
    pass(checks, "product.e2e_controls");
  }

  if (enabledEnv(env, "UVP_PRODUCT_PERMISSIVE_AUTH") || isPermissiveAuthorizationRequested(env)) {
    fail(checks, errors, "product.permissive_authorization", "permissive Product submission authorization is forbidden in production");
  } else {
    pass(checks, "product.permissive_authorization");
  }

  for (const envName of privateKeyEnvNames(config)) {
    const privateKey = env[envName]?.trim().toLowerCase();
    if (privateKey && ANVIL_DEFAULT_PRIVATE_KEYS.has(privateKey)) {
      fail(checks, errors, `private_key.${envName}`, `${envName} must not use an Anvil default private key in production`);
    }
  }

  if (stateMachine) {
    pass(checks, "contracts.state_machine");
  } else {
    fail(checks, errors, "contracts.state_machine", "UVPStateMachine contract address is required in production");
  }

  if (trustRegistry) {
    pass(checks, "contracts.trust_registry");
  } else {
    fail(checks, errors, "contracts.trust_registry", "ZhixuTrustRegistry contract address is required in production");
  }
}

function requireDurableStoreMetadata(
  config: ChainServicesConfig,
  checks: ConfigDiagnosticCheck[],
  errors: string[],
  environment: "production" | "testnet" | "staging"
): void {
  if (config.database.driver === "postgres") {
    pass(checks, "store_metadata.durable");
    return;
  }
  fail(
    checks,
    errors,
    "store_metadata.durable",
    `Store metadata stores must use durable Postgres storage in ${environment}`
  );
}

function runTestnetSafetyPreflight(
  config: ChainServicesConfig,
  env: Env,
  checks: ConfigDiagnosticCheck[],
  errors: string[]
): void {
  if (config.security.environment !== "testnet") {
    return;
  }

  const stateMachine = stateMachineAddress(config.network.contracts);
  const trustRegistry = trustRegistryAddress(config.network.contracts);

  if (config.security.preflightStrict) {
    pass(checks, "security.preflight_strict");
  } else {
    fail(checks, errors, "security.preflight_strict", "SECURITY_PREFLIGHT_STRICT=false is forbidden in testnet");
  }

  if (config.security.logRedactionEnabled) {
    pass(checks, "security.log_redaction");
  } else {
    fail(checks, errors, "security.log_redaction", "LOG_REDACTION_ENABLED=false is forbidden in testnet");
  }

  if (config.database.driver === "postgres") {
    pass(checks, "storage.driver");
  } else {
    fail(checks, errors, "storage.driver", "CHAIN_SERVICES_DATABASE_DRIVER=postgres is required in testnet");
  }
  requireDurableStoreMetadata(config, checks, errors, "testnet");

  if (config.network.chainId === 84532) {
    pass(checks, "network.chain_id_configured");
  } else {
    fail(checks, errors, "network.chain_id_configured", "UVP_CHAIN_ID=84532 is required in testnet");
  }

  if (isNonLocalRpcUrl(config.network.rpcUrl)) {
    pass(checks, "network.rpc_url_configured");
  } else {
    fail(checks, errors, "network.rpc_url_configured", "UVP_RPC_URL must point to a non-local Base Sepolia RPC in testnet");
  }

  if (stateMachine) {
    pass(checks, "contracts.state_machine");
  } else {
    fail(checks, errors, "contracts.state_machine", "UVPStateMachine contract address is required in testnet");
  }

  if (trustRegistry) {
    pass(checks, "contracts.trust_registry");
  } else {
    fail(checks, errors, "contracts.trust_registry", "ZhixuTrustRegistry contract address is required in testnet");
  }

  if (config.productBff.registrationAdapter === "memory") {
    fail(checks, errors, "product.registration_adapter", "UVP_PRODUCT_BFF_REGISTRATION_ADAPTER=memory is forbidden in testnet");
  } else {
    pass(checks, "product.registration_adapter");
  }

  if (config.relayer.broadcastEnabled) {
    pass(checks, "relayer.broadcast_enabled");
  } else {
    fail(checks, errors, "relayer.broadcast_enabled", "UVP_STATE_MACHINE_RELAYER_BROADCAST_ENABLED=false is forbidden in testnet");
  }

  if (config.evidenceStorage.adapter === "rehearsal-object") {
    pass(checks, "evidence.storage_adapter");
  } else {
    fail(checks, errors, "evidence.storage_adapter", "UVP_EVIDENCE_STORAGE_ADAPTER=rehearsal-object is required in testnet");
  }

  if (enabledEnv(env, "UVP_PRODUCT_DEMO_MODE")) {
    fail(checks, errors, "product.demo_mode", "UVP_PRODUCT_DEMO_MODE=1 is forbidden in testnet");
  } else {
    pass(checks, "product.demo_mode");
  }

  if (enabledEnv(env, "UVP_PRODUCT_E2E_FIXTURES")) {
    fail(checks, errors, "product.e2e_controls", "UVP_PRODUCT_E2E_FIXTURES=1 is forbidden in testnet");
  } else {
    pass(checks, "product.e2e_controls");
  }

  if (enabledEnv(env, "UVP_PRODUCT_PERMISSIVE_AUTH") || isPermissiveAuthorizationRequested(env)) {
    fail(checks, errors, "product.permissive_authorization", "permissive Product submission authorization is forbidden in testnet");
  } else {
    pass(checks, "product.permissive_authorization");
  }

  for (const envName of privateKeyEnvNames(config)) {
    const privateKey = env[envName]?.trim().toLowerCase();
    if (privateKey && ANVIL_DEFAULT_PRIVATE_KEYS.has(privateKey)) {
      fail(checks, errors, `private_key.${envName}`, `${envName} must not use an Anvil default private key in testnet`);
    }
  }

  if (config.governance.broadcastEnabled && config.governance.chainId !== 84532) {
    fail(checks, errors, "governance.chain_id_configured", "GOVERNANCE_CHAIN_ID=84532 is required in testnet when governance broadcast is enabled");
  }
}

function runStagingSafetyPreflight(
  config: ChainServicesConfig,
  env: Env,
  checks: ConfigDiagnosticCheck[],
  errors: string[]
): void {
  if (config.security.environment !== "staging") {
    return;
  }

  const stateMachine = stateMachineAddress(config.network.contracts);
  const trustRegistry = trustRegistryAddress(config.network.contracts);

  if (config.security.preflightStrict) {
    pass(checks, "security.preflight_strict");
  } else {
    fail(checks, errors, "security.preflight_strict", "SECURITY_PREFLIGHT_STRICT=false is forbidden in staging");
  }

  if (config.security.logRedactionEnabled) {
    pass(checks, "security.log_redaction");
  } else {
    fail(checks, errors, "security.log_redaction", "LOG_REDACTION_ENABLED=false is forbidden in staging");
  }

  if (config.database.driver === "postgres") {
    pass(checks, "storage.driver");
  } else {
    fail(checks, errors, "storage.driver", "CHAIN_SERVICES_DATABASE_DRIVER=postgres is required in staging");
  }
  requireDurableStoreMetadata(config, checks, errors, "staging");
  if (config.database.migrationsAutoRun && env.UVP_STAGING_ALLOW_AUTO_MIGRATIONS?.trim() !== "1") {
    fail(checks, errors, "storage.migrations_auto_run", "CHAIN_SERVICES_MIGRATIONS_AUTO_RUN=true is forbidden in staging without UVP_STAGING_ALLOW_AUTO_MIGRATIONS=1");
  } else {
    pass(checks, "storage.migrations_auto_run");
  }

  if (config.network.chainId === 84532) {
    pass(checks, "network.chain_id_configured");
  } else {
    fail(checks, errors, "network.chain_id_configured", "UVP_CHAIN_ID=84532 is required in staging");
  }
  if (isNonLocalRpcUrl(config.network.rpcUrl)) {
    pass(checks, "network.rpc_url_configured");
  } else {
    fail(checks, errors, "network.rpc_url_configured", "UVP_RPC_URL must point to a non-local Base Sepolia or staging RPC in staging");
  }
  if (config.network.finalityConfirmations > 0) {
    pass(checks, "network.finality_confirmations");
  } else {
    fail(checks, errors, "network.finality_confirmations", "UVP_FINALITY_CONFIRMATIONS must be positive in staging");
  }
  if (config.network.reorgBufferBlocks > 0) {
    pass(checks, "network.reorg_buffer_blocks");
  } else {
    fail(checks, errors, "network.reorg_buffer_blocks", "UVP_REORG_BUFFER_BLOCKS must be positive in staging");
  }
  if (stateMachine) {
    pass(checks, "contracts.state_machine");
  } else {
    fail(checks, errors, "contracts.state_machine", "UVPStateMachine contract address is required in staging");
  }
  if (trustRegistry) {
    pass(checks, "contracts.trust_registry");
  } else {
    fail(checks, errors, "contracts.trust_registry", "ZhixuTrustRegistry contract address is required in staging");
  }

  if (config.productBff.registrationAdapter === "anvil") {
    pass(checks, "product.registration_adapter");
  } else {
    fail(checks, errors, "product.registration_adapter", "UVP_PRODUCT_BFF_REGISTRATION_ADAPTER=anvil is required in staging");
  }
  if (config.productBff.waitForReceipt) {
    pass(checks, "product.registration_receipt");
  } else {
    fail(checks, errors, "product.registration_receipt", "UVP_PRODUCT_BFF_WAIT_FOR_RECEIPT=true is required in staging");
  }
  if (config.relayer.broadcastEnabled) {
    pass(checks, "relayer.broadcast_enabled");
  } else {
    fail(checks, errors, "relayer.broadcast_enabled", "UVP_STATE_MACHINE_RELAYER_BROADCAST_ENABLED=true is required in staging");
  }
  if (config.evidenceStorage.adapter === "s3") {
    pass(checks, "evidence.storage_adapter");
  } else {
    fail(checks, errors, "evidence.storage_adapter", "UVP_EVIDENCE_STORAGE_ADAPTER=s3 is required in staging");
  }
  if (config.evidenceStorage.s3Bucket && config.evidenceStorage.s3Region) {
    pass(checks, "evidence.s3_location");
  } else {
    fail(checks, errors, "evidence.s3_location", "UVP_EVIDENCE_S3_BUCKET and UVP_EVIDENCE_S3_REGION are required in staging");
  }
  if (config.evidenceStorage.s3AccessKeyIdEnv && env[config.evidenceStorage.s3AccessKeyIdEnv]?.trim()) {
    pass(checks, "evidence.s3_access_key");
  } else {
    fail(checks, errors, "evidence.s3_access_key", `${config.evidenceStorage.s3AccessKeyIdEnv ?? "UVP_EVIDENCE_S3_ACCESS_KEY_ID_ENV"} is required in staging`);
  }
  if (config.evidenceStorage.s3SecretAccessKeyEnv && env[config.evidenceStorage.s3SecretAccessKeyEnv]?.trim()) {
    pass(checks, "evidence.s3_secret_key");
  } else {
    fail(checks, errors, "evidence.s3_secret_key", `${config.evidenceStorage.s3SecretAccessKeyEnv ?? "UVP_EVIDENCE_S3_SECRET_ACCESS_KEY_ENV"} is required in staging`);
  }
  if (config.evidenceStorage.s3UriMode === "object" && !config.evidenceStorage.s3ObjectNamespace) {
    fail(checks, errors, "evidence.s3_object_namespace", "UVP_EVIDENCE_S3_OBJECT_NAMESPACE is required when UVP_EVIDENCE_S3_URI_MODE=object in staging");
  } else {
    pass(checks, "evidence.s3_object_namespace");
  }

  if (enabledEnv(env, "UVP_PRODUCT_DEMO_MODE")) {
    fail(checks, errors, "product.demo_mode", "UVP_PRODUCT_DEMO_MODE=1 is forbidden in staging");
  } else {
    pass(checks, "product.demo_mode");
  }
  if (enabledEnv(env, "UVP_PRODUCT_E2E_FIXTURES")) {
    fail(checks, errors, "product.e2e_controls", "UVP_PRODUCT_E2E_FIXTURES=1 is forbidden in staging");
  } else {
    pass(checks, "product.e2e_controls");
  }
  if (enabledEnv(env, "UVP_PRODUCT_PERMISSIVE_AUTH") || isPermissiveAuthorizationRequested(env)) {
    fail(checks, errors, "product.permissive_authorization", "permissive Product submission authorization is forbidden in staging");
  } else {
    pass(checks, "product.permissive_authorization");
  }

  runStagingRolePreflight(config, env, checks, errors);
}

function runNonLocalRoleSafetyPreflight(
  config: ChainServicesConfig,
  env: Env,
  checks: ConfigDiagnosticCheck[],
  errors: string[]
): void {
  if (config.security.environment === "local" || config.security.environment === "production" || config.security.environment === "testnet" || config.security.environment === "staging") {
    return;
  }

  if (config.security.logRedactionEnabled) {
    pass(checks, "security.log_redaction");
  } else {
    fail(checks, errors, "security.log_redaction", "LOG_REDACTION_ENABLED=false is forbidden outside local mode");
  }

  for (const envName of privateKeyEnvNames(config)) {
    const privateKey = env[envName]?.trim().toLowerCase();
    if (privateKey && ANVIL_DEFAULT_PRIVATE_KEYS.has(privateKey)) {
      fail(checks, errors, `private_key.${envName}`, `${envName} must not use an Anvil default private key outside local mode`);
    }
  }
}

function runStagingRolePreflight(
  config: ChainServicesConfig,
  env: Env,
  checks: ConfigDiagnosticCheck[],
  errors: string[]
): void {
  checkPrivateKeyRole({
    checks,
    errors,
    name: "operator.deployer",
    envName: config.operatorRoles.deployerPrivateKeyEnv,
    privateKey: env[config.operatorRoles.deployerPrivateKeyEnv],
    expectedAddress: config.operatorRoles.deployerAddress,
    missingMessage: `${config.operatorRoles.deployerPrivateKeyEnv} is required in staging`,
    mismatchMessage: `${config.operatorRoles.deployerPrivateKeyEnv} does not match UVP_ETH_DEPLOYER_ADDRESS`
  });

  if (config.operatorRoles.stateMachineOwnerAddress) {
    pass(checks, "operator.state_machine_owner");
  } else {
    fail(checks, errors, "operator.state_machine_owner", "UVP_STATE_MACHINE_OWNER_ADDRESS is required in staging");
  }
  if (config.operatorRoles.planPublisherAddress) {
    pass(checks, "operator.plan_publisher");
  } else {
    fail(checks, errors, "operator.plan_publisher", "UVP_PLAN_PUBLISHER_ADDRESS is required in staging");
  }
  if (config.productBff.registrarAddress) {
    pass(checks, "operator.order_registrar");
  } else {
    fail(checks, errors, "operator.order_registrar", "UVP_ORDER_REGISTRAR_ADDRESS is required in staging");
  }
  if (config.relayer.expectedGasPayer) {
    pass(checks, "operator.relayer_gas_payer");
  } else {
    fail(checks, errors, "operator.relayer_gas_payer", "UVP_RELAYER_GAS_PAYER_ADDRESS is required in staging");
  }
  if (config.operatorRoles.participantWallets.length > 0) {
    pass(checks, "operator.participant_wallets");
  } else {
    fail(checks, errors, "operator.participant_wallets", "UVP_REHEARSAL_PARTICIPANT_WALLETS is required in staging");
  }
  for (const participantWallet of config.operatorRoles.participantWallets) {
    if (ANVIL_DEFAULT_ADDRESSES.has(participantWallet)) {
      fail(checks, errors, "operator.participant_wallets", "UVP_REHEARSAL_PARTICIPANT_WALLETS must not include Anvil default wallet addresses in staging");
      break;
    }
  }

  checkPrivateKeyRole({
    checks,
    errors,
    name: "operator.governance_signer",
    envName: "GOVERNANCE_SIGNER_PRIVATE_KEY",
    privateKey: config.governance.signerPrivateKey,
    expectedAddress: config.governance.signerAddress,
    missingMessage: "GOVERNANCE_SIGNER_PRIVATE_KEY is required in staging",
    mismatchMessage: "GOVERNANCE_SIGNER_PRIVATE_KEY does not match GOVERNANCE_SIGNER_ADDRESS"
  });
  if (config.governance.domainId) {
    pass(checks, "operator.governance_domain");
  } else {
    fail(checks, errors, "operator.governance_domain", "GOVERNANCE_DOMAIN_ID is required in staging");
  }
  if (config.governance.domainOwnerAddress) {
    pass(checks, "operator.governance_domain_owner");
  } else {
    fail(checks, errors, "operator.governance_domain_owner", "GOVERNANCE_DOMAIN_OWNER_ADDRESS is required in staging");
  }
  if (config.operatorRoles.adminReviewers.length > 0) {
    pass(checks, "operator.governance_admin_reviewer");
  } else {
    fail(checks, errors, "operator.governance_admin_reviewer", "GOVERNANCE_ADMIN_REVIEWER_IDS is required in staging");
  }
  if ((config.operatorRoles.opsConsoleAdmins ?? []).length > 0) {
    pass(checks, "operator.ops_console_admin");
  } else {
    fail(checks, errors, "operator.ops_console_admin", "OPS_CONSOLE_ADMIN_IDS is required in staging");
  }
}

function checkPrivateKeyRole(input: {
  readonly checks: ConfigDiagnosticCheck[];
  readonly errors: string[];
  readonly name: string;
  readonly envName: string;
  readonly privateKey: string | undefined;
  readonly expectedAddress: Address | undefined;
  readonly missingMessage: string;
  readonly mismatchMessage: string;
}): void {
  const privateKey = input.privateKey?.trim();
  if (!privateKey) {
    fail(input.checks, input.errors, input.name, input.missingMessage);
    return;
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    fail(input.checks, input.errors, input.name, `${input.envName} must be a 32-byte private key`);
    return;
  }
  if (ANVIL_DEFAULT_PRIVATE_KEYS.has(privateKey.toLowerCase())) {
    fail(input.checks, input.errors, input.name, `${input.envName} must not use an Anvil default private key in staging`);
    return;
  }
  const address = privateKeyAddress(privateKey, input.envName);
  if (!address) {
    fail(input.checks, input.errors, input.name, `${input.envName} must derive a valid EVM address`);
    return;
  }
  if (!input.expectedAddress) {
    fail(input.checks, input.errors, input.name, `${input.name} expected address is required in staging`);
    return;
  }
  if (address !== input.expectedAddress) {
    fail(input.checks, input.errors, input.name, input.mismatchMessage);
    return;
  }
  pass(input.checks, input.name);
}

function runProductRegistrationPreflight(
  config: ChainServicesConfig,
  env: Env,
  checks: ConfigDiagnosticCheck[],
  errors: string[]
): void {
  if (config.productBff.registrationAdapter === "memory") {
    skip(checks, "product.registration_configured", "Product BFF registration adapter is memory");
    return;
  }

  const stateMachine = stateMachineAddress(config.network.contracts);
  if (!stateMachine) {
    fail(checks, errors, "product.registration_contract", "UVPStateMachine contract address is required when Product BFF registration adapter is anvil");
  } else {
    pass(checks, "product.registration_contract");
  }

  const privateKey = env[config.productBff.registrarPrivateKeyEnv]?.trim();
  if (!privateKey) {
    fail(checks, errors, "product.registration_private_key", `${config.productBff.registrarPrivateKeyEnv} is required when Product BFF registration adapter is anvil`);
  } else if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    fail(checks, errors, "product.registration_private_key", `${config.productBff.registrarPrivateKeyEnv} must be a 32-byte private key`);
  } else {
    const registrar = privateKeyAddress(privateKey, "order registrar");
    if (config.productBff.registrarAddress && registrar && registrar !== config.productBff.registrarAddress) {
      fail(checks, errors, "product.registration_private_key", `${config.productBff.registrarPrivateKeyEnv} does not match configured order registrar address`);
    } else {
      pass(checks, "product.registration_private_key");
    }
  }
}

async function runRpcPreflight(
  config: ChainServicesConfig,
  clients: RunConfigPreflightOptions["clients"],
  checks: ConfigDiagnosticCheck[],
  errors: string[]
): Promise<void> {
  const networkClient = clients?.network ?? publicClient(config.network.rpcUrl);
  await checkChainId({
    name: "network.chain_id",
    expectedChainId: config.network.chainId,
    client: networkClient,
    checks,
    errors
  });

  await checkContractCode({
    name: "contracts.state_machine_code",
    address: stateMachineAddress(config.network.contracts),
    client: networkClient,
    requireBytecode: config.security.environment === "staging" || config.security.environment === "production",
    checks,
    errors
  });
  await checkContractCode({
    name: "contracts.trust_registry_code",
    address: trustRegistryAddress(config.network.contracts),
    client: networkClient,
    requireBytecode: config.security.environment === "staging" || config.security.environment === "production",
    checks,
    errors
  });

  const shouldCheckGovernanceOwner = config.governance.broadcastEnabled ||
    (config.security.environment === "staging" && Boolean(config.governance.domainId && config.governance.signerPrivateKey));
  if (!shouldCheckGovernanceOwner || !config.governance.domainId || !config.governance.signerPrivateKey) {
    return;
  }

  const trustRegistry = trustRegistryAddress(config.network.contracts);
  if (!trustRegistry) {
    return;
  }

  const governanceClient = clients?.governance ?? publicClient(config.governance.rpcUrl);
  await checkChainId({
    name: "governance.chain_id",
    expectedChainId: config.governance.chainId,
    client: governanceClient,
    checks,
    errors
  });

  if (!governanceClient.readContract) {
    if (config.security.environment === "staging" || config.security.environment === "production") {
      fail(checks, errors, "governance.owner", "governance preflight client must read domain owner in staging and production");
      return;
    }
    skip(checks, "governance.owner", "governance preflight client cannot read domain owner");
    return;
  }

  try {
    const signer = normalizeAddress(privateKeyToAccount(config.governance.signerPrivateKey).address, "governance signer");
    const owner = normalizeAddress(String(await governanceClient.readContract({
      address: trustRegistry as ViemAddress,
      abi: trustRegistryOwnerAbi,
      functionName: "domainOwner",
      args: [config.governance.domainId]
    })), "governance domain owner");
    if (config.governance.domainOwnerAddress && owner !== config.governance.domainOwnerAddress) {
      fail(checks, errors, "governance.owner", "on-chain governance domain owner does not match GOVERNANCE_DOMAIN_OWNER_ADDRESS");
      return;
    }
    const allowedOperators = new Set(config.governance.allowedOperators.map((address) => normalizeAddress(address, "governance allowed operator")));
    if (owner !== signer && !allowedOperators.has(signer)) {
      fail(checks, errors, "governance.owner", "governance signer is not the domain owner or an allowed operator");
      return;
    }
    pass(checks, "governance.owner");
  } catch (error) {
    fail(checks, errors, "governance.owner", redactErrorMessage(error));
  }
}

async function checkChainId(input: {
  readonly name: string;
  readonly expectedChainId: number;
  readonly client: PreflightPublicClient;
  readonly checks: ConfigDiagnosticCheck[];
  readonly errors: string[];
}): Promise<void> {
  try {
    const rpcChainId = await input.client.getChainId();
    if (rpcChainId !== input.expectedChainId) {
      fail(input.checks, input.errors, input.name, `RPC chainId ${rpcChainId} does not match configured chainId ${input.expectedChainId}`);
      return;
    }
    pass(input.checks, input.name);
  } catch (error) {
    fail(input.checks, input.errors, input.name, redactErrorMessage(error));
  }
}

async function checkContractCode(input: {
  readonly name: string;
  readonly address: Address | undefined;
  readonly client: PreflightPublicClient;
  readonly requireBytecode?: boolean;
  readonly checks: ConfigDiagnosticCheck[];
  readonly errors: string[];
}): Promise<void> {
  if (!input.address) {
    skip(input.checks, input.name, "contract address is not configured");
    return;
  }
  if (!input.client.getBytecode) {
    if (input.requireBytecode) {
      fail(input.checks, input.errors, input.name, "preflight client must read contract bytecode");
      return;
    }
    skip(input.checks, input.name, "preflight client cannot read contract bytecode");
    return;
  }

  try {
    const bytecode = await input.client.getBytecode({ address: input.address as ViemAddress });
    if (!bytecode || bytecode === "0x") {
      fail(input.checks, input.errors, input.name, `no contract bytecode found at ${input.address}`);
      return;
    }
    pass(input.checks, input.name);
  } catch (error) {
    fail(input.checks, input.errors, input.name, redactErrorMessage(error));
  }
}

function publicClient(rpcUrl: string): PreflightPublicClient {
  return createPublicClient({ transport: http(rpcUrl) }) as PreflightPublicClient;
}

function stateMachineAddress(contracts: Readonly<Record<string, Address>>): Address | undefined {
  for (const alias of ["UVPStateMachine", "StateMachine", "stateMachine", "uvpStateMachine"]) {
    const address = contracts[alias];
    if (address && address !== zeroAddress) {
      return normalizeAddress(address, `contract ${alias}`);
    }
  }
  return undefined;
}

function trustRegistryAddress(contracts: Readonly<Record<string, Address>>): Address | undefined {
  for (const alias of ["ZhixuTrustRegistry", "TrustRegistry", "trustRegistry", "zhixuTrustRegistry"]) {
    const address = contracts[alias];
    if (address && address !== zeroAddress) {
      return normalizeAddress(address, `contract ${alias}`);
    }
  }
  return undefined;
}

function diagnosticWarnings(
  config: ChainServicesConfig,
  values: {
    readonly relayerConfigured: boolean;
    readonly relayerPrivateKeyConfigured: boolean;
    readonly demoMode: boolean;
    readonly e2eControls: boolean;
    readonly permissiveAuthorizationRequested: boolean;
  }
): readonly string[] {
  const warnings: string[] = [];
  if (config.database.driver === "memory") {
    warnings.push("memory storage is non-durable");
  }
  if (config.productBff.registrationAdapter === "memory") {
    warnings.push("Product BFF registration uses the memory adapter");
  }
  if (values.demoMode) {
    warnings.push("Product demo mode is enabled");
  }
  if (values.e2eControls) {
    warnings.push("Product E2E controls are requested");
  }
  if (values.permissiveAuthorizationRequested) {
    warnings.push("permissive Product authorization is requested");
  }
  if (!values.relayerConfigured && values.relayerPrivateKeyConfigured) {
    warnings.push("relayer private key is configured without a state-machine contract");
  }
  if (!config.security.logRedactionEnabled) {
    warnings.push("log redaction is disabled");
  }
  if (config.governance.allowedOperators.length > 0) {
    warnings.push("GOVERNANCE_ALLOWED_OPERATORS is a rehearsal seam; current contracts still enforce domain-owner authority");
  }
  if (config.governance.broadcastEnabled && config.security.environment !== "testnet" && config.security.environment !== "staging") {
    warnings.push("env-key governance broadcaster is for testnet/staging rehearsal only and is not production governance");
  }
  return warnings;
}

function enabledEnv(env: Env, name: string): boolean {
  const rawValue = env[name]?.trim().toLowerCase();
  return rawValue === "1" || rawValue === "true" || rawValue === "yes";
}

function isPermissiveAuthorizationRequested(env: Env): boolean {
  const rawValue = env.UVP_PRODUCT_SUBMISSION_AUTHORIZATION?.trim().toLowerCase();
  return rawValue === "permissive" || rawValue === "product_projection_demo";
}

function operatorRoleDiagnostics(config: ChainServicesConfig, env: Env): ConfigDiagnostics["operatorRoles"] {
  return {
    deployer: privateKeyRoleDiagnostics(
      config.operatorRoles.deployerPrivateKeyEnv,
      env,
      config.operatorRoles.deployerAddress
    ),
    stateMachineOwner: addressRoleDiagnostics(config.operatorRoles.stateMachineOwnerAddress),
    planPublisher: addressRoleDiagnostics(config.operatorRoles.planPublisherAddress),
    orderRegistrar: privateKeyRoleDiagnostics(
      config.productBff.registrarPrivateKeyEnv,
      env,
      config.productBff.registrarAddress ?? config.operatorRoles.orderRegistrarAddress
    ),
    relayerGasPayer: privateKeyRoleDiagnostics(
      config.relayer.stateMachinePrivateKeyEnv,
      env,
      config.relayer.expectedGasPayer ?? config.operatorRoles.relayerGasPayerAddress
    ),
    participantWallet: {
      configuredCount: config.operatorRoles.participantWallets.length,
      backendBusinessSigning: "forbidden"
    },
    governanceDomainOwner: addressRoleDiagnostics(config.operatorRoles.governanceDomainOwnerAddress ?? config.governance.domainOwnerAddress),
    governanceSigner: privateKeyRoleDiagnostics(
      "GOVERNANCE_SIGNER_PRIVATE_KEY",
      env,
      config.governance.signerAddress ?? config.operatorRoles.governanceSignerAddress
    ),
    governanceAdminReviewer: {
      configuredCount: config.operatorRoles.adminReviewers.length,
      publicTrustAuthority: false
    },
    opsConsoleAdmin: {
      configuredCount: (config.operatorRoles.opsConsoleAdmins ?? []).length
    }
  };
}

function privateKeyRoleDiagnostics(
  privateKeyEnv: string,
  env: Env,
  expectedAddress: Address | undefined
): PrivateKeyRoleDiagnostics {
  const privateKeyConfigured = Boolean(env[privateKeyEnv]?.trim());
  const address = privateKeyAddress(env[privateKeyEnv], privateKeyEnv);
  return {
    privateKeyEnv,
    privateKeyConfigured,
    ...(address ? { address } : {}),
    ...(expectedAddress ? { expectedAddress } : {}),
    ...(address && expectedAddress ? { addressMatches: address === expectedAddress } : {})
  };
}

function addressRoleDiagnostics(address: Address | undefined): AddressRoleDiagnostics {
  return {
    configured: Boolean(address),
    ...(address ? { address } : {})
  };
}

function privateKeyAddress(privateKey: string | undefined, label: string): Address | undefined {
  const trimmed = privateKey?.trim();
  if (!trimmed || !/^0x[0-9a-fA-F]{64}$/.test(trimmed)) {
    return undefined;
  }
  try {
    return normalizeAddress(privateKeyToAccount(trimmed as Hex).address, label);
  } catch {
    return undefined;
  }
}

function privateKeyEnvNames(config: ChainServicesConfig): readonly string[] {
  return [...new Set([
    config.relayer.stateMachinePrivateKeyEnv,
    "GOVERNANCE_SIGNER_PRIVATE_KEY",
    config.productBff.registrarPrivateKeyEnv,
    config.operatorRoles.deployerPrivateKeyEnv
  ])];
}

function isNonLocalRpcUrl(rpcUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rpcUrl);
  } catch {
    return false;
  }

  const hostname = parsed.hostname.toLowerCase();
  return hostname !== "localhost" &&
    hostname !== "127.0.0.1" &&
    hostname !== "0.0.0.0" &&
    hostname !== "::1" &&
    hostname !== "[::1]" &&
    !hostname.endsWith(".local");
}

function pass(checks: ConfigDiagnosticCheck[], name: string): void {
  checks.push({ name, status: "passed" });
}

function fail(checks: ConfigDiagnosticCheck[], errors: string[], name: string, message: string): void {
  const redacted = redactErrorMessage(message);
  checks.push({ name, status: "failed", message: redacted });
  errors.push(redacted);
}

function skip(checks: ConfigDiagnosticCheck[], name: string, message: string): void {
  checks.push({ name, status: "skipped", message });
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
  "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6"
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
  "0xbcd4042de499d14e55001ccbb24a551f3b954096"
]);
