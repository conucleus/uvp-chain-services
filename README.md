<p align="right">
  <strong>English</strong> | <a href="./README.zh.md">简体中文</a>
</p>

# uvp-chain-services

Non-trusted service boundary for the EVM-native UVP track.

This domain owns indexers, projection storage, generic chain reads, identity
projection reads, and chain/admin diagnostics. Business rows, wallet sessions,
evidence, governance writes, Product APIs, and signed-operation relay live
outside this process. The concrete package is:

- `service/`: chain services workspace package.

## Development Topology

This repository is mounted by `uvp-eth` as a Git submodule. The service package
depends on `@uvp-eth/compiler`, `@uvp-eth/protocol-bindings`,
`@uvp-eth/chain-read-contract`, and `@uvp-eth/statemachine`, which are owned by
`uvp-protocol`. Use the `uvp-eth` umbrella checkout for local integration
development so pnpm can resolve those cross-repository `workspace:*`
dependencies. A standalone checkout requires the protocol packages to be
published or linked into an equivalent local workspace.

Services may cache and project chain facts, but they must not become the source
of truth for plans, orders, signals, hooks, or identity bindings. Chain
Services does not broadcast transactions, hold a gas-payer or business-signing
key, or accept prepare/submit operations: signed operations are delivered
directly or through an app-owned relay, and this process only indexes the
resulting contract events. Its configuration surface therefore contains no
relayer, private-key, broadcast, or receipt-reconcile settings. Rebuildability
from contract events is the default rule.

This domain implements the service-side convergence gate for chain projections,
plan artifacts, generic chain reads, and operator diagnostics. Product Schema,
Store authoring, evidence, governance review, and all business HTTP surfaces are
owned by `uvp-app-backend`.

The `/chain/*` wire DTOs and runtime decoders are owned by
`@uvp-eth/chain-read-contract`; this service keeps only indexer-internal
projection types and serializes them through `toWire`.

## Deployment Assumptions

The service assumes a single indexer/writer instance per database: projection
cursor updates, migration runs, and indexer pending post-commit sweeps are
single-writer. Migration advisory locks make overlapping migration runs safe to
reject, but running multiple indexer/API instances that advance the same
projection is not a supported topology; horizontal scaling requires
single-writer partitioning first.

## API Access Policy

Chain reads (`/chain/*`), `GET /identity/bindings`, `GET /healthz`, and
`GET /readyz` are anonymous. `/admin/*` surfaces require admin headers
(`x-uvp-admin-id` / `x-uvp-admin-role`); outside the `local` runtime profile
they also require `x-uvp-admin-token` matching
`CHAIN_SERVICES_ADMIN_TOKEN_HASHES`, plus the `OPS_CONSOLE_ADMIN_IDS`
allowlist. Admin ops can rebuild the projection and sweep indexer pending
post-commit steps; they cannot create business signatures or chain state, and
there is no submission/stage-patch retry endpoint.
