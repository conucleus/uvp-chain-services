CREATE TABLE IF NOT EXISTS order_requirement_bundle (
  draft_id TEXT PRIMARY KEY,
  schema_version TEXT NOT NULL,
  declaration_json TEXT NOT NULL,
  requirements_hash TEXT NOT NULL,
  declared_by TEXT NOT NULL,
  declared_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (draft_id) REFERENCES product_order_draft (draft_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS order_requirement_consent (
  consent_id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  requirements_hash TEXT NOT NULL,
  signature TEXT NOT NULL,
  signed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (draft_id) REFERENCES order_requirement_bundle (draft_id) ON DELETE CASCADE,
  UNIQUE (draft_id, wallet_address)
);

CREATE INDEX IF NOT EXISTS order_requirement_consent_draft_idx
  ON order_requirement_consent (draft_id, created_at);
