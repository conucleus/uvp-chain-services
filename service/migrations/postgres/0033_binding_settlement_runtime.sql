-- V3 binding / settlement / runtime storage (B3).
-- Chain events are the only truth for deposits/settlements; product-side
-- accepted terms are the only truth for what should have been deposited.
-- tranche_id = keccak256(abi.encode(orderId, stageId, payer)); verifier C is
-- part of the accepted deposit terms and verdict instructions.
-- Foreign deposits are kept as state='foreign' but never become the stage tranche.

CREATE TABLE IF NOT EXISTS escrow_instance (
  chain_id INTEGER NOT NULL,
  escrow_address TEXT NOT NULL,
  token_address TEXT,
  contract_version TEXT NOT NULL,
  uvp_address TEXT,
  uvp_executor_address TEXT,
  deployment_block TEXT,
  start_block TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (chain_id, escrow_address)
);

CREATE TABLE IF NOT EXISTS tranche_binding (
  binding_id TEXT PRIMARY KEY,
  chain_id INTEGER NOT NULL,
  escrow_address TEXT NOT NULL,
  order_id TEXT NOT NULL,
  stage_key TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  tranche_id TEXT NOT NULL,
  payer TEXT NOT NULL,
  payee TEXT NOT NULL,
  verifier TEXT,
  amount TEXT NOT NULL,
  fee_bps INTEGER NOT NULL,
  fee_recipient TEXT NOT NULL,
  state TEXT NOT NULL,
  origin TEXT NOT NULL,
  terms_hash TEXT,
  deposit_tx_hash TEXT,
  deposit_block TEXT,
  deposit_log_index INTEGER,
  payer_amount TEXT,
  payee_amount TEXT,
  fee_amount TEXT,
  settled_tx_hash TEXT,
  settled_block TEXT,
  instruction_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (chain_id, escrow_address, tranche_id),
  UNIQUE (chain_id, escrow_address, order_id, stage_id, payer)
);

CREATE INDEX IF NOT EXISTS tranche_binding_order_idx
  ON tranche_binding (order_id, stage_id);
CREATE INDEX IF NOT EXISTS tranche_binding_stage_idx
  ON tranche_binding (chain_id, escrow_address, order_id, stage_id);

CREATE TABLE IF NOT EXISTS binding_deposit_intent (
  intent_id TEXT PRIMARY KEY,
  chain_id INTEGER NOT NULL,
  escrow_address TEXT NOT NULL,
  order_id TEXT NOT NULL,
  stage_key TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  tranche_id TEXT NOT NULL,
  payer TEXT NOT NULL,
  payee TEXT NOT NULL,
  verifier TEXT NOT NULL,
  amount TEXT NOT NULL,
  fee_bps INTEGER NOT NULL,
  fee_recipient TEXT NOT NULL,
  terms_hash TEXT NOT NULL,
  nonce TEXT NOT NULL,
  deadline TEXT NOT NULL,
  status TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  typed_data_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS binding_deposit_intent_active_stage_uk
  ON binding_deposit_intent (chain_id, escrow_address, order_id, stage_id)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS binding_index_cursor (
  chain_id INTEGER NOT NULL,
  escrow_address TEXT NOT NULL,
  start_block TEXT NOT NULL,
  next_block TEXT NOT NULL,
  last_block TEXT,
  last_block_hash TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (chain_id, escrow_address)
);

CREATE TABLE IF NOT EXISTS binding_event_anomaly (
  anomaly_id TEXT PRIMARY KEY,
  chain_id INTEGER NOT NULL,
  escrow_address TEXT NOT NULL,
  block_number TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  tx_hash TEXT NOT NULL,
  reason TEXT NOT NULL,
  details_json TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (chain_id, escrow_address, block_number, log_index, reason)
);

CREATE TABLE IF NOT EXISTS settlement_instruction (
  instruction_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  chain_id INTEGER NOT NULL,
  escrow_address TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  stage_key TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  tranche_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payer_amount TEXT NOT NULL,
  payee_amount TEXT NOT NULL,
  source_fact_id TEXT NOT NULL,
  payer TEXT,
  payee TEXT,
  verifier TEXT,
  uvp_executor_address TEXT,
  required_signers_json TEXT NOT NULL,
  payer_signature TEXT,
  payer_signer TEXT,
  payee_signature TEXT,
  payee_signer TEXT,
  verifier_signature TEXT,
  verifier_signer TEXT,
  instruction_ref TEXT NOT NULL,
  typed_data_hash TEXT NOT NULL,
  nonce TEXT NOT NULL,
  deadline TEXT NOT NULL,
  status TEXT NOT NULL,
  execute_eligible_at TEXT,
  blocked_by_dispute INTEGER NOT NULL DEFAULT 0,
  tx_hash TEXT,
  block_number TEXT,
  error_code TEXT,
  attempts INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS settlement_instruction_status_idx
  ON settlement_instruction (status, created_at);
CREATE INDEX IF NOT EXISTS settlement_instruction_order_idx
  ON settlement_instruction (order_id, stage_id);
CREATE INDEX IF NOT EXISTS settlement_instruction_tranche_idx
  ON settlement_instruction (chain_id, escrow_address, tranche_id);
CREATE INDEX IF NOT EXISTS settlement_instruction_ref_idx
  ON settlement_instruction (instruction_ref);

CREATE TABLE IF NOT EXISTS settlement_receipt (
  receipt_id TEXT PRIMARY KEY,
  instruction_id TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  escrow_address TEXT NOT NULL,
  order_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  tranche_id TEXT NOT NULL,
  payer_amount TEXT NOT NULL,
  payee_amount TEXT NOT NULL,
  fee_amount TEXT NOT NULL,
  instruction_ref TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  block_number TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  confirmed_at TEXT NOT NULL,
  UNIQUE (chain_id, escrow_address, tx_hash, log_index)
);

CREATE INDEX IF NOT EXISTS settlement_receipt_instruction_idx
  ON settlement_receipt (instruction_id);

CREATE TABLE IF NOT EXISTS runtime_time_rule (
  rule_id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  stage_key TEXT NOT NULL,
  name TEXT NOT NULL,
  expression TEXT NOT NULL,
  action_kind TEXT NOT NULL,
  payer_amount TEXT,
  payee_amount TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (order_id, stage_key, name)
);

CREATE TABLE IF NOT EXISTS runtime_due_fact (
  fact_key TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  stage_key TEXT NOT NULL,
  rule_name TEXT NOT NULL,
  action_kind TEXT NOT NULL,
  source_fact_id TEXT NOT NULL,
  basis_fact_ids_json TEXT NOT NULL,
  payer_amount TEXT,
  payee_amount TEXT,
  due_at TEXT NOT NULL,
  status TEXT NOT NULL,
  signal_submission_id TEXT,
  instruction_id TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS runtime_due_fact_order_idx
  ON runtime_due_fact (order_id, status);

CREATE TABLE IF NOT EXISTS runtime_signal_submission (
  submission_id TEXT PRIMARY KEY,
  fact_key TEXT NOT NULL UNIQUE,
  plan_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  stage_key TEXT NOT NULL,
  signal_name TEXT NOT NULL,
  executor TEXT NOT NULL,
  status TEXT NOT NULL,
  tx_hash TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL
);
