import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  keccak256,
  stringToBytes,
  decodeAbiParameters
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  STATE_MACHINE_ABI,
  buildTriggerOrderFromOutsideForCall,
  deriveTriggerOrderId
} from "@uvp-eth/protocol-bindings";
import { ConfigError, normalizeAddress, type Address, type Hex } from "../../shared/types.js";
import type { ProductOrderTriggerStatus, SignalAuthorizationDTO } from "./types.js";

export const DEFAULT_PRODUCT_REGISTRAR_ADDRESS = "0x000000000000000000000000000000000000bff1" as const;
// UVPStateMachine v0.9: planId/orderId/sourceId are indexed; signalId is the
// first value in the data payload (not a fourth topic).
const signalSubmittedTopic = keccak256(stringToBytes("SignalSubmitted(bytes32,bytes32,bytes32,bytes32,bytes32,bytes32,address)"));

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
  readonly data?: Hex;
}

export interface ProductTriggerBroadcastReceipt {
  readonly status?: "success" | "reverted" | "failed" | string;
  readonly blockNumber?: bigint;
  readonly logs: readonly ProductTriggerBroadcastReceiptLog[];
}

export interface ProductTriggerBroadcastPublicClient {
  waitForTransactionReceipt(parameters: { readonly hash: Hex; readonly timeout?: number }): Promise<ProductTriggerBroadcastReceipt | undefined>;
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
    // 已广播的 txHash 必须穿越 catch：writeContract 成功后等待回执/解析回执
    // 抛错时，链上交易已经存在，failed 结果不得丢失 txHash（对齐
    // submissions/broadcast-adapter 的 failedResult 携带方式）。
    let txHash: Hex | undefined;
    try {
      const { publicClient, wallet } = this.#clients();
      const stateMachineAddress = input.stateMachineAddress ?? this.#options.stateMachineAddress;
      const call = buildTriggerOrderFromOutsideForCall({
        stateMachineAddress,
        chainId: this.#options.chainId
      }, {
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
      txHash = await wallet.writeContract({
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
      // 一事一单：链上订单 id 由合约从事实派生——本地镜像同一公式做回执
      // 事件匹配（input.orderId 是产品侧关联 id，不进链上请求）。
      const chainOrderId = deriveTriggerOrderId(input.planId, input.sourceId, input.signalId, input.payloadHash);
      if (receipt?.status === "success" && hasSignalSubmittedEvent(receipt.logs, input.planId, chainOrderId, input.sourceId, input.signalId)) {
        return {
          status: "confirmed",
          txHash,
          ...(receipt.blockNumber !== undefined ? { blockNumber: receipt.blockNumber.toString() } : {}),
          retryable: false
        };
      }
      if (receipt?.status === "success") {
        return {
          status: "indexing",
          txHash,
          ...(receipt.blockNumber !== undefined ? { blockNumber: receipt.blockNumber.toString() } : {}),
          retryable: false
        };
      }
      if (receipt?.status === "reverted" || receipt?.status === "failed") {
        return {
          status: "failed",
          txHash,
          ...(receipt.blockNumber !== undefined ? { blockNumber: receipt.blockNumber.toString() } : {}),
          errorCode: "trigger_order_reverted",
          errorMessage: `triggerOrderFromOutsideFor transaction receipt status ${receipt.status}`,
          retryable: false
        };
      }
      // A missing receipt or an RPC/client-specific status is neither a
      // success nor a deterministic revert. Keep the known tx in indexing so
      // reconcile can probe it later; callers must not rebroadcast it.
      return {
        status: "indexing",
        txHash,
        ...(receipt?.blockNumber !== undefined ? { blockNumber: receipt.blockNumber.toString() } : {}),
        errorCode: "transaction_receipt_unknown",
        errorMessage: "trigger transaction receipt is missing or has an unknown status",
        retryable: true
      };
    } catch (error) {
      const classified = classifyProductTriggerBroadcastError(error);
      return {
        status: txHash && classified.retryable ? "indexing" : "failed",
        ...(txHash ? { txHash } : {}),
        errorCode: txHash && classified.retryable ? "transaction_receipt_unknown" : classified.errorCode,
        errorMessage: txHash && classified.retryable
          ? "trigger transaction receipt could not be verified"
          : classified.message,
        retryable: classified.retryable
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
  logs: readonly ProductTriggerBroadcastReceiptLog[],
  planId: Hex,
  orderId: Hex,
  sourceId: Hex,
  signalId: Hex
): boolean {
  const normalizedPlanId = planId.toLowerCase();
  const normalizedOrderId = orderId.toLowerCase();
  return logs.some((log) =>
    log.topics[0]?.toLowerCase() === signalSubmittedTopic &&
    log.topics[1]?.toLowerCase() === normalizedPlanId &&
    log.topics[2]?.toLowerCase() === normalizedOrderId &&
    log.topics[3]?.toLowerCase() === sourceId.toLowerCase() &&
    signalIdFromEventData(log.data) === signalId.toLowerCase()
  );
}

function signalIdFromEventData(data: Hex | undefined): string | undefined {
  if (!data) {
    return undefined;
  }
  try {
    const [signalId] = decodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "address" }
      ],
      data
    );
    return typeof signalId === "string" ? signalId.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

interface ClassifiedProductTriggerBroadcastError {
  readonly errorCode: string;
  readonly message: string;
  readonly retryable: boolean;
}

function classifyProductTriggerBroadcastError(error: unknown): ClassifiedProductTriggerBroadcastError {
  const message = error instanceof Error ? error.message : "triggerOrderFromOutsideFor broadcast failed";
  const haystack = `${error instanceof Error ? error.name : ""} ${message}`;
  if (/revert|invalid|expired|deadline|unknown.?order|already.?exists|unauthori[sz]ed|signature/i.test(haystack)) {
    return {
      errorCode: "trigger_order_reverted",
      message: "triggerOrderFromOutsideFor transaction was rejected deterministically",
      retryable: false
    };
  }
  if (/timeout|timed out|ETIMEDOUT|AbortError|ECONNRESET|network|socket|transport/i.test(haystack)) {
    return {
      errorCode: "trigger_order_broadcast_failed",
      message,
      retryable: true
    };
  }
  return {
    errorCode: "trigger_order_broadcast_failed",
    message,
    retryable: true
  };
}

export type ProductOrderTriggerResult = ProductOrderTriggerBroadcastResult;
