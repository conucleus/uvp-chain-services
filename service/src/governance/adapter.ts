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
import { ConfigError, consoleLogger, normalizeAddress, normalizeBytes32, type Address, type Hex, type Logger } from "../shared/types.js";
import { redactErrorMessage } from "../security/redaction.js";
import {
  isDuplicateTransactionReport,
  resolveDuplicateTransactionOutcome
} from "../shared/broadcast/duplicate-transaction.js";
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
  getTransactionReceipt?(parameters: {
    readonly hash: Hex;
  }): Promise<{
    readonly status?: "success" | "reverted" | string;
    readonly blockNumber?: bigint;
  } | undefined | null>;
  getBlockNumber?(parameters?: undefined): Promise<bigint>;
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
  readonly logger?: Logger;
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

export function createConfiguredGovernanceChainAdapter(
  config: ChainServicesConfig,
  options: { readonly logger?: Logger } = {}
): GovernanceChainAdapter {
  if (!config.governance.broadcastEnabled) {
    if (config.security.environment === "local") {
      return createSimulatedGovernanceChainAdapter();
    }
    if (config.security.environment === "production") {
      return createRefusingGovernanceChainAdapter(
        "governance broadcast is disabled: production forbids env private-key governance (GOVERNANCE_BROADCAST_ENABLED) and no production governance signer is assembled; identity registration/revocation is refused until a production governance integration is wired"
      );
    }
    throw new ConfigError(
      `GOVERNANCE_BROADCAST_ENABLED=true is required in ${config.security.environment}; the simulated governance adapter is only available in local`
    );
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
    allowedOperators: config.governance.allowedOperators,
    ...(options.logger ? { logger: options.logger } : {})
  });
}

export function createRefusingGovernanceChainAdapter(reason: string): GovernanceChainAdapter {
  return {
    async registerIdentity() {
      return refusedBroadcastResult(reason);
    },
    async revokeIdentity() {
      return refusedBroadcastResult(reason);
    }
  };
}

function refusedBroadcastResult(reason: string): GovernanceBroadcastResultDTO {
  return {
    status: "failed",
    errorCode: "governance_broadcast_disabled",
    message: reason,
    retryable: true,
    simulated: false
  };
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
  const logger = options.logger ?? consoleLogger;

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

    let broadcastTxHash: ReturnType<typeof normalizeTxHash> | undefined;
    try {
      const txHash = normalizeTxHash(await walletClient.writeContract({
        address: contractAddress as ViemAddress,
        abi: uvpIdentityRegistryAbi,
        account,
        chain,
        functionName,
        args
      }));
      broadcastTxHash = txHash;

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
      if (isDuplicateTransactionReport(governanceErrorHaystack(error))) {
        return adjudicatedDuplicateGovernanceBroadcast(error, publicClient, signer, options.txConfirmations, logger);
      }
      return {
        ...failedBroadcast({
          errorCode: "broadcast_failed",
          message: sanitizedErrorMessage(error, options.privateKey),
          retryable: isRetryableBroadcastError(error),
          signer
        }),
        ...(broadcastTxHash ? { txHash: broadcastTxHash } : {})
      };
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
  readonly txHash?: Hex;
  readonly blockNumber?: string;
}): GovernanceBroadcastResultDTO {
  return {
    status: "failed",
    ...(input.signer ? { signer: input.signer } : {}),
    ...(input.txHash ? { txHash: input.txHash } : {}),
    ...(input.blockNumber ? { blockNumber: input.blockNumber } : {}),
    errorCode: input.errorCode,
    message: input.message,
    retryable: input.retryable,
    simulated: false
  };
}

async function adjudicatedDuplicateGovernanceBroadcast(
  error: unknown,
  publicClient: GovernancePublicClient,
  signer: Address,
  txConfirmations: number,
  logger: Logger
): Promise<GovernanceBroadcastResultDTO> {
  const getReceipt = publicClient.getTransactionReceipt
    ? (txHash: Hex) => probeDuplicateReceiptAtDepth(publicClient, txHash, txConfirmations)
    : undefined;
  return resolveDuplicateTransactionOutcome(
    error,
    getReceipt,
    {
      onSubmitted: ({ txHash, blockNumber }) => ({
        status: "confirmed",
        txHash,
        ...(blockNumber !== undefined ? { blockNumber } : {}),
        signer,
        retryable: false,
        simulated: false
      }),
      onReceiptFailed: ({ txHash, blockNumber }) => failedBroadcast({
        errorCode: "transaction_reverted",
        message: "the duplicate governance transaction was mined and reverted on chain",
        retryable: false,
        signer,
        txHash,
        ...(blockNumber !== undefined ? { blockNumber } : {})
      }),
      onReceiptUnknown: ({ txHash }) => failedBroadcast({
        errorCode: "transaction_receipt_unknown",
        message: "broadcaster reported a duplicate governance transaction but no receipt is available yet; the candidate hash is retained for the next probe",
        retryable: true,
        signer,
        txHash
      }),
      onReassemblableNonceRace: () => failedBroadcast({
        errorCode: "duplicate_transaction",
        message: "broadcaster reported a nonce race without an attributable transaction hash; the governance request can be re-assembled with a fresh gas nonce",
        retryable: true,
        signer
      })
    },
    (txHash, probeError) => {
      logger.warn(
        "governance duplicate-transaction receipt probe failed; the candidate hash stays retryable",
        { txHash, message: redactErrorMessage(probeError) }
      );
    }
  );
}

async function probeDuplicateReceiptAtDepth(
  publicClient: GovernancePublicClient,
  txHash: Hex,
  txConfirmations: number
): Promise<{ readonly status?: "success" | "reverted" | string; readonly blockNumber?: bigint } | undefined | null> {
  const receipt = await publicClient.getTransactionReceipt!({ hash: txHash });
  if (!receipt || receipt.status !== "success" || !publicClient.getBlockNumber) {
    return receipt;
  }
  if (receipt.blockNumber === undefined) {
    return undefined;
  }
  const latest = await publicClient.getBlockNumber();
  if (latest - receipt.blockNumber + 1n < BigInt(Math.max(txConfirmations, 1))) {
    return undefined;
  }
  return receipt;
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
  const haystack = governanceErrorHaystack(error);
  if (
    /unknownrpcerror|rpcerror|httprequesterror|websocketerror|timeouterror|resourceunavailable/i.test(haystack) ||
    /timeout|timed out|etimedout|econnreset|econnrefused|aborterror|fetch failed|network error|rpc unavailable/i.test(haystack)
  ) {
    return true;
  }
  if (haystack.includes("revert") || haystack.includes("notowner") || haystack.includes("not owner")) {
    return false;
  }
  return true;
}

function governanceErrorHaystack(error: unknown): string {
  const name = findGovernanceErrorName(error);
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return `${name ?? ""} ${message}`;
}

function findGovernanceErrorName(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const record = error as Record<string, unknown>;
  if (typeof record.errorName === "string") {
    return record.errorName;
  }
  if (typeof record.name === "string") {
    return record.name;
  }
  if (record.cause) {
    return findGovernanceErrorName(record.cause);
  }
  return undefined;
}

const zeroAddress = "0x0000000000000000000000000000000000000000";
