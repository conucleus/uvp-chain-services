import type { ChainServicesConfig } from "../config/index.js";
import { loadConfigFromEnv } from "../config/index.js";
import { createChainEventSourceForTarget } from "../chain-adapters/events.js";
import type { ChainEvent, EventCursor } from "./events.js";
import {
  buildActiveChainEventReplaySummary,
  sortChainEvents
} from "./events.js";
import type { ProjectionSnapshot } from "./projections.js";
import { createEmptyProjectionSnapshot, rebuildOrderProjections } from "./projections.js";
import { rebuildTrustProjections } from "./trust-projections.js";
import { createProjectionStore } from "../storage/factory.js";
import {
  defaultProjectionScope,
  type DurableProjectionStore,
  type ProjectionScope,
  type ProjectionStore,
  type ProjectionSyncState
} from "../storage/projection-store.js";
import { consoleLogger, noopLogger, type LifecycleService, type Logger } from "../shared/types.js";
import { redactErrorMessage } from "../security/redaction.js";
import { isDirectRun } from "../shared/runtime.js";

export interface ChainEventRange {
  readonly chainId: number;
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
}

export interface ChainEventSource {
  getFinalizedBlock(config: ChainServicesConfig): Promise<bigint>;
  readEvents(range: ChainEventRange, config: ChainServicesConfig): Promise<readonly ChainEvent[]>;
}

export interface ChainEventNotificationProcessor {
  processSignalSubmittedEvents(events: readonly ChainEvent[]): Promise<unknown>;
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
  readonly trustPlanCount: number;
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
  readonly #logger: Logger;
  readonly #scope: ProjectionScope;

  constructor(options: IndexerServiceOptions) {
    this.#config = options.config;
    this.#eventSource = options.eventSource;
    this.#store = options.store;
    this.#notificationProcessor = options.notificationProcessor;
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
          removedLogsFiltered: true,
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
          trustPlanCount: 0,
          eventCount: 0,
          activeEventCount: 0,
          removedEventCount: 0,
          removedLogsFiltered: true,
          syncState,
          mismatchCount: 0
        })
      };
    }

    const startedAt = new Date().toISOString();
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
      const replaySummary = buildActiveChainEventReplaySummary(events);
      const activeEvents = [...replaySummary.activeEvents];
      const lastEvent = sortChainEvents(activeEvents).at(-1);
      const trustSnapshot = rebuildTrustProjections(events);

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
          mismatchCount: 0
        }
      };
      const snapshot = await this.#store.resetFromEvents({
        deploymentBlock,
        events,
        scope: this.#scope,
        syncState: syncStateInput
      });
      await this.#processSignalNotifications(activeEvents);

      this.#cursor = {
        chainId: this.#config.network.chainId,
        deploymentBlock,
        nextBlock: finalizedBlock + 1n,
        finalizedBlock
      };
      await this.#saveCursor();

      const syncState = await this.#store.getSyncState(this.#scope) ?? await this.#store.saveSyncState(syncStateInput);
      const summary = summaryFromSnapshot({
        chainId: this.#config.network.chainId,
        deploymentBlock,
        fromBlock: deploymentBlock,
        toBlock: finalizedBlock,
        snapshot,
        trustPlanCount: Object.keys(trustSnapshot.plans).length,
        eventCount: activeEvents.length,
        activeEventCount: replaySummary.activeEventCount,
        removedEventCount: replaySummary.removedEventCount,
        removedLogsFiltered: replaySummary.removedLogsFiltered,
        syncState,
        mismatchCount: 0
      });

      this.#logger.info("indexer rebuilt projections from chain events", {
        eventCount: summary.eventCount,
        stateMachineOrderCount: summary.stateMachineOrderCount,
        trustPlanCount: summary.trustPlanCount,
        nextBlock: this.#cursor.nextBlock.toString(),
        syncStatus: summary.syncStatus
      });

      return { snapshot, summary };
    } catch (error) {
      await this.#markDegraded(finalizedBlock, error);
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
    if (finalizedBlock < fromBlock) {
      this.#cursor = {
        chainId: this.#config.network.chainId,
        deploymentBlock,
        nextBlock: fromBlock,
        finalizedBlock
      };
      await this.#saveCursor();
      return this.#summarizeStoredProjection({
        fromBlock,
        toBlock: finalizedBlock,
        newEventCount: 0
      });
    }

    const events = await this.#eventSource.readEvents(
      {
        chainId: this.#config.network.chainId,
        fromBlock,
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
      const trustSnapshot = rebuildTrustProjections(allEvents);
      await durableStore.saveSnapshot(this.#scope, "order", snapshot);
      await durableStore.saveSnapshot(this.#scope, "trust", trustSnapshot);
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
          fromBlock,
          toBlock: finalizedBlock,
          eventCount: activeNewEvents.length,
          activeEventCount: replaySummary.activeEventCount,
          removedEventCount: replaySummary.removedEventCount,
          removedLogsFiltered: replaySummary.removedLogsFiltered,
          projectionRebuilt: true,
          mismatchCount: 0
        }
      });
      return {
        snapshot,
        summary: summaryFromSnapshot({
          chainId: this.#config.network.chainId,
          deploymentBlock,
          fromBlock,
          toBlock: finalizedBlock,
          snapshot,
          trustPlanCount: Object.keys(trustSnapshot.plans).length,
          eventCount: activeEvents.length,
          activeEventCount: replaySummary.activeEventCount,
          removedEventCount: replaySummary.removedEventCount,
          removedLogsFiltered: replaySummary.removedLogsFiltered,
          syncState,
          mismatchCount: 0
        })
      };
    });

    this.#cursor = {
      chainId: this.#config.network.chainId,
      deploymentBlock,
      nextBlock: finalizedBlock + 1n,
      finalizedBlock
    };
    await this.#saveCursor();
    await this.#processSignalNotifications(activeNewEvents);

    this.#logger.info("indexer incrementally refreshed projections from chain events", {
      fromBlock: fromBlock.toString(),
      toBlock: finalizedBlock.toString(),
      newEventCount: activeNewEvents.length,
      eventCount: result.summary.eventCount,
      stateMachineOrderCount: result.summary.stateMachineOrderCount,
      nextBlock: this.#cursor.nextBlock.toString(),
      syncStatus: result.summary.syncStatus
    });

    return result;
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
      ...(this.#cursor.finalizedBlock !== undefined ? { finalizedBlock: this.#cursor.finalizedBlock } : {})
    });
  }

  async #summarizeStoredProjection(input: {
    readonly fromBlock: bigint;
    readonly toBlock: bigint;
    readonly newEventCount: number;
  }): Promise<IndexerRebuildResult> {
    const snapshot = await this.#store.getOrderSnapshot?.() ?? createEmptyProjectionSnapshot();
    const trustSnapshot = await this.#store.getTrustSnapshot();
    const existing = await this.#store.getSyncState(this.#scope);
    const syncState = await this.#store.saveSyncState({
      ...this.#scope,
      syncStatus: existing?.syncStatus ?? "indexed",
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
        removedLogsFiltered: true,
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
        trustPlanCount: Object.keys(trustSnapshot.plans).length,
        eventCount: syncState.eventCount,
        activeEventCount: syncState.eventCount,
        removedEventCount: 0,
        removedLogsFiltered: true,
        syncState,
        mismatchCount: 0
      })
    };
  }

  async #processSignalNotifications(events: readonly ChainEvent[]): Promise<void> {
    if (!this.#notificationProcessor || events.length === 0) {
      return;
    }
    try {
      await this.#notificationProcessor.processSignalSubmittedEvents(events);
    } catch (error) {
      this.#logger.warn("notification processor failed after indexer projection commit", {
        message: error instanceof Error ? redactErrorMessage(error) : "unknown notification processor error"
      });
    }
  }

  async #markDegraded(finalizedBlock: bigint, error: unknown): Promise<void> {
    const existing = await this.#store.getSyncState(this.#scope).catch(() => undefined);
    await this.#store.saveSyncState({
      ...this.#scope,
      syncStatus: "degraded",
      ...(existing?.latestIndexedBlock !== undefined ? { latestIndexedBlock: existing.latestIndexedBlock } : {}),
      finalizedBlock,
      confirmationDepth: this.#config.network.finalityConfirmations,
      ...(existing?.lastEventName ? { lastEventName: existing.lastEventName } : {}),
      eventCount: existing?.eventCount ?? 0,
      rebuild: {
        status: "failed",
        ...(existing?.rebuild?.startedAt ? { startedAt: existing.rebuild.startedAt } : {}),
        completedAt: new Date().toISOString(),
        deploymentBlock: this.#config.network.deploymentBlock,
        fromBlock: this.#config.network.deploymentBlock,
        toBlock: finalizedBlock,
        eventCount: existing?.eventCount ?? 0,
        activeEventCount: existing?.eventCount ?? 0,
        removedEventCount: existing?.rebuild?.removedEventCount ?? 0,
        removedLogsFiltered: existing?.rebuild?.removedLogsFiltered ?? true,
        projectionRebuilt: false,
        mismatchCount: existing?.rebuild?.mismatchCount ?? 0
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
  consoleLogger.info("indexer framework ready", {
    chainId: config.network.chainId,
    deploymentBlock: config.network.deploymentBlock.toString(),
    databaseUrl: config.database.url
  });
}

if (isDirectRun(import.meta.url)) {
  void main();
}

function minBlock(left: bigint, right: bigint | undefined): bigint {
  return right === undefined || left <= right ? left : right;
}

function summaryFromSnapshot(input: {
  readonly chainId: number;
  readonly deploymentBlock: bigint;
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
  readonly snapshot: ProjectionSnapshot;
  readonly trustPlanCount: number;
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
    trustPlanCount: input.trustPlanCount,
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
