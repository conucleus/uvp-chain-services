// 测试车道划分（WP9.1）：unit 只放不依赖 Postgres/router/live chain 的确定性
// 测试；其余测试文件留在 integration，用 Postgres/router 测本层契约。live
// chain/多进程的跨层用例归 L6（uvp-deploy/qa/tests/live-chain/），不回到本
// 名单。两个 vitest 配置都从这里取名单，避免双源；tests/ 下新增、改名或移动
// 测试时同步本名单。
export const UNIT_TEST_FILES = [
  "bytes32-display.test.ts",
  "chain-read.test.ts",
  "config.test.ts",
  "indexer.reorg-determinism.test.ts",
  "plan-artifact-cli.test.ts",
  "proof-verifier.test.ts",
  "stage-files.test.ts",
  "storage.test.ts",
  "viem-event-source.test.ts"
] as const;
