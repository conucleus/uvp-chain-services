// unit 车道：只跑 lane-membership 列出的确定性测试，不 provision Postgres。
import { defineConfig } from "vitest/config";
import { UNIT_TEST_FILES } from "./tests/lane-membership";

export default defineConfig({
  test: {
    include: UNIT_TEST_FILES.map((file) => `tests/${file}`)
  }
});
