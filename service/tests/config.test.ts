import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildConfigDiagnostics, loadConfigFromEnv, runConfigPreflight } from "../src/config/index.js";
import { createApiRouter } from "../src/api/routes.js";
import { ObjectEvidenceStorage } from "../src/evidence/index.js";
import { MemoryProjectionStore } from "../src/storage/projection-store.js";
import { redactSecrets } from "../src/security/index.js";

const anvilPrivateKey = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const productionRelayerPrivateKey = "0x1111111111111111111111111111111111111111111111111111111111111111";
const productionRelayerAddress = "0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a";
const productionRegistrarPrivateKey = "0x2222222222222222222222222222222222222222222222222222222222222222";
const productionRegistrarAddress = "0x1563915e194d8cfba1943570603f7606a3115508";
const productionContracts = JSON.stringify({
  UVPStateMachine: "0x1111111111111111111111111111111111111111",
  ZhixuTrustRegistry: "0x2222222222222222222222222222222222222222"
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
        ZhixuTrustRegistry: {
          address: "0x2222222222222222222222222222222222222222",
          deployment: { blockNumber: 12 }
        }
      }
    }));

    const config = loadConfigFromEnv({
      UVP_ADDRESS_MANIFEST: manifestPath,
      ANVIL_RPC_URL: "http://127.0.0.1:18545",
      UVP_CONTRACTS_JSON: JSON.stringify({
        ZhixuTrustRegistry: "0x3333333333333333333333333333333333333333"
      })
    });

    expect(config.network.chainId).toBe(31337);
    expect(config.network.rpcUrl).toBe("http://127.0.0.1:18545");
    expect(config.network.deploymentBlock).toBe(11n);
    expect(config.network.contracts.UVPStateMachine).toBe("0x1111111111111111111111111111111111111111");
    expect(config.network.contracts.ZhixuTrustRegistry).toBe("0x3333333333333333333333333333333333333333");
  });

  it("loads address manifest from UVP_STAGING_REHEARSAL_MANIFEST as a tertiary fallback", () => {
    const dir = mkdtempSync(join(tmpdir(), "uvp-chain-services-"));
    tempDirs.push(dir);
    const manifestPath = join(dir, "rehearsal.addresses.json");
    writeFileSync(manifestPath, JSON.stringify({
      network: {
        chainId: 31337,
        rpcUrlEnv: "ANVIL_RPC_URL"
      },
      deployment: { blockNumber: 7 },
      contracts: {
        UVPStateMachine: {
          address: "0xaaaa111111111111111111111111111111111111",
          deployment: { blockNumber: 8 }
        }
      }
    }));

    const config = loadConfigFromEnv({
      UVP_STAGING_REHEARSAL_MANIFEST: manifestPath,
      ANVIL_RPC_URL: "http://127.0.0.1:18545"
    });

    expect(config.network.chainId).toBe(31337);
    expect(config.network.deploymentBlock).toBe(7n);
    expect(config.network.contracts.UVPStateMachine).toBe("0xaaaa111111111111111111111111111111111111");
  });

  it("loads v5 deployment registry manifests with contract fallbacks and modules", () => {
    const dir = mkdtempSync(join(tmpdir(), "uvp-chain-services-"));
    tempDirs.push(dir);
    const manifestPath = join(dir, "addresses.v5.json");
    const deploymentId = `0x${"01".repeat(32)}`;
    writeFileSync(manifestPath, JSON.stringify({
      schemaVersion: "uvp-eth.addresses.v5",
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
        ZhixuTrustRegistry: {
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

  it("does not let zero-address manual overrides erase manifest contracts", () => {
    const dir = mkdtempSync(join(tmpdir(), "uvp-chain-services-"));
    tempDirs.push(dir);
    const manifestPath = join(dir, "addresses.json");
    writeFileSync(manifestPath, JSON.stringify({
      contracts: {
        ZhixuTrustRegistry: {
          address: "0x2222222222222222222222222222222222222222"
        }
      }
    }));

    const config = loadConfigFromEnv({
      UVP_ADDRESS_MANIFEST: manifestPath,
      UVP_CONTRACTS_JSON: JSON.stringify({
        ZhixuTrustRegistry: "0x0000000000000000000000000000000000000000"
      })
    });

    expect(config.network.contracts.ZhixuTrustRegistry).toBe("0x2222222222222222222222222222222222222222");
  });

  it("defaults durable storage to the memory driver", () => {
    const config = loadConfigFromEnv({});

    expect(config.database).toEqual({
      driver: "memory",
      url: "memory://projection-store",
      migrationsAutoRun: false
    });
  });

  it("loads durable storage driver, URL, and migration auto-run config", () => {
    const config = loadConfigFromEnv({
      CHAIN_SERVICES_DATABASE_DRIVER: "sqlite",
      CHAIN_SERVICES_DATABASE_URL: "sqlite://./local.db",
      CHAIN_SERVICES_MIGRATIONS_AUTO_RUN: "true"
    });

    expect(config.database).toEqual({
      driver: "sqlite",
      url: "sqlite://./local.db",
      migrationsAutoRun: true
    });
  });

  it("loads reconcile worker config", () => {
    const config = loadConfigFromEnv({
      RECONCILE_WORKER_ENABLED: "true",
      RECONCILE_POLL_INTERVAL_MS: "250",
      RECONCILE_TX_TIMEOUT_MS: "1000"
    });

    expect(config.reconcile).toEqual({
      enabled: true,
      pollIntervalMs: 250,
      txTimeoutMs: 1000
    });
  });

  it("infers postgres driver from database URL", () => {
    const config = loadConfigFromEnv({
      CHAIN_SERVICES_DATABASE_URL: "postgres://uvp:uvp@127.0.0.1:5432/uvp"
    });

    expect(config.database.driver).toBe("postgres");
    expect(config.database.url).toBe("postgres://uvp:uvp@127.0.0.1:5432/uvp");
  });

  it("loads security hardening config", () => {
    const config = loadConfigFromEnv({
      CHAIN_SERVICES_ENV: "local",
      SECURITY_PREFLIGHT_STRICT: "true",
      LOG_REDACTION_ENABLED: "false",
      BROADCAST_MAX_IN_FLIGHT_PER_ORDER: "2",
      BROADCAST_MAX_RETRY_ATTEMPTS: "5",
      BROADCAST_RETRY_BASE_MS: "100",
      BROADCAST_RETRY_MAX_MS: "2000",
      BROADCAST_RECEIPT_TIMEOUT_MS: "30000"
    });

    expect(config.security).toEqual({
      environment: "local",
      preflightStrict: true,
      logRedactionEnabled: false,
      broadcastMaxInFlightPerOrder: 2,
      broadcastMaxRetry: 5,
      broadcastRetryBaseMs: 100,
      broadcastRetryMaxMs: 2000,
      broadcastReceiptTimeoutMs: 30000
    });
    expect(config.relayer.maxRetries).toBe(5);
  });

  it("loads Store auth config with local dev-header default and JWT settings", () => {
    expect(loadConfigFromEnv({}).storeAuth).toEqual({
      mode: "dev_headers",
      roleClaim: "roles",
      principalClaim: "sub",
      displayNameClaim: "name",
      clockToleranceSeconds: 60
    });

    expect(loadConfigFromEnv(storeAuthJwtEnv).storeAuth).toEqual({
      mode: "jwt",
      jwksUrl: "https://identity.example/.well-known/jwks.json",
      issuer: "https://identity.example/",
      audience: "uvp-store",
      roleClaim: "roles",
      principalClaim: "sub",
      displayNameClaim: "name",
      clockToleranceSeconds: 30
    });
  });

  it("loads the Base Sepolia testnet runtime profile with Postgres storage", () => {
    const config = loadConfigFromEnv(testnetEnv(testnetPostgresConfigUrl()));

    expect(config.security.environment).toBe("testnet");
    expect(config.security.preflightStrict).toBe(true);
    expect(config.network.chainId).toBe(84532);
    expect(config.database).toMatchObject({
      driver: "postgres",
      migrationsAutoRun: true
    });
    expect(config.productBff.registrationAdapter).toBe("anvil");
    expect(config.relayer.broadcastEnabled).toBe(true);
    expect(config.evidenceStorage.adapter).toBe("rehearsal-object");
  });

  it("rejects testnet memory, SQLite, or implicit database storage", () => {
    const databaseUrl = testnetPostgresConfigUrl();

    expect(() => loadConfigFromEnv(testnetEnv(databaseUrl, {
      CHAIN_SERVICES_DATABASE_DRIVER: "memory"
    }))).toThrow(/CHAIN_SERVICES_DATABASE_DRIVER=postgres is required in testnet/);

    const { CHAIN_SERVICES_DATABASE_URL: _databaseUrl, ...missingDatabaseUrl } = testnetEnv(databaseUrl);
    expect(() => loadConfigFromEnv(missingDatabaseUrl)).toThrow(/CHAIN_SERVICES_DATABASE_URL is required/);

    expect(() => loadConfigFromEnv(testnetEnv(databaseUrl, {
      CHAIN_SERVICES_DATABASE_DRIVER: "sqlite",
      CHAIN_SERVICES_DATABASE_URL: sqliteConfigUrl(tempDirs)
    }))).toThrow(/CHAIN_SERVICES_DATABASE_DRIVER=postgres is required in testnet/);

    expect(() => loadConfigFromEnv(testnetEnv(databaseUrl, {
      UVP_INDEXER_POLL_INTERVAL_MS: "1000"
    }))).toThrow(/UVP_INDEXER_POLL_INTERVAL_MS=0/);
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
        ZhixuTrustRegistry: "0x2222222222222222222222222222222222222222"
      })
    }))).toThrow(/UVPStateMachine contract address/);

    expect(() => loadConfigFromEnv(testnetEnv(databaseUrl, {
      UVP_CONTRACTS_JSON: JSON.stringify({
        UVPStateMachine: "0x1111111111111111111111111111111111111111"
      })
    }))).toThrow(/ZhixuTrustRegistry contract address/);
  });

  it("rejects testnet demo controls, permissive auth, memory registration, and unsafe keys", () => {
    const databaseUrl = testnetPostgresConfigUrl();

    expect(() => loadConfigFromEnv(testnetEnv(databaseUrl, {
      UVP_PRODUCT_DEMO_MODE: "1"
    }))).toThrow(/UVP_PRODUCT_DEMO_MODE/);

    expect(() => loadConfigFromEnv(testnetEnv(databaseUrl, {
      UVP_PRODUCT_E2E_FIXTURES: "1"
    }))).toThrow(/UVP_PRODUCT_E2E_FIXTURES/);

    expect(() => loadConfigFromEnv(testnetEnv(databaseUrl, {
      UVP_PRODUCT_SUBMISSION_AUTHORIZATION: "product_projection_demo"
    }))).toThrow(/permissive Product submission authorization/);

    expect(() => loadConfigFromEnv(testnetEnv(databaseUrl, {
      UVP_PRODUCT_BFF_REGISTRATION_ADAPTER: "memory"
    }))).toThrow(/REGISTRATION_ADAPTER=memory/);

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
      UVP_RPC_URL: "https://base-sepolia.example/rpc?api_key=rpc-secret"
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
      storage: { driver: "postgres", durable: true },
      evidenceStorage: {
        adapter: "rehearsal-object",
        objectNamespace: "uvp-rehearsal"
      },
      network: {
        chainId: 84532,
        stateMachineConfigured: true,
        trustRegistryConfigured: true
      },
      product: {
        demoMode: false,
        e2eControls: false,
        registrationAdapter: "anvil",
        permissiveAuthorizationRequested: false
      },
      storeAuth: {
        mode: "dev_headers",
        jwtConfigured: false,
        externalIdentityEvidence: false,
        evidenceClassification: "prototype",
        evidenceReasons: ["store_auth_dev_headers"],
        keySource: "missing",
        jwksUrlConfigured: false,
        issuerConfigured: false,
        audienceConfigured: false,
        roleClaim: "roles",
        principalClaim: "sub",
        displayNameClaimConfigured: true,
        clockToleranceSeconds: 60
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

    await expect(runConfigPreflight(config, {
      env: {
        ...env,
        UVP_PRODUCT_E2E_FIXTURES: "1"
      },
      clients: {
        network: { getChainId: async () => 84532 }
      }
    })).rejects.toThrow(/UVP_PRODUCT_E2E_FIXTURES=1 is forbidden in testnet/);
  });

  it("loads the staging runtime profile with Postgres, S3, strict preflight, and role env names", () => {
    const config = loadConfigFromEnv(stagingEnv(tempDirs));

    expect(config.security).toMatchObject({
      environment: "staging",
      preflightStrict: true,
      logRedactionEnabled: true
    });
    expect(config.database).toMatchObject({
      driver: "postgres",
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

  it("rejects staging local storage, demo controls, local RPC, wrong chain, unsafe evidence, and weak keys", () => {
    expect(() => loadConfigFromEnv(stagingEnv(tempDirs, {
      CHAIN_SERVICES_DATABASE_DRIVER: "memory"
    }))).toThrow(/CHAIN_SERVICES_DATABASE_DRIVER=postgres/);

    expect(() => loadConfigFromEnv(stagingEnv(tempDirs, {
      CHAIN_SERVICES_DATABASE_DRIVER: "sqlite",
      CHAIN_SERVICES_DATABASE_URL: sqliteConfigUrl(tempDirs)
    }))).toThrow(/CHAIN_SERVICES_DATABASE_DRIVER=postgres/);

    const { CHAIN_SERVICES_DATABASE_URL: _databaseUrl, ...missingDatabaseUrl } = stagingEnv(tempDirs);
    expect(() => loadConfigFromEnv(missingDatabaseUrl)).toThrow(/CHAIN_SERVICES_DATABASE_URL/);

    expect(() => loadConfigFromEnv(stagingEnv(tempDirs, {
      CHAIN_SERVICES_MIGRATIONS_AUTO_RUN: "true"
    }))).toThrow(/UVP_STAGING_ALLOW_AUTO_MIGRATIONS/);

    expect(() => loadConfigFromEnv(stagingEnv(tempDirs, {
      UVP_INDEXER_POLL_INTERVAL_MS: "5000"
    }))).toThrow(/UVP_INDEXER_POLL_INTERVAL_MS=0/);

    expect(() => loadConfigFromEnv(stagingEnv(tempDirs, {
      RECONCILE_POLL_INTERVAL_MS: "5000"
    }))).toThrow(/RECONCILE_POLL_INTERVAL_MS/);

    expect(() => loadConfigFromEnv(stagingEnv(tempDirs, {
      UVP_EVIDENCE_STORAGE_ADAPTER: "local"
    }))).toThrow(/UVP_EVIDENCE_STORAGE_ADAPTER=s3/);

    expect(() => loadConfigFromEnv(stagingEnv(tempDirs, {
      UVP_EVIDENCE_STORAGE_ADAPTER: "rehearsal-object"
    }))).toThrow(/UVP_EVIDENCE_STORAGE_ADAPTER=s3/);

    expect(() => loadConfigFromEnv(stagingEnv(tempDirs, {
      UVP_PRODUCT_DEMO_MODE: "1"
    }))).toThrow(/UVP_PRODUCT_DEMO_MODE/);

    expect(() => loadConfigFromEnv(stagingEnv(tempDirs, {
      UVP_PRODUCT_E2E_FIXTURES: "1"
    }))).toThrow(/UVP_PRODUCT_E2E_FIXTURES/);

    expect(() => loadConfigFromEnv(stagingEnv(tempDirs, {
      UVP_PRODUCT_PERMISSIVE_AUTH: "1"
    }))).toThrow(/permissive Product submission authorization/);

    expect(() => loadConfigFromEnv(stagingEnv(tempDirs, {
      UVP_PRODUCT_BFF_REGISTRATION_ADAPTER: "memory"
    }))).toThrow(/REGISTRATION_ADAPTER=anvil/);

    expect(() => loadConfigFromEnv(stagingEnv(tempDirs, {
      UVP_PRODUCT_BFF_WAIT_FOR_RECEIPT: "false"
    }))).toThrow(/WAIT_FOR_RECEIPT=true/);

    expect(() => loadConfigFromEnv(stagingEnv(tempDirs, {
      UVP_STATE_MACHINE_RELAYER_BROADCAST_ENABLED: "false"
    }))).toThrow(/RELAYER_BROADCAST_ENABLED=true/);

    expect(() => loadConfigFromEnv(stagingEnv(tempDirs, {
      STORE_AUTH_MODE: "dev_headers"
    }))).toThrow(/STORE_AUTH_MODE=jwt/);

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
    expect(() => loadConfigFromEnv(missingManifest)).toThrow(/UVP_ADDRESS_MANIFEST, UVP_ETH_ADDRESS_MANIFEST, or UVP_STAGING_REHEARSAL_MANIFEST is required in staging/);

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
  });

  it("accepts UVP_STAGING_REHEARSAL_MANIFEST as a valid staging address manifest source", () => {
    const manifestPath = stagingManifestPath(tempDirs);
    const env = {
      ...stagingEnv(tempDirs),
      UVP_STAGING_REHEARSAL_MANIFEST: manifestPath
    };
    delete (env as Record<string, string | undefined>).UVP_ADDRESS_MANIFEST;

    const config = loadConfigFromEnv(env);

    expect(config.network.contracts.UVPStateMachine).toBe("0x1111111111111111111111111111111111111111");
    expect(config.network.deploymentBlock).toBe(100n);
    expect(config.security.environment).toBe("staging");
  });

  it("runs safe strict preflight diagnostics for the staging profile", async () => {
    const env = stagingEnv(tempDirs);
    const config = loadConfigFromEnv(env);

    const diagnostics = await runConfigPreflight(config, {
      env,
      clients: {
        network: {
          getChainId: async () => 84532,
          getBytecode: async () => "0x01"
        },
        governance: {
          getChainId: async () => 84532,
          readContract: async () => stagingGovernanceAddress
        }
      }
    });

    expect(diagnostics).toMatchObject({
      environment: "staging",
      storage: { driver: "postgres", durable: true, migrationsAutoRun: false },
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
          privateKeyEnv: "GOVERNANCE_SIGNER_PRIVATE_KEY",
          address: stagingGovernanceAddress,
          expectedAddress: stagingGovernanceAddress,
          addressMatches: true
        },
        governanceAdminReviewer: { configuredCount: 1 },
        opsConsoleAdmin: { configuredCount: 1 }
      },
      product: {
        demoMode: false,
        e2eControls: false,
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

  it("rejects production non-Postgres storage, unsafe migrations, and Anvil default private keys", () => {
    expect(() => loadConfigFromEnv({
      CHAIN_SERVICES_ENV: "production",
      ...storeAuthJwtEnv
    })).toThrow(/CHAIN_SERVICES_DATABASE_DRIVER=postgres is required in production/);

    expect(() => loadConfigFromEnv(productionEnv({
      CHAIN_SERVICES_DATABASE_DRIVER: "sqlite",
      CHAIN_SERVICES_DATABASE_URL: "sqlite://./prod-chain-services.sqlite3"
    }))).toThrow(/CHAIN_SERVICES_DATABASE_DRIVER=postgres is required in production/);

    expect(() => loadConfigFromEnv(productionEnv({
      CHAIN_SERVICES_MIGRATIONS_AUTO_RUN: "true"
    }))).toThrow(/UVP_PRODUCTION_ALLOW_AUTO_MIGRATIONS/);

    expect(() => loadConfigFromEnv(productionEnv({
      GOVERNANCE_SIGNER_PRIVATE_KEY: anvilPrivateKey
    }))).toThrow(/Anvil default private key/);
  });

  it("rejects production demo, test controls, permissive auth, redaction gaps, and mock registration", () => {
    expect(loadConfigFromEnv(productionEnv()).security.environment).toBe("production");

    expect(() => loadConfigFromEnv(productionEnv({
      UVP_PRODUCT_DEMO_MODE: "1"
    }))).toThrow(/UVP_PRODUCT_DEMO_MODE/);

    expect(() => loadConfigFromEnv(productionEnv({
      UVP_PRODUCT_E2E_FIXTURES: "1"
    }))).toThrow(/UVP_PRODUCT_E2E_FIXTURES/);

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
    }))).toThrow(/STORE_AUTH_MODE=jwt/);

    expect(() => loadConfigFromEnv(productionEnv({
      STORE_AUTH_ISSUER: "http://localhost:8789/"
    }))).toThrow(/STORE_AUTH_ISSUER must be HTTPS/);

    const { STORE_AUTH_AUDIENCE: _audience, ...missingAudience } = productionEnv();
    expect(() => loadConfigFromEnv(missingAudience)).toThrow(/STORE_AUTH_AUDIENCE/);

    expect(() => loadConfigFromEnv(productionEnv({
      UVP_PRODUCT_BFF_REGISTRATION_ADAPTER: "memory"
    }))).toThrow(/REGISTRATION_ADAPTER=memory/);

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
        ZhixuTrustRegistry: "0x2222222222222222222222222222222222222222"
      })
    }))).toThrow(/UVPStateMachine contract address/);

    expect(() => loadConfigFromEnv(productionEnv({
      UVP_CONTRACTS_JSON: JSON.stringify({
        UVPStateMachine: "0x1111111111111111111111111111111111111111"
      })
    }))).toThrow(/ZhixuTrustRegistry contract address/);

    const { UVP_STATE_MACHINE_RELAYER_PRIVATE_KEY: _privateKey, ...missingRelayer } = productionEnv();
    expect(() => loadConfigFromEnv(missingRelayer)).toThrow(/UVP_STATE_MACHINE_RELAYER_PRIVATE_KEY is required/);
  });

  it("fails production preflight when unsafe env is injected after config load", async () => {
    const config = loadConfigFromEnv(productionEnv());

    await expect(runConfigPreflight(config, {
      env: productionEnv({ UVP_PRODUCT_E2E_FIXTURES: "1" }),
      clients: {
        network: { getChainId: async () => 31337 }
      }
    })).rejects.toThrow(/UVP_PRODUCT_E2E_FIXTURES=1 is forbidden in production/);
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
      CHAIN_SERVICES_DATABASE_DRIVER: "sqlite",
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
    const router = createApiRouter(new MemoryProjectionStore(), { configDiagnostics: diagnostics });
    const response = await router.handle({ method: "GET", pathname: "/healthz" });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      diagnostics: {
        environment: "local",
        demoMode: false,
        e2eControls: false,
        storageDriver: "sqlite",
        relayerConfigured: true,
        relayer: { configured: true },
        governance: { broadcastEnabled: false },
        storage: { driver: "sqlite", durable: true },
        product: {
          demoMode: false,
          e2eControls: false,
          registrationAdapter: "memory",
          permissiveAuthorizationRequested: false
        },
        security: {
          logRedactionEnabled: true
        },
        storeMetadata: {
          readiness: "ready",
          credentialsExposed: false,
          nonAuthoritative: true,
          sourceOfTruth: "contracts-and-chain-events",
          stores: {
            draft: { kind: "memory", readiness: "ready", durable: false, credentialsExposed: false },
            productSchema: { kind: "memory", readiness: "ready", durable: false, credentialsExposed: false, representedBy: "draft" },
            version: { kind: "memory", readiness: "ready", durable: false, credentialsExposed: false },
            supplier: { kind: "memory", readiness: "ready", durable: false, credentialsExposed: false },
            supplierAudit: { kind: "memory", readiness: "ready", durable: false, credentialsExposed: false, representedBy: "supplier" },
            docking: { kind: "memory", readiness: "ready", durable: false, credentialsExposed: false }
          }
        }
      }
    });
    expect(JSON.stringify(response.body)).not.toContain("2222222222222222222222222222222222222222222222222222222222222222");
  });

  it("marks non-local readiness degraded when Store metadata wiring falls back to memory", async () => {
    const config = loadConfigFromEnv(productionEnv());
    const diagnostics = buildConfigDiagnostics(config, {
      env: productionEnv(),
      preflight: {
        status: "passed",
        checks: [{ name: "store_metadata.durable", status: "passed" }]
      }
    });
    const router = createApiRouter(new MemoryProjectionStore(), {
      configDiagnostics: diagnostics,
      productRuntimeEnvironment: "production",
      evidenceStorage: productionSafeEvidenceStorage()
    });

    const response = await router.handle({ method: "GET", pathname: "/readyz" });

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      ok: false,
      ready: false,
      reasons: expect.arrayContaining(["store_metadata_degraded"]),
      diagnostics: {
        storeMetadata: {
          readiness: "degraded",
          stores: {
            draft: { kind: "memory", readiness: "degraded" },
            productSchema: { kind: "memory", readiness: "degraded", representedBy: "draft" },
            version: { kind: "memory", readiness: "degraded" },
            supplier: { kind: "memory", readiness: "degraded" },
            supplierAudit: { kind: "memory", readiness: "degraded", representedBy: "supplier" },
            docking: { kind: "memory", readiness: "degraded" }
          }
        }
      }
    });
  });
});

function productionEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    CHAIN_SERVICES_ENV: "production",
    CHAIN_SERVICES_DATABASE_DRIVER: "postgres",
    CHAIN_SERVICES_DATABASE_URL: "postgres://uvp:db-secret@prod-db.internal:5432/uvp",
    CHAIN_SERVICES_MIGRATIONS_AUTO_RUN: "false",
    ...storeAuthJwtEnv,
    UVP_CONTRACTS_JSON: productionContracts,
    UVP_PRODUCT_BFF_REGISTRATION_ADAPTER: "anvil",
    UVP_PRODUCT_BFF_REGISTRAR_PRIVATE_KEY: productionRegistrarPrivateKey,
    UVP_STATE_MACHINE_RELAYER_PRIVATE_KEY: productionRelayerPrivateKey,
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
    CHAIN_SERVICES_DATABASE_DRIVER: "postgres",
    CHAIN_SERVICES_DATABASE_URL: databaseUrl,
    CHAIN_SERVICES_MIGRATIONS_AUTO_RUN: "true",
    UVP_INDEXER_POLL_INTERVAL_MS: "0",
    UVP_CHAIN_ID: "84532",
    UVP_RPC_URL: "https://base-sepolia.example/rpc",
    UVP_CONTRACTS_JSON: productionContracts,
    UVP_PRODUCT_BFF_REGISTRATION_ADAPTER: "anvil",
    UVP_PRODUCT_BFF_REGISTRAR_PRIVATE_KEY: testnetRegistrarPrivateKey,
    UVP_STATE_MACHINE_RELAYER_PRIVATE_KEY: testnetRelayerPrivateKey,
    UVP_EVIDENCE_STORAGE_ADAPTER: "rehearsal-object",
    ...overrides
  };
}

function stagingEnv(tempDirs: string[], overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    CHAIN_SERVICES_RUNTIME_ENV: "staging",
    SECURITY_PREFLIGHT_STRICT: "true",
    LOG_REDACTION_ENABLED: "true",
    CHAIN_SERVICES_DATABASE_DRIVER: "postgres",
    CHAIN_SERVICES_DATABASE_URL: "postgres://uvp:db-secret@staging-db.internal:5432/uvp",
    CHAIN_SERVICES_MIGRATIONS_AUTO_RUN: "false",
    UVP_INDEXER_POLL_INTERVAL_MS: "0",
    ...storeAuthJwtEnv,
    UVP_CHAIN_ID: "84532",
    UVP_RPC_URL: "https://base-sepolia.example/rpc?api_key=rpc-secret",
    UVP_ADDRESS_MANIFEST: stagingManifestPath(tempDirs),
    UVP_FINALITY_CONFIRMATIONS: "12",
    UVP_REORG_BUFFER_BLOCKS: "24",
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
    GOVERNANCE_SIGNER_PRIVATE_KEY: testnetRegistrarPrivateKey,
    GOVERNANCE_ADMIN_REVIEWER_IDS: "gov-reviewer-1",
    OPS_CONSOLE_ADMIN_IDS: "ops-admin-1",
    RECONCILE_WORKER_ENABLED: "true",
    RECONCILE_POLL_INTERVAL_MS: "30000",
    UVP_PRODUCT_DEMO_MODE: "0",
    UVP_PRODUCT_E2E_FIXTURES: "0",
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
    schemaVersion: "uvp-eth.addresses.v5",
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
      ZhixuTrustRegistry: {
        address: "0x2222222222222222222222222222222222222222",
        deployment: { blockNumber: 111 }
      }
    }
  }));
  return manifestPath;
}

function stagingPreflightClients() {
  return {
    network: {
      getChainId: async () => 84532,
      getBytecode: async () => "0x01" as const
    },
    governance: {
      getChainId: async () => 84532,
      readContract: async () => stagingGovernanceAddress
    }
  };
}

function sqliteConfigUrl(tempDirs: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "uvp-chain-services-config-"));
  tempDirs.push(dir);
  return `sqlite://${join(dir, "testnet.sqlite3")}`;
}

function testnetPostgresConfigUrl(): string {
  return "postgres://uvp:db-secret@testnet-db.internal:5432/uvp";
}
