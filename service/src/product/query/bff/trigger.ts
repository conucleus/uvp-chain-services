import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  getEventSelector,
  decodeAbiParameters
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  STATE_MACHINE_ABI,
  buildTriggerOrderFromOutsideForCall,
  deriveTriggerOrderId,
  type SignalAttributionPayload
} from "@uvp-eth/protocol-bindings";
import { onchainSignalId, onchainSourceId } from "@uvp-eth/compiler";
import { zeroFactAttribution } from "../../../submissions/capability-proofs.js";
import { ConfigError, normalizeAddress, type Address, type Hex } from "../../../shared/types.js";
import { redactErrorMessage } from "../../../security/redaction.js";
import type { ProductOrderTriggerStatus, SignalAuthorizationDTO } from "./types.js";

export const DEFAULT_PRODUCT_REGISTRAR_ADDRESS = "0x000000000000000000000000000000000000bff1" as const;

const signalSubmittedTopic = eventTopicFromAbi("SignalSubmitted");

function eventTopicFromAbi(eventName: string): Hex {
  type StateMachineAbiEvent = Extract<
    (typeof STATE_MACHINE_ABI)[number],
    { readonly type: "event" }
  >;
  const event = STATE_MACHINE_ABI.find(
    (entry): entry is StateMachineAbiEvent =>
      entry.type === "event" && entry.name === eventName
  );
  if (!event) {
    throw new ConfigError(`STATE_MACHINE_ABI is missing the ${eventName} event`);
  }
  return getEventSelector(event);
}

export function productSignalSourceId(source: string): Hex {
  return onchainSourceId(source);
}

export function productSignalId(signalName: string): Hex {
  return onchainSignalId(signalName);
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
  readonly birthFactAttribution?: SignalAttributionPayload;
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
  readonly rejectGasPayerAsSubmitter?: boolean;
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
    if (this.#options.rejectGasPayerAsSubmitter &&
        this.registrarAddress.toLowerCase() === input.submitter.toLowerCase()) {
      return {
        status: "failed",
        errorCode: "relayer_business_signer_reuse",
        errorMessage: "relayer gas payer must not be the participant business signer",
        retryable: false
      };
    }
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
        signature: input.signature,
        birthFactAttribution: input.birthFactAttribution ??
          zeroFactAttribution(input.sourceId, input.signalId)
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

function isTransportEnvelopeError(haystack: string): boolean {
  return /json.?rpc|http request|fetch failed|network|socket|connection|ECONN|ETIMEDOUT|timeout|timed out|deadline exceeded|AbortError|transport|too many|rate.?limit/i.test(haystack);
}

function classifyProductTriggerBroadcastError(error: unknown): ClassifiedProductTriggerBroadcastError {
  const message = error instanceof Error ? error.message : "triggerOrderFromOutsideFor broadcast failed";
  const haystack = `${error instanceof Error ? error.name : ""} ${message}`;
  if (!isTransportEnvelopeError(haystack) &&
      /\brevert|unauthori[sz]ed|expired|deadline|unknown.?order|already.?(?:registered|exists|triggered)|signature/i.test(haystack)) {
    return {
      errorCode: "trigger_order_reverted",
      message: "triggerOrderFromOutsideFor transaction was rejected deterministically",
      retryable: false
    };
  }
  return {
    errorCode: "trigger_order_broadcast_failed",
    message: redactErrorMessage(message),
    retryable: true
  };
}

export type ProductOrderTriggerResult = ProductOrderTriggerBroadcastResult;
