import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { SqliteDatabase } from "./sqlite.js";
import { normalizeSqliteError } from "./sqlite.js";
import { StorageMigrationError } from "./errors.js";

export interface MigrationDefinition {
  readonly version: string;
  readonly checksum: string;
  readonly sql: string;
}

export interface AppliedMigrationRecord {
  readonly version: string;
  readonly checksum: string;
  readonly appliedAt: string;
  readonly durationMs: number;
}

export interface MigrationRunResult {
  readonly applied: readonly AppliedMigrationRecord[];
  readonly pending: readonly MigrationDefinition[];
}

export interface RunSqliteMigrationsOptions {
  readonly database: SqliteDatabase;
  readonly migrationsDirectory?: string;
  readonly dryRun?: boolean;
}

const migrationTableSql = `
CREATE TABLE IF NOT EXISTS chain_services_migrations (
  version TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL
);
`;

export function runSqliteMigrations(options: RunSqliteMigrationsOptions): MigrationRunResult {
  const migrations = loadSqlMigrations(options.migrationsDirectory ?? defaultMigrationsDirectory());
  options.database.exec(migrationTableSql);
  assertNoRetiredMigrations(
    listAppliedVersionsSqlite(options.database),
    migrations
  );

  const applied: AppliedMigrationRecord[] = [];
  const pending: MigrationDefinition[] = [];

  for (const migration of migrations) {
    const existing = getMigrationRecord(options.database, migration.version);
    if (existing) {
      if (existing.checksum !== migration.checksum) {
        throw new StorageMigrationError(
          `migration ${migration.version} checksum mismatch: database=${existing.checksum} file=${migration.checksum}`
        );
      }
      continue;
    }

    pending.push(migration);
    if (options.dryRun === true) {
      continue;
    }

    const start = Date.now();
    try {
      options.database.exec("BEGIN IMMEDIATE;");
      options.database.exec(migration.sql);
      const record = {
        version: migration.version,
        checksum: migration.checksum,
        appliedAt: new Date().toISOString(),
        durationMs: Math.max(Date.now() - start, 0)
      };
      options.database.prepare(
        `INSERT INTO chain_services_migrations (version, checksum, applied_at, duration_ms)
         VALUES (?, ?, ?, ?)`
      ).run(record.version, record.checksum, record.appliedAt, record.durationMs);
      options.database.exec("COMMIT;");
      applied.push(record);
    } catch (error) {
      options.database.exec("ROLLBACK;");
      throw normalizeSqliteError(error);
    }
  }

  return { applied, pending };
}

function listAppliedVersionsSqlite(database: SqliteDatabase): readonly string[] {
  return database.prepare(
    `SELECT version FROM chain_services_migrations ORDER BY version ASC`
  ).all().map((row) => rowObject(row).version).filter((version): version is string => typeof version === "string");
}

export function listAppliedSqliteMigrations(database: SqliteDatabase): readonly AppliedMigrationRecord[] {
  database.exec(migrationTableSql);
  return database.prepare(
    `SELECT version, checksum, applied_at AS appliedAt, duration_ms AS durationMs
     FROM chain_services_migrations
     ORDER BY version ASC`
  ).all().map((row) => migrationRow(row));
}

/** 迁移文件名契约：4 位序号前缀 + 小写蛇形名。序号是应用的排序与
 * 幂等键（version = 去后缀文件名），格式漂移会让 localeCompare 排序
 * 与序号语义脱钩，必须在加载时拒绝而不是静默接受。 */
const MIGRATION_FILENAME_PATTERN = /^(\d{4})_[a-z0-9_]+\.sql$/;

export function loadSqlMigrations(migrationsDirectory: string): readonly MigrationDefinition[] {
  const files = readdirSync(migrationsDirectory)
    .filter((file) => file.endsWith(".sql"))
    .sort((left, right) => left.localeCompare(right));

  const seenNumbers = new Set<string>();
  return files.map((file) => {
    const match = MIGRATION_FILENAME_PATTERN.exec(file);
    if (!match) {
      throw new StorageMigrationError(
        `migration file ${file} must match NNNN_name.sql (4-digit sequence prefix, lowercase snake name)`
      );
    }
    const sequence = match[1]!;
    if (seenNumbers.has(sequence)) {
      throw new StorageMigrationError(
        `migration sequence ${sequence} is defined by more than one file in ${migrationsDirectory}`
      );
    }
    seenNumbers.add(sequence);
    const sql = readFileSync(resolve(migrationsDirectory, file), "utf8");
    return {
      version: basename(file, ".sql"),
      checksum: createHash("sha256").update(sql).digest("hex"),
      sql
    };
  });
}

/**
 * 库内已应用版本与文件集比对：已应用而文件缺失 = 有迁移文件被删除或
 * 改名——该库的 schema 来源已不可重建，静默继续会让后续版本号叠在一个
 * 有洞的历史上。响亮失败，由人裁决（恢复文件或人工核对后清账）。
 */
export function assertNoRetiredMigrations(
  appliedVersions: readonly string[],
  migrations: readonly MigrationDefinition[]
): void {
  const known = new Set(migrations.map((migration) => migration.version));
  const retired = appliedVersions.filter((version) => !known.has(version));
  if (retired.length > 0) {
    throw new StorageMigrationError(
      `applied migrations missing from the migrations directory: ${retired.join(", ")}; ` +
      "restore the files or reconcile the ledger before running further migrations"
    );
  }
}

function getMigrationRecord(database: SqliteDatabase, version: string): AppliedMigrationRecord | undefined {
  const row = database.prepare(
    `SELECT version, checksum, applied_at AS appliedAt, duration_ms AS durationMs
     FROM chain_services_migrations
     WHERE version = ?`
  ).get(version);
  return row ? migrationRow(row) : undefined;
}

function migrationRow(row: unknown): AppliedMigrationRecord {
  const record = rowObject(row);
  const version = stringColumn(record, "version");
  const checksum = stringColumn(record, "checksum");
  const appliedAt = stringColumn(record, "appliedAt");
  const durationMs = numberColumn(record, "durationMs");
  return { version, checksum, appliedAt, durationMs };
}

function rowObject(row: unknown): Record<string, unknown> {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new StorageMigrationError("migration query returned a malformed row");
  }
  return row as Record<string, unknown>;
}

function stringColumn(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new StorageMigrationError(`migration column ${key} must be a string`);
  }
  return value;
}

function numberColumn(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number") {
    throw new StorageMigrationError(`migration column ${key} must be a number`);
  }
  return value;
}

function defaultMigrationsDirectory(): string {
  return resolve(process.cwd(), "migrations");
}
