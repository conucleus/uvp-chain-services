CREATE TABLE IF NOT EXISTS chain_projection_sync_state (
  chain_id INTEGER NOT NULL,
  contract_address TEXT NOT NULL,
  sync_status TEXT NOT NULL,
  latest_indexed_block NUMERIC,
  finalized_block NUMERIC,
  confirmation_depth INTEGER NOT NULL DEFAULT 0,
  last_event_name TEXT,
  event_count INTEGER NOT NULL DEFAULT 0,
  rebuild_json JSONB,
  degraded_reason TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (chain_id, contract_address)
);
