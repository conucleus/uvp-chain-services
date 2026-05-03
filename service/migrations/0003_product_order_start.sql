CREATE TABLE IF NOT EXISTS product_order_start (
  start_id TEXT PRIMARY KEY,
  registration_id TEXT NOT NULL UNIQUE,
  draft_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  status TEXT NOT NULL,
  tx_hash TEXT UNIQUE,
  block_number TEXT,
  error_code TEXT,
  error_message TEXT,
  retryable INTEGER NOT NULL,
  reconcile_status TEXT,
  last_checked_at TEXT,
  receipt_status TEXT,
  projection_status TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (registration_id) REFERENCES product_order_registration (registration_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS product_order_start_status_idx
  ON product_order_start (status, created_at);
