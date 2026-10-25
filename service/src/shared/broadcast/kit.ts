import type { Chain } from "viem";
import { ConfigError, assertHex, normalizeAddress, type Address, type Hex } from "../types.js";
import { redactErrorMessage } from "../../security/redaction.js";

// 状态机广播装配套件（单源）：submissions 与 stage-patches 共用的装配
// 骨架（chainFor/findErrorName/errorText/normalizeGasPayer 等）。

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
export const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";
export const DEFAULT_RELAYER_PRIVATE_KEY_ENV = "UVP_STATE_MACHINE_RELAYER_PRIVATE_KEY";

export function chainFor(chainId: number, rpcUrl: string): Chain {
  return {
    id: chainId,
    name: `uvp-${chainId}`,
    nativeCurrency: {
      name: "Ether",
      symbol: "ETH",
      decimals: 18
    },
    rpcUrls: {
      default: {
        http: [rpcUrl]
      }
    }
  };
}

export function findErrorName(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const record = error as Record<string, unknown>;
  if (typeof record.errorName === "string" && record.errorName) {
    return record.errorName;
  }
  if (
    Object.prototype.hasOwnProperty.call(record, "name") &&
    typeof record.name === "string" &&
    record.name &&
    record.name !== "Error"
  ) {
    return record.name;
  }
  if (record.cause) {
    return findErrorName(record.cause);
  }
  return undefined;
}

export function errorText(error: unknown): string {
  if (error instanceof Error) {
    const causeText = "cause" in error ? errorText((error as { readonly cause?: unknown }).cause) : "";
    return redactErrorMessage([error.message, causeText].filter(Boolean).join(" "));
  }
  if (typeof error === "string") {
    return redactErrorMessage(error);
  }
  if (error && typeof error === "object") {
    const text = Object.entries(error as Record<string, unknown>)
      .filter(([key]) => key !== "stack")
      .map(([_key, value]) => typeof value === "string" ? value : "")
      .filter(Boolean)
      .join(" ");
    return redactErrorMessage(text);
  }
  return "";
}

export function normalizeGasPayer(value: string | undefined): Address {
  if (!value) {
    throw new ConfigError("relayer gas payer address is required");
  }
  const address = normalizeAddress(value, "relayer gas payer");
  if (address === ZERO_ADDRESS) {
    throw new ConfigError("relayer gas payer address must not be zero");
  }
  return address;
}

export function requiredRpcUrl(rpcUrl: string | undefined, label: string): string {
  if (!rpcUrl) {
    throw new ConfigError(`UVP_RPC_URL is required for ${label}; refusing to fall back to a default RPC endpoint`);
  }
  return rpcUrl;
}

export interface RelayerPrivateKeyOptions {
  readonly relayerPrivateKey?: Hex;
  readonly relayerPrivateKeyEnv?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export function loadRelayerPrivateKey(options: RelayerPrivateKeyOptions, label: string): Hex {
  const privateKey = options.relayerPrivateKey ?? (options.env ?? process.env)[
    options.relayerPrivateKeyEnv ?? DEFAULT_RELAYER_PRIVATE_KEY_ENV
  ];
  if (!privateKey) {
    throw new ConfigError(`${options.relayerPrivateKeyEnv ?? DEFAULT_RELAYER_PRIVATE_KEY_ENV} is required for ${label}`);
  }
  assertHex(privateKey, options.relayerPrivateKeyEnv ?? DEFAULT_RELAYER_PRIVATE_KEY_ENV);
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new ConfigError(`${options.relayerPrivateKeyEnv ?? DEFAULT_RELAYER_PRIVATE_KEY_ENV} must be a 32-byte private key`);
  }
  return privateKey.toLowerCase() as Hex;
}

export interface BroadcastFailureCoreInput {
  readonly errorCode: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly gasPayer: Address;
  readonly txHash?: Hex;
  readonly blockNumber?: string;
}

export interface BroadcastFailureCore {
  readonly status: "failed";
  readonly txHash?: Hex;
  readonly blockNumber?: string;
  readonly errorCode: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly attempt: {
    readonly status: "failed";
    readonly txHash?: Hex;
    readonly blockNumber?: string;
    readonly gasPayer: Address;
    readonly errorCode: string;
    readonly errorMessage: string;
    readonly retryable: boolean;
  };
}

export function broadcastFailureCore(input: BroadcastFailureCoreInput): BroadcastFailureCore {
  return {
    status: "failed",
    ...(input.txHash ? { txHash: input.txHash } : {}),
    ...(input.blockNumber ? { blockNumber: input.blockNumber } : {}),
    errorCode: input.errorCode,
    message: input.message,
    retryable: input.retryable,
    attempt: {
      status: "failed",
      ...(input.txHash ? { txHash: input.txHash } : {}),
      ...(input.blockNumber ? { blockNumber: input.blockNumber } : {}),
      gasPayer: input.gasPayer,
      errorCode: input.errorCode,
      errorMessage: input.message,
      retryable: input.retryable
    }
  };
}
