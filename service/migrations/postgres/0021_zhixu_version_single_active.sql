-- series 单活约束：同一 series 只允许一行 status='active'。
-- 事务化 cutover 只保证单事务内的"先撤旧、再立新"；两个并发 activate
-- 各自读到 cutover 前的旧状态时，双双落新 active 行会留下双 active
-- （resolveActiveVersion 只取 find 到的第一条）。部分唯一索引把裁决
-- 下沉到存储层：后提交者在索引上撞车，败者按激活冲突 409 收敛。
CREATE UNIQUE INDEX IF NOT EXISTS store_zhixu_version_metadata_single_active_uk
  ON store_zhixu_version_metadata (series_id)
  WHERE status = 'active';
