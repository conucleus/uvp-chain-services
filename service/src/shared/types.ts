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

export function assertAddress(value: string, fieldName: string): asserts value is Address {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new ConfigError(`${fieldName} must be a 20-byte EVM address`);
  }
}

export function assertBytes32(value: string, fieldName: string): asserts value is Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new ConfigError(`${fieldName} must be a 32-byte hex string`);
  }
}

export function normalizeAddress(value: string, fieldName: string): Address {
  assertAddress(value, fieldName);
  return value.toLowerCase() as Address;
}

export function normalizeBytes32(value: string, fieldName: string): Hex {
  assertBytes32(value, fieldName);
  return value.toLowerCase() as Hex;
}
