import type { ChainEvent } from "../indexer/events.js";
import { filterActiveChainEvents, sortChainEvents } from "../indexer/events.js";
import {
  createEmptyProjectionSnapshot,
  rebuildOrderProjections,
  type OrderProjection,
  type ProjectionSnapshot,
  type StateMachineOrderProjection,
  type StateMachineTaskProjection
} from "../indexer/projections.js";
import {
  createEmptyTrustProjectionSnapshot,
  filterPlanTrust,
  filterSupplierTrust,
  rebuildTrustProjections,
  type PlanTrustProjection,
  type PlanTrustQuery,
  type SupplierTrustProjection,
  type SupplierTrustQuery,
  type TrustDomainProjection,
  type TrustProjectionSnapshot
} from "../indexer/trust-projections.js";
import type { Address } from "../shared/types.js";
import type { StorageAdapterLifecycle, TransactionalStorage } from "./types.js";

export const projectionScopeContractAddress = "0x0000000000000000000000000000000000000000" as const;

export type ProjectionSyncStatus = "indexed" | "syncing" | "stale" | "rebuilding" | "degraded";
export type ProjectionRebuildStatus = "idle" | "running" | "completed" | "failed";

export interface ProjectionRebuildMetadata {
  readonly status: ProjectionRebuildStatus;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly fromBlock?: bigint;
  readonly toBlock?: bigint;
  readonly eventCount?: number;
  readonly mismatchCount?: number;
}

export interface ProjectionSyncState extends ProjectionScope {
  readonly syncStatus: ProjectionSyncStatus;
  readonly latestIndexedBlock?: bigint;
  readonly finalizedBlock?: bigint;
  readonly confirmationDepth: number;
  readonly lastEventName?: string;
  readonly eventCount: number;
  readonly rebuild?: ProjectionRebuildMetadata;
  readonly degradedReason?: string;
  readonly updatedAt: string;
}

export interface ProjectionRebuildInput {
  readonly deploymentBlock: bigint;
  readonly events: readonly ChainEvent[];
  readonly scope?: ProjectionScope;
  readonly syncState?: Omit<ProjectionSyncState, "updatedAt">;
}

export interface ProjectionScope {
  readonly chainId: number;
  readonly contractAddress: Address;
}

export interface StoredProjectionCursor extends ProjectionScope {
  readonly deploymentBlock: bigint;
  readonly nextBlock: bigint;
  readonly finalizedBlock?: bigint;
  readonly updatedAt: string;
}

export type ProjectionSnapshotKind = "order" | "trust";

export interface StoredProjectionSnapshot<TSnapshot> extends ProjectionScope {
  readonly kind: ProjectionSnapshotKind;
  readonly version: number;
  readonly snapshot: TSnapshot;
  readonly updatedAt: string;
}

export interface ProjectionStore {
  resetFromEvents(input: ProjectionRebuildInput): Promise<ProjectionSnapshot>;
  getOrderSnapshot?(): Promise<ProjectionSnapshot>;
  saveSyncState(state: Omit<ProjectionSyncState, "updatedAt">): Promise<ProjectionSyncState>;
  getSyncState(scope?: Partial<ProjectionScope>): Promise<ProjectionSyncState | undefined>;
  listOrders(): Promise<readonly OrderProjection[]>;
  getOrder(orderId: string): Promise<OrderProjection | undefined>;
  listStateMachineOrders(): Promise<readonly StateMachineOrderProjection[]>;
  getStateMachineOrder(orderId: string): Promise<StateMachineOrderProjection | undefined>;
  findStateMachineOrdersByOrderId(orderId: string): Promise<readonly StateMachineOrderProjection[]>;
  listStateMachineTasks(): Promise<readonly StateMachineTaskProjection[]>;
  getStateMachineTask(taskId: string): Promise<StateMachineTaskProjection | undefined>;
  listTrustDomains(): Promise<readonly TrustDomainProjection[]>;
  listPlanTrust(query: PlanTrustQuery): Promise<readonly PlanTrustProjection[]>;
  listSupplierTrust(query: SupplierTrustQuery): Promise<readonly SupplierTrustProjection[]>;
  getTrustSnapshot(): Promise<TrustProjectionSnapshot>;
}

export interface DurableProjectionStore extends ProjectionStore, StorageAdapterLifecycle, TransactionalStorage {
  saveCursor(cursor: Omit<StoredProjectionCursor, "updatedAt">): Promise<StoredProjectionCursor>;
  getCursor(scope: ProjectionScope): Promise<StoredProjectionCursor | undefined>;
  appendEvent(event: ChainEvent): Promise<void>;
  listEvents(scope: Partial<ProjectionScope>): Promise<readonly ChainEvent[]>;
  saveSnapshot<TSnapshot>(
    scope: ProjectionScope,
    kind: ProjectionSnapshotKind,
    snapshot: TSnapshot,
    version?: number
  ): Promise<StoredProjectionSnapshot<TSnapshot>>;
  getSnapshot<TSnapshot>(
    scope: ProjectionScope,
    kind: ProjectionSnapshotKind
  ): Promise<StoredProjectionSnapshot<TSnapshot> | undefined>;
}

export class MemoryProjectionStore implements ProjectionStore {
  #snapshot: ProjectionSnapshot = createEmptyProjectionSnapshot();
  #trustSnapshot: TrustProjectionSnapshot = createEmptyTrustProjectionSnapshot();
  #syncState: ProjectionSyncState | undefined;

  async resetFromEvents(input: ProjectionRebuildInput): Promise<ProjectionSnapshot> {
    const events = input.events.filter((event) => event.blockNumber >= input.deploymentBlock);
    this.#snapshot = rebuildOrderProjections(events);
    this.#trustSnapshot = rebuildTrustProjections(events);
    this.#syncState = syncStateFromRebuildInput(input, events);
    return this.#snapshot;
  }

  async getOrderSnapshot(): Promise<ProjectionSnapshot> {
    return this.#snapshot;
  }

  async saveSyncState(state: Omit<ProjectionSyncState, "updatedAt">): Promise<ProjectionSyncState> {
    this.#syncState = {
      ...state,
      updatedAt: new Date().toISOString()
    };
    return this.#syncState;
  }

  async getSyncState(_scope: Partial<ProjectionScope> = {}): Promise<ProjectionSyncState | undefined> {
    return this.#syncState;
  }

  async listOrders(): Promise<readonly OrderProjection[]> {
    return Object.values(this.#snapshot.orders);
  }

  async getOrder(orderId: string): Promise<OrderProjection | undefined> {
    return this.#snapshot.orders[orderId];
  }

  async listStateMachineOrders(): Promise<readonly StateMachineOrderProjection[]> {
    return Object.values(this.#snapshot.stateMachineOrders);
  }

  async getStateMachineOrder(orderId: string): Promise<StateMachineOrderProjection | undefined> {
    return this.#snapshot.stateMachineOrders[orderId.toLowerCase()] ?? this.#snapshot.stateMachineOrders[orderId] ??
      uniqueOrderByBareId(Object.values(this.#snapshot.stateMachineOrders), orderId);
  }

  async findStateMachineOrdersByOrderId(orderId: string): Promise<readonly StateMachineOrderProjection[]> {
    return Object.values(this.#snapshot.stateMachineOrders).filter((order) => order.orderId.toLowerCase() === orderId.toLowerCase());
  }

  async listStateMachineTasks(): Promise<readonly StateMachineTaskProjection[]> {
    return Object.values(this.#snapshot.stateMachineTasks);
  }

  async getStateMachineTask(taskId: string): Promise<StateMachineTaskProjection | undefined> {
    return this.#snapshot.stateMachineTasks[taskId];
  }

  async listTrustDomains(): Promise<readonly TrustDomainProjection[]> {
    return Object.values(this.#trustSnapshot.domains);
  }

  async listPlanTrust(query: PlanTrustQuery): Promise<readonly PlanTrustProjection[]> {
    return filterPlanTrust(this.#trustSnapshot, query);
  }

  async listSupplierTrust(query: SupplierTrustQuery): Promise<readonly SupplierTrustProjection[]> {
    return filterSupplierTrust(this.#trustSnapshot, query);
  }

  async getTrustSnapshot(): Promise<TrustProjectionSnapshot> {
    return this.#trustSnapshot;
  }
}

export function defaultProjectionScope(chainId: number): ProjectionScope {
  return {
    chainId,
    contractAddress: projectionScopeContractAddress
  };
}

export function syncStateFromRebuildInput(
  input: ProjectionRebuildInput,
  events: readonly ChainEvent[]
): ProjectionSyncState {
  const activeEvents = filterActiveChainEvents(events);
  const sortedEvents = sortChainEvents(activeEvents);
  const lastEvent = sortedEvents.at(-1);
  const latestIndexedBlock = latestBlockNumber(activeEvents);
  const scope = input.scope ?? {
    chainId: lastEvent?.chainId ?? input.syncState?.chainId ?? 0,
    contractAddress: input.syncState?.contractAddress ?? projectionScopeContractAddress
  };
  const base = input.syncState;

  return {
    chainId: scope.chainId,
    contractAddress: scope.contractAddress,
    syncStatus: base?.syncStatus ?? "indexed",
    ...(latestIndexedBlock !== undefined ? { latestIndexedBlock } : {}),
    ...(base?.finalizedBlock !== undefined ? { finalizedBlock: base.finalizedBlock } : {}),
    confirmationDepth: base?.confirmationDepth ?? 0,
    ...(lastEvent ? { lastEventName: lastEvent.eventName } : base?.lastEventName ? { lastEventName: base.lastEventName } : {}),
    eventCount: base?.eventCount ?? activeEvents.length,
    ...(base?.rebuild ? { rebuild: base.rebuild } : {}),
    ...(base?.degradedReason ? { degradedReason: base.degradedReason } : {}),
    updatedAt: new Date().toISOString()
  };
}

function latestBlockNumber(events: readonly ChainEvent[]): bigint | undefined {
  return events.reduce<bigint | undefined>(
    (latest, event) => latest === undefined || event.blockNumber > latest ? event.blockNumber : latest,
    undefined
  );
}

function uniqueOrderByBareId(
  orders: readonly StateMachineOrderProjection[],
  orderId: string
): StateMachineOrderProjection | undefined {
  const matches = orders.filter((order) => order.orderId.toLowerCase() === orderId.toLowerCase());
  return matches.length === 1 ? matches[0] : undefined;
}
