<p align="right">
  <strong>English</strong> | <a href="./README.zh.md">简体中文</a>
</p>

# uvp-chain-services

Non-trusted service boundary for the EVM-native UVP track.

This domain owns indexers, relayers, proof projection, Product APIs, storage
adapters, submission services, and governance/admin APIs. The concrete package is:

- `service/`: chain services workspace package.

## Development Topology

This repository is mounted by `uvp-eth` as a Git submodule. The service package
depends on `@uvp-eth/compiler`, `@uvp-eth/product-dto`, and
`@uvp-eth/protocol-bindings`, which are owned by `uvp-protocol`.

Use the `uvp-eth` umbrella checkout for local integration development so pnpm can
resolve those cross-repository `workspace:*` dependencies. A standalone checkout
requires the protocol packages to be published or linked into an equivalent local
workspace.

Services may cache, project, relay, and translate chain facts, but they must not
become the source of truth for plans, orders, signals, hooks, identity bindings, funds,
approvals, releases, refunds, or disputes. Rebuildability from contract events is
the default rule.

This domain implements the service-side convergence gate for Product Schema v1,
dynamic stage executor authority, docked Zhixu projection language, resource
manifest/access state, Store authoring, proof/read models, operator audit, and
signal-container producer APIs.
