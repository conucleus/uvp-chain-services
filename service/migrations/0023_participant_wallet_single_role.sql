-- 一钱包一角色（draft 内）：同一 draft 的已接受角色槽中，一个钱包最多
-- 占一个。UNIQUE (draft_id, role_slot_id) 只挡同槽双行；跨槽并发 accept
-- 的钱包查重发生在事务外（先查后写），双双通过后会留下同钱包双角色——
-- resolvePermissions 对每个槽各生成一份授权，同 submitter 双角色在链上
-- 无法兑现"一人一角色"的语义。裁决下沉到存储层：后提交者在索引上撞车，
-- 败者由服务层按 409 收敛。仅 accepted 且已绑钱包的行参与；invited/
-- rejected/未绑钱包行不受限。不同 draft 间同钱包多角色合法，键含
-- draft_id 即不在本索引语义内。
CREATE UNIQUE INDEX IF NOT EXISTS product_participant_accepted_wallet_per_draft_uk
  ON product_participant (draft_id, LOWER(wallet_address))
  WHERE status = 'accepted' AND wallet_address IS NOT NULL;
