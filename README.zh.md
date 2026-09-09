<p align="right">
  <a href="./README.md">English</a> | <strong>简体中文</strong>
</p>

# uvp-chain-services

EVM 原生 UVP 方向的非信任服务边界。

本域负责 indexer、relayer、proof projection、Product API、storage adapter、submission service 和 governance/admin API。当前具体 package 是：

- `service/`：chain services workspace package。

## 开发拓扑

本仓库由 `uvp-eth` 作为 Git submodule 挂载。`service` package 依赖 `@uvp-eth/compiler`、`@uvp-eth/product-dto` 和 `@uvp-eth/protocol-bindings`，这些 package 由 `uvp-protocol` 拥有。

本地集成开发请使用 `uvp-eth` umbrella checkout，这样 pnpm 可以解析这些跨仓库 `workspace:*` 依赖。独立 checkout 需要把 protocol packages 发布出去，或链接到等价的本地 workspace。

Services 可以缓存、投影、relay 和翻译链上事实，但不能成为 plans、orders、signals、hooks 或 identity bindings 的事实来源。中继的唯一交易面是 plan-scoped 的 `submitSignalFor` 广播（参与者已签名的信号）；relayer 只代付 gas，不携带自己的业务动作词表。默认规则是必须能从 contract events 重建。

本域实现 service 侧收束门禁，覆盖 Product Schema v1、dynamic stage executor authority、docked Zhixu projection language、resource manifest/access state、Store authoring、proof/read models、operator audit 和 signal-container producer APIs。

## API 访问口径

纯链上事实的投影保持公开：`GET /product/orders/:orderId/timeline` 与 `GET /product/orders/:orderId/proof` 匿名可读（链上事件是公开可回放真相）。与之相对，业务档案端点（`GET /product/submissions/:submissionId`、`GET /product/order-triggers/:triggerId` 与邀请预览 `GET /product/invites/:inviteId`）一律要求会话身份（邀请预览另需一次性 invite token）。local 运行档之外，管理/运营面还要求口令因子（`x-uvp-admin-token`）；明文白名单自报 admin 头仅限 local 开发档。
