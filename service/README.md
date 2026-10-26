# UVP Chain Services

Chain Services 把 UVP 链上事实投影成 Product、Store 和运维接口，并负责证据存储、签名交易广播、回执对账及索引重建。投影可以删除后从链上重建，不是新的事实来源。

## 责任边界

- `UVPStateMachine` 及其冻结模块定义 Order、Stage、Signal、Plan 发布、提交授权和资源补丁。
- 计划词表（selectorBindings / signalCapabilities / executorCandidates）的唯一 off-chain 权威是 `plan_artifacts`：按 `(chain_id, plan_id, plan_hash)` 内容寻址、行级不可变，由 Store 草稿编译落库；索引重建与提交造证只读该表。产物缺失即重建失败、提交造证 503，不再从 `store_zhixu_draft` 富集，也不得退化成空词表继续。
- `UVPIdentityRegistry` 只记录线下主体标识与链上账户的绑定和撤销。
- Store 的供应商档案、能力标签、搜索、推荐、审核记录均为链下经营数据，不形成协议级信用或平台担保。
- Chain Services 可以代付 gas，但业务签名仍由对应参与者产生，服务在任何路径上都不生成业务签名。代付广播的交易面不止一处：plan-scoped 的 `submitSignalFor`（Signal 提交）、`applyStageExecutorPatchFor` / `applyStageResourcePatchFor`（stage 补丁代发）、`triggerOrderFromOutsideFor`（订单注册）、`pokeTimer`（timer keeper 链上时钟拨表，`src/timer-keeper/` 的 `TimerKeeperWorker` 按投影轮询 waiting 且 dueAt 已到的 hook，keeper 用独立 env 私钥角色 `UVP_TIMER_KEEPER_PRIVATE_KEY`/`UVP_TIMER_KEEPER_ADDRESS`）、`submitDockedInput` / `submitDockedSignal`（dock keeper 活性提交），以及治理身份注册/撤销（`registerIdentityBinding` / `revokeIdentityBinding`）。信号/补丁/触发提交均由 capability-proofs 单源（`@uvp-eth/compiler`，见 `src/submissions/capability-proofs.ts`）现场造证随交易携带。dock keeper 装配口径：`submitDockedInput` / `submitDockedSignal` 是 permissionless 合约面，其 route 清单（binding 全集 + 预组装 open/attach calldata）只存在于云编译产物（`uvp.dockRoute.v2`）——链上事件只暴露已投递的 binding，链轨没有可重建清单的投影源，`DockAutomationWorker` 因此保持显式 no-op 直到云编译 route 数据库接入方接线 route source 与代付 submitter；staging readiness 探针（`/product/staging/readiness` 的 automation 摘要）呈现该装配状态。
- 证据正文保存在链下，链上和投影层只保存可校验的哈希与资源句柄。

## 目录结构

`src/` 按链事实、投影、执行与业务数据分界（意见书 B2 结构治理后的目标布局）：

- `indexer/service.ts`：扫描与索引入口（增量刷新、重组回滚、`--rebuild` 全量重建）。
- `projection/plan-artifacts.ts`：计划编译产物表（`plan_artifacts`）的 Postgres store 与索引/语义 oracle 解析器；缺失产物抛 `PlanArtifactMissingError`。
- `indexer/replay.ts`：统一事件顺序与重放编排。`rebuildOrderProjections` 是投影重建的单一入口，同时推进部署注册表事件族与显式诊断计数（幻影订单、dock 未开启、激活缺补丁等不允许静默的计数）。
- `indexer/projections/`：按事件族与投影对象分文件——`proof`（事件参数解码与证明/时间线原语）、`snapshot`（重放快照形状与部署注册表读取）、`order`（订单事件与订单桶/复合键，含模块→状态机地址归一化）、`plan`（计划发布与元数据模块事件）、`signal`（信号/授权/委派）、`stage`（阶段补丁与 hook 生命周期）、`docking`（dock 具名接口委托）、`task`（任务投影与提交信号推进）；`index.ts` 保持原 `projections.ts` 的对外导出面。
- `product/application/`：产品用例与命令（订单草稿、证据、Signal/补丁/dock 提交编排）；`product/query/`：读模型与 BFF（含 `bff/` 各存储实现与 staging 就绪检查）。
- `store/`：Store 链下业务数据的聚合目录——`sessions`（钱包会话与挑战）、`suppliers`（供应商档案）、`listings`、`join`（入驻申请）、`decoration`（店铺装修）、`console`（运营台：草稿编译、审计、closure、运行时视图）。供应商、会话和经营资料是链下业务数据，不属于"删除后从链重建"的范围。
- 其余：`api/`（HTTP 路由与边界）、`submissions/`、`reconcile/`、`dock-automation/`、`timer-keeper/`（链上时钟拨表 keeper）、`evidence/`、`stage-patches/`、`notifications/`、`governance/`、`storage/`、`config/`、`security/`、`chain-adapters/`、`proof-verifier/`、`shared/broadcast/`（两条在役广播链路的装配套件与 duplicate-transaction 车道单源）。

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
- `CHAIN_SERVICES_DATABASE_URL`: 投影和业务存储（唯一存储 env，PG-only，必须是 `postgres://` DSN；未设置时启动直接报错并提示用 docker 起库）
- `UVP_EVIDENCE_STORAGE_ADAPTER`: 证据存储适配器
- `UVP_STATE_MACHINE_RELAYER_BROADCAST_ENABLED`: State Machine 广播开关
- `RECONCILE_WORKER_ENABLED`: 交易回执对账

非本地环境应使用持久数据库和对象存储，并通过安全预检。demo/fixture/mock 运行路径仅存在于 local 档（simulated 治理链适配器、内存广播等开发适配器），非 local 环境不含。

## 存储与测试（PG-only）

存储引擎只保留 Postgres：部署跑什么，本地与测试就跑什么。

- 本地起库用 `./scripts/with-postgres.sh`（内部复用 `uvp-deploy/deploy/scripts/lib/with-postgres.sh`，一次性 docker postgres，随机端口），把打印出的 DSN 填进 `CHAIN_SERVICES_DATABASE_URL`。
- `pnpm test` 会自动套一层 `./scripts/with-postgres.sh` 起 docker 库再跑 vitest；直接运行 `vitest`（绕过该脚本）时必须自带 `CHAIN_SERVICES_POSTGRES_TEST_URL` 指向一个可达的 Postgres。

## 迁移口径

系统未上线：`service/migrations/` 的迁移字节以 dev 活线为准，不承诺跨版本升级路径；已编号的迁移文件不再修改，需要结构变化时开新编号迁移。启动时 migration checksum 失配即拒启：按 `chain_services_migrations` 台账清账后重建该库。

## 接口概览

Product：

- `GET /product/zhixus`、`GET /product/zhixus/:zhixuId`
- `GET /product/orders`、`GET /product/orders/:orderId`
- `GET /product/tasks`、`GET /product/tasks/:taskId`
- `GET /product/me`、`GET /product/me/orders`、`GET /product/me/tasks`
- `GET /product/me/activity-feed`
- `POST /product/registration`、`GET /product/registration/me`：参与者实体自助
  登记（链下档案；账号地址取会话锚定地址，单账号单活跃记录；状态恒为
  `self_declared`/未核验，响应 `verified:false`、`chainWritten:false`；不写链、
  不创建 supplier、不调用治理身份登记）
- `POST /product/evidence` 及证据读取
- 订单面只有 V3：`/product/v3/configs`、`/product/v3/order-drafts`（含
  invites/finalize）、`/product/v3/orders/:orderId`（订单/阶段/tasks 读，阶段
  状态从链投影派生）。V1 的 `POST /product/order-drafts`、`/product/invites/*`、
  `/product/orders/:id/{invites,participants}`、`/product/order-drafts/:id/requirements`
  已删除，统一返回 `410 v1_order_surface_removed`。
- Stage executor、resource、Signal 提交及 docked order link 流程

Store：

- `GET /store/zhixus`
- `/store/zhixu-drafts` 下的导入、编辑、校验、编译与发布准备流程
- `/store/suppliers` 下的链下供应商档案元数据
- `/store/docking-sessions` 下的凝结核工作流
- `GET /store/search`、`GET /store/audit`、`GET /store/runtime/summary`
- Store 运行时读端点（订单/任务的运营视图）：
  - `GET /store/zhixus/:zhixuId/orders`
  - `GET /store/orders/:orderId/observation`
  - `GET /store/orders/:orderId/replay`
  - `GET /store/orders/:orderId/audit-summary`
- `GET /store/orders/:orderId/candidates`（歧义订单消歧页，产品向）

### API 访问策略

接口按三档身份门执行（以路由实际代码为准，本节是索引不是权威）：

- **参与者面**（Product 提交/触发档案/证据读取、实体登记读写、`/store/orders/:orderId/candidates`）：要求会话锚定钱包身份（匿名 `wallet_identity_required`）。candidates 只携带部署级元数据，不含钱包或提交者映射。
- **Store 公共读**（匿名可读）：`/store/zhixus`、`/store/search` 等公开目录面。
- **运营观察面**（需 Store read 角色，匿名与纯钱包会话不可读）：`/store/audit`、`/store/runtime/summary`、`/store/zhixu-series/:seriesId/versions`、`/store/zhixus/:zhixuId/orders`、`/store/orders/:orderId/{observation,replay,audit-summary}`。这些响应含全部订单的 submitter 地址、tasks assigneeWallet 与参与者钱包映射（无参与者过滤）——持有者是运营方/管理员钱包会话，以及 dev/JWT 形态的 reader 及以上身份；任意第三方钱包 SIWE 会话不因"有锚定会话"即得全量运营数据。`/store/audit` 在此之上按租户过滤：非管理员（reader/operator）只能读到自己 actor 名下的审计记录，管理员保留全量视角。
- **试拼会话归属**：`/store/docking-sessions` 的会话档案（含 draftSignalMap）按创建者锚定地址做租户归属断言——非创建者读 404（与不存在同响应）、写 403；管理员保留跨租户治理可见性。
- Store 写操作面（草稿导入/编译、schema 保存、listing/supplier/docking 管理）要求 `store_operator`；版本激活/废弃与治理动作（草稿审核、身份登记/撤销）分别要求 `store_admin` / 治理管理员。

治理与身份：

- `GET /admin/governance/reviews`
- `POST /admin/governance/review-zhixu`
- `POST /admin/governance/review-supplier`
- `POST /admin/governance/register-identity`
- `POST /admin/governance/revoke-identity`
- `GET /identity/bindings`

运维：

- `GET /healthz`、`GET /readyz`
- `GET /admin/diagnostics`
- `GET /admin/ops/status`、`GET /admin/ops/summary`
- `POST /admin/ops/reconcile/run`
- `POST /admin/ops/projections/rebuild`

精确请求与响应结构以 `src/api/routes`、Product DTO 和自动化测试为准。

## 验证原则

测试覆盖现行协议不变量、权限边界、签名域、索引重放、重组恢复、持久化和公开接口；不再表达现行行为或风险的测试会被移除。持久化测试统一走 Postgres（见上文「存储与测试（PG-only）」）。
