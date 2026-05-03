import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  keccak256,
  stringToBytes,
  type Abi,
  type Address,
  type Hex
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { startApiServer } from "../src/api/server.js";
import type { ChainServicesConfig } from "../src/config/index.js";
import { MemoryProjectionStore } from "../src/storage/projection-store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "../../..");
const contractsDir = resolve(rootDir, "uvp-protocol/contracts/uvp-contracts");
const registryArtifactPath = resolve(contractsDir, "out/ZhixuTrustRegistry.sol/ZhixuTrustRegistry.json");
const anvilPrivateKey = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const canRunAnvil = commandExists("anvil") && commandExists("forge");
const maybeIt = canRunAnvil ? it : it.skip;

describe("anvil trust registry indexing", () => {
  let anvil: ChildProcess | undefined;
  let apiServer: Server | undefined;

  afterEach(async () => {
    if (apiServer) {
      await closeHttpServer(apiServer);
      apiServer = undefined;
    }
    if (anvil) {
      await stopProcess(anvil);
      anvil = undefined;
    }
  });

  maybeIt("indexes registry logs with Viem and serves revoked plan trust over HTTP", async () => {
    execFileSync("forge", ["build"], { cwd: contractsDir, stdio: "pipe" });

    const rpcPort = await freePort();
    const rpcUrl = `http://127.0.0.1:${rpcPort}`;
    anvil = spawn("anvil", ["--host", "127.0.0.1", "--port", String(rpcPort), "--chain-id", "31337"], {
      stdio: "ignore"
    });

    const publicClient = createPublicClient({ transport: http(rpcUrl) });
    await waitForRpc(publicClient);
    const chainId = await publicClient.getChainId();
    const account = privateKeyToAccount(anvilPrivateKey as Hex);
    const wallet = createWalletClient({
      account,
      chain: {
        id: chainId,
        name: "anvil",
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: { default: { http: [rpcUrl] } }
      },
      transport: http(rpcUrl)
    });

    const artifact = await readRegistryArtifact();
    const deployHash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode });
    const deployReceipt = await publicClient.waitForTransactionReceipt({ hash: deployHash });
    const registry = getAddress(deployReceipt.contractAddress as Address);

    const domainId = hashText("chain-services:test-domain");
    const planId = hashText("chain-services:test-plan");
    const planHash = hashText("plan-hash");
    const artifactHash = hashText("artifact-hash");
    const policyHash = hashText("policy-hash");
    const metadataHash = hashText("metadata-hash");
    const reasonHash = hashText("reason-hash");
    const supplierSubjectId = hashText("chain-services:test-supplier");
    const supplierWallet = getAddress("0x4444444444444444444444444444444444444444");
    const profileHash = hashText("profile-hash");
    const capabilityHash = hashText("capability-hash");
    const reputationHash = hashText("reputation-hash");

    await writeAndWait(publicClient, await wallet.writeContract({
      address: registry,
      abi: artifact.abi,
      functionName: "registerDomain",
      args: [domainId, metadataHash, "uvp-eth://domains/test"]
    }));
    await writeAndWait(publicClient, await wallet.writeContract({
      address: registry,
      abi: artifact.abi,
      functionName: "attestPlan",
      args: [domainId, planId, planHash, artifactHash, policyHash, metadataHash, "uvp-eth://plans/test"]
    }));
    await writeAndWait(publicClient, await wallet.writeContract({
      address: registry,
      abi: artifact.abi,
      functionName: "revokePlan",
      args: [domainId, planId, reasonHash, "uvp-eth://revocations/test"]
    }));

    apiServer = await startApiServer(testConfig({
      chainId,
      rpcUrl,
      deploymentBlock: deployReceipt.blockNumber,
      registry
    }), new MemoryProjectionStore());

    const apiBase = httpServerBaseUrl(apiServer);
    const response = await fetch(`${apiBase}/trust/plans?domainId=${domainId}&planId=${planId}`);
    const body = await response.json() as { readonly plans?: Array<{ readonly revoked?: boolean; readonly revokeReasonHash?: string }> };

    expect(response.status).toBe(200);
    expect(body.plans).toHaveLength(1);
    expect(body.plans?.[0]?.revoked).toBe(true);
    expect(body.plans?.[0]?.revokeReasonHash).toBe(reasonHash);

    await writeAndWait(publicClient, await wallet.writeContract({
      address: registry,
      abi: artifact.abi,
      functionName: "attestSupplier",
      args: [
        domainId,
        supplierSubjectId,
        supplierWallet,
        profileHash,
        capabilityHash,
        reputationHash,
        "uvp-eth://suppliers/test"
      ]
    }));
    await writeAndWait(publicClient, await wallet.writeContract({
      address: registry,
      abi: artifact.abi,
      functionName: "revokeSupplier",
      args: [domainId, supplierSubjectId, reasonHash, "uvp-eth://supplier-revocations/test"]
    }));

    const supplier = await waitForSupplierTrust(apiBase, domainId, supplierSubjectId);
    expect(supplier.revoked).toBe(true);
    expect(supplier.revokeReasonHash).toBe(reasonHash);

    const optionsResponse = await fetch(`${apiBase}/trust/plans?domainId=${domainId}&planId=${planId}`, {
      method: "OPTIONS"
    });
    expect(optionsResponse.status).toBe(204);
    expect(optionsResponse.headers.get("access-control-allow-origin")).toBe("*");
  }, 120_000);
});

interface RegistryArtifact {
  readonly abi: Abi;
  readonly bytecode: Hex;
}

async function readRegistryArtifact(): Promise<RegistryArtifact> {
  const artifact = JSON.parse(await readFile(registryArtifactPath, "utf8")) as {
    readonly abi: Abi;
    readonly bytecode: { readonly object: string };
  };
  const bytecode = artifact.bytecode.object.startsWith("0x")
    ? artifact.bytecode.object
    : `0x${artifact.bytecode.object}`;
  return {
    abi: artifact.abi,
    bytecode: bytecode as Hex
  };
}

function testConfig(input: {
  readonly chainId: number;
  readonly rpcUrl: string;
  readonly deploymentBlock: bigint;
  readonly registry: Address;
}): ChainServicesConfig {
  return {
    network: {
      chainId: input.chainId,
      rpcUrl: input.rpcUrl,
      deploymentBlock: input.deploymentBlock,
      finalityConfirmations: 0,
      reorgBufferBlocks: 0,
      contracts: {
        ZhixuTrustRegistry: input.registry
      }
    },
    database: {
      driver: "memory",
      url: "memory://projection-store",
      migrationsAutoRun: false
    },
    api: {
      host: "127.0.0.1",
      port: 0,
      indexerPollIntervalMs: 50
    },
    relayer: {
      businessSigning: "forbidden",
      broadcastEnabled: false,
      stateMachinePrivateKeyEnv: "UVP_STATE_MACHINE_RELAYER_PRIVATE_KEY",
      maxRetries: 0
    },
    governance: {
      broadcastEnabled: false,
      rpcUrl: input.rpcUrl,
      chainId: input.chainId,
      txConfirmations: 1,
      allowedOperators: []
    },
    productBff: {
      registrationAdapter: "memory",
      registrarPrivateKeyEnv: "UVP_PRODUCT_BFF_REGISTRAR_PRIVATE_KEY",
      waitForReceipt: false
    },
    operatorRoles: {
      deployerPrivateKeyEnv: "UVP_ETH_DEPLOYER_PRIVATE_KEY",
      participantWallets: [],
      adminReviewers: []
    },
    reconcile: {
      enabled: false,
      pollIntervalMs: 50,
      txTimeoutMs: 60_000
    },
    evidenceStorage: {
      adapter: "local",
      objectNamespace: "uvp-rehearsal"
    },
    security: {
      environment: "local",
      preflightStrict: false,
      logRedactionEnabled: true,
      broadcastMaxInFlightPerOrder: 1,
      broadcastMaxRetry: 0,
      broadcastRetryBaseMs: 250,
      broadcastRetryMaxMs: 5_000,
      broadcastReceiptTimeoutMs: 0
    }
  };
}

async function writeAndWait(publicClient: ReturnType<typeof createPublicClient>, hash: Hex): Promise<void> {
  await publicClient.waitForTransactionReceipt({ hash });
}

function hashText(value: string): Hex {
  return keccak256(stringToBytes(value));
}

function commandExists(command: string): boolean {
  return spawnSync(command, ["--version"], { stdio: "ignore" }).status === 0;
}

async function waitForRpc(publicClient: ReturnType<typeof createPublicClient>): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await publicClient.getChainId();
      return;
    } catch {
      await delay(250);
    }
  }
  throw new Error("anvil RPC did not become ready");
}

async function freePort(): Promise<number> {
  return await new Promise((resolvePromise, reject) => {
    const server = createNetServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("could not allocate a TCP port")));
        return;
      }
      const port = address.port;
      server.close(() => resolvePromise(port));
    });
  });
}

function httpServerBaseUrl(server: Server): string {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected TCP API server address");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function waitForSupplierTrust(
  apiBase: string,
  domainId: Hex,
  supplierSubjectId: Hex
): Promise<{ readonly revoked?: boolean; readonly revokeReasonHash?: string }> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await fetch(`${apiBase}/trust/suppliers?domainId=${domainId}&supplierSubjectId=${supplierSubjectId}`);
    const body = await response.json() as {
      readonly suppliers?: Array<{ readonly revoked?: boolean; readonly revokeReasonHash?: string }>;
    };
    const supplier = body.suppliers?.[0];
    if (response.status === 200 && supplier?.revoked === true) {
      return supplier;
    }
    await delay(100);
  }
  throw new Error("supplier trust projection did not refresh to revoked=true");
}

async function closeHttpServer(server: Server): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    server.close((error) => (error ? reject(error) : resolvePromise()));
  });
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise())),
    delay(2_000)
  ]);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
