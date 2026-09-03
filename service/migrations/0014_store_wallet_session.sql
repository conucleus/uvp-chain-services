-- PRD89: Store 钱包会话（challenge / session / account address）
CREATE TABLE IF NOT EXISTS store_auth_challenge (
  nonce TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  intent TEXT NOT NULL,
  account_id TEXT,
  message TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);

CREATE INDEX IF NOT EXISTS store_auth_challenge_address_idx
  ON store_auth_challenge (address, issued_at);

CREATE TABLE IF NOT EXISTS store_wallet_session (
  session_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL,
  anchored_address TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at TEXT,
  revoked_reason TEXT
);

CREATE INDEX IF NOT EXISTS store_wallet_session_account_idx
  ON store_wallet_session (account_id, expires_at);

CREATE TABLE IF NOT EXISTS store_account_address (
  address TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  status TEXT NOT NULL,
  anchored_at TEXT NOT NULL,
  anchor_session_id TEXT,
  revoked_at TEXT,
  revoked_by_session_id TEXT
);

CREATE INDEX IF NOT EXISTS store_account_address_account_idx
  ON store_account_address (account_id, status);
