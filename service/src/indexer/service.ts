import type { ChainServicesConfig } from "../config/index.js";
import { loadConfigFromEnv } from "../config/index.js";
import { createChainEventSourceForTarget } from "../chain-adapters/events.js";
import type { ChainEvent, EventCursor } from "./events.js";
import {
  buildActiveChainEventReplaySummary,
  sortChainEvents
} from "./events.js";
import type { ProjectionSnapshot } from "./projections/index.js";
import { createEmptyProjectionSnapshot } from "./projections/index.js";
import { optionalBytes32Arg } from "./projections/proof.js";
import {
  countDuplicateActiveEventAnomalies,
  countReplayAnomalies,
  rebuildOrderProjections
} from "./replay.js";
import type { ProjectionReplayOptions } from "./replay.js";
import type { DockArtifact } from "@uvp-eth/compiler";
import type { PlanCapabilityTablesInput } from "./projections/plan.js";
import {
  emptySemanticOracleSummary,
  runSemanticOracleReplay,
  type SemanticOraclePlan,
  type SemanticOracleSummary
} from "./semantic-oracle.js";
import { createEmptyIdentityProjectionSnapshot, rebuildIdentityProjections } from "./identity-projections.js";
import { createChainServicesStores } from "../storage/factory.js";
import { createDockArtifactResolver } from "../projection/dock-artifacts.js";
import { createPlanArtifactResolvers } from "../projection/plan-artifacts.js";
import {
  defaultProjectionScope,
  projectionDiagnosticsFromSnapshots,
  type DurableProjectionStore,
  type ProjectionScope,
  type ProjectionStore,
  type ProjectionSyncState
} from "../storage/projection-store.js";
import { consoleLogger, noopLogger, ConfigError, ProjectionError, type Hex, type LifecycleService, type Logger } from "@uvp-eth/service-runtime";
import { redactEndpointErrorMessage } from "../shared/redaction.js";
import { isDirectRun } from "../shared/runtime.js";

export interface ChainEventRange {
  readonly chainId: number;
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
}

type Writable<TValue> = {
  -readonly [TKey in keyof TValue]: TValue[TKey];
};

export interface ChainEventSource {
  getFinalizedBlock(config: ChainServicesConfig): Promise<bigint>;
  readEvents(range: ChainEventRange, config: ChainServicesConfig): Promise<readonly ChainEvent[]>;
  getBlockHash?(blockNumber: bigint, config: ChainServicesConfig): Promise<Hex>;
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
  readonly resolvePlanCapabilityTables?: (
    planId: Hex,
    planHash: Hex
  ) => Promise<PlanCapabilityTablesInput>;
  readonly resolveSemanticOraclePlan?: (
    planId: Hex,
    planHash: Hex
  ) => Promise<SemanticOraclePlan | undefined>;
  readonly resolveDockArtifact?: (
    dkid: Hex,
    docHash: Hex
  ) => Promise<DockArtifact>;
  readonly logger?: Logger;
}

class ReorgCursorMovedError extends Error {
  override readonly name = "ReorgCursorMovedError";

  constructor() {
    super("durable cursor was moved by another writer during reorg rollback");
  }
}

class IncrementalEarlyExitDeclinedError extends Error {
  override readonly name = "IncrementalEarlyExitDeclinedError";

  constructor() {
    super("incremental early exit declined; the full refresh path must handle this round");
  }
}

export class IndexerService implements LifecycleService {
  readonly name = "indexer";

  #running = false;
  #exclusive: Promise<unknown> = Promise.resolve();
  #draining = false;
  #refreshQueued = false;
  #cursor: EventCursor | undefined;
  #consecutiveCursorCasFailures = 0;
  #planCapabilityTablesCache = new Map<string, PlanCapabilityTablesInput>();
  #dockArtifactsCache = new Map<string, DockArtifact>();
  #semanticOraclePlansCache = new Map<string, SemanticOraclePlan>();
  readonly #config: ChainServicesConfig;
  readonly #eventSource: ChainEventSource;
  readonly #store: ProjectionStore;
  readonly #resolvePlanCapabilityTables:
    | ((planId: Hex, planHash: Hex) => Promise<PlanCapabilityTablesInput>)
    | undefined;
  readonly #resolveSemanticOraclePlan:
    | ((planId: Hex, planHash: Hex) => Promise<SemanticOraclePlan | undefined>)
    | undefined;
  readonly #resolveDockArtifact:
    | ((dkid: Hex, docHash: Hex) => Promise<DockArtifact>)
    | undefined;
  readonly #logger: Logger;
  readonly #scope: ProjectionScope;

  constructor(options: IndexerServiceOptions) {
    this.#config = options.config;
    this.#eventSource = options.eventSource;
    this.#store = options.store;
    this.#resolvePlanCapabilityTables = options.resolvePlanCapabilityTables;
    this.#resolveSemanticOraclePlan = options.resolveSemanticOraclePlan;
    this.#resolveDockArtifact = options.resolveDockArtifact;
    this.#logger = options.logger ?? noopLogger;
    this.#scope = defaultProjectionScope(options.config.network.chainId);
  }

  get cursor(): EventCursor | undefined {
    return this.#cursor;
  }

  async #planCapabilityTablesFor(
    events: readonly ChainEvent[]
  ): Promise<ProjectionReplayOptions | undefined> {
    const resolver = this.#resolvePlanCapabilityTables;
    if (!resolver) {
      return undefined;
    }
    for (const anchor of this.#collectPlanAnchors(events).values()) {
      if (this.#planCapabilityTablesCache.has(anchor.planId.toLowerCase())) {
        continue;
      }
      try {
        const source = await resolver(anchor.planId, anchor.planHash);
        this.#planCapabilityTablesCache.set(anchor.planId.toLowerCase(), source);
      } catch (error) {
        this.#logger.warn("plan artifact resolution failed; the plan will be marked capabilityEnrichment=failed while other plans continue", {
          planId: anchor.planId,
          message: error instanceof Error ? redactEndpointErrorMessage(error) : "unknown resolution error"
        });
      }
    }
    return {
      planCapabilityTables: [...this.#planCapabilityTablesCache.values()]
    };
  }

  async #projectionReplayOptionsFor(
    events: readonly ChainEvent[]
  ): Promise<ProjectionReplayOptions | undefined> {
    const planOptions = await this.#planCapabilityTablesFor(events);
    const resolver = this.#resolveDockArtifact;
    if (resolver) {
      for (const anchor of this.#collectDockAnchors(events).values()) {
        const key = `${anchor.dkid.toLowerCase()}:${anchor.docHash.toLowerCase()}`;
        if (this.#dockArtifactsCache.has(key)) {
          continue;
        }
        try {
          this.#dockArtifactsCache.set(key, await resolver(anchor.dkid, anchor.docHash));
        } catch (error) {
          this.#logger.warn("dock artifact resolution failed; the dock will be marked enrichment=failed while other plans and docks continue", {
            dkid: anchor.dkid,
            docHash: anchor.docHash,
            message: error instanceof Error ? redactEndpointErrorMessage(error) : "unknown resolution error"
          });
        }
      }
    }
    const dockArtifacts = [...this.#dockArtifactsCache.values()];
    if (!planOptions && dockArtifacts.length === 0) {
      return undefined;
    }
    return {
      ...(planOptions ?? {}),
      ...(dockArtifacts.length > 0 ? { dockArtifacts } : {})
    };
  }

  #collectDockAnchors(events: readonly ChainEvent[]): Map<string, { readonly dkid: Hex; readonly docHash: Hex }> {
    const anchors = new Map<string, { readonly dkid: Hex; readonly docHash: Hex }>();
    for (const event of events) {
      if (event.removed === true || event.eventName !== "DockRegistered") {
        continue;
      }
      const dkid = optionalBytes32Arg(event, "dkid");
      const docHash = optionalBytes32Arg(event, "docHash");
      if (!dkid || !docHash) {
        continue;
      }
      anchors.set(`${dkid.toLowerCase()}:${docHash.toLowerCase()}`, { dkid, docHash });
    }
    return anchors;
  }

  async #semanticOraclePlansFor(
    events: readonly ChainEvent[]
  ): Promise<readonly SemanticOraclePlan[] | undefined> {
    const resolver = this.#resolveSemanticOraclePlan;
    if (!resolver) {
      return undefined;
    }
    for (const anchor of this.#collectPlanAnchors(events).values()) {
      if (this.#semanticOraclePlansCache.has(anchor.planId.toLowerCase())) {
        continue;
      }
      try {
        const plan = await resolver(anchor.planId, anchor.planHash);
        if (plan) {
          this.#semanticOraclePlansCache.set(anchor.planId.toLowerCase(), plan);
        }
      } catch (error) {
        this.#logger.warn("semantic oracle plan artifact resolution failed; the plan is excluded from this round's semantic verification", {
          planId: anchor.planId,
          message: error instanceof Error ? redactEndpointErrorMessage(error) : "unknown resolution error"
        });
      }
    }
    return [...this.#semanticOraclePlansCache.values()];
  }

  #collectPlanAnchors(events: readonly ChainEvent[]): Map<string, { readonly planId: Hex; readonly planHash: Hex }> {
    const anchors = new Map<string, { readonly planId: Hex; readonly planHash: Hex }>();
    for (const event of events) {
      if (event.removed === true) {
        continue;
      }
      if (event.eventName !== "PlanCommitted" && event.eventName !== "PlanFinalized" && event.eventName !== "PlanRegistered") {
        continue;
      }
      const planId = optionalBytes32Arg(event, "planId");
      const planHash = optionalBytes32Arg(event, "planHash");
      if (!planId || !planHash) {
        continue;
      }
      anchors.set(planId.toLowerCase(), { planId, planHash });
    }
    return anchors;
  }

  #runSemanticOracle(
    events: readonly ChainEvent[],
    plans: readonly SemanticOraclePlan[] | undefined
  ): SemanticOracleSummary {
    if (!plans || plans.length === 0 || events.length === 0) {
      return emptySemanticOracleSummary();
    }
    return runSemanticOracleReplay(events, plans);
  }

  #reconcileSemanticOracle(semanticOracle: SemanticOracleSummary): void {
    if (semanticOracle.semanticOracleMismatchCount > 0) {
      this.#logger.warn(
        "semantic replay oracle diverged from the indexed hook observations; the projection stays chain-authoritative and is NOT overwritten - inspect the on-chain events versus the store-domain plan artifacts for the checked plan subset",
        {
          semanticOracleMismatchCount: semanticOracle.semanticOracleMismatchCount,
          semanticOracleCheckedPlanCount: semanticOracle.semanticOracleCheckedPlanCount
        }
      );
    }
    if (semanticOracle.semanticOracleErrorCount > 0) {
      this.#logger.warn(
        "semantic replay oracle could not verify the indexed hook observations (replay errored outside a chain mismatch); the projection stays chain-authoritative and the failure is counted separately from mismatches",
        {
          semanticOracleErrorCount: semanticOracle.semanticOracleErrorCount,
          semanticOracleCheckedPlanCount: semanticOracle.semanticOracleCheckedPlanCount
        }
      );
    }
  }

  #reconcileCapabilityEnrichmentMismatch(snapshot: ProjectionSnapshot): void {
    const mismatchedPlanIds: Hex[] = [];
    for (const plan of Object.values(snapshot.stateMachinePlans)) {
      if (plan.capabilityEnrichment !== "failed") {
        continue;
      }
      this.#planCapabilityTablesCache.delete(plan.planId.toLowerCase());
      mismatchedPlanIds.push(plan.planId);
    }
    const mismatches = snapshot.capabilityEnrichmentMismatchCount ?? 0;
    if (mismatches > 0) {
      this.#logger.warn(
        "plan artifact vocabulary failed the on-chain anchor assertion (the artifact tables do not reproduce the chain capabilitiesRoot/supplierBindingsRoot); the listed plans stay unenriched-failed so consumers refuse their vocabulary proofs, and the cached source is dropped so the next round re-resolves the corrected artifact",
        {
          capabilityEnrichmentMismatchCount: mismatches,
          planIds: mismatchedPlanIds
        }
      );
    }
    const mismatchedDockIds: string[] = [];
    for (const dock of Object.values(snapshot.stateMachineDocks)) {
      if (dock.enrichment !== "failed") {
        continue;
      }
      for (const [cacheKey, cached] of this.#dockArtifactsCache) {
        if (cached.dkid === dock.dkid) {
          this.#dockArtifactsCache.delete(cacheKey);
        }
      }
      mismatchedDockIds.push(dock.dkid);
    }
    const dockMismatches = snapshot.dockEnrichmentMismatchCount ?? 0;
    if (dockMismatches > 0) {
      this.#logger.warn(
        "dock artifact enrichment failed or mismatched on-chain DockRegistered fields; the listed docks stay enrichment=failed while other plans and docks continue",
        {
          dockEnrichmentMismatchCount: dockMismatches,
          dkids: mismatchedDockIds
        }
      );
    }
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
    return this.#withExclusiveGuard(() => this.#rebuildFromDeploymentBlock(options));
  }

  #withExclusiveGuard<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#exclusive.then(() => operation());
    this.#exclusive = run.then(() => undefined, () => undefined);
    return run;
  }

  async #rebuildFromDeploymentBlock(
    options: IndexerRebuildOptions = {},
    prefetchedFinalizedBlock?: bigint
  ): Promise<IndexerRebuildResult> {
    const deploymentBlock = this.#config.network.deploymentBlock;
    const finalizedBlock = prefetchedFinalizedBlock
      ?? minBlock(
        await this.#eventSource.getFinalizedBlock(this.#config),
        options.targetBlock
      );

    if (finalizedBlock < deploymentBlock) {
      const nextCursor: EventCursor = {
        chainId: this.#config.network.chainId,
        deploymentBlock,
        nextBlock: deploymentBlock,
        finalizedBlock,
        ...(deploymentBlock > 0n
          ? (await this.#cursorBlockHash(deploymentBlock - 1n) ?? {})
          : {})
      };
      await this.#saveCursor(nextCursor);
      this.#cursor = nextCursor;
      const syncState = await this.#store.saveSyncState({
        ...this.#scope,
        syncStatus: "syncing",
        finalizedBlock,
        confirmationDepth: this.#config.network.finalityConfirmations,
        eventCount: 0,
        projectionDiagnostics: projectionDiagnosticsFromSnapshots(
          createEmptyProjectionSnapshot(),
          createEmptyIdentityProjectionSnapshot()
        ),
        rebuild: {
          status: "idle",
          deploymentBlock,
          fromBlock: finalizedBlock,
          toBlock: finalizedBlock,
          eventCount: 0,
          activeEventCount: 0,
          removedEventCount: 0,
          removedLogsFiltered: false,
          projectionRebuilt: false,
          mismatchCount: 0
        }
      });
      return {
        snapshot: createEmptyProjectionSnapshot(),
        summary: summaryFromSnapshot({
          chainId: this.#config.network.chainId,
          deploymentBlock,
          fromBlock: finalizedBlock,
          toBlock: finalizedBlock,
          snapshot: createEmptyProjectionSnapshot(),
          identityBindingCount: 0,
          eventCount: 0,
          activeEventCount: 0,
          removedEventCount: 0,
          removedLogsFiltered: false,
          syncState,
          mismatchCount: 0,
          projectionRebuilt: false
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
      const canonicalHeadHash = await this.#cursorBlockHash(finalizedBlock);
      const events = await this.#eventSource.readEvents(
        {
          chainId: this.#config.network.chainId,
          fromBlock: deploymentBlock,
          toBlock: finalizedBlock
        },
        this.#config
      );
      mismatchCount = countDuplicateActiveEventAnomalies(events);
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
      const nextCursor: EventCursor = {
        chainId: this.#config.network.chainId,
        deploymentBlock,
        nextBlock: finalizedBlock + 1n,
        finalizedBlock,
        ...(canonicalHeadHash ?? {})
      };
      const enrichmentOptions = await this.#projectionReplayOptionsFor(events);
      const semanticOraclePlans = await this.#semanticOraclePlansFor(events);
      const snapshot = await this.#store.resetFromEvents({
        deploymentBlock,
        events,
        ...(enrichmentOptions ?? {}),
        scope: this.#scope,
        syncState: syncStateInput,
        cursor: {
          chainId: this.#scope.chainId,
          contractAddress: this.#scope.contractAddress,
          deploymentBlock,
          nextBlock: nextCursor.nextBlock,
          finalizedBlock,
          ...(nextCursor.blockHash !== undefined ? { blockHash: nextCursor.blockHash } : {})
        }
      });
      this.#cursor = nextCursor;

      const semanticOracle = this.#runSemanticOracle(events, semanticOraclePlans);
      const syncState = await this.#store.saveSyncState({
        ...syncStateInput,
        projectionDiagnostics: projectionDiagnosticsFromSnapshots(snapshot, identitySnapshot, semanticOracle)
      });
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
        projectionRebuilt: true,
        syncState,
        mismatchCount
      });

      this.#logger.info("indexer rebuilt projections from chain events", {
        eventCount: summary.eventCount,
        stateMachineOrderCount: summary.stateMachineOrderCount,
        identityBindingCount: summary.identityBindingCount,
        unresolvedIdentityRevokeEventCount: identitySnapshot.unresolvedRevokeEventCount ?? 0,
        mismatchCount: summary.mismatchCount,
        unresolvedModuleOrderEventCount: snapshot.unresolvedModuleOrderEventCount ?? 0,
        capabilityEnrichmentMismatchCount: snapshot.capabilityEnrichmentMismatchCount ?? 0,
        dockEnrichmentMismatchCount: snapshot.dockEnrichmentMismatchCount ?? 0,
        unknownEventCount: snapshot.unknownEventCount ?? 0,
        semanticOracleMismatchCount: semanticOracle.semanticOracleMismatchCount,
        semanticOracleCheckedPlanCount: semanticOracle.semanticOracleCheckedPlanCount,
        semanticOracleErrorCount: semanticOracle.semanticOracleErrorCount,
        semanticOracleExcludedPlanCount: semanticOracle.semanticOracleExcludedPlanCount,
        nextBlock: this.#cursor.nextBlock.toString(),
        syncStatus: summary.syncStatus
      });
      this.#reconcileCapabilityEnrichmentMismatch(snapshot);
      this.#reconcileSemanticOracle(semanticOracle);

      return { snapshot, summary };
    } catch (error) {
      const applyFailureCount = error instanceof ProjectionError ? 1 : 0;
      await this.#markDegraded(finalizedBlock, error, mismatchCount + applyFailureCount);
      throw error;
    }
  }

  async refreshFromCursorWithSummary(options: IndexerRebuildOptions = {}): Promise<IndexerRebuildResult> {
    return this.#withExclusiveGuard(() =>
      this.#refreshFromCursor(options).catch(async (error: unknown) => {
        await this.#markDegraded(undefined, error);
        throw error;
      })
    );
  }

  async #refreshFromCursor(options: IndexerRebuildOptions = {}): Promise<IndexerRebuildResult> {
    const durableStore = this.#store;
    if (!isDurableProjectionStore(durableStore)) {
      return this.#rebuildFromDeploymentBlock(options);
    }

    const deploymentBlock = this.#config.network.deploymentBlock;
    const finalizedBlock = minBlock(
      await this.#eventSource.getFinalizedBlock(this.#config),
      options.targetBlock
    );
    const storedCursor = await durableStore.getCursor(this.#scope);
    const cursor = this.#cursor ?? storedCursor;
    if (!cursor) {
      // 无游标回落复用本轮已取的 finalizedBlock，不再二次请求 getFinalizedBlock。
      return this.#rebuildFromDeploymentBlock(options, finalizedBlock);
    }

    const fromBlock = cursor.nextBlock > deploymentBlock ? cursor.nextBlock : deploymentBlock;
    const effectiveFromBlock = await this.#rollbackOnReorg(fromBlock);
    const priorFinalizedBlock = maxBlockOf(
      (await durableStore.getCursor(this.#scope))?.finalizedBlock,
      this.#cursor?.finalizedBlock
    );
    const reportedFinalizedBlock = priorFinalizedBlock !== undefined && priorFinalizedBlock > finalizedBlock
      ? priorFinalizedBlock
      : finalizedBlock;
    if (finalizedBlock < effectiveFromBlock) {
      const nextCursor: EventCursor = {
        chainId: this.#config.network.chainId,
        deploymentBlock,
        nextBlock: effectiveFromBlock,
        finalizedBlock: reportedFinalizedBlock,
        ...(effectiveFromBlock > 0n
          ? (await this.#cursorBlockHash(effectiveFromBlock - 1n) ?? {})
          : {})
      };
      await this.#saveCursorAdvancingFrom(nextCursor, effectiveFromBlock);
      const result = await this.#summarizeStoredProjection({
        fromBlock: effectiveFromBlock,
        toBlock: reportedFinalizedBlock,
        newEventCount: 0
      });
      return result;
    }

    const nextCursorBlockHash = await this.#cursorBlockHash(finalizedBlock);
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
    if (
      events.length === 0 &&
      await this.#store.hasProjectionSnapshot("order") &&
      await this.#planCapabilityTablesCacheCoversStoredPlans()
    ) {
      const earlyExitCursor: EventCursor = {
        chainId: this.#config.network.chainId,
        deploymentBlock,
        nextBlock: finalizedBlock + 1n,
        finalizedBlock: reportedFinalizedBlock,
        ...(nextCursorBlockHash ?? {})
      };
      let earlyExitAccepted = false;
      try {
        await durableStore.withTransaction(async () => {
          if (await this.#sweepCommittedButUnadvancedEvents(durableStore, effectiveFromBlock) > 0) {
            throw new IncrementalEarlyExitDeclinedError();
          }
          const saved = await durableStore.saveCursor(
            {
              ...this.#scope,
              deploymentBlock,
              nextBlock: earlyExitCursor.nextBlock,
              ...(earlyExitCursor.finalizedBlock !== undefined ? { finalizedBlock: earlyExitCursor.finalizedBlock } : {}),
              ...(earlyExitCursor.blockHash !== undefined ? { blockHash: earlyExitCursor.blockHash } : {})
            },
            { expectNextBlock: effectiveFromBlock }
          );
          if (saved === undefined) {
            throw new IncrementalEarlyExitDeclinedError();
          }
        });
        earlyExitAccepted = true;
      } catch (error) {
        if (!(error instanceof IncrementalEarlyExitDeclinedError)) {
          throw error;
        }
      }
      if (earlyExitAccepted) {
        this.#consecutiveCursorCasFailures = 0;
        this.#cursor = earlyExitCursor;
        const result = await this.#summarizeStoredProjection({
          fromBlock: effectiveFromBlock,
          toBlock: reportedFinalizedBlock,
          newEventCount: 0
        });
        this.#logger.info("indexer skipped the full replay on a zero-new-events round; the stored projection already covers the finalized range", {
          fromBlock: effectiveFromBlock.toString(),
          toBlock: reportedFinalizedBlock.toString(),
          eventCount: result.summary.eventCount,
          nextBlock: earlyExitCursor.nextBlock.toString(),
          syncStatus: result.summary.syncStatus
        });
        return result;
      }
    }
    const enrichmentEvents = this.#resolvePlanCapabilityTables || this.#resolveDockArtifact
      ? [...(await durableStore.listEvents({ chainId: this.#scope.chainId })), ...events]
      : events;
    const enrichmentOptions = await this.#projectionReplayOptionsFor(enrichmentEvents);
    const semanticOraclePlans = await this.#semanticOraclePlansFor(enrichmentEvents);

    let identitySnapshot: Awaited<ReturnType<typeof rebuildIdentityProjections>> | undefined;
    let oracleResult: SemanticOracleSummary = emptySemanticOracleSummary();
    const result = await durableStore.withTransaction(async () => {
      await this.#sweepCommittedButUnadvancedEvents(durableStore, effectiveFromBlock);
      for (const event of events) {
        await durableStore.appendEvent(event);
      }
      const allEvents = await durableStore.listEvents({ chainId: this.#scope.chainId });
      const replaySummary = buildActiveChainEventReplaySummary(allEvents);
      const activeEvents = [...replaySummary.activeEvents];
      const lastEvent = sortChainEvents(activeEvents).at(-1);
      const snapshot = rebuildOrderProjections(allEvents, {
        ...(enrichmentOptions ?? {})
      });
      identitySnapshot = rebuildIdentityProjections(allEvents);
      const semanticOracle = this.#runSemanticOracle(allEvents, semanticOraclePlans);
      oracleResult = semanticOracle;
      await durableStore.saveSnapshot(this.#scope, "order", snapshot);
      await durableStore.saveSnapshot(this.#scope, "identity", identitySnapshot);
      const mismatchCount = countDuplicateActiveEventAnomalies(allEvents);
      const syncState = await durableStore.saveSyncState({
        ...this.#scope,
        syncStatus: "indexed",
        ...(lastEvent ? { latestIndexedBlock: lastEvent.blockNumber } : {}),
        finalizedBlock: reportedFinalizedBlock,
        confirmationDepth: this.#config.network.finalityConfirmations,
        ...(lastEvent ? { lastEventName: lastEvent.eventName } : {}),
        eventCount: activeEvents.length,
        projectionDiagnostics: projectionDiagnosticsFromSnapshots(snapshot, identitySnapshot, semanticOracle),
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
          projectionRebuilt: true,
          syncState,
          mismatchCount
        })
      };
    });

    const nextCursor: EventCursor = {
      chainId: this.#config.network.chainId,
      deploymentBlock,
      nextBlock: finalizedBlock + 1n,
      finalizedBlock: reportedFinalizedBlock,
      ...(nextCursorBlockHash ?? {})
    };
    await this.#saveCursorAdvancingFrom(nextCursor, effectiveFromBlock);

    this.#logger.info("indexer incrementally refreshed projections from chain events", {
      fromBlock: effectiveFromBlock.toString(),
      toBlock: finalizedBlock.toString(),
      newEventCount: activeNewEvents.length,
      eventCount: result.summary.eventCount,
      stateMachineOrderCount: result.summary.stateMachineOrderCount,
      mismatchCount: result.summary.mismatchCount,
      unresolvedModuleOrderEventCount: result.snapshot.unresolvedModuleOrderEventCount ?? 0,
      capabilityEnrichmentMismatchCount: result.snapshot.capabilityEnrichmentMismatchCount ?? 0,
      dockEnrichmentMismatchCount: result.snapshot.dockEnrichmentMismatchCount ?? 0,
      unknownEventCount: result.snapshot.unknownEventCount ?? 0,
      semanticOracleMismatchCount: oracleResult.semanticOracleMismatchCount,
      semanticOracleCheckedPlanCount: oracleResult.semanticOracleCheckedPlanCount,
      semanticOracleErrorCount: oracleResult.semanticOracleErrorCount,
      semanticOracleExcludedPlanCount: oracleResult.semanticOracleExcludedPlanCount,
      unresolvedIdentityRevokeEventCount: identitySnapshot?.unresolvedRevokeEventCount ?? 0,
      nextBlock: this.#cursor?.nextBlock.toString() ?? nextCursor.nextBlock.toString(),
      syncStatus: result.summary.syncStatus
    });
    this.#reconcileCapabilityEnrichmentMismatch(result.snapshot);
    this.#reconcileSemanticOracle(oracleResult);

    return { snapshot: result.snapshot, summary: result.summary };
  }

  get running(): boolean {
    return this.#running;
  }

  refreshIfIdle(): void {
    this.#refreshQueued = true;
    if (this.#draining) {
      return;
    }
    void this.#drainRefreshQueue();
  }

  async #drainRefreshQueue(): Promise<void> {
    this.#draining = true;
    try {
      while (this.#refreshQueued) {
        this.#refreshQueued = false;
        await this.#withExclusiveGuard(() => this.#refreshFromCursor())
          .catch((error: unknown) => {
            void this.#markDegraded(undefined, error).catch((markError: unknown) => {
              this.#logger.warn("indexer failed to mark background refresh degraded", {
                message: markError instanceof Error ? redactEndpointErrorMessage(markError) : "unknown error"
              });
            });
            this.#logger.warn("indexer background refresh failed", {
              message: error instanceof Error ? redactEndpointErrorMessage(error) : "unknown error"
            });
          });
      }
    } finally {
      this.#draining = false;
      if (this.#refreshQueued) {
        void this.#drainRefreshQueue();
      }
    }
  }

  async #saveCursor(cursor: EventCursor): Promise<void> {
    if (!isDurableProjectionStore(this.#store)) {
      return;
    }
    await this.#store.saveCursor({
      ...this.#scope,
      deploymentBlock: cursor.deploymentBlock,
      nextBlock: cursor.nextBlock,
      ...(cursor.finalizedBlock !== undefined ? { finalizedBlock: cursor.finalizedBlock } : {}),
      ...(cursor.blockHash !== undefined ? { blockHash: cursor.blockHash } : {})
    });
  }

  async #saveCursorAdvancingFrom(cursor: EventCursor, expectNextBlock: bigint): Promise<void> {
    const durableStore = this.#store;
    if (!isDurableProjectionStore(durableStore)) {
      this.#cursor = cursor;
      return;
    }
    const saved = await durableStore.saveCursor(
      {
        ...this.#scope,
        deploymentBlock: cursor.deploymentBlock,
        nextBlock: cursor.nextBlock,
        ...(cursor.finalizedBlock !== undefined ? { finalizedBlock: cursor.finalizedBlock } : {}),
        ...(cursor.blockHash !== undefined ? { blockHash: cursor.blockHash } : {})
      },
      { expectNextBlock }
    );
    if (saved === undefined) {
      const current = await durableStore.getCursor(this.#scope);
      this.#cursor = current
        ? {
          chainId: current.chainId,
          deploymentBlock: current.deploymentBlock,
          nextBlock: current.nextBlock,
          ...(current.finalizedBlock !== undefined ? { finalizedBlock: current.finalizedBlock } : {}),
          ...(current.blockHash !== undefined ? { blockHash: current.blockHash } : {})
        }
        : cursor;
      this.#consecutiveCursorCasFailures += 1;
      if (this.#consecutiveCursorCasFailures >= CURSOR_CAS_FAILURE_LIMIT) {
        throw new ConfigError(
          "durable projection cursor keeps being moved by another writer; run exactly one indexer process per chain scope (single-writer invariant)"
        );
      }
      this.#logger.warn("indexer cursor moved by another writer during refresh; deferring to the durable cursor and re-reading next round", {
        expectedNextBlock: expectNextBlock.toString(),
        durableNextBlock: current?.nextBlock.toString(),
        consecutiveDeferrals: this.#consecutiveCursorCasFailures
      });
      return;
    }
    this.#consecutiveCursorCasFailures = 0;
    this.#cursor = cursor;
  }

  async #cursorBlockHash(blockNumber: bigint): Promise<{ readonly blockHash: Hex } | undefined> {
    const blockHash = await this.#eventSource.getBlockHash?.(blockNumber, this.#config);
    return blockHash ? { blockHash } : undefined;
  }

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
    try {
      return await this.#rollbackToCommonAncestor(durableStore, fromBlock);
    } catch (error) {
      if (!(error instanceof ReorgCursorMovedError)) {
        throw error;
      }
      const current = await durableStore.getCursor(this.#scope);
      this.#consecutiveCursorCasFailures += 1;
      if (this.#consecutiveCursorCasFailures >= CURSOR_CAS_FAILURE_LIMIT) {
        throw new ConfigError(
          "durable projection cursor keeps being moved by another writer; run exactly one indexer process per chain scope (single-writer invariant)"
        );
      }
      this.#logger.warn("indexer cursor moved by another writer during reorg rollback; deferring to the durable cursor and re-reading next round", {
        expectedNextBlock: fromBlock.toString(),
        durableNextBlock: current?.nextBlock.toString(),
        consecutiveDeferrals: this.#consecutiveCursorCasFailures
      });
      const nextBlock = current
        ? (current.nextBlock > this.#config.network.deploymentBlock
          ? current.nextBlock
          : this.#config.network.deploymentBlock)
        : fromBlock;
      this.#cursor = current
        ? {
          chainId: current.chainId,
          deploymentBlock: current.deploymentBlock,
          nextBlock,
          ...(current.finalizedBlock !== undefined ? { finalizedBlock: current.finalizedBlock } : {}),
          ...(current.blockHash !== undefined ? { blockHash: current.blockHash } : {})
        }
        : this.#cursor;
      return nextBlock;
    }
  }

  async #rollbackToCommonAncestor(
    durableStore: DurableProjectionStore,
    fromBlock: bigint
  ): Promise<bigint> {
    const deploymentBlock = this.#config.network.deploymentBlock;
    const storedEvents = await durableStore.listEvents({ chainId: this.#scope.chainId });
    const backtrackFloor = fromBlock > BigInt(MAX_REORG_BACKTRACK_BLOCKS)
      ? (fromBlock - BigInt(MAX_REORG_BACKTRACK_BLOCKS) > deploymentBlock
        ? fromBlock - BigInt(MAX_REORG_BACKTRACK_BLOCKS)
        : deploymentBlock)
      : deploymentBlock;

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
        return this.#applyReorgRollback(durableStore, fromBlock, event.blockNumber, canonicalHash);
      }
    }

    const anchorsBelowWindow = storedEvents
      .filter((event): event is ChainEvent & { readonly blockHash: Hex } =>
        !event.removed &&
        event.blockHash !== undefined &&
        event.blockNumber < fromBlock &&
        event.blockNumber >= deploymentBlock)
      .sort((left, right) => (right.blockNumber > left.blockNumber ? 1 : right.blockNumber < left.blockNumber ? -1 : 0));
    for (const anchor of anchorsBelowWindow) {
      const canonicalHash = await this.#eventSource.getBlockHash?.(anchor.blockNumber, this.#config);
      if (canonicalHash && isSameBlockHash(canonicalHash, anchor.blockHash)) {
        return this.#applyReorgRollback(durableStore, fromBlock, anchor.blockNumber, canonicalHash);
      }
    }
    if (anchorsBelowWindow.length > 0) {
      throw new ConfigError(
        `chain reorg deeper than the stored projection history; full projection rebuild is required`
      );
    }

    const hasStoredEvents = storedEvents.some((event) => !event.removed);
    if (hasStoredEvents) {
      throw new ConfigError(
        "chain reorg detected but stored events carry no block hashes; no common ancestor can be located; full projection rebuild is required"
      );
    }
    this.#logger.warn("chain reorg detected with no stored live events; resetting the projection and replaying the canonical chain from the deployment block", {
      fromBlock: fromBlock.toString(),
      deploymentBlock: this.#config.network.deploymentBlock.toString()
    });
    return this.#resetProjectionAfterEmptyHistoryReorg(durableStore, fromBlock);
  }

  async #resetProjectionAfterEmptyHistoryReorg(
    durableStore: DurableProjectionStore,
    fromBlock: bigint
  ): Promise<bigint> {
    const deploymentBlock = this.#config.network.deploymentBlock;
    const orderSnapshot = createEmptyProjectionSnapshot();
    const identitySnapshot = createEmptyIdentityProjectionSnapshot();
    const existing = await durableStore.getSyncState(this.#scope).catch(() => undefined);
    await durableStore.withTransaction(async () => {
      await durableStore.deleteEventsAfterBlock(
        { chainId: this.#scope.chainId },
        deploymentBlock > 0n ? deploymentBlock - 1n : -1n
      );
      await durableStore.saveSnapshot(this.#scope, "order", orderSnapshot);
      await durableStore.saveSnapshot(this.#scope, "identity", identitySnapshot);
      await durableStore.saveSyncState({
        ...this.#scope,
        syncStatus: "syncing",
        finalizedBlock: deploymentBlock,
        confirmationDepth: this.#config.network.finalityConfirmations,
        eventCount: 0,
        projectionDiagnostics: projectionDiagnosticsFromSnapshots(orderSnapshot, identitySnapshot),
        rebuild: {
          status: "idle",
          deploymentBlock,
          fromBlock: deploymentBlock,
          toBlock: deploymentBlock,
          eventCount: 0,
          activeEventCount: 0,
          removedEventCount: 0,
          removedLogsFiltered: false,
          projectionRebuilt: true,
          mismatchCount: existing?.rebuild?.mismatchCount ?? 0
        }
      });
      const saved = await durableStore.saveCursor(
        {
          ...this.#scope,
          deploymentBlock,
          nextBlock: deploymentBlock,
          finalizedBlock: deploymentBlock
        },
        { expectNextBlock: fromBlock }
      );
      if (saved === undefined) {
        throw new ReorgCursorMovedError();
      }
    });
    this.#consecutiveCursorCasFailures = 0;
    this.#cursor = {
      chainId: this.#config.network.chainId,
      deploymentBlock,
      nextBlock: deploymentBlock,
      finalizedBlock: deploymentBlock
    };
    return deploymentBlock;
  }

  async #applyReorgRollback(
    durableStore: DurableProjectionStore,
    fromBlock: bigint,
    ancestorBlock: bigint,
    ancestorHash: Hex
  ): Promise<bigint> {
    const deploymentBlock = this.#config.network.deploymentBlock;
    const survivingEvents = (await durableStore.listEvents({ chainId: this.#scope.chainId }))
      .filter((event) => event.blockNumber <= ancestorBlock);
    const enrichmentOptions = await this.#projectionReplayOptionsFor(survivingEvents);
    const semanticOraclePlans = await this.#semanticOraclePlansFor(survivingEvents);
    await durableStore.withTransaction(async () => {
      const deleted = await durableStore.deleteEventsAfterBlock(
        { chainId: this.#scope.chainId },
        ancestorBlock
      );
      const remainingEvents = await durableStore.listEvents({ chainId: this.#scope.chainId });
      const snapshot = rebuildOrderProjections(remainingEvents, {
        ...(enrichmentOptions ?? {})
      });
      this.#reconcileCapabilityEnrichmentMismatch(snapshot);
      const semanticOracle = this.#runSemanticOracle(remainingEvents, semanticOraclePlans);
      this.#reconcileSemanticOracle(semanticOracle);
      const identitySnapshot = rebuildIdentityProjections(remainingEvents);
      await durableStore.saveSnapshot(this.#scope, "order", snapshot);
      await durableStore.saveSnapshot(this.#scope, "identity", identitySnapshot);
      const replaySummary = buildActiveChainEventReplaySummary(remainingEvents);
      const mismatchCount = countDuplicateActiveEventAnomalies(remainingEvents);
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
        projectionDiagnostics: projectionDiagnosticsFromSnapshots(snapshot, identitySnapshot, semanticOracle),
        rebuild: {
          status: "idle",
          deploymentBlock,
          fromBlock: deploymentBlock,
          toBlock: ancestorBlock,
          eventCount: replaySummary.activeEventCount,
          activeEventCount: replaySummary.activeEventCount,
          removedEventCount: 0,
          removedLogsFiltered: false,
          projectionRebuilt: true,
          mismatchCount
        }
      });
      const saved = await durableStore.saveCursor(
        {
          ...this.#scope,
          deploymentBlock,
          nextBlock: ancestorBlock + 1n > deploymentBlock ? ancestorBlock + 1n : deploymentBlock,
          finalizedBlock: ancestorBlock,
          blockHash: ancestorHash
        },
        { expectNextBlock: fromBlock }
      );
      if (saved === undefined) {
        throw new ReorgCursorMovedError();
      }
      this.#logger.warn("indexer rolled back projections after chain reorg", {
        ancestorBlock: ancestorBlock.toString(),
        deletedEvents: deleted,
        nextBlock: (ancestorBlock + 1n).toString()
      });
    });
    this.#consecutiveCursorCasFailures = 0;
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

  async #sweepCommittedButUnadvancedEvents(
    durableStore: DurableProjectionStore,
    effectiveFromBlock: bigint
  ): Promise<number> {
    if (effectiveFromBlock <= 0n) {
      return 0;
    }
    const cursorAtAppend = await durableStore.getCursor(this.#scope);
    if (cursorAtAppend?.nextBlock !== effectiveFromBlock) {
      return 0;
    }
    const swept = await durableStore.deleteEventsAfterBlock(
      { chainId: this.#scope.chainId },
      effectiveFromBlock - 1n
    );
    if (swept > 0) {
      this.#logger.warn("indexer swept committed-but-unadvanced event rows before replaying canonical chain data", {
        fromBlock: effectiveFromBlock.toString(),
        sweptEvents: swept
      });
    }
    return swept;
  }

  async #planCapabilityTablesCacheCoversStoredPlans(): Promise<boolean> {
    if (!this.#resolvePlanCapabilityTables) {
      return true;
    }
    const snapshot = await this.#store.getOrderSnapshot?.();
    return Object.values(snapshot?.stateMachinePlans ?? {}).every((plan) =>
      this.#planCapabilityTablesCache.has(plan.planId.toLowerCase())
    );
  }

  async #summarizeStoredProjection(input: {
    readonly fromBlock: bigint;
    readonly toBlock: bigint;
    readonly newEventCount: number;
  }): Promise<IndexerRebuildResult> {
    const metadataFromBlock = input.fromBlock > input.toBlock ? input.toBlock : input.fromBlock;
    const snapshot = await this.#store.getOrderSnapshot?.() ?? createEmptyProjectionSnapshot();
    const identitySnapshot = await this.#store.getIdentitySnapshot();
    const existing = await this.#store.getSyncState(this.#scope);
    const projectionBuilt = await this.#store.hasProjectionSnapshot("order");
    const mismatchCount = existing?.rebuild?.mismatchCount ?? 0;
    const degraded = existing?.syncStatus === "degraded";
    const rebuilding = existing?.syncStatus === "rebuilding" || existing?.rebuild?.status === "running";
    const syncStatus = degraded
      ? "degraded"
      : rebuilding || !projectionBuilt
        ? "stale"
        : "indexed";
    const syncState = await this.#store.saveSyncState({
      ...this.#scope,
      syncStatus,
      ...(existing?.latestIndexedBlock !== undefined ? { latestIndexedBlock: existing.latestIndexedBlock } : {}),
      finalizedBlock: input.toBlock,
      confirmationDepth: this.#config.network.finalityConfirmations,
      ...(existing?.lastEventName ? { lastEventName: existing.lastEventName } : {}),
      eventCount: existing?.eventCount ?? 0,
      ...(existing?.projectionDiagnostics ? { projectionDiagnostics: existing.projectionDiagnostics } : {}),
      ...(degraded && existing?.degradedReason ? { degradedReason: existing.degradedReason } : {}),
      rebuild: {
        status: existing?.rebuild?.status === "running" ? "running" : "idle",
        deploymentBlock: this.#config.network.deploymentBlock,
        fromBlock: metadataFromBlock,
        toBlock: input.toBlock,
        eventCount: input.newEventCount,
        activeEventCount: existing?.eventCount ?? 0,
        removedEventCount: 0,
        removedLogsFiltered: false,
        projectionRebuilt: projectionBuilt,
        mismatchCount
      }
    });
    return {
      snapshot,
      summary: summaryFromSnapshot({
        chainId: this.#config.network.chainId,
        deploymentBlock: this.#config.network.deploymentBlock,
        fromBlock: metadataFromBlock,
        toBlock: input.toBlock,
        snapshot,
        identityBindingCount: Object.keys(identitySnapshot.bindings).length,
        eventCount: syncState.eventCount,
        activeEventCount: syncState.eventCount,
        removedEventCount: 0,
        removedLogsFiltered: false,
        projectionRebuilt: projectionBuilt,
        syncState,
        mismatchCount
      })
    };
  }

  async #markDegraded(
    finalizedBlock: bigint | undefined,
    error: unknown,
    mismatchCount?: number
  ): Promise<void> {
    const existing = await this.#store.getSyncState(this.#scope).catch(() => undefined);
    const effectiveFinalizedBlock =
      finalizedBlock ?? existing?.finalizedBlock ?? this.#cursor?.finalizedBlock ?? this.#config.network.deploymentBlock;
    const effectiveMismatchCount = mismatchCount ??
      existing?.rebuild?.mismatchCount ??
      await this.#storedMismatchCount(existing);
    await this.#store.saveSyncState({
      ...this.#scope,
      syncStatus: "degraded",
      ...(existing?.latestIndexedBlock !== undefined ? { latestIndexedBlock: existing.latestIndexedBlock } : {}),
      finalizedBlock: effectiveFinalizedBlock,
      confirmationDepth: this.#config.network.finalityConfirmations,
      ...(existing?.lastEventName ? { lastEventName: existing.lastEventName } : {}),
      eventCount: existing?.eventCount ?? 0,
      ...(existing?.projectionDiagnostics ? { projectionDiagnostics: existing.projectionDiagnostics } : {}),
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
        mismatchCount: effectiveMismatchCount
      },
      degradedReason: error instanceof Error
        ? redactEndpointErrorMessage(error)
        : "unknown indexer rebuild error"
    });
  }

  async #storedMismatchCount(existing?: ProjectionSyncState): Promise<number> {
    if (isDurableProjectionStore(this.#store)) {
      const events = await this.#store.listEvents({ chainId: this.#scope.chainId });
      return countReplayAnomalies(events);
    }
    return existing?.rebuild?.mismatchCount ?? 0;
  }
}

export function createIndexerService(options: IndexerServiceOptions): IndexerService {
  return new IndexerService(options);
}

async function main(): Promise<void> {
  const config = loadConfigFromEnv();
  if (!process.argv.includes("--rebuild")) {
    throw new Error("indexer CLI requires --rebuild");
  }
  const eventSource = createChainEventSourceForTarget(config, { logger: consoleLogger });
  if (!eventSource) {
    throw new Error("no configured indexer contracts; set UVP_CONTRACTS_JSON or an address manifest");
  }
  const stores = createChainServicesStores({
    database: config.database,
    chainId: config.network.chainId
  });
  try {
    const planArtifacts = createPlanArtifactResolvers({
      store: stores.planArtifactStore,
      chainId: config.network.chainId
    });
    const dockArtifacts = createDockArtifactResolver({
      store: stores.dockArtifactStore,
      chainId: config.network.chainId
    });
    const service = createIndexerService({
      config,
      eventSource,
      store: stores.projectionStore,
      resolvePlanCapabilityTables: planArtifacts.resolvePlanCapabilityTables,
      resolveSemanticOraclePlan: planArtifacts.resolveSemanticOraclePlan,
      resolveDockArtifact: dockArtifacts.resolveDockArtifact,
      logger: consoleLogger
    });
    const targetBlock = parseTargetBlockArg(process.argv);
    const { summary } = await service.rebuildFromDeploymentBlockWithSummary(
      targetBlock === undefined ? {} : { targetBlock }
    );
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await stores.close();
  }
}

if (isDirectRun(import.meta.url)) {
  void main();
}

function minBlock(left: bigint, right: bigint | undefined): bigint {
  return right === undefined || left <= right ? left : right;
}

function maxBlockOf(left: bigint | undefined, right: bigint | undefined): bigint | undefined {
  if (left === undefined) {
    return right;
  }
  if (right === undefined) {
    return left;
  }
  return left >= right ? left : right;
}

const MAX_REORG_BACKTRACK_BLOCKS = 1_000;

const CURSOR_CAS_FAILURE_LIMIT = 3;

function isSameBlockHash(left: Hex, right: Hex): boolean {
  return left.toLowerCase() === right.toLowerCase();
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
  readonly projectionRebuilt: boolean;
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
    projectionRebuilt: input.projectionRebuilt,
    stateMachineOrderCount: Object.values(input.snapshot.stateMachineOrders).length,
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

function parseTargetBlockArg(argv: readonly string[]): bigint | undefined {
  const targetBlockArg = argv.find((item) => item.startsWith("--to-block=") || item.startsWith("--target-block="));
  if (!targetBlockArg) {
    return undefined;
  }
  const rawValue = targetBlockArg.slice(targetBlockArg.indexOf("=") + 1);
  return BigInt(rawValue);
}
