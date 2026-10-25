import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { PostgresDatabase } from "../src/storage/postgres-client.js";
import { runPostgresMigrations } from "../src/storage/postgres-migrations.js";

// Postgres 测试库供给：模板库 uvp_tpl + 每次调用克隆 uvp_test_<hex>。
// admin DSN 读 CHAIN_SERVICES_POSTGRES_TEST_URL（指到任意库即可，docker
// 供给器默认注入 /postgres）。跑 `pnpm test` 会自动起一次性 docker postgres；
// 直接 vitest 需先导出该 env。克隆库不回收：容器随测试进程销毁。
const TEMPLATE_DATABASE_NAME = "uvp_tpl";
const TEST_DATABASE_PREFIX = "uvp_test_";
const TEMPLATE_LOCK_KEY = 7_201_611_337;

function adminDatabaseUrl(): string {
  const url = process.env.CHAIN_SERVICES_POSTGRES_TEST_URL;
  if (!url) {
    throw new Error(
      "CHAIN_SERVICES_POSTGRES_TEST_URL is not set: run tests via `pnpm test` " +
        "(scripts/with-postgres.sh provisions a disposable docker postgres automatically); " +
        "when invoking vitest directly, export CHAIN_SERVICES_POSTGRES_TEST_URL with an " +
        "admin DSN first"
    );
  }
  return url;
}

function postgresUrlWithDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function postgresIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) {
    throw new Error(`invalid Postgres test identifier: ${identifier}`);
  }
  return identifier;
}

function postgresMigrationsDirectory(): string {
  return fileURLToPath(new URL("../migrations/postgres", import.meta.url));
}

async function templateIsReady(adminUrl: string): Promise<boolean> {
  const template = new Client({
    connectionString: postgresUrlWithDatabase(adminUrl, TEMPLATE_DATABASE_NAME)
  });
  try {
    await template.connect();
  } catch {
    return false;
  }
  try {
    const result = await template.query<{ applied: string }>(
      "SELECT version FROM chain_services_migrations LIMIT 1"
    );
    return result.rows.length > 0;
  } catch {
    return false;
  } finally {
    await template.end();
  }
}

async function bootstrapTemplateDatabase(adminUrl: string): Promise<void> {
  // CREATE/DROP DATABASE 不能在事务里，且要在非目标库连接上执行：
  // 始终在 admin DSN 指向的库上操作模板库 uvp_tpl。
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(
      `DROP DATABASE IF EXISTS ${postgresIdentifier(TEMPLATE_DATABASE_NAME)} WITH (FORCE)`
    );
    await admin.query(
      `CREATE DATABASE ${postgresIdentifier(TEMPLATE_DATABASE_NAME)}`
    );
  } finally {
    await admin.end();
  }

  // 连进 uvp_tpl 执行 migrations/postgres/*.sql（生产 runner：同一份 DDL、
  // 同一排序，台账让克隆库对 autoRun 的 store 表现为已迁移完成）。
  const templateDatabase = new PostgresDatabase({
    databaseUrl: postgresUrlWithDatabase(adminUrl, TEMPLATE_DATABASE_NAME)
  });
  try {
    await runPostgresMigrations({
      database: templateDatabase,
      migrationsDirectory: postgresMigrationsDirectory()
    });
  } finally {
    // 克隆前必须断开模板库全部连接，否则 CREATE DATABASE ... TEMPLATE 失败。
    await templateDatabase.close();
  }
}

/**
 * 创建指向全新测试库的完整 DSN：模板库 uvp_tpl 就绪即克隆
 * uvp_test_<随机小写串>，未就绪才重建（全仓每个容器只 bootstrap 一次）。
 * vitest 按文件隔离模块状态，跨文件/跨进程的串行靠专用连接上的
 * session 级 advisory lock 覆盖「探测→重建→克隆」整个窗口。不回收测试库。
 */
export async function createPostgresTestDatabase(): Promise<string> {
  const adminUrl = adminDatabaseUrl();
  const database = `${TEST_DATABASE_PREFIX}${randomBytes(10).toString("hex")}`;

  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query("SELECT pg_advisory_lock($1)", [TEMPLATE_LOCK_KEY]);
    try {
      if (!(await templateIsReady(adminUrl))) {
        await bootstrapTemplateDatabase(adminUrl);
      }
      await admin.query(
        `CREATE DATABASE ${postgresIdentifier(database)} TEMPLATE ${postgresIdentifier(
          TEMPLATE_DATABASE_NAME
        )}`
      );
    } finally {
      await admin.query("SELECT pg_advisory_unlock($1)", [TEMPLATE_LOCK_KEY]);
    }
  } finally {
    await admin.end();
  }

  return postgresUrlWithDatabase(adminUrl, database);
}
