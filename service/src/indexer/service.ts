import type { ChainServicesConfig } from "../config/index.js";
import { loadConfigFromEnv } from "../config/index.js";
import { createChainEventSourceForTarget } from "../chain-adapters/events.js";
import type { ChainEvent, EventCursor } from "./events.js";
import {
  buildActiveChainEventReplaySummary,
  sortChainEvents
} from "./events.js";
import type { ProjectionSnapshot } from "./projections.js";
import { countReplayAnomalies, createEmptyProjectionSnapshot, rebuildOrderProjections } from "./projections.js";
import { rebuildIdentityProjections } from "./identity-projections.js";
import { createProjectionStore } from "../storage/factory.js";
import {
  defaultProjectionScope,
  type DurableProjectionStore,
  type ProjectionScope,
  type ProjectionStore,
  type ProjectionSyncState
} from "../storage/projection-store.js";
import { consoleLogger, noopLogger, ConfigError, type Hex, type LifecycleService, type Logger } from "../shared/types.js";
import { redactErrorMessage, redactSecrets } from "../security/redaction.js";
import { isDirectRun } from "../shared/runtime.js";

export interface ChainEventRange {
  readonly chainId: number;
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
}

export interface ChainEventSource {
  getFinalizedBlock(config: ChainServicesConfig): Promise<bigint>;
  readEvents(range: ChainEventRange, config: ChainServicesConfig): Promise<readonly ChainEvent[]>;
  /**
   * ETH-02：返回当前 canonical 链上指定高度区块哈希；用于追加前的
   * cursor 哈希连续性校验与 reorg 共同祖先定位。事件源不支持时
   * （可选方法缺失）索引器跳过校验，仅依赖 finalityConfirmations 缓冲。
   */
  getBlockHash?(blockNumber: bigint, config: ChainServicesConfig): Promise<Hex>;
}

export interface ChainEventNotificationProcessor {
  processSignalSubmittedEvents(events: readonly ChainEvent[]): Promise<unknown>;
}

export interface ProjectionAutomationProcessor {
  processProjection(snapshot: ProjectionSnapshot): Promise<unknown>;
}

export interface IndexerRebuildSummary {
  readonly chainId: number;
  readonly deploymentBlock: string;
  readonly fromBlock: string;
  readonly toBlock: string;
  readonly eventCount: number;
  readonly activeEventCount: number;
  readonly removedEventCount: number;
  readonly removedLogsFiltered: boolean;
  readonly projectionRebuilt: boolean;
  readonly stateMachineOrderCount: number;
  readonly identityBindingCount: number;
  readonly mismatchCount: number;
  readonly syncStatus: ProjectionSyncState["syncStatus"];
  readonly finalizedBlock: string;
  readonly confirmationDepth: number;
  readonly lastEventName?: string;
}

export interface IndexerRebuildResult {
  readonly snapshot: ProjectionSnapshot;
  readonly summary: IndexerRebuildSummary;
}

export interface IndexerRebuildOptions {
  readonly targetBlock?: bigint;
}

export interface IndexerServiceOptions {
  readonly config: ChainServicesConfig;
  readonly eventSource: ChainEventSource;
  readonly store: ProjectionStore;
  readonly notificationProcessor?: ChainEventNotificationProcessor;
  readonly projectionAutomationProcessor?: ProjectionAutomationProcessor;
  readonly logger?: Logger;
}

export class IndexerService implements LifecycleService {
  readonly name = "indexer";

  #running = false;
  #rebuilding = false;
  #refreshQueued = false;
  #cursor: EventCursor | undefined;
  readonly #config: ChainServicesConfig;
  readonly #eventSource: ChainEventSource;
  readonly #store: ProjectionStore;
  readonly #notificationProcessor: ChainEventNotificationProcessor | undefined;
  readonly #projectionAutomationProcessor: ProjectionAutomationProcessor | undefined;
  readonly #logger: Logger;
  readonly #scope: ProjectionScope;

  constructor(options: IndexerServiceOptions) {
    this.#config = options.config;
    this.#eventSource = options.eventSource;
    this.#store = options.store;
    this.#notificationProcessor = options.notificationProcessor;
    this.#projectionAutomationProcessor = options.projectionAutomationProcessor;
    this.#logger = options.logger ?? noopLogger;
    this.#scope = defaultProjectionScope(options.config.network.chainId);
  }

  get cursor(): EventCursor | undefined {
    return this.#cursor;
  }

  async start(): Promise<void> {
    this.#running = true;
    this.#logger.info("indexer started", {
      chainId: this.#config.network.chainId,
      deploymentBlock: this.#config.network.deploymentBlock.toString()
    });
  }

  async stop(): Promise<void> {
    this.#running = false;
    this.#logger.info("indexer stopped");
  }

  async rebuildFromDeploymentBlock(): Promise<ProjectionSnapshot> {
    return (await this.rebuildFromDeploymentBlockWithSummary()).snapshot;
  }

  async rebuildFromDeploymentBlockWithSummary(options: IndexerRebuildOptions = {}): Promise<IndexerRebuildResult> {
    const deploymentBlock = this.#config.network.deploymentBlock;
    const finalizedBlock = minBlock(
      await this.#eventSource.getFinalizedBlock(this.#config),
      options.targetBlock
    );

    if (finalizedBlock < deploymentBlock) {
      this.#cursor = {
        chainId: this.#config.network.chainId,
        deploymentBlock,
        nextBlock: deploymentBlock,
        finalizedBlock
      };
      await this.#saveCursor();
      const syncState = await this.#store.saveSyncState({
        ...this.#scope,
        syncStatus: "syncing",
        finalizedBlock,
        confirmationDepth: this.#config.network.finalityConfirmations,
        eventCount: 0,
        rebuild: {
          status: "idle",
          deploymentBlock,
          fromBlock: deploymentBlock,
          toBlock: finalizedBlock,
          eventCount: 0,
          activeEventCount: 0,
          removedEventCount: 0,
          removedLogsFiltered: false,
          projectionRebuilt: true,
          mismatchCount: 0
        }
      });
      return {
        snapshot: createEmptyProjectionSnapshot(),
        summary: summaryFromSnapshot({
          chainId: this.#config.network.chainId,
          deploymentBlock,
          fromBlock: deploymentBlock,
          toBlock: finalizedBlock,
          snapshot: createEmptyProjectionSnapshot(),
          identityBindingCount: 0,
          eventCount: 0,
          activeEventCount: 0,
          removedEventCount: 0,
          removedLogsFiltered: false,
          syncState,
          mismatchCount: 0
        })
      };
    }

    const startedAt = new Date().toISOString();
    let mismatchCount = 0;
    await this.#store.saveSyncState({
      ...this.#scope,
      syncStatus: "rebuilding",
      ...(this.#cursor?.nextBlock ? { latestIndexedBlock: this.#cursor.nextBlock - 1n } : {}),
      finalizedBlock,
      confirmationDepth: this.#config.network.finalityConfirmations,
      eventCount: 0,
      rebuild: {
        status: "running",
        startedAt,
        deploymentBlock,
        fromBlock: deploymentBlock,
        toBlock: finalizedBlock,
        mismatchCount: 0
      }
    });

    try {
      const events = await this.#eventSource.readEvents(
        {
          chainId: this.#config.network.chainId,
          fromBlock: deploymentBlock,
          toBlock: finalizedBlock
        },
        this.#config
      );
      // ETH-09：mismatchCount 反映真实 replay 异常（重复/矛盾投递、投影
      // apply 失败），不再硬编码 0。
      mismatchCount = countReplayAnomalies(events);
      const replaySummary = buildActiveChainEventReplaySummary(events);
      const activeEvents = [...replaySummary.activeEvents];
      const lastEvent = sortChainEvents(activeEvents).at(-1);
      const identitySnapshot = rebuildIdentityProjections(events);

      const syncStateInput: Omit<ProjectionSyncState, "updatedAt"> = {
        ...this.#scope,
        syncStatus: "indexed",
        ...(lastEvent ? { latestIndexedBlock: lastEvent.blockNumber } : {}),
        finalizedBlock,
        confirmationDepth: this.#config.network.finalityConfirmations,
        ...(lastEvent ? { lastEventName: lastEvent.eventName } : {}),
        eventCount: activeEvents.length,
        rebuild: {
          status: "completed",
          startedAt,
          completedAt: new Date().toISOString(),
          deploymentBlock,
          fromBlock: deploymentBlock,
          toBlock: finalizedBlock,
          eventCount: activeEvents.length,
          activeEventCount: replaySummary.activeEventCount,
          removedEventCount: replaySummary.removedEventCount,
          removedLogsFiltered: replaySummary.removedLogsFiltered,
          projectionRebuilt: true,
          mismatchCount
        }
      };
      const snapshot = await this.#store.resetFromEvents({
        deploymentBlock,
        events,
        scope: this.#scope,
        syncState: syncStateInput
      });
      await this.#processSignalNotifications(activeEvents);
      await this.#processProjectionAutomation(snapshot);

      this.#cursor = {
        chainId: this.#config.network.chainId,
        deploymentBlock,
        nextBlock: finalizedBlock + 1n,
        finalizedBlock,
        ...(await this.#cursorBlockHash(finalizedBlock))
      };
      await this.#saveCursor();

      const syncState = await this.#store.getSyncState(this.#scope) ?? await this.#store.saveSyncState(syncStateInput);
      const summary = summaryFromSnapshot({
        chainId: this.#config.network.chainId,
        deploymentBlock,
        fromBlock: deploymentBlock,
        toBlock: finalizedBlock,
        snapshot,
        identityBindingCount: Object.keys(identitySnapshot.bindings).length,
        eventCount: activeEvents.length,
        activeEventCount: replaySummary.activeEventCount,
        removedEventCount: replaySummary.removedEventCount,
        removedLogsFiltered: replaySummary.removedLogsFiltered,
        syncState,
        mismatchCount
      });

      this.#logger.info("indexer rebuilt projections from chain events", {
        eventCount: summary.eventCount,
        stateMachineOrderCount: summary.stateMachineOrderCount,
        identityBindingCount: summary.identityBindingCount,
        mismatchCount: summary.mismatchCount,
        nextBlock: this.#cursor.nextBlock.toString(),
        syncStatus: summary.syncStatus
      });

      return { snapshot, summary };
    } catch (error) {
      // ETH-09：投影 apply 失败（如未知 plan 引用）时把已统计到的真实
      // 异常数带入 degraded 状态，而不是回退为旧值/0。
      await this.#markDegraded(finalizedBlock, error, mismatchCount);
      throw error;
    }
  }

  async refreshFromCursorWithSummary(options: IndexerRebuildOptions = {}): Promise<IndexerRebuildResult> {
    const durableStore = this.#store;
    if (!isDurableProjectionStore(durableStore)) {
      return this.rebuildFromDeploymentBlockWithSummary(options);
    }

    const deploymentBlock = this.#config.network.deploymentBlock;
    const finalizedBlock = minBlock(
      await this.#eventSource.getFinalizedBlock(this.#config),
      options.targetBlock
    );
    const storedCursor = await durableStore.getCursor(this.#scope);
    const cursor = this.#cursor ?? storedCursor;
    if (!cursor) {
      return this.rebuildFromDeploymentBlockWithSummary(
        options.targetBlock === undefined ? {} : { targetBlock: finalizedBlock }
      );
    }

    const fromBlock = cursor.nextBlock > deploymentBlock ? cursor.nextBlock : deploymentBlock;
    // ETH-02：追加前做哈希连续性校验。深度 reorg 会在这里被检测到并回滚
    // 投影；finalityConfirmations 仍是第一道缓冲，超过其深度的 reorg 若
    // 回溯窗口内找不到共同祖先则报错要求 full rebuild。
    const effectiveFromBlock = await this.#rollbackOnReorg(fromBlock);
    if (finalizedBlock < effectiveFromBlock) {
      this.#cursor = {
        chainId: this.#config.network.chainId,
        deploymentBlock,
        nextBlock: effectiveFromBlock,
        finalizedBlock
      };
      await this.#saveCursor();
      const result = await this.#summarizeStoredProjection({
        fromBlock: effectiveFromBlock,
        toBlock: finalizedBlock,
        newEventCount: 0
      });
      await this.#processProjectionAutomation(result.snapshot);
      return result;
    }

    const events = await this.#eventSource.readEvents(
      {
        chainId: this.#config.network.chainId,
        fromBlock: effectiveFromBlock,
        toBlock: finalizedBlock
      },
      this.#config
    );
    const newReplaySummary = buildActiveChainEventReplaySummary(events);
    const activeNewEvents = [...newReplaySummary.activeEvents];

    const result = await durableStore.withTransaction(async () => {
      for (const event of events) {
        await durableStore.appendEvent(event);
      }
      const allEvents = await durableStore.listEvents({ chainId: this.#scope.chainId });
      const replaySummary = buildActiveChainEventReplaySummary(allEvents);
      const activeEvents = [...replaySummary.activeEvents];
      const lastEvent = sortChainEvents(activeEvents).at(-1);
      const snapshot = rebuildOrderProjections(allEvents);
      const identitySnapshot = rebuildIdentityProjections(allEvents);
      await durableStore.saveSnapshot(this.#scope, "order", snapshot);
      await durableStore.saveSnapshot(this.#scope, "identity", identitySnapshot);
      // ETH-09：mismatchCount 反映真实 replay 异常，不再硬编码 0。
      const mismatchCount = countReplayAnomalies(allEvents);
      const syncState = await durableStore.saveSyncState({
        ...this.#scope,
        syncStatus: "indexed",
        ...(lastEvent ? { latestIndexedBlock: lastEvent.blockNumber } : {}),
        finalizedBlock,
        confirmationDepth: this.#config.network.finalityConfirmations,
        ...(lastEvent ? { lastEventName: lastEvent.eventName } : {}),
        eventCount: activeEvents.length,
        rebuild: {
          status: "idle",
          deploymentBlock,
          fromBlock: effectiveFromBlock,
          toBlock: finalizedBlock,
          eventCount: activeNewEvents.length,
          activeEventCount: replaySummary.activeEventCount,
          removedEventCount: replaySummary.removedEventCount,
          removedLogsFiltered: replaySummary.removedLogsFiltered,
          projectionRebuilt: true,
          mismatchCount
        }
      });
      return {
        snapshot,
        summary: summaryFromSnapshot({
          chainId: this.#config.network.chainId,
          deploymentBlock,
          fromBlock: effectiveFromBlock,
          toBlock: finalizedBlock,
          snapshot,
          identityBindingCount: Object.keys(identitySnapshot.bindings).length,
          eventCount: activeEvents.length,
          activeEventCount: replaySummary.activeEventCount,
          removedEventCount: replaySummary.removedEventCount,
          removedLogsFiltered: replaySummary.removedLogsFiltered,
          syncState,
          mismatchCount
        })
      };
    });

    this.#cursor = {
      chainId: this.#config.network.chainId,
      deploymentBlock,
      nextBlock: finalizedBlock + 1n,
      finalizedBlock,
      ...(await this.#cursorBlockHash(finalizedBlock))
    };
    await this.#saveCursor();
    await this.#processSignalNotifications(activeNewEvents);
    await this.#processProjectionAutomation(result.snapshot);

    this.#logger.info("indexer incrementally refreshed projections from chain events", {
      fromBlock: effectiveFromBlock.toString(),
      toBlock: finalizedBlock.toString(),
      newEventCount: activeNewEvents.length,
      eventCount: result.summary.eventCount,
      stateMachineOrderCount: result.summary.stateMachineOrderCount,
      mismatchCount: result.summary.mismatchCount,
      nextBlock: this.#cursor.nextBlock.toString(),
      syncStatus: result.summary.syncStatus
    });

    return { snapshot: result.snapshot, summary: result.summary };
  }

  get running(): boolean {
    return this.#running;
  }

  refreshIfIdle(): void {
    if (this.#rebuilding) {
      this.#refreshQueued = true;
      return;
    }
    this.#rebuilding = true;
    void this.#drainRefreshQueue();
  }

  async #drainRefreshQueue(): Promise<void> {
    try {
      do {
        this.#refreshQueued = false;
        await this.refreshFromCursorWithSummary()
          .catch((error: unknown) => {
            void this.#markDegraded(undefined, error).catch((markError: unknown) => {
              this.#logger.warn("indexer failed to mark background refresh degraded", {
                message: markError instanceof Error ? redactErrorMessage(markError) : "unknown error"
              });
            });
            this.#logger.warn("indexer background refresh failed", {
              message: error instanceof Error ? redactErrorMessage(error) : "unknown error"
            });
          });
      } while (this.#refreshQueued);
    } finally {
      this.#rebuilding = false;
    }
  }

  async #saveCursor(): Promise<void> {
    if (!isDurableProjectionStore(this.#store) || !this.#cursor) {
      return;
    }
    await this.#store.saveCursor({
      ...this.#scope,
      deploymentBlock: this.#cursor.deploymentBlock,
      nextBlock: this.#cursor.nextBlock,
      ...(this.#cursor.finalizedBlock !== undefined ? { finalizedBlock: this.#cursor.finalizedBlock } : {}),
      ...(this.#cursor.blockHash !== undefined ? { blockHash: this.#cursor.blockHash } : {})
    });
  }

  /**
   * ETH-02：cursor 高度（finalizedBlock）区块哈希；事件源不支持时省略，
   * 下次刷新将跳过哈希校验（仅靠 finalityConfirmations 缓冲）。
   */
  async #cursorBlockHash(blockNumber: bigint): Promise<{ readonly blockHash: Hex } | undefined> {
    const blockHash = await this.#eventSource.getBlockHash?.(blockNumber, this.#config);
    return blockHash ? { blockHash } : undefined;
  }

  /**
   * ETH-02：追加前校验哈希连续性——cursor 已存块哈希是 cursor 高度
   * （nextBlock - 1 = fromBlock - 1）区块的哈希；取 canonical 链上同一
   * 高度的哈希与之比较（与"取高度+1 块比 parentHash"等价），不一致即
   * 发生过 reorg：从 cursor 向回（有界，MAX_REORG_BACKTRACK_BLOCKS）在
   * 已存事件与 canonical 链之间找共同祖先，删除祖先之后的事件、从剩余
   * 事件重建快照并回退 cursor，然后从祖先 + 1 正常追加。
   *
   * 残余风险：超过 finalityConfirmations 的深度 reorg 仍可能伪造出
   * "完全一致"的历史；回溯窗口内找不到共同祖先时报错要求 full rebuild。
   * cursor 无已存哈希（旧数据/事件源不支持）时跳过校验。
   */
  async #rollbackOnReorg(fromBlock: bigint): Promise<bigint> {
    const durableStore = this.#store;
    if (!isDurableProjectionStore(durableStore)) {
      return fromBlock;
    }
    const storedCursor = await durableStore.getCursor(this.#scope);
    const storedHash = storedCursor?.blockHash;
    const getBlockHash = this.#eventSource.getBlockHash?.bind(this.#eventSource);
    if (!storedHash || !getBlockHash) {
      return fromBlock;
    }
    const cursorHeight = fromBlock - 1n;
    if (cursorHeight < this.#config.network.deploymentBlock) {
      return fromBlock;
    }

    const canonicalHash = await getBlockHash(cursorHeight, this.#config);
    if (isSameBlockHash(canonicalHash, storedHash)) {
      return fromBlock;
    }
    return this.#rollbackToCommonAncestor(durableStore, fromBlock);
  }

  /** ETH-02：从 cursor 高度向回找共同祖先（有界），找到则回滚投影。 */
  async #rollbackToCommonAncestor(
    durableStore: DurableProjectionStore,
    fromBlock: bigint
  ): Promise<bigint> {
    const deploymentBlock = this.#config.network.deploymentBlock;
    const storedEvents = await durableStore.listEvents({ chainId: this.#scope.chainId });
    const backtrackFloor = fromBlock > BigInt(MAX_REORG_BACKTRACK_BLOCKS)
      ? fromBlock - BigInt(MAX_REORG_BACKTRACK_BLOCKS)
      : deploymentBlock;

    // 从最新的带哈希事件向回找：第一个 canonical 哈希一致的块即共同祖先。
    const candidates = storedEvents
      .filter((event): event is ChainEvent & { readonly blockHash: Hex } =>
        !event.removed &&
        event.blockHash !== undefined &&
        event.blockNumber >= backtrackFloor &&
        event.blockNumber < fromBlock)
      .sort((left, right) => (right.blockNumber > left.blockNumber ? 1 : right.blockNumber < left.blockNumber ? -1 : 0));
    const seenBlocks = new Set<bigint>();
    for (const event of candidates) {
      if (seenBlocks.has(event.blockNumber)) {
        continue;
      }
      seenBlocks.add(event.blockNumber);
      const canonicalHash = await this.#eventSource.getBlockHash?.(event.blockNumber, this.#config);
      if (canonicalHash && isSameBlockHash(canonicalHash, event.blockHash)) {
        return this.#applyReorgRollback(durableStore, event.blockNumber, canonicalHash);
      }
    }

    throw new ConfigError(
      `chain reorg deeper than the ${MAX_REORG_BACKTRACK_BLOCKS}-block rollback window; full projection rebuild is required`
    );
  }

  /** ETH-02：删除祖先之后的事件、重建快照、回退 cursor。 */
  async #applyReorgRollback(
    durableStore: DurableProjectionStore,
    ancestorBlock: bigint,
    ancestorHash: Hex
  ): Promise<bigint> {
    const deploymentBlock = this.#config.network.deploymentBlock;
    await durableStore.withTransaction(async () => {
      const deleted = await durableStore.deleteEventsAfterBlock(
        { chainId: this.#scope.chainId },
        ancestorBlock
      );
      const remainingEvents = await durableStore.listEvents({ chainId: this.#scope.chainId });
      const snapshot = rebuildOrderProjections(remainingEvents);
      const identitySnapshot = rebuildIdentityProjections(remainingEvents);
      await durableStore.saveSnapshot(this.#scope, "order", snapshot);
      await durableStore.saveSnapshot(this.#scope, "identity", identitySnapshot);
      const replaySummary = buildActiveChainEventReplaySummary(remainingEvents);
      const existing = await durableStore.getSyncState(this.#scope).catch(() => undefined);
      await durableStore.saveSyncState({
        ...this.#scope,
        syncStatus: "syncing",
        ...(existing?.latestIndexedBlock !== undefined && existing.latestIndexedBlock <= ancestorBlock
          ? { latestIndexedBlock: existing.latestIndexedBlock }
          : {}),
        finalizedBlock: ancestorBlock,
        confirmationDepth: this.#config.network.finalityConfirmations,
        ...(existing?.lastEventName ? { lastEventName: existing.lastEventName } : {}),
        eventCount: replaySummary.activeEventCount,
        rebuild: {
          status: "idle",
          deploymentBlock,
          fromBlock: deploymentBlock,
          toBlock: ancestorBlock,
          eventCount: 0,
          activeEventCount: replaySummary.activeEventCount,
          removedEventCount: 0,
          removedLogsFiltered: false,
          projectionRebuilt: true,
          mismatchCount: 0
        }
      });
      await durableStore.saveCursor({
        ...this.#scope,
        deploymentBlock,
        nextBlock: ancestorBlock + 1n > deploymentBlock ? ancestorBlock + 1n : deploymentBlock,
        finalizedBlock: ancestorBlock,
        blockHash: ancestorHash
      });
      this.#logger.warn("indexer rolled back projections after chain reorg", {
        ancestorBlock: ancestorBlock.toString(),
        deletedEvents: deleted,
        nextBlock: (ancestorBlock + 1n).toString()
      });
    });
    const nextBlock = ancestorBlock + 1n > deploymentBlock ? ancestorBlock + 1n : deploymentBlock;
    this.#cursor = {
      chainId: this.#config.network.chainId,
      deploymentBlock,
      nextBlock,
      finalizedBlock: ancestorBlock,
      blockHash: ancestorHash
    };
    return nextBlock;
  }

  async #summarizeStoredProjection(input: {
    readonly fromBlock: bigint;
    readonly toBlock: bigint;
    readonly newEventCount: number;
  }): Promise<IndexerRebuildResult> {
    const snapshot = await this.#store.getOrderSnapshot?.() ?? createEmptyProjectionSnapshot();
    const identitySnapshot = await this.#store.getIdentitySnapshot();
    const existing = await this.#store.getSyncState(this.#scope);
    const syncState = await this.#store.saveSyncState({
      ...this.#scope,
      syncStatus: "indexed",
      ...(existing?.latestIndexedBlock !== undefined ? { latestIndexedBlock: existing.latestIndexedBlock } : {}),
      finalizedBlock: input.toBlock,
      confirmationDepth: this.#config.network.finalityConfirmations,
      ...(existing?.lastEventName ? { lastEventName: existing.lastEventName } : {}),
      eventCount: existing?.eventCount ?? 0,
      rebuild: {
        status: "idle",
        deploymentBlock: this.#config.network.deploymentBlock,
        fromBlock: input.fromBlock,
        toBlock: input.toBlock,
        eventCount: input.newEventCount,
        activeEventCount: existing?.eventCount ?? 0,
        removedEventCount: 0,
        removedLogsFiltered: false,
        projectionRebuilt: snapshot.rebuildable,
        mismatchCount: 0
      }
    });
    return {
      snapshot,
      summary: summaryFromSnapshot({
        chainId: this.#config.network.chainId,
        deploymentBlock: this.#config.network.deploymentBlock,
        fromBlock: input.fromBlock,
        toBlock: input.toBlock,
        snapshot,
        identityBindingCount: Object.keys(identitySnapshot.bindings).length,
        eventCount: syncState.eventCount,
        activeEventCount: syncState.eventCount,
        removedEventCount: 0,
        removedLogsFiltered: false,
        syncState,
        mismatchCount: 0
      })
    };
  }

  async #processSignalNotifications(events: readonly ChainEvent[]): Promise<void> {
    const processor = this.#notificationProcessor;
    if (!processor || events.length === 0) {
      return;
    }
    await this.#runPostCommitStepWithBoundedRetry("signal notification", () =>
      processor.processSignalSubmittedEvents(events)
    );
  }

  async #processProjectionAutomation(
    snapshot: ProjectionSnapshot
  ): Promise<void> {
    const processor = this.#projectionAutomationProcessor;
    if (!processor) {
      return;
    }
    await this.#runPostCommitStepWithBoundedRetry("projection automation", () =>
      processor.processProjection(snapshot)
    );
  }

  /**
   * Post-commit steps run after the projection commit succeeded. Failures are
   * retried a bounded number of times in-process; once retries are exhausted
   * the step gives up with an error log instead of blocking the indexer loop.
   */
  async #runPostCommitStepWithBoundedRetry(step: string, run: () => Promise<unknown>): Promise<void> {
    for (let attempt = 1; attempt <= POST_COMMIT_STEP_MAX_ATTEMPTS; attempt += 1) {
      try {
        await run();
        return;
      } catch (error) {
        const message = error instanceof Error ? redactErrorMessage(error) : `unknown ${step} error`;
        if (attempt === POST_COMMIT_STEP_MAX_ATTEMPTS) {
          this.#logger.error(`post-commit ${step} failed after ${POST_COMMIT_STEP_MAX_ATTEMPTS} attempts`, {
            message
          });
          return;
        }
        const nextDelayMs = postCommitStepRetryDelayMs(attempt);
        this.#logger.warn(`post-commit ${step} failed; retrying`, { attempt, nextDelayMs, message });
        await sleep(nextDelayMs);
      }
    }
  }

  async #markDegraded(
    finalizedBlock: bigint | undefined,
    error: unknown,
    mismatchCount?: number
  ): Promise<void> {
    const existing = await this.#store.getSyncState(this.#scope).catch(() => undefined);
    const effectiveFinalizedBlock =
      finalizedBlock ?? existing?.finalizedBlock ?? this.#cursor?.finalizedBlock ?? this.#config.network.deploymentBlock;
    await this.#store.saveSyncState({
      ...this.#scope,
      syncStatus: "degraded",
      ...(existing?.latestIndexedBlock !== undefined ? { latestIndexedBlock: existing.latestIndexedBlock } : {}),
      finalizedBlock: effectiveFinalizedBlock,
      confirmationDepth: this.#config.network.finalityConfirmations,
      ...(existing?.lastEventName ? { lastEventName: existing.lastEventName } : {}),
      eventCount: existing?.eventCount ?? 0,
      rebuild: {
        status: "failed",
        ...(existing?.rebuild?.startedAt ? { startedAt: existing.rebuild.startedAt } : {}),
        completedAt: new Date().toISOString(),
        deploymentBlock: this.#config.network.deploymentBlock,
        fromBlock: this.#config.network.deploymentBlock,
        toBlock: effectiveFinalizedBlock,
        eventCount: existing?.eventCount ?? 0,
        activeEventCount: existing?.eventCount ?? 0,
        removedEventCount: existing?.rebuild?.removedEventCount ?? 0,
        removedLogsFiltered: existing?.rebuild?.removedLogsFiltered ?? false,
        projectionRebuilt: false,
        mismatchCount: mismatchCount ?? existing?.rebuild?.mismatchCount ?? 0
      },
      degradedReason: error instanceof Error ? error.message : "unknown indexer rebuild error"
    });
  }
}

export function createIndexerService(options: IndexerServiceOptions): IndexerService {
  return new IndexerService(options);
}

async function main(): Promise<void> {
  const config = loadConfigFromEnv();
  if (process.argv.includes("--rebuild")) {
    const eventSource = createChainEventSourceForTarget(config);
    if (!eventSource) {
      throw new Error("no configured indexer contracts; set UVP_CONTRACTS_JSON or an address manifest");
    }
    const store = createProjectionStore({
      database: config.database,
      chainId: config.network.chainId
    });
    try {
      const service = createIndexerService({ config, eventSource, store, logger: consoleLogger });
      const targetBlock = parseTargetBlockArg(process.argv);
      const { summary } = await service.rebuildFromDeploymentBlockWithSummary(
        targetBlock === undefined ? {} : { targetBlock }
      );
      console.log(JSON.stringify(summary, null, 2));
    } finally {
      if (isClosableStore(store)) {
        await store.close();
      }
    }
    return;
  }
  consoleLogger.info("indexer framework ready", redactSecrets({
    chainId: config.network.chainId,
    deploymentBlock: config.network.deploymentBlock.toString(),
    databaseUrl: config.database.url
  }));
}

if (isDirectRun(import.meta.url)) {
  void main();
}

function minBlock(left: bigint, right: bigint | undefined): bigint {
  return right === undefined || left <= right ? left : right;
}

const MAX_REORG_BACKTRACK_BLOCKS = 1_000;

function isSameBlockHash(left: Hex, right: Hex): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

const POST_COMMIT_STEP_MAX_ATTEMPTS = 3;
const POST_COMMIT_STEP_RETRY_BASE_DELAY_MS = 100;
const POST_COMMIT_STEP_RETRY_MAX_DELAY_MS = 2000;

function postCommitStepRetryDelayMs(attempt: number): number {
  return Math.min(
    POST_COMMIT_STEP_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
    POST_COMMIT_STEP_RETRY_MAX_DELAY_MS
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function summaryFromSnapshot(input: {
  readonly chainId: number;
  readonly deploymentBlock: bigint;
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
  readonly snapshot: ProjectionSnapshot;
  readonly identityBindingCount: number;
  readonly eventCount: number;
  readonly activeEventCount: number;
  readonly removedEventCount: number;
  readonly removedLogsFiltered: boolean;
  readonly syncState: ProjectionSyncState;
  readonly mismatchCount: number;
}): IndexerRebuildSummary {
  return {
    chainId: input.chainId,
    deploymentBlock: input.deploymentBlock.toString(),
    fromBlock: input.fromBlock.toString(),
    toBlock: input.toBlock.toString(),
    eventCount: input.eventCount,
    activeEventCount: input.activeEventCount,
    removedEventCount: input.removedEventCount,
    removedLogsFiltered: input.removedLogsFiltered,
    projectionRebuilt: input.snapshot.rebuildable,
    stateMachineOrderCount: Object.keys(input.snapshot.stateMachineOrders).length,
    identityBindingCount: input.identityBindingCount,
    mismatchCount: input.mismatchCount,
    syncStatus: input.syncState.syncStatus,
    finalizedBlock: input.syncState.finalizedBlock?.toString() ?? input.toBlock.toString(),
    confirmationDepth: input.syncState.confirmationDepth,
    ...(input.syncState.lastEventName ? { lastEventName: input.syncState.lastEventName } : {})
  };
}

function isDurableProjectionStore(store: ProjectionStore): store is DurableProjectionStore {
  return "saveCursor" in store && typeof (store as { readonly saveCursor?: unknown }).saveCursor === "function";
}

function isClosableStore(store: ProjectionStore): store is ProjectionStore & { close(): Promise<void> } {
  return "close" in store && typeof (store as { readonly close?: unknown }).close === "function";
}

function parseTargetBlockArg(argv: readonly string[]): bigint | undefined {
  const targetBlockArg = argv.find((item) => item.startsWith("--to-block=") || item.startsWith("--target-block="));
  if (!targetBlockArg) {
    return undefined;
  }
  const rawValue = targetBlockArg.slice(targetBlockArg.indexOf("=") + 1);
  return BigInt(rawValue);
}
