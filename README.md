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
become the source of truth for plans, orders, signals, hooks, or identity
bindings. The relayed transaction surfaces are the plan-scoped `submitSignalFor`
broadcast of participant-signed signals plus several narrowly scoped paid-gas
submissions — stage patches (`applyStageExecutorPatchFor` /
`applyStageResourcePatchFor`), order registration
(`triggerOrderFromOutsideFor`), dock keeper liveness submissions
(`submitDockedInput` / `submitDockedSignal`), and governance identity
registration/revocation (`registerIdentityBinding` /
`revokeIdentityBinding`, see `service/README.md`). Delivery status of the dock
keeper surface: `submitDockedInput` / `submitDockedSignal` are permissionless
contract surfaces, and their service-side automation is not assembled in the
current delivery — the `DockAutomationWorker` in the API server runs as an
explicit no-op until a route source and a paid-gas submitter are wired (the
assembly point is provided by the cloud-compile route database integrator).
Relayers pay gas and carry no business-action vocabulary of their own.
Rebuildability from contract events is the default rule.

This domain implements the service-side convergence gate for Product Schema v1,
dynamic stage executor authority, docked Zhixu projection language, resource
manifest/access state, Store authoring, proof/read models, operator audit, and
signal-container producer APIs.

## API Access Policy

Order/task reads are participant-gated: `GET /product/orders/:orderId` (with
its `/timeline` and `/proof` views, which disclose participant wallets and
signer details) requires a session identity, and orders assigned to other
participants are indistinguishable from nonexistent (404). Business-record
endpoints (`GET /product/submissions/:submissionId`, `GET
/product/order-triggers/:triggerId`, and the invite preview `GET
/product/invites/:inviteId`) always require a session identity (the invite
preview additionally requires the one-time invite token). Outside the `local`
runtime profile, admin/ops surfaces additionally require a password factor
(`x-uvp-admin-token`); plaintext whitelisted self-declared admin headers are a
local-only development mode.
