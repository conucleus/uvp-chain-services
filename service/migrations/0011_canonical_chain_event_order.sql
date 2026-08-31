DROP INDEX IF EXISTS chain_event_log_order_idx;

ALTER TABLE chain_event_log RENAME TO chain_event_log_legacy;

CREATE TABLE chain_event_log (
  chain_id INTEGER NOT NULL,
  contract_address TEXT NOT NULL,
  block_number TEXT NOT NULL,
  transaction_hash TEXT NOT NULL,
  transaction_index INTEGER,
  log_index INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  event_name TEXT NOT NULL,
  args_json TEXT NOT NULL,
  removed INTEGER NOT NULL DEFAULT 0,
  block_hash TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (chain_id, contract_address, block_number, transaction_hash, log_index),
  UNIQUE (chain_id, contract_address, event_id)
);

INSERT INTO chain_event_log (
  chain_id, contract_address, block_number, transaction_hash, transaction_index,
  log_index, event_id, event_name, args_json, removed, block_hash, created_at
)
SELECT
  chain_id, contract_address, block_number, transaction_hash, NULL,
  log_index, event_id, event_name, args_json, removed, block_hash, created_at
FROM chain_event_log_legacy;

DROP TABLE chain_event_log_legacy;

CREATE INDEX chain_event_log_order_idx
  ON chain_event_log (chain_id, block_number, transaction_index, log_index);
