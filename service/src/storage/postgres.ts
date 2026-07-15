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
import { PostgresDatabase } from "./postgres-client.js";
import {
  booleanColumn,
  nullableStringColumn,
  numberColumn,
  rowObject,
  stringColumn,
} from "./postgres-rows.js";
import {
  projectionScopeContractAddress,
  syncStateFromRebuildInput,
} from "./projection-store.js";
import type {
  DurableProjectionStore,
  ProjectionRebuildInput,
  ProjectionScope,
  ProjectionSyncState,
  ProjectionSnapshotKind,
  StoredProjectionCursor,
  StoredProjectionSnapshot,
} from "./projection-store.js";

export interface PostgresProjectionStoreOptions {
  readonly databaseUrl?: string;
  readonly database?: PostgresDatabase;
  readonly chainId?: number;
  readonly projectionScopeContractAddress?: Address;
  readonly migrations?: {
    readonly autoRun?: boolean;
    readonly directory?: string;
  };
}

export class PostgresProjectionStore implements DurableProjectionStore {
  readonly driver = "postgres" as const;

  readonly #database: PostgresDatabase;
  readonly #ownsDatabase: boolean;
  #snapshotScope: ProjectionScope;

  constructor(options: PostgresProjectionStoreOptions) {
    if (!options.database && !options.databaseUrl) {
      throw new Error(
        "PostgresProjectionStore requires database or databaseUrl",
      );
    }
    this.#database =
      options.database ??
      new PostgresDatabase({
        databaseUrl: options.databaseUrl!,
        ...(options.migrations ? { migrations: options.migrations } : {}),
      });
    this.#ownsDatabase = !options.database;
    this.#snapshotScope = {
      chainId: options.chainId ?? 0,
      contractAddress:
        options.projectionScopeContractAddress ??
        projectionScopeContractAddress,
    };
  }

  async close(): Promise<void> {
    if (this.#ownsDatabase) {
      await this.#database.close();
    }
  }

  async withTransaction<T>(operation: () => Promise<T>): Promise<T> {
    return this.#database.withTransaction(operation);
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
      await this.#database.query(
        `DELETE FROM chain_event_log
         WHERE chain_id = $1`,
        [scope.chainId],
      );
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
    await this.#database.query(
      `INSERT INTO chain_projection_sync_state (
         chain_id, contract_address, sync_status, latest_indexed_block, finalized_block,
         confirmation_depth, last_event_name, event_count, rebuild_json, degraded_reason, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)
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
      [
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
      ],
    );

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
    const result = await this.#database.query(
      `SELECT
         chain_id AS "chainId",
         contract_address AS "contractAddress",
         sync_status AS "syncStatus",
         latest_indexed_block::text AS "latestIndexedBlock",
         finalized_block::text AS "finalizedBlock",
         confirmation_depth AS "confirmationDepth",
         last_event_name AS "lastEventName",
         event_count AS "eventCount",
         rebuild_json::text AS "rebuildJson",
         degraded_reason AS "degradedReason",
         updated_at AS "updatedAt"
       FROM chain_projection_sync_state
       WHERE chain_id = $1 AND contract_address = $2`,
      [chainId, contractAddress],
    );
    return result.rows[0] ? syncStateRow(result.rows[0]) : undefined;
  }

  async saveCursor(
    cursor: Omit<StoredProjectionCursor, "updatedAt">,
  ): Promise<StoredProjectionCursor> {
    const updatedAt = new Date().toISOString();
    const normalizedContract = normalizeAddress(
      cursor.contractAddress,
      "cursor.contractAddress",
    );
    await this.#database.query(
      `INSERT INTO chain_index_cursor (
         chain_id, contract_address, deployment_block, next_block, finalized_block, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT(chain_id, contract_address)
       DO UPDATE SET
         deployment_block = excluded.deployment_block,
         next_block = excluded.next_block,
         finalized_block = excluded.finalized_block,
         updated_at = excluded.updated_at`,
      [
        cursor.chainId,
        normalizedContract,
        cursor.deploymentBlock.toString(),
        cursor.nextBlock.toString(),
        cursor.finalizedBlock?.toString() ?? null,
        updatedAt,
      ],
    );

    return {
      chainId: cursor.chainId,
      contractAddress: normalizedContract,
      deploymentBlock: cursor.deploymentBlock,
      nextBlock: cursor.nextBlock,
      ...(cursor.finalizedBlock !== undefined
        ? { finalizedBlock: cursor.finalizedBlock }
        : {}),
      updatedAt,
    };
  }

  async getCursor(
    scope: ProjectionScope,
  ): Promise<StoredProjectionCursor | undefined> {
    const result = await this.#database.query(
      `SELECT
         chain_id AS "chainId",
         contract_address AS "contractAddress",
         deployment_block::text AS "deploymentBlock",
         next_block::text AS "nextBlock",
         finalized_block::text AS "finalizedBlock",
         updated_at AS "updatedAt"
       FROM chain_index_cursor
       WHERE chain_id = $1 AND contract_address = $2`,
      [
        scope.chainId,
        normalizeAddress(scope.contractAddress, "cursor.contractAddress"),
      ],
    );
    return result.rows[0] ? cursorRow(result.rows[0]) : undefined;
  }

  async appendEvent(event: ChainEvent): Promise<void> {
    const normalizedContract = normalizeAddress(
      event.contractAddress,
      "event.contractAddress",
    );
    if (event.removed === true) {
      const eventId = chainEventKey({
        ...event,
        contractAddress: normalizedContract,
      });
      const result = await this.#database.query(
        `UPDATE chain_event_log
         SET removed = TRUE, block_hash = COALESCE($1, block_hash)
         WHERE chain_id = $2 AND contract_address = $3 AND event_id = $4`,
        [
          event.blockHash?.toLowerCase() ?? null,
          event.chainId,
          normalizedContract,
          eventId,
        ],
      );
      if ((result.rowCount ?? 0) > 0) {
        return;
      }
    }

    await this.#database.query(
      `INSERT INTO chain_event_log (
         chain_id, contract_address, block_number, transaction_hash, log_index,
         event_id, event_name, args_json, removed, block_hash, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11)`,
      [
        event.chainId,
        normalizedContract,
        event.blockNumber.toString(),
        event.transactionHash.toLowerCase(),
        event.logIndex,
        chainEventKey({ ...event, contractAddress: normalizedContract }),
        event.eventName,
        stringifyStorageJson(event.args),
        event.removed === true,
        event.blockHash?.toLowerCase() ?? null,
        new Date().toISOString(),
      ],
    );
  }

  async listEvents(
    scope: Partial<ProjectionScope> = {},
  ): Promise<readonly ChainEvent[]> {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (scope.chainId !== undefined) {
      values.push(scope.chainId);
      clauses.push(`chain_id = $${values.length}`);
    }
    if (scope.contractAddress) {
      values.push(
        normalizeAddress(scope.contractAddress, "event.contractAddress"),
      );
      clauses.push(`contract_address = $${values.length}`);
    }

    const result = await this.#database.query(
      `SELECT
         chain_id AS "chainId",
         contract_address AS "contractAddress",
         block_number::text AS "blockNumber",
         transaction_hash AS "transactionHash",
         log_index AS "logIndex",
         event_name AS "eventName",
         args_json::text AS "argsJson",
         removed,
         block_hash AS "blockHash"
       FROM chain_event_log
       ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
       ORDER BY chain_id ASC, block_number ASC, log_index ASC`,
      values,
    );

    return sortChainEvents(result.rows.map((row) => eventRow(row)));
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
    await this.#database.query(
      `INSERT INTO chain_projection_snapshot (
         chain_id, contract_address, snapshot_kind, snapshot_version, snapshot_json, updated_at
       ) VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       ON CONFLICT(chain_id, contract_address, snapshot_kind)
       DO UPDATE SET
         snapshot_version = excluded.snapshot_version,
         snapshot_json = excluded.snapshot_json,
         updated_at = excluded.updated_at`,
      [
        scope.chainId,
        normalizedContract,
        kind,
        version,
        stringifyStorageJson(snapshot),
        updatedAt,
      ],
    );

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
    const result = await this.#database.query(
      `SELECT
         chain_id AS "chainId",
         contract_address AS "contractAddress",
         snapshot_kind AS kind,
         snapshot_version AS version,
         snapshot_json::text AS "snapshotJson",
         updated_at AS "updatedAt"
       FROM chain_projection_snapshot
       WHERE chain_id = $1 AND contract_address = $2 AND snapshot_kind = $3`,
      [
        scope.chainId,
        normalizeAddress(scope.contractAddress, "snapshot.contractAddress"),
        kind,
      ],
    );
    return result.rows[0] ? snapshotRow<TSnapshot>(result.rows[0]) : undefined;
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
    return Object.values(
      (await this.#currentOrderSnapshot()).stateMachineOrders,
    );
  }

  async getStateMachineOrder(
    orderId: string,
  ): Promise<StateMachineOrderProjection | undefined> {
    const snapshot = await this.#currentOrderSnapshot();
    return (
      snapshot.stateMachineOrders[orderId.toLowerCase()] ??
      snapshot.stateMachineOrders[orderId] ??
      uniqueOrderByBareId(Object.values(snapshot.stateMachineOrders), orderId)
    );
  }

  async findStateMachineOrdersByOrderId(
    orderId: string,
  ): Promise<readonly StateMachineOrderProjection[]> {
    const snapshot = await this.#currentOrderSnapshot();
    return Object.values(snapshot.stateMachineOrders).filter(
      (order) => order.orderId.toLowerCase() === orderId.toLowerCase(),
    );
  }

  async listStateMachineTasks(): Promise<
    readonly StateMachineTaskProjection[]
  > {
    return Object.values(
      (await this.#currentOrderSnapshot()).stateMachineTasks,
    );
  }

  async getStateMachineTask(
    taskId: string,
  ): Promise<StateMachineTaskProjection | undefined> {
    return (await this.#currentOrderSnapshot()).stateMachineTasks[taskId];
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
  const record = rowObject(row, "chain_index_cursor query");
  const finalizedBlock = nullableStringColumn(record, "finalizedBlock");
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
    updatedAt: stringColumn(record, "updatedAt"),
  };
}

function eventRow(row: unknown): ChainEvent {
  const record = rowObject(row, "chain_event_log query");
  const blockHash = nullableStringColumn(record, "blockHash");
  const removed = booleanColumn(record, "removed");
  return {
    chainId: numberColumn(record, "chainId"),
    contractAddress: normalizeAddress(
      stringColumn(record, "contractAddress"),
      "event.contractAddress",
    ),
    blockNumber: BigInt(stringColumn(record, "blockNumber")),
    transactionHash: stringColumn(record, "transactionHash") as Hex,
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
  const record = rowObject(row, "chain_projection_snapshot query");
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

function syncStateRow(row: unknown): ProjectionSyncState {
  const record = rowObject(row, "chain_projection_sync_state query");
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
): StateMachineOrderProjection | undefined {
  const matches = orders.filter(
    (order) => order.orderId.toLowerCase() === orderId.toLowerCase(),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function snapshotKindColumn(
  record: Record<string, unknown>,
  key: string,
): ProjectionSnapshotKind {
  const value = stringColumn(record, key);
  if (value !== "order" && value !== "identity") {
    throw new Error(
      `Postgres column ${key} must be a known projection snapshot kind`,
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
      `Postgres column ${key} must be a known projection sync status`,
    );
  }
  return value;
}
