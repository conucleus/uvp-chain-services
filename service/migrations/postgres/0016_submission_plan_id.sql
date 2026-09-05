-- U-068: keep the plan-scoped identity at the durable submission boundary.
-- plan_id is NOT NULL and declared on the submission table from migration 0002
-- (system not launched; no nullable legacy rows or backfill path are kept).
-- This migration only (re)builds the plan-scoped business key indexes.
DROP INDEX IF EXISTS submission_business_key_idx;

CREATE UNIQUE INDEX IF NOT EXISTS submission_business_key_idx
  ON submission (plan_id, order_id, task_id, submitter, signal_name, nonce);

CREATE INDEX IF NOT EXISTS submission_plan_order_idx
  ON submission (plan_id, onchain_order_id);
