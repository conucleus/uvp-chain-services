// StageEscrowV3 binding indexer: scans exactly one (chainId, escrowAddress)
// pair, replays Deposited/Settled into tranche bindings, and persists its cursor
// so restarts resume instead of silently rescanning/forgetting. A cursor-block
// hash mismatch triggers a full rebuild from startBlock (the contract gives us
// no rollback journal). Unknown logs and events before startBlock are recorded
// as anomalies, never dropped silently.

import { createPublicClient, http } from "viem";
import type { ChainServicesConfig } from "../config/index.js";
import { noopLogger, type Address, type Hex, type Logger } from "../shared/types.js";
import { decodeBindingLogs, type BindingEvent, type RawBindingLog } from "./events.js";
import { applyBindingEvent } from "./projection.js";
import type { BindingStore } from "./store.js";
import type { BindingEventAnomaly } from "./types.js";

const DEFAULT_PAGE_SIZE = 9_999n;
const ZERO_HASH = `0x${"00".repeat(32)}` as Hex;

export interface BindingLogSource {
  getBlockNumber(): Promise<bigint>;
  getLogs(input: {
    readonly address: Address;
    readonly fromBlock: bigint;
    readonly toBlock: bigint;
  }): Promise<readonly RawBindingLog[]>;
  getBlock(input: { readonly blockNumber: bigint }): Promise<{
    readonly hash: Hex | null;
    readonly timestamp: bigint;
  }>;
}

export function createViemBindingLogSource(
  config: Pick<ChainServicesConfig, "network">
): BindingLogSource {
  const client = createPublicClient({ transport: http(config.network.rpcUrl) });
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

export interface BindingIndexSummary {
  readonly chainId: number;
  readonly escrowAddress: Address;
  readonly fromBlock: string;
  readonly toBlock: string;
  readonly eventCount: number;
  readonly appliedCount: number;
  readonly duplicateCount: number;
  readonly anomalyCount: number;
  readonly unknownLogCount: number;
  readonly rebuilt: boolean;
}

export interface BindingIndexerOptions {
  readonly chainId: number;
  readonly escrowAddress: Address;
  readonly startBlock: bigint;
  readonly deploymentBlock?: bigint;
  readonly store: BindingStore;
  readonly source: BindingLogSource;
  readonly logger?: Logger;
  readonly pageSize?: bigint;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
}

export class BindingIndexerService {
  readonly #chainId: number;
  readonly #escrowAddress: Address;
  readonly #startBlock: bigint;
  readonly #deploymentBlock: bigint | undefined;
  readonly #store: BindingStore;
  readonly #source: BindingLogSource;
  readonly #logger: Logger;
  readonly #pageSize: bigint;
  readonly #now: () => Date;
  readonly #idFactory: (() => string) | undefined;

  #refreshing: Promise<BindingIndexSummary> | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: BindingIndexerOptions) {
    this.#chainId = options.chainId;
    this.#escrowAddress = options.escrowAddress.toLowerCase() as Address;
    this.#startBlock = options.startBlock;
    this.#deploymentBlock = options.deploymentBlock;
    this.#store = options.store;
    this.#source = options.source;
    this.#logger = options.logger ?? noopLogger;
    this.#pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    this.#now = options.now ?? (() => new Date());
    this.#idFactory = options.idFactory;
    if (this.#pageSize <= 0n) {
      throw new Error("pageSize must be greater than zero");
    }
  }

  start(intervalMs: number): void {
    if (this.#timer) {
      return;
    }
    if (intervalMs <= 0) {
      this.#logger.warn("binding indexer polling is disabled (interval <= 0)");
      return;
    }
    this.#timer = setInterval(() => {
      void this.refreshIfIdle().catch((error: unknown) => {
        this.#logger.error("binding indexer refresh failed", {
          message: error instanceof Error ? error.message : "unknown binding indexer error"
        });
      });
    }, intervalMs);
    void this.refreshIfIdle().catch((error: unknown) => {
      this.#logger.error("binding indexer rebuild failed", {
        message: error instanceof Error ? error.message : "unknown binding indexer error"
      });
    });
  }

  async stop(): Promise<void> {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    if (this.#refreshing) {
      await this.#refreshing.catch(() => undefined);
    }
  }

  refreshIfIdle(): Promise<BindingIndexSummary> {
    if (this.#refreshing) {
      return this.#refreshing;
    }
    this.#refreshing = this.refresh().finally(() => {
      this.#refreshing = undefined;
    });
    return this.#refreshing;
  }

  async refresh(): Promise<BindingIndexSummary> {
    const cursor = await this.#store.getCursor(this.#chainId, this.#escrowAddress);
    if (!cursor) {
      return this.rebuild();
    }
    if (cursor.lastBlock !== undefined && cursor.lastBlockHash !== undefined) {
      const block = await this.#source.getBlock({ blockNumber: BigInt(cursor.lastBlock) });
      if (block.hash === null || block.hash.toLowerCase() !== cursor.lastBlockHash.toLowerCase()) {
        this.#logger.warn("binding indexer reorg detected; rebuilding from startBlock", {
          cursorBlock: cursor.lastBlock,
          escrowAddress: this.#escrowAddress
        });
        return this.rebuild();
      }
    }
    const latest = await this.#source.getBlockNumber();
    if (latest < BigInt(cursor.nextBlock)) {
      return emptySummary(this.#chainId, this.#escrowAddress, cursor.nextBlock, cursor.nextBlock, false);
    }
    const summary = await this.#scan(BigInt(cursor.nextBlock), latest);
    await this.#advanceCursor(latest);
    return { ...summary, toBlock: latest.toString(), rebuilt: false };
  }

  async rebuild(): Promise<BindingIndexSummary> {
    await this.#store.resetProjection(this.#chainId, this.#escrowAddress);
    if (this.#deploymentBlock !== undefined && this.#startBlock > this.#deploymentBlock) {
      await this.#recordAnomaly({
        blockNumber: this.#startBlock.toString(),
        logIndex: -1,
        txHash: ZERO_HASH,
        reason: "start_block_after_deployment",
        details: {
          startBlock: this.#startBlock.toString(),
          deploymentBlock: this.#deploymentBlock.toString(),
          note: "events before startBlock are not scanned; they are not silently treated as absent"
        }
      });
    }
    const latest = await this.#source.getBlockNumber();
    if (latest < this.#startBlock) {
      await this.#store.saveCursor({
        chainId: this.#chainId,
        escrowAddress: this.#escrowAddress,
        startBlock: this.#startBlock.toString(),
        nextBlock: this.#startBlock.toString(),
        updatedAt: this.#now().toISOString()
      });
      this.#logger.info("binding projection rebuilt with no scan range", {
        chainId: this.#chainId,
        escrowAddress: this.#escrowAddress,
        startBlock: this.#startBlock.toString(),
        latestBlock: latest.toString()
      });
      return emptySummary(this.#chainId, this.#escrowAddress, this.#startBlock.toString(), latest.toString(), true);
    }
    const summary = await this.#scan(this.#startBlock, latest);
    await this.#advanceCursor(latest);
    this.#logger.info("binding projection rebuilt", {
      chainId: this.#chainId,
      escrowAddress: this.#escrowAddress,
      startBlock: this.#startBlock.toString(),
      latestBlock: latest.toString(),
      eventCount: summary.eventCount,
      anomalyCount: summary.anomalyCount
    });
    return { ...summary, rebuilt: true };
  }

  async #scan(fromBlock: bigint, toBlock: bigint): Promise<BindingIndexSummary> {
    let eventCount = 0;
    let appliedCount = 0;
    let duplicateCount = 0;
    let anomalyCount = 0;
    let unknownLogCount = 0;
    let cursor = fromBlock;
    while (cursor <= toBlock) {
      const chunkEnd = minBigInt(cursor + this.#pageSize - 1n, toBlock);
      const logs = await this.#source.getLogs({
        address: this.#escrowAddress,
        fromBlock: cursor,
        toBlock: chunkEnd
      });
      const timestamps = await this.#blockTimestamps(logs);
      const decoded = decodeBindingLogs({
        chainId: this.#chainId,
        escrowAddress: this.#escrowAddress,
        logs,
        blockTimestampOf: (blockNumber) => {
          const timestamp = timestamps.get(blockNumber);
          if (timestamp === undefined) {
            throw new Error(`binding indexer did not fetch block ${blockNumber.toString()}`);
          }
          return timestamp;
        }
      });
      unknownLogCount += decoded.unknownLogCount;
      if (decoded.unknownLogCount > 0) {
        await this.#recordAnomaly({
          blockNumber: cursor.toString(),
          logIndex: -1,
          txHash: ZERO_HASH,
          reason: "unknown_log",
          details: {
            count: decoded.unknownLogCount,
            fromBlock: cursor.toString(),
            toBlock: chunkEnd.toString()
          }
        });
        anomalyCount += 1;
      }
      for (const event of decoded.events) {
        eventCount += 1;
        const result = await this.#apply(event);
        if (result.applied) {
          appliedCount += 1;
        } else if (result.reason === "duplicate") {
          duplicateCount += 1;
        } else {
          anomalyCount += 1;
        }
      }
      cursor = chunkEnd + 1n;
    }
    return {
      chainId: this.#chainId,
      escrowAddress: this.#escrowAddress,
      fromBlock: fromBlock.toString(),
      toBlock: toBlock.toString(),
      eventCount,
      appliedCount,
      duplicateCount,
      anomalyCount,
      unknownLogCount,
      rebuilt: false
    };
  }

  async #apply(event: BindingEvent): Promise<{ readonly applied: boolean; readonly reason?: string }> {
    return applyBindingEvent(event, {
      store: this.#store,
      minimumBlock: this.#startBlock.toString(),
      now: this.#now,
      ...(this.#idFactory ? { idFactory: this.#idFactory } : {})
    });
  }

  async #recordAnomaly(input: {
    readonly blockNumber: string;
    readonly logIndex: number;
    readonly txHash: Hex;
    readonly reason: BindingEventAnomaly["reason"];
    readonly details: unknown;
  }): Promise<void> {
    const anomaly: BindingEventAnomaly = {
      anomalyId: this.#idFactory ? this.#idFactory() : `anom_${this.#chainId}_${input.blockNumber}_${input.logIndex}_${input.reason}`,
      chainId: this.#chainId,
      escrowAddress: this.#escrowAddress,
      blockNumber: input.blockNumber,
      logIndex: input.logIndex,
      txHash: input.txHash,
      reason: input.reason,
      details: input.details,
      createdAt: this.#now().toISOString()
    };
    await this.#store.recordAnomaly(anomaly);
  }

  async #blockTimestamps(logs: readonly RawBindingLog[]): Promise<ReadonlyMap<bigint, bigint>> {
    const blockNumbers = [
      ...new Set(logs.flatMap((log) => (log.blockNumber === null ? [] : [log.blockNumber])))
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
      throw new Error(`binding indexer cannot advance past block ${blockNumber.toString()}: block hash is null`);
    }
    await this.#store.saveCursor({
      chainId: this.#chainId,
      escrowAddress: this.#escrowAddress,
      startBlock: this.#startBlock.toString(),
      nextBlock: (blockNumber + 1n).toString(),
      lastBlock: blockNumber.toString(),
      lastBlockHash: block.hash,
      updatedAt: this.#now().toISOString()
    });
  }
}

function emptySummary(
  chainId: number,
  escrowAddress: Address,
  fromBlock: string,
  toBlock: string,
  rebuilt: boolean
): BindingIndexSummary {
  return {
    chainId,
    escrowAddress,
    fromBlock,
    toBlock,
    eventCount: 0,
    appliedCount: 0,
    duplicateCount: 0,
    anomalyCount: 0,
    unknownLogCount: 0,
    rebuilt
  };
}

function minBigInt(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}
