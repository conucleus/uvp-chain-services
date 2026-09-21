-- ETH-04(b)：通知 delivery / participant read 状态持久化；
-- ETH-07：safe broadcast 去重状态持久化（重启后仍可去重）。
CREATE TABLE IF NOT EXISTS notification_delivery (
  delivery_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  task_id TEXT,
  order_id TEXT NOT NULL,
  receiver_hook_id TEXT,
  receiver_stage_id TEXT,
  source_id TEXT,
  signal_id TEXT,
  payload_hash TEXT,
  idempotency_key TEXT,
  chain_id INTEGER NOT NULL,
  state_machine_address TEXT NOT NULL,
  submitter TEXT,
  supplier_subject_id TEXT,
  supplier_wallet TEXT,
  transport_type TEXT,
  activation_status TEXT,
  external_receipt_ref TEXT,
  reason TEXT,
  payload_json TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS notification_delivery_order_idx
  ON notification_delivery (order_id, created_at);

CREATE INDEX IF NOT EXISTS notification_delivery_status_idx
  ON notification_delivery (status, updated_at);

CREATE TABLE IF NOT EXISTS notification_read_state (
  participant_key TEXT NOT NULL,
  notification_id TEXT NOT NULL,
  read_at TEXT NOT NULL,
  PRIMARY KEY (participant_key, notification_id)
);

CREATE TABLE IF NOT EXISTS broadcast_dedupe_state (
  idempotency_key TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  last_result_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS broadcast_dedupe_tx_owner (
  tx_hash TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
