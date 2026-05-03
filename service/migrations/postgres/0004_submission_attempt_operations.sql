ALTER TABLE submission_attempt ADD COLUMN order_id TEXT;
ALTER TABLE submission_attempt ADD COLUMN source_id TEXT;
ALTER TABLE submission_attempt ADD COLUMN signal_id TEXT;
ALTER TABLE submission_attempt ADD COLUMN submitter TEXT;
ALTER TABLE submission_attempt ADD COLUMN block_number TEXT;
ALTER TABLE submission_attempt ADD COLUMN retryable BOOLEAN;
ALTER TABLE submission_attempt ADD COLUMN retry_state TEXT;
ALTER TABLE submission_attempt ADD COLUMN dead_letter BOOLEAN;
ALTER TABLE submission_attempt ADD COLUMN next_retry_at TEXT;

CREATE INDEX IF NOT EXISTS submission_attempt_order_idx
  ON submission_attempt (order_id, source_id, signal_id, submitter, attempt_number);

CREATE INDEX IF NOT EXISTS submission_attempt_retry_idx
  ON submission_attempt (retry_state, dead_letter, updated_at);
