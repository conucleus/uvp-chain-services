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
  try {
    return operation();
  } catch (error) {
    throw normalizeSqliteError(error);
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
