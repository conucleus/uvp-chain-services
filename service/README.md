# UVP Chain Services

Chain Services 把 UVP 链上事实投影成 Product、Store 和运维接口，并负责证据存储、签名交易广播、回执对账及索引重建。投影可以删除后从链上重建，不是新的事实来源。

## 责任边界

- `UVPStateMachine` 及其冻结模块定义 Order、Stage、Signal、Plan 发布、提交授权和资源补丁。
- `UVPIdentityRegistry` 只记录线下主体标识与链上账户的绑定和撤销。
- Store 的供应商档案、能力标签、搜索、推荐、审核记录均为链下经营数据，不形成协议级信用或平台担保。
- Chain Services 可以代付 gas，但业务签名仍由对应参与者产生。
- 证据正文保存在链下，链上和投影层只保存可校验的哈希与资源句柄。

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
- `CHAIN_SERVICES_DATABASE_DRIVER`, `CHAIN_SERVICES_DATABASE_URL`: 投影和业务存储
- `UVP_EVIDENCE_STORAGE_ADAPTER`: 证据存储适配器
- `UVP_STATE_MACHINE_RELAYER_BROADCAST_ENABLED`: State Machine 广播开关
- `RECONCILE_WORKER_ENABLED`: 交易回执对账

非本地环境应使用持久数据库和对象存储，并通过安全预检。仓库不含 demo/fixture/mock 运行路径。

## 接口概览

Product：

- `GET /product/zhixus`、`GET /product/zhixus/:zhixuId`
- `GET /product/orders`、`GET /product/orders/:orderId`
- `GET /product/tasks`、`GET /product/tasks/:taskId`
- `GET /product/me`、`GET /product/me/orders`、`GET /product/me/tasks`
- `GET /product/me/activity-feed`
- `POST /product/order-drafts` 及草稿确认、注册流程
- `POST /product/evidence` 及证据读取
- Stage executor、resource、Signal 提交及 docked order link 流程

Store：

- `GET /store/zhixus`
- `/store/zhixu-drafts` 下的导入、编辑、校验、编译与发布准备流程
- `/store/suppliers` 下的链下供应商档案与能力元数据
- `/store/docking-sessions` 下的凝结核工作流
- `GET /store/search`、`GET /store/audit`、`GET /store/runtime/summary`
- `GET /store/closure/dry-run`

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

测试覆盖现行协议不变量、权限边界、签名域、索引重放、重组恢复、持久化和公开接口；不再表达现行行为或风险的测试会被移除。
