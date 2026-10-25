import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { StorageMigrationError } from "./errors.js";
import type { PostgresDatabase } from "./postgres-client.js";
import { numberColumn, rowObject, stringColumn } from "./postgres-rows.js";

export interface RunPostgresMigrationsOptions {
  readonly database: PostgresDatabase;
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

export async function runPostgresMigrations(options: RunPostgresMigrationsOptions): Promise<MigrationRunResult> {
  const migrations = loadSqlMigrations(options.migrationsDirectory ?? defaultPostgresMigrationsDirectory());
  await options.database.queryRaw(migrationTableSql);

  if (options.dryRun === true) {
    assertNoRetiredMigrations(await listAppliedVersionsPostgres(options.database), migrations);
    const pending = [];
    for (const migration of migrations) {
      const existing = await getMigrationRecord(options.database, migration.version);
      if (existing) {
        assertChecksumMatches(existing, migration);
        continue;
      }
      pending.push(migration);
    }
    return { applied: [], pending };
  }

  return options.database.withTransactionRaw(async () => {
    await options.database.queryRaw("SELECT pg_advisory_xact_lock(hashtext('chain_services_migrations'))");
    assertNoRetiredMigrations(await listAppliedVersionsPostgres(options.database), migrations);

    const applied: AppliedMigrationRecord[] = [];
    const pending: MigrationDefinition[] = [];

    for (const migration of migrations) {
      const existing = await getMigrationRecord(options.database, migration.version);
      if (existing) {
        assertChecksumMatches(existing, migration);
        continue;
      }

      pending.push(migration);

      const start = Date.now();
      await options.database.queryRaw(migration.sql);
      const record = {
        version: migration.version,
        checksum: migration.checksum,
        appliedAt: new Date().toISOString(),
        durationMs: Math.max(Date.now() - start, 0)
      };
      await options.database.queryRaw(
        `INSERT INTO chain_services_migrations (version, checksum, applied_at, duration_ms)
         VALUES ($1, $2, $3, $4)`,
        [record.version, record.checksum, record.appliedAt, record.durationMs]
      );
      applied.push(record);
    }

    return { applied, pending };
  });
}

function assertChecksumMatches(existing: AppliedMigrationRecord, migration: MigrationDefinition): void {
  if (existing.checksum !== migration.checksum) {
    throw new StorageMigrationError(
      `migration ${migration.version} checksum mismatch: database=${existing.checksum} file=${migration.checksum}`
    );
  }
}

async function listAppliedVersionsPostgres(database: PostgresDatabase): Promise<readonly string[]> {
  const result = await database.queryRaw<{ readonly version: string }>(
    `SELECT version FROM chain_services_migrations ORDER BY version ASC`
  );
  return result.rows.map((row) => row.version);
}

export async function listAppliedPostgresMigrations(
  database: PostgresDatabase
): Promise<readonly AppliedMigrationRecord[]> {
  await database.query(migrationTableSql);
  const result = await database.query(
    `SELECT version, checksum, applied_at AS "appliedAt", duration_ms AS "durationMs"
     FROM chain_services_migrations
     ORDER BY version ASC`
  );
  return result.rows.map((row) => migrationRow(row));
}

async function getMigrationRecord(
  database: PostgresDatabase,
  version: string
): Promise<AppliedMigrationRecord | undefined> {
  const result = await database.queryRaw(
    `SELECT version, checksum, applied_at AS "appliedAt", duration_ms AS "durationMs"
     FROM chain_services_migrations
     WHERE version = $1`,
    [version]
  );
  return result.rows[0] ? migrationRow(result.rows[0]) : undefined;
}

function migrationRow(row: unknown): AppliedMigrationRecord {
  const record = rowObject(row, "Postgres migration query");
  return {
    version: stringColumn(record, "version"),
    checksum: stringColumn(record, "checksum"),
    appliedAt: stringColumn(record, "appliedAt"),
    durationMs: numberColumn(record, "durationMs")
  };
}

function defaultPostgresMigrationsDirectory(): string {
  return resolve(process.cwd(), "migrations", "postgres");
}

// SQL 迁移文件装载与账本校验，只服务于本模块的 postgres 迁移 runner。

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
