# AGENTS.md

## Module Purpose

`uvp-chain-services/service/` owns non-trusted off-chain services around the contracts:
indexer, relayer boundary, proof verifier, trust APIs, and Product APIs.

These services improve usability but are never the source of truth.

## Responsibilities

- Index `UVPDeploymentRegistry`, `UVPStateMachine`, and `ZhixuTrustRegistry`
  events into queryable projections.
- Rebuild state-machine order, task, timeline, proof, and trust state from
  chain events.
- Accept user-signed EIP-712 payloads and relay them to contracts.
- Track transaction submission, confirmation, and retry status.
- Verify evidence hashes, metadata hashes, and Zhixu hashes for UI/API use.
- Serve product DTO APIs for `zhixu-store-web`.
- Serve Store Console read APIs and non-authoritative Store draft APIs such as
  docking sandbox sessions.
- Serve integration surfaces for `uvp-executor-kit/package/`.
- Mirror contract submitter authorization in Product APIs: static registration
  authorizations remain valid, and active stage executor overlays derive
  target-stage submit authority for the active stage executor.

## Non-Responsibilities

- Do not decide business state without chain events.
- Do not sign checker, executor, or adjudicator business messages.
- Do not store user private keys.
- Do not treat the service database as canonical.
- Do not expose `/product/flows` or make the product object a linear flow; the
  product object is a Zhixu order.

## Relayer Rules

- The relayer may pay gas and submit transactions.
- The relayer must verify payload structure before submission.
- The relayer must not replace signer, order id, stage id, signal, evidence hash,
  nonce, or deadline.
- Failed submissions must be observable and retryable.

## Indexer Rules

- Indexer state must be rebuildable from a configured deployment block.
- Every API record should retain chain id, contract address, block number, tx hash,
  and log index.
- State-machine plan/order projection keys must include chain id and
  state-machine address; bare order ids may be served only when unambiguous.
- Product draft registration must use the active deployment from the registry
  projection, while task submission must return to the order/task's original
  state-machine address.
- Reorg and finality policy must be explicit per network.
- Product DTOs should hide protocol internals from ordinary users and put raw
  event/source/signal details only in proof fields.
- Store docking sandbox sessions are drafts only: they may validate candidate
  signal maps, but they must not publish Zhixu definitions, register plans,
  create orders, or create signal authorization.

## Testing Expectations

- Local Anvil integration tests.
- Event replay from block zero.
- Database wipe and rebuild tests.
- Fake signer and malformed payload tests.
- Duplicate nonce handling tests.
