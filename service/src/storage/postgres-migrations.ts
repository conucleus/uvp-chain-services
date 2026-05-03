import { resolve } from "node:path";
import { StorageMigrationError } from "./errors.js";
import {
  loadSqlMigrations,
  type AppliedMigrationRecord,
  type MigrationDefinition,
  type MigrationRunResult
} from "./migrations.js";
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

  const applied: AppliedMigrationRecord[] = [];
  const pending: MigrationDefinition[] = [];

  for (const migration of migrations) {
    const existing = await getMigrationRecord(options.database, migration.version);
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
    await options.database.withTransactionRaw(async () => {
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
    });
  }

  return { applied, pending };
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
