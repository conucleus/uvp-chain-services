CREATE TABLE IF NOT EXISTS order_config_v3 (
  config_id TEXT NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  plan_id TEXT,
  plan_hash TEXT,
  birth_json TEXT,
  bundle_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  published_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (config_id, version)
);

CREATE INDEX IF NOT EXISTS order_config_v3_config_idx
  ON order_config_v3 (config_id, status);

CREATE TABLE IF NOT EXISTS order_draft_v3 (
  draft_id TEXT PRIMARY KEY,
  config_id TEXT NOT NULL,
  config_version TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  buyer_wallet TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  state_machine TEXT NOT NULL,
  title TEXT NOT NULL,
  currency TEXT NOT NULL,
  stage_subset_json TEXT NOT NULL,
  status TEXT NOT NULL,
  terms_hash TEXT,
  finalize_nonce TEXT,
  finalize_deadline TEXT,
  order_id TEXT,
  plan_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  frozen_at TEXT
);

CREATE INDEX IF NOT EXISTS order_draft_v3_buyer_idx
  ON order_draft_v3 (buyer_wallet, created_at);

CREATE TABLE IF NOT EXISTS order_stage_v3 (
  draft_id TEXT NOT NULL,
  stage_key TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  stage_index INTEGER NOT NULL,
  amount TEXT NOT NULL,
  slots_json TEXT NOT NULL,
  profile_ref TEXT,
  standard_json TEXT,
  final_standard_hash TEXT NOT NULL,
  invite_deadline TEXT NOT NULL,
  work_deadline TEXT NOT NULL,
  terms_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (draft_id, stage_key),
  UNIQUE (draft_id, stage_id),
  FOREIGN KEY (draft_id) REFERENCES order_draft_v3 (draft_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS order_stage_slot_v3 (
  draft_id TEXT NOT NULL,
  stage_key TEXT NOT NULL,
  slot_key TEXT NOT NULL,
  required INTEGER NOT NULL,
  subject_label TEXT,
  contact_ref TEXT,
  wallet TEXT,
  status TEXT NOT NULL,
  invite_id TEXT,
  accepted_terms_hash TEXT,
  accepted_at TEXT,
  signature TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (draft_id, stage_key, slot_key),
  FOREIGN KEY (draft_id, stage_key) REFERENCES order_stage_v3 (draft_id, stage_key) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS order_stage_slot_v3_wallet_idx
  ON order_stage_slot_v3 (draft_id, wallet);

CREATE TABLE IF NOT EXISTS order_invite_v3 (
  invite_id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL,
  stage_key TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  slot_key TEXT NOT NULL,
  subject_label TEXT NOT NULL,
  contact_ref TEXT,
  wallet TEXT,
  token_hash TEXT NOT NULL,
  nonce TEXT NOT NULL,
  status TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  accepted_by TEXT,
  accepted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (draft_id, stage_key) REFERENCES order_stage_v3 (draft_id, stage_key) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS order_invite_v3_single_active
  ON order_invite_v3 (draft_id, stage_key, slot_key)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS order_v3 (
  order_id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL UNIQUE,
  plan_id TEXT NOT NULL,
  state_machine TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  buyer_wallet TEXT NOT NULL,
  terms_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  tx_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (draft_id) REFERENCES order_draft_v3 (draft_id)
);

CREATE TABLE IF NOT EXISTS order_idempotency_v3 (
  principal_wallet TEXT NOT NULL,
  operation TEXT NOT NULL,
  idem_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  resource_id TEXT,
  response_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (principal_wallet, operation, idem_key)
);
