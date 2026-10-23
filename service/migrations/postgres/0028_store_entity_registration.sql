-- 参与者实体自助登记档案（链下，非身份核验）。
--
-- 只记录参与者自己申报的实体信息，用于 v1「实体登记 + 人工核验 + 钱包绑定」
-- 的最小闭环；不写链、不创建供应商、不冒充 UVPIdentityRegistry 身份绑定。
-- 核验状态只有 self_declared（自助登记、未核验）与 pending_review（待人工
-- 核验）；verified 不在库内落 true，接口恒返回 false。
--
-- 单账号单活跃记录：account_address 唯一（重复提交走更新，不追加第二条）。
CREATE TABLE IF NOT EXISTS store_entity_registration (
  registration_id TEXT PRIMARY KEY,
  account_address TEXT NOT NULL,
  account_id TEXT,
  legal_name TEXT NOT NULL,
  registration_number TEXT NOT NULL,
  contact_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('self_declared', 'pending_review')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS store_entity_registration_account_uk
  ON store_entity_registration (account_address);
