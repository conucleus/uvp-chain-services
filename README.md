<p align="right">
  <strong>English</strong> | <a href="./README.zh.md">简体中文</a>
</p>

# uvp-chain-services

Non-trusted service boundary for the EVM-native UVP track.

This domain owns indexers, projection storage, relay operation state, generic
chain reads, and chain/admin diagnostics. Business rows, wallet sessions,
evidence, governance writes, and Product APIs live in `uvp-app-backend`. The
concrete package is:

- `service/`: chain services workspace package.

## Development Topology

This repository is mounted by `uvp-eth` as a Git submodule. The service package
depends on `@uvp-eth/compiler`, `@uvp-eth/product-dto`, and
`@uvp-eth/protocol-bindings`, which are owned by `uvp-protocol`.

Use the `uvp-eth` umbrella checkout for local integration development so pnpm can
resolve those cross-repository `workspace:*` dependencies. A standalone checkout
requires the protocol packages to be published or linked into an equivalent local
workspace.

Services may cache, project, and relay chain facts, but they must not become
the source of truth for plans, orders, signals, hooks, or identity bindings.
The relayed transaction surfaces kept here are the plan-scoped `submitSignalFor`
broadcast of participant-signed signals and stage patches
(`applyStageExecutorPatchFor` / `applyStageResourcePatchFor`); order registration,
governance identity registration/revocation, and the business prepare
orchestration in front of them are being retired in favour of client-signed
operations. Signal and patch submissions carry capability proofs minted on the
spot by the capability-proofs single source (`@uvp-eth/compiler`) inside the
transaction.
Dock keeper assembly: `submitDockedInput` / `submitDockedSignal` are
permissionless contract surfaces, and their route rosters (the binding sets plus
the pre-assembled open/attach calldata) exist only in cloud-compile artifacts
(`uvp.dockRoute.v2`) — chain events expose delivered bindings only, so the
chain track has no projection source from which the roster could be rebuilt.
The `DockAutomationWorker` in the API server therefore stays an explicit no-op
until the cloud-compile route database integrator wires a route source and a
paid-gas submitter; the staging readiness probe surfaces this assembly state.
Relayers pay gas and carry no business-action vocabulary of their own.
Rebuildability from contract events is the default rule.

This domain implements the service-side convergence gate for chain projections,
plan artifacts, relay operation state, generic chain reads, and operator
diagnostics. Product Schema, Store authoring, evidence, and governance review
surfaces are owned by `uvp-app-backend`.

The `/chain/*` wire DTOs and runtime decoders are owned by
`@uvp-eth/chain-read-contract`; this service keeps only indexer-internal
projection types and serializes them through `toWire`.

## Deployment Assumptions

The service assumes a single writer instance per database. The BFF trigger
lock, broadcast dedupe claims, in-flight broadcast rate limiting, and stage
patch nonce reservations are process-local: the "at most one in-flight
broadcast per order/submitter" and "one trigger per draft" guarantees hold only
while a single process owns the API and relaying loops. Races that cross the
process boundary are arbitrated by storage constraints and conditional
updates (invite single-active, join decisions, wallet-to-role binding,
migration advisory locks), but running multiple API/relayer instances against
one database is not a supported topology; horizontal scaling requires
single-writer partitioning first.

## API Access Policy

Chain reads, `GET /healthz`, and `GET /readyz` are anonymous. `/admin/*`
surfaces require admin headers (`x-uvp-admin-id` / `x-uvp-admin-role`); outside
the `local` runtime profile they also require `x-uvp-admin-token` matching
`CHAIN_SERVICES_ADMIN_TOKEN_HASHES`, plus the `OPS_CONSOLE_ADMIN_IDS`
allowlist. Wallet sessions and participant-scoped Product reads are served by
`uvp-app-backend`; the remaining legacy prepare routes fail closed outside
`local`.
