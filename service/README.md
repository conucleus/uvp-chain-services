# UVP Chain Services

Chain Services 把 UVP 链上事实投影成通用链读和运维接口，并负责 relay 操作态、交易广播、回执对账及索引重建。业务行、钱包会话和证据/治理写路径已迁 `uvp-app-backend`（:8788）；chain 进程只持链投影、relay 操作态和签名广播。投影可以删除后从链上重建，不是新的事实来源。

## 责任边界

- `UVPStateMachine` 及其冻结模块定义 Order、Stage、Signal、Plan 发布、提交授权和资源补丁。
- 计划词表（selectorBindings / signalCapabilities / executorCandidates）的唯一 off-chain 权威是 `plan_artifacts`：按 `(chain_id, plan_id, plan_hash)` 内容寻址、行级不可变；索引重建与提交造证只读该表。产物缺失即重建失败、提交造证 503，不得退化成空词表继续。产物写入入口是 `plan-artifact:record` CLI（见下文「记录计划编译产物」）；Store 草稿编译入口已随 B2 删除。
- `UVPIdentityRegistry` 只记录线下主体标识与链上账户的绑定和撤销。
- Chain Services 可以代付 gas，但业务签名仍由对应参与者产生，服务在任何路径上都不生成业务签名。代付广播的交易面只剩链侧 relay 操作态：plan-scoped 的 `submitSignalFor`（Signal 提交）与 `applyStageExecutorPatchFor` / `applyStageResourcePatchFor`（stage 补丁代发）；订单注册/治理身份注册撤销已迁 `uvp-app-backend`。信号/补丁提交仍由 capability-proofs 单源（`@uvp-eth/compiler`，见 `src/submissions/capability-proofs.ts`）现场造证随交易携带。dock/timer keeper 等应用自动化已移出 chain-services（见 ARCHITECTURE Phase B）。
- `GET /identity/bindings` 只读身份投影；治理 review、descriptor 快照和治理签名 key 已迁 `uvp-app-backend`。

## 目录结构

`src/` 按链事实、投影、执行与业务数据分界（意见书 B2 结构治理后的目标布局）：

- `indexer/service.ts`：扫描与索引入口（增量刷新、重组回滚、`--rebuild` 全量重建）。
- `cli/record-plan-artifact.ts`：`plan_artifacts` 的生产写入入口（校验产物身份后写入，不跑迁移；见下文「记录计划编译产物」）。
- `projection/plan-artifacts.ts`：计划编译产物表（`plan_artifacts`）的 Postgres store 与索引/语义 oracle 解析器；缺失产物抛 `PlanArtifactMissingError`。
- `indexer/replay.ts`：统一事件顺序与重放编排。`rebuildOrderProjections` 是投影重建的单一入口，同时推进部署注册表事件族与显式诊断计数（幻影订单、dock 未开启、激活缺补丁等不允许静默的计数）。
- `indexer/projections/`：按事件族与投影对象分文件——`proof`（事件参数解码与证明/时间线原语）、`snapshot`（重放快照形状与部署注册表读取）、`order`（订单事件与订单桶/复合键，含模块→状态机地址归一化）、`plan`（计划发布与元数据模块事件）、`signal`（信号/授权/委派）、`stage`（阶段补丁与 hook 生命周期）、`docking`（dock 具名接口委托）、`task`（任务投影与提交信号推进）；`index.ts` 保持原 `projections.ts` 的对外导出面。
- `submissions/`、`stage-patches/`：relay 操作态（nonce/dedupe/回执）与链投影授权；遗留的 prepare/submit 路由只保留链侧可完成的路径，task/evidence 读取已迁 app。
- 其余：`api/`（链读/运维/relay 路由与边界）、`relay/`、`reconcile/`（投影与 relay 回执/尝试操作态）、`storage/`（projection store + 链侧 op state）、`config/`（链/relay/索引/运维 env）、`security/`、`chain-adapters/`、`proof-verifier/`、`shared/broadcast/`（在役广播链路的装配套件与 duplicate-transaction 车道单源）。
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
- `CHAIN_SERVICES_DATABASE_URL`: 链投影和 relay 操作态存储（唯一存储 env，PG-only，必须是 `postgres://` DSN；未设置时启动直接报错并提示用 docker 起库）
- `UVP_STATE_MACHINE_RELAYER_BROADCAST_ENABLED`: State Machine 广播开关
- `RECONCILE_WORKER_ENABLED`: 投影 + relay 回执对账
- `OPS_CONSOLE_ADMIN_IDS` / `CHAIN_SERVICES_ADMIN_TOKEN_HASHES`: 运维 admin 白名单与 token hash

非本地环境应使用持久数据库和对象存储，并通过安全预检。demo/fixture/mock 运行路径仅存在于 local 档（simulated 治理链适配器、内存广播等开发适配器），非 local 环境不含。

## 存储与测试（PG-only）

存储引擎只保留 Postgres：部署跑什么，本地与测试就跑什么。

- 本地起库用 `./scripts/with-postgres.sh`（内部复用 `uvp-deploy/deploy/scripts/lib/with-postgres.sh`，一次性 docker postgres，随机端口），把打印出的 DSN 填进 `CHAIN_SERVICES_DATABASE_URL`。
- `pnpm test` 会自动套一层 `./scripts/with-postgres.sh` 起 docker 库再跑 vitest；直接运行 `vitest`（绕过该脚本）时必须自带 `CHAIN_SERVICES_POSTGRES_TEST_URL` 指向一个可达的 Postgres。

## 迁移口径

系统未上线：`service/migrations/` 的迁移字节以 dev 活线为准，不承诺跨版本升级路径；已编号的迁移文件不再修改，需要结构变化时开新编号迁移。启动时 migration checksum 失配即拒启：按 `chain_services_migrations` 台账清账后重建该库。

## 记录计划编译产物（plan_artifacts）

`registerPlan` 上链后，运营者用 CLI 把编译器产出的 `OnchainHookPlanArtifact` 写入服务库（一次一个 artifact，不起 HTTP 服务、不扫描、不回填）：

```bash
cd uvp-chain-services/service
export CHAIN_SERVICES_DATABASE_URL='postgres://<user>:<password>@<host>:5432/<database>'
pnpm --silent run plan-artifact:record \
  --file ./artifacts/plan.json \
  --chain-id 31337 \
  --publisher 0x1111111111111111111111111111111111111111 \
  --dry-run
```

`--dry-run` 只做参数/产物校验并打印结果（连 DSN 都不需要）；去掉后写入并打印 `recorded: true`。建议先 dry-run，把输出的 `planId`/`planHash` 与 `PlanCommitted`/`PlanRegistered` 事件核对后再写。用 `pnpm --silent` 是为了让 stdout 只剩下面那一行 JSON。

- `--file`：编译器产出的 raw `OnchainHookPlanArtifact` JSON（不是 Store 草稿）。如果来自 `uvp-client plan compile --out`，该文件是 `{artifact, registerArgs, planId}` 包装对象，需要先取出其中的 `artifact`（CLI 只接受 raw artifact）。`schemaVersion` 必须等于编译器 `ONCHAIN_HOOK_PLAN_SCHEMA_VERSION`；未知字段、被篡改的 `planHash`、非法形状都会在任何写入前拒绝。
- `--chain-id`：目标链 ID（正整数）。
- 键必须是链上注册身份：`plan_hash = toSolidityRegisterPlanArgs(artifact).planHash`（运行时 planHash，不是 `artifact.planHash`），`plan_id = planIdForPublisher(publisher, plan_hash)`。`artifact.planId` 是编译器计划身份，**不是**链上 planId；用 `--publisher <address>` 推导，或把注册事件里的 planId 用 `--plan-id <bytes32>` 传入；两者同时给出时必须一致，否则拒绝。用错键不会报错但索引永远解析不到，是这条写路径要防的主要事故。
- 幂等：主键 `(chain_id, plan_id, plan_hash)` 加 `ON CONFLICT DO NOTHING`，重复执行成功且不新增行；写入前 store 会重算 planHash 并拒绝身份不符的记录（`PlanArtifactIdentityError`）。这样索引重建/提交造证只会读到与链上 planHash 对应的词表，不会静默退化为空词表。
- 迁移：CLI 不建表、不跑迁移。表不存在时原样报出 Postgres 错误并提示先跑 service migrations；本地/部署需要按上文「迁移口径」先完成迁移。
- DSN 只从 `CHAIN_SERVICES_DATABASE_URL` 读取，缺失或不是 `postgres://`/`postgresql://` 即失败；错误与日志不会回显 DSN 或密码。成功时 stdout 只有一行 `{"chainId":31337,"planId":"0x…","planHash":"0x…","recorded":true}`（dry-run 为 `recorded:false`），诊断走 stderr（默认不带 stack，`--verbose` 才打印）。

## 接口概览

匿名链读：

- `GET /chain/orders`、`GET /chain/orders/:orderId`、`GET /chain/orders/:orderId/tasks`
- `GET /chain/tasks`、`GET /chain/tasks/:taskId`
- `GET /chain/sync-state`、`GET /chain/snapshot`

身份投影：

- `GET /identity/bindings`（只读 `ProjectionStore`，无 review/descriptor/tx）

Relay 操作态 / 遗留 prepare：

- `POST /product/tasks/:taskId/prepare-submit`、`POST /product/tasks/:taskId/submit`
- `GET /product/submissions/:submissionId`
- `POST /product/tasks/:taskId/prepare-stage-executor-patch|prepare-stage-resource-patch`
- `POST /product/tasks/:taskId/submit-stage-executor-patch|submit-stage-resource-patch`

> prepare 的 task/evidence 读取已迁 app：链侧调用会 fail-closed 503；wallet claim 仅 local 可用。host 已指向 `uvp-app-backend`（:8788），这些遗留路由待 client/relay 写路径切换后删除。

运维：

- `GET /healthz`、`GET /readyz`
- `GET /admin/diagnostics`
- `GET /admin/ops/status`、`GET /admin/ops/summary`
- `POST /admin/ops/reconcile/run`、`POST /admin/ops/projections/rebuild`
- `GET /admin/ops/indexer/pending-steps`、`POST /admin/ops/indexer/pending-steps/retry`
- `POST /admin/ops/submissions/:id/retry`

V1 墓碑：

- `/product/order-drafts*`、`/product/orders/:id/{invites,participants}`、`/product/invites/*` 返回 `410 v1_order_surface_removed`。

### API 访问策略

- 链读、`/healthz`、`/readyz`：匿名。
- `/admin/*`：`x-uvp-admin-id` + `x-uvp-admin-role`；非 local 必须带 `x-uvp-admin-token`（`CHAIN_SERVICES_ADMIN_TOKEN_HASHES`），并受 `OPS_CONSOLE_ADMIN_IDS` 白名单约束。
- 遗留 prepare/submission 路由：local 只接受 self-reported wallet；非 local 返回 401 `wallet_identity_required`，等待 client/relay 签名路径。

精确请求与响应结构以 `src/api/routes`、投影 DTO 和自动化测试为准。

## 验证原则

测试覆盖现行协议不变量、权限边界、签名域、索引重放、重组恢复、持久化和公开接口；不再表达现行行为或风险的测试会被移除。持久化测试统一走 Postgres（见上文「存储与测试（PG-only）」）。
