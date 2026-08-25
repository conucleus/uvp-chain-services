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

Services 可以缓存、投影、relay 和翻译链上事实，但不能成为 plans、orders、signals、hooks、identity bindings、funds、approvals、releases、refunds 或 disputes 的事实来源。默认规则是必须能从 contract events 重建。

本域实现 service 侧收束门禁，覆盖 Product Schema v1、dynamic stage executor authority、docked Zhixu projection language、resource manifest/access state、Store authoring、proof/read models、operator audit 和 signal-container producer APIs。
