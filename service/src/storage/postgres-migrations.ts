import { resolve } from "node:path";
import { StorageMigrationError } from "./errors.js";
import {
  assertNoRetiredMigrations,
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

  // 多实例并发启动会各自跑迁移：查询-应用-记账的序列没有库级互斥时，
  // 两个实例可以同时把同一批 pending 各自应用一遍（DDL 竞态 + 台账
  // 重复插入）。事务级 advisory lock 把整轮序列化——后来者在锁上等待，
  // 拿锁后重读台账（上一轮已应用的版本直接跳过），同一迁移只会被应用
  // 一次。批次整体一个事务：任一步失败全批回滚，库留在上一完整基线，
  // 下次启动整批重放。
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
