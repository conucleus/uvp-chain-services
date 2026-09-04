-- U-068: keep the plan-scoped identity at the durable submission boundary.
ALTER TABLE submission ADD COLUMN plan_id TEXT;

-- Existing prepared JSON already contains planId for rows created by the
-- plan-scoped signing path. Backfill the relational identity before rebuilding
-- the business-key index; legacy rows without it remain explicitly nullable
-- and are handled as legacy data by the read path.
UPDATE submission
SET plan_id = json_extract(prepared_json, '$.planId')
WHERE plan_id IS NULL
  AND json_extract(prepared_json, '$.planId') IS NOT NULL;

DROP INDEX IF EXISTS submission_business_key_idx;

CREATE UNIQUE INDEX IF NOT EXISTS submission_business_key_idx
  ON submission (plan_id, order_id, task_id, submitter, signal_name, nonce);

CREATE INDEX IF NOT EXISTS submission_plan_order_idx
  ON submission (plan_id, onchain_order_id);
