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

// 各 store 独立开连接写同一库文件。不设 busy_timeout 时并发写立刻
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

// node:sqlite 的 database.isTransaction 是 Node 22.16/24+ 才有的属性，
// 而 engines 声明 >=20——旧运行时上该属性为 undefined（falsy），嵌套调用
// 会再次 BEGIN（"cannot start a transaction within a transaction"），随后
// catch 里的 ROLLBACK 还会把外层事务一并回滚。无该属性时退回按连接
// 追踪（本模块是连接上唯一的事务入口），语义与 isTransaction 一致：
// 嵌套调用直接并入外层事务（扁平事务，由外层负责提交/回滚）。
const connectionsInTransaction = new WeakSet<object>();

function isConnectionInTransaction(database: SqliteDatabase): boolean {
  if (typeof database.isTransaction === "boolean") {
    return database.isTransaction;
  }
  return connectionsInTransaction.has(database);
}

export async function withSqliteTransaction<T>(
  database: SqliteDatabase,
  operation: () => Promise<T>
): Promise<T> {
  // BEGIN IMMEDIATE 持有写锁直到 COMMIT：operation 虽是 async 签名，事务
  // 体内只允许本模块的同步 sqlite 调用——任何 await 外部 I/O（RPC/文件/
  // 其他连接）都会把写锁跨事件循环持有，放大 BUSY 竞争面并可能拖垮同库
  // 其它连接的写入。
  if (isConnectionInTransaction(database)) {
    return operation();
  }

  database.exec("BEGIN IMMEDIATE;");
  const trackConnection = typeof database.isTransaction !== "boolean";
  if (trackConnection) {
    connectionsInTransaction.add(database);
  }
  try {
    const result = await operation();
    database.exec("COMMIT;");
    return result;
  } catch (error) {
    safeRollback(database);
    throw error;
  } finally {
    if (trackConnection) {
      connectionsInTransaction.delete(database);
    }
  }
}

function safeRollback(database: SqliteDatabase): void {
  try {
    database.exec("ROLLBACK;");
  } catch {
    // 回滚失败不得掩盖原始错误：连接可能已中断或事务已不在开启状态，
    // 原始错误优先上抛，残留状态由下一次事务边界的报错如实暴露。
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

/**
 * 供存储调用方区分"跨连接写竞争的瞬态锁错误"与真实存储故障：
 * SQLITE_BUSY 经 busy_timeout + 有界重试仍溢出时是竞争信号，不是数据
 * 损坏，调用方不得据此把投影标成 degraded。
 */
export function isTransientSqliteBusyError(error: unknown): boolean {
  return isSqliteBusyError(error);
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
