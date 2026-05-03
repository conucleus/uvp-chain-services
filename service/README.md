# chain-services

Non-trusted services for the EVM UVP runtime.

This module contains the indexer, relayer boundary, proof verifier, and APIs
used by the Store workbench and executor tools. The contracts remain the source
of truth.

Public status: alpha service runtime. It is suitable for protocol/product
experimentation and local rehearsals, not for production custody, settlement, or
audited operations.

Repo-split convergence is tracked by PRD109. This service must project the same
Product Schema v1, executor authority, docked Zhixu, resource manifest/access,
proof, identity/audit, and signal-container language as `@uvp-eth/product-dto`;
it must not promote Store metadata or prototype runtime gaps into chain truth.

## Scope

- `indexer`
  - reads `UVPStateMachine` and `ZhixuTrustRegistry` events from a configured
    deployment block;
  - rebuilds state-machine order/task/proof projections and trust projections;
  - stores query-friendly data that can be wiped and replayed.
- `relayer`
  - receives participant-signed EIP-712 payloads;
  - submits transactions with a gas-payer identity;
  - tracks submission, failure, confirmation, and retry status;
  - never creates executor business signatures.
- `notifications`
  - derives supplier delivery intents from finalized `HookReady`, order-level
    submitter authorization, and `ZhixuTrustRegistry` supplier trust;
  - stores retryable operational delivery state only;
  - never changes order, task, hook, signal, or trust truth.
- `proof-verifier`
  - checks metadata hash, evidence hash, and Zhixu hash alignment;
  - reports mismatches for UI/API use without deciding business state.
- `api`
  - exposes read models, trust queries, and product DTOs derived from chain
    events.

## Storage

Durable storage is adapter-backed. The default remains memory for tests and
prototype runs:

```text
CHAIN_SERVICES_DATABASE_DRIVER=memory|sqlite|postgres
CHAIN_SERVICES_DATABASE_URL=memory://projection-store
CHAIN_SERVICES_MIGRATIONS_AUTO_RUN=false
```

Local development can use SQLite:

```bash
CHAIN_SERVICES_DATABASE_DRIVER=sqlite \
CHAIN_SERVICES_DATABASE_URL=sqlite://./chain-services.sqlite3 \
CHAIN_SERVICES_MIGRATIONS_AUTO_RUN=true \
pnpm dev:api
```

Production, staging, and Base Sepolia testnet profiles require PostgreSQL. Run
migrations explicitly before production/staging service starts; testnet may
enable auto migrations for rehearsal only. SQLite remains a local/test adapter
for developer durable runs and storage contract coverage.

### Testnet Runtime Profile

`CHAIN_SERVICES_RUNTIME_ENV` in testnet mode is the Base Sepolia rehearsal
profile. It uses production-like fail-closed checks and requires PostgreSQL for
durable service state. Required env vars:

```text
CHAIN_SERVICES_RUNTIME_ENV
CHAIN_SERVICES_DATABASE_DRIVER
CHAIN_SERVICES_DATABASE_URL
CHAIN_SERVICES_MIGRATIONS_AUTO_RUN
SECURITY_PREFLIGHT_STRICT
UVP_CHAIN_ID
UVP_RPC_URL
UVP_ADDRESS_MANIFEST
UVP_PRODUCT_BFF_REGISTRATION_ADAPTER
UVP_PRODUCT_BFF_REGISTRAR_PRIVATE_KEY_ENV
UVP_STATE_MACHINE_RELAYER_BROADCAST_ENABLED
UVP_STATE_MACHINE_RELAYER_PRIVATE_KEY_ENV
UVP_EVIDENCE_STORAGE_ADAPTER
UVP_EVIDENCE_OBJECT_NAMESPACE
RECONCILE_WORKER_ENABLED
```

The address manifest, or `UVP_CONTRACTS_JSON`, must include `UVPStateMachine`
and `ZhixuTrustRegistry`. Testnet rejects memory/SQLite storage, implicit
database URLs, localhost RPC, any chain id other than `84532`, demo mode, E2E
fixture controls, permissive Product submission authorization, memory
registration, and Anvil default private keys. The relayer broadcast flag must
remain enabled with a configured gas-payer key. Database records remain
workflow/cache state only: indexed projections can be deleted and rebuilt from
contract events.

## Product API

`chain-services` exposes the first product-facing DTO layer. These routes
translate contract projections and registry attestations into language
`zhixu-store-web` can render:

```text
GET /product/zhixus
GET /product/zhixus/:zhixuId
GET /product/orders
GET /product/orders/:orderId
GET /product/orders/:orderId/timeline
GET /product/orders/:orderId/proof
GET /product/tasks
GET /product/tasks/:taskId
GET /product/me
GET /product/me/orders
GET /product/me/tasks
GET /product/me/tasks/:taskId
GET /product/staging/readiness
POST /product/tasks/:taskId/prepare-submit
POST /product/tasks/:taskId/submit
POST /product/tasks/:taskId/prepare-stage-executor-patch
POST /product/tasks/:taskId/submit-stage-executor-patch
POST /product/tasks/:taskId/prepare-stage-resource-patch
POST /product/tasks/:taskId/submit-stage-resource-patch
GET /product/submissions/:submissionId
POST /product/evidence
GET /product/evidence/:evidenceId
GET /product/evidence/:evidenceId/proof
```

`/product/zhixu` is accepted as a temporary singular alias from earlier drafts,
but `/product/zhixus` is the canonical route. `/product/flows` is intentionally
not implemented.

The Product API is projection-first. `/product/orders`, `/product/tasks`,
`/timeline`, and `/proof` prefer `UVPStateMachine` projections built from
`OrderRegistered`, `SignalSubmitted`, `HookStatusChanged`, `HookReady`, and
`TimerPoked`. Removed escrow-shaped events are ignored by product projections,
and demo DTOs are available only through explicit demo controls.
Chain-backed DTOs include projection metadata plus tx/block/event proof rows so
the UI can show when data came from replayed chain events.

Demo and fallback behavior is deliberately explicit. Local fixture catalog rows,
memory registration stores, permissive submission authorization, and E2E control
routes are development tools only. Non-local runtime profiles reject them during
config preflight.

Store Product Schema bundles may attach `addOnManifest` to role slots. These
manifests are Store metadata used to render ordinary participant pages and map
buttons to Product API actions. They are validated for role-slot, stage,
component, and input-binding consistency, but they do not authorize submission;
order-level submitter permissions and chain contracts remain authoritative.

`/product/me` is the participant-scoped entry for the ordinary fulfillment App.
It filters orders and tasks by an explicit wallet address from `wallet`,
`walletAddress`, `x-uvp-wallet-address`, or `x-wallet-address`. It does not
infer authority from labels; returned tasks still come from indexed
state-machine task projections and order-level submitter authorization.

Stage overlay routes let an authorized stage executor prepare and submit either
an order-level target-stage executor patch or a resource manifest patch.
`prepare-stage-executor-patch` returns EIP-712 typed data for executor
selection only; resource bundle fields are rejected. `prepare-stage-resource-patch`
binds `resourceKey`, `manifestHash`, `policyHash`, and `manifestURI` into a
separate stage-executor-signed payload, and production mode rejects legacy `http`,
`txcloud`, and `plain_text` resource handles. Submit routes verify signer
signature recovery and hand the signed payload to the configured relayer
adapter; when relayer broadcast is disabled, the API records
`broadcast_disabled` after signature verification instead of creating a selector
signature.

Versioned state-machine cutovers are read from `UVPDeploymentRegistry` events.
Plan/order projection keys include `(chainId, stateMachineAddress, id)`, and
Product order DTOs include `stateMachineAddress` plus `deploymentId` when known.
`GET /product/orders/:orderId` still accepts a bare order id when it is unique;
if the same order id exists on multiple state-machine deployments the API
returns `409 ambiguous_order_id` with candidate contract addresses. Draft submit
uses the current active deployment from the registry projection, while task
submit keeps using the task's original state-machine address.

`/product/zhixus` defaults to official-domain plans that are currently attested
and not revoked. Revoked plans are never treated as approved and are not
reintroduced through fallback. For local demos with no trust projection at all,
call `/product/zhixus?fallback=demo` to return the catalog fixture with
`chainAttestation.status = not_found`.

`GET /product/staging/readiness` is the Product API release-evidence gate. It
returns a redacted summary of staging profile, active deployment projection,
indexer status, Product order/task counts, plan trust, supplier trust, proof
event counts, evidence storage readiness, and configured role inputs. The route
returns `503 not_ready` unless staging preflight has passed, demo/E2E/permissive
fallbacks are off, the active deployment and chain projections exist, Product
orders/tasks/proofs are projected from chain events, plan trust is active, and no
submitter task is blocked by revoked supplier trust.

## Store Console API

The first nucleus-facing Store Console projection is separate from ordinary
Product routes:

```text
GET /store/search?q=<query>&type=<all|zhixu|order|supplier>&limit=<n>
GET /store/zhixus
GET /store/zhixus?query=<query>&lifecycle=<status>&review=<status>&trust=<status>
GET /store/zhixus/:zhixuId
GET /store/orders/:orderId/candidates
```

These routes return `StoreZhixuConsoleDTO` rows with lifecycle status, review
state, chain attestation, order count, open task count, supplier trust count,
and next action. `GET /store/zhixus/:zhixuId` returns a detail DTO that keeps
the console fields and adds business-stage, role-slot, supplier-requirement,
version, action, and proof sections. Store search returns typed Zhixu, order,
and supplier results, and ambiguous order ids route to candidates instead of
guessing a deployment context.

These routes are meant for nuclei and governance operators who manage order
definitions. They may show candidates that are not visible in the public Product
catalog, but they still do not make backend state authoritative: chain truth
remains `UVPStateMachine` and `ZhixuTrustRegistry` events.

### Store Docking Sandbox API

PRD56 adds session-scoped docking drafts for "试拼" signal maps:

```text
POST /store/docking-sessions
GET  /store/docking-sessions/:sessionId
POST /store/docking-sessions/:sessionId/validate
POST /store/docking-sessions/:sessionId/save-draft-map
```

Write routes require Store operator/admin headers such as
`x-uvp-store-user-id` plus `x-uvp-store-role=operator|admin` (the existing
`x-uvp-store-operator-id` / `x-uvp-store-operator-role` names are also
accepted). Missing write access returns `403 forbidden`.

Docking sessions are Store drafts only. Validation can report missing source
outputs, missing target inputs, incompatible payload hints, role-slot mismatch,
not-attested versions, and revoked versions. Saving a draft map does not mutate
Store Zhixu detail, Product catalog, official Zhixu definitions, plan
attestation, order registration, or order-level signal authorization.

## Store Zhixu Draft Workflow API

Store draft write routes keep import/review state off chain while compiling and
attesting through the protocol boundaries:

```text
POST /store/zhixu-drafts/import
GET  /store/zhixu-drafts/:draftId
POST /store/zhixu-drafts/:draftId/compile-preview
POST /store/zhixu-drafts/:draftId/submit-review
POST /store/zhixu-drafts/:draftId/request-attestation
```

`compile-preview` uses the compiler HookPlan and on-chain HookPlan artifact
generation; it does not hand-build plan or artifact hashes. `submit-review`
requires Store operator headers and writes a governance review.
`request-attestation` requires the existing governance admin headers and
delegates to the governance service, which recomputes metadata and policy
hashes before broadcast. A draft reaches `active` only when the trust projection
contains a matching `PlanAttested` event; draft storage is never a public
Product catalog source.

Local verification:

```bash
pnpm --filter @uvp-eth/chain-services exec vitest run tests/store-console-drafts.test.ts
```

### Store Supplier Registry API

PRD53 adds the Store supplier registry under the same nucleus/operator surface:

```text
GET  /store/suppliers?query=<q>&trust=<active|revoked|not_found>&tag=<tag>
GET  /store/suppliers/:supplierId
POST /store/suppliers
POST /store/suppliers/:supplierId/review
POST /store/suppliers/:supplierId/request-attestation
POST /store/suppliers/:supplierId/request-revocation
```

Write routes require `x-uvp-store-operator-id` with
`x-uvp-store-operator-role: store_operator | store_admin | admin`, or existing
admin/governance headers. Store supplier metadata, capability tags, supported
role slots, supported stages, and profile labels are off-chain Store metadata.
`trustStatus` is always derived from `ZhixuTrustRegistry` supplier projections;
requesting attestation or revocation delegates to governance actions and does
not fabricate chain trust before the indexer observes `SupplierAttested` or
`SupplierRevoked`.

Capability tags are limited to `logistics`, `customs`, `inspection`, `payment`,
`dispute-review`, and `document-verification`. Tag edits are recorded in the
Store metadata audit log. Tags help operators match candidates, but they do not
create `submitSignal` authorization. Product BFF order registration still
requires accepted participants and explicit order permission rows, and it
refuses revoked supplier wallets for future generated authorizations.

### Store Operator Auth And Audit

Phase 3 Store operator controls are tracked by PRD76, PRD78, and PRD79.

`/store/session` resolves the backend Store principal and capabilities. Local
and test profiles may use development headers, while staging and production
profiles require `STORE_AUTH_MODE=jwt` with JWKS, issuer, and audience config.
Missing identity returns `401`; authenticated but underprivileged access returns
`403`.

Phase 4 controlled operator pilots must use the JWT/JWKS path for every Store
operator request. The local pilot JWKS helper in
`uvp-deploy/deploy/scripts/store-pilot-jwks.ts` is only for a trusted local
staging rehearsal; remote chain-services deployments need a reachable HTTPS JWKS
identity source.

`GET /store/audit?resourceType=&resourceId=&actor=&action=&outcome=&limit=`
requires `store.audit.read` and returns redacted durable Store operator audit
records. Store audit is operational evidence only: it cannot create plan trust,
supplier trust, order state, signal authorization, or revocation truth.
Sensitive Store actions validate a Store-only `confirmation` body before side
effects.

### Local Product E2E Controls

The `/product/e2e/*` routes are local browser-test controls, not public Product
API. They are available only when both conditions are true:

```text
CHAIN_SERVICES_RUNTIME_ENV=local
UVP_PRODUCT_E2E_FIXTURES=1
```

Routes:

```text
POST   /product/e2e/fixtures/revoked-zhixu
DELETE /product/e2e/fixtures/revoked-zhixu
POST   /product/e2e/controls/syncing
DELETE /product/e2e/controls/syncing
```

When disabled, these routes return 404. The controls are in-memory only and do
not alter durable business state, chain events, Hook semantics, or replay
authority. They exist to make full browser negative scenarios deterministic:
revoked plan display and indexer-syncing UI state.

## Evidence API

Evidence Service v1 accepts JSON requests only; multipart uploads are not wired
yet. Send a mock principal with `x-uvp-principal-id` and, when needed,
`x-uvp-principal-role: admin | participant | checker | adjudicator`.

```bash
curl -X POST http://127.0.0.1:8787/product/evidence \
  -H 'content-type: application/json' \
  -H 'x-uvp-principal-id: seller' \
  --data '{
    "orderId": "order-1",
    "taskId": "task-1",
    "stageIdentifier": "export-documents",
    "documentType": "invoice",
    "fileName": "invoice.txt",
    "textPayload": "invoice payload",
    "metadata": {
      "businessLabel": "Commercial invoice",
      "fields": { "invoiceNo": "INV-1" }
    },
    "accessPolicy": { "readers": ["buyer"] }
  }'
```

Supported content forms are `textPayload`, `base64Payload`, `jsonPayload`, or
`content: { "encoding": "text" | "base64" | "json", "value": ... }`.
The service computes:

```text
contentHash = keccak256(file bytes)
metadataHash = keccak256(canonical JSON metadata)
payloadHash = keccak256(canonical JSON { contentHash, metadataHash, documentType, orderId, stageIdentifier })
```

File names and `evidenceId` are not part of `payloadHash`. The default API
server stores local bytes under `cache/evidence` (or `UVP_EVIDENCE_STORAGE_DIR`)
and keeps metadata in memory; tests use the in-memory storage adapter. Both
`memory://` and `local://` evidence storage adapters are non-production only.
Production-like runtime (`testnet`, `staging`, or `production`) must use a
production-safe object storage adapter and must expose private object URIs such
as `object://`, `s3://`, `gs://`, `azblob://`, or another non-public bucket
reference. Public HTTP download URLs, presigned query credentials, and embedded
bucket credentials are rejected at the Evidence Service boundary.

For Base Sepolia rehearsal without a cloud SDK, use the rehearsal object
adapter. It stores bytes in a run-scoped local directory but returns private
`object://` URIs, so Product DTOs and chain-bound hashes exercise the same
object-storage shape. This adapter is rehearsal-only and is not a production
credential or durability solution:

```text
UVP_EVIDENCE_STORAGE_ADAPTER=rehearsal-object
UVP_EVIDENCE_OBJECT_NAMESPACE=uvp-testnet-rehearsal
UVP_EVIDENCE_OBJECT_ROOT_DIR=./cache/evidence-object-testnet
```

`UVP_EVIDENCE_OBJECT_NAMESPACE` is a private namespace label, not a public
download host. Do not put access keys, presigned query strings, or public HTTP
URLs in evidence storage URI configuration or API responses.

No file plaintext is written on-chain. Product task submit resolves evidence,
verifies `contentHash` and `metadataHash`, signs only the resulting
`payloadHash`, and marks evidence `bound` only after a submitted or confirmed
state-machine transaction. Failed or disabled broadcasts do not mark evidence
bound.

Proof lookup:

```bash
curl http://127.0.0.1:8787/product/evidence/ev_xxx/proof \
  -H 'x-uvp-principal-id: buyer'
```

Access policy is participant based: owners and writers may upload, readers may
read, adjudicators may read only through `disputeReaders`, and admins may read
but every admin evidence/proof read is recorded in the evidence admin-read audit
store. Proof responses expose hashes, `payloadRef`, storage URI, verification
status, and bound signal ids; ordinary submission proof rows expose only
submission status, submitter, payload hash, transaction hash, and relayer error
codes.

## Wallet Submit / Submission API

Wallet Submit v1 prepares a browser-wallet EIP-712 payload, verifies the
returned signature, consumes the nonce, and stores an observable submission.
The default broadcast adapter is disabled. It records `signature_received`
status with `broadcastStatus = not_attempted`; that means the wallet signature
verified, not that anything was sent on-chain. When
`UVP_STATE_MACHINE_RELAYER_PRIVATE_KEY` is present, the API server wires a real
state-machine broadcaster that pays gas and calls
`UVPStateMachine.submitSignalFor(...)`.

Submitter authorization is also adapter-backed. Tests use an allow-list adapter
to cover unauthorized submitters; the default Product projection adapter is a
demo fallback until `SignalSubmitterAuthorized` or Product BFF permissions are
available as a canonical read model.

Prepare a task submission:

```bash
curl -X POST http://127.0.0.1:8787/product/tasks/task-1/prepare-submit \
  -H 'content-type: application/json' \
  -H 'x-uvp-principal-id: seller' \
  --data '{
    "evidenceIds": ["ev_xxx"],
    "walletAddress": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "intent": "confirm_stage"
  }'
```

The response includes `humanSummary` and `typedData` for
`eth_signTypedData_v4`. The typed-data message contains:

```text
orderId
sourceId
signalId
payloadHash
idempotencyKey
submitter
deadline
```

The human summary still includes the display `stageIdentifier`, `signalName`,
`payloadRef`, chain id, and verifying contract for UI review.

Submit the wallet signature:

```bash
curl -X POST http://127.0.0.1:8787/product/tasks/task-1/submit \
  -H 'content-type: application/json' \
  --data '{
    "prepareId": "prep_xxx",
    "walletAddress": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "signature": "0x..."
  }'
```

`submit` verifies signature recovery, rejects expired prepares, consumes the
submitter/order/stage/signal nonce, and rejects duplicate prepare reuse. With
the default adapter, the stored submission has:

```text
status = signature_received
broadcastStatus = not_attempted
errorCode = broadcast_disabled
```

To enable real local broadcast, set the deployed state-machine address through
the address manifest or `UVP_CONTRACTS_JSON`, then configure these environment
variables from a trusted shell or secret injector:

```text
UVP_STATE_MACHINE_RELAYER_BROADCAST_ENABLED
UVP_STATE_MACHINE_RELAYER_PRIVATE_KEY_ENV
UVP_STATE_MACHINE_RELAYER_PRIVATE_KEY
UVP_RELAYER_GAS_PAYER_ADDRESS
BROADCAST_MAX_IN_FLIGHT_PER_ORDER
BROADCAST_MAX_RETRY_ATTEMPTS
BROADCAST_RETRY_BASE_MS
BROADCAST_RETRY_MAX_MS
BROADCAST_RECEIPT_TIMEOUT_MS
```

The private key is read only from the environment and is used as the gas payer.
Broadcast failures are classified into API `errorCode` values such as
`unauthorized_signal_submitter`, `signal_already_exists`, `unknown_order`,
`expired_signal_signature`, `invalid_signal_signature`, `rpc_timeout`, and
`relayer_insufficient_funds`.

Query status:

```bash
curl http://127.0.0.1:8787/product/submissions/sub_xxx
```

Returned fields include `txHash?`, `blockNumber?`, `errorCode?`, `retryable`,
`retryState`, `deadLetter`, `attempts`, and `proofRows`. Each broadcast attempt
records the on-chain order/source/signal, submitter, gas payer, tx hash,
block number when known, retry state, and revert reason when available. Until a
broadcast adapter is enabled, `txHash` is absent and the submission is proof
that the wallet signature was verified, not that a state-machine signal was
submitted on-chain.

### Relayer Operations Runbook

Relayer boundary:

- The Product API prepares typed data and verifies the participant wallet
  signature. The relayer never creates or repairs business signatures.
- The state-machine broadcaster only pays gas and calls
  `UVPStateMachine.submitSignalFor(orderId, sourceId, signalId, payloadHash,
  idempotencyKey, submitter, deadline, signature)`.
- The relayer must not log private keys, full signatures, raw calldata, or
  evidence plaintext. API responses expose `signatureHash`, not the signature.

Operational cases:

- `relayer_insufficient_funds`: fund or rotate the gas payer, then retry only
  after the balance is visible on the configured RPC. Do not switch to a
  participant key.
- `rpc_timeout`: check RPC health and rate limits. The submission remains
  `failed` with `retryable = true` and a `txHash` when the write reached the
  RPC; reconcile the receipt before rebroadcasting.
- `broadcast_rate_limited`: per-order and per-submitter in-flight controls are
  active. Wait for the current attempt to finish or reconcile it.
- Nonce conflict / duplicate submit: duplicate prepare reuse is rejected before
  broadcast. Treat it as idempotency protection, not a chain failure.
- `transaction_reverted`: inspect attempt `revertReason`, `txHash`, and
  `blockNumber`. Do not mark the task successful unless chain events later
  prove the signal was accepted.
- `chain_id_mismatch`: stop the service, fix `UVP_CHAIN_ID` or `UVP_RPC_URL`,
  and rerun preflight before accepting traffic.
- `signal_already_exists`: reconcile chain projections. If the signal exists,
  the user should query the chain-backed task/order state instead of retrying.
- `unknown_order`: verify the order registration transaction and indexer
  replay. Retry only after the order exists on the same chain.
- Reorg after submission: rerun the reconcile worker from the deployment block
  or rebuild projections from events; the database is a cache, not authority.
- Private key rotation: drain in-flight attempts, update the injected relayer
  private key, run production preflight, confirm the derived gas payer, and
  restart. Never write the old or new key into docs, logs, tickets, or tests.

## Product BFF API

The first Product BFF lives inside `chain-services`. Local prototype runs use
an in-memory store for draft and invite state; durable profiles wire the same
records through the configured service store. It is product workflow state only;
contracts and indexed events remain the source of truth.

```text
POST /product/order-drafts
PATCH /product/order-drafts/:draftId
GET /product/order-drafts/:draftId
POST /product/orders/:draftId/invites
POST /product/invites/:inviteId/accept
POST /product/invites/:inviteId/reject
GET /product/orders/:draftId/participants
POST /product/order-drafts/:draftId/submit
GET /product/order-registrations/:registrationId
POST /product/order-registrations/:registrationId/retry
```

Draft creation and submit re-check the existing product/trust projection. A
plan must be attested and not revoked unless a caller explicitly opts into the
demo fallback for draft creation; submit still requires real attestation.
Submit validates required participants and wallets, builds server-side
`SignalAuthorization[]`, creates a stable `orderId`, and calls the configured
registration adapter for `UVPStateMachine.registerOrder(orderId, planId,
creator, authorizations)`.

The default registration adapter is an in-memory fake that leaves registration
`status = pending`; it does not mark the draft as chain-registered. Use the
Anvil-friendly adapter only when a deployed `UVPStateMachine` address and
registrar private key are configured:

```text
UVP_PRODUCT_BFF_REGISTRATION_ADAPTER
UVP_PRODUCT_BFF_REGISTRAR_PRIVATE_KEY_ENV
UVP_PRODUCT_BFF_REGISTRAR_PRIVATE_KEY
UVP_ORDER_REGISTRAR_ADDRESS
UVP_PRODUCT_BFF_WAIT_FOR_RECEIPT
UVP_PRODUCT_BFF_CREATOR_ADDRESS
```

`GET /product/order-registrations/:registrationId` returns `pending`,
`confirmed`, or `failed` plus `txHash?`, `blockNumber?`, `errorCode?`, and
`retryable`. Retry reuses the same `orderId` and only works for
`failed && retryable` registrations.

## Governance Admin API

Governance Admin stores official review, attestation, and revocation workflow
records through the configured service store. By default it uses a simulated
adapter and does not send transactions. Set `GOVERNANCE_BROADCAST_ENABLED=true`
to enable the server-side private-key broadcaster for `ZhixuTrustRegistry`.

Admin routes require mock headers:

```text
x-uvp-admin-id: admin-1
x-uvp-admin-role: admin
```

Supported routes:

```text
GET /admin/governance/reviews
POST /admin/governance/review-zhixu
POST /admin/governance/review-supplier
POST /admin/governance/attest-zhixu
POST /admin/governance/revoke-zhixu
POST /admin/governance/attest-supplier
POST /admin/governance/revoke-supplier
GET /admin/governance/tx/:txLogId
```

Review writes store `draft | submitted | approved_for_broadcast | approved |
restricted | rejected | revoked`, risk tags, public summary, internal notes,
`metadataHash`, `policyHash`, reviewer, and timestamps. `approved` is retained
as a legacy alias; new admin workflows should use `approved_for_broadcast`.
Admin review DTOs include `internalNotes`; public helper DTOs exclude them, and
rejected/revoked reviews are filtered out of public discovery. Restricted
reviews remain direct-viewable but are not recommended.

Attest endpoints generate the request DTOs expected by `ZhixuTrustRegistry`:

- plan attest: `domainId`, `planId`, `planHash`, `artifactHash`,
  generated `policyHash`, generated `metadataHash`, `metadataURI`;
- plan revoke: `domainId`, `planId`, generated `reasonHash`, `reasonURI`;
- supplier attest: `domainId`, `supplierSubjectId`, `wallet`, generated
  `profileHash`, `capabilityHash`, `reputationHash`, generated
  `metadataHash`, `metadataURI`;
- supplier revoke: `domainId`, `supplierSubjectId`, generated `reasonHash`,
  `reasonURI`.

All hash inputs use canonical JSON snapshots and exclude `internalNotes` from
on-chain-bound metadata. Client-supplied `metadataHash`, `policyHash`,
`profileHash`, `capabilityHash`, and `reputationHash` are ignored by the
service and recomputed before broadcast.

Real governance broadcast uses:

```text
GOVERNANCE_BROADCAST_ENABLED
GOVERNANCE_DOMAIN_ID
GOVERNANCE_SIGNER_PRIVATE_KEY
GOVERNANCE_SIGNER_ADDRESS
GOVERNANCE_DOMAIN_OWNER_ADDRESS
GOVERNANCE_RPC_URL
GOVERNANCE_CHAIN_ID
GOVERNANCE_TX_CONFIRMATIONS
GOVERNANCE_ALLOWED_OPERATORS
```

The broadcaster verifies the RPC chain id, requires the request `domainId` to
match `GOVERNANCE_DOMAIN_ID`, and checks that the signer is the registry domain
owner unless the signer is explicitly present in `GOVERNANCE_ALLOWED_OPERATORS`.
The allowed-operator setting is only a seam for future operator support; the
current contract still enforces `onlyDomainOwner`.

Tx logs expose `pending`, `broadcasting`, `indexing`, `confirmed`, or `failed`
state plus `retryable`. A submitted transaction that is waiting for receipt or
projection is still `pending`/`indexing` at the admin workflow layer. A
confirmed tx log does not make a plan public by itself; Product API visibility
and revoked blocking continue to come from the indexed `ZhixuTrustRegistry`
trust projection.

Supplier attest/revoke records are projected as public supplier trust status
(`attested` or `revoked`) but do not create `submitSignal` authority. Product
BFF order authorization is still generated only from the plan permission table
and accepted participant wallets; supplier trust can become an additional
future precondition without rewriting historical orders or signals.

## Notification Ops API

`notifications` implements registry-routed delivery as non-authoritative worker
logic. `UVPStateMachine` emits `HookReady`; the worker waits for finalized
projection state, resolves matching `SignalSubmitterAuthorized` records, checks
active supplier trust for the submitter wallet, reads the supplier notification
profile from `SupplierAttested.metadataURI`, and then records either a delivery
attempt or a skipped reason.

Supplier capability metadata may include supplier-owned notification transports.
`webhook`, `slack`, `email`, and `mcp` are platform-pushed transports;
`executor-watch` means the supplier listens to chain events directly and no push
call is made. The difference is automation depth only: Slack/email notify a
human lane, while MCP invokes an executor interface. MCP acceptance still does
not complete the task; only a later authorized `SignalSubmitted` event does.

```json
{
  "capability": {
    "notification": {
      "version": "uvp.supplierNotificationProfile.v1",
      "transports": [
        {
          "type": "webhook",
          "endpointRef": "secret://supplier-a/webhook",
          "priority": 10
        },
        {
          "type": "slack",
          "channelRef": "secret://supplier-a/slack/customs",
          "priority": 20
        },
        {
          "type": "email",
          "mailboxRef": "secret://supplier-a/email/ops",
          "priority": 30
        },
        {
          "type": "mcp",
          "serverRef": "secret://supplier-a/mcp/server",
          "toolName": "uvp.handleHookReady",
          "authRef": "secret://supplier-a/mcp/auth",
          "enabled": true
        },
        {
          "type": "executor-watch",
          "instructionsURI": "ipfs://supplier-a/executor-watch"
        }
      ]
    }
  }
}
```

The server recomputes `profileHash`, `capabilityHash`, `metadataHash`, and
`reputationHash`; client-supplied hashes are ignored. Profiles should contain
verifiable routing references only (`endpointRef`, `channelRef`, `mailboxRef`,
`serverRef`, `authRef`). Do not put webhook secrets, Slack tokens, mailbox
credentials, MCP auth material, business documents, invoice contents, logistics
files, or evidence plaintext in chain metadata.

Supplier management-center routes prepare and save a supplier-owned profile
update. The supplier wallet signs the normalized profile message; the returned
`attestSupplierInput` is the governance input that can be bound to
`SupplierAttested.metadataURI`/`capabilityHash`.

```text
POST /supplier/notifications/profile/prepare
POST /supplier/notifications/profile
GET /supplier/notifications/profile?wallet=:wallet
```

Admin routes require the same mock admin headers as governance routes:

```text
POST /admin/notifications/run-once
GET /admin/notifications/profiles
GET /admin/notifications/deliveries
POST /admin/notifications/deliveries/:deliveryId/retry
POST /admin/notifications/deliveries/:deliveryId/dead-letter
```

Delivery state is operational cache state: `pending | sent | failed | skipped |
dead_letter`, with optional `transportType`, `externalReceiptRef`, and MCP
`activationStatus: accepted | started | rejected`. It can be retried or
dead-lettered, but it cannot mark a task done or alter hook/order state. Only an
authorized wallet's `SignalSubmitted` event is state-machine truth. Local
verification:

```bash
pnpm --filter @uvp-eth/chain-services exec vitest run tests/notifications.test.ts
```

## Operator Key Role Handoff

PRD42 separates operator roles even when a rehearsal temporarily uses the same
testnet wallet for more than one role. Health diagnostics report role addresses
separately and never include private key material.

Role env vars:

```text
UVP_ETH_DEPLOYER_PRIVATE_KEY_ENV
UVP_ETH_DEPLOYER_PRIVATE_KEY
UVP_ETH_DEPLOYER_ADDRESS
UVP_STATE_MACHINE_OWNER_ADDRESS
UVP_PLAN_PUBLISHER_ADDRESS
UVP_ORDER_REGISTRAR_ADDRESS
UVP_PRODUCT_BFF_REGISTRAR_PRIVATE_KEY_ENV
UVP_PRODUCT_BFF_REGISTRAR_PRIVATE_KEY
UVP_RELAYER_GAS_PAYER_ADDRESS
UVP_STATE_MACHINE_RELAYER_PRIVATE_KEY_ENV
UVP_STATE_MACHINE_RELAYER_PRIVATE_KEY
UVP_REHEARSAL_PARTICIPANT_WALLETS
GOVERNANCE_DOMAIN_ID
GOVERNANCE_DOMAIN_OWNER_ADDRESS
GOVERNANCE_SIGNER_ADDRESS
GOVERNANCE_SIGNER_PRIVATE_KEY
GOVERNANCE_ADMIN_REVIEWER_IDS
```

Handoff rules:

- `CHAIN_SERVICES_ENV=testnet` is Base Sepolia rehearsal only, not production
  verified governance.
- Relayer gas payer keys pay gas for `submitSignalFor`; they must not be used
  as participant business signer keys.
- Registrar keys only broadcast Product BFF-approved order registrations.
- Governance admin review records are workflow state only. Public trust comes
  from indexed `ZhixuTrustRegistry` events.
- Key rotation drains in-flight registration, relay, and governance attempts
  before restart, then reruns config preflight and checks derived addresses.

## Observability And Ops Runbook

Operator diagnostics are safe summaries, not chain truth. Contracts and chain
events remain authoritative; health output only reports service ability to read,
rebuild, reconcile, relay, and store off-chain evidence references.

Routes:

```text
GET /healthz
GET /readyz
GET /admin/diagnostics
```

`/healthz` and `/readyz` expose only redacted operational fields: runtime
environment, chain id, configured contract addresses, indexer sync and rebuild
status, latest indexed/finalized blocks and lag, reconcile worker status,
submission counts and dead-letter summaries, governance tx counts, evidence
storage adapter readiness, and config preflight status. `/admin/diagnostics`
requires admin headers and returns the same safe operator view. None of these
routes exposes RPC URLs, private keys, full signatures, raw calldata, tokens,
presigned URLs, or evidence plaintext.

Structured logs include `requestId`; rehearsal callers may pass `x-uvp-run-id`
to correlate a run. Broadcast and reconcile logs include `txHash` and
`errorCode` when present. Error messages are redacted before they are returned
or logged.

Runbook cases:

- RPC timeout: check `/readyz` for `indexer_degraded` or `reconcile_error`,
  inspect the redacted `errorCode`, then verify the RPC provider out of band.
  If a write may have reached the RPC and a `txHash` exists, reconcile the
  receipt before retrying.
- chain id mismatch: stop the service, correct `UVP_CHAIN_ID`,
  `GOVERNANCE_CHAIN_ID`, or the RPC endpoint, rerun strict preflight, then
  restart. Do not accept Product traffic while `/readyz` reports
  `preflight_failed`.
- relayer insufficient funds: fund or rotate only the configured gas payer,
  wait until the balance is visible on the same RPC, then retry retryable
  submissions. Never substitute a participant wallet for the relayer gas payer.
- unauthorized submitter: verify the order-level authorization projected from
  the registered order. Do not override submitter, source id, signal id, or
  signature server-side.
- duplicate signal/idempotency conflict: treat `signal_already_exists`,
  `duplicate_submit`, or duplicate nonce failures as idempotency protection.
  Rebuild projections and show the chain-backed task state instead of forcing a
  new signal.
- dead-letter retry: inspect `/healthz` `submissions.deadLetters`. Retry only
  entries marked retryable; non-retryable dead-letter entries require correcting
  authorization, signature, order, or gas-payer configuration before a new user
  action is prepared.
- projection lag or projection rebuild: compare `latestIndexedBlock`,
  `finalizedBlock`, and `lagBlocks`. Run `pnpm --filter
  @uvp-eth/chain-services rebuild:indexer` after confirming the deployment
  block and contract addresses. The projection database can be wiped and
  rebuilt because it is not canonical.
- reorg: keep `UVP_FINALITY_CONFIRMATIONS` and `UVP_REORG_BUFFER_BLOCKS`
  explicit for the network. After a suspected reorg, rebuild from the deployment
  block and trust only the replayed event projection.
- evidence storage unavailable: check `evidenceStorage.readiness` and adapter
  kind. For testnet rehearsal use the object-style adapter; do not expose
  presigned URLs or embedded credentials. If storage is unavailable, pause new
  evidence uploads and keep existing chain hashes as the audit anchor.
- governance tx pending: `pending` or `indexing` means the tx is not yet proven
  by the trust projection. Check `txHash`, wait for receipt/finality, then let
  reconcile move it to `confirmed` only after the registry event is indexed.
- governance tx failed: inspect `errorCode`, domain id, signer address, and
  registry ownership. A failed governance tx does not publish or revoke a plan
  unless the chain event later proves it.
- safe key rotation: drain in-flight relayer/governance attempts, update the
  injected secret outside source control, run preflight, restart, and verify
  derived public addresses in diagnostics. The full handoff policy belongs to
  PRD42.

## Local Package

This directory is a standalone TypeScript package. It does not import or vendor
the Go UVP repository and does not depend on `uvp-deploy`.

```bash
pnpm --filter @uvp-eth/chain-services typecheck
pnpm --filter @uvp-eth/chain-services test
pnpm --filter @uvp-eth/chain-services dev:api
```

Local defaults use in-memory stores. The SQLite adapter persists projection,
Product BFF, evidence metadata, submission, and governance workflow records
behind the same interfaces without changing the trust boundary.

## Configuration

- `.env.example` documents local environment variables.
- `config/local.example.json` documents the same deployment shape as JSON.
- `UVP_ADDRESS_MANIFEST` or `UVP_ETH_ADDRESS_MANIFEST` can point at a
  `uvp-deploy/deploy/addresses/*.json` file; the service reads `UVPStateMachine` and
  `ZhixuTrustRegistry` addresses plus deployment blocks from it.
- `UVP_CONTRACTS_JSON` can override manifest contract addresses; zero-address
  entries are ignored so they do not erase manifest addresses.
- `UVP_DEPLOYMENT_BLOCK` overrides the manifest start point for replay.
- `UVP_INDEXER_POLL_INTERVAL_MS` controls live refresh from chain logs. Set it
  to `0` only for one-shot replay tests.
- `CHAIN_SERVICES_DATABASE_URL` points to service storage, not canonical state.
  `UVP_DATABASE_URL` remains a legacy local alias.

## Trust Boundary

If the database is deleted, the service must be able to rebuild its state from
chain events and deployment configuration. Any state that cannot be rebuilt this
way is not canonical.

The relayer may pay gas and submit transactions, but every business action must
arrive with a participant signature that verifies against the payload. The
relayer must not replace signer, order id, source id, signal id, payload hash,
idempotency key, or deadline, and it must not expose any API for creating business
signatures.

## Source Layout

- `src/config/` loads local service configuration.
- `src/indexer/` defines chain event replay and projection rebuilds.
- `src/storage/` defines projection-store interfaces and an in-memory adapter.
- `src/relayer/` defines signed payload relay, nonce, and submission tracking.
- `src/proof-verifier/` checks hash alignment for UI/API use.
- `src/api/` exposes a small read API router and Node server.
- `src/notifications/` derives and dispatches supplier-routed HookReady delivery
  attempts from finalized projections.
- `src/product/` maps projections into user-facing Zhixu/order/task DTOs.
- `tests/` contains focused unit coverage and Anvil-facing integration coverage.
