-- 一钱包一角色（draft 内）：同一 draft 的已接受角色槽中，一个钱包最多
-- 占一个。UNIQUE (draft_id, role_slot_id) 只挡同槽双行；跨槽并发 accept
-- 的钱包查重发生在事务外（先查后写），双双通过后会留下同钱包双角色——
-- resolvePermissions 对每个槽各生成一份授权，同 submitter 双角色在链上
-- 无法兑现"一人一角色"的语义。裁决下沉到存储层：后提交者在索引上撞车，
-- 败者由服务层按 409 收敛。仅 accepted 且已绑钱包的行参与；invited/
-- rejected/未绑钱包行不受限。不同 draft 间同钱包多角色合法，键含
-- draft_id 即不在本索引语义内。
--
-- 存量同钱包双 accepted 正是该索引要防的历史竞态产物：直接建索引会在
-- 重复组上失败、阻断升级。先确定性收敛再上索引——每组保留最新行
-- （accepted_at，空值按最早计，平局以 participant_id 决胜），旧行翻
-- replaced：该槽的接受已被新槽取代，读取侧只认 accepted 为已履约，
-- replaced 槽不再计入就绪、也不再阻断重邀。钱包地址保留为历史痕迹，
-- 非 accepted 行本就不参与索引与查重。
UPDATE product_participant AS older
SET status = 'replaced'
WHERE older.status = 'accepted'
  AND older.wallet_address IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM product_participant AS newer
    WHERE newer.draft_id = older.draft_id
      AND newer.status = 'accepted'
      AND newer.wallet_address IS NOT NULL
      AND newer.participant_id <> older.participant_id
      AND LOWER(newer.wallet_address) = LOWER(older.wallet_address)
      AND (COALESCE(newer.accepted_at, '') > COALESCE(older.accepted_at, '')
        OR (COALESCE(newer.accepted_at, '') = COALESCE(older.accepted_at, '')
          AND newer.participant_id > older.participant_id))
  );

CREATE UNIQUE INDEX IF NOT EXISTS product_participant_accepted_wallet_per_draft_uk
  ON product_participant (draft_id, LOWER(wallet_address))
  WHERE status = 'accepted' AND wallet_address IS NOT NULL;
