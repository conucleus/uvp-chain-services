#!/usr/bin/env bash
# 薄壳：把 chain-services 测试接到 uvp-deploy 的 with-postgres 供给器。
# `pnpm test` 经本脚本跑 vitest：CHAIN_SERVICES_POSTGRES_TEST_URL 已设时
# 供给器直接透传；未设时起一次性 docker postgres（随机端口）并注入该 env。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

exec bash "${REPO_ROOT}/uvp-deploy/deploy/scripts/lib/with-postgres.sh" \
  --provisioner docker --container-prefix uvp-chain-services-test-pg "$@"
