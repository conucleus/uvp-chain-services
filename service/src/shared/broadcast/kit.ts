import type { Chain } from "viem";
import { ConfigError, assertHex, normalizeAddress, type Address, type Hex } from "../types.js";
import { redactErrorMessage } from "../../security/redaction.js";

/**
 * 状态机广播装配套件（单源）：submissions 与 stage-patches 两份
 * broadcast-adapter 此前各自复制的骨架（chainFor / findErrorName /
 * errorText / normalizeGasPayer / requiredRpcUrl / loadRelayerPrivateKey /
 * failedResult 核心字段拼装）收敛于此。两处分叉行为已按更正确一侧统一：
 * - findErrorName：errorName 优先，其次自有（own）且非默认的 name——
 *   不再被 Error 原型链上的 "Error" 短路（旧 relayer 形态），也不忽略
 *   显式赋名的自定义错误；
 * - errorText：保留普通对象分支（拼接字符串字段值），非 Error 对象的
 *   错误面不再被静默丢弃（旧 stage-patches 形态）。
 * 结果 DTO 面（errorLabel/retryState/deadLetter/revertReason）为
 * submissions 面专属字段，由各 adapter 自行附加，不在本套件硬统一。
 */

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
  // 只认自有且非默认的 name：Error 原型链上的 "Error" 对任何错误恒真，
  // 会短路 cause 递归（viem 的 errorName 与自定义错误类名才是有效信号）。
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
  // fail-closed：无显式 RPC 配置即抛错，不回落 127.0.0.1:8545（本地环境
  // 也必须显式传 UVP_RPC_URL）。
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

/** failedResult 的公共骨架：顶层与 attempt 的同名字段同值拼装。 */
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
