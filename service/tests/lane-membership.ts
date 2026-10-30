// 测试车道划分（WP9.1）：unit 只放不依赖 Postgres/router/anvil/live chain 的
// 确定性测试；其余测试文件留在 integration。两个 vitest 配置都从这里取名单，
// 避免双源；tests/ 下新增、改名或移动测试时同步本名单。
export const UNIT_TEST_FILES = [
  "bytes32-display.test.ts",
  "chain-read.test.ts",
  "config.test.ts",
  "indexer.reorg-determinism.test.ts",
  "plan-artifact-cli.test.ts",
  "proof-verifier.test.ts",
  "storage.test.ts",
  "viem-event-source.test.ts"
] as const;
