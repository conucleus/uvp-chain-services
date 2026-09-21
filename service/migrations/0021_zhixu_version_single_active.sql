-- series 单活约束：同一 series 只允许一行 status='active'。
-- 事务化 cutover 只保证单事务内的"先撤旧、再立新"；两个并发 activate
-- 各自读到 cutover 前的旧状态时，双双落新 active 行会留下双 active
-- （resolveActiveVersion 只取 find 到的第一条）。部分唯一索引把裁决
-- 下沉到存储层：后提交者在索引上撞车，败者按激活冲突 409 收敛。
--
-- 存量双 active 是并发 activate 竞态的产物：直接建索引会在重复组上
-- 失败、阻断升级。先确定性收敛再上索引——每组保留最新行
-- （created_at，平局以 version_id 决胜），旧行翻 deprecated，与 cutover
-- 撤旧的生命周期写法同口径（服务层撤旧即写 deprecated）。
UPDATE store_zhixu_version_metadata AS older
SET status = 'deprecated'
WHERE older.status = 'active'
  AND EXISTS (
    SELECT 1
    FROM store_zhixu_version_metadata AS newer
    WHERE newer.series_id = older.series_id
      AND newer.status = 'active'
      AND (newer.created_at > older.created_at
        OR (newer.created_at = older.created_at
          AND newer.version_id > older.version_id))
  );

CREATE UNIQUE INDEX IF NOT EXISTS store_zhixu_version_metadata_single_active_uk
  ON store_zhixu_version_metadata (series_id)
  WHERE status = 'active';
