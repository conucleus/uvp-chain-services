-- store_docking_session 列改造：v2 具名接口形态下，会话锚定
-- 「目标接口名 + 下单模式」（selected_interface_name / order_mode），
-- 取代旧版按 zhixu 版本号锚定试拼对象的 source_version_id /
-- target_version_id。读写路径以 session_json 为准，这两列是写侧
-- 投影列；旧列全仓无消费方，直接 DROP。
--
-- 存量行无可派生来源：旧列存的是 zhixu 版本 ID，与新列的接口名 /
-- 下单模式分属不同语义域，无法换算。回填为空串（=「未记录」）而非
-- 伪造任一合法枚举值——order_mode 的 {new, existing} 对旧行都不
-- 成立，伪造会让未来的列读者拿到静默错误语义；空串让假设枚举值的
-- 读者响亮失败。
ALTER TABLE store_docking_session ADD COLUMN IF NOT EXISTS selected_interface_name TEXT NOT NULL DEFAULT '';
ALTER TABLE store_docking_session ADD COLUMN IF NOT EXISTS order_mode TEXT NOT NULL DEFAULT '';
ALTER TABLE store_docking_session DROP COLUMN IF EXISTS source_version_id;
ALTER TABLE store_docking_session DROP COLUMN IF EXISTS target_version_id;
