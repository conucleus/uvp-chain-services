// integration 车道：跑 unit 名单之外的测试（Postgres + createApiRouter），
// 由 scripts/with-postgres.sh 供给一次性 Postgres。
import { configDefaults, defineConfig } from "vitest/config";
import { UNIT_TEST_FILES } from "./tests/lane-membership";

export default defineConfig({
  test: {
    include: ["tests/*.test.ts"],
    exclude: [...configDefaults.exclude, ...UNIT_TEST_FILES.map((file) => `tests/${file}`)]
  }
});
