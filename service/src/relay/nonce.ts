// relay nonce 账本端口与 reserve/release 单源：两条车道各自持久化 nonce row，
// 语义一致——reserve 先占位（重复即冲突），只有未真正广播/无 txHash 的失败才
// 释放；未知结果保留已消费的 nonce 交给 reconcile 探针。

export interface RelayNonceLedger {
  reserveNonce(key: string, options?: { readonly staleBefore?: string }): Promise<boolean>;
  releaseNonce?(key: string): Promise<void>;
}

export async function reserveRelayNonce(
  ledger: RelayNonceLedger,
  key: string,
  options?: { readonly staleBefore?: string }
): Promise<boolean> {
  return ledger.reserveNonce(key, options);
}

export async function releaseRelayNonce(ledger: RelayNonceLedger, key: string): Promise<void> {
  await ledger.releaseNonce?.(key);
}
