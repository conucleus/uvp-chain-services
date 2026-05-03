import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  keccak256,
  parseAbi,
  stringToBytes
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ConfigError, normalizeAddress, type Address, type Hex } from "../../shared/types.js";
import type { ProductOrderRegistrationStatus, ProductOrderStartStatus, SignalAuthorizationDTO } from "./types.js";

export const DEFAULT_PRODUCT_REGISTRAR_ADDRESS = "0x000000000000000000000000000000000000bff1" as const;
export const PRODUCT_INITIAL_TRIGGER_SOURCE_ID = productSignalSourceId("");
export const PRODUCT_INITIAL_TRIGGER_SIGNAL_ID = productSignalId("OUTSIDE");
const signalSubmittedTopic = keccak256(stringToBytes("SignalSubmitted(bytes32,bytes32,bytes32,bytes32,bytes32,address)"));

export function productSignalSourceId(source: string): Hex {
  return keccak256(stringToBytes(source)) as Hex;
}

export function productSignalId(signalName: string): Hex {
  return keccak256(stringToBytes(signalName)) as Hex;
}

export interface ProductRegisterOrderInput {
  readonly registrationId: string;
  readonly draftId: string;
  readonly orderId: Hex;
  readonly stateMachineAddress?: Address;
  readonly deploymentId?: Hex;
  readonly planId: Hex;
  readonly creator: Address;
  readonly authorizations: readonly SignalAuthorizationDTO[];
}

export interface ProductRegistrationAdapterResult {
  readonly status: ProductOrderRegistrationStatus;
  readonly txHash?: Hex;
  readonly blockNumber?: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly retryable: boolean;
}

export interface ProductOrderRegistrationAdapter {
  readonly registrarAddress?: Address;
  registerOrder(input: ProductRegisterOrderInput): Promise<ProductRegistrationAdapterResult>;
}

export interface ProductSubmitInitialTriggerInput {
  readonly startId: string;
  readonly registrationId: string;
  readonly orderId: Hex;
  readonly sourceId: Hex;
  readonly signalId: Hex;
  readonly stateMachineAddress?: Address;
  readonly deploymentId?: Hex;
  readonly registrationTxHash?: Hex;
  readonly registrationBlockNumber?: string;
  readonly payloadHash: Hex;
  readonly idempotencyKey: Hex;
}

export interface ProductOrderTriggerResult {
  readonly status: ProductOrderStartStatus;
  readonly txHash?: Hex;
  readonly blockNumber?: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly retryable: boolean;
}

export interface ProductOrderTriggerAdapter {
  readonly registrarAddress?: Address;
  submitInitialTrigger(input: ProductSubmitInitialTriggerInput): Promise<ProductOrderTriggerResult>;
}

export interface MemoryProductRegistrationAdapterOptions {
  readonly registrarAddress?: Address;
  readonly status?: ProductOrderRegistrationStatus;
  readonly txHash?: Hex;
  readonly blockNumber?: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly retryable?: boolean;
}

export interface MemoryProductTriggerAdapterOptions {
  readonly registrarAddress?: Address;
  readonly status?: ProductOrderStartStatus;
  readonly txHash?: Hex;
  readonly blockNumber?: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly retryable?: boolean;
}

export class MemoryProductOrderTriggerAdapter implements ProductOrderTriggerAdapter {
  readonly registrarAddress: Address;
  readonly #attempts: ProductSubmitInitialTriggerInput[] = [];
  #result: ProductOrderTriggerResult;

  constructor(options: MemoryProductTriggerAdapterOptions = {}) {
    this.registrarAddress = normalizeAddress(options.registrarAddress ?? DEFAULT_PRODUCT_REGISTRAR_ADDRESS, "registrarAddress");
    this.#result = triggerResultFromOptions(options);
  }

  setResult(options: Omit<MemoryProductTriggerAdapterOptions, "registrarAddress">): void {
    this.#result = triggerResultFromOptions(options);
  }

  listAttempts(): readonly ProductSubmitInitialTriggerInput[] {
    return this.#attempts.map((attempt) => ({ ...attempt }));
  }

  async submitInitialTrigger(input: ProductSubmitInitialTriggerInput): Promise<ProductOrderTriggerResult> {
    this.#attempts.push({ ...input });
    if (shouldGenerateMemoryTriggerTxHash(this.#result)) {
      return {
        ...this.#result,
        txHash: keccak256(stringToBytes(`uvp:product-bff:memory-start:${input.startId}`))
      };
    }
    return this.#result;
  }
}

export class MemoryProductOrderRegistrationAdapter implements ProductOrderRegistrationAdapter, ProductOrderTriggerAdapter {
  readonly registrarAddress: Address;
  readonly #attempts: ProductRegisterOrderInput[] = [];
  readonly #triggerAdapter: MemoryProductOrderTriggerAdapter;
  #result: ProductRegistrationAdapterResult;

  constructor(options: MemoryProductRegistrationAdapterOptions = {}) {
    this.registrarAddress = normalizeAddress(options.registrarAddress ?? DEFAULT_PRODUCT_REGISTRAR_ADDRESS, "registrarAddress");
    this.#result = adapterResultFromOptions(options);
    this.#triggerAdapter = new MemoryProductOrderTriggerAdapter({ registrarAddress: this.registrarAddress });
  }

  setResult(options: Omit<MemoryProductRegistrationAdapterOptions, "registrarAddress">): void {
    this.#result = adapterResultFromOptions(options);
  }

  listAttempts(): readonly ProductRegisterOrderInput[] {
    return this.#attempts.map((attempt) => ({
      ...attempt,
      authorizations: [...attempt.authorizations]
    }));
  }

  setTriggerResult(options: Omit<MemoryProductTriggerAdapterOptions, "registrarAddress">): void {
    this.#triggerAdapter.setResult(options);
  }

  listInitialTriggerAttempts(): readonly ProductSubmitInitialTriggerInput[] {
    return this.#triggerAdapter.listAttempts();
  }

  async registerOrder(input: ProductRegisterOrderInput): Promise<ProductRegistrationAdapterResult> {
    this.#attempts.push({
      ...input,
      authorizations: [...input.authorizations]
    });
    if (this.#result.status === "confirmed" && !this.#result.txHash) {
      return {
        ...this.#result,
        txHash: keccak256(stringToBytes(`uvp:product-bff:memory-registration:${input.registrationId}`))
      };
    }
    return this.#result;
  }

  async submitInitialTrigger(input: ProductSubmitInitialTriggerInput): Promise<ProductOrderTriggerResult> {
    return this.#triggerAdapter.submitInitialTrigger(input);
  }
}

export interface AnvilProductRegistrationAdapterOptions {
  readonly rpcUrl: string;
  readonly chainId: number;
  readonly stateMachineAddress: Address;
  readonly privateKey?: Hex | string;
  readonly registrarAddress?: Address;
  readonly waitForReceipt?: boolean;
  readonly publicClient?: ProductRegistrationPublicClient;
  readonly walletClient?: ProductRegistrationWalletClient;
  readonly unknownOrderRetryDelayMs?: number;
  readonly unknownOrderMaxRetries?: number;
}

export interface ProductRegistrationReceiptLog {
  readonly address?: Address;
  readonly topics: readonly Hex[];
}

export interface ProductRegistrationReceipt {
  readonly status?: "success" | "reverted" | "failed" | string;
  readonly blockNumber: bigint;
  readonly logs: readonly ProductRegistrationReceiptLog[];
}

export interface ProductRegistrationPublicClient {
  waitForTransactionReceipt(parameters: { readonly hash: Hex; readonly timeout?: number }): Promise<ProductRegistrationReceipt>;
}

export interface ProductRegistrationWalletClient {
  readonly account?: { readonly address?: string };
  writeContract(parameters: {
    readonly address: Address;
    readonly abi: typeof stateMachineProductBffAbi;
    readonly functionName: "registerOrder" | "submitSignal";
    readonly args: readonly unknown[];
  }): Promise<Hex>;
}

export class AnvilProductOrderRegistrationAdapter implements ProductOrderRegistrationAdapter, ProductOrderTriggerAdapter {
  readonly registrarAddress: Address;
  readonly #options: AnvilProductRegistrationAdapterOptions & { readonly privateKey?: Hex };

  constructor(options: AnvilProductRegistrationAdapterOptions) {
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

  async registerOrder(input: ProductRegisterOrderInput): Promise<ProductRegistrationAdapterResult> {
    try {
      const { publicClient, wallet } = this.#clients();
      const txHash = await wallet.writeContract({
        address: input.stateMachineAddress ?? this.#options.stateMachineAddress,
        abi: stateMachineProductBffAbi,
        functionName: "registerOrder",
        args: [input.orderId, input.planId, input.creator, input.authorizations]
      });
      if (!this.#options.waitForReceipt) {
        return {
          status: "pending",
          txHash,
          retryable: false
        };
      }
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status === "success") {
        return {
          status: "confirmed",
          txHash,
          blockNumber: receipt.blockNumber.toString(),
          retryable: false
        };
      }
      return {
        status: "failed",
        txHash,
        blockNumber: receipt.blockNumber.toString(),
        errorCode: "register_order_reverted",
        errorMessage: `registerOrder transaction receipt status ${receipt.status}`,
        retryable: true
      };
    } catch (error) {
      return {
        status: "failed",
        errorCode: "register_order_broadcast_failed",
        errorMessage: error instanceof Error ? error.message : "registerOrder broadcast failed",
        retryable: true
      };
    }
  }

  async submitInitialTrigger(input: ProductSubmitInitialTriggerInput): Promise<ProductOrderTriggerResult> {
    try {
      const { publicClient, wallet } = this.#clients();
      const stateMachineAddress = input.stateMachineAddress ?? this.#options.stateMachineAddress;
      const txHash = await writeInitialTriggerWithUnknownOrderRetry({
        wallet,
        publicClient,
        stateMachineAddress,
        input,
        ...(this.#options.unknownOrderRetryDelayMs !== undefined
          ? { unknownOrderRetryDelayMs: this.#options.unknownOrderRetryDelayMs }
          : {}),
        ...(this.#options.unknownOrderMaxRetries !== undefined
          ? { unknownOrderMaxRetries: this.#options.unknownOrderMaxRetries }
          : {})
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
        errorCode: "submit_initial_trigger_reverted",
        errorMessage: `submitSignal transaction receipt status ${receipt.status}`,
        retryable: true
      };
    } catch (error) {
      return {
        status: "failed",
        errorCode: "submit_initial_trigger_broadcast_failed",
        errorMessage: error instanceof Error ? error.message : "submitSignal broadcast failed",
        retryable: true
      };
    }
  }

  #clients(): { readonly publicClient: ProductRegistrationPublicClient; readonly wallet: ProductRegistrationWalletClient } {
    const chain = defineChain({
      id: this.#options.chainId,
      name: `uvp-${this.#options.chainId}`,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [this.#options.rpcUrl] } }
    });
    const publicClient = this.#options.publicClient ?? createPublicClient({
      chain,
      transport: http(this.#options.rpcUrl)
    }) as ProductRegistrationPublicClient;
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
      }) as ProductRegistrationWalletClient
    };
  }
}

async function writeInitialTriggerWithUnknownOrderRetry(input: {
  readonly wallet: ProductRegistrationWalletClient;
  readonly publicClient: ProductRegistrationPublicClient;
  readonly stateMachineAddress: Address;
  readonly input: ProductSubmitInitialTriggerInput;
  readonly unknownOrderRetryDelayMs?: number;
  readonly unknownOrderMaxRetries?: number;
}): Promise<Hex> {
  const maxRetries = input.unknownOrderMaxRetries ?? 3;
  const retryDelayMs = input.unknownOrderRetryDelayMs ?? 1_000;
  let registrationProofChecked = false;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await input.wallet.writeContract({
        address: input.stateMachineAddress,
        abi: stateMachineProductBffAbi,
        functionName: "submitSignal",
        args: [
          input.input.orderId,
          input.input.sourceId,
          input.input.signalId,
          input.input.payloadHash,
          input.input.idempotencyKey
        ]
      });
    } catch (error) {
      if (!isUnknownOrderRevert(error) || attempt >= maxRetries || !input.input.registrationTxHash) {
        throw error;
      }
      if (!registrationProofChecked) {
        const registered = await waitForMatchingOrderRegistration(input.publicClient, {
          stateMachineAddress: input.stateMachineAddress,
          orderId: input.input.orderId,
          registrationTxHash: input.input.registrationTxHash
        });
        if (!registered) {
          throw error;
        }
        registrationProofChecked = true;
      }
      if (retryDelayMs > 0) {
        await delay(retryDelayMs);
      }
    }
  }
  throw new Error("submitSignal retry budget exhausted");
}

function adapterResultFromOptions(options: Omit<MemoryProductRegistrationAdapterOptions, "registrarAddress">): ProductRegistrationAdapterResult {
  const status = options.status ?? "pending";
  return {
    status,
    ...(options.txHash ? { txHash: options.txHash } : {}),
    ...(options.blockNumber ? { blockNumber: options.blockNumber } : {}),
    ...(options.errorCode ? { errorCode: options.errorCode } : {}),
    ...(options.errorMessage ? { errorMessage: options.errorMessage } : {}),
    retryable: options.retryable ?? status === "failed"
  };
}

function triggerResultFromOptions(options: Omit<MemoryProductTriggerAdapterOptions, "registrarAddress">): ProductOrderTriggerResult {
  const status = options.status ?? "confirmed";
  return {
    status,
    ...(options.txHash ? { txHash: options.txHash } : {}),
    ...(options.blockNumber ? { blockNumber: options.blockNumber } : {}),
    ...(options.errorCode ? { errorCode: options.errorCode } : {}),
    ...(options.errorMessage ? { errorMessage: options.errorMessage } : {}),
    retryable: options.retryable ?? status === "failed"
  };
}

function shouldGenerateMemoryTriggerTxHash(result: ProductOrderTriggerResult): boolean {
  return result.status !== "pending" && result.status !== "failed" && !result.txHash;
}

async function waitForMatchingOrderRegistration(
  publicClient: ProductRegistrationPublicClient,
  input: {
    readonly stateMachineAddress: Address;
    readonly orderId: Hex;
    readonly registrationTxHash: Hex;
  }
): Promise<boolean> {
  const receipt = await publicClient.waitForTransactionReceipt({ hash: input.registrationTxHash });
  return receipt.status === "success" && hasOrderRegisteredEvent(receipt.logs, input.stateMachineAddress, input.orderId);
}

function isUnknownOrderRevert(error: unknown): boolean {
  const text = errorText(error);
  return text.includes("UnknownOrder") || text.includes("0xb838de96");
}

function errorText(error: unknown, seen = new Set<unknown>()): string {
  if (!error || seen.has(error)) {
    return "";
  }
  seen.add(error);
  if (typeof error === "string") {
    return error;
  }
  if (!(error instanceof Error)) {
    return "";
  }
  const parts = [error.name, error.message];
  const record = error as Error & {
    readonly shortMessage?: unknown;
    readonly details?: unknown;
    readonly cause?: unknown;
  };
  if (typeof record.shortMessage === "string") {
    parts.push(record.shortMessage);
  }
  if (typeof record.details === "string") {
    parts.push(record.details);
  }
  parts.push(errorText(record.cause, seen));
  return parts.join(" ");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function hasOrderRegisteredEvent(
  logs: readonly ProductRegistrationReceiptLog[],
  stateMachineAddress: Address,
  orderId: Hex
): boolean {
  const normalizedOrderId = orderId.toLowerCase();
  const normalizedStateMachine = stateMachineAddress.toLowerCase();
  return logs.some((log) =>
    log.address?.toLowerCase() === normalizedStateMachine &&
    log.topics[0]?.toLowerCase() === orderRegisteredTopic &&
    log.topics[1]?.toLowerCase() === normalizedOrderId
  );
}

const stateMachineProductBffAbi = parseAbi([
  "error UnknownOrder()",
  "function registerOrder(bytes32 orderId,bytes32 planId,address creator,(bytes32 sourceId,bytes32 signalId,address submitter,bytes32 role,bytes32 metadataHash)[] authorizations)",
  "function submitSignal(bytes32 orderId,bytes32 sourceId,bytes32 signalId,bytes32 payloadHash,bytes32 idempotencyKey)"
]);

const orderRegisteredTopic = keccak256(stringToBytes("OrderRegistered(bytes32,bytes32)"));
