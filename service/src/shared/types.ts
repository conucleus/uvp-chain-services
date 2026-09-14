import {
  normalizeAddress as normalizeAddressCanonical,
  normalizeBytes32 as normalizeBytes32Canonical
} from "@uvp-eth/protocol-bindings";

export type Hex = `0x${string}`;
export type Address = Hex;
export type ChainId = number;
export type ChainTarget = "evm" | "solana";

export interface ChainPointer {
  readonly chainId: ChainId;
  readonly contractAddress: Address;
  readonly blockNumber: bigint;
  /**
   * Canonical EVM transaction position within the block.  Optional because
   * some event sources and hand-built fixtures omit it; the comparison and
   * persistence layers never depend on its presence.
   */
  readonly transactionIndex?: number;
  readonly transactionHash: Hex;
  readonly logIndex: number;
  readonly blockHash?: Hex;
}

/**
 * Compare chain facts in the order in which an EVM execution produced them.
 * The transaction index is the decisive tie-breaker for separate
 * transactions in the same block; events without it retain the
 * deterministic log-index fallback.
 */
export function compareChainPointers(
  left: Pick<ChainPointer, "chainId" | "blockNumber" | "transactionIndex" | "transactionHash" | "logIndex">,
  right: Pick<ChainPointer, "chainId" | "blockNumber" | "transactionIndex" | "transactionHash" | "logIndex">
): number {
  if (left.chainId !== right.chainId) {
    return left.chainId - right.chainId;
  }
  if (left.blockNumber !== right.blockNumber) {
    return left.blockNumber < right.blockNumber ? -1 : 1;
  }
  if (left.transactionIndex !== undefined && right.transactionIndex !== undefined &&
      left.transactionIndex !== right.transactionIndex) {
    return left.transactionIndex - right.transactionIndex;
  }
  if (left.logIndex !== right.logIndex) {
    return left.logIndex - right.logIndex;
  }
  return left.transactionHash.localeCompare(right.transactionHash);
}

export interface LifecycleService {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export const consoleLogger: Logger = {
  debug: (message, context) => console.debug(message, context ?? {}),
  info: (message, context) => console.info(message, context ?? {}),
  warn: (message, context) => console.warn(message, context ?? {}),
  error: (message, context) => console.error(message, context ?? {})
};

export const noopLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

export class ProjectionError extends Error {
  override readonly name = "ProjectionError";
}

export class UnsupportedChainTargetError extends Error {
  override readonly name = "UnsupportedChainTargetError";
  readonly target: string;

  constructor(target: string, message = `${target} target is reserved but not implemented`) {
    super(message);
    this.target = target;
  }
}

export function assertHex(value: string, fieldName: string): asserts value is Hex {
  if (!/^0x[0-9a-fA-F]*$/.test(value)) {
    throw new ConfigError(`${fieldName} must be a 0x-prefixed hex string`);
  }
}

// 规范化单源在 @uvp-eth/protocol-bindings（宽松 40/64-hex 校验 + 统一小写
// 输出＝比较键/存储键的权威形态；接受集与输出和原正则实现逐字段等价，
// 已核 viem isAddress strict:false 与 BYTES32_RE 同正则）。本层仅保留
// 错误面适配：路由与 config 按 ConfigError 分流 400/预检失败，bindings
// 抛泛 Error——不适配会把无效输入校验失败升格成 500。展示/签名等拼写
// 敏感场景用 bindings 的 normalizeAddressChecksummed，本仓比较/存储键
// 场景一律走小写形态。
export function normalizeAddress(value: string, fieldName: string): Address {
  try {
    return normalizeAddressCanonical(value, fieldName);
  } catch (error) {
    throw new ConfigError(error instanceof Error ? error.message : `${fieldName} must be a valid EVM address`);
  }
}

export function normalizeBytes32(value: string, fieldName: string): Hex {
  try {
    return normalizeBytes32Canonical(value, fieldName);
  } catch (error) {
    throw new ConfigError(error instanceof Error ? error.message : `${fieldName} must be a 32-byte hex value`);
  }
}
