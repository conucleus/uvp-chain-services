CREATE TABLE IF NOT EXISTS chain_index_cursor (
  chain_id INTEGER NOT NULL,
  contract_address TEXT NOT NULL,
  deployment_block NUMERIC NOT NULL,
  next_block NUMERIC NOT NULL,
  finalized_block NUMERIC,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (chain_id, contract_address)
);

CREATE TABLE IF NOT EXISTS chain_event_log (
  chain_id INTEGER NOT NULL,
  contract_address TEXT NOT NULL,
  block_number NUMERIC NOT NULL,
  transaction_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  event_name TEXT NOT NULL,
  args_json JSONB NOT NULL,
  removed BOOLEAN NOT NULL DEFAULT FALSE,
  block_hash TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (chain_id, contract_address, block_number, log_index),
  UNIQUE (chain_id, contract_address, event_id)
);

CREATE INDEX IF NOT EXISTS chain_event_log_order_idx
  ON chain_event_log (chain_id, block_number, log_index);

CREATE TABLE IF NOT EXISTS chain_projection_snapshot (
  chain_id INTEGER NOT NULL,
  contract_address TEXT NOT NULL,
  snapshot_kind TEXT NOT NULL,
  snapshot_version INTEGER NOT NULL,
  snapshot_json JSONB NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (chain_id, contract_address, snapshot_kind)
);
