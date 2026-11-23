// Postgres 错误归一：只把唯一冲突 SQLSTATE 映射为 StorageConstraintError。
// 事务回滚/唯一索引/PG 重开/durable wiring 属数据库机械，按风格禁令 §3.5 不在此测。
import { describe, expect, it } from "vitest";
import { StorageConstraintError } from "../src/storage/errors.js";
import { normalizePostgresError } from "../src/storage/postgres-client.js";
import { readableSyncState } from "../src/storage/sync-state.js";
import type { ProjectionSyncState } from "../src/storage/projection-store.js";

describe("postgres error normalization", () => {
  it("maps only the unique-violation SQLSTATE to StorageConstraintError", () => {
    const pgError = (code: string) => Object.assign(new Error(`pg failure (${code})`), { code });
    expect(normalizePostgresError(pgError("23505"))).toBeInstanceOf(StorageConstraintError);
    for (const code of ["23502", "23503", "23514", "23000", "23"]) {
      const normalized = normalizePostgresError(pgError(code));
      expect(normalized).not.toBeInstanceOf(StorageConstraintError);
      expect(normalized).toBeInstanceOf(Error);
    }
  });
});

describe("projection sync-state read model", () => {
  const updatedAt = "2026-10-27T00:00:00.000Z";

  function state(overrides: Partial<ProjectionSyncState> = {}): ProjectionSyncState {
    return {
      chainId: 31337,
      contractAddress: "0x0000000000000000000000000000000000000000",
      syncStatus: "indexed",
      latestIndexedBlock: 100n,
      finalizedBlock: 100n,
      confirmationDepth: 1,
      eventCount: 4,
      updatedAt,
      ...overrides
    };
  }

  it("reports stale while a rebuild is running instead of claiming the projection is indexed", () => {
    expect(readableSyncState(state({
      syncStatus: "rebuilding",
      rebuild: { status: "running" }
    }), { now: new Date(updatedAt) })).toMatchObject({ syncStatus: "stale" });
  });

  it("reports stale when the durable scan cursor has not reached the finalized bound", () => {
    expect(readableSyncState(state(), {
      now: new Date(updatedAt),
      cursor: { nextBlock: 100n, finalizedBlock: 100n }
    })).toMatchObject({ syncStatus: "stale" });
  });

  it("reports stale when no cursor is available and the indexed block trails the finalized bound", () => {
    expect(readableSyncState(state({ latestIndexedBlock: 99n, finalizedBlock: 100n }), {
      now: new Date(updatedAt)
    })).toMatchObject({ syncStatus: "stale" });
  });

  it("keeps indexed when the scan cursor and heartbeat both cover the finalized bound", () => {
    expect(readableSyncState(state(), {
      now: new Date(updatedAt),
      staleAfterMs: 30_000,
      cursor: { nextBlock: 101n, finalizedBlock: 100n }
    })).toMatchObject({ syncStatus: "indexed" });
  });

  it("reports stale when the indexer heartbeat is older than the staleness window", () => {
    expect(readableSyncState(state(), {
      now: new Date(Date.parse(updatedAt) + 31_000),
      staleAfterMs: 30_000
    })).toMatchObject({ syncStatus: "stale" });
  });

  it("preserves a degraded status instead of downgrading a real failure to stale", () => {
    expect(readableSyncState(state({ syncStatus: "degraded", degradedReason: "rpc failed" }), {
      now: new Date(Date.parse(updatedAt) + 31_000),
      staleAfterMs: 30_000
    })).toMatchObject({ syncStatus: "degraded", degradedReason: "rpc failed" });
  });
});
