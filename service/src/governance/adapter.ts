import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  type Address as ViemAddress,
  type Chain
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { ChainServicesConfig } from "../config/index.js";
import { hashGovernanceCanonicalJson } from "./hashing.js";
import { ConfigError, normalizeAddress, normalizeBytes32, type Address, type Hex } from "../shared/types.js";
import { redactErrorMessage } from "../security/redaction.js";
import type {
  GovernanceBroadcastResultDTO,
  IdentityRegistrationRequestDTO,
  IdentityRevocationRequestDTO
} from "./types.js";

const uvpIdentityRegistryAbi = parseAbi([
  "function owner() view returns (address)",
  "function registerIdentityBinding(bytes32 subjectId,address account,bytes32 descriptorHash,string descriptorURI) returns (bytes32 bindingId)",
  "function revokeIdentityBinding(bytes32 bindingId,bytes32 reasonHash,string reasonURI)"
]);

export type GovernanceWriteFunctionName = "registerIdentityBinding" | "revokeIdentityBinding";

export interface GovernancePublicClient {
  getChainId(): Promise<number>;
  readContract(parameters: {
    readonly address: ViemAddress;
    readonly abi: unknown;
    readonly functionName: "owner";
    readonly args?: readonly unknown[];
  }): Promise<unknown>;
  waitForTransactionReceipt(parameters: {
    readonly hash: Hex;
    readonly confirmations?: number;
  }): Promise<{
    readonly status: "success" | "reverted";
    readonly blockNumber?: bigint;
  }>;
}

export interface GovernanceWalletClient {
  writeContract(parameters: {
    readonly address: ViemAddress;
    readonly abi: unknown;
    readonly account: unknown;
    readonly chain: Chain;
    readonly functionName: GovernanceWriteFunctionName;
    readonly args: readonly unknown[];
  }): Promise<Hex>;
}

export interface GovernanceBroadcasterAdapterOptions {
  readonly rpcUrl: string;
  readonly chainId: number;
  readonly contractAddress: Address;
  readonly privateKey: Hex;
  readonly txConfirmations: number;
  readonly allowedOperators?: readonly Address[];
  readonly publicClient?: GovernancePublicClient;
  readonly walletClient?: GovernanceWalletClient;
}

export interface GovernanceChainAdapter {
  registerIdentity(request: IdentityRegistrationRequestDTO): Promise<GovernanceBroadcastResultDTO>;
  revokeIdentity(request: IdentityRevocationRequestDTO): Promise<GovernanceBroadcastResultDTO>;
}

export function createSimulatedGovernanceChainAdapter(): GovernanceChainAdapter {
  return {
    async registerIdentity(request) {
      return simulatedBroadcast(request);
    },
    async revokeIdentity(request) {
      return simulatedBroadcast(request);
    }
  };
}

function simulatedBroadcast(request: unknown): GovernanceBroadcastResultDTO {
  return {
    status: "simulated_tx",
    txHash: hashGovernanceCanonicalJson({
      version: 1,
      kind: "simulatedGovernanceTransaction",
      request
    }, "txHash"),
    retryable: false,
    simulated: true
  };
}

export function createConfiguredGovernanceChainAdapter(config: ChainServicesConfig): GovernanceChainAdapter {
  if (!config.governance.broadcastEnabled) {
    return createSimulatedGovernanceChainAdapter();
  }

  const contractAddress = identityRegistryAddress(config.network.contracts);
  if (!contractAddress) {
    throw new ConfigError("UVPIdentityRegistry contract address is required when governance broadcast is enabled");
  }
  if (!config.governance.signerPrivateKey) {
    throw new ConfigError(`${config.governance.signerPrivateKeyEnv} is required when governance broadcast is enabled`);
  }

  return createGovernanceBroadcasterAdapter({
    rpcUrl: config.governance.rpcUrl,
    chainId: config.governance.chainId,
    contractAddress,
    privateKey: config.governance.signerPrivateKey,
    txConfirmations: config.governance.txConfirmations,
    allowedOperators: config.governance.allowedOperators
  });
}

export function createGovernanceBroadcasterAdapter(
  options: GovernanceBroadcasterAdapterOptions
): GovernanceChainAdapter {
  const contractAddress = normalizeAddress(options.contractAddress, "governance contract address");
  if (contractAddress === zeroAddress) {
    throw new ConfigError("governance contract address must not be zero");
  }
  const account = privateKeyToAccount(options.privateKey);
  const signer = normalizeAddress(account.address, "governance signer");
  const allowedOperators = new Set(
    (options.allowedOperators ?? []).map((address) => normalizeAddress(address, "governance allowed operator"))
  );
  const chain = governanceChain(options.chainId, options.rpcUrl);
  const publicClient = options.publicClient ?? createPublicClient({
    chain,
    transport: http(options.rpcUrl)
  }) as GovernancePublicClient;
  const walletClient = options.walletClient ?? createWalletClient({
    account,
    chain,
    transport: http(options.rpcUrl)
  }) as GovernanceWalletClient;

  async function broadcast(
    request: IdentityRegistrationRequestDTO | IdentityRevocationRequestDTO,
    functionName: GovernanceWriteFunctionName,
    args: readonly unknown[]
  ): Promise<GovernanceBroadcastResultDTO> {
    const preflight = await preflightBroadcast({
      chainId: options.chainId,
      signer,
      allowedOperators,
      contractAddress,
      publicClient,
      privateKey: options.privateKey
    });
    if (preflight) {
      return preflight;
    }

    try {
      const txHash = normalizeTxHash(await walletClient.writeContract({
        address: contractAddress as ViemAddress,
        abi: uvpIdentityRegistryAbi,
        account,
        chain,
        functionName,
        args
      }));

      if (options.txConfirmations <= 0) {
        return {
          status: "submitted",
          txHash,
          signer,
          retryable: false,
          simulated: false
        };
      }

      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
        confirmations: options.txConfirmations
      });
      const blockNumber = receipt.blockNumber?.toString();
      if (receipt.status === "reverted") {
        return {
          status: "failed",
          txHash,
          ...(blockNumber ? { blockNumber } : {}),
          signer,
          errorCode: "transaction_reverted",
          message: "governance transaction reverted",
          retryable: false,
          simulated: false
        };
      }

      return {
        status: "confirmed",
        txHash,
        ...(blockNumber ? { blockNumber } : {}),
        signer,
        retryable: false,
        simulated: false
      };
    } catch (error) {
      return failedBroadcast({
        errorCode: "broadcast_failed",
        message: sanitizedErrorMessage(error, options.privateKey),
        retryable: isRetryableBroadcastError(error),
        signer
      });
    }
  }

  return {
    registerIdentity(request) {
      return broadcast(request, "registerIdentityBinding", [
        request.subjectId,
        request.account,
        request.descriptorHash,
        request.descriptorURI
      ]);
    },
    revokeIdentity(request) {
      return broadcast(request, "revokeIdentityBinding", [
        request.bindingId,
        request.reasonHash,
        request.reasonURI
      ]);
    }
  };
}

async function preflightBroadcast(input: {
  readonly chainId: number;
  readonly signer: Address;
  readonly allowedOperators: ReadonlySet<Address>;
  readonly contractAddress: Address;
  readonly publicClient: GovernancePublicClient;
  readonly privateKey: Hex;
}): Promise<GovernanceBroadcastResultDTO | undefined> {
  try {
    const chainId = await input.publicClient.getChainId();
    if (chainId !== input.chainId) {
      return failedBroadcast({
        errorCode: "governance_chain_id_mismatch",
        message: `RPC chainId ${chainId} does not match configured governance chainId ${input.chainId}`,
        retryable: false,
        signer: input.signer
      });
    }
  } catch (error) {
    return failedBroadcast({
      errorCode: "governance_chain_id_unavailable",
      message: sanitizedErrorMessage(error, input.privateKey),
      retryable: true,
      signer: input.signer
    });
  }

  let owner: Address;
  try {
    owner = normalizeAddress(String(await input.publicClient.readContract({
      address: input.contractAddress as ViemAddress,
      abi: uvpIdentityRegistryAbi,
      functionName: "owner"
    })), "governance registry owner");
  } catch (error) {
    return failedBroadcast({
      errorCode: "governance_registry_owner_unavailable",
      message: sanitizedErrorMessage(error, input.privateKey),
      retryable: isRetryableBroadcastError(error),
      signer: input.signer
    });
  }

  if (owner !== input.signer && !input.allowedOperators.has(input.signer)) {
    return failedBroadcast({
      errorCode: "governance_signer_not_authorized",
      message: "governance signer is not the registry owner or an allowed operator",
      retryable: false,
      signer: input.signer
    });
  }

  return undefined;
}

function failedBroadcast(input: {
  readonly errorCode: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly signer?: Address;
}): GovernanceBroadcastResultDTO {
  return {
    status: "failed",
    ...(input.signer ? { signer: input.signer } : {}),
    errorCode: input.errorCode,
    message: input.message,
    retryable: input.retryable,
    simulated: false
  };
}

function identityRegistryAddress(contracts: Readonly<Record<string, Address>>): Address | undefined {
  const address = contracts.UVPIdentityRegistry;
  return address && address !== zeroAddress
    ? normalizeAddress(address, "contract UVPIdentityRegistry")
    : undefined;
}

function governanceChain(chainId: number, rpcUrl: string): Chain {
  return {
    id: chainId,
    name: `governance-${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: {
      default: { http: [rpcUrl] }
    }
  };
}

function normalizeTxHash(value: Hex): Hex {
  return normalizeBytes32(value, "transaction hash");
}

function sanitizedErrorMessage(error: unknown, privateKey: Hex): string {
  const message = error instanceof Error ? error.message : "unknown governance broadcast error";
  return redactErrorMessage(message.split(privateKey).join("[redacted]"));
}

function isRetryableBroadcastError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("revert") || message.includes("notowner") || message.includes("unknown")) {
    return false;
  }
  return true;
}

const zeroAddress = "0x0000000000000000000000000000000000000000";
