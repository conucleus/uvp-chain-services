// Postgres 错误归一：只把唯一冲突 SQLSTATE 映射为 StorageConstraintError。
// 事务回滚/唯一索引/PG 重开/durable wiring 属数据库机械，按风格禁令 §3.5 不在此测。
import { describe, expect, it } from "vitest";
import { StorageConstraintError } from "../src/storage/errors.js";
import { normalizePostgresError } from "../src/storage/postgres-client.js";

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
