import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildConfigDiagnostics, loadConfigFromEnv as loadRawConfigFromEnv, runConfigPreflight } from "../src/config/index.js";

const MANDATORY_STORAGE_AND_REGISTRATION_ENV = {
  CHAIN_SERVICES_RUNTIME_ENV: "local",
  CHAIN_SERVICES_DATABASE_URL: "postgres://uvp:uvp@127.0.0.1:5432/uvp_chain_services",
  UVP_PRODUCT_BFF_REGISTRATION_ADAPTER: "memory-trigger"
} as const;

function loadConfigFromEnv(env: Record<string, string | undefined> = {}): ReturnType<typeof loadRawConfigFromEnv> {
  return loadRawConfigFromEnv({ ...MANDATORY_STORAGE_AND_REGISTRATION_ENV, ...env });
}
import { createApiRouter } from "../src/api/routes.js";
import { ObjectEvidenceStorage } from "../src/evidence/index.js";
import { PostgresProjectionStore } from "../src/storage/postgres.js";
import { createChainServicesStores, type ChainServicesStores } from "../src/storage/factory.js";
import { createPostgresTestDatabase } from "./postgres.js";
import { redactSecrets } from "../src/security/index.js";

let stores: ChainServicesStores;

beforeAll(async () => {
  stores = createChainServicesStores({
    database: { url: await createPostgresTestDatabase(), migrationsAutoRun: true }
  });
});

afterAll(async () => {
  await stores.close();
});

function requiredRouterStores() {
  return {
    storeWalletSessionStore: stores.storeWalletSessionStore,
    identityDescriptorSnapshots: stores.identityDescriptorSnapshots,
    productBffStore: stores.productBffStore,
    orderStore: stores.orderStore,
    orderRequirementsStore: stores.orderRequirementsStore,
    evidenceMetadataStore: stores.evidenceMetadataStore,
    submissionStore: stores.submissionStore,
    governanceStore: stores.governanceStore,
    stageExecutorPatchStore: stores.stageExecutorPatchStore,
    stageResourcePatchStore: stores.stageResourcePatchStore,
  };
}

const anvilPrivateKey = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const productionRelayerPrivateKey = "0x1111111111111111111111111111111111111111111111111111111111111111";
const productionRelayerAddress = "0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a";
const productionRegistrarPrivateKey = "0x2222222222222222222222222222222222222222222222222222222222222222";
const productionAdminTokenHash = "f7a03f48c0e2aa2d5e55ca186c20032ddbf53b7f5f93fce387d65c3f83433e8d";
const productionRegistrarAddress = "0x1563915e194d8cfba1943570603f7606a3115508";
const productionContracts = JSON.stringify({
  UVPStateMachine: "0x1111111111111111111111111111111111111111",
  UVPIdentityRegistry: "0x2222222222222222222222222222222222222222"
});
const testnetRelayerPrivateKey = "0x3333333333333333333333333333333333333333333333333333333333333333";
const testnetRegistrarPrivateKey = "0x4444444444444444444444444444444444444444444444444444444444444444";
const stagingDeployerAddress = "0x5cbdd86a2fa8dc4bddd8a8f69dba48572eec07fb";
const stagingGovernanceAddress = "0x7564105e977516c53be337314c7e53838967bdac";
const storeAuthJwtEnv = {
  STORE_AUTH_MODE: "jwt",
  STORE_AUTH_JWKS_URL: "https://identity.example/.well-known/jwks.json",
  STORE_AUTH_ISSUER: "https://identity.example/",
  STORE_AUTH_AUDIENCE: "uvp-store",
  STORE_AUTH_ROLE_CLAIM: "roles",
  STORE_AUTH_PRINCIPAL_CLAIM: "sub",
  STORE_AUTH_DISPLAY_NAME_CLAIM: "name",
  STORE_AUTH_CLOCK_TOLERANCE_SECONDS: "30"
};

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
          address: "0x1111111111111111111111111111111111111111",
          deployment: { blockNumber: 20 }
        },
        UVPIdentityRegistry: {
          address: "0x2222222222222222222222222222222222222222",
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
    expect(config.network.contracts.UVPStateMachine).toBe("0x1111111111111111111111111111111111111111");
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
          stateMachineAddress: "0x1111111111111111111111111111111111111111",
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
          address: "0x1111111111111111111111111111111111111111",
          deployment: { blockNumber: 20 }
        },
        UVPIdentityRegistry: {
          address: "0x2222222222222222222222222222222222222222",
          deployment: { blockNumber: 18 }
        }
      }
    }));

    const config = loadConfigFromEnv({ UVP_ADDRESS_MANIFEST: manifestPath });

    expect(config.network.activeDeploymentId).toBe(deploymentId);
    expect(config.network.deploymentBlock).toBe(18n);
    expect(config.network.contracts.UVPDeploymentRegistry).toBe("0x3333333333333333333333333333333333333333");
    expect(config.network.contracts.UVPStateMachine).toBe("0x1111111111111111111111111111111111111111");
    expect(config.network.stateMachineDeployments).toEqual([
      {
        deploymentId,
        stateMachineAddress: "0x1111111111111111111111111111111111111111",
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
      /schemaVersion must be "uvp-eth.addresses.v1"/,
    );

    const stalePath = join(dir, "stale-schema.json");
    writeFileSync(stalePath, JSON.stringify({ schemaVersion: "uvp-eth.addresses.v5", contracts: {} }));
    expect(() => loadConfigFromEnv({ UVP_ADDRESS_MANIFEST: stalePath })).toThrow(
      /schemaVersion must be "uvp-eth.addresses.v1"/,
    );
  });

  it("does not let zero-address manual overrides erase manifest contracts", () => {
    const dir = mkdtempSync(join(tmpdir(), "uvp-chain-services-"));
    tempDirs.push(dir);
    const manifestPath = join(dir, "addresses.json");
    writeFileSync(manifestPath, JSON.stringify({
      schemaVersion: "uvp-eth.addresses.v1",
      contracts: {
        UVPIdentityRegistry: {
          address: "0x2222222222222222222222222222222222222222"
        }
      }
    }));

    const config = loadConfigFromEnv({
      UVP_ADDRESS_MANIFEST: manifestPath,
      UVP_CONTRACTS_JSON: JSON.stringify({
        UVPIdentityRegistry: "0x0000000000000000000000000000000000000000"
      })
    });

    expect(config.network.contracts.UVPIdentityRegistry).toBe("0x2222222222222222222222222222222222222222");
  });

  it("refuses to start without an explicit runtime environment", () => {
    expect(() => loadRawConfigFromEnv({
      CHAIN_SERVICES_DATABASE_URL: "postgres://uvp:uvp@127.0.0.1:5432/uvp_chain_services",
      UVP_PRODUCT_BFF_REGISTRATION_ADAPTER: "memory-trigger"
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
    const quiet: string[] = [];
    console.warn = (message?: unknown) => {
      quiet.push(String(message));
    };
    try {
      loadConfigFromEnv({ UVP_RPC_URL: "http://127.0.0.1:8545" });
      expect(quiet).toHaveLength(0);
    } finally {
      console.warn = originalWarn;
    }
  });

  it("requires the storage URL to be declared explicitly and points local runs at the bundled Postgres container", () => {
    expect(() => loadRawConfigFromEnv({})).toThrow(/CHAIN_SERVICES_RUNTIME_ENV is required/);

    expect(() => loadRawConfigFromEnv({
      CHAIN_SERVICES_RUNTIME_ENV: "local"
    })).toThrow(/CHAIN_SERVICES_DATABASE_URL is required/);
    expect(() => loadRawConfigFromEnv({
      CHAIN_SERVICES_RUNTIME_ENV: "local"
    })).toThrow(/with-postgres\.sh/);

    const config = loadConfigFromEnv({});
    expect(config.database).toEqual({
      url: "postgres://uvp:uvp@127.0.0.1:5432/uvp_chain_services",
      migrationsAutoRun: false
    });
  });

  it("loads the storage URL and migration auto-run config", () => {
    const config = loadConfigFromEnv({
      CHAIN_SERVICES_DATABASE_URL: "postgres://uvp:uvp@127.0.0.1:5432/local-db",
      CHAIN_SERVICES_MIGRATIONS_AUTO_RUN: "true"
    });

    expect(config.database).toEqual({
      url: "postgres://uvp:uvp@127.0.0.1:5432/local-db",
      migrationsAutoRun: true
    });
  });

  it("rejects non-postgres database URLs", () => {
    expect(() => loadRawConfigFromEnv({
      CHAIN_SERVICES_RUNTIME_ENV: "local",
      CHAIN_SERVICES_DATABASE_URL: "postgres://uvp:uvp@127.0.0.1:5432/uvp",
      UVP_PRODUCT_BFF_REGISTRATION_ADAPTER: "memory-trigger"
    })).not.toThrow();

    expect(() => loadRawConfigFromEnv({
      CHAIN_SERVICES_RUNTIME_ENV: "local",
      CHAIN_SERVICES_DATABASE_URL: "not-a-database-url",
      UVP_PRODUCT_BFF_REGISTRATION_ADAPTER: "memory-trigger"
    })).toThrow(/CHAIN_SERVICES_DATABASE_URL must be a postgres:\/\/ \(or postgresql:\/\/\) DSN/);
  });

  it("propagates the broadcast retry budget into the relayer config", () => {
    const config = loadConfigFromEnv({
      BROADCAST_MAX_RETRY_ATTEMPTS: "5"
    });

    expect(config.relayer.maxRetries).toBe(5);
  });

  it("loads Store auth config with local dev-header default and JWT settings", () => {
    expect(loadConfigFromEnv({}).storeAuth).toEqual({
      mode: "dev_headers",
      roleClaim: "roles",
      principalClaim: "sub",
      displayNameClaim: "name",
      clockToleranceSeconds: 60,
      walletSession: {
        enabled: true,
        operatorWallets: [],
        adminWallets: [],
        sessionTtlSeconds: 43200,
        challengeTtlSeconds: 300,
        devAnchoredAddressHeaderEnabled: true
      }
    });

    expect(loadConfigFromEnv(storeAuthJwtEnv).storeAuth).toEqual({
      mode: "jwt",
      jwksUrl: "https://identity.example/.well-known/jwks.json",
      issuer: "https://identity.example/",
      audience: "uvp-store",
      roleClaim: "roles",
      principalClaim: "sub",
      displayNameClaim: "name",
      clockToleranceSeconds: 30,
      walletSession: {
        enabled: true,
        operatorWallets: [],
        adminWallets: [],
        sessionTtlSeconds: 43200,
        challengeTtlSeconds: 300,
        devAnchoredAddressHeaderEnabled: true
      }
    });
  });

  it("loads the Base Sepolia testnet runtime profile with Postgres storage", () => {
    const config = loadConfigFromEnv(testnetEnv(testnetPostgresConfigUrl()));

    expect(config.security.environment).toBe("testnet");
    expect(config.security.preflightStrict).toBe(true);
    expect(config.network.chainId).toBe(84532);
    expect(config.database).toEqual({
      url: testnetPostgresConfigUrl(),
      migrationsAutoRun: true
    });
    expect(config.productBff.registrationAdapter).toBe("anvil");
    expect(config.relayer.broadcastEnabled).toBe(true);
    expect(config.evidenceStorage.adapter).toBe("rehearsal-object");
  });

  it("rejects testnet non-Postgres or missing database storage", () => {
    const databaseUrl = testnetPostgresConfigUrl();

    const { CHAIN_SERVICES_DATABASE_URL: _databaseUrl, ...missingDatabaseUrl } = testnetEnv(databaseUrl);
    expect(() => loadRawConfigFromEnv(missingDatabaseUrl)).toThrow(/CHAIN_SERVICES_DATABASE_URL is required/);

    expect(() => loadConfigFromEnv(testnetEnv(databaseUrl, {
      CHAIN_SERVICES_DATABASE_URL: "not-a-database-url"
    }))).toThrow(/CHAIN_SERVICES_DATABASE_URL must be a postgres:\/\/ \(or postgresql:\/\/\) DSN/);

    expect(() => loadConfigFromEnv(testnetEnv(databaseUrl, {
      UVP_INDEXER_POLL_INTERVAL_MS: undefined
    }))).toThrow(/UVP_INDEXER_POLL_INTERVAL_MS must be explicitly configured/);

    expect(() => loadConfigFromEnv(testnetEnv(databaseUrl, {
      UVP_INDEXER_POLL_INTERVAL_MS: "0"
    }))).toThrow(/UVP_INDEXER_POLL_DISABLED_ACK=1/);

    expect(loadConfigFromEnv(testnetEnv(databaseUrl, {
      UVP_INDEXER_POLL_INTERVAL_MS: "0",
      UVP_INDEXER_POLL_DISABLED_ACK: "1"
    })).api.indexerPollIntervalMs).toBe(0);
  });

  it("rejects testnet missing RPC, wrong chain id, local RPC, or incomplete contracts", () => {
    const databaseUrl = testnetPostgresConfigUrl();
    const { UVP_RPC_URL: _rpcUrl, ...missingRpc } = testnetEnv(databaseUrl);
    expect(() => loadConfigFromEnv(missingRpc)).toThrow(/UVP_RPC_URL is required in testnet/);

    expect(() => loadConfigFromEnv(testnetEnv(databaseUrl, {
      UVP_RPC_URL: "http://127.0.0.1:8545"
    }))).toThrow(/non-local Base Sepolia RPC/);

    expect(() => loadConfigFromEnv(testnetEnv(databaseUrl, {
      UVP_CHAIN_ID: "31337"
    }))).toThrow(/UVP_CHAIN_ID=84532 is required in testnet/);

    expect(() => loadConfigFromEnv(testnetEnv(databaseUrl, {
      UVP_CONTRACTS_JSON: JSON.stringify({
        UVPIdentityRegistry: "0x2222222222222222222222222222222222222222"
      })
    }))).toThrow(/UVPStateMachine contract address/);

    expect(() => loadConfigFromEnv(testnetEnv(databaseUrl, {
      UVP_CONTRACTS_JSON: JSON.stringify({
        UVPStateMachine: "0x1111111111111111111111111111111111111111"
      })
    }))).toThrow(/UVPIdentityRegistry contract address/);
  });

  it("rejects testnet demo controls, permissive auth, memory registration, and unsafe keys", () => {
    const databaseUrl = testnetPostgresConfigUrl();

    expect(loadConfigFromEnv(testnetEnv(databaseUrl, {
      UVP_PRODUCT_DEMO_MODE: "1"
    })).security.environment).toBe("testnet");

    expect(() => loadConfigFromEnv(testnetEnv(databaseUrl, {
      UVP_PRODUCT_SUBMISSION_AUTHORIZATION: "product_projection_demo"
    }))).toThrow(/permissive Product submission authorization/);

    expect(() => loadConfigFromEnv(testnetEnv(databaseUrl, {
      UVP_PRODUCT_BFF_REGISTRATION_ADAPTER: "memory"
    }))).toThrow(/UVP_PRODUCT_BFF_REGISTRATION_ADAPTER must be memory-trigger or anvil/);

    expect(() => loadConfigFromEnv(testnetEnv(databaseUrl, {
      UVP_PRODUCT_BFF_REGISTRATION_ADAPTER: "memory-trigger"
    }))).toThrow(/REGISTRATION_ADAPTER=anvil is required in testnet/);

    expect(() => loadConfigFromEnv(testnetEnv(databaseUrl, {
      UVP_STATE_MACHINE_RELAYER_BROADCAST_ENABLED: "false"
    }))).toThrow(/RELAYER_BROADCAST_ENABLED=false/);

    expect(() => loadConfigFromEnv(testnetEnv(databaseUrl, {
      UVP_EVIDENCE_STORAGE_ADAPTER: "local"
    }))).toThrow(/UVP_EVIDENCE_STORAGE_ADAPTER=rehearsal-object/);

    expect(() => loadConfigFromEnv(testnetEnv(databaseUrl, {
      SECURITY_PREFLIGHT_STRICT: "false"
    }))).toThrow(/SECURITY_PREFLIGHT_STRICT=false/);

    expect(() => loadConfigFromEnv(testnetEnv(databaseUrl, {
      LOG_REDACTION_ENABLED: "false"
    }))).toThrow(/LOG_REDACTION_ENABLED=false/);

    expect(() => loadConfigFromEnv(testnetEnv(databaseUrl, {
      UVP_STATE_MACHINE_RELAYER_PRIVATE_KEY: anvilPrivateKey
    }))).toThrow(/Anvil default private key/);

    const { UVP_STATE_MACHINE_RELAYER_PRIVATE_KEY: _relayerPrivateKey, ...missingRelayer } = testnetEnv(databaseUrl);
    expect(() => loadConfigFromEnv(missingRelayer)).toThrow(/UVP_STATE_MACHINE_RELAYER_PRIVATE_KEY is required in testnet/);
  });

  it("runs safe strict preflight diagnostics for the testnet profile", async () => {
    const env = testnetEnv(testnetPostgresConfigUrl(), {
      UVP_RPC_URL: "https://base-sepolia.example/rpc?api_key=rpc-secret",
      UVP_ADDRESS_MANIFEST: stagingManifestPath(tempDirs, "testnet.addresses.json")
    });
    const config = loadConfigFromEnv(env);

    const diagnostics = await runConfigPreflight(config, {
      env,
      clients: {
        network: { getChainId: async () => 84532 }
      }
    });

    expect(diagnostics).toMatchObject({
      environment: "testnet",
      storage: { driver: "postgres" },
      evidenceStorage: {
        adapter: "rehearsal-object",
        objectNamespace: "uvp-rehearsal"
      },
      network: {
        chainId: 84532,
        stateMachineConfigured: true,
        identityRegistryConfigured: true
      },
      product: {
        registrationAdapter: "anvil",
        permissiveAuthorizationRequested: false
      },
      storeAuth: {
        mode: "jwt",
        jwtConfigured: true,
        externalIdentityEvidence: true,
        evidenceClassification: "external_oidc",
        evidenceReasons: [],
        keySource: "jwks_url",
        jwksUrlConfigured: true,
        issuerConfigured: true,
        audienceConfigured: true,
        roleClaim: "roles",
        principalClaim: "sub",
        displayNameClaimConfigured: true,
        clockToleranceSeconds: 30
      },
      preflight: { strict: true, status: "passed" }
    });
    expect(diagnostics.preflight.checks).toContainEqual({
      name: "store_metadata.durable",
      status: "passed"
    });
    const serialized = JSON.stringify(diagnostics);
    expect(serialized).not.toContain("rpc-secret");
    expect(serialized).not.toContain(testnetRelayerPrivateKey.slice(2));
    expect(serialized).not.toContain(testnetRegistrarPrivateKey.slice(2));
  });

  it("fails testnet preflight when unsafe env is injected after config load", async () => {
    const env = testnetEnv(testnetPostgresConfigUrl());
    const config = loadConfigFromEnv(env);

    expect(() => loadConfigFromEnv(testnetEnv(testnetPostgresConfigUrl(), {
      STORE_AUTH_DEV_ANCHORED_ADDRESS_HEADER: "true"
    }))).toThrow(/STORE_AUTH_DEV_ANCHORED_ADDRESS_HEADER=true is only allowed in local development/);
  });

  it("loads the staging runtime profile with Postgres, S3, strict preflight, and role env names", () => {
    const config = loadConfigFromEnv(stagingEnv(tempDirs));

    expect(config.security).toMatchObject({
      environment: "staging",
      preflightStrict: true,
      logRedactionEnabled: true
    });
    expect(config.database).toEqual({
      url: "postgres://uvp:db-secret@staging-db.internal:5432/uvp",
      migrationsAutoRun: false
    });
    expect(config.evidenceStorage).toMatchObject({
      adapter: "s3",
      s3Bucket: "uvp-staging-evidence",
      s3Region: "us-east-1",
      s3Endpoint: "https://objects.example",
      s3Prefix: "staging/evidence",
      s3ForcePathStyle: true,
      s3AccessKeyIdEnv: "UVP_STAGING_EVIDENCE_S3_ACCESS_KEY_ID",
      s3SecretAccessKeyEnv: "UVP_STAGING_EVIDENCE_S3_SECRET_ACCESS_KEY",
      s3UriMode: "s3"
    });
    expect(config.productBff).toMatchObject({
      registrationAdapter: "anvil",
      registrarPrivateKeyEnv: "UVP_STAGING_ORDER_REGISTRAR_PRIVATE_KEY",
      registrarAddress: productionRegistrarAddress,
      waitForReceipt: true
    });
    expect(config.relayer).toMatchObject({
      broadcastEnabled: true,
      stateMachinePrivateKeyEnv: "UVP_STAGING_RELAYER_PRIVATE_KEY",
      expectedGasPayer: productionRelayerAddress
    });
    expect(config.storeAuth).toMatchObject({
      mode: "jwt",
      jwksUrl: "https://identity.example/.well-known/jwks.json",
      issuer: "https://identity.example/",
      audience: "uvp-store",
      roleClaim: "roles",
      principalClaim: "sub",
      displayNameClaim: "name",
      clockToleranceSeconds: 30
    });
    expect(config.operatorRoles.opsConsoleAdmins).toEqual(["ops-admin-1"]);
  });

  it("rejects staging non-Postgres storage, demo controls, local RPC, wrong chain, unsafe evidence, and weak keys", () => {
    expect(() => loadConfigFromEnv(stagingEnv(tempDirs, {
      CHAIN_SERVICES_DATABASE_URL: "not-a-database-url"
    }))).toThrow(/CHAIN_SERVICES_DATABASE_URL must be a postgres:\/\/ \(or postgresql:\/\/\) DSN/);

    const { CHAIN_SERVICES_DATABASE_URL: _databaseUrl, ...missingDatabaseUrl } = stagingEnv(tempDirs);
    expect(() => loadRawConfigFromEnv(missingDatabaseUrl)).toThrow(/CHAIN_SERVICES_DATABASE_URL/);

    expect(() => loadConfigFromEnv(stagingEnv(tempDirs, {
      CHAIN_SERVICES_MIGRATIONS_AUTO_RUN: "true"
    }))).toThrow(/UVP_STAGING_ALLOW_AUTO_MIGRATIONS/);

    expect(() => loadConfigFromEnv(stagingEnv(tempDirs, {
      UVP_INDEXER_POLL_INTERVAL_MS: undefined
    }))).toThrow(/UVP_INDEXER_POLL_INTERVAL_MS must be explicitly configured/);

    expect(() => loadConfigFromEnv(stagingEnv(tempDirs, {
      UVP_INDEXER_POLL_INTERVAL_MS: "0"
    }))).toThrow(/UVP_INDEXER_POLL_DISABLED_ACK=1/);

    expect(loadConfigFromEnv(stagingEnv(tempDirs, {
      UVP_INDEXER_POLL_INTERVAL_MS: "0",
      UVP_INDEXER_POLL_DISABLED_ACK: "1"
    })).api.indexerPollIntervalMs).toBe(0);

    expect(() => loadConfigFromEnv(stagingEnv(tempDirs, {
      RECONCILE_POLL_INTERVAL_MS: "5000"
    }))).toThrow(/RECONCILE_POLL_INTERVAL_MS/);

    expect(() => loadConfigFromEnv(stagingEnv(tempDirs, {
      UVP_EVIDENCE_STORAGE_ADAPTER: "local"
    }))).toThrow(/UVP_EVIDENCE_STORAGE_ADAPTER=s3/);

    expect(() => loadConfigFromEnv(stagingEnv(tempDirs, {
      UVP_EVIDENCE_STORAGE_ADAPTER: "rehearsal-object"
    }))).toThrow(/UVP_EVIDENCE_STORAGE_ADAPTER=s3/);

    expect(loadConfigFromEnv(stagingEnv(tempDirs, {
      UVP_PRODUCT_DEMO_MODE: "1"
    })).security.environment).toBe("staging");

    expect(() => loadConfigFromEnv(stagingEnv(tempDirs, {
      UVP_PRODUCT_PERMISSIVE_AUTH: "1"
    }))).toThrow(/permissive Product submission authorization/);

    expect(() => loadConfigFromEnv(stagingEnv(tempDirs, {
      UVP_PRODUCT_BFF_REGISTRATION_ADAPTER: "memory"
    }))).toThrow(/UVP_PRODUCT_BFF_REGISTRATION_ADAPTER must be memory-trigger or anvil/);

    expect(() => loadConfigFromEnv(stagingEnv(tempDirs, {
      UVP_PRODUCT_BFF_REGISTRATION_ADAPTER: "memory-trigger"
    }))).toThrow(/REGISTRATION_ADAPTER=anvil is required in staging/);

    expect(() => loadConfigFromEnv(stagingEnv(tempDirs, {
      UVP_PRODUCT_BFF_WAIT_FOR_RECEIPT: "false"
    }))).toThrow(/WAIT_FOR_RECEIPT=true/);

    expect(() => loadConfigFromEnv(stagingEnv(tempDirs, {
      UVP_STATE_MACHINE_RELAYER_BROADCAST_ENABLED: "false"
    }))).toThrow(/RELAYER_BROADCAST_ENABLED=true/);

    expect(() => loadConfigFromEnv(stagingEnv(tempDirs, {
      STORE_AUTH_MODE: "dev_headers"
    }))).toThrow(/dev_headers is only allowed in local/);

    expect(() => loadConfigFromEnv(stagingEnv(tempDirs, {
      STORE_AUTH_JWKS_URL: "http://127.0.0.1:8789/.well-known/jwks.json"
    }))).toThrow(/STORE_AUTH_JWKS_URL must be HTTPS/);

    expect(() => loadConfigFromEnv(stagingEnv(tempDirs, {
      STORE_AUTH_JWKS_URL: "https://127.0.0.1:8789/.well-known/jwks.json"
    }))).toThrow(/STORE_AUTH_JWKS_URL must not use localhost or private network hosts/);

    expect(() => loadConfigFromEnv(stagingEnv(tempDirs, {
      STORE_AUTH_JWKS_URL: undefined,
      STORE_AUTH_OIDC_DISCOVERY_URL: "https://10.0.0.5/.well-known/openid-configuration"
    }))).toThrow(/STORE_AUTH_OIDC_DISCOVERY_URL must not use localhost or private network hosts/);

    expect(() => loadConfigFromEnv(stagingEnv(tempDirs, {
      STORE_AUTH_CLOCK_TOLERANCE_SECONDS: "1.5"
    }))).toThrow(/STORE_AUTH_CLOCK_TOLERANCE_SECONDS/);

    const { UVP_EVIDENCE_S3_BUCKET: _s3Bucket, ...missingS3Bucket } = stagingEnv(tempDirs);
    expect(() => loadConfigFromEnv(missingS3Bucket)).toThrow(/UVP_EVIDENCE_S3_BUCKET/);

    const { UVP_EVIDENCE_S3_ACCESS_KEY_ID_ENV: _s3AccessKeyEnv, ...missingS3AccessKeyEnv } = stagingEnv(tempDirs);
    expect(() => loadConfigFromEnv(missingS3AccessKeyEnv)).toThrow(/UVP_EVIDENCE_S3_ACCESS_KEY_ID_ENV/);

    const { UVP_STAGING_EVIDENCE_S3_SECRET_ACCESS_KEY: _s3Secret, ...missingS3SecretValue } = stagingEnv(tempDirs);
    expect(() => loadConfigFromEnv(missingS3SecretValue)).toThrow(/UVP_STAGING_EVIDENCE_S3_SECRET_ACCESS_KEY/);

    expect(() => loadConfigFromEnv(stagingEnv(tempDirs, {
      UVP_EVIDENCE_S3_FORCE_PATH_STYLE: "maybe"
    }))).toThrow(/UVP_EVIDENCE_S3_FORCE_PATH_STYLE/);

    expect(() => loadConfigFromEnv(stagingEnv(tempDirs, {
      UVP_EVIDENCE_S3_URI_MODE: "object"
    }))).toThrow(/UVP_EVIDENCE_S3_OBJECT_NAMESPACE/);

    expect(() => loadConfigFromEnv(stagingEnv(tempDirs, {
      UVP_RPC_URL: "http://127.0.0.1:8545"
    }))).toThrow(/non-local Base Sepolia or staging RPC/);

    expect(() => loadConfigFromEnv(stagingEnv(tempDirs, {
      UVP_CHAIN_ID: "31337"
    }))).toThrow(/UVP_CHAIN_ID=84532/);

    expect(() => loadConfigFromEnv(stagingEnv(tempDirs, {
      SECURITY_PREFLIGHT_STRICT: "false"
    }))).toThrow(/SECURITY_PREFLIGHT_STRICT=false/);

    expect(() => loadConfigFromEnv(stagingEnv(tempDirs, {
      UVP_STAGING_RELAYER_PRIVATE_KEY: anvilPrivateKey
    }))).toThrow(/Anvil default private key/);

    expect(() => loadConfigFromEnv(stagingEnv(tempDirs, {
      UVP_REHEARSAL_PARTICIPANT_WALLETS: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"
    }))).toThrow(/Anvil default wallet/);
  });

  it("rejects staging missing or example address manifests and missing role anchors", () => {
    const { UVP_ADDRESS_MANIFEST: _manifest, ...missingManifest } = stagingEnv(tempDirs);
    expect(() => loadConfigFromEnv(missingManifest)).toThrow(/UVP_ADDRESS_MANIFEST is required in staging/);

    expect(() => loadConfigFromEnv(stagingEnv(tempDirs, {
      UVP_ADDRESS_MANIFEST: stagingManifestPath(tempDirs, "staging.example.json")
    }))).toThrow(/not an example manifest/);

    const { UVP_RELAYER_GAS_PAYER_ADDRESS: _gasPayer, ...missingGasPayer } = stagingEnv(tempDirs);
    expect(() => loadConfigFromEnv(missingGasPayer)).toThrow(/UVP_RELAYER_GAS_PAYER_ADDRESS/);

    const { UVP_ORDER_REGISTRAR_ADDRESS: _registrar, ...missingRegistrar } = stagingEnv(tempDirs);
    expect(() => loadConfigFromEnv(missingRegistrar)).toThrow(/UVP_ORDER_REGISTRAR_ADDRESS/);

    const { GOVERNANCE_SIGNER_ADDRESS: _governanceSigner, ...missingGovernanceSigner } = stagingEnv(tempDirs);
    expect(() => loadConfigFromEnv(missingGovernanceSigner)).toThrow(/GOVERNANCE_SIGNER_ADDRESS/);

    const { OPS_CONSOLE_ADMIN_IDS: _opsAdmins, ...missingOpsAdmins } = stagingEnv(tempDirs);
    expect(() => loadConfigFromEnv(missingOpsAdmins)).toThrow(/OPS_CONSOLE_ADMIN_IDS/);

    const { GOVERNANCE_ADMIN_TOKEN_HASHES: _adminTokens, ...missingAdminTokens } = stagingEnv(tempDirs);
    expect(() => loadConfigFromEnv(missingAdminTokens)).toThrow(/GOVERNANCE_ADMIN_TOKEN_HASHES is required in staging/);
    expect(() => loadConfigFromEnv(stagingEnv(tempDirs, {
      GOVERNANCE_ADMIN_TOKEN_HASHES: "zz-not-hex"
    }))).toThrow(/sha256 hex/);
  });

  it("runs safe strict preflight diagnostics for the staging profile", async () => {
    const env = stagingEnv(tempDirs);
    const config = loadConfigFromEnv(env);

    const diagnostics = await runConfigPreflight(config, {
      env,
      clients: stagingPreflightClients()
    });

    expect(diagnostics).toMatchObject({
      environment: "staging",
      storage: { driver: "postgres", migrationsAutoRun: false },
      evidenceStorage: {
        adapter: "s3",
        s3: {
          bucketConfigured: true,
          regionConfigured: true,
          endpointConfigured: true,
          prefixConfigured: true,
          forcePathStyle: true,
          uriMode: "s3",
          objectNamespaceConfigured: false,
          accessKeyIdEnv: "UVP_STAGING_EVIDENCE_S3_ACCESS_KEY_ID",
          secretAccessKeyEnv: "UVP_STAGING_EVIDENCE_S3_SECRET_ACCESS_KEY"
        }
      },
      relayer: {
        broadcastEnabled: true,
        gasPayer: productionRelayerAddress,
        expectedGasPayer: productionRelayerAddress
      },
      governance: {
        broadcastEnabled: true,
        signerAddress: stagingGovernanceAddress,
        expectedSignerAddress: stagingGovernanceAddress,
        expectedRegistryOwnerAddress: stagingGovernanceAddress
      },
      operatorRoles: {
        deployer: {
          privateKeyEnv: "UVP_STAGING_DEPLOYER_PRIVATE_KEY",
          address: stagingDeployerAddress,
          expectedAddress: stagingDeployerAddress,
          addressMatches: true
        },
        orderRegistrar: {
          privateKeyEnv: "UVP_STAGING_ORDER_REGISTRAR_PRIVATE_KEY",
          address: productionRegistrarAddress,
          expectedAddress: productionRegistrarAddress,
          addressMatches: true
        },
        relayerGasPayer: {
          privateKeyEnv: "UVP_STAGING_RELAYER_PRIVATE_KEY",
          address: productionRelayerAddress,
          expectedAddress: productionRelayerAddress,
          addressMatches: true
        },
        governanceSigner: {
          privateKeyEnv: "UVP_STAGING_GOVERNANCE_SIGNER_PRIVATE_KEY",
          address: stagingGovernanceAddress,
          expectedAddress: stagingGovernanceAddress,
          addressMatches: true
        },
        governanceAdminReviewer: { configuredCount: 1 },
        opsConsoleAdmin: { configuredCount: 1 }
      },
      product: {
        registrationAdapter: "anvil",
        permissiveAuthorizationRequested: false
      },
      storeAuth: {
        mode: "jwt",
        jwtConfigured: true,
        externalIdentityEvidence: true,
        evidenceClassification: "external_oidc",
        evidenceReasons: [],
        keySource: "jwks_url",
        jwksUrlConfigured: true,
        issuerConfigured: true,
        audienceConfigured: true,
        roleClaim: "roles",
        principalClaim: "sub",
        displayNameClaimConfigured: true,
        clockToleranceSeconds: 30
      },
      preflight: { strict: true, status: "passed" }
    });
    expect(diagnostics.preflight.checks).toContainEqual({
      name: "store_metadata.durable",
      status: "passed"
    });
    expect(diagnostics.preflight.checks).toContainEqual({
      name: "store_auth.external_oidc",
      status: "passed"
    });

    const serialized = JSON.stringify(diagnostics);
    expect(serialized).not.toContain("db-secret");
    expect(serialized).not.toContain("rpc-secret");
    expect(serialized).not.toContain("object-secret");
    expect(serialized).not.toContain(productionRelayerPrivateKey.slice(2));
    expect(serialized).not.toContain(productionRegistrarPrivateKey.slice(2));
    expect(serialized).not.toContain(testnetRelayerPrivateKey.slice(2));
    expect(serialized).not.toContain(testnetRegistrarPrivateKey.slice(2));
  });

  it("fails strict preflight closed when the active deployment manifest is missing modules", async () => {
    const manifestDir = mkdtempSync(join(tmpdir(), "uvp-chain-services-modules-"));
    tempDirs.push(manifestDir);
    const manifestPath = join(manifestDir, "flat.addresses.json");
    writeFileSync(manifestPath, JSON.stringify({
      schemaVersion: "uvp-eth.addresses.v1",
      network: { chainId: 84532, rpcUrlEnv: "UVP_RPC_URL" },
      deployment: { blockNumber: 100 },
      contracts: {
        UVPStateMachine: {
          address: "0x1111111111111111111111111111111111111111",
          deployment: { blockNumber: 110 }
        },
        UVPIdentityRegistry: {
          address: "0x2222222222222222222222222222222222222222",
          deployment: { blockNumber: 111 }
        }
      }
    }));
    const env = stagingEnv(tempDirs, {
      UVP_ADDRESS_MANIFEST: manifestPath
    });
    const config = loadConfigFromEnv(env);
    await expect(runConfigPreflight(config, {
      env,
      clients: stagingPreflightClients()
    })).rejects.toThrow(/stateMachineDeployments with modules are required/);

    const localConfig = loadConfigFromEnv({
      UVP_ADDRESS_MANIFEST: manifestPath,
      UVP_RPC_URL: "http://127.0.0.1:8545"
    });
    const localDiagnostics = await runConfigPreflight(localConfig, {
      env: { UVP_ADDRESS_MANIFEST: manifestPath },
      clients: stagingPreflightClients()
    });
    expect(localDiagnostics.preflight.checks).toContainEqual(
      expect.objectContaining({
        name: "contracts.state_machine_modules_manifest",
        status: "skipped"
      })
    );
  });

  it("fails strict preflight when activeDeploymentId matches no deployment in the manifest", async () => {
    const manifestDir = mkdtempSync(join(tmpdir(), "uvp-chain-services-active-id-"));
    tempDirs.push(manifestDir);
    const manifestPath = join(manifestDir, "addresses.mismatch.json");
    writeFileSync(manifestPath, JSON.stringify({
      schemaVersion: "uvp-eth.addresses.v1",
      activeDeploymentId: `0x${"ff".repeat(32)}`,
      stateMachineDeployments: [
        {
          deploymentId: `0x${"01".repeat(32)}`,
          stateMachineAddress: "0x1111111111111111111111111111111111111111",
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
          address: "0x1111111111111111111111111111111111111111",
          deployment: { blockNumber: 20 }
        },
        UVPIdentityRegistry: {
          address: "0x2222222222222222222222222222222222222222",
          deployment: { blockNumber: 18 }
        }
      }
    }));
    const env = stagingEnv(tempDirs, {
      UVP_ADDRESS_MANIFEST: manifestPath
    });
    const config = loadConfigFromEnv(env);
    await expect(runConfigPreflight(config, {
      env,
      clients: stagingPreflightClients()
    })).rejects.toThrow(/activeDeploymentId .* does not match any deployment/);
  });

  it("fails strict preflight when no deployment is explicitly active", async () => {
    const manifestDir = mkdtempSync(join(tmpdir(), "uvp-chain-services-no-active-"));
    tempDirs.push(manifestDir);
    const manifestPath = join(manifestDir, "addresses.no-active.json");
    const modules = {
      stagePatch: "0x4444444444444444444444444444444444444444",
      derivedSignal: "0x5555555555555555555555555555555555555555",
      docking: "0x6666666666666666666666666666666666666666",
      planMetadata: "0x8888888888888888888888888888888888888888",
      orderLink: "0x9999999999999999999999999999999999999999",
      lens: "0x7777777777777777777777777777777777777777"
    };
    writeFileSync(manifestPath, JSON.stringify({
      schemaVersion: "uvp-eth.addresses.v1",
      stateMachineDeployments: [
        {
          deploymentId: `0x${"01".repeat(32)}`,
          stateMachineAddress: "0x1111111111111111111111111111111111111111",
          modules,
          deploymentBlock: "20"
        },
        {
          deploymentId: `0x${"02".repeat(32)}`,
          stateMachineAddress: "0x1212121212121212121212121212121212121212",
          modules,
          deploymentBlock: "30"
        }
      ],
      contracts: {
        UVPStateMachine: {
          address: "0x1111111111111111111111111111111111111111",
          deployment: { blockNumber: 20 }
        },
        UVPIdentityRegistry: {
          address: "0x2222222222222222222222222222222222222222",
          deployment: { blockNumber: 18 }
        }
      }
    }));
    const env = stagingEnv(tempDirs, {
      UVP_ADDRESS_MANIFEST: manifestPath
    });
    await expect(runConfigPreflight(loadConfigFromEnv(env), {
      env,
      clients: stagingPreflightClients()
    })).rejects.toThrow(/must contain exactly one status=active deployment/);
  });

  it("rejects flat module contract keys that diverge from deployment module manifests", async () => {
    const manifestDir = mkdtempSync(join(tmpdir(), "uvp-chain-services-drift-"));
    tempDirs.push(manifestDir);
    const manifestPath = join(manifestDir, "addresses.drift.json");
    writeFileSync(manifestPath, JSON.stringify({
      schemaVersion: "uvp-eth.addresses.v1",
      stateMachineDeployments: [
        {
          deploymentId: `0x${"01".repeat(32)}`,
          stateMachineAddress: "0x1111111111111111111111111111111111111111",
          status: "active",
          deploymentBlock: "20",
          modules: {
            stagePatch: "0x4444444444444444444444444444444444444444",
            derivedSignal: "0x5555555555555555555555555555555555555555",
            docking: "0x6666666666666666666666666666666666666666",
            planMetadata: "0x8888888888888888888888888888888888888888",
            orderLink: "0x9999999999999999999999999999999999999999",
            lens: "0x7777777777777777777777777777777777777777"
          }
        }
      ],
      contracts: {
        UVPStateMachine: {
          address: "0x1111111111111111111111111111111111111111",
          deployment: { blockNumber: 20 }
        },
        UVPIdentityRegistry: {
          address: "0x2222222222222222222222222222222222222222",
          deployment: { blockNumber: 18 }
        },
        UVPStagePatchModule: {
          address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          deployment: { blockNumber: 21 }
        }
      }
    }));

    const env = stagingEnv(tempDirs, { UVP_ADDRESS_MANIFEST: manifestPath });
    await expect(runConfigPreflight(loadConfigFromEnv(env), {
      env,
      clients: stagingPreflightClients()
    })).rejects.toThrow(/flat module contract addresses diverge from deployment module manifests/);

    const localConfig = loadConfigFromEnv({
      UVP_ADDRESS_MANIFEST: manifestPath,
      UVP_RPC_URL: "http://127.0.0.1:8545"
    });
    await expect(runConfigPreflight(localConfig, {
      env: { UVP_ADDRESS_MANIFEST: manifestPath }
    })).rejects.toThrow(/UVPStagePatchModule=0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa conflicts with deployment/);
  });

  it("rejects flat UVPStateMachine addresses that diverge from the active deployment", async () => {
    const manifestDir = mkdtempSync(join(tmpdir(), "uvp-chain-services-sm-drift-"));
    tempDirs.push(manifestDir);
    const manifestPath = join(manifestDir, "addresses.sm-drift.json");
    writeFileSync(manifestPath, JSON.stringify({
      schemaVersion: "uvp-eth.addresses.v1",
      stateMachineDeployments: [
        {
          deploymentId: `0x${"02".repeat(32)}`,
          stateMachineAddress: "0x9999999999999999999999999999999999999999",
          status: "active",
          deploymentBlock: "20",
          modules: {
            stagePatch: "0x4444444444444444444444444444444444444444",
            derivedSignal: "0x5555555555555555555555555555555555555555",
            docking: "0x6666666666666666666666666666666666666666",
            planMetadata: "0x8888888888888888888888888888888888888888",
            orderLink: "0x9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a",
            lens: "0x7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c"
          }
        }
      ],
      contracts: {
        UVPStateMachine: {
          address: "0x1111111111111111111111111111111111111111",
          deployment: { blockNumber: 20 }
        }
      }
    }));

    const env = {
      UVP_ADDRESS_MANIFEST: manifestPath,
      UVP_RPC_URL: "http://127.0.0.1:8545"
    };
    await expect(runConfigPreflight(loadConfigFromEnv(env), { env })).rejects.toThrow(
      /contracts\.UVPStateMachine=0x1111111111111111111111111111111111111111 does not match active deployment/
    );
  });

  it("warns when UVP_CONTRACTS_JSON overrides address-manifest contract entries", () => {
    const manifestDir = mkdtempSync(join(tmpdir(), "uvp-chain-services-json-override-"));
    tempDirs.push(manifestDir);
    const manifestPath = join(manifestDir, "addresses.override.json");
    writeFileSync(manifestPath, JSON.stringify({
      schemaVersion: "uvp-eth.addresses.v1",
      contracts: {
        UVPStateMachine: {
          address: "0x1111111111111111111111111111111111111111",
          deployment: { blockNumber: 20 }
        }
      }
    }));

    const env = {
      UVP_ADDRESS_MANIFEST: manifestPath,
      UVP_CONTRACTS_JSON: JSON.stringify({
        UVPStateMachine: "0x9999999999999999999999999999999999999999"
      })
    };
    const diagnostics = buildConfigDiagnostics(loadConfigFromEnv(env), { env });
    expect(diagnostics.warnings).toContainEqual(
      expect.stringContaining("UVP_CONTRACTS_JSON overrides the UVP_ADDRESS_MANIFEST entry for UVPStateMachine")
    );

    const consistentEnv = {
      UVP_ADDRESS_MANIFEST: manifestPath,
      UVP_CONTRACTS_JSON: JSON.stringify({
        UVPStateMachine: "0x1111111111111111111111111111111111111111"
      })
    };
    const consistent = buildConfigDiagnostics(loadConfigFromEnv(consistentEnv), { env: consistentEnv });
    expect(consistent.warnings).not.toContainEqual(
      expect.stringContaining("UVP_CONTRACTS_JSON overrides")
    );
  });

  it("requires wait-for-receipt registration and the reconcile worker in production", () => {
    expect(() => loadConfigFromEnv(productionEnv({
      UVP_PRODUCT_BFF_WAIT_FOR_RECEIPT: undefined
    }))).toThrow(/UVP_PRODUCT_BFF_WAIT_FOR_RECEIPT=true is required in production/);

    expect(() => loadConfigFromEnv(productionEnv({
      RECONCILE_WORKER_ENABLED: undefined
    }))).toThrow(/RECONCILE_WORKER_ENABLED=true is required in production/);
  });

  it("requires wait-for-receipt registration and the reconcile worker in testnet", () => {
    expect(() => loadConfigFromEnv(testnetEnv(testnetPostgresConfigUrl(), {
      UVP_PRODUCT_BFF_WAIT_FOR_RECEIPT: undefined
    }))).toThrow(/UVP_PRODUCT_BFF_WAIT_FOR_RECEIPT=true is required in testnet/);

    expect(() => loadConfigFromEnv(testnetEnv(testnetPostgresConfigUrl(), {
      RECONCILE_WORKER_ENABLED: undefined
    }))).toThrow(/RECONCILE_WORKER_ENABLED=true is required in testnet/);
  });

  it("requires an explicit production chainId and refuses the 31337 fallback", () => {
    expect(() => loadConfigFromEnv(productionEnv({
      UVP_CHAIN_ID: undefined
    }))).toThrow(/UVP_CHAIN_ID must be explicitly configured in production/);
  });

  it("rejects plain-http RPC and S3 endpoints outside local development", () => {
    expect(() => loadConfigFromEnv(testnetEnv(testnetPostgresConfigUrl(), {
      UVP_RPC_URL: "http://base-sepolia.example/rpc"
    }))).toThrow(/UVP_RPC_URL must use https outside local development/);

    expect(() => loadConfigFromEnv(testnetEnv(testnetPostgresConfigUrl(), {
      GOVERNANCE_RPC_URL: "http://base-sepolia.example/rpc"
    }))).toThrow(/GOVERNANCE_RPC_URL must use https outside local development/);

    expect(() => loadConfigFromEnv(stagingEnv(tempDirs, {
      UVP_EVIDENCE_S3_ENDPOINT: "http://objects.example"
    }))).toThrow(/UVP_EVIDENCE_S3_ENDPOINT must use https outside local development/);

    expect(() => loadConfigFromEnv(stagingEnv(tempDirs, {
      UVP_EVIDENCE_S3_ENDPOINT: "http://127.0.0.1:9000"
    }))).not.toThrow();
  });

  it("requires an informed acknowledgement for testnet auto migrations", () => {
    expect(() => loadConfigFromEnv(testnetEnv(testnetPostgresConfigUrl(), {
      UVP_TESTNET_ALLOW_AUTO_MIGRATIONS: undefined
    }))).toThrow(/UVP_TESTNET_ALLOW_AUTO_MIGRATIONS=1/);
  });

  it("enforces a finality confirmation floor of 2 in production preflight under the confirmations anchor", async () => {
    const floorEnv = productionEnv({
      UVP_FINALITY_ANCHOR: "confirmations",
      UVP_FINALITY_CONFIRMATIONS: "1"
    });
    await expect(runConfigPreflight(loadConfigFromEnv(floorEnv), {
      env: floorEnv,
      clients: productionPreflightClients()
    })).rejects.toThrow(/UVP_FINALITY_CONFIRMATIONS must be at least 2 in production when UVP_FINALITY_ANCHOR=confirmations/);

    const finalizedEnv = productionEnv({
      UVP_FINALITY_CONFIRMATIONS: undefined
    });
    const finalizedConfig = loadConfigFromEnv(finalizedEnv);
    expect(finalizedConfig.network.finalityAnchor).toBe("finalized");
    const finalizedPreflightError = await runConfigPreflight(finalizedConfig, {
      env: finalizedEnv,
      clients: stagingPreflightClients()
    }).then(() => undefined, (error: unknown) => error);
    expect(String((finalizedPreflightError as Error)?.message ?? "")).not.toMatch(/finality_confirmations/);
  });

  it("fails staging preflight on signer mismatch, missing bytecode reads, or governance owner mismatch", async () => {
    const relayerMismatchEnv = stagingEnv(tempDirs, {
      UVP_RELAYER_GAS_PAYER_ADDRESS: "0x9999999999999999999999999999999999999999"
    });
    await expect(runConfigPreflight(loadConfigFromEnv(relayerMismatchEnv), {
      env: relayerMismatchEnv,
      clients: stagingPreflightClients()
    })).rejects.toThrow(/relayer private key does not match configured relayer gas payer address/);

    const deployerMismatchEnv = stagingEnv(tempDirs, {
      UVP_ETH_DEPLOYER_ADDRESS: "0x9999999999999999999999999999999999999999"
    });
    await expect(runConfigPreflight(loadConfigFromEnv(deployerMismatchEnv), {
      env: deployerMismatchEnv,
      clients: stagingPreflightClients()
    })).rejects.toThrow(/does not match UVP_ETH_DEPLOYER_ADDRESS/);

    const env = stagingEnv(tempDirs);
    await expect(runConfigPreflight(loadConfigFromEnv(env), {
      env,
      clients: {
        network: { getChainId: async () => 84532 },
        governance: {
          getChainId: async () => 84532,
          readContract: async () => stagingGovernanceAddress
        }
      }
    })).rejects.toThrow(/preflight client must read contract bytecode/);

    const governanceMismatchEnv = stagingEnv(tempDirs);
    await expect(runConfigPreflight(loadConfigFromEnv(governanceMismatchEnv), {
      env: governanceMismatchEnv,
      clients: {
        network: {
          getChainId: async () => 84532,
          getBytecode: async () => "0x01"
        },
        governance: {
          getChainId: async () => 84532,
          readContract: async () => "0x9999999999999999999999999999999999999999"
        }
      }
    })).rejects.toThrow(/on-chain governance registry owner does not match GOVERNANCE_REGISTRY_OWNER_ADDRESS/);
  });

  it("requires the managed-database poll gates in production as well", () => {
    expect(() => loadConfigFromEnv(productionEnv({
      UVP_INDEXER_POLL_INTERVAL_MS: undefined
    }))).toThrow(/UVP_INDEXER_POLL_INTERVAL_MS must be explicitly configured/);

    expect(() => loadConfigFromEnv(productionEnv({
      UVP_INDEXER_POLL_INTERVAL_MS: "0"
    }))).toThrow(/UVP_INDEXER_POLL_DISABLED_ACK=1/);

    expect(() => loadConfigFromEnv(productionEnv({
      UVP_INDEXER_POLL_INTERVAL_MS: "0",
      UVP_INDEXER_POLL_DISABLED_ACK: "1"
    }))).not.toThrow();

    expect(() => loadConfigFromEnv(productionEnv({
      RECONCILE_WORKER_ENABLED: "true",
      RECONCILE_POLL_INTERVAL_MS: "5000"
    }))).toThrow(/RECONCILE_POLL_INTERVAL_MS must be 0 or at least 30000/);
  });

  it("rejects production non-Postgres storage, unsafe migrations, and Anvil default private keys", () => {
    expect(() => loadRawConfigFromEnv({
      CHAIN_SERVICES_RUNTIME_ENV: "production",
      ...storeAuthJwtEnv
    })).toThrow(/CHAIN_SERVICES_DATABASE_URL is required/);

    expect(() => loadConfigFromEnv(productionEnv({
      CHAIN_SERVICES_DATABASE_URL: "not-a-database-url"
    }))).toThrow(/CHAIN_SERVICES_DATABASE_URL must be a postgres:\/\/ \(or postgresql:\/\/\) DSN/);

    expect(() => loadConfigFromEnv(productionEnv({
      CHAIN_SERVICES_MIGRATIONS_AUTO_RUN: "true"
    }))).toThrow(/UVP_PRODUCTION_ALLOW_AUTO_MIGRATIONS/);

    expect(() => loadConfigFromEnv(productionEnv({
      GOVERNANCE_SIGNER_PRIVATE_KEY: anvilPrivateKey
    }))).toThrow(/Anvil default private key/);
  });

  it("defaults the finality anchor to the finalized tag and validates the explicit override", () => {
    expect(loadConfigFromEnv().network.finalityAnchor).toBe("finalized");
    expect(loadConfigFromEnv({
      UVP_FINALITY_ANCHOR: "confirmations"
    }).network.finalityAnchor).toBe("confirmations");
    expect(() => loadConfigFromEnv({
      UVP_FINALITY_ANCHOR: "latest"
    })).toThrow(/UVP_FINALITY_ANCHOR must be finalized or confirmations/);

    const { UVP_FINALITY_CONFIRMATIONS: _prodFinality, ...missingProdFinality } = productionEnv();
    expect(loadConfigFromEnv(missingProdFinality).network.finalityAnchor).toBe("finalized");

    const { UVP_FINALITY_CONFIRMATIONS: _testnetFinality, ...missingTestnetFinality } =
      testnetEnv(testnetPostgresConfigUrl());
    expect(loadConfigFromEnv(missingTestnetFinality).network.finalityAnchor).toBe("finalized");
  });

  it("requires an explicit UVP_FINALITY_CONFIRMATIONS in production, staging and testnet under the confirmations anchor; local keeps the default", () => {
    const { UVP_FINALITY_CONFIRMATIONS: _finality, ...missingFinality } = productionEnv({
      UVP_FINALITY_ANCHOR: "confirmations"
    });
    expect(() => loadConfigFromEnv(missingFinality)).toThrow(
      /UVP_FINALITY_CONFIRMATIONS must be explicitly configured/
    );

    expect(() => loadConfigFromEnv(productionEnv({
      UVP_FINALITY_ANCHOR: "confirmations",
      UVP_FINALITY_CONFIRMATIONS: "0"
    }))).toThrow(/UVP_FINALITY_CONFIRMATIONS must be explicitly configured/);

    expect(() => loadConfigFromEnv(productionEnv({
      UVP_FINALITY_ANCHOR: "confirmations",
      UVP_FINALITY_CONFIRMATIONS: "-2"
    }))).toThrow(/UVP_FINALITY_CONFIRMATIONS must be a non-negative safe integer/);

    expect(loadConfigFromEnv(stagingEnv(tempDirs)).network.finalityConfirmations).toBe(12);

    expect(() => loadConfigFromEnv(testnetEnv(testnetPostgresConfigUrl(), {
      UVP_FINALITY_ANCHOR: "confirmations",
      UVP_FINALITY_CONFIRMATIONS: undefined
    }))).toThrow(
      /UVP_FINALITY_CONFIRMATIONS must be explicitly configured to a positive integer in testnet/
    );
    expect(() => loadConfigFromEnv(testnetEnv(testnetPostgresConfigUrl(), {
      UVP_FINALITY_ANCHOR: "confirmations",
      UVP_FINALITY_CONFIRMATIONS: "0"
    }))).toThrow(/UVP_FINALITY_CONFIRMATIONS must be explicitly configured to a positive integer in testnet/);

    expect(loadConfigFromEnv().network.finalityConfirmations).toBe(1);
  });

  it("requires fully configured s3 evidence storage in production", () => {
    const { UVP_EVIDENCE_STORAGE_ADAPTER: _adapter, ...missingAdapter } = productionEnv();
    expect(() => loadConfigFromEnv(missingAdapter)).toThrow(
      /UVP_EVIDENCE_STORAGE_ADAPTER=s3 is required in production/
    );

    expect(() => loadConfigFromEnv(productionEnv({
      UVP_EVIDENCE_STORAGE_ADAPTER: "local"
    }))).toThrow(/UVP_EVIDENCE_STORAGE_ADAPTER=s3 is required in production/);

    expect(() => loadConfigFromEnv(productionEnv({
      UVP_EVIDENCE_STORAGE_ADAPTER: "rehearsal-object"
    }))).toThrow(/UVP_EVIDENCE_STORAGE_ADAPTER=s3 is required in production/);

    const { UVP_EVIDENCE_S3_BUCKET: _bucket, ...missingBucket } = productionEnv();
    expect(() => loadConfigFromEnv(missingBucket)).toThrow(
      /UVP_EVIDENCE_S3_BUCKET is required in production/
    );

    const { UVP_EVIDENCE_S3_REGION: _region, ...missingRegion } = productionEnv();
    expect(() => loadConfigFromEnv(missingRegion)).toThrow(
      /UVP_EVIDENCE_S3_REGION is required in production/
    );

    const { UVP_EVIDENCE_S3_ACCESS_KEY_ID_ENV: _accessKeyEnv, ...missingAccessKeyEnv } = productionEnv();
    expect(() => loadConfigFromEnv(missingAccessKeyEnv)).toThrow(
      /UVP_EVIDENCE_S3_ACCESS_KEY_ID_ENV is required in production/
    );

    const { UVP_EVIDENCE_S3_SECRET_ACCESS_KEY_ENV: _secretKeyEnv, ...missingSecretKeyEnv } = productionEnv();
    expect(() => loadConfigFromEnv(missingSecretKeyEnv)).toThrow(
      /UVP_EVIDENCE_S3_SECRET_ACCESS_KEY_ENV is required in production/
    );
  });

  it("rejects production demo, test controls, permissive auth, redaction gaps, and mock registration", () => {
    expect(loadConfigFromEnv(productionEnv()).security.environment).toBe("production");

    expect(loadConfigFromEnv(productionEnv({
      UVP_PRODUCT_DEMO_MODE: "1"
    })).security.environment).toBe("production");

    expect(() => loadConfigFromEnv(productionEnv({
      UVP_PRODUCT_SUBMISSION_AUTHORIZATION: "permissive"
    }))).toThrow(/permissive Product submission authorization/);

    expect(() => loadConfigFromEnv(productionEnv({
      SECURITY_PREFLIGHT_STRICT: "false"
    }))).toThrow(/SECURITY_PREFLIGHT_STRICT=false/);

    expect(() => loadConfigFromEnv(productionEnv({
      LOG_REDACTION_ENABLED: "false"
    }))).toThrow(/LOG_REDACTION_ENABLED=false/);

    expect(() => loadConfigFromEnv(productionEnv({
      STORE_AUTH_MODE: "dev_headers"
    }))).toThrow(/dev_headers is only allowed in local/);

    expect(() => loadConfigFromEnv(productionEnv({
      STORE_AUTH_ISSUER: "http://localhost:8789/"
    }))).toThrow(/STORE_AUTH_ISSUER must be HTTPS/);

    const { STORE_AUTH_AUDIENCE: _audience, ...missingAudience } = productionEnv();
    expect(() => loadConfigFromEnv(missingAudience)).toThrow(/STORE_AUTH_AUDIENCE/);

    expect(() => loadConfigFromEnv(productionEnv({
      UVP_PRODUCT_BFF_REGISTRATION_ADAPTER: "memory"
    }))).toThrow(/UVP_PRODUCT_BFF_REGISTRATION_ADAPTER must be memory-trigger or anvil/);

    expect(() => loadConfigFromEnv(productionEnv({
      UVP_PRODUCT_BFF_REGISTRATION_ADAPTER: "memory-trigger"
    }))).toThrow(/REGISTRATION_ADAPTER=anvil is required in production/);

    expect(() => loadConfigFromEnv(productionEnv({
      GOVERNANCE_BROADCAST_ENABLED: "true",
      GOVERNANCE_SIGNER_PRIVATE_KEY: productionRelayerPrivateKey
    }))).toThrow(/env private-key governance and is forbidden in production/);
  });

  it("accepts vendor-neutral OIDC discovery as the Store JWT key source", () => {
    const config = loadConfigFromEnv(stagingEnv(tempDirs, {
      STORE_AUTH_JWKS_URL: undefined,
      STORE_AUTH_OIDC_DISCOVERY_URL: "https://identity.example/.well-known/openid-configuration"
    }));

    expect(config.storeAuth).toMatchObject({
      mode: "jwt",
      oidcDiscoveryUrl: "https://identity.example/.well-known/openid-configuration",
      issuer: "https://identity.example/",
      audience: "uvp-store"
    });
    expect(config.storeAuth?.jwksUrl).toBeUndefined();
  });

  it("requires production chain contracts and relay signer configuration", () => {
    expect(() => loadConfigFromEnv(productionEnv({
      UVP_CONTRACTS_JSON: JSON.stringify({
        UVPIdentityRegistry: "0x2222222222222222222222222222222222222222"
      })
    }))).toThrow(/UVPStateMachine contract address/);

    expect(() => loadConfigFromEnv(productionEnv({
      UVP_CONTRACTS_JSON: JSON.stringify({
        UVPStateMachine: "0x1111111111111111111111111111111111111111"
      })
    }))).toThrow(/UVPIdentityRegistry contract address/);

    const { UVP_STATE_MACHINE_RELAYER_PRIVATE_KEY: _privateKey, ...missingRelayer } = productionEnv();
    expect(() => loadConfigFromEnv(missingRelayer)).toThrow(/UVP_STATE_MACHINE_RELAYER_PRIVATE_KEY is required/);
  });

  it("fails production preflight when unsafe env is injected after config load", async () => {
    const config = loadConfigFromEnv(productionEnv());

    await expect(runConfigPreflight(config, {
      env: productionEnv({ UVP_PRODUCT_PERMISSIVE_AUTH: "1" }),
      clients: {
        network: { getChainId: async () => 31337 }
      }
    })).rejects.toThrow(/permissive Product submission authorization/);
  });

  it("fails strict preflight on RPC chainId mismatch before serving traffic", async () => {
    const config = loadConfigFromEnv({
      SECURITY_PREFLIGHT_STRICT: "true",
      UVP_CHAIN_ID: "1"
    });

    await expect(runConfigPreflight(config, {
      env: {},
      clients: {
        network: { getChainId: async () => 31337 }
      }
    })).rejects.toThrow(/RPC chainId 31337 does not match configured chainId 1/);
  });

  it("fails preflight when relayer private key is configured without a state-machine address", async () => {
    const env = {
      UVP_STATE_MACHINE_RELAYER_PRIVATE_KEY: "0x1111111111111111111111111111111111111111111111111111111111111111"
    };
    const config = loadConfigFromEnv(env);

    await expect(runConfigPreflight(config, { env })).rejects.toThrow(/UVPStateMachine contract address is required/);
  });

  it("fails preflight when relayer broadcast is enabled without a relayer key", async () => {
    const env = {
      UVP_CONTRACTS_JSON: JSON.stringify({
        UVPStateMachine: "0x1111111111111111111111111111111111111111"
      }),
      UVP_STATE_MACHINE_RELAYER_BROADCAST_ENABLED: "true"
    };
    const config = loadConfigFromEnv(env);

    await expect(runConfigPreflight(config, { env })).rejects.toThrow(/UVP_STATE_MACHINE_RELAYER_PRIVATE_KEY is required when relayer broadcast is enabled/);
  });

  it("fails preflight when configured registrar or relayer addresses do not match their private keys", async () => {
    const relayerEnv = {
      UVP_CONTRACTS_JSON: JSON.stringify({
        UVPStateMachine: "0x1111111111111111111111111111111111111111"
      }),
      UVP_STATE_MACHINE_RELAYER_PRIVATE_KEY: productionRelayerPrivateKey,
      UVP_RELAYER_GAS_PAYER_ADDRESS: "0x9999999999999999999999999999999999999999"
    };
    await expect(runConfigPreflight(loadConfigFromEnv(relayerEnv), { env: relayerEnv }))
      .rejects.toThrow(/relayer private key does not match configured relayer gas payer address/);

    const registrarEnv = {
      UVP_CONTRACTS_JSON: JSON.stringify({
        UVPStateMachine: "0x1111111111111111111111111111111111111111"
      }),
      UVP_PRODUCT_BFF_REGISTRATION_ADAPTER: "anvil",
      UVP_PRODUCT_BFF_REGISTRAR_PRIVATE_KEY: productionRegistrarPrivateKey,
      UVP_ORDER_REGISTRAR_ADDRESS: "0x9999999999999999999999999999999999999999"
    };
    await expect(runConfigPreflight(loadConfigFromEnv(registrarEnv), { env: registrarEnv }))
      .rejects.toThrow(/does not match configured order registrar address/);
  });

  it("rejects staging when log redaction is disabled or Anvil defaults are used", async () => {
    const redactionEnv = {
      ...stagingEnv(tempDirs),
      LOG_REDACTION_ENABLED: "false"
    };
    expect(() => loadConfigFromEnv(redactionEnv)).toThrow(/LOG_REDACTION_ENABLED=false is forbidden in staging/);

    const keyEnv = {
      ...stagingEnv(tempDirs),
      UVP_STAGING_RELAYER_PRIVATE_KEY: anvilPrivateKey
    };
    expect(() => loadConfigFromEnv(keyEnv)).toThrow(/Anvil default private key/);
  });

  it("resolves the governance signer key via GOVERNANCE_SIGNER_PRIVATE_KEY_ENV and fails loudly when missing", () => {
    const namedEnv = loadConfigFromEnv({
      GOVERNANCE_BROADCAST_ENABLED: "true",
      GOVERNANCE_SIGNER_PRIVATE_KEY_ENV: "UVP_STAGING_GOVERNANCE_SIGNER_PRIVATE_KEY",
      UVP_STAGING_GOVERNANCE_SIGNER_PRIVATE_KEY: testnetRegistrarPrivateKey
    });
    expect(namedEnv.governance.signerPrivateKeyEnv).toBe("UVP_STAGING_GOVERNANCE_SIGNER_PRIVATE_KEY");
    expect(namedEnv.governance.signerPrivateKey).toBe(testnetRegistrarPrivateKey);

    expect(() => loadConfigFromEnv({
      GOVERNANCE_BROADCAST_ENABLED: "true",
      GOVERNANCE_SIGNER_PRIVATE_KEY_ENV: "UVP_STAGING_GOVERNANCE_SIGNER_PRIVATE_KEY"
    })).toThrow(/UVP_STAGING_GOVERNANCE_SIGNER_PRIVATE_KEY is required when GOVERNANCE_BROADCAST_ENABLED=true/);

    const defaultValueForm = loadConfigFromEnv({
      GOVERNANCE_BROADCAST_ENABLED: "true",
      GOVERNANCE_SIGNER_PRIVATE_KEY: testnetRegistrarPrivateKey
    });
    expect(defaultValueForm.governance.signerPrivateKeyEnv).toBe("GOVERNANCE_SIGNER_PRIVATE_KEY");
    expect(defaultValueForm.governance.signerPrivateKey).toBe(testnetRegistrarPrivateKey);

    const { UVP_STAGING_GOVERNANCE_SIGNER_PRIVATE_KEY: _stagingKey, ...missingStagingKey } = stagingEnv(tempDirs);
    expect(() => loadConfigFromEnv(missingStagingKey)).toThrow(
      /UVP_STAGING_GOVERNANCE_SIGNER_PRIVATE_KEY is required/
    );
  });

  it("fails strict governance preflight when signer or registry owner does not match chain state", async () => {
    const env = testnetEnv(testnetPostgresConfigUrl(), {
      GOVERNANCE_BROADCAST_ENABLED: "true",
      GOVERNANCE_SIGNER_PRIVATE_KEY: productionRelayerPrivateKey,
      GOVERNANCE_REGISTRY_OWNER_ADDRESS: "0x8888888888888888888888888888888888888888"
    });
    const config = loadConfigFromEnv(env);

    await expect(runConfigPreflight(config, {
      env,
      clients: {
        network: {
          getChainId: async () => 84532,
          getBytecode: async () => "0x01"
        },
        governance: {
          getChainId: async () => 84532,
          readContract: async () => "0x9999999999999999999999999999999999999999"
        }
      }
    })).rejects.toThrow(/on-chain governance registry owner does not match GOVERNANCE_REGISTRY_OWNER_ADDRESS/);
  });

  it("drops the query string when a logged URL cannot be parsed", () => {
    const malformed = "https://exa mple.com/path?token=raw-secret-value";
    const redacted = redactSecrets({ url: malformed });
    expect(redacted.url).toBe("https://exa mple.com/path?[redacted]");
  });

  it("keeps 64-hex business identifiers and only redacts secrets by key name or labeled text", () => {
    const orderId = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const prepareId = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const redacted = redactSecrets({
      planId: orderId,
      message: `order ${orderId} prepared as ${prepareId} is ready`,
      nested: { orderId, hookId: prepareId }
    }) as { planId: string; message: string; nested: { orderId: string; hookId: string } };

    expect(redacted.planId).toBe(orderId);
    expect(redacted.message).toContain(orderId);
    expect(redacted.message).toContain(prepareId);
    expect(redacted.nested.orderId).toBe(orderId);
    expect(redacted.nested.hookId).toBe(prepareId);

    const secretsRedacted = redactSecrets({
      private_key: "0x1111111111111111111111111111111111111111111111111111111111111111",
      signature: `0x${"aa".repeat(65)}`,
      auth_token: "token-value",
      errorText: `signing failed: private key 0x2222222222222222222222222222222222222222222222222222222222222222 is invalid`,
      signatureText: `broadcast returned sig 0x${"bb".repeat(65)}`
    }) as { private_key: string; signature: string; auth_token: string; errorText: string; signatureText: string };

    expect(secretsRedacted.private_key).toBe("[redacted:secret]");
    expect(secretsRedacted.signature).toBe("[redacted:secret]");
    expect(secretsRedacted.auth_token).toBe("[redacted:secret]");
    expect(secretsRedacted.errorText).not.toContain("22222222222222222222222222222222");
    expect(secretsRedacted.errorText).toContain("[redacted:secret]");
    expect(secretsRedacted.signatureText).not.toContain("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  });

  it("redacts secrets and exposes safe health diagnostics", async () => {
    const rpcUrl = "https://rpc.example/path?api_key=rpc-secret&chain=local";
    const redacted = redactSecrets({
      privateKey: "0x1111111111111111111111111111111111111111111111111111111111111111",
      signature: `0x${"aa".repeat(65)}`,
      adminToken: "admin-secret",
      authorization: "Bearer admin-secret",
      rpcUrl,
      storageURI: "s3://object-user:object-password@private-bucket/evidence?X-Amz-Signature=object-secret&X-Amz-Credential=object-credential&AWSAccessKeyId=object-key&sig=object-sig",
      rawCalldata: `0x${"12".repeat(80)}`
    });

    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain("admin-secret");
    expect(serialized).not.toContain("rpc-secret");
    expect(serialized).not.toContain("object-secret");
    expect(serialized).not.toContain("object-credential");
    expect(serialized).not.toContain("object-password");
    expect(serialized).not.toContain("object-key");
    expect(serialized).not.toContain("object-sig");
    expect(serialized).not.toContain("1111111111111111111111111111111111111111111111111111111111111111");
    expect(serialized).not.toContain("1212121212121212");

    const config = loadConfigFromEnv({
      UVP_CONTRACTS_JSON: JSON.stringify({
        UVPStateMachine: "0x1111111111111111111111111111111111111111"
      }),
      UVP_STATE_MACHINE_RELAYER_PRIVATE_KEY: "0x2222222222222222222222222222222222222222222222222222222222222222"
    });
    const diagnostics = buildConfigDiagnostics(config, {
      env: {
        UVP_STATE_MACHINE_RELAYER_PRIVATE_KEY: "0x2222222222222222222222222222222222222222222222222222222222222222"
      }
    });
    const store = new PostgresProjectionStore({
      databaseUrl: await createPostgresTestDatabase()
    });
    const router = createApiRouter(store, { ...requiredRouterStores(), submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111", configDiagnostics: diagnostics });
    const response = await router.handle({ method: "GET", pathname: "/healthz" });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      status: "ok",
      sourceOfTruth: "contracts-and-chain-events"
    });
    expect((response.body as Record<string, unknown>).diagnostics).toBeUndefined();

    const adminResponse = await router.handle({
      method: "GET",
      pathname: "/admin/diagnostics",
      headers: { "x-uvp-admin-id": "local-admin", "x-uvp-admin-role": "governance_admin" }
    });
    expect(adminResponse.status).toBe(200);
    expect(adminResponse.body).toMatchObject({
      diagnostics: {
        environment: "local",
        storageDriver: "postgres",
        relayerConfigured: true,
        relayer: { configured: true },
        governance: { broadcastEnabled: false },
        storage: { driver: "postgres" },
        product: {
          registrationAdapter: "memory-trigger",
          permissiveAuthorizationRequested: false
        },
        security: {
          logRedactionEnabled: true
        }
      }
    });
    expect(JSON.stringify(adminResponse.body)).not.toContain("2222222222222222222222222222222222222222222222222222222222222222");
    await store.close();
  });

});

function productionEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    CHAIN_SERVICES_RUNTIME_ENV: "production",
    CHAIN_SERVICES_DATABASE_URL: "postgres://uvp:db-secret@prod-db.internal:5432/uvp",
    CHAIN_SERVICES_MIGRATIONS_AUTO_RUN: "false",
    UVP_PRODUCT_BFF_WAIT_FOR_RECEIPT: "true",
    RECONCILE_WORKER_ENABLED: "true",
    ...storeAuthJwtEnv,
    UVP_CONTRACTS_JSON: productionContracts,
    UVP_EVIDENCE_STORAGE_ADAPTER: "s3",
    UVP_EVIDENCE_S3_BUCKET: "uvp-production-evidence",
    UVP_EVIDENCE_S3_REGION: "us-east-1",
    UVP_EVIDENCE_S3_ACCESS_KEY_ID_ENV: "UVP_PRODUCTION_EVIDENCE_S3_ACCESS_KEY_ID",
    UVP_EVIDENCE_S3_SECRET_ACCESS_KEY_ENV: "UVP_PRODUCTION_EVIDENCE_S3_SECRET_ACCESS_KEY",
    UVP_PRODUCT_BFF_REGISTRATION_ADAPTER: "anvil",
    UVP_PRODUCT_BFF_REGISTRAR_PRIVATE_KEY: productionRegistrarPrivateKey,
    UVP_STATE_MACHINE_RELAYER_PRIVATE_KEY: productionRelayerPrivateKey,
    UVP_CHAIN_ID: "8453",
    UVP_FINALITY_CONFIRMATIONS: "12",
    UVP_RPC_URL: "https://base-mainnet.example/rpc",
    GOVERNANCE_ADMIN_REVIEWER_IDS: "gov-reviewer-1",
    OPS_CONSOLE_ADMIN_IDS: "ops-admin-1",
    GOVERNANCE_ADMIN_TOKEN_HASHES: "f7a03f48c0e2aa2d5e55ca186c20032ddbf53b7f5f93fce387d65c3f83433e8d",
    UVP_INDEXER_POLL_INTERVAL_MS: "5000",
    RECONCILE_POLL_INTERVAL_MS: "30000",
    ...storeAuthJwtEnv,
    ...overrides
  };
}

function productionSafeEvidenceStorage(): ObjectEvidenceStorage {
  return new ObjectEvidenceStorage({
    client: {
      async put(input) {
        return {
          storageURI: `object://evidence/${encodeURIComponent(input.evidenceId)}`,
          size: input.bytes.byteLength
        };
      },
      async get() {
        return undefined;
      },
      async exists() {
        return false;
      }
    }
  });
}

function testnetEnv(databaseUrl: string, overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    CHAIN_SERVICES_RUNTIME_ENV: "testnet",
    CHAIN_SERVICES_DATABASE_URL: databaseUrl,
    CHAIN_SERVICES_MIGRATIONS_AUTO_RUN: "true",
    UVP_TESTNET_ALLOW_AUTO_MIGRATIONS: "1",
    UVP_INDEXER_POLL_INTERVAL_MS: "5000",
    UVP_CHAIN_ID: "84532",
    UVP_RPC_URL: "https://base-sepolia.example/rpc",
    UVP_CONTRACTS_JSON: productionContracts,
    UVP_PRODUCT_BFF_REGISTRATION_ADAPTER: "anvil",
    UVP_PRODUCT_BFF_REGISTRAR_PRIVATE_KEY: testnetRegistrarPrivateKey,
    UVP_STATE_MACHINE_RELAYER_PRIVATE_KEY: testnetRelayerPrivateKey,
    UVP_EVIDENCE_STORAGE_ADAPTER: "rehearsal-object",
    UVP_PRODUCT_BFF_WAIT_FOR_RECEIPT: "true",
    RECONCILE_WORKER_ENABLED: "true",
    RECONCILE_POLL_INTERVAL_MS: "30000",
    UVP_FINALITY_CONFIRMATIONS: "12",
    ...storeAuthJwtEnv,
    GOVERNANCE_ADMIN_REVIEWER_IDS: "gov-reviewer-1",
    OPS_CONSOLE_ADMIN_IDS: "ops-admin-1",
    GOVERNANCE_ADMIN_TOKEN_HASHES: "f7a03f48c0e2aa2d5e55ca186c20032ddbf53b7f5f93fce387d65c3f83433e8d",
    ...overrides
  };
}

function stagingEnv(tempDirs: string[], overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    CHAIN_SERVICES_RUNTIME_ENV: "staging",
    SECURITY_PREFLIGHT_STRICT: "true",
    LOG_REDACTION_ENABLED: "true",
    CHAIN_SERVICES_DATABASE_URL: "postgres://uvp:db-secret@staging-db.internal:5432/uvp",
    CHAIN_SERVICES_MIGRATIONS_AUTO_RUN: "false",
    UVP_INDEXER_POLL_INTERVAL_MS: "5000",
    ...storeAuthJwtEnv,
    UVP_CHAIN_ID: "84532",
    UVP_RPC_URL: "https://base-sepolia.example/rpc?api_key=rpc-secret",
    UVP_ADDRESS_MANIFEST: stagingManifestPath(tempDirs),
    UVP_FINALITY_CONFIRMATIONS: "12",
    UVP_PRODUCT_BFF_REGISTRATION_ADAPTER: "anvil",
    UVP_PRODUCT_BFF_REGISTRAR_PRIVATE_KEY_ENV: "UVP_STAGING_ORDER_REGISTRAR_PRIVATE_KEY",
    UVP_STAGING_ORDER_REGISTRAR_PRIVATE_KEY: productionRegistrarPrivateKey,
    UVP_ORDER_REGISTRAR_ADDRESS: productionRegistrarAddress,
    UVP_PRODUCT_BFF_WAIT_FOR_RECEIPT: "true",
    UVP_STATE_MACHINE_RELAYER_BROADCAST_ENABLED: "true",
    UVP_STATE_MACHINE_RELAYER_PRIVATE_KEY_ENV: "UVP_STAGING_RELAYER_PRIVATE_KEY",
    UVP_STAGING_RELAYER_PRIVATE_KEY: productionRelayerPrivateKey,
    UVP_RELAYER_GAS_PAYER_ADDRESS: productionRelayerAddress,
    UVP_EVIDENCE_STORAGE_ADAPTER: "s3",
    UVP_EVIDENCE_S3_BUCKET: "uvp-staging-evidence",
    UVP_EVIDENCE_S3_REGION: "us-east-1",
    UVP_EVIDENCE_S3_ENDPOINT: "https://objects.example",
    UVP_EVIDENCE_S3_PREFIX: "staging/evidence",
    UVP_EVIDENCE_S3_FORCE_PATH_STYLE: "true",
    UVP_EVIDENCE_S3_ACCESS_KEY_ID_ENV: "UVP_STAGING_EVIDENCE_S3_ACCESS_KEY_ID",
    UVP_EVIDENCE_S3_SECRET_ACCESS_KEY_ENV: "UVP_STAGING_EVIDENCE_S3_SECRET_ACCESS_KEY",
    UVP_STAGING_EVIDENCE_S3_ACCESS_KEY_ID: "AKIASTAGING",
    UVP_STAGING_EVIDENCE_S3_SECRET_ACCESS_KEY: "object-secret",
    UVP_ETH_DEPLOYER_PRIVATE_KEY_ENV: "UVP_STAGING_DEPLOYER_PRIVATE_KEY",
    UVP_STAGING_DEPLOYER_PRIVATE_KEY: testnetRelayerPrivateKey,
    UVP_ETH_DEPLOYER_ADDRESS: stagingDeployerAddress,
    UVP_STATE_MACHINE_OWNER_ADDRESS: "0x3333333333333333333333333333333333333333",
    UVP_PLAN_PUBLISHER_ADDRESS: "0x4444444444444444444444444444444444444444",
    UVP_REHEARSAL_PARTICIPANT_WALLETS: "0x7777777777777777777777777777777777777777",
    GOVERNANCE_BROADCAST_ENABLED: "true",
    GOVERNANCE_REGISTRY_OWNER_ADDRESS: stagingGovernanceAddress,
    GOVERNANCE_SIGNER_ADDRESS: stagingGovernanceAddress,
    GOVERNANCE_SIGNER_PRIVATE_KEY_ENV: "UVP_STAGING_GOVERNANCE_SIGNER_PRIVATE_KEY",
    UVP_STAGING_GOVERNANCE_SIGNER_PRIVATE_KEY: testnetRegistrarPrivateKey,
    GOVERNANCE_ADMIN_REVIEWER_IDS: "gov-reviewer-1",
    OPS_CONSOLE_ADMIN_IDS: "ops-admin-1",
    GOVERNANCE_ADMIN_TOKEN_HASHES: "f7a03f48c0e2aa2d5e55ca186c20032ddbf53b7f5f93fce387d65c3f83433e8d",
    RECONCILE_WORKER_ENABLED: "true",
    RECONCILE_POLL_INTERVAL_MS: "30000",
    UVP_PRODUCT_DEMO_MODE: "0",
    UVP_PRODUCT_PERMISSIVE_AUTH: "0",
    ...storeAuthJwtEnv,
    ...overrides
  };
}

function stagingManifestPath(tempDirs: string[], filename = "staging.addresses.json"): string {
  const dir = mkdtempSync(join(tmpdir(), "uvp-chain-services-staging-"));
  tempDirs.push(dir);
  const manifestPath = join(dir, filename);
  writeFileSync(manifestPath, JSON.stringify({
    schemaVersion: "uvp-eth.addresses.v1",
    network: {
      chainId: 84532,
      rpcUrlEnv: "UVP_RPC_URL"
    },
    deployment: {
      blockNumber: 100
    },
    contracts: {
      UVPStateMachine: {
        address: "0x1111111111111111111111111111111111111111",
        deployment: { blockNumber: 110 }
      },
      UVPIdentityRegistry: {
        address: "0x2222222222222222222222222222222222222222",
        deployment: { blockNumber: 111 }
      }
    },
    stateMachineDeployments: [
      {
        deploymentId: "0x" + "ab".repeat(32),
        stateMachineAddress: "0x1111111111111111111111111111111111111111",
        status: "active",
        deploymentBlock: 110,
        modules: {
          stagePatch: "0x1212121212121212121212121212121212121212",
          derivedSignal: "0x1313131313131313131313131313131313131313",
          docking: "0x1414141414141414141414141414141414141414",
          planMetadata: "0x1515151515151515151515151515151515151515",
          orderLink: "0x1616161616161616161616161616161616161616",
          lens: "0x1717171717171717171717171717171717171717"
        }
      }
    ]
  }));
  return manifestPath;
}

function productionPreflightClients() {
  return {
    network: {
      getChainId: async () => 8453,
      getBytecode: async () => "0x01" as const
    }
  };
}

function stagingPreflightClients() {
  const manifestModuleByGetter: Record<string, string> = {
    stagePatchModule: "0x1212121212121212121212121212121212121212",
    derivedSignalModule: "0x1313131313131313131313131313131313131313",
    dockingModule: "0x1414141414141414141414141414141414141414",
    planMetadataModule: "0x1515151515151515151515151515151515151515",
    orderLinkModule: "0x1616161616161616161616161616161616161616",
    lens: "0x1717171717171717171717171717171717171717"
  };
  return {
    network: {
      getChainId: async () => 84532,
      getBytecode: async () => "0x01" as const,
      readContract: async (call: { functionName: string }) =>
        manifestModuleByGetter[call.functionName] ?? "0x0000000000000000000000000000000000000000"
    },
    governance: {
      getChainId: async () => 84532,
      readContract: async () => stagingGovernanceAddress
    }
  };
}

function testnetPostgresConfigUrl(): string {
  return "postgres://uvp:db-secret@testnet-db.internal:5432/uvp";
}
