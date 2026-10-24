// StageEscrow log indexer: scans only the configured escrow address, decodes
// the V2 event surface, and replays it into the tranche projection. A rebuild
// clears the projection and re-reads the same block range; a cursor-hash
// mismatch (reorg) triggers the same rebuild instead of guessing a rollback.

import { createPublicClient, http } from "viem";
import type { ChainServicesConfig, EscrowIndexerConfig } from "../config/index.js";
import type { Address, Hex, Logger } from "../shared/types.js";
import { noopLogger } from "../shared/types.js";
import { decodeEscrowLogs, type RawEscrowLog } from "./events.js";
import { replayEscrowEvents } from "./projection.js";
import type {
  EscrowEvent,
  EscrowProjectionStore,
  EscrowReplaySummary
} from "./types.js";

const LOG_PAGE_SIZE = 9_999n;

export interface EscrowLogSource {
  getBlockNumber(): Promise<bigint>;
  getLogs(input: {
    readonly address: Address;
    readonly fromBlock: bigint;
    readonly toBlock: bigint;
  }): Promise<readonly RawEscrowLog[]>;
  getBlock(input: { readonly blockNumber: bigint }): Promise<{
    readonly hash: Hex | null;
    readonly timestamp: bigint;
  }>;
}

export function createViemEscrowLogSource(
  config: Pick<ChainServicesConfig, "network">
): EscrowLogSource {
  const client = createPublicClient({
    transport: http(config.network.rpcUrl)
  });
  return {
    getBlockNumber: () => client.getBlockNumber(),
    getLogs: (input) =>
      client.getLogs({
        address: input.address,
        fromBlock: input.fromBlock,
        toBlock: input.toBlock
      }),
    async getBlock(input) {
      const block = await client.getBlock({ blockNumber: input.blockNumber });
      return { hash: block.hash, timestamp: block.timestamp };
    }
  };
}

export interface EscrowIndexerOptions {
  readonly chainId: number;
  readonly address: Address;
  readonly startBlock: bigint;
  readonly store: EscrowProjectionStore;
  readonly source: EscrowLogSource;
  readonly logger?: Logger;
}

export class EscrowIndexerService {
  readonly #chainId: number;
  readonly #address: Address;
  readonly #startBlock: bigint;
  readonly #store: EscrowProjectionStore;
  readonly #source: EscrowLogSource;
  readonly #logger: Logger;

  #nextBlock: bigint | undefined;
  #lastBlock: bigint | undefined;
  #lastBlockHash: Hex | undefined;
  #refreshing: Promise<EscrowReplaySummary> | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: EscrowIndexerOptions) {
    this.#chainId = options.chainId;
    this.#address = options.address;
    this.#startBlock = options.startBlock;
    this.#store = options.store;
    this.#source = options.source;
    this.#logger = options.logger ?? noopLogger;
  }

  static fromConfig(options: {
    readonly config: EscrowIndexerConfig;
    readonly store: EscrowProjectionStore;
    readonly source: EscrowLogSource;
    readonly logger?: Logger;
  }): EscrowIndexerService {
    return new EscrowIndexerService({
      chainId: options.config.chainId,
      address: options.config.address,
      startBlock: options.config.startBlock,
      store: options.store,
      source: options.source,
      ...(options.logger ? { logger: options.logger } : {})
    });
  }

  get indexedThrough(): bigint | undefined {
    return this.#lastBlock;
  }

  start(intervalMs: number): void {
    if (this.#timer) {
      return;
    }
    if (intervalMs <= 0) {
      this.#logger.warn(
        "ESCROW INDEXER POLLING IS DISABLED (UVP_INDEXER_POLL_INTERVAL_MS=0): the escrow projection is rebuilt once and will not follow new tranche events"
      );
      void this.refreshIfIdle().catch((error: unknown) => {
        this.#logger.error("escrow projection rebuild failed", {
          message: error instanceof Error ? error.message : "unknown escrow indexer error"
        });
      });
      return;
    }
    this.#timer = setInterval(() => {
      void this.refreshIfIdle().catch((error: unknown) => {
        this.#logger.error("escrow projection refresh failed", {
          message: error instanceof Error ? error.message : "unknown escrow indexer error"
        });
      });
    }, intervalMs);
    void this.refreshIfIdle().catch((error: unknown) => {
      this.#logger.error("escrow projection rebuild failed", {
        message: error instanceof Error ? error.message : "unknown escrow indexer error"
      });
    });
  }

  stop(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  refreshIfIdle(): Promise<EscrowReplaySummary> {
    if (this.#refreshing) {
      return this.#refreshing;
    }
    this.#refreshing = this.refresh().finally(() => {
      this.#refreshing = undefined;
    });
    return this.#refreshing;
  }

  async refresh(): Promise<EscrowReplaySummary> {
    if (this.#nextBlock === undefined) {
      return this.rebuild();
    }
    if (this.#lastBlock !== undefined && this.#lastBlockHash !== undefined) {
      const cursorBlock = await this.#source.getBlock({
        blockNumber: this.#lastBlock
      });
      if (cursorBlock.hash === null || cursorBlock.hash !== this.#lastBlockHash) {
        this.#logger.warn("escrow projection reorg detected; rebuilding from the configured start block", {
          cursorBlock: this.#lastBlock.toString()
        });
        return this.rebuild();
      }
    }

    const latest = await this.#source.getBlockNumber();
    if (latest < this.#nextBlock) {
      return emptySummary();
    }
    const summary = await this.#scan(this.#nextBlock, latest);
    await this.#advanceCursor(latest);
    return summary;
  }

  async rebuild(): Promise<EscrowReplaySummary> {
    const latest = await this.#source.getBlockNumber();
    await this.#store.clear(this.#address);
    this.#nextBlock = this.#startBlock;
    this.#lastBlock = undefined;
    this.#lastBlockHash = undefined;

    const summary = latest >= this.#startBlock
      ? await this.#scan(this.#startBlock, latest)
      : emptySummary();
    if (latest >= this.#startBlock) {
      await this.#advanceCursor(latest);
    }
    this.#logger.info("escrow projection rebuilt", {
      chainId: this.#chainId,
      escrowAddress: this.#address,
      startBlock: this.#startBlock.toString(),
      latestBlock: latest.toString(),
      eventCount: summary.eventCount,
      appliedCount: summary.appliedCount,
      unknownTrancheEventCount: summary.unknownTrancheEventCount
    });
    return summary;
  }

  async #scan(fromBlock: bigint, toBlock: bigint): Promise<EscrowReplaySummary> {
    let summary = emptySummary();
    let cursor = fromBlock;
    while (cursor <= toBlock) {
      const chunkEnd = minBigInt(cursor + LOG_PAGE_SIZE - 1n, toBlock);
      const logs = await this.#source.getLogs({
        address: this.#address,
        fromBlock: cursor,
        toBlock: chunkEnd
      });
      const timestamps = await this.#blockTimestamps(logs);
      const decoded = decodeEscrowLogs({
        chainId: this.#chainId,
        escrowAddress: this.#address,
        logs,
        blockTimestampOf: (blockNumber) => {
          const timestamp = timestamps.get(blockNumber);
          if (timestamp === undefined) {
            throw new Error(
              `escrow indexer did not fetch block ${blockNumber.toString()} for a decoded log`
            );
          }
          return timestamp;
        }
      });
      const chunkSummary = await replayEscrowEvents(this.#store, decoded.events);
      summary = addSummaries(summary, chunkSummary);
      if (chunkSummary.unknownTrancheEventCount > 0) {
        this.#logger.warn("escrow events for unknown tranches were skipped", {
          count: chunkSummary.unknownTrancheEventCount,
          fromBlock: cursor.toString(),
          toBlock: chunkEnd.toString()
        });
      }
      if (decoded.unknownLogCount > 0) {
        this.#logger.warn("escrow logs with unknown signatures were skipped", {
          count: decoded.unknownLogCount,
          fromBlock: cursor.toString(),
          toBlock: chunkEnd.toString()
        });
      }
      cursor = chunkEnd + 1n;
    }
    return summary;
  }

  async #blockTimestamps(
    logs: readonly RawEscrowLog[]
  ): Promise<ReadonlyMap<bigint, bigint>> {
    const blockNumbers = [
      ...new Set(
        logs.flatMap((log) =>
          log.blockNumber === null ? [] : [log.blockNumber]
        )
      )
    ].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    const timestamps = new Map<bigint, bigint>();
    for (const blockNumber of blockNumbers) {
      const block = await this.#source.getBlock({ blockNumber });
      timestamps.set(blockNumber, block.timestamp);
    }
    return timestamps;
  }

  async #advanceCursor(blockNumber: bigint): Promise<void> {
    const block = await this.#source.getBlock({ blockNumber });
    if (block.hash === null) {
      throw new Error(
        `escrow indexer cannot advance past block ${blockNumber.toString()}: block hash is null`
      );
    }
    this.#nextBlock = blockNumber + 1n;
    this.#lastBlock = blockNumber;
    this.#lastBlockHash = block.hash;
  }
}

function emptySummary(): EscrowReplaySummary {
  return {
    eventCount: 0,
    appliedCount: 0,
    duplicateEventCount: 0,
    staleEventCount: 0,
    unknownTrancheEventCount: 0,
    conflictingDepositCount: 0,
    terminalEventCount: 0
  };
}

function addSummaries(
  left: EscrowReplaySummary,
  right: EscrowReplaySummary
): EscrowReplaySummary {
  return {
    eventCount: left.eventCount + right.eventCount,
    appliedCount: left.appliedCount + right.appliedCount,
    duplicateEventCount: left.duplicateEventCount + right.duplicateEventCount,
    staleEventCount: left.staleEventCount + right.staleEventCount,
    unknownTrancheEventCount:
      left.unknownTrancheEventCount + right.unknownTrancheEventCount,
    conflictingDepositCount:
      left.conflictingDepositCount + right.conflictingDepositCount,
    terminalEventCount: left.terminalEventCount + right.terminalEventCount
  };
}

function minBigInt(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}
