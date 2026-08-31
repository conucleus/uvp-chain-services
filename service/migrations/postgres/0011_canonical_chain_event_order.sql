ALTER TABLE chain_event_log
  ADD COLUMN IF NOT EXISTS transaction_index INTEGER;

ALTER TABLE chain_event_log
  DROP CONSTRAINT IF EXISTS chain_event_log_pkey;

ALTER TABLE chain_event_log
  ADD CONSTRAINT chain_event_log_pkey
  PRIMARY KEY (chain_id, contract_address, block_number, transaction_hash, log_index);

DROP INDEX IF EXISTS chain_event_log_order_idx;

CREATE INDEX chain_event_log_order_idx
  ON chain_event_log (chain_id, block_number, transaction_index, log_index);
