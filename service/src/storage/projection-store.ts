import type { ChainEvent } from "../indexer/events.js";
import { filterActiveChainEvents, sortChainEvents } from "../indexer/events.js";
import {
  createEmptyProjectionSnapshot,
  rebuildOrderProjections,
  type OrderProjection,
  type ProjectionSnapshot,
  type StateMachineOrderProjection,
  type StateMachineTaskProjection,
} from "../indexer/projections.js";
import {
  createEmptyIdentityProjectionSnapshot,
  filterIdentityBindings,
  rebuildIdentityProjections,
  type IdentityBindingProjection,
  type IdentityBindingQuery,
  type IdentityProjectionSnapshot,
} from "../indexer/identity-projections.js";
import type { Address, Hex } from "../shared/types.js";
import type { StorageAdapterLifecycle, TransactionalStorage } from "./types.js";

export const projectionScopeContractAddress =
  "0x0000000000000000000000000000000000000000" as const;

export type ProjectionSyncStatus =
  | "indexed"
  | "syncing"
  | "stale"
  | "rebuilding"
  | "degraded";
export type ProjectionRebuildStatus =
  | "idle"
  | "running"
  | "completed"
  | "failed";

export interface ProjectionRebuildMetadata {
  readonly status: ProjectionRebuildStatus;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly deploymentBlock?: bigint;
  readonly fromBlock?: bigint;
  readonly toBlock?: bigint;
  readonly eventCount?: number;
  readonly activeEventCount?: number;
  readonly removedEventCount?: number;
  readonly removedLogsFiltered?: boolean;
  readonly projectionRebuilt?: boolean;
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
  /** ETH-02：nextBlock - 1 高度区块哈希，用于追加前的哈希连续性校验。 */
  readonly blockHash?: Hex;
  readonly updatedAt: string;
}

export type ProjectionSnapshotKind = "order" | "identity";

/**
 * Post-commit steps（信号通知 / 投影自动化）在投影与 cursor 落库之后执行；
 * 处理失败且进程内重试耗尽时必须持久化，否则 cursor 已前进、增量永不再
 * 处理，通知永久丢失。后台 sweep 持续补投直至成功或人工干预。
 */
export type PendingPostCommitKind = "signal_notification" | "projection_automation";

export interface PendingPostCommitStep {
  readonly stepId: string;
  readonly chainId: number;
  readonly kind: PendingPostCommitKind;
  /** signal_notification：处理失败的那批链上事件（回放补投的载荷）。 */
  readonly events?: readonly ChainEvent[];
  readonly attempts: number;
  readonly lastError?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SavePendingPostCommitStepInput {
  readonly stepId: string;
  readonly chainId: number;
  readonly kind: PendingPostCommitKind;
  readonly events?: readonly ChainEvent[];
}

export interface StoredProjectionSnapshot<TSnapshot> extends ProjectionScope {
  readonly kind: ProjectionSnapshotKind;
  readonly version: number;
  readonly snapshot: TSnapshot;
  readonly updatedAt: string;
}

export interface ProjectionStore {
  resetFromEvents(input: ProjectionRebuildInput): Promise<ProjectionSnapshot>;
  getOrderSnapshot(): Promise<ProjectionSnapshot>;
  saveSyncState(
    state: Omit<ProjectionSyncState, "updatedAt">,
  ): Promise<ProjectionSyncState>;
  getSyncState(
    scope?: Partial<ProjectionScope>,
  ): Promise<ProjectionSyncState | undefined>;
  listOrders(): Promise<readonly OrderProjection[]>;
  getOrder(orderId: string): Promise<OrderProjection | undefined>;
  listStateMachineOrders(): Promise<readonly StateMachineOrderProjection[]>;
  /**
   * 订单身份是 (planId, orderId) 复合键。调用方持有 planId 时必须传入：
   * 同号订单跨 plan 复用时裸 orderId 查询按"唯一才返回"处理，多命中即
   * undefined（fail-closed），绝不猜第一个。
   */
  getStateMachineOrder(
    orderId: string,
    planId?: string,
  ): Promise<StateMachineOrderProjection | undefined>;
  findStateMachineOrdersByOrderId(
    orderId: string,
  ): Promise<readonly StateMachineOrderProjection[]>;
  listStateMachineTasks(): Promise<readonly StateMachineTaskProjection[]>;
  getStateMachineTask(
    taskId: string,
  ): Promise<StateMachineTaskProjection | undefined>;
  listIdentityBindings(
    query: IdentityBindingQuery,
  ): Promise<readonly IdentityBindingProjection[]>;
  getIdentitySnapshot(): Promise<IdentityProjectionSnapshot>;
}

export interface DurableProjectionStore
  extends ProjectionStore,
    StorageAdapterLifecycle,
    TransactionalStorage {
  saveCursor(
    cursor: Omit<StoredProjectionCursor, "updatedAt">,
  ): Promise<StoredProjectionCursor>;
  getCursor(
    scope: ProjectionScope,
  ): Promise<StoredProjectionCursor | undefined>;
  appendEvent(event: ChainEvent): Promise<void>;
  listEvents(scope: Partial<ProjectionScope>): Promise<readonly ChainEvent[]>;
  /**
   * ETH-02：删除 blockNumber > block 的已投影事件（reorg 回滚），
   * 返回删除行数。调用方随后必须从剩余事件重建快照并回退 cursor。
   * chainId 必填：无链范围的整库删除会跨链误删。
   */
  deleteEventsAfterBlock(
    scope: { readonly chainId: number; readonly contractAddress?: Address },
    blockNumber: bigint,
  ): Promise<number>;
  saveSnapshot<TSnapshot>(
    scope: ProjectionScope,
    kind: ProjectionSnapshotKind,
    snapshot: TSnapshot,
    version?: number,
  ): Promise<StoredProjectionSnapshot<TSnapshot>>;
  getSnapshot<TSnapshot>(
    scope: ProjectionScope,
    kind: ProjectionSnapshotKind,
  ): Promise<StoredProjectionSnapshot<TSnapshot> | undefined>;
  /**
   * ETH-04：post-commit 步骤失败后的持久补投队列。游标在通知处理前已
   * 保存，失败批次必须落表由后台 sweep 补投，而不是静默丢弃。
   */
  savePendingPostCommitStep(input: SavePendingPostCommitStepInput): Promise<PendingPostCommitStep>;
  listPendingPostCommitSteps(scope: { readonly chainId: number }): Promise<readonly PendingPostCommitStep[]>;
  recordPendingPostCommitAttempt(stepId: string, error: string): Promise<void>;
  deletePendingPostCommitStep(stepId: string): Promise<void>;
}

export class MemoryProjectionStore implements ProjectionStore {
  #snapshot: ProjectionSnapshot = createEmptyProjectionSnapshot();
  #identitySnapshot: IdentityProjectionSnapshot =
    createEmptyIdentityProjectionSnapshot();
  #syncState: ProjectionSyncState | undefined;

  async resetFromEvents(
    input: ProjectionRebuildInput,
  ): Promise<ProjectionSnapshot> {
    const events = input.events.filter(
      (event) => event.blockNumber >= input.deploymentBlock,
    );
    this.#snapshot = rebuildOrderProjections(events);
    this.#identitySnapshot = rebuildIdentityProjections(events);
    this.#syncState = syncStateFromRebuildInput(input, events);
    return this.#snapshot;
  }

  async getOrderSnapshot(): Promise<ProjectionSnapshot> {
    return this.#snapshot;
  }

  async saveSyncState(
    state: Omit<ProjectionSyncState, "updatedAt">,
  ): Promise<ProjectionSyncState> {
    this.#syncState = {
      ...state,
      updatedAt: new Date().toISOString(),
    };
    return this.#syncState;
  }

  async getSyncState(
    _scope: Partial<ProjectionScope> = {},
  ): Promise<ProjectionSyncState | undefined> {
    return this.#syncState;
  }

  async listOrders(): Promise<readonly OrderProjection[]> {
    return Object.values(this.#snapshot.orders);
  }

  async getOrder(orderId: string): Promise<OrderProjection | undefined> {
    return this.#snapshot.orders[orderId];
  }

  async listStateMachineOrders(): Promise<
    readonly StateMachineOrderProjection[]
  > {
    return uniqueProjectionValues(this.#snapshot.stateMachineOrders);
  }

  async getStateMachineOrder(
    orderId: string,
    planId?: string,
  ): Promise<StateMachineOrderProjection | undefined> {
    const orders = uniqueProjectionValues(this.#snapshot.stateMachineOrders);
    if (planId) {
      // 订单身份是 (planId, orderId)：带 planId 的查询只匹配同 plan 投影，
      // 不做裸键回退，跨 plan 复用同号订单时绝不串单。
      return uniqueOrderByBareId(orders, orderId, planId);
    }
    return (
      this.#snapshot.stateMachineOrders[orderId.toLowerCase()] ??
      this.#snapshot.stateMachineOrders[orderId] ??
      uniqueOrderByBareId(orders, orderId)
    );
  }

  async findStateMachineOrdersByOrderId(
    orderId: string,
  ): Promise<readonly StateMachineOrderProjection[]> {
    return uniqueProjectionValues(this.#snapshot.stateMachineOrders).filter(
      (order) => order.orderId.toLowerCase() === orderId.toLowerCase(),
    );
  }

  async listStateMachineTasks(): Promise<
    readonly StateMachineTaskProjection[]
  > {
    return uniqueProjectionValues(this.#snapshot.stateMachineTasks);
  }

  async getStateMachineTask(
    taskId: string,
  ): Promise<StateMachineTaskProjection | undefined> {
    const normalizedTaskId = taskId.toLowerCase();
    return (
      this.#snapshot.stateMachineTasks[normalizedTaskId] ??
      this.#snapshot.stateMachineTasks[taskId] ??
      uniqueTaskByBareId(uniqueProjectionValues(this.#snapshot.stateMachineTasks), taskId)
    );
  }

  async listIdentityBindings(
    query: IdentityBindingQuery,
  ): Promise<readonly IdentityBindingProjection[]> {
    return filterIdentityBindings(this.#identitySnapshot, query);
  }

  async getIdentitySnapshot(): Promise<IdentityProjectionSnapshot> {
    return this.#identitySnapshot;
  }
}

export function defaultProjectionScope(chainId: number): ProjectionScope {
  return {
    chainId,
    contractAddress: projectionScopeContractAddress,
  };
}

export function syncStateFromRebuildInput(
  input: ProjectionRebuildInput,
  events: readonly ChainEvent[],
): ProjectionSyncState {
  const activeEvents = filterActiveChainEvents(events);
  const sortedEvents = sortChainEvents(activeEvents);
  const lastEvent = sortedEvents.at(-1);
  const latestIndexedBlock = latestBlockNumber(activeEvents);
  const scope = input.scope ?? {
    chainId: lastEvent?.chainId ?? input.syncState?.chainId ?? 0,
    contractAddress:
      input.syncState?.contractAddress ?? projectionScopeContractAddress,
  };
  const base = input.syncState;

  return {
    chainId: scope.chainId,
    contractAddress: scope.contractAddress,
    syncStatus: base?.syncStatus ?? "indexed",
    ...(latestIndexedBlock !== undefined ? { latestIndexedBlock } : {}),
    ...(base?.finalizedBlock !== undefined
      ? { finalizedBlock: base.finalizedBlock }
      : {}),
    confirmationDepth: base?.confirmationDepth ?? 0,
    ...(lastEvent
      ? { lastEventName: lastEvent.eventName }
      : base?.lastEventName
        ? { lastEventName: base.lastEventName }
        : {}),
    eventCount: base?.eventCount ?? activeEvents.length,
    ...(base?.rebuild ? { rebuild: base.rebuild } : {}),
    ...(base?.degradedReason ? { degradedReason: base.degradedReason } : {}),
    updatedAt: new Date().toISOString(),
  };
}

function latestBlockNumber(events: readonly ChainEvent[]): bigint | undefined {
  return events.reduce<bigint | undefined>(
    (latest, event) =>
      latest === undefined || event.blockNumber > latest
        ? event.blockNumber
        : latest,
    undefined,
  );
}

function uniqueOrderByBareId(
  orders: readonly StateMachineOrderProjection[],
  orderId: string,
  planId?: string,
): StateMachineOrderProjection | undefined {
  const matches = orders.filter(
    (order) =>
      order.orderId.toLowerCase() === orderId.toLowerCase() &&
      (!planId || order.planId.toLowerCase() === planId.toLowerCase()),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function uniqueTaskByBareId(
  tasks: readonly StateMachineTaskProjection[],
  taskId: string,
): StateMachineTaskProjection | undefined {
  const normalizedTaskId = taskId.toLowerCase();
  const matches = tasks.filter((task) => task.taskId.toLowerCase() === normalizedTaskId);
  return matches.length === 1 ? matches[0] : undefined;
}

function uniqueProjectionValues<TValue>(record: Readonly<Record<string, TValue>>): TValue[] {
  return [...new Set(Object.values(record))];
}
