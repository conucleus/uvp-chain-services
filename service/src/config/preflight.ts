import { createPublicClient, http, parseAbi, type Address as ViemAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { listContractJsonOverrides, type ChainServicesConfig } from "./env.js";
import { ConfigError, normalizeAddress, type Address, type Hex } from "@uvp-eth/service-runtime";
import { redactErrorMessage } from "@uvp-eth/service-runtime";
import { ANVIL_DEFAULT_PRIVATE_KEYS } from "./anvil-defaults.js";

type Env = Record<string, string | undefined>;

export type ConfigPreflightStatus = "passed" | "failed" | "skipped";

export interface ConfigDiagnosticCheck {
  readonly name: string;
  readonly status: ConfigPreflightStatus;
  readonly message?: string;
}

export interface ConfigDiagnostics {
  readonly environment: ChainServicesConfig["security"]["environment"];
  readonly storageDriver: string;
  readonly relayerConfigured: boolean;
  readonly network: {
    readonly chainId: number;
    readonly deploymentBlock: string;
    readonly finalityConfirmations: number;
    readonly contracts: Readonly<Record<string, Address>>;
    readonly stateMachineConfigured: boolean;
    readonly identityRegistryConfigured: boolean;
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
  readonly operatorRoles: {
    readonly relayerGasPayer: PrivateKeyRoleDiagnostics;
    readonly opsConsoleAdmin: {
      readonly configuredCount: number;
      readonly adminTokenConfigured: boolean;
    };
  };
  readonly storage: {
    readonly driver: string;
    readonly durable: boolean;
    readonly migrationsAutoRun: boolean;
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
    readonly functionName: string;
    readonly args?: readonly unknown[];
  }): Promise<unknown>;
}

interface PrivateKeyRoleDiagnostics {
  readonly privateKeyEnv: string;
  readonly privateKeyConfigured: boolean;
  readonly address?: Address;
  readonly expectedAddress?: Address;
  readonly addressMatches?: boolean;
}

export interface RunConfigPreflightOptions {
  readonly env?: Env;
  readonly clients?: {
    readonly network?: PreflightPublicClient;
  };
}

const stateMachineModuleAbi = parseAbi([
  "function stagePatchModule() view returns (address)",
  "function derivedSignalModule() view returns (address)",
  "function dockingModule() view returns (address)",
  "function planMetadataModule() view returns (address)",
  "function orderLinkModule() view returns (address)",
  "function lens() view returns (address)"
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
  const identityRegistry = identityRegistryAddress(config.network.contracts);
  const relayerPrivateKeyConfigured = Boolean(env[config.relayer.stateMachinePrivateKeyEnv]?.trim());
  const relayerGasPayer = privateKeyAddress(env[config.relayer.stateMachinePrivateKeyEnv], "relayer gas payer");
  const relayerConfigured = Boolean(config.relayer.broadcastEnabled && stateMachine && relayerPrivateKeyConfigured);
  const preflight = options.preflight ?? {
    status: "skipped" as const,
    checks: []
  };

  return {
    environment: config.security.environment,
    storageDriver: "postgres",
    relayerConfigured,
    network: {
      chainId: config.network.chainId,
      deploymentBlock: config.network.deploymentBlock.toString(),
      finalityConfirmations: config.network.finalityConfirmations,
      contracts: config.network.contracts,
      stateMachineConfigured: Boolean(stateMachine),
      identityRegistryConfigured: Boolean(identityRegistry)
    },
    warnings: [
      ...diagnosticWarnings(config, {
        relayerConfigured,
        relayerPrivateKeyConfigured
      }),
      ...safeListContractJsonOverrides(env).map((name) =>
        `UVP_CONTRACTS_JSON overrides the UVP_ADDRESS_MANIFEST entry for ${name}; the inline JSON address silently wins`
      )
    ],
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
    operatorRoles: operatorRoleDiagnostics(config, env),
    storage: {
      driver: "postgres",
      durable: true,
      migrationsAutoRun: config.database.migrationsAutoRun
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

  runStateMachineModulesManifestPreflight(config, checks, errors);
  runModuleAddressDriftPreflight(config, checks, errors);
  runStateMachineAddressDriftPreflight(config, checks, errors);

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
}

const REQUIRED_STATE_MACHINE_MODULE_KEYS = [
  "stagePatch",
  "derivedSignal",
  "docking",
  "planMetadata",
  "orderLink",
  "lens"
] as const;

function runStateMachineModulesManifestPreflight(
  config: ChainServicesConfig,
  checks: ConfigDiagnosticCheck[],
  errors: string[]
): void {
  const strictRuntime =
    config.security.environment === "production" ||
    config.security.environment === "testnet" ||
    config.security.environment === "staging";
  if (!strictRuntime) {
    skip(checks, "contracts.state_machine_modules_manifest", "module manifest completeness is not required in local mode");
    return;
  }

  const deployments = config.network.stateMachineDeployments ?? [];
  if (deployments.length === 0) {
    fail(
      checks,
      errors,
      "contracts.state_machine_modules_manifest",
      "stateMachineDeployments with modules are required in production/testnet/staging; the flat contract-address form silently drops all module-event projections"
    );
    return;
  }

  if (
    config.network.activeDeploymentId &&
    !deployments.some((deployment) => deployment.deploymentId === config.network.activeDeploymentId)
  ) {
    fail(
      checks,
      errors,
      "contracts.state_machine_modules_manifest",
      `activeDeploymentId ${config.network.activeDeploymentId} does not match any deployment in stateMachineDeployments; refusing to silently fall back to another deployment`
    );
    return;
  }

  if (!config.network.activeDeploymentId) {
    const activeCount = deployments.filter((deployment) => deployment.status === "active").length;
    if (activeCount !== 1) {
      fail(
        checks,
        errors,
        "contracts.state_machine_modules_manifest",
        `stateMachineDeployments must contain exactly one status=active deployment (or an explicit activeDeploymentId) in production/testnet/staging; found ${activeCount}; refusing to silently use the first entry`
      );
      return;
    }
  }

  const active = selectActiveStateMachineDeployment(config);
  if (!active) {
    fail(
      checks,
      errors,
      "contracts.state_machine_modules_manifest",
      "no state-machine deployment could be selected; configure activeDeploymentId or mark one deployment active"
    );
    return;
  }

  const modules = active.modules;
  if (!modules) {
    fail(
      checks,
      errors,
      "contracts.state_machine_modules_manifest",
      `active deployment ${active.deploymentId} is missing the modules manifest; module addresses must be explicit`
    );
    return;
  }

  const missing = REQUIRED_STATE_MACHINE_MODULE_KEYS.filter((key) => !modules[key]);
  if (missing.length > 0) {
    fail(
      checks,
      errors,
      "contracts.state_machine_modules_manifest",
      `active deployment ${active.deploymentId} is missing required modules: ${missing.join(", ")}`
    );
    return;
  }
  pass(checks, "contracts.state_machine_modules_manifest");
}

const FLAT_CONTRACT_BY_MODULE_KEY = {
  stagePatch: "UVPStagePatchModule",
  derivedSignal: "UVPDerivedSignalModule",
  docking: "UVPDockingModule",
  planMetadata: "UVPPlanMetadataModule",
  orderLink: "UVPOrderLinkModule"
} as const;

type ModuleManifestKey = keyof typeof FLAT_CONTRACT_BY_MODULE_KEY;

function runModuleAddressDriftPreflight(
  config: ChainServicesConfig,
  checks: ConfigDiagnosticCheck[],
  errors: string[]
): void {
  const deployments = config.network.stateMachineDeployments ?? [];
  if (deployments.length === 0) {
    skip(checks, "contracts.module_address_consistency", "no nested deployment module manifest configured");
    return;
  }
  const drifts: string[] = [];
  for (const [moduleKey, contractName] of Object.entries(FLAT_CONTRACT_BY_MODULE_KEY) as readonly [ModuleManifestKey, string][]) {
    const flat = config.network.contracts[contractName];
    if (!flat) {
      continue;
    }
    for (const deployment of deployments) {
      const nested = deployment.modules?.[moduleKey];
      if (nested && nested.toLowerCase() !== flat.toLowerCase()) {
        drifts.push(`${contractName}=${flat} conflicts with deployment ${deployment.deploymentId} modules.${moduleKey}=${nested}`);
      }
    }
  }
  if (drifts.length > 0) {
    fail(
      checks,
      errors,
      "contracts.module_address_consistency",
      `flat module contract addresses diverge from deployment module manifests: ${drifts.join("; ")}`
    );
    return;
  }
  pass(checks, "contracts.module_address_consistency");
}

function runStateMachineAddressDriftPreflight(
  config: ChainServicesConfig,
  checks: ConfigDiagnosticCheck[],
  errors: string[]
): void {
  const deployments = config.network.stateMachineDeployments ?? [];
  if (deployments.length === 0) {
    skip(checks, "contracts.state_machine_address_consistency", "no nested state-machine deployments configured");
    return;
  }
  const flat = stateMachineAddress(config.network.contracts);
  if (!flat) {
    skip(checks, "contracts.state_machine_address_consistency", "flat UVPStateMachine contract address is not configured");
    return;
  }
  const active = selectActiveStateMachineDeployment(config);
  if (!active) {
    skip(checks, "contracts.state_machine_address_consistency", "no active state-machine deployment could be selected");
    return;
  }
  if (active.stateMachineAddress.toLowerCase() !== flat.toLowerCase()) {
    fail(
      checks,
      errors,
      "contracts.state_machine_address_consistency",
      `contracts.UVPStateMachine=${flat} does not match active deployment ${active.deploymentId} stateMachineAddress=${active.stateMachineAddress}`
    );
    return;
  }
  pass(checks, "contracts.state_machine_address_consistency");
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
    name: "contracts.identity_registry_code",
    address: identityRegistryAddress(config.network.contracts),
    client: networkClient,
    requireBytecode: config.security.environment === "staging" || config.security.environment === "production",
    checks,
    errors
  });
  await checkStateMachineModules({
    config,
    client: networkClient,
    checks,
    errors
  });
}

async function checkStateMachineModules(input: {
  readonly config: ChainServicesConfig;
  readonly client: PreflightPublicClient;
  readonly checks: ConfigDiagnosticCheck[];
  readonly errors: string[];
}): Promise<void> {
  const deployment = selectActiveStateMachineDeployment(input.config);
  if (!deployment?.modules) {
    skip(input.checks, "contracts.state_machine_modules", "no state-machine module manifest entries configured");
    return;
  }
  if (!input.client.readContract) {
    if (input.config.security.environment === "staging" || input.config.security.environment === "production") {
      fail(input.checks, input.errors, "contracts.state_machine_modules", "preflight client must read state-machine module getters in staging and production");
      return;
    }
    skip(input.checks, "contracts.state_machine_modules", "preflight client cannot read state-machine module getters");
    return;
  }

  const getterByKey = {
    stagePatch: "stagePatchModule",
    derivedSignal: "derivedSignalModule",
    docking: "dockingModule",
    planMetadata: "planMetadataModule",
    orderLink: "orderLinkModule",
    lens: "lens"
  } as const;

  try {
    for (const key of Object.keys(getterByKey) as Array<keyof typeof getterByKey>) {
      const expected = deployment.modules[key];
      if (!expected) {
        fail(
          input.checks,
          input.errors,
          "contracts.state_machine_modules",
          `state-machine module manifest is missing ${key} (${getterByKey[key]}); module addresses must be explicit`
        );
        return;
      }
      const actual = normalizeAddress(String(await input.client.readContract({
        address: deployment.stateMachineAddress as ViemAddress,
        abi: stateMachineModuleAbi,
        functionName: getterByKey[key]
      })), `state-machine ${getterByKey[key]}`);
      if (actual !== expected) {
        fail(
          input.checks,
          input.errors,
          "contracts.state_machine_modules",
          `manifest module ${key} does not match on-chain ${getterByKey[key]}`
        );
        return;
      }
    }
    pass(input.checks, "contracts.state_machine_modules");
  } catch (error) {
    fail(input.checks, input.errors, "contracts.state_machine_modules", redactErrorMessage(error));
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
  const address = contracts.UVPStateMachine;
  return address && address !== zeroAddress
    ? normalizeAddress(address, "contract UVPStateMachine")
    : undefined;
}

export function selectActiveStateMachineDeployment(
  config: ChainServicesConfig
): NonNullable<ChainServicesConfig["network"]["stateMachineDeployments"]>[number] | undefined {
  const deployments = config.network.stateMachineDeployments ?? [];
  if (config.network.activeDeploymentId) {
    const active = deployments.find((deployment) => deployment.deploymentId === config.network.activeDeploymentId);
    if (active) {
      return active;
    }
  }
  return deployments.find((deployment) => deployment.status === "active") ?? deployments[0];
}

function identityRegistryAddress(contracts: Readonly<Record<string, Address>>): Address | undefined {
  const address = contracts.UVPIdentityRegistry;
  return address && address !== zeroAddress
    ? normalizeAddress(address, "contract UVPIdentityRegistry")
    : undefined;
}

function diagnosticWarnings(
  config: ChainServicesConfig,
  values: {
    readonly relayerConfigured: boolean;
    readonly relayerPrivateKeyConfigured: boolean;
  }
): readonly string[] {
  const warnings: string[] = [];
  if (!values.relayerConfigured && values.relayerPrivateKeyConfigured) {
    warnings.push("relayer private key is configured without a state-machine contract");
  }
  if (!config.security.logRedactionEnabled) {
    warnings.push("log redaction is disabled");
  }
  return warnings;
}

function safeListContractJsonOverrides(env: Env): readonly string[] {
  try {
    return listContractJsonOverrides(env);
  } catch {
    return [];
  }
}

function operatorRoleDiagnostics(config: ChainServicesConfig, env: Env): ConfigDiagnostics["operatorRoles"] {
  return {
    relayerGasPayer: privateKeyRoleDiagnostics(
      config.relayer.stateMachinePrivateKeyEnv,
      env,
      config.relayer.expectedGasPayer ?? config.operatorRoles.relayerGasPayerAddress
    ),
    opsConsoleAdmin: {
      configuredCount: (config.operatorRoles.opsConsoleAdmins ?? []).length,
      adminTokenConfigured: (config.operatorRoles.adminTokenHashes ?? []).length > 0
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

function pass(checks: ConfigDiagnosticCheck[], name: string): void {
  checks.push({ name, status: "passed" });
}

function fail(checks: ConfigDiagnosticCheck[], errors: string[], name: string, message: string): void {
  errors.push(message);
  checks.push({ name, status: "failed", message });
}

function skip(checks: ConfigDiagnosticCheck[], name: string, message: string): void {
  checks.push({ name, status: "skipped", message });
}
