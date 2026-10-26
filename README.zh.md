<p align="right">
  <a href="./README.md">English</a> | <strong>简体中文</strong>
</p>

# uvp-chain-services

EVM 原生 UVP 方向的非信任服务边界。

本域负责 indexer、链投影存储、通用链读、身份投影读和 chain/admin 诊断。
业务行、钱包会话、证据、治理写路径、Product API 与签名交易的中继都在本进程
之外。当前具体 package 是：

- `service/`：chain services workspace package。

## 开发拓扑

本仓库由 `uvp-eth` 作为 Git submodule 挂载。`service` package 依赖
`@uvp-eth/compiler`、`@uvp-eth/protocol-bindings`、
`@uvp-eth/chain-read-contract` 和 `@uvp-eth/statemachine`，这些 package 由
`uvp-protocol` 拥有。本地集成开发请使用 `uvp-eth` umbrella checkout，这样
pnpm 可以解析这些跨仓库 `workspace:*` 依赖；独立 checkout 需要把 protocol
packages 发布出去，或链接到等价的本地 workspace。

Services 可以缓存、投影链上事实，但不能成为 plans、orders、signals、hooks 或
identity bindings 的事实来源。Chain Services 不广播交易、不持有 gas payer 或
业务签名 key、也不接收 prepare/submit 操作：已签名操作走 direct 或应用侧
relay，本进程只索引其产生的合约事件。默认规则是必须能从 contract events
重建投影。

本域实现 service 侧收束门禁，覆盖链投影、plan artifacts、通用链读与运维诊断。
Product Schema、Store authoring、证据、治理 review 与全部业务 HTTP 面由
`uvp-app-backend` 拥有。

`/chain/*` 的 wire DTO 与运行时 decoder 由 `@uvp-eth/chain-read-contract`
拥有；本服务只保留 indexer 内部投影类型，经 `toWire` 序列化。

## 部署假设

本服务假设每个数据库只有一个 indexer/写者实例：投影游标推进、迁移执行与
indexer pending post-commit sweep 都是单写者。迁移 advisory lock 会让重叠的
迁移运行显式失败而不是并发写，但多个 indexer/API 实例共写同一投影不是受支持
拓扑；横向扩展必须先做单写者分区。

## API 访问口径

链读（`/chain/*`）、`GET /identity/bindings`、`GET /healthz` 与 `GET /readyz`
匿名。`/admin/*` 需要 admin 头（`x-uvp-admin-id` / `x-uvp-admin-role`）；local
以外还要求 `x-uvp-admin-token` 匹配 `CHAIN_SERVICES_ADMIN_TOKEN_HASHES`，并受
`OPS_CONSOLE_ADMIN_IDS` 白名单约束。运维操作只能重建投影与重试 indexer pending
post-commit steps，不能生成业务签名或伪造链上状态；没有 submission/stage-patch
retry 端点。
