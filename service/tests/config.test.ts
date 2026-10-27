import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadConfigFromEnv as loadRawConfigFromEnv,
  runConfigPreflight
} from "../src/config/index.js";
import type { PreflightPublicClient } from "../src/config/preflight.js";

const MANDATORY_ENV = {
  CHAIN_SERVICES_RUNTIME_ENV: "local",
  CHAIN_SERVICES_DATABASE_URL: "postgres://uvp:uvp@127.0.0.1:5432/uvp_chain_services"
} as const;

function loadConfigFromEnv(env: Record<string, string | undefined> = {}): ReturnType<typeof loadRawConfigFromEnv> {
  return loadRawConfigFromEnv({ ...MANDATORY_ENV, ...env });
}

const stateMachine = "0x1111111111111111111111111111111111111111";
const identityRegistry = "0x2222222222222222222222222222222222222222";
const adminTokenHash = "f7a03f48c0e2aa2d5e55ca186c20032ddbf53b7f5f93fce387d65c3f83433e8d";

const profileEnv = {
  OPS_CONSOLE_ADMIN_IDS: "ops-admin-1",
  CHAIN_SERVICES_ADMIN_TOKEN_HASHES: adminTokenHash,
  UVP_CONTRACTS_JSON: JSON.stringify({
    UVPStateMachine: stateMachine,
    UVPIdentityRegistry: identityRegistry
  })
} as const;

describe("chain-services config", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("defaults chain target to EVM and accepts Solana as a reserved target", () => {
    expect(loadConfigFromEnv({}).network.chainTarget).toBe("evm");
    expect(loadConfigFromEnv({ UVP_CHAIN_TARGET: "solana" }).network.chainTarget).toBe("solana");
    expect(() => loadConfigFromEnv({ UVP_CHAIN_TARGET: "cosmos" })).toThrow(/UVP_CHAIN_TARGET must be evm or solana/);
  });

  it("loads supported contract addresses and replay block from an address manifest", () => {
    const dir = mkdtempSync(join(tmpdir(), "uvp-chain-services-"));
    tempDirs.push(dir);
    const manifestPath = join(dir, "addresses.json");
    writeFileSync(manifestPath, JSON.stringify({
      schemaVersion: "uvp-eth.addresses.v1",
      network: {
        chainId: 31337,
        rpcUrlEnv: "ANVIL_RPC_URL"
      },
      deployment: {
        blockNumber: 11
      },
      contracts: {
        UVPStateMachine: {
          address: stateMachine,
          deployment: { blockNumber: 20 }
        },
        UVPIdentityRegistry: {
          address: identityRegistry,
          deployment: { blockNumber: 12 }
        }
      }
    }));

    const config = loadConfigFromEnv({
      UVP_ADDRESS_MANIFEST: manifestPath,
      ANVIL_RPC_URL: "http://127.0.0.1:18545",
      UVP_CONTRACTS_JSON: JSON.stringify({
        UVPIdentityRegistry: "0x3333333333333333333333333333333333333333"
      })
    });

    expect(config.network.chainId).toBe(31337);
    expect(config.network.rpcUrl).toBe("http://127.0.0.1:18545");
    expect(config.network.deploymentBlock).toBe(11n);
    expect(config.network.contracts.UVPStateMachine).toBe(stateMachine);
    expect(config.network.contracts.UVPIdentityRegistry).toBe("0x3333333333333333333333333333333333333333");
  });

  it("loads v1 deployment registry manifests with modules", () => {
    const dir = mkdtempSync(join(tmpdir(), "uvp-chain-services-"));
    tempDirs.push(dir);
    const manifestPath = join(dir, "addresses.v1.json");
    const deploymentId = `0x${"01".repeat(32)}`;
    writeFileSync(manifestPath, JSON.stringify({
      schemaVersion: "uvp-eth.addresses.v1",
      activeDeploymentId: deploymentId,
      stateMachineDeployments: [
        {
          deploymentId,
          stateMachineAddress: stateMachine,
          modules: {
            stagePatch: "0x4444444444444444444444444444444444444444",
            derivedSignal: "0x5555555555555555555555555555555555555555",
            docking: "0x6666666666666666666666666666666666666666",
            planMetadata: "0x8888888888888888888888888888888888888888",
            orderLink: "0x9999999999999999999999999999999999999999",
            lens: "0x7777777777777777777777777777777777777777"
          },
          status: "active",
          deploymentBlock: "20"
        }
      ],
      contracts: {
        UVPDeploymentRegistry: {
          address: "0x3333333333333333333333333333333333333333",
          deployment: { blockNumber: 19 }
        },
        UVPStateMachine: {
          address: stateMachine,
          deployment: { blockNumber: 20 }
        },
        UVPIdentityRegistry: {
          address: identityRegistry,
          deployment: { blockNumber: 18 }
        }
      }
    }));

    const config = loadConfigFromEnv({ UVP_ADDRESS_MANIFEST: manifestPath });

    expect(config.network.activeDeploymentId).toBe(deploymentId);
    expect(config.network.deploymentBlock).toBe(18n);
    expect(config.network.contracts.UVPDeploymentRegistry).toBe("0x3333333333333333333333333333333333333333");
    expect(config.network.stateMachineDeployments).toEqual([
      {
        deploymentId,
        stateMachineAddress: stateMachine,
        modules: {
          stagePatch: "0x4444444444444444444444444444444444444444",
          derivedSignal: "0x5555555555555555555555555555555555555555",
          docking: "0x6666666666666666666666666666666666666666",
          planMetadata: "0x8888888888888888888888888888888888888888",
          orderLink: "0x9999999999999999999999999999999999999999",
          lens: "0x7777777777777777777777777777777777777777"
        },
        status: "active",
        deploymentBlock: 20n
      }
    ]);
  });

  it("rejects address manifests with a missing or unsupported schemaVersion", () => {
    const dir = mkdtempSync(join(tmpdir(), "uvp-chain-services-"));
    tempDirs.push(dir);
    const missingPath = join(dir, "missing-schema.json");
    writeFileSync(missingPath, JSON.stringify({ contracts: {} }));
    expect(() => loadConfigFromEnv({ UVP_ADDRESS_MANIFEST: missingPath })).toThrow(
      /schemaVersion must be "uvp-eth.addresses.v1"/
    );

    const stalePath = join(dir, "stale-schema.json");
    writeFileSync(stalePath, JSON.stringify({ schemaVersion: "uvp-eth.addresses.v5", contracts: {} }));
    expect(() => loadConfigFromEnv({ UVP_ADDRESS_MANIFEST: stalePath })).toThrow(
      /schemaVersion must be "uvp-eth.addresses.v1"/
    );
  });

  it("does not let zero-address manual overrides erase manifest contracts", () => {
    const dir = mkdtempSync(join(tmpdir(), "uvp-chain-services-"));
    tempDirs.push(dir);
    const manifestPath = join(dir, "addresses.json");
    writeFileSync(manifestPath, JSON.stringify({
      schemaVersion: "uvp-eth.addresses.v1",
      contracts: {
        UVPIdentityRegistry: { address: identityRegistry }
      }
    }));

    const config = loadConfigFromEnv({
      UVP_ADDRESS_MANIFEST: manifestPath,
      UVP_CONTRACTS_JSON: JSON.stringify({
        UVPIdentityRegistry: "0x0000000000000000000000000000000000000000"
      })
    });

    expect(config.network.contracts.UVPIdentityRegistry).toBe(identityRegistry);
  });

  it("refuses to start without an explicit runtime environment", () => {
    expect(() => loadRawConfigFromEnv({
      CHAIN_SERVICES_DATABASE_URL: "postgres://uvp:uvp@127.0.0.1:5432/uvp_chain_services"
    })).toThrow(/CHAIN_SERVICES_RUNTIME_ENV is required/);
    expect(loadConfigFromEnv({ CHAIN_SERVICES_RUNTIME_ENV: "local" }).security.environment).toBe("local");
  });

  it("warns loudly when the local RPC URL falls back to the Anvil default", () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown) => {
      warnings.push(String(message));
    };
    try {
      const config = loadConfigFromEnv({});
      expect(config.network.rpcUrl).toBe("http://127.0.0.1:8545");
      expect(warnings.some((message) => message.includes("UVP_RPC_URL"))).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });

  it("requires an explicit Postgres DSN and loads migration auto-run config", () => {
    expect(() => loadRawConfigFromEnv({ CHAIN_SERVICES_RUNTIME_ENV: "local" })).toThrow(
      /CHAIN_SERVICES_DATABASE_URL is required/
    );
    expect(() => loadConfigFromEnv({ CHAIN_SERVICES_DATABASE_URL: "mysql://uvp@127.0.0.1/uvp" })).toThrow(
      /CHAIN_SERVICES_DATABASE_URL must be a postgres/
    );
    const config = loadConfigFromEnv({
      CHAIN_SERVICES_DATABASE_URL: "postgres://uvp:uvp@127.0.0.1:5432/uvp_chain_services",
      CHAIN_SERVICES_MIGRATIONS_AUTO_RUN: "true"
    });
    expect(config.database.migrationsAutoRun).toBe(true);
  });

  it("loads the Base Sepolia testnet profile with chain-only env", () => {
    const config = loadConfigFromEnv({
      CHAIN_SERVICES_RUNTIME_ENV: "testnet",
      UVP_RPC_URL: "https://sepolia.example/rpc",
      UVP_CHAIN_ID: "84532",
      ...profileEnv
    });
    expect(config.security.environment).toBe("testnet");
    expect(config.operatorRoles.opsConsoleAdmins).toEqual(["ops-admin-1"]);
    expect(config.operatorRoles.adminTokenHashes).toEqual([adminTokenHash]);
  });

  it("rejects testnet profiles without the chain-safe operator and RPC env", () => {
    expect(() => loadConfigFromEnv({
      CHAIN_SERVICES_RUNTIME_ENV: "testnet",
      ...profileEnv
    })).toThrow(/UVP_RPC_URL is required in testnet/);

    expect(() => loadConfigFromEnv({
      CHAIN_SERVICES_RUNTIME_ENV: "testnet",
      UVP_RPC_URL: "https://sepolia.example/rpc",
      UVP_CHAIN_ID: "84532",
      ...profileEnv,
      OPS_CONSOLE_ADMIN_IDS: ""
    })).toThrow(/OPS_CONSOLE_ADMIN_IDS is required in testnet/);

    expect(() => loadConfigFromEnv({
      CHAIN_SERVICES_RUNTIME_ENV: "testnet",
      UVP_RPC_URL: "https://sepolia.example/rpc",
      UVP_CHAIN_ID: "84532",
      ...profileEnv,
      CHAIN_SERVICES_ADMIN_TOKEN_HASHES: ""
    })).toThrow(/CHAIN_SERVICES_ADMIN_TOKEN_HASHES is required in testnet/);
  });

  it("loads the staging profile with a curated manifest and chain-only roles", () => {
    const dir = mkdtempSync(join(tmpdir(), "uvp-chain-services-"));
    tempDirs.push(dir);
    const manifestPath = join(dir, "addresses.staging.json");
    writeFileSync(manifestPath, JSON.stringify({
      schemaVersion: "uvp-eth.addresses.v1",
      contracts: {
        UVPStateMachine: { address: stateMachine },
        UVPIdentityRegistry: { address: identityRegistry }
      }
    }));
    const config = loadConfigFromEnv({
      CHAIN_SERVICES_RUNTIME_ENV: "staging",
      UVP_ADDRESS_MANIFEST: manifestPath,
      UVP_RPC_URL: "https://sepolia.example/rpc",
      UVP_CHAIN_ID: "84532",
      ...profileEnv
    });
    expect(config.security.environment).toBe("staging");
    expect(config.network.contracts.UVPStateMachine).toBe(stateMachine);
  });

  it("loads the production profile with chain-only env", () => {
    const config = loadConfigFromEnv({
      CHAIN_SERVICES_RUNTIME_ENV: "production",
      UVP_RPC_URL: "https://base-mainnet.example/rpc",
      UVP_CHAIN_ID: "8453",
      SECURITY_PREFLIGHT_STRICT: "true",
      LOG_REDACTION_ENABLED: "true",
      ...profileEnv
    });
    expect(config.security.environment).toBe("production");
    expect(config.network.chainId).toBe(8453);
  });

  it("requires an explicit chainId and RPC in production", () => {
    expect(() => loadConfigFromEnv({
      CHAIN_SERVICES_RUNTIME_ENV: "production",
      UVP_CHAIN_ID: "8453",
      ...profileEnv
    })).toThrow(/UVP_RPC_URL is required in production/);

    expect(() => loadConfigFromEnv({
      CHAIN_SERVICES_RUNTIME_ENV: "production",
      UVP_RPC_URL: "https://base-mainnet.example/rpc",
      ...profileEnv
    })).toThrow(/UVP_CHAIN_ID must be explicitly configured in production/);
  });

  it("defaults the finality anchor to the finalized tag and validates the explicit override", () => {
    expect(loadConfigFromEnv({}).network.finalityAnchor).toBe("finalized");
    expect(loadConfigFromEnv({
      UVP_FINALITY_ANCHOR: "confirmations",
      UVP_FINALITY_CONFIRMATIONS: "3"
    }).network.finalityConfirmations).toBe(3);
    expect(() => loadConfigFromEnv({ UVP_FINALITY_ANCHOR: "latest" })).toThrow(/UVP_FINALITY_ANCHOR/);
  });

  it("runs chain-only preflight against a fake network client", async () => {
    const deploymentId = `0x${"01".repeat(32)}`;
    const dir = mkdtempSync(join(tmpdir(), "uvp-chain-services-"));
    tempDirs.push(dir);
    const manifestPath = join(dir, "addresses.staging.json");
    writeFileSync(manifestPath, JSON.stringify({
      schemaVersion: "uvp-eth.addresses.v1",
      activeDeploymentId: deploymentId,
      stateMachineDeployments: [{
        deploymentId,
        stateMachineAddress: stateMachine,
        status: "active",
        modules: {
          stagePatch: "0x4444444444444444444444444444444444444444",
          derivedSignal: "0x5555555555555555555555555555555555555555",
          docking: "0x6666666666666666666666666666666666666666",
          planMetadata: "0x8888888888888888888888888888888888888888",
          orderLink: "0x9999999999999999999999999999999999999999",
          lens: "0x7777777777777777777777777777777777777777"
        }
      }],
      contracts: {
        UVPStateMachine: { address: stateMachine },
        UVPIdentityRegistry: { address: identityRegistry }
      }
    }));
    const config = loadConfigFromEnv({
      CHAIN_SERVICES_RUNTIME_ENV: "staging",
      UVP_ADDRESS_MANIFEST: manifestPath,
      UVP_RPC_URL: "https://sepolia.example/rpc",
      UVP_CHAIN_ID: "84532",
      ...profileEnv
    });

    const moduleAddress = {
      stagePatchModule: "0x4444444444444444444444444444444444444444",
      derivedSignalModule: "0x5555555555555555555555555555555555555555",
      dockingModule: "0x6666666666666666666666666666666666666666",
      planMetadataModule: "0x8888888888888888888888888888888888888888",
      orderLinkModule: "0x9999999999999999999999999999999999999999",
      lens: "0x7777777777777777777777777777777777777777"
    } as const;
    const client: PreflightPublicClient = {
      async getChainId() {
        return 84532;
      },
      async getBytecode() {
        return "0x6000";
      },
      async readContract(input) {
        return moduleAddress[input.functionName as keyof typeof moduleAddress];
      }
    };

    const diagnostics = await runConfigPreflight(config, {
      clients: { network: client }
    });
    expect(diagnostics.preflight.status).toBe("passed");
    expect(diagnostics.preflight.checks).toContainEqual(expect.objectContaining({
      name: "contracts.state_machine_modules",
      status: "passed"
    }));
  });

  it("fails preflight when the RPC chainId does not match config", async () => {
    const config = loadConfigFromEnv({
      CHAIN_SERVICES_RUNTIME_ENV: "testnet",
      UVP_RPC_URL: "https://sepolia.example/rpc",
      UVP_CHAIN_ID: "84532",
      ...profileEnv
    });
    const client: PreflightPublicClient = {
      async getChainId() {
        return 1;
      },
      async getBytecode() {
        return "0x6000";
      }
    };
    await expect(runConfigPreflight(config, { clients: { network: client } })).rejects.toThrow(
      /RPC chainId 1 does not match configured chainId 84532/
    );
  });
});
