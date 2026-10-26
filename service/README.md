# UVP Chain Services

Chain Services 把 UVP 链上事实投影成 Product 和运维接口，并负责证据存储、签名交易广播、回执对账及索引重建。投影可以删除后从链上重建，不是新的事实来源。

## 责任边界

- `UVPStateMachine` 及其冻结模块定义 Order、Stage、Signal、Plan 发布、提交授权和资源补丁。
- 计划词表（selectorBindings / signalCapabilities / executorCandidates）的唯一 off-chain 权威是 `plan_artifacts`：按 `(chain_id, plan_id, plan_hash)` 内容寻址、行级不可变；索引重建与提交造证只读该表。产物缺失即重建失败、提交造证 503，不得退化成空词表继续。当前没有 config publish 之外的产物写入 API（Store 草稿编译入口已随 B2 删除，需后续 publish/backfill 入口补齐）。
- `UVPIdentityRegistry` 只记录线下主体标识与链上账户的绑定和撤销。
- Chain Services 可以代付 gas，但业务签名仍由对应参与者产生，服务在任何路径上都不生成业务签名。代付广播的交易面保留在：plan-scoped 的 `submitSignalFor`（Signal 提交）、`applyStageExecutorPatchFor` / `applyStageResourcePatchFor`（stage 补丁代发）、`triggerOrderFromOutsideFor`（订单注册），以及治理身份注册/撤销（`registerIdentityBinding` / `revokeIdentityBinding`）。信号/补丁/触发提交均由 capability-proofs 单源（`@uvp-eth/compiler`，见 `src/submissions/capability-proofs.ts`）现场造证随交易携带。dock/timer keeper 等应用自动化已移出 chain-services（见 ARCHITECTURE Phase B）。
- 证据正文保存在链下，链上和投影层只保存可校验的哈希与资源句柄。

## 目录结构

`src/` 按链事实、投影、执行与业务数据分界（意见书 B2 结构治理后的目标布局）：

- `indexer/service.ts`：扫描与索引入口（增量刷新、重组回滚、`--rebuild` 全量重建）。
- `projection/plan-artifacts.ts`：计划编译产物表（`plan_artifacts`）的 Postgres store 与索引/语义 oracle 解析器；缺失产物抛 `PlanArtifactMissingError`。
- `indexer/replay.ts`：统一事件顺序与重放编排。`rebuildOrderProjections` 是投影重建的单一入口，同时推进部署注册表事件族与显式诊断计数（幻影订单、dock 未开启、激活缺补丁等不允许静默的计数）。
- `indexer/projections/`：按事件族与投影对象分文件——`proof`（事件参数解码与证明/时间线原语）、`snapshot`（重放快照形状与部署注册表读取）、`order`（订单事件与订单桶/复合键，含模块→状态机地址归一化）、`plan`（计划发布与元数据模块事件）、`signal`（信号/授权/委派）、`stage`（阶段补丁与 hook 生命周期）、`docking`（dock 具名接口委托）、`task`（任务投影与提交信号推进）；`index.ts` 保持原 `projections.ts` 的对外导出面。
- `product/application/`：产品用例与命令（订单草稿、证据、Signal/补丁/dock 提交编排）；`product/query/`：读模型与 BFF（含 `bff/` 各存储实现与 staging 就绪检查）。
- `store/`：仅保留 Product 写路径所需的最小 Store 面——`sessions`（钱包会话/JWT 身份）与 `console/access.ts`（身份解析）、`store-publishing.ts`（config publish 元数据）。Store 草稿、供应商、上架、入驻、装修、运营台等业务后端已随 Phase B2 删除，由 zhixu-registry 等独立服务接管。
- 其余：`api/`（HTTP 路由与边界）、`submissions/`、`stage-patches/`、`relay/`、`reconcile/`（relay 回执/尝试操作态）、`evidence/`、`governance/`、`storage/`、`config/`、`security/`、`chain-adapters/`、`proof-verifier/`、`shared/broadcast/`（两条在役广播链路的装配套件与 duplicate-transaction 车道单源）。

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
- `POST /product/evidence` 及证据读取
- 订单面只有 V3：`/product/v3/configs`、`/product/v3/order-drafts`（含
  invites/finalize）、`/product/v3/orders/:orderId`（订单/阶段/tasks 读，阶段
  状态从链投影派生）。V1 的 `POST /product/order-drafts`、`/product/invites/*`、
  `/product/orders/:id/{invites,participants}`、`/product/order-drafts/:id/requirements`
  已删除，统一返回 `410 v1_order_surface_removed`。
- Stage executor、resource、Signal 提交及 docked order link 流程

Store（仅会话身份面，Store 业务后端已删除）：

- `POST /store/auth/challenge`、`POST /store/auth/verify`、`POST /store/auth/logout`
- `GET /store/auth/addresses`、`POST /store/auth/addresses/revoke`、`GET /store/auth/session`
- `GET /store/session`：当前 Store 身份/角色的只读摘要

### API 访问策略

接口按三档身份门执行（以路由实际代码为准，本节是索引不是权威）：

- **参与者面**（Product 提交/触发档案/证据读取）：要求会话锚定钱包身份（匿名 `wallet_identity_required`）。
- **Store 会话面**：`/store/auth/*` 与 `GET /store/session` 解析 Store 身份（dev headers 或 JWT）；Store 业务读/写路由已随 Phase B2 删除，不再暴露运营数据面。
- **治理动作**（身份登记/撤销）：要求治理管理员。

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
