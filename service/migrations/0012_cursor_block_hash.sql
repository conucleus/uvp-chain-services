-- ETH-02：cursor 记录 next_block - 1 高度的区块哈希，追加前用它做
-- 哈希连续性校验；缺失（旧行）时跳过校验。
ALTER TABLE chain_index_cursor ADD COLUMN block_hash TEXT;
