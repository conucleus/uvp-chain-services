// relay dedupe 账本：幂等键 → attempts/lastResult，txHash → 幂等键归属。
// 表复用既有广播 dedupe 表（broadcast_dedupe_state / broadcast_dedupe_tx_owner），
// lastResult 是各车道自己的广播结果 JSON，账本不解释业务字段；键由车道命名
// 空间隔离（submissions=0x 哈希，stage-patches=非 0x nonceKey）。

export interface RelayDedupeState {
  readonly attempts: number;
  readonly lastResult: unknown;
}

export interface RelayDedupeStore {
  load(idempotencyKey: string): Promise<RelayDedupeState | undefined>;
  save(idempotencyKey: string, state: RelayDedupeState): Promise<void>;
  claimTxHash(txHash: string, idempotencyKey: string): Promise<string | undefined>;
}
