CREATE TABLE IF NOT EXISTS escrow_tranches (
  escrow_address TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  tranche_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  payer TEXT NOT NULL,
  payee TEXT NOT NULL,
  verifier TEXT NOT NULL,
  amount TEXT NOT NULL,
  observation_days INTEGER NOT NULL,
  fee_bps INTEGER NOT NULL,
  fee_recipient TEXT NOT NULL,
  state TEXT NOT NULL,
  approved_at TEXT,
  rejected_at TEXT,
  suspended_at TEXT,
  payer_amount TEXT,
  payee_amount TEXT,
  fee_amount TEXT,
  released_at TEXT,
  refunded_at TEXT,
  updated_at TEXT NOT NULL,
  block_number TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  PRIMARY KEY (escrow_address, tranche_id),
  UNIQUE (escrow_address, order_id, stage_id)
);

CREATE INDEX IF NOT EXISTS escrow_tranches_order_idx
  ON escrow_tranches (order_id, stage_id);
