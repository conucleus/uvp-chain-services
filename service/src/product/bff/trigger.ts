import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  keccak256,
  stringToBytes
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  STATE_MACHINE_ABI,
  buildTriggerOrderFromOutsideForCall
} from "@uvp-eth/protocol-bindings";
import { ConfigError, normalizeAddress, type Address, type Hex } from "../../shared/types.js";
import type { ProductOrderTriggerStatus, SignalAuthorizationDTO } from "./types.js";

export const DEFAULT_PRODUCT_REGISTRAR_ADDRESS = "0x000000000000000000000000000000000000bff1" as const;
const signalSubmittedTopic = keccak256(stringToBytes("SignalSubmitted(bytes32,bytes32,bytes32,bytes32,bytes32,address)"));

export function productSignalSourceId(source: string): Hex {
  return keccak256(stringToBytes(source)) as Hex;
}

export function productSignalId(signalName: string): Hex {
  return keccak256(stringToBytes(signalName)) as Hex;
}

export interface ProductBroadcastOutsideTriggerInput {
  readonly triggerId: string;
  readonly draftId: string;
  readonly orderId: Hex;
  readonly planId: Hex;
  readonly creator: Address;
  readonly triggerHookId: Hex;
  readonly triggerStageId: Hex;
  readonly sourceId: Hex;
  readonly signalId: Hex;
  readonly payloadHash: Hex;
  readonly idempotencyKey: Hex;
  readonly submitter: Address;
  readonly deadline: string;
  readonly signature: Hex;
  readonly stateMachineAddress?: Address;
  readonly deploymentId?: Hex;
  readonly authorizations: readonly SignalAuthorizationDTO[];
}

export interface ProductOrderTriggerBroadcastResult {
  readonly status: ProductOrderTriggerStatus;
  readonly txHash?: Hex;
  readonly blockNumber?: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly retryable: boolean;
}

export interface ProductOrderTriggerBroadcastAdapter {
  readonly registrarAddress?: Address;
  broadcastOutsideTrigger(input: ProductBroadcastOutsideTriggerInput): Promise<ProductOrderTriggerBroadcastResult>;
}

export interface MemoryProductTriggerBroadcastAdapterOptions {
  readonly registrarAddress?: Address;
}

/**
 * memory-trigger adapter: records the trigger attempt in process memory only.
 * It never broadcasts and never claims an on-chain outcome, so it always
 * reports status "pending" with no transaction hash. Drafts stay out of the
 * "triggered" state until a real chain adapter confirms the order.
 */
export class MemoryProductOrderTriggerBroadcastAdapter implements ProductOrderTriggerBroadcastAdapter {
  readonly registrarAddress: Address;
  readonly #attempts: ProductBroadcastOutsideTriggerInput[] = [];

  constructor(options: MemoryProductTriggerBroadcastAdapterOptions = {}) {
    this.registrarAddress = normalizeAddress(options.registrarAddress ?? DEFAULT_PRODUCT_REGISTRAR_ADDRESS, "registrarAddress");
  }

  listAttempts(): readonly ProductBroadcastOutsideTriggerInput[] {
    return this.#attempts.map((attempt) => ({
      ...attempt,
      authorizations: [...attempt.authorizations]
    }));
  }

  async broadcastOutsideTrigger(input: ProductBroadcastOutsideTriggerInput): Promise<ProductOrderTriggerBroadcastResult> {
    this.#attempts.push({
      ...input,
      authorizations: [...input.authorizations]
    });
    return {
      status: "pending",
      retryable: false
    };
  }
}

export interface AnvilProductTriggerBroadcastAdapterOptions {
  readonly rpcUrl: string;
  readonly chainId: number;
  readonly stateMachineAddress: Address;
  readonly privateKey?: Hex | string;
  readonly registrarAddress?: Address;
  readonly waitForReceipt?: boolean;
  readonly publicClient?: ProductTriggerBroadcastPublicClient;
  readonly walletClient?: ProductTriggerBroadcastWalletClient;
  readonly unknownOrderRetryDelayMs?: number;
  readonly unknownOrderMaxRetries?: number;
}

export interface ProductTriggerBroadcastReceiptLog {
  readonly address?: Address;
  readonly topics: readonly Hex[];
}

export interface ProductTriggerBroadcastReceipt {
  readonly status?: "success" | "reverted" | "failed" | string;
  readonly blockNumber: bigint;
  readonly logs: readonly ProductTriggerBroadcastReceiptLog[];
}

export interface ProductTriggerBroadcastPublicClient {
  waitForTransactionReceipt(parameters: { readonly hash: Hex; readonly timeout?: number }): Promise<ProductTriggerBroadcastReceipt>;
}

export interface ProductTriggerBroadcastWalletClient {
  readonly account?: { readonly address?: string };
  writeContract(parameters: {
    readonly address: Address;
    readonly abi: typeof STATE_MACHINE_ABI;
    readonly functionName: "triggerOrderFromOutsideFor";
    readonly args: readonly unknown[];
  }): Promise<Hex>;
}

export class AnvilProductOrderTriggerBroadcastAdapter implements ProductOrderTriggerBroadcastAdapter {
  readonly registrarAddress: Address;
  readonly #options: AnvilProductTriggerBroadcastAdapterOptions & { readonly privateKey?: Hex };

  constructor(options: AnvilProductTriggerBroadcastAdapterOptions) {
    const privateKey = options.privateKey ? normalizePrivateKey(options.privateKey, "privateKey") : undefined;
    if (!privateKey && !options.walletClient) {
      throw new ConfigError("privateKey is required when walletClient is not provided");
    }
    const registrarAddress = options.registrarAddress ?? options.walletClient?.account?.address ??
      (privateKey ? privateKeyToAccount(privateKey).address : undefined);
    if (!registrarAddress) {
      throw new ConfigError("registrarAddress is required when privateKey or walletClient account address is not provided");
    }
    this.registrarAddress = normalizeAddress(registrarAddress, "registrarAddress");
    const { privateKey: _privateKey, ...normalizedOptions } = options;
    this.#options = {
      ...normalizedOptions,
      stateMachineAddress: normalizeAddress(options.stateMachineAddress, "stateMachineAddress"),
      ...(privateKey ? { privateKey } : {})
    };
  }

  async broadcastOutsideTrigger(input: ProductBroadcastOutsideTriggerInput): Promise<ProductOrderTriggerBroadcastResult> {
    try {
      const { publicClient, wallet } = this.#clients();
      const stateMachineAddress = input.stateMachineAddress ?? this.#options.stateMachineAddress;
      const call = buildTriggerOrderFromOutsideForCall({
        stateMachineAddress,
        chainId: this.#options.chainId
      }, {
        orderId: input.orderId,
        planId: input.planId,
        creator: input.creator,
        triggerHookId: input.triggerHookId,
        triggerStageId: input.triggerStageId,
        sourceId: input.sourceId,
        signalId: input.signalId,
        payloadHash: input.payloadHash,
        idempotencyKey: input.idempotencyKey,
        submitter: input.submitter,
        deadline: input.deadline,
        authorizations: input.authorizations,
        signature: input.signature
      });
      const txHash = await wallet.writeContract({
        address: call.address,
        abi: call.abi,
        functionName: call.functionName,
        args: call.args
      });
      if (!this.#options.waitForReceipt) {
        return {
          status: "submitted",
          txHash,
          retryable: false
        };
      }
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status === "success" && hasSignalSubmittedEvent(receipt.logs, input.orderId, input.sourceId, input.signalId)) {
        return {
          status: "confirmed",
          txHash,
          blockNumber: receipt.blockNumber.toString(),
          retryable: false
        };
      }
      if (receipt.status === "success") {
        return {
          status: "indexing",
          txHash,
          blockNumber: receipt.blockNumber.toString(),
          retryable: false
        };
      }
      return {
        status: "failed",
        txHash,
        blockNumber: receipt.blockNumber.toString(),
        errorCode: "trigger_order_reverted",
        errorMessage: `triggerOrderFromOutsideFor transaction receipt status ${receipt.status}`,
        retryable: true
      };
    } catch (error) {
      return {
        status: "failed",
        errorCode: "trigger_order_broadcast_failed",
        errorMessage: error instanceof Error ? error.message : "triggerOrderFromOutsideFor broadcast failed",
        retryable: true
      };
    }
  }

  #clients(): { readonly publicClient: ProductTriggerBroadcastPublicClient; readonly wallet: ProductTriggerBroadcastWalletClient } {
    const chain = defineChain({
      id: this.#options.chainId,
      name: `uvp-${this.#options.chainId}`,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [this.#options.rpcUrl] } }
    });
    const publicClient = this.#options.publicClient ?? createPublicClient({
      chain,
      transport: http(this.#options.rpcUrl)
    }) as ProductTriggerBroadcastPublicClient;
    if (this.#options.walletClient) {
      return { publicClient, wallet: this.#options.walletClient };
    }
    if (!this.#options.privateKey) {
      throw new ConfigError("privateKey is required when walletClient is not provided");
    }
    const account = privateKeyToAccount(this.#options.privateKey);
    return {
      publicClient,
      wallet: createWalletClient({
        account,
        chain,
        transport: http(this.#options.rpcUrl)
      }) as ProductTriggerBroadcastWalletClient
    };
  }
}

function normalizePrivateKey(value: Hex | string, fieldName: string): Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new ConfigError(`${fieldName} must be a 32-byte private key hex string`);
  }
  return value.toLowerCase() as Hex;
}

function hasSignalSubmittedEvent(
  logs: readonly { readonly topics: readonly Hex[] }[],
  orderId: Hex,
  sourceId: Hex,
  signalId: Hex
): boolean {
  const normalizedOrderId = orderId.toLowerCase();
  return logs.some((log) =>
    log.topics[0]?.toLowerCase() === signalSubmittedTopic &&
    log.topics[1]?.toLowerCase() === normalizedOrderId &&
    log.topics[2]?.toLowerCase() === sourceId.toLowerCase() &&
    log.topics[3]?.toLowerCase() === signalId.toLowerCase()
  );
}

export type ProductOrderTriggerResult = ProductOrderTriggerBroadcastResult;
