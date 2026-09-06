import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { StorageConstraintError, StorageError } from "./errors.js";

export type SqliteValue = string | number | bigint | null | Buffer;

export interface SqliteRunResult {
  readonly changes: number;
  readonly lastInsertRowid: number | bigint;
}

export interface SqliteStatement {
  run(...values: readonly SqliteValue[]): SqliteRunResult;
  get(...values: readonly SqliteValue[]): unknown;
  all(...values: readonly SqliteValue[]): unknown[];
}

export interface SqliteDatabase {
  readonly isTransaction?: boolean;
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

interface NodeSqliteModule {
  readonly DatabaseSync: new (path: string) => SqliteDatabase;
}

const require = createRequire(import.meta.url);

// CS-P2：各 store 独立开连接写同一库文件。不设 busy_timeout 时并发写立刻
// SQLITE_BUSY,统一在连接层给等待预算,写路径再叠加有界重试兜底。
const SQLITE_BUSY_TIMEOUT_MS = 5_000;
const SQLITE_WRITE_BUSY_RETRY_DELAYS_MS = [25, 100, 400] as const;

export function openSqliteDatabase(databaseUrl: string): SqliteDatabase {
  const databasePath = sqlitePathFromUrl(databaseUrl);
  if (databasePath !== ":memory:") {
    mkdirSync(dirname(databasePath), { recursive: true });
  }

  try {
    const sqlite = require("node:sqlite") as NodeSqliteModule;
    const database = new sqlite.DatabaseSync(databasePath);
    database.exec("PRAGMA foreign_keys = ON;");
    database.exec("PRAGMA journal_mode = WAL;");
    database.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};`);
    return database;
  } catch (error) {
    if (isMissingNodeSqlite(error)) {
      throw new StorageError(
        "SQLite storage requires a Node.js runtime with node:sqlite support, or a future external SQLite driver"
      );
    }
    throw normalizeSqliteError(error);
  }
}

export async function withSqliteTransaction<T>(
  database: SqliteDatabase,
  operation: () => Promise<T>
): Promise<T> {
  if (database.isTransaction) {
    return operation();
  }

  database.exec("BEGIN IMMEDIATE;");
  try {
    const result = await operation();
    database.exec("COMMIT;");
    return result;
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  }
}

export function sqlitePathFromUrl(databaseUrl: string): string {
  const trimmed = databaseUrl.trim();
  if (trimmed === ":memory:" || trimmed === "sqlite::memory:" || trimmed === "sqlite://:memory:") {
    return ":memory:";
  }
  if (trimmed.startsWith("file:")) {
    return fileURLToPath(trimmed);
  }
  if (trimmed.startsWith("sqlite://")) {
    return decodeURIComponent(trimmed.slice("sqlite://".length));
  }
  if (trimmed.startsWith("sqlite:")) {
    return decodeURIComponent(trimmed.slice("sqlite:".length));
  }
  return trimmed;
}

export function runSqliteWrite<T>(operation: () => T): T {
  let attempt = 0;
  for (;;) {
    try {
      return operation();
    } catch (error) {
      // busy_timeout 之外的偶发锁竞争(如事务边界的 BEGIN IMMEDIATE)按
      // 有界次数同步退避重试;重试耗尽或非 busy 错误原样归一化上抛。
      if (!isSqliteBusyError(error) || attempt >= SQLITE_WRITE_BUSY_RETRY_DELAYS_MS.length) {
        throw normalizeSqliteError(error);
      }
      sleepSync(SQLITE_WRITE_BUSY_RETRY_DELAYS_MS[attempt]!);
      attempt += 1;
    }
  }
}

export function normalizeSqliteError(error: unknown): Error {
  if (isSqliteUniqueConstraintError(error)) {
    return new StorageConstraintError(error.message);
  }
  if (error instanceof Error) {
    return error;
  }
  return new StorageError("unknown SQLite storage error");
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isSqliteBusyError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as Error & { readonly code?: unknown }).code;
  return (
    (typeof code === "string" && code.startsWith("SQLITE_BUSY")) ||
    /database is locked|database table is locked/i.test(error.message)
  );
}

function isMissingNodeSqlite(error: unknown): boolean {
  return error instanceof Error && /node:sqlite|Cannot find module/.test(error.message);
}

function isSqliteUniqueConstraintError(error: unknown): error is Error & { readonly code?: string } {
  const sqliteError = error as Error & { readonly code?: unknown };
  return (
    error instanceof Error &&
    (error.message.includes("UNIQUE constraint failed") ||
      (typeof sqliteError.code === "string" && sqliteError.code === "SQLITE_CONSTRAINT_UNIQUE"))
  );
}
