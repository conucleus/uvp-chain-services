import type { Hex } from "../types.js";

// duplicate-transaction 广播失败车道的共享机制（单源）：submissions 与
// stage-patches 共用的三报错形态识别、候选 txHash 提取与回执探针四态裁决。

export interface DuplicateTransactionReceiptProbe {
  readonly status?: "success" | "reverted" | string;
  readonly blockNumber?: bigint | number | string;
}

export type DuplicateTransactionAdjudication =
  | { readonly kind: "submitted"; readonly txHash: Hex; readonly blockNumber?: string }
  | { readonly kind: "receipt_failed"; readonly txHash: Hex; readonly blockNumber?: string }
  | { readonly kind: "receipt_unknown"; readonly txHash: Hex }
  | { readonly kind: "reassemblable_nonce_race" };

export type DuplicateTransactionReceiptGetter =
  (txHash: Hex) => Promise<DuplicateTransactionReceiptProbe | undefined | null>;

export interface DuplicateTransactionOutcomeBuilders<TResult> {
  readonly onSubmitted: (outcome: { readonly txHash: Hex; readonly blockNumber?: string }) => TResult;
  readonly onReceiptFailed: (outcome: { readonly txHash: Hex; readonly blockNumber?: string }) => TResult;
  readonly onReceiptUnknown: (outcome: { readonly txHash: Hex }) => TResult;
  readonly onReassemblableNonceRace: () => TResult;
}

export async function resolveDuplicateTransactionOutcome<TResult>(
  error: unknown,
  getReceipt: DuplicateTransactionReceiptGetter | undefined,
  builders: DuplicateTransactionOutcomeBuilders<TResult>,
  onProbeError?: (txHash: Hex, error: unknown) => void
): Promise<TResult> {
  const adjudication = await adjudicateDuplicateTransaction(error, undefined, getReceipt, onProbeError);
  switch (adjudication.kind) {
    case "submitted":
      return builders.onSubmitted(adjudication);
    case "receipt_failed":
      return builders.onReceiptFailed(adjudication);
    case "receipt_unknown":
      return builders.onReceiptUnknown(adjudication);
    case "reassemblable_nonce_race":
      return builders.onReassemblableNonceRace();
  }
}

export function isDuplicateTransactionReport(haystack: string): boolean {
  return /nonce too low|replacement transaction underpriced|already known/i.test(haystack);
}

const TX_HASH_LIKE = /^0x[0-9a-fA-F]{64}$/;

export function duplicateTransactionTxHashCandidates(
  error: unknown,
  priorTxHash?: Hex
): readonly Hex[] {
  const candidates: Hex[] = [];
  const push = (value: unknown): void => {
    if (typeof value === "string" && TX_HASH_LIKE.test(value)) {
      const normalized = value.toLowerCase() as Hex;
      if (!candidates.includes(normalized)) {
        candidates.push(normalized);
      }
    }
  };
  collectTxHashLikeFields(error, push, 0);
  push(priorTxHash);
  return candidates;
}

function collectTxHashLikeFields(
  value: unknown,
  visit: (value: unknown) => void,
  depth: number
): void {
  if (depth > 4 || value == null) {
    return;
  }
  if (typeof value === "string") {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectTxHashLikeFields(item, visit, depth + 1);
    }
    return;
  }
  if (typeof value !== "object") {
    return;
  }
  const record = value as Record<string, unknown>;
  for (const key of ["txHash", "transactionHash", "hash"]) {
    if (key in record) {
      visit(record[key]);
    }
  }
  for (const key of ["transaction", "cause", "error", "details"]) {
    if (key in record) {
      collectTxHashLikeFields(record[key], visit, depth + 1);
    }
  }
}

export function duplicateTransactionReceiptVerdict(
  receipt: DuplicateTransactionReceiptProbe | undefined | null
): "success" | "failed" | "unknown" {
  if (!receipt) {
    return "unknown";
  }
  if (receipt.status === "success") {
    return "success";
  }
  if (receipt.status === "reverted" || receipt.status === "failed") {
    return "failed";
  }
  return "unknown";
}

export async function adjudicateDuplicateTransaction(
  error: unknown,
  priorTxHash: Hex | undefined,
  getReceipt: DuplicateTransactionReceiptGetter | undefined,
  onProbeError?: (txHash: Hex, error: unknown) => void
): Promise<DuplicateTransactionAdjudication> {
  const candidates = duplicateTransactionTxHashCandidates(error, priorTxHash);
  if (candidates.length === 0) {
    return { kind: "reassemblable_nonce_race" };
  }
  if (!getReceipt) {
    return { kind: "receipt_unknown", txHash: candidates[0]! };
  }
  let lastCandidate = candidates[0]!;
  for (const txHash of candidates) {
    lastCandidate = txHash;
    let receipt: DuplicateTransactionReceiptProbe | undefined | null;
    try {
      receipt = await getReceipt(txHash);
    } catch (probeError) {
      onProbeError?.(txHash, probeError);
      continue;
    }
    const verdict = duplicateTransactionReceiptVerdict(receipt);
    if (verdict === "success") {
      const blockNumber = receipt?.blockNumber;
      return {
        kind: "submitted",
        txHash,
        ...(blockNumber !== undefined ? { blockNumber: blockNumber.toString() } : {})
      };
    }
    if (verdict === "failed") {
      const blockNumber = receipt?.blockNumber;
      return {
        kind: "receipt_failed",
        txHash,
        ...(blockNumber !== undefined ? { blockNumber: blockNumber.toString() } : {})
      };
    }
  }
  return { kind: "receipt_unknown", txHash: lastCandidate };
}
