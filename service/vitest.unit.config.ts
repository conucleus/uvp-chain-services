// unit 车道：只跑 lane-membership 列出的确定性测试，不 provision Postgres。
// 名单里的文件缺失时直接失败：vitest 对不存在的 include 会静默少跑。
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { UNIT_TEST_FILES } from "./tests/lane-membership";

const missingUnitFiles = UNIT_TEST_FILES.filter(
  (file) => !existsSync(fileURLToPath(new URL(`./tests/${file}`, import.meta.url)))
);
if (missingUnitFiles.length > 0) {
  throw new Error(`unit lane member missing: ${missingUnitFiles.join(", ")}`);
}

export default defineConfig({
  test: {
    include: UNIT_TEST_FILES.map((file) => `tests/${file}`)
  }
});
