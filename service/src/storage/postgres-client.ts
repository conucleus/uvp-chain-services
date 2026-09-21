import { AsyncLocalStorage } from "node:async_hooks";
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import { StorageConstraintError, StorageError, StorageUnavailableError } from "./errors.js";
import { runPostgresMigrations } from "./postgres-migrations.js";

export interface PostgresDatabaseOptions {
  readonly databaseUrl: string;
  readonly migrations?: {
    readonly autoRun?: boolean;
    readonly directory?: string;
  };
}

export class PostgresDatabase {
  readonly #pool: Pool;
  readonly #transaction = new AsyncLocalStorage<PoolClient>();
  readonly #ready: Promise<void>;

  constructor(options: PostgresDatabaseOptions) {
    this.#pool = new Pool({
      connectionString: options.databaseUrl,
      connectionTimeoutMillis: 5_000
    });
    this.#ready = options.migrations?.autoRun === true
      ? runPostgresMigrations({
          database: this,
          ...(options.migrations.directory ? { migrationsDirectory: options.migrations.directory } : {})
        }).then(() => undefined)
      : Promise.resolve();
  }

  async ready(): Promise<void> {
    await this.#ready;
  }

  async close(): Promise<void> {
    try {
      await this.#ready;
    } finally {
      await this.#pool.end();
    }
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    values: readonly unknown[] = []
  ): Promise<QueryResult<T>> {
    await this.ready();
    return this.queryRaw(sql, values);
  }

  async queryRaw<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    values: readonly unknown[] = []
  ): Promise<QueryResult<T>> {
    const client = this.#transaction.getStore();
    try {
      return await (client ?? this.#pool).query<T>(sql, [...values]);
    } catch (error) {
      throw normalizePostgresError(error);
    }
  }

  async withTransaction<T>(operation: () => Promise<T>): Promise<T> {
    await this.ready();
    return this.withTransactionRaw(operation);
  }

  async withTransactionRaw<T>(operation: () => Promise<T>): Promise<T> {
    // 不等 ready()：迁移运行器是 #ready 的构造方，等 ready 是循环等待
    // （迁移→开事务→等迁移完成→死锁）。公开的 withTransaction 仍先过
    // ready 门，业务查询不会跑到迁移前面。
    const currentClient = this.#transaction.getStore();
    if (currentClient) {
      return operation();
    }

    const client = await this.#pool.connect().catch((error: unknown) => {
      throw normalizePostgresError(error);
    });
    try {
      await client.query("BEGIN");
      const result = await this.#transaction.run(client, operation);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original failure; rollback failure is secondary.
      }
      throw normalizePostgresError(error);
    } finally {
      client.release();
    }
  }
}

export function normalizePostgresError(error: unknown): Error {
  if (isPostgresConstraintError(error)) {
    return new StorageConstraintError(error.message);
  }
  if (isPostgresConnectivityError(error)) {
    return new StorageUnavailableError(causeMessage(error));
  }
  if (error instanceof Error) {
    return error;
  }
  return new StorageError("unknown Postgres storage error");
}

function isPostgresConnectivityError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message;
  return /authentication timed out|Connection terminated unexpectedly|connect ETIMEDOUT|connect ECONNREFUSED|timeout expired|remaining connection slots are reserved|too many clients|Connection reset by peer/i.test(message) ||
    (error as Error & { readonly code?: string }).code === "57P01" ||
    (error as Error & { readonly code?: string }).code === "08006" ||
    (error as Error & { readonly code?: string }).code === "08001";
}

function causeMessage(error: unknown): string {
  if (error instanceof Error) {
    return `Postgres database is temporarily unavailable: ${error.message}`;
  }
  return "Postgres database is temporarily unavailable";
}

function isPostgresConstraintError(error: unknown): error is Error & { readonly code: string } {
  const postgresError = error as Error & { readonly code?: unknown };
  // 只认唯一冲突（23505）：StorageConstraintError 的消费方一律按"并发
  // 败者的 409 域冲突"收敛，23xxx 前缀会把 FK（23503）/NOT NULL
  //（23502）/CHECK（23514）等完整性故障误译成域冲突——那些是数据或
  // schema 问题，必须以原始错误上抛。与 sqlite 侧只认 UNIQUE 约束的
  // 口径对齐。
  return (
    error instanceof Error &&
    typeof postgresError.code === "string" &&
    postgresError.code === "23505"
  );
}
