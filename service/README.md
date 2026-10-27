# UVP Chain Services

Chain Services 把 UVP 链上事实投影成通用链读和运维接口，并负责索引重建。业务行、钱包会话、证据/治理写路径与提交编排已迁 `uvp-app-backend`（:8788）；chain 进程只持链投影，不广播交易、不生成业务签名。投影可以删除后从链上重建，不是新的事实来源。

## 责任边界

- `UVPStateMachine` 及其冻结模块定义 Order、Stage、Signal、Plan 发布、提交授权和资源补丁。
- 计划词表（selectorBindings / signalCapabilities / executorCandidates）的唯一 off-chain 权威是 `plan_artifacts`：按 `(chain_id, plan_id, plan_hash)` 内容寻址、行级不可变；索引重建与链读只读该表。产物缺失即重建失败、链读 404，不得退化成空词表继续。产物写入入口是 `plan-artifact:record` CLI（见下文「记录计划编译产物」）；Store 草稿编译入口已随 B2 删除。
- `UVPIdentityRegistry` 只记录线下主体标识与链上账户的绑定和撤销。
- Chain Services 不代付 gas、不广播交易、不生成业务签名。Signal/补丁/订单注册的签名与 direct/relay 投递由 `uvp-client` 或应用侧完成；本服务只索引链事件并对外提供链读。dock/timer keeper 等应用自动化已移出 chain-services（见 ARCHITECTURE Phase B）。
- `GET /identity/bindings` 只读身份投影；治理 review、descriptor 快照和治理签名 key 已迁 `uvp-app-backend`。

## 目录结构

`src/` 按链事实、投影、索引与运维读面分界：

- `indexer/service.ts`：扫描与索引入口（增量刷新、重组回滚、`--rebuild` 全量重建）。
- `cli/record-plan-artifact.ts`：`plan_artifacts` 的生产写入入口（校验产物身份后写入，不跑迁移；见下文「记录计划编译产物」）。
- `projection/plan-artifacts.ts`：计划编译产物表（`plan_artifacts`）的 Postgres store 与索引/语义 oracle 解析器；缺失产物抛 `PlanArtifactMissingError`。
- `indexer/replay.ts`：统一事件顺序与重放编排。`rebuildOrderProjections` 是投影重建的单一入口，同时推进部署注册表事件族与显式诊断计数（幻影订单、dock 未开启、激活缺补丁等不允许静默的计数）。
- `indexer/projections/`：按事件族与投影对象分文件——`proof`（事件参数解码与证明/时间线原语）、`snapshot`（重放快照形状与部署注册表读取）、`order`（订单事件与订单桶/复合键，含模块→状态机地址归一化）、`plan`（计划发布与元数据模块事件）、`signal`（信号/授权/委派）、`stage`（阶段补丁与 hook 生命周期）、`docking`（dock 具名接口委托）、`task`（任务投影与提交信号推进）；`index.ts` 保持原 `projections.ts` 的对外导出面。
- 其余：`api/`（链读/运维路由与边界）、`storage/`（projection store）、`config/`（链/索引/运维 env）、`security/`、`chain-adapters/`、`proof-verifier/`、`shared/`（链常量与运行时工具）。
- 业务模块 `order/`、`product/`、`evidence/`、`governance/`、`store/`、`task/`、`visibility/`、`resources/` 已删除；对应 HTTP/表/签名 key 由 `uvp-app-backend` 拥有。

## 运行

```bash
pnpm install
cp .env.example .env.local   # 仅作为配置参考，服务本身不会加载该文件
pnpm run typecheck
pnpm run test
pnpm run dev:api
```

配置全部从进程环境变量读取（服务内没有任何 dotenv/`.env` 文件加载逻辑）。`.env.example` 只是模板；实际运行时请在 shell 中 export 变量，或使用支持 `--env-file` 的启动器注入，例如：

```bash
node --env-file=.env.local --import tsx src/api/server.ts
```

默认 API 地址为 `http://127.0.0.1:8787`。地址清单必须使用当前 schema，并明确提供 `stateMachineDeployments`；服务不会根据单个合约地址合成部署记录。

## 主要配置

- `CHAIN_SERVICES_RUNTIME_ENV`: `local`、`testnet`、`staging` 或 `production`
- `UVP_ADDRESS_MANIFEST`: 当前网络地址清单
- `UVP_RPC_URL`, `UVP_CHAIN_ID`: RPC 与链 ID
- `CHAIN_SERVICES_DATABASE_URL`: 链投影存储（唯一存储 env，PG-only，必须是 `postgres://` DSN；未设置时启动直接报错并提示用 docker 起库）
- `OPS_CONSOLE_ADMIN_IDS` / `CHAIN_SERVICES_ADMIN_TOKEN_HASHES`: 运维 admin 白名单与 token hash

本进程没有 relayer/私钥/广播/回执对账配置：config/preflight 只解析链、索引、存储与运维 admin env。

非本地环境应使用持久数据库并通过安全预检。demo/fixture/mock 运行路径仅存在于 local 档，非 local 环境不含。

## 存储与测试（PG-only）

存储引擎只保留 Postgres：部署跑什么，本地与测试就跑什么。

- 本地起库用 `./scripts/with-postgres.sh`（内部复用 `uvp-deploy/deploy/scripts/lib/with-postgres.sh`，一次性 docker postgres，随机端口），把打印出的 DSN 填进 `CHAIN_SERVICES_DATABASE_URL`。
- `pnpm test` 会自动套一层 `./scripts/with-postgres.sh` 起 docker 库再跑 vitest；直接运行 `vitest`（绕过该脚本）时必须自带 `CHAIN_SERVICES_POSTGRES_TEST_URL` 指向一个可达的 Postgres。

## 迁移口径

系统未上线：`service/migrations/postgres/` 只有**单一基线 `0001_schema.sql`**，由当前最终 schema 的
`pg_dump --schema-only` 生成（6 张 chain/投影表 + 函数/触发器/索引/约束）。不再保留 0002/0003/0004
历史迁移；旧库直接重建，不做升级路径。迁移台账 `chain_services_migrations` 由 runner 创建，
checksum 漂移/已应用版本消失仍 fail-closed。

- chain 只拥有 `chain_event_log`、`chain_index_cursor`、`chain_projection_snapshot`、
  `chain_projection_sync_state`、`indexer_pending_post_commit`、`plan_artifacts`；
- 业务表全部归 `uvp-app-backend` 的 `app` schema，fresh DB 不会在 `public` 创建它们；
- 本服务以 `public` 为默认 schema 读自己的表，不读写 `app`。
