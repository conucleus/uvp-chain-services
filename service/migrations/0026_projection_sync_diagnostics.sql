-- A6：投影重放的显式诊断计数（unknown/unresolved 族与词表富集
-- mismatch）持久化进 sync state——/healthz 与 /admin/diagnostics 只读
-- sync state，计数只留在快照/日志里时，投影悄然不完整仍报 ok/ready。
ALTER TABLE chain_projection_sync_state ADD COLUMN projection_diagnostics_json TEXT;
