import { createPublicClient, createWalletClient, http, type Chain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { buildSubmitDockedSignalCall, DOCKING_MODULE_ABI } from "@uvp-eth/protocol-bindings";
import { ConfigError, normalizeAddress, type Address, type Hex } from "../shared/types.js";
import { redactErrorMessage } from "../security/redaction.js";
import type {
  DockedSignalBroadcastAdapter,
  DockedSignalBroadcastResult,
  DockedSignalCandidate
} from "./types.js";

export interface DockedSignalPublicClient {
  getChainId?(): Promise<number>;
  estimateContractGas?(args: SubmitDockedSignalWriteArgs): Promise<bigint>;
  waitForTransactionReceipt?(args: { readonly hash: Hex; readonly timeout?: number }): Promise<{
    readonly status?: "success" | "reverted" | string;
    readonly blockNumber?: bigint;
  }>;
}

export interface SubmitDockedSignalCall {
  readonly address: Address;
  readonly abi: typeof DOCKING_MODULE_ABI;
  readonly functionName: "submitDockedSignal";
  readonly args: readonly [Hex, Hex, Hex, Hex, Hex];
  readonly data: Hex;
  readonly chainId?: number;
}

export interface SubmitDockedSignalWriteArgs extends SubmitDockedSignalCall {
  readonly account?: Address;
}

export interface DockedSignalWalletClient {
  readonly account?: { readonly address?: string };
  writeContract(call: SubmitDockedSignalCall): Promise<Hex>;
}

export interface StateMachineDockedSignalBroadcastAdapterOptions {
  readonly chainId: number;
  readonly rpcUrl?: string;
  readonly relayerPrivateKey?: Hex;
  readonly relayerPrivateKeyEnv?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly publicClient?: DockedSignalPublicClient;
  readonly walletClient?: DockedSignalWalletClient;
  readonly waitForReceipt?: boolean;
  readonly confirmOnReceipt?: boolean;
  readonly receiptTimeoutMs?: number;
  readonly maxGasPerTx?: bigint;
}

const DEFAULT_RELAYER_PRIVATE_KEY_ENV = "UVP_STATE_MACHINE_RELAYER_PRIVATE_KEY";

export function createStateMachineDockedSignalBroadcastAdapter(
  options: StateMachineDockedSignalBroadcastAdapterOptions
): DockedSignalBroadcastAdapter {
  const chain = options.rpcUrl ? chainFor(options.chainId, options.rpcUrl) : undefined;
  const publicClient: DockedSignalPublicClient = options.publicClient ?? createPublicClient({
    ...(chain ? { chain } : {}),
    transport: http(requiredRpcUrl(options.rpcUrl))
  });
  const account = options.walletClient ? undefined : privateKeyToAccount(loadRelayerPrivateKey(options));
  const walletClient: DockedSignalWalletClient = options.walletClient ?? (createWalletClient({
    account,
    ...(chain ? { chain } : {}),
    transport: http(requiredRpcUrl(options.rpcUrl))
  }) as unknown as DockedSignalWalletClient);
  const gasPayer = normalizeGasPayer(options.walletClient?.account?.address ?? account?.address);
  const waitForReceipt = options.waitForReceipt ?? true;

  return {
    async broadcast(candidate): Promise<DockedSignalBroadcastResult> {
      const call = buildSubmitDockedSignalCall({
        dockingModuleAddress: candidate.dockingModuleAddress,
        ...(candidate.chainId !== undefined ? { chainId: candidate.chainId } : {})
      }, {
        localOrderId: candidate.binding.localOrderId,
        linkedOrderId: candidate.binding.linkedOrderId,
        linkedSourceId: candidate.binding.linkedSourceId,
        linkedSignalId: candidate.binding.linkedSignalId,
        idempotencyKey: candidate.idempotencyKey
      }) as SubmitDockedSignalCall;

      const chainId = await publicClient.getChainId?.();
      if (chainId !== undefined && chainId !== options.chainId) {
        return failedResult(
          candidate,
          "chain_id_mismatch",
          `configured chainId ${options.chainId} does not match RPC chainId ${chainId}`,
          false,
          gasPayer
        );
      }

      const gasCheck = await estimateGas(publicClient, call, gasPayer, options.maxGasPerTx, candidate);
      if (gasCheck) {
        return gasCheck;
      }

      let txHash: Hex;
      try {
        txHash = await walletClient.writeContract(call);
      } catch (error) {
        const classified = classifyDockedSignalBroadcastError(error);
        return failedResult(candidate, classified.errorCode, classified.message, classified.retryable, gasPayer);
      }

      if (!waitForReceipt) {
        return {
          status: "submitted",
          candidateId: candidate.candidateId,
          txHash,
          attempt: {
            status: "submitted",
            ...(gasPayer ? { gasPayer } : {}),
            txHash,
            retryable: false
          }
        };
      }

      try {
        const receipt = await publicClient.waitForTransactionReceipt?.({
          hash: txHash,
          ...(options.receiptTimeoutMs && options.receiptTimeoutMs > 0 ? { timeout: options.receiptTimeoutMs } : {})
        });
        if (receipt?.status === "reverted") {
          return failedResult(candidate, "transaction_reverted", "transaction reverted", false, gasPayer, txHash, receipt.blockNumber?.toString());
        }
        const status = options.confirmOnReceipt ? "confirmed" : "submitted";
        return {
          status,
          candidateId: candidate.candidateId,
          txHash,
          ...(receipt?.blockNumber !== undefined ? { blockNumber: receipt.blockNumber.toString() } : {}),
          attempt: {
            status,
            ...(gasPayer ? { gasPayer } : {}),
            txHash,
            ...(receipt?.blockNumber !== undefined ? { blockNumber: receipt.blockNumber.toString() } : {}),
            retryable: false
          }
        };
      } catch (error) {
        const classified = classifyDockedSignalBroadcastError(error);
        return failedResult(candidate, classified.errorCode, classified.message, classified.retryable, gasPayer, txHash);
      }
    }
  };
}

export function notSupportedDockedSignalBroadcastAdapter(reason = "docked signal automation broadcast is not configured"): DockedSignalBroadcastAdapter {
  return {
    async broadcast(candidate) {
      return {
        status: "skipped",
        candidateId: candidate.candidateId,
        reason,
        attempt: {
          status: "skipped",
          errorCode: "broadcast_disabled",
          message: reason,
          retryable: false
        }
      };
    }
  };
}

async function estimateGas(
  publicClient: DockedSignalPublicClient,
  call: SubmitDockedSignalCall,
  gasPayer: Address | undefined,
  maxGasPerTx: bigint | undefined,
  candidate: DockedSignalCandidate
): Promise<DockedSignalBroadcastResult | undefined> {
  if (!publicClient.estimateContractGas) {
    return undefined;
  }
  try {
    const estimatedGas = await publicClient.estimateContractGas({
      ...call,
      ...(gasPayer ? { account: gasPayer } : {})
    });
    if (maxGasPerTx !== undefined && estimatedGas > maxGasPerTx) {
      return {
        status: "skipped",
        candidateId: candidate.candidateId,
        reason: "estimated gas exceeds docked signal automation cap",
        attempt: {
          status: "skipped",
          ...(gasPayer ? { gasPayer } : {}),
          estimatedGas: estimatedGas.toString(),
          errorCode: "estimated_gas_exceeds_cap",
          message: `estimated gas ${estimatedGas.toString()} exceeds cap ${maxGasPerTx.toString()}`,
          retryable: false
        }
      };
    }
  } catch (error) {
    const classified = classifyDockedSignalBroadcastError(error);
    return failedResult(candidate, classified.errorCode, classified.message, classified.retryable, gasPayer);
  }
  return undefined;
}

function failedResult(
  candidate: DockedSignalCandidate,
  errorCode: string,
  message: string,
  retryable: boolean,
  gasPayer?: Address,
  txHash?: Hex,
  blockNumber?: string
): DockedSignalBroadcastResult {
  return {
    status: "failed",
    candidateId: candidate.candidateId,
    errorCode,
    reason: message,
    ...(txHash ? { txHash } : {}),
    ...(blockNumber ? { blockNumber } : {}),
    attempt: {
      status: "failed",
      ...(gasPayer ? { gasPayer } : {}),
      ...(txHash ? { txHash } : {}),
      ...(blockNumber ? { blockNumber } : {}),
      errorCode,
      message,
      retryable
    }
  };
}

function classifyDockedSignalBroadcastError(error: unknown): {
  readonly errorCode: string;
  readonly message: string;
  readonly retryable: boolean;
} {
  const message = redactErrorMessage(error);
  const haystack = `${findErrorName(error) ?? ""} ${message}`;
  if (/SignalAlreadyExists/i.test(haystack)) {
    return {
      errorCode: "signal_already_exists",
      message: "mapped local signal already exists",
      retryable: false
    };
  }
  if (/DockedSignalBindingNotFound|UnknownDockedOrderLink|UnknownLinkedOrder|UnknownOrder/i.test(haystack)) {
    return {
      errorCode: "docked_signal_not_available",
      message,
      retryable: false
    };
  }
  if (/chain_id_mismatch|InvalidInput|Zero/i.test(haystack)) {
    return {
      errorCode: "invalid_docked_signal_request",
      message,
      retryable: false
    };
  }
  return {
    errorCode: "docked_signal_broadcast_failed",
    message,
    retryable: true
  };
}

function findErrorName(error: unknown): string | undefined {
  if (error && typeof error === "object" && "name" in error && typeof (error as { readonly name?: unknown }).name === "string") {
    return (error as { readonly name: string }).name;
  }
  return undefined;
}

function normalizeGasPayer(value: string | undefined): Address | undefined {
  return value ? normalizeAddress(value, "gasPayer") : undefined;
}

function loadRelayerPrivateKey(options: StateMachineDockedSignalBroadcastAdapterOptions): Hex {
  if (options.relayerPrivateKey) {
    return options.relayerPrivateKey;
  }
  const env = options.env ?? process.env;
  const envName = options.relayerPrivateKeyEnv ?? DEFAULT_RELAYER_PRIVATE_KEY_ENV;
  const value = env[envName]?.trim();
  if (!value) {
    throw new ConfigError(`${envName} is required when walletClient is not provided`);
  }
  return value as Hex;
}

function requiredRpcUrl(rpcUrl: string | undefined): string {
  if (!rpcUrl) {
    throw new ConfigError("rpcUrl is required when publicClient or walletClient is not provided");
  }
  return rpcUrl;
}

function chainFor(chainId: number, rpcUrl: string): Chain {
  return {
    id: chainId,
    name: `uvp-${chainId}`,
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
    rpcUrls: {
      default: { http: [rpcUrl] }
    }
  };
}
