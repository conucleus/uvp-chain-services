-- U-068: keep the plan-scoped identity at the durable submission boundary.
-- plan_id is NOT NULL and declared on the submission tables from migration 0002
-- (system not launched; no nullable legacy rows or backfill path are kept).
-- CS-P5: the business key uniqueness lives on submission_prepare (one prepare
-- per business key); submission rows are append-only per submission_id and may
-- repeat the key across retries of the same prepare.
DROP INDEX IF EXISTS submission_business_key_idx;

CREATE UNIQUE INDEX IF NOT EXISTS submission_business_key_idx
  ON submission_prepare (plan_id, order_id, task_id, submitter, signal_name, nonce);

CREATE INDEX IF NOT EXISTS submission_prepare_plan_order_idx
  ON submission_prepare (plan_id, onchain_order_id);
