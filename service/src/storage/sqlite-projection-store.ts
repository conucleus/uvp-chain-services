import {
  chainEventKey,
  sortChainEvents,
  type ChainEvent,
} from "../indexer/events.js";
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
import { normalizeAddress, type Address, type Hex } from "../shared/types.js";
import { parseStorageJson, stringifyStorageJson } from "./json.js";
import { runSqliteMigrations } from "./migrations.js";
import {
  projectionScopeContractAddress,
  syncStateFromRebuildInput,
} from "./projection-store.js";
import type {
  DurableProjectionStore,
  PendingPostCommitKind,
  PendingPostCommitStep,
  ProjectionRebuildInput,
  ProjectionScope,
  ProjectionSyncState,
  ProjectionSnapshotKind,
  SavePendingPostCommitStepInput,
  StoredProjectionCursor,
  StoredProjectionSnapshot,
} from "./projection-store.js";
import {
  openSqliteDatabase,
  runSqliteWrite,
  withSqliteTransaction,
  type SqliteDatabase,
  type SqliteValue,
} from "./sqlite.js";
import { optionalNumberColumn } from "./sqlite-rows.js";

export interface SqliteProjectionStoreOptions {
  readonly databaseUrl: string;
  readonly chainId?: number;
  readonly projectionScopeContractAddress?: Address;
  readonly migrations?: {
    readonly autoRun?: boolean;
    readonly directory?: string;
  };
}

export class SqliteProjectionStore implements DurableProjectionStore {
  readonly driver = "sqlite" as const;

  readonly #database: SqliteDatabase;
  #snapshotScope: ProjectionScope;

  constructor(options: SqliteProjectionStoreOptions) {
    this.#database = openSqliteDatabase(options.databaseUrl);
    this.#snapshotScope = {
      chainId: options.chainId ?? 0,
      contractAddress:
        options.projectionScopeContractAddress ??
        projectionScopeContractAddress,
    };
    if (options.migrations?.autoRun === true) {
      runSqliteMigrations({
        database: this.#database,
        ...(options.migrations.directory
          ? { migrationsDirectory: options.migrations.directory }
          : {}),
      });
    }
  }

  async close(): Promise<void> {
    this.#database.close();
  }

  async withTransaction<T>(operation: () => Promise<T>): Promise<T> {
    return withSqliteTransaction(this.#database, operation);
  }

  async resetFromEvents(
    input: ProjectionRebuildInput,
  ): Promise<ProjectionSnapshot> {
    const events = input.events.filter(
      (event) => event.blockNumber >= input.deploymentBlock,
    );
    const orderSnapshot = rebuildOrderProjections(events);
    const identitySnapshot = rebuildIdentityProjections(events);
    const scope = input.scope ?? this.#scopeFromEvents(events);
    const syncState = syncStateFromRebuildInput({ ...input, scope }, events);

    await this.withTransaction(async () => {
      runSqliteWrite(() => {
        this.#database
          .prepare("DELETE FROM chain_event_log WHERE chain_id = ?")
          .run(scope.chainId);
      });
      for (const event of events) {
        await this.appendEvent(event);
      }
      await this.saveSnapshot(scope, "order", orderSnapshot);
      await this.saveSnapshot(scope, "identity", identitySnapshot);
      await this.saveSyncState(
        input.syncState
          ? {
              ...input.syncState,
              chainId: scope.chainId,
              contractAddress: scope.contractAddress,
            }
          : {
              chainId: syncState.chainId,
              contractAddress: syncState.contractAddress,
              syncStatus: syncState.syncStatus,
              ...(syncState.latestIndexedBlock !== undefined
                ? { latestIndexedBlock: syncState.latestIndexedBlock }
                : {}),
              ...(syncState.finalizedBlock !== undefined
                ? { finalizedBlock: syncState.finalizedBlock }
                : {}),
              confirmationDepth: syncState.confirmationDepth,
              ...(syncState.lastEventName
                ? { lastEventName: syncState.lastEventName }
                : {}),
              eventCount: syncState.eventCount,
              ...(syncState.rebuild ? { rebuild: syncState.rebuild } : {}),
              ...(syncState.degradedReason
                ? { degradedReason: syncState.degradedReason }
                : {}),
            },
      );
    });

    this.#snapshotScope = scope;
    return orderSnapshot;
  }

  async getOrderSnapshot(): Promise<ProjectionSnapshot> {
    return this.#currentOrderSnapshot();
  }

  async saveSyncState(
    state: Omit<ProjectionSyncState, "updatedAt">,
  ): Promise<ProjectionSyncState> {
    const updatedAt = new Date().toISOString();
    const normalizedContract = normalizeAddress(
      state.contractAddress,
      "syncState.contractAddress",
    );
    runSqliteWrite(() => {
      this.#database
        .prepare(
          `INSERT INTO chain_projection_sync_state (
           chain_id, contract_address, sync_status, latest_indexed_block, finalized_block,
           confirmation_depth, last_event_name, event_count, rebuild_json, degraded_reason, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(chain_id, contract_address)
         DO UPDATE SET
           sync_status = excluded.sync_status,
           latest_indexed_block = excluded.latest_indexed_block,
           finalized_block = excluded.finalized_block,
           confirmation_depth = excluded.confirmation_depth,
           last_event_name = excluded.last_event_name,
           event_count = excluded.event_count,
           rebuild_json = excluded.rebuild_json,
           degraded_reason = excluded.degraded_reason,
           updated_at = excluded.updated_at`,
        )
        .run(
          state.chainId,
          normalizedContract,
          state.syncStatus,
          state.latestIndexedBlock?.toString() ?? null,
          state.finalizedBlock?.toString() ?? null,
          state.confirmationDepth,
          state.lastEventName ?? null,
          state.eventCount,
          state.rebuild ? stringifyStorageJson(state.rebuild) : null,
          state.degradedReason ?? null,
          updatedAt,
        );
    });

    return {
      ...state,
      contractAddress: normalizedContract,
      updatedAt,
    };
  }

  async getSyncState(
    scope: Partial<ProjectionScope> = {},
  ): Promise<ProjectionSyncState | undefined> {
    const chainId = scope.chainId ?? this.#snapshotScope.chainId;
    const contractAddress = normalizeAddress(
      scope.contractAddress ?? this.#snapshotScope.contractAddress,
      "syncState.contractAddress",
    );
    const row = this.#database
      .prepare(
        `SELECT
         chain_id AS chainId,
         contract_address AS contractAddress,
         sync_status AS syncStatus,
         latest_indexed_block AS latestIndexedBlock,
         finalized_block AS finalizedBlock,
         confirmation_depth AS confirmationDepth,
         last_event_name AS lastEventName,
         event_count AS eventCount,
         rebuild_json AS rebuildJson,
         degraded_reason AS degradedReason,
         updated_at AS updatedAt
       FROM chain_projection_sync_state
       WHERE chain_id = ? AND contract_address = ?`,
      )
      .get(chainId, contractAddress);
    return row ? syncStateRow(row) : undefined;
  }

  async saveCursor(
    cursor: Omit<StoredProjectionCursor, "updatedAt">,
  ): Promise<StoredProjectionCursor> {
    const updatedAt = new Date().toISOString();
    const normalizedContract = normalizeAddress(
      cursor.contractAddress,
      "cursor.contractAddress",
    );
    runSqliteWrite(() => {
      this.#database
        .prepare(
          `INSERT INTO chain_index_cursor (
           chain_id, contract_address, deployment_block, next_block, finalized_block, block_hash, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(chain_id, contract_address)
         DO UPDATE SET
           deployment_block = excluded.deployment_block,
           next_block = excluded.next_block,
           finalized_block = excluded.finalized_block,
           block_hash = excluded.block_hash,
           updated_at = excluded.updated_at`,
        )
        .run(
          cursor.chainId,
          normalizedContract,
          cursor.deploymentBlock.toString(),
          cursor.nextBlock.toString(),
          cursor.finalizedBlock?.toString() ?? null,
          cursor.blockHash?.toLowerCase() ?? null,
          updatedAt,
        );
    });

    return {
      chainId: cursor.chainId,
      contractAddress: normalizedContract,
      deploymentBlock: cursor.deploymentBlock,
      nextBlock: cursor.nextBlock,
      ...(cursor.finalizedBlock !== undefined
        ? { finalizedBlock: cursor.finalizedBlock }
        : {}),
      ...(cursor.blockHash !== undefined ? { blockHash: cursor.blockHash } : {}),
      updatedAt,
    };
  }

  async getCursor(
    scope: ProjectionScope,
  ): Promise<StoredProjectionCursor | undefined> {
    const row = this.#database
      .prepare(
        `SELECT
         chain_id AS chainId,
         contract_address AS contractAddress,
         deployment_block AS deploymentBlock,
         next_block AS nextBlock,
         finalized_block AS finalizedBlock,
         block_hash AS blockHash,
         updated_at AS updatedAt
       FROM chain_index_cursor
       WHERE chain_id = ? AND contract_address = ?`,
      )
      .get(
        scope.chainId,
        normalizeAddress(scope.contractAddress, "cursor.contractAddress"),
      );
    return row ? cursorRow(row) : undefined;
  }

  async deleteEventsAfterBlock(
    scope: { readonly chainId: number; readonly contractAddress?: Address },
    blockNumber: bigint,
  ): Promise<number> {
    // chainId 必填：无链范围的删除会跨链误删其他链的已投影事件。
    const clauses: string[] = ["CAST(block_number AS INTEGER) > ?", "chain_id = ?"];
    const values: SqliteValue[] = [blockNumber.toString(), scope.chainId];
    if (scope.contractAddress) {
      clauses.push("contract_address = ?");
      values.push(
        normalizeAddress(scope.contractAddress, "event.contractAddress"),
      );
    }
    return runSqliteWrite(() => {
      const result = this.#database
        .prepare(`DELETE FROM chain_event_log WHERE ${clauses.join(" AND ")}`)
        .run(...values);
      return result.changes;
    });
  }

  async savePendingPostCommitStep(
    input: SavePendingPostCommitStepInput,
  ): Promise<PendingPostCommitStep> {
    const now = new Date().toISOString();
    runSqliteWrite(() => {
      this.#database
        .prepare(
          `INSERT INTO indexer_pending_post_commit (
           step_id, chain_id, kind, events_json, attempts, last_error, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 0, NULL, ?, ?)
         ON CONFLICT(step_id) DO NOTHING`,
        )
        .run(
          input.stepId,
          input.chainId,
          input.kind,
          input.events ? stringifyStorageJson(input.events) : null,
          now,
          now,
        );
    });
    const saved = await this.#pendingStepRow(input.stepId);
    if (!saved) {
      throw new Error("sqlite pending post-commit step disappeared after save");
    }
    return saved;
  }

  async listPendingPostCommitSteps(
    scope: { readonly chainId: number },
  ): Promise<readonly PendingPostCommitStep[]> {
    const rows = this.#database
      .prepare(
        `SELECT step_id AS stepId, chain_id AS chainId, kind, events_json AS eventsJson,
           attempts, last_error AS lastError, created_at AS createdAt, updated_at AS updatedAt
         FROM indexer_pending_post_commit
         WHERE chain_id = ?
         ORDER BY created_at ASC, step_id ASC`,
      )
      .all(scope.chainId);
    return rows.map((row) => pendingPostCommitRow(row));
  }

  async recordPendingPostCommitAttempt(stepId: string, error: string): Promise<void> {
    const updatedAt = new Date().toISOString();
    runSqliteWrite(() => {
      this.#database
        .prepare(
          `UPDATE indexer_pending_post_commit
         SET attempts = attempts + 1, last_error = ?, updated_at = ?
         WHERE step_id = ?`,
        )
        .run(error, updatedAt, stepId);
    });
  }

  async deletePendingPostCommitStep(stepId: string): Promise<void> {
    runSqliteWrite(() => {
      this.#database
        .prepare("DELETE FROM indexer_pending_post_commit WHERE step_id = ?")
        .run(stepId);
    });
  }

  async #pendingStepRow(stepId: string): Promise<PendingPostCommitStep | undefined> {
    const row = this.#database
      .prepare(
        `SELECT step_id AS stepId, chain_id AS chainId, kind, events_json AS eventsJson,
           attempts, last_error AS lastError, created_at AS createdAt, updated_at AS updatedAt
         FROM indexer_pending_post_commit
         WHERE step_id = ?`,
      )
      .get(stepId);
    return row ? pendingPostCommitRow(row) : undefined;
  }

  async appendEvent(event: ChainEvent): Promise<void> {
    const normalizedContract = normalizeAddress(
      event.contractAddress,
      "event.contractAddress",
    );
    runSqliteWrite(() => {
      if (event.removed === true) {
        const eventId = chainEventKey({
          ...event,
          contractAddress: normalizedContract,
        });
        const result = this.#database
          .prepare(
            `UPDATE chain_event_log
           SET removed = 1, block_hash = COALESCE(?, block_hash)
           WHERE chain_id = ? AND contract_address = ? AND event_id = ?`,
          )
          .run(
            event.blockHash?.toLowerCase() ?? null,
            event.chainId,
            normalizedContract,
            eventId,
          );
        if (result.changes > 0) {
          return;
        }
      } else {
        // 复活：同主键（chain/contract/block/txHash/logIndex）的事件此前
        // 因 reorg 被打上 removed 墓碑，canonical 链重新出现同一位日志时
        // 必须解除墓碑；INSERT OR IGNORE 只会忽略主键冲突、保留 removed=1，
        // 导致复活事件被永久跳过。
        const revival = this.#database
          .prepare(
            `UPDATE chain_event_log
           SET removed = 0, event_name = ?, args_json = ?, block_hash = COALESCE(?, block_hash)
           WHERE chain_id = ? AND contract_address = ? AND block_number = ?
             AND transaction_hash = ? AND log_index = ? AND removed = 1`,
          )
          .run(
            event.eventName,
            stringifyStorageJson(event.args),
            event.blockHash?.toLowerCase() ?? null,
            event.chainId,
            normalizedContract,
            event.blockNumber.toString(),
            event.transactionHash.toLowerCase(),
            event.logIndex,
          );
        if (revival.changes > 0) {
          return;
        }
      }
      this.#database
        .prepare(
          `INSERT OR IGNORE INTO chain_event_log (
           chain_id, contract_address, block_number, transaction_hash, transaction_index, log_index,
           event_id, event_name, args_json, removed, block_hash, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          event.chainId,
          normalizedContract,
          event.blockNumber.toString(),
          event.transactionHash.toLowerCase(),
          event.transactionIndex ?? null,
          event.logIndex,
          chainEventKey({ ...event, contractAddress: normalizedContract }),
          event.eventName,
          stringifyStorageJson(event.args),
          event.removed === true ? 1 : 0,
          event.blockHash?.toLowerCase() ?? null,
          new Date().toISOString(),
        );
    });
  }

  async listEvents(
    scope: Partial<ProjectionScope> = {},
  ): Promise<readonly ChainEvent[]> {
    const clauses: string[] = [];
    const values: SqliteValue[] = [];
    if (scope.chainId !== undefined) {
      clauses.push("chain_id = ?");
      values.push(scope.chainId);
    }
    if (scope.contractAddress) {
      clauses.push("contract_address = ?");
      values.push(
        normalizeAddress(scope.contractAddress, "event.contractAddress"),
      );
    }

    const rows = this.#database
      .prepare(
        `SELECT
         chain_id AS chainId,
         contract_address AS contractAddress,
         block_number AS blockNumber,
         transaction_hash AS transactionHash,
         transaction_index AS transactionIndex,
         log_index AS logIndex,
         event_name AS eventName,
         args_json AS argsJson,
         removed,
         block_hash AS blockHash
       FROM chain_event_log
         ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
       ORDER BY chain_id ASC, CAST(block_number AS INTEGER) ASC,
         transaction_index IS NULL ASC, transaction_index ASC, log_index ASC`,
      )
      .all(...values);

    return sortChainEvents(rows.map((row) => eventRow(row)));
  }

  async saveSnapshot<TSnapshot>(
    scope: ProjectionScope,
    kind: ProjectionSnapshotKind,
    snapshot: TSnapshot,
    version = 1,
  ): Promise<StoredProjectionSnapshot<TSnapshot>> {
    const updatedAt = new Date().toISOString();
    const normalizedContract = normalizeAddress(
      scope.contractAddress,
      "snapshot.contractAddress",
    );
    runSqliteWrite(() => {
      this.#database
        .prepare(
          `INSERT INTO chain_projection_snapshot (
           chain_id, contract_address, snapshot_kind, snapshot_version, snapshot_json, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(chain_id, contract_address, snapshot_kind)
         DO UPDATE SET
           snapshot_version = excluded.snapshot_version,
           snapshot_json = excluded.snapshot_json,
           updated_at = excluded.updated_at`,
        )
        .run(
          scope.chainId,
          normalizedContract,
          kind,
          version,
          stringifyStorageJson(snapshot),
          updatedAt,
        );
    });

    return {
      chainId: scope.chainId,
      contractAddress: normalizedContract,
      kind,
      version,
      snapshot,
      updatedAt,
    };
  }

  async getSnapshot<TSnapshot>(
    scope: ProjectionScope,
    kind: ProjectionSnapshotKind,
  ): Promise<StoredProjectionSnapshot<TSnapshot> | undefined> {
    const row = this.#database
      .prepare(
        `SELECT
         chain_id AS chainId,
         contract_address AS contractAddress,
         snapshot_kind AS kind,
         snapshot_version AS version,
         snapshot_json AS snapshotJson,
         updated_at AS updatedAt
       FROM chain_projection_snapshot
       WHERE chain_id = ? AND contract_address = ? AND snapshot_kind = ?`,
      )
      .get(
        scope.chainId,
        normalizeAddress(scope.contractAddress, "snapshot.contractAddress"),
        kind,
      );
    return row ? snapshotRow<TSnapshot>(row) : undefined;
  }

  async listOrders(): Promise<readonly OrderProjection[]> {
    return Object.values((await this.#currentOrderSnapshot()).orders);
  }

  async getOrder(orderId: string): Promise<OrderProjection | undefined> {
    return (await this.#currentOrderSnapshot()).orders[orderId];
  }

  async listStateMachineOrders(): Promise<
    readonly StateMachineOrderProjection[]
  > {
    return uniqueProjectionValues(
      (await this.#currentOrderSnapshot()).stateMachineOrders,
    );
  }

  async getStateMachineOrder(
    orderId: string,
    planId?: string,
  ): Promise<StateMachineOrderProjection | undefined> {
    const snapshot = await this.#currentOrderSnapshot();
    const orders = uniqueProjectionValues(snapshot.stateMachineOrders);
    if (planId) {
      // 订单身份是 (planId, orderId)：带 planId 的查询只匹配同 plan 投影，
      // 不做裸键回退，跨 plan 复用同号订单时绝不串单。
      return uniqueOrderByBareId(orders, orderId, planId);
    }
    return (
      snapshot.stateMachineOrders[orderId.toLowerCase()] ??
      snapshot.stateMachineOrders[orderId] ??
      uniqueOrderByBareId(orders, orderId)
    );
  }

  async findStateMachineOrdersByOrderId(
    orderId: string,
  ): Promise<readonly StateMachineOrderProjection[]> {
    const snapshot = await this.#currentOrderSnapshot();
    return uniqueProjectionValues(snapshot.stateMachineOrders).filter(
      (order) => order.orderId.toLowerCase() === orderId.toLowerCase(),
    );
  }

  async listStateMachineTasks(): Promise<
    readonly StateMachineTaskProjection[]
  > {
    return uniqueProjectionValues(
      (await this.#currentOrderSnapshot()).stateMachineTasks,
    );
  }

  async getStateMachineTask(
    taskId: string,
  ): Promise<StateMachineTaskProjection | undefined> {
    const tasks = (await this.#currentOrderSnapshot()).stateMachineTasks;
    return (
      tasks[taskId.toLowerCase()] ??
      tasks[taskId] ??
      uniqueTaskByBareId(uniqueProjectionValues(tasks), taskId)
    );
  }

  async listIdentityBindings(
    query: IdentityBindingQuery,
  ): Promise<readonly IdentityBindingProjection[]> {
    return filterIdentityBindings(await this.getIdentitySnapshot(), query);
  }

  async getIdentitySnapshot(): Promise<IdentityProjectionSnapshot> {
    return (
      (
        await this.getSnapshot<IdentityProjectionSnapshot>(
          this.#snapshotScope,
          "identity",
        )
      )?.snapshot ?? createEmptyIdentityProjectionSnapshot()
    );
  }

  async #currentOrderSnapshot(): Promise<ProjectionSnapshot> {
    return (
      (await this.getSnapshot<ProjectionSnapshot>(this.#snapshotScope, "order"))
        ?.snapshot ?? createEmptyProjectionSnapshot()
    );
  }

  #scopeFromEvents(events: readonly ChainEvent[]): ProjectionScope {
    return {
      chainId: events[0]?.chainId ?? this.#snapshotScope.chainId,
      contractAddress: this.#snapshotScope.contractAddress,
    };
  }
}

function cursorRow(row: unknown): StoredProjectionCursor {
  const record = rowObject(row);
  const finalizedBlock = nullableStringColumn(record, "finalizedBlock");
  const blockHash = nullableStringColumn(record, "blockHash");
  return {
    chainId: numberColumn(record, "chainId"),
    contractAddress: normalizeAddress(
      stringColumn(record, "contractAddress"),
      "cursor.contractAddress",
    ),
    deploymentBlock: BigInt(stringColumn(record, "deploymentBlock")),
    nextBlock: BigInt(stringColumn(record, "nextBlock")),
    ...(finalizedBlock !== null
      ? { finalizedBlock: BigInt(finalizedBlock) }
      : {}),
    ...(blockHash !== null ? { blockHash: blockHash as Hex } : {}),
    updatedAt: stringColumn(record, "updatedAt"),
  };
}

function eventRow(row: unknown): ChainEvent {
  const record = rowObject(row);
  const blockHash = nullableStringColumn(record, "blockHash");
  const removed = numberColumn(record, "removed") === 1;
  const transactionIndex = optionalNumberColumn(record, "transactionIndex");
  return {
    chainId: numberColumn(record, "chainId"),
    contractAddress: normalizeAddress(
      stringColumn(record, "contractAddress"),
      "event.contractAddress",
    ),
    blockNumber: BigInt(stringColumn(record, "blockNumber")),
    transactionHash: stringColumn(record, "transactionHash") as Hex,
    ...(transactionIndex !== undefined ? { transactionIndex } : {}),
    logIndex: numberColumn(record, "logIndex"),
    eventName: stringColumn(record, "eventName"),
    args: parseStorageJson<Record<string, unknown>>(
      stringColumn(record, "argsJson"),
    ),
    ...(removed ? { removed } : {}),
    ...(blockHash !== null ? { blockHash: blockHash as Hex } : {}),
  };
}

function snapshotRow<TSnapshot>(
  row: unknown,
): StoredProjectionSnapshot<TSnapshot> {
  const record = rowObject(row);
  return {
    chainId: numberColumn(record, "chainId"),
    contractAddress: normalizeAddress(
      stringColumn(record, "contractAddress"),
      "snapshot.contractAddress",
    ),
    kind: snapshotKindColumn(record, "kind"),
    version: numberColumn(record, "version"),
    snapshot: parseStorageJson<TSnapshot>(stringColumn(record, "snapshotJson")),
    updatedAt: stringColumn(record, "updatedAt"),
  };
}

function pendingPostCommitRow(row: unknown): PendingPostCommitStep {
  const record = rowObject(row);
  const eventsJson = nullableStringColumn(record, "eventsJson");
  const lastError = nullableStringColumn(record, "lastError");
  return {
    stepId: stringColumn(record, "stepId"),
    chainId: numberColumn(record, "chainId"),
    kind: pendingPostCommitKindColumn(record, "kind"),
    ...(eventsJson !== null ? { events: parseStorageJson<readonly ChainEvent[]>(eventsJson) } : {}),
    attempts: numberColumn(record, "attempts"),
    ...(lastError !== null ? { lastError } : {}),
    createdAt: stringColumn(record, "createdAt"),
    updatedAt: stringColumn(record, "updatedAt"),
  };
}

function pendingPostCommitKindColumn(
  record: Record<string, unknown>,
  key: string,
): PendingPostCommitKind {
  const value = stringColumn(record, key);
  if (value !== "signal_notification" && value !== "projection_automation") {
    throw new Error(`SQLite column ${key} must be a known pending post-commit kind`);
  }
  return value;
}

function syncStateRow(row: unknown): ProjectionSyncState {
  const record = rowObject(row);
  const latestIndexedBlock = nullableStringColumn(record, "latestIndexedBlock");
  const finalizedBlock = nullableStringColumn(record, "finalizedBlock");
  const lastEventName = nullableStringColumn(record, "lastEventName");
  const rebuildJson = nullableStringColumn(record, "rebuildJson");
  const degradedReason = nullableStringColumn(record, "degradedReason");
  const rebuild =
    rebuildJson !== null
      ? parseStorageJson<NonNullable<ProjectionSyncState["rebuild"]>>(
          rebuildJson,
        )
      : undefined;
  return {
    chainId: numberColumn(record, "chainId"),
    contractAddress: normalizeAddress(
      stringColumn(record, "contractAddress"),
      "syncState.contractAddress",
    ),
    syncStatus: syncStatusColumn(record, "syncStatus"),
    ...(latestIndexedBlock !== null
      ? { latestIndexedBlock: BigInt(latestIndexedBlock) }
      : {}),
    ...(finalizedBlock !== null
      ? { finalizedBlock: BigInt(finalizedBlock) }
      : {}),
    confirmationDepth: numberColumn(record, "confirmationDepth"),
    ...(lastEventName !== null ? { lastEventName } : {}),
    eventCount: numberColumn(record, "eventCount"),
    ...(rebuild ? { rebuild } : {}),
    ...(degradedReason !== null ? { degradedReason } : {}),
    updatedAt: stringColumn(record, "updatedAt"),
  };
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

function rowObject(row: unknown): Record<string, unknown> {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new Error("SQLite query returned a malformed row");
  }
  return row as Record<string, unknown>;
}

function stringColumn(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`SQLite column ${key} must be a string`);
  }
  return value;
}

function nullableStringColumn(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key];
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`SQLite column ${key} must be a string or null`);
  }
  return value;
}

function numberColumn(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number") {
    throw new Error(`SQLite column ${key} must be a number`);
  }
  return value;
}

function snapshotKindColumn(
  record: Record<string, unknown>,
  key: string,
): ProjectionSnapshotKind {
  const value = stringColumn(record, key);
  if (value !== "order" && value !== "identity") {
    throw new Error(
      `SQLite column ${key} must be a known projection snapshot kind`,
    );
  }
  return value;
}

function syncStatusColumn(
  record: Record<string, unknown>,
  key: string,
): ProjectionSyncState["syncStatus"] {
  const value = stringColumn(record, key);
  if (
    value !== "indexed" &&
    value !== "syncing" &&
    value !== "stale" &&
    value !== "rebuilding" &&
    value !== "degraded"
  ) {
    throw new Error(
      `SQLite column ${key} must be a known projection sync status`,
    );
  }
  return value;
}
