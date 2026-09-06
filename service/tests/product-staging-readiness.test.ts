import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { crossBorderPlanIds } from "@uvp-eth/product-dto/fixtures";
import { buildConfigDiagnostics, loadConfigFromEnv, type ConfigDiagnostics } from "../src/config/index.js";
import { createApiRouter } from "../src/api/routes.js";
import { ObjectEvidenceStorage } from "../src/evidence/index.js";
import type { ChainEvent } from "../src/indexer/events.js";
import { MemoryProjectionStore } from "../src/storage/projection-store.js";
import { crossBorderSchemaResolver } from "./cross-border-schema.js";
import type { Address, Hex } from "../src/shared/types.js";

const chainId = 84532;
const stateMachineAddress = "0x1111111111111111111111111111111111111111" as Address;
const identityRegistryAddress = "0x2222222222222222222222222222222222222222" as Address;
const deploymentRegistryAddress = "0x8888888888888888888888888888888888888888" as Address;
const activeDeploymentId = bytes32Hex("d02");
const stateMachineOrderId = bytes32Hex("202");
const hookId = bytes32Hex("303");
const stageId = bytes32Text("export.customs");
const hookName = bytes32Text("customs-review");
const sourceId = bytes32Text("customs-source");
const signalId = bytes32Text("cmp");
const metadataHash = "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const payloadHash = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const idempotencyKey = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const abiHash = bytes32Hex("abc");
const submitter = "0x3333333333333333333333333333333333333333" as Address;
const productionRelayerPrivateKey = "0x1111111111111111111111111111111111111111111111111111111111111111";
const productionRelayerAddress = "0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a";
const productionRegistrarPrivateKey = "0x2222222222222222222222222222222222222222222222222222222222222222";
const productionRegistrarAddress = "0x1563915e194d8cfba1943570603f7606a3115508";
const stagingDeployerPrivateKey = "0x3333333333333333333333333333333333333333333333333333333333333333";
const stagingDeployerAddress = "0x5cbdd86a2fa8dc4bddd8a8f69dba48572eec07fb";
const stagingGovernancePrivateKey = "0x4444444444444444444444444444444444444444444444444444444444444444";
const stagingGovernanceAddress = "0x7564105e977516c53be337314c7e53838967bdac";
const generatedAt = "2026-05-01T00:00:00.000Z";

describe("Product API staging readiness", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("serves a no-secret ready summary from non-demo chain projections", async () => {
    const store = new MemoryProjectionStore();
    await store.resetFromEvents({ deploymentBlock: 0n, events: readinessEvents() });
    await store.saveSyncState({
      chainId,
      contractAddress: stateMachineAddress,
      syncStatus: "indexed",
      latestIndexedBlock: 9n,
      finalizedBlock: 9n,
      confirmationDepth: 12,
      lastEventName: "SignalSubmitterAuthorized",
      eventCount: 9,
      rebuild: {
        status: "completed",
        deploymentBlock: 1n,
        fromBlock: 1n,
        toBlock: 9n,
        eventCount: 9,
        activeEventCount: 9,
        removedEventCount: 1,
        removedLogsFiltered: true,
        projectionRebuilt: true,
        mismatchCount: 0
      }
    });
    const router = createApiRouter(store, { productSchemaResolver: crossBorderSchemaResolver(), submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111",
      configDiagnostics: stagingDiagnostics(tempDirs),
      productRuntimeEnvironment: "staging",
      evidenceStorage: productionSafeEvidenceStorage(),
      now: () => new Date(generatedAt)
    });

    const response = await router.handle({ method: "GET", pathname: "/product/staging/readiness" });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      ready: true,
      status: "ready",
      reasons: [],
      sourceOfTruth: "contracts-and-chain-events",
      backendAuthority: false,
      generatedAt,
      profile: {
        environment: "staging",
        preflightStrict: true,
        preflightStatus: "passed",
        e2eControls: false,
        registrationAdapter: "anvil",
        storageDriver: "postgres",
        storageDurable: true,
        storeAuthMode: "jwt",
        storeAuthJwtConfigured: true,
        storeAuthExternalIdentityEvidence: true,
        storeAuthEvidenceClassification: "external_oidc",
        storeAuthKeySource: "jwks_url"
      },
      deployment: {
        ready: true,
        activeDeploymentId,
        stateMachineAddress,
        projectionStatus: "active",
        source: "registry_projection"
      },
      indexer: {
        ready: true,
        syncStatus: "indexed",
        latestIndexedBlock: "9",
        rebuild: {
          status: "completed",
          deploymentBlock: "1",
          fromBlock: "1",
          toBlock: "9",
          activeEventCount: 9,
          removedEventCount: 1,
          removedLogsFiltered: true,
          projectionRebuilt: true,
          mismatchCount: 0
        },
        activeEventCount: 9,
        removedEventCount: 1,
        removedLogsFiltered: true,
        projectionRebuilt: true,
        eventRowsReplayed: 9
      },
      productState: {
        zhixuCount: 1,
        orderCount: 1,
        taskCount: 1,
        openTaskCount: 1,
        submittableTaskCount: 1,
        sampleOrders: [
          expect.objectContaining({
            orderId: stateMachineOrderId,
            deploymentId: activeDeploymentId,
            stateMachineAddress,
            proofEventCount: expect.any(Number)
          })
        ],
        sampleTasks: [
          expect.objectContaining({
            orderId: stateMachineOrderId,
            status: "open",
            canSubmit: true,
            assigneeWallet: submitter,
            readyTxHash: txHash(7n)
          })
        ]
      },
      proof: {
        orderProofEventCount: expect.any(Number),
        taskProofRowCount: expect.any(Number),
        payloadHashEventCount: 1,
        eventNames: expect.arrayContaining(["OrderRegistered", "SignalSubmitted", "HookReady", "PlanRegistered"])
      },
      evidenceStorage: {
        adapterKind: "object",
        readiness: "ready",
        productionSafe: true
      },
      roleInputs: {
        ready: true,
        relayerConfigured: true,
        governanceConfigured: true,
        participantWalletCount: 1
      }
    });
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain("db-secret");
    expect(serialized).not.toContain("rpc-secret");
    expect(serialized).not.toContain("object-secret");
    expect(serialized).not.toContain(productionRelayerPrivateKey.slice(2));
    expect(serialized).not.toContain(productionRegistrarPrivateKey.slice(2));
    expect(serialized).not.toContain(stagingDeployerPrivateKey.slice(2));
    expect(serialized).not.toContain(stagingGovernancePrivateKey.slice(2));
  });

  it("fails closed when fixture controls are presented as staging evidence", async () => {
    const store = new MemoryProjectionStore();
    await store.resetFromEvents({ deploymentBlock: 0n, events: readinessEvents({ includeActiveDeployment: false }) });
    const baseDiagnostics = stagingDiagnostics(tempDirs);
    const unsafeDiagnostics: ConfigDiagnostics = {
      ...baseDiagnostics,
      e2eControls: true,
      product: {
        ...baseDiagnostics.product,
        e2eControls: true,
        permissiveAuthorizationRequested: true
      }
    };
    const router = createApiRouter(store, { productSchemaResolver: crossBorderSchemaResolver(), submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111",
      configDiagnostics: unsafeDiagnostics,
      productRuntimeEnvironment: "staging",
      evidenceStorage: productionSafeEvidenceStorage(),
      now: () => new Date(generatedAt)
    });

    const response = await router.handle({ method: "GET", pathname: "/product/staging/readiness" });

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      ok: false,
      ready: false,
      status: "not_ready",
      reasons: expect.arrayContaining([
        "product_e2e_fixtures_enabled",
        "permissive_product_authorization_requested",
        "no_active_deployment"
      ]),
      productState: {
        orderCount: 1,
        taskCount: 1
      }
    });
  });

  it("fails closed when required staging preflight evidence is missing", async () => {
    const failedDiagnostics: ConfigDiagnostics = {
      ...stagingDiagnostics(tempDirs),
      preflight: {
        strict: true,
        status: "failed",
        checks: [{
          name: "network.chain_id",
          status: "failed",
          message: "RPC token=rpc-secret refused"
        }]
      }
    };
    const router = createApiRouter(new MemoryProjectionStore(), { productSchemaResolver: crossBorderSchemaResolver(), submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111",
      configDiagnostics: failedDiagnostics,
      productRuntimeEnvironment: "staging",
      evidenceStorage: productionSafeEvidenceStorage(),
      now: () => new Date(generatedAt)
    });

    const response = await router.handle({ method: "GET", pathname: "/product/staging/readiness" });

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      ok: false,
      reasons: expect.arrayContaining([
        "staging_preflight_not_passed",
        "no_active_deployment",
        "indexer_not_indexed",
        "no_chain_projected_order",
        "no_chain_projected_task",
        "no_chain_proof"
      ])
    });
    expect(JSON.stringify(response.body)).not.toContain("rpc-secret");
  });

  it("fails closed when JWT config evidence is not external OIDC/JWKS", async () => {
    const baseDiagnostics = stagingDiagnostics(tempDirs);
    const unsafeDiagnostics: ConfigDiagnostics = {
      ...baseDiagnostics,
      storeAuth: {
        ...baseDiagnostics.storeAuth,
        mode: "jwt",
        jwtConfigured: true,
        externalIdentityEvidence: false,
        evidenceClassification: "not_verified",
        evidenceReasons: ["store_auth_key_source_local_or_private"],
        keySource: "jwks_url"
      }
    };
    const store = new MemoryProjectionStore();
    await store.resetFromEvents({ deploymentBlock: 0n, events: readinessEvents() });
    const router = createApiRouter(store, { productSchemaResolver: crossBorderSchemaResolver(), submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111",
      configDiagnostics: unsafeDiagnostics,
      productRuntimeEnvironment: "staging",
      evidenceStorage: productionSafeEvidenceStorage(),
      now: () => new Date(generatedAt)
    });

    const response = await router.handle({ method: "GET", pathname: "/product/staging/readiness" });

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      ok: false,
      ready: false,
      reasons: expect.arrayContaining(["store_auth_external_oidc_missing"]),
      profile: {
        storeAuthMode: "jwt",
        storeAuthJwtConfigured: true,
        storeAuthExternalIdentityEvidence: false,
        storeAuthEvidenceClassification: "not_verified"
      }
    });
  });

});

function stagingDiagnostics(tempDirs: string[]): ConfigDiagnostics {
  const env = stagingEnv(tempDirs);
  return buildConfigDiagnostics(loadConfigFromEnv(env), {
    env,
    preflight: {
      status: "passed",
      checks: [
        { name: "network.chain_id", status: "passed" },
        { name: "contracts.state_machine_code", status: "passed" },
        { name: "contracts.identity_registry_code", status: "passed" },
        { name: "governance.owner", status: "passed" }
      ]
    }
  });
}

function stagingEnv(tempDirs: string[]): Record<string, string | undefined> {
  return {
    CHAIN_SERVICES_RUNTIME_ENV: "staging",
    SECURITY_PREFLIGHT_STRICT: "true",
    LOG_REDACTION_ENABLED: "true",
    CHAIN_SERVICES_DATABASE_DRIVER: "postgres",
    CHAIN_SERVICES_DATABASE_URL: "postgres://uvp:db-secret@staging-db.internal:5432/uvp",
    CHAIN_SERVICES_MIGRATIONS_AUTO_RUN: "false",
    UVP_INDEXER_POLL_INTERVAL_MS: "5000",
    STORE_AUTH_MODE: "jwt",
    STORE_AUTH_JWKS_URL: "https://identity.example/.well-known/jwks.json",
    STORE_AUTH_ISSUER: "https://identity.example/",
    STORE_AUTH_AUDIENCE: "uvp-store",
    STORE_AUTH_ROLE_CLAIM: "roles",
    STORE_AUTH_PRINCIPAL_CLAIM: "sub",
    STORE_AUTH_DISPLAY_NAME_CLAIM: "name",
    STORE_AUTH_CLOCK_TOLERANCE_SECONDS: "30",
    UVP_CHAIN_ID: chainId.toString(),
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
    UVP_STAGING_DEPLOYER_PRIVATE_KEY: stagingDeployerPrivateKey,
    UVP_ETH_DEPLOYER_ADDRESS: stagingDeployerAddress,
    UVP_STATE_MACHINE_OWNER_ADDRESS: "0x3333333333333333333333333333333333333333",
    UVP_PLAN_PUBLISHER_ADDRESS: "0x4444444444444444444444444444444444444444",
    UVP_REHEARSAL_PARTICIPANT_WALLETS: "0x7777777777777777777777777777777777777777",
    GOVERNANCE_BROADCAST_ENABLED: "true",
    GOVERNANCE_REGISTRY_OWNER_ADDRESS: stagingGovernanceAddress,
    GOVERNANCE_SIGNER_ADDRESS: stagingGovernanceAddress,
    GOVERNANCE_SIGNER_PRIVATE_KEY_ENV: "UVP_STAGING_GOVERNANCE_SIGNER_PRIVATE_KEY",
    UVP_STAGING_GOVERNANCE_SIGNER_PRIVATE_KEY: stagingGovernancePrivateKey,
    GOVERNANCE_ADMIN_REVIEWER_IDS: "gov-reviewer-1",
    OPS_CONSOLE_ADMIN_IDS: "ops-admin-1",
    RECONCILE_WORKER_ENABLED: "true",
    RECONCILE_POLL_INTERVAL_MS: "30000",
    UVP_PRODUCT_DEMO_MODE: "0",
    UVP_PRODUCT_E2E_FIXTURES: "0",
    UVP_PRODUCT_PERMISSIVE_AUTH: "0"
  };
}

function stagingManifestPath(tempDirs: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "uvp-product-readiness-"));
  tempDirs.push(dir);
  const manifestPath = join(dir, "staging.addresses.json");
  writeFileSync(manifestPath, JSON.stringify({
    schemaVersion: "uvp-eth.addresses.v1",
    network: {
      chainId,
      rpcUrlEnv: "UVP_RPC_URL"
    },
    deployment: {
      blockNumber: 1
    },
    contracts: {
      UVPDeploymentRegistry: {
        address: deploymentRegistryAddress,
        deployment: { blockNumber: 1 }
      },
      UVPStateMachine: {
        address: stateMachineAddress,
        deployment: { blockNumber: 4 }
      },
      UVPIdentityRegistry: {
        address: identityRegistryAddress,
        deployment: { blockNumber: 4 }
      }
    }
  }));
  return manifestPath;
}

function readinessEvents(options: {
  readonly includeActiveDeployment?: boolean;
} = {}): readonly ChainEvent[] {
  return [
    ...(options.includeActiveDeployment === false ? [] : activeDeploymentEvents()),
    chainEvent(4n, 0, "PlanRegistered", {
      planId: crossBorderPlanIds.planId,
      planHash: crossBorderPlanIds.planHash,
      hookCount: 1n
    }),
    chainEvent(5n, 0, "SignalCapabilityRegistered", {
      planId: crossBorderPlanIds.planId,
      stageId,
      targetSourceId: stageId,
      signalId: hookName,
      targetOrderRelation: 0
    }),
    chainEvent(6n, 0, "OrderRegistered", {
      orderId: stateMachineOrderId,
      planId: crossBorderPlanIds.planId
    }),
    chainEvent(6n, 1, "SignalSubmitted", {
      orderId: stateMachineOrderId,
      sourceId,
      signalId,
      payloadHash,
      idempotencyKey,
      submitter
    }),
    chainEvent(7n, 0, "HookReady", {
      orderId: stateMachineOrderId,
      hookId,
      stageId,
      hookName
    }),
    chainEvent(8n, 0, "SignalSubmitterAuthorized", {
      orderId: stateMachineOrderId,
      sourceId: stageId,
      signalId: hookName,
      submitter,
      role: bytes32Text("customs-broker"),
      metadataHash
    })
  ];
}

function activeDeploymentEvents(): readonly ChainEvent[] {
  return [
    chainEvent(1n, 0, "DeploymentRegistered", {
      deploymentId: activeDeploymentId,
      stateMachine: stateMachineAddress,
      artifactHash: crossBorderPlanIds.artifactHash,
      abiHash,
      deploymentBlock: 4n,
      metadataURI: "uvp-eth://deployments/staging"
    }, deploymentRegistryAddress),
    chainEvent(2n, 0, "DeploymentCanaryMarked", {
      deploymentId: activeDeploymentId,
      evidenceHash: metadataHash,
      evidenceURI: "uvp-eth://deployments/staging/canary"
    }, deploymentRegistryAddress),
    chainEvent(3n, 0, "DeploymentActivated", {
      previousDeploymentId: bytes32Hex("0"),
      newDeploymentId: activeDeploymentId,
      evidenceHash: metadataHash,
      evidenceURI: "uvp-eth://deployments/staging/active"
    }, deploymentRegistryAddress)
  ];
}

function chainEvent(
  blockNumber: bigint,
  logIndex: number,
  eventName: string,
  args: Record<string, unknown>,
  contractAddress: Address = stateMachineAddress
): ChainEvent {
  return {
    chainId,
    contractAddress,
    blockNumber,
    transactionHash: txHash(blockNumber, logIndex),
    logIndex,
    eventName,
    args
  };
}

function productionSafeEvidenceStorage(): ObjectEvidenceStorage {
  return new ObjectEvidenceStorage({
    client: {
      async put(input) {
        return {
          storageURI: `object://uvp-staging-evidence/${encodeURIComponent(input.evidenceId)}`,
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

function txHash(blockNumber: bigint, logIndex = 0): Hex {
  return `0x${`${blockNumber.toString(16)}${logIndex.toString(16)}`.padStart(64, "0")}` as Hex;
}

function bytes32Text(value: string): Hex {
  return `0x${Buffer.from(value, "utf8").toString("hex").padEnd(64, "0")}` as Hex;
}

function bytes32Hex(suffix: string): Hex {
  return `0x${suffix.padStart(64, "0")}` as Hex;
}
