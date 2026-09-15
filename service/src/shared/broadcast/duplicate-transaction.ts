import type { Hex } from "../types.js";

/**
 * duplicate-transaction 广播失败车道的共享机制（单源）。
 *
 * broadcaster 报 "nonce too low" / "already known" / "replacement transaction
 * underpriced" 不等于失败：同一签名载荷（或同 nonce 交易）可能已经上链或
 * 仍在池中。直接钉终态死信会把已上链交易永久标记 failed、误导参与方对已
 * 消费 nonce 重签。本模块提供三条在役广播链路（submissions signal 面、
 * stage-patches patch 面）与 relayer 共用的判定机制：
 *
 * 1. 车道识别（isDuplicateTransactionReport）：文本匹配三报错形态；
 * 2. 候选 txHash 提取（duplicateTransactionTxHashCandidates）：错误对象
 *    携带的哈希 + 此前记录的哈希，去重保序；
 * 3. 回执探针裁决（adjudicateDuplicateTransaction）：探针成功→按已提交
 *    落账（submitted）；reverted→链上已裁决失败（receipt_failed 终态）；
 *    探针失败/无回执/状态未知→transaction_receipt_unknown 可重试并保留
 *    候选 txHash；无可探对象→nonce 竞争可重组装（reassemblable）。
 *
 * 错误码词表本身不入本模块：signal 面与 patch 面的 errorCode 集各自保持
 * （分类表有 taxonomy conformance 钉），这里只共享机制不硬统一错误码。
 */

/** 回执探针的最小事实面：状态与块高即可裁决 duplicate 车道。 */
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

/** 各广播面只提供结果构造器：错误码/标签/DTO 形状留在各自分类表一侧。 */
export interface DuplicateTransactionOutcomeBuilders<TResult> {
  readonly onSubmitted: (outcome: { readonly txHash: Hex; readonly blockNumber?: string }) => TResult;
  readonly onReceiptFailed: (outcome: { readonly txHash: Hex; readonly blockNumber?: string }) => TResult;
  readonly onReceiptUnknown: (outcome: { readonly txHash: Hex }) => TResult;
  readonly onReassemblableNonceRace: () => TResult;
}

/**
 * 广播面 catch 口的消费入口：一次探针裁决 + 四态结果映射。判定与映射
 * 在此单源；结果构造（错误码、标签、attempt 形状）由各面注入，不硬统一。
 */
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

/** broadcaster 的 duplicate-transaction 三报错形态（nonce 冲突车道）。 */
export function isDuplicateTransactionReport(haystack: string): boolean {
  return /nonce too low|replacement transaction underpriced|already known/i.test(haystack);
}

const TX_HASH_LIKE = /^0x[0-9a-fA-F]{64}$/;

/**
 * duplicate_transaction 的候选 txHash（去重保序）：错误对象上携带的
 * txHash/transactionHash/hash 字段（viem/节点错误常见），加上该提交此前
 * 记录的 txHash——"already known" 通常是同一签名载荷先前已广播。
 */
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

/** 单笔回执的三态裁决：success / failed（含 reverted）/ unknown。 */
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

/**
 * duplicate-transaction 的回执探针裁决（四态）：
 * - 探到 success 回执 → submitted：交易已上链成功，按已提交落账；
 * - 探到 reverted/failed 回执 → receipt_failed：链上已裁决失败（nonce 已
 *   被该失败交易消费），调用方落终态；
 * - 有候选哈希但回执未产出/探针抛错/状态未知 → receipt_unknown：不是
 *   失败裁决，调用方按 transaction_receipt_unknown 可重试落账并保留候选
 *   哈希，下轮重探；
 * - 无候选哈希（gas nonce 冲突通常不携带 txHash）→ reassemblable_nonce_
 *   race：业务结果未在链上落定，换 gas nonce 重组装即可自愈。
 *
 * 探针不可用（getReceipt 未实现）同样未裁决：有候选哈希按 receipt_unknown
 * 保留，无候选按 reassemblable。
 */
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
