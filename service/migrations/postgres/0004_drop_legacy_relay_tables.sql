-- Drop the legacy relay/prepare op-state tables after submissions/stage-patches/
-- relay/reconcile were removed. No surviving chain code reads them; the client
-- signs and relays its own operations. plan_artifacts and chain projection
-- tables are intentionally untouched.
DROP TABLE IF EXISTS submission;
DROP TABLE IF EXISTS submission_prepare;
DROP TABLE IF EXISTS submission_attempt;
DROP TABLE IF EXISTS submission_nonce;
DROP TABLE IF EXISTS stage_patch_prepared;
DROP TABLE IF EXISTS stage_patch_submission;
DROP TABLE IF EXISTS stage_patch_nonce;
DROP TABLE IF EXISTS broadcast_dedupe_state;
DROP TABLE IF EXISTS broadcast_dedupe_tx_owner;
