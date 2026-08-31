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
const registryArtifactPath = resolve(contractsDir, "out/UVPIdentityRegistry.sol/UVPIdentityRegistry.json");
const anvilPrivateKey = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const canRunAnvil = commandExists("anvil") && commandExists("forge");
const maybeIt = canRunAnvil ? it : it.skip;

describe("anvil identity registry indexing", () => {
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

  maybeIt("indexes identity binding registration and revocation over HTTP", async () => {
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

    const reasonHash = hashText("reason-hash");
    const supplierSubjectId = hashText("chain-services:test-supplier");
    const supplierWallet = getAddress("0x4444444444444444444444444444444444444444");
    const descriptorHash = hashText("identity-descriptor");

    await writeAndWait(publicClient, await wallet.writeContract({
      address: registry,
      abi: artifact.abi,
      functionName: "registerIdentityBinding",
      args: [supplierSubjectId, supplierWallet, descriptorHash, "uvp-store://identities/test"]
    }));
    const bindingId = await publicClient.readContract({
      address: registry,
      abi: artifact.abi,
      functionName: "activeBindingForAccount",
      args: [supplierWallet]
    }) as Hex;
    await writeAndWait(publicClient, await wallet.writeContract({
      address: registry,
      abi: artifact.abi,
      functionName: "revokeIdentityBinding",
      args: [bindingId, reasonHash, "uvp-store://identity-revocations/test"]
    }));

    apiServer = await startApiServer(testConfig({
      chainId,
      rpcUrl,
      deploymentBlock: deployReceipt.blockNumber,
      registry
    }), new MemoryProjectionStore());

    const apiBase = httpServerBaseUrl(apiServer);
    const identity = await waitForIdentityBinding(apiBase, registry, bindingId);

    expect(identity.status).toBe("revoked");
    expect(identity.revokeReasonHash).toBe(reasonHash);
    expect(identity.account).toBe(supplierWallet.toLowerCase());

    const optionsResponse = await fetch(`${apiBase}/identity/bindings?registryAddress=${registry}&bindingId=${bindingId}`, {
      method: "OPTIONS"
    });
    expect(optionsResponse.status).toBe(204);
    // 模-5 裁决：跨源默认关闭。未配置 UVP_API_CORS_ALLOWED_ORIGINS 时不回
    // allow-origin 头（通配 "*" 已废除）。
    expect(optionsResponse.headers.get("access-control-allow-origin")).toBeNull();
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
        UVPIdentityRegistry: input.registry,
        UVPStateMachine: "0x1111111111111111111111111111111111111111"
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
      registrationAdapter: "memory-trigger",
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
    dockedSignalAutomation: {
      enabled: false,
      maxCandidatesPerRun: 4,
      maxGasPerTx: 500_000n,
      waitForReceipt: true
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

async function waitForIdentityBinding(
  apiBase: string,
  registryAddress: Address,
  bindingId: Hex
): Promise<{ readonly status?: string; readonly revokeReasonHash?: string; readonly account?: string }> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await fetch(`${apiBase}/identity/bindings?registryAddress=${registryAddress}&bindingId=${bindingId}`);
    const body = await response.json() as {
      readonly bindings?: Array<{ readonly status?: string; readonly revokeReasonHash?: string; readonly account?: string }>;
    };
    const identity = body.bindings?.[0];
    if (response.status === 200 && identity?.status === "revoked") {
      return identity;
    }
    await delay(100);
  }
  throw new Error("identity binding projection did not reach revoked status");
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
