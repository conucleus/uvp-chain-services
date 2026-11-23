# UVP Chain Services

Chain Services 把 UVP 链上事实投影成通用链读和运维接口，并负责索引重建。业务行、钱包会话、证据/治理写路径与提交编排已迁 `used-car/backend`（:8788）；chain 进程只持链投影，不广播交易、不生成业务签名。投影可以删除后从链上重建，不是新的事实来源。

## 责任边界

- `UVPStateMachine` 及其冻结模块定义 Order、Stage、Signal、Plan 发布、stage→supplier 指派和阶段文件补丁。
- 计划词表（selectorBindings / signalCapabilities / stageFileWriters / supplierBindings）的唯一 off-chain 权威是 `plan_artifacts`：按 `(chain_id, plan_id, plan_hash)` 内容寻址、行级不可变；索引重建与链读只读该表。产物缺失即重建失败、链读 404，不得退化成空词表继续。产物写入入口是 `plan-artifact:record` CLI（见下文「记录计划编译产物」）；Store 草稿编译入口已随 B2 删除。
- `UVPIdentityRegistry` 是唯一链上身份边界：既有 owner 登记的 subject↔account 绑定，也有 supplier capability 命名空间——自注册产生 `pending`、store registrar 激活/暂停/撤销；`supplierId` 是 UUID 编码的 `bytes32`，与 supplier account 永久一对一绑定（无 rotate）。链读按同一合约的 `SupplierRegistered`/`SupplierStatusChanged` 事件重放 SID→account 与状态，stage 发信账户按计划 default supplier → active stage patch supplier 的 supplierId 经 `accountOf` 解析；不持链下身份/KYC 数据。
- Chain Services 不代付 gas、不广播交易、不生成业务签名。Signal/补丁/订单注册的签名与 direct/relay 投递由 `uvp-client` 或应用侧完成；本服务只索引链事件并对外提供链读。timer keeper 等应用自动化已移出 chain-services（见 ARCHITECTURE Phase B）。
- `GET /identity/bindings` 只读身份投影；治理 review、descriptor 快照和治理签名 key 已迁 `used-car/backend`。

## 目录结构

`src/` 按链事实、投影、索引与运维读面分界：

- `indexer/service.ts`：扫描与索引入口（增量刷新、重组回滚、`--rebuild` 全量重建）；索引合约的日志解码失败时整批抛 `UndecodableChainLogError`，cursor 与投影不前进，不做跳过计数。
- `cli/record-plan-artifact.ts`：`plan_artifacts` 的生产写入入口（校验产物身份后写入，不跑迁移；见下文「记录计划编译产物」）。
- `cli/record-dock-artifact.ts`：`dock_artifacts` 的生产写入入口（校验 `uvp.dock.v1` 产物身份后写入，不跑迁移）。
- `projection/plan-artifacts.ts`：计划编译产物表（`plan_artifacts`）的 Postgres store 与索引/语义 oracle 解析器；缺失产物抛 `PlanArtifactMissingError`。
- `projection/dock-artifacts.ts`：Dock 文档产物表（`dock_artifacts`）的 Postgres store 与索引解析器；保存 `uvp.dock.v1`（validWhen AST/dependencies/atoms），是可从链上事件 + 记录产物重建的链下读投影，不是第二权威；缺失或身份不一致抛 `DockArtifactMissingError`/`DockArtifactIdentityError`，重建 fail-closed。
- 链读 snapshot 提供静态 Dock（`uvp.dock.v1`）与 DockBinding/per-output 投影（`uvp.dockBinding.v1`），没有 Link 行/状态。binding 身份、payload generation、emitted/emitted_by 来自链上事件，可从 `chain_event_log` 重建；A/B 窗口的当前 `satisfied`/相对 due 是 API 读时对 stage-patch `dockOutputWindow` view 的 live enrichment（不持久、不构成历史），无历史时 `opened_by`/`closed_by` 省略。chain-services 不实现第二套 Hook AST 求值器；view 读取按 binding+output 做短 TTL 缓存，view 不可用时 snapshot 读 fail-closed 503。
- `indexer/replay.ts`：统一事件顺序与重放编排。`rebuildOrderProjections` 是投影重建的单一入口，同时推进部署注册表事件族与显式诊断计数（幻影订单、激活缺补丁等不允许静默的计数）。
- `indexer/projections/`：按事件族与投影对象分文件——`proof`（事件参数解码与证明/时间线原语）、`snapshot`（重放快照形状与部署注册表读取）、`order`（订单事件与订单桶/复合键，含模块→状态机地址归一化）、`plan`（计划发布与元数据模块事件，含 `supplierBindingsRoot`/`supplierBindings`）、`signal`（SignalSubmitted/DerivedSignalSubmitted 与 relayer 字段）、`stage`（stage supplier 指派补丁/active supplier 与 hook 生命周期）、`stage-files`（`StageFileWritten` 的不透明 key→payload 重放）、`supplier`（`UVPIdentityRegistry` 供应商命名空间的 SID↔account 永久绑定与状态事件重放，及 assigned supplier account 解析）、`task`（任务投影与提交信号推进）；`index.ts` 保持原 `projections.ts` 的对外导出面。
- 其余：`api/`（链读/运维路由与边界）、`storage/`（projection store）、`config/`（链/索引/运维 env）、`security/`、`chain-adapters/`、`proof-verifier/`、`shared/`（链常量与运行时工具）。
- 业务模块 `order/`、`product/`、`evidence/`、`governance/`、`store/`、`task/`、`visibility/`、`resources/` 已删除；对应 HTTP/表/签名 key 由 `used-car/backend` 拥有。

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

## 运维接口（admin-ops）

`/admin/ops/*` 只暴露链投影自身的恢复动作，`src/api/routes/admin-ops.ts` 是唯一清单：

- `GET /admin/ops/status`、`GET /admin/ops/summary`；
- `POST /admin/ops/projections/rebuild`；
- `GET /admin/ops/indexer/pending-steps`、`POST /admin/ops/indexer/pending-steps/retry`。

reconcile worker 与 submission 重试属于已迁出的应用/relayer 域（本进程没有
submission 表、也没有 reconcile 配置），chain-services 不提供
`/admin/ops/reconcile/run` 或 `/admin/ops/submissions/:id/retry`。
`uvp-deploy/ops/console-web` 必须对齐上面的清单：它只调用 pending-step sweep 与
projection rebuild；不得为了兼容旧 UI 在本服务补死路由或 submission 面。

链读的 `syncStatus` 在投影重建中（`syncStatus=rebuilding` 或 `rebuild.status=running`）、
durable cursor 未追到 finalized bound、或 indexer heartbeat 超过 3 个 poll interval
时返回 `stale`；`degraded` 保持原样，不被降级成 `stale`。

非本地环境应使用持久数据库并通过安全预检。demo/fixture/mock 运行路径仅存在于 local 档，非 local 环境不含。

## 记录 Dock 编译产物

`dock_artifacts` 是 Dock 文档的链下读投影（可从链上 `DockRegistered` 事件 + 已记录产物重建），不是第二权威；链上 `UVPDockRegistry` 仍是 Dock 存在性的权威。写入入口只接受 uvp-core `analyzeDock` 生成的 `uvp.dock.v1` 产物：

```bash
CHAIN_SERVICES_DATABASE_URL=postgres://... \
  pnpm --filter @uvp-eth/chain-services dock-artifact:record -- \
  --file <dock-artifact.json> --chain-id <n> [--dry-run] [--verbose]
```

CLI 校验产物封闭字段集、`dkid = zd-<docHash 前 32 hex>`、各 id/validWhen AST/dependencies/atoms 形状后写入 `(chain_id, dkid, doc_hash)`；缺失或身份不一致时索引重建 fail-closed，不返回空 Dock。`--dry-run` 只校验并打印身份；CLI 不跑迁移。

## 存储与测试（PG-only）

存储引擎只保留 Postgres：部署跑什么，本地与测试就跑什么。

- 本地起库用 `./scripts/with-postgres.sh`（内部复用 `uvp-deploy/deploy/scripts/lib/with-postgres.sh`，一次性 docker postgres，随机端口），把打印出的 DSN 填进 `CHAIN_SERVICES_DATABASE_URL`。
- `pnpm test` 会自动套一层 `./scripts/with-postgres.sh` 起 docker 库再跑 vitest；直接运行 `vitest`（绕过该脚本）时必须自带 `CHAIN_SERVICES_POSTGRES_TEST_URL` 指向一个可达的 Postgres。

## 迁移口径

系统未上线：`service/migrations/postgres/` 只有**单一基线 `0001_schema.sql`**，由当前最终 schema 的
`pg_dump --schema-only` 生成（7 张 chain/投影表 + 函数/触发器/索引/约束）。不再保留 0002/0003/0004
历史迁移；旧库直接重建，不做升级路径。迁移台账 `chain_services_migrations` 由 runner 创建，
checksum 漂移/已应用版本消失仍 fail-closed。

- chain 只拥有 `chain_event_log`、`chain_index_cursor`、`chain_projection_snapshot`、
  `chain_projection_sync_state`、`indexer_pending_post_commit`、`plan_artifacts`、`dock_artifacts`；
- 业务表全部归 `used-car/backend` 的 `app` schema，fresh DB 不会在 `public` 创建它们；
- 本服务以 `public` 为默认 schema 读自己的表，不读写 `app`。
