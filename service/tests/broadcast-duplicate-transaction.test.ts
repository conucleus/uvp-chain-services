import { describe, expect, it, vi } from "vitest";
import {
  adjudicateDuplicateTransaction,
  duplicateTransactionReceiptVerdict,
  duplicateTransactionTxHashCandidates,
  isDuplicateTransactionReport,
  resolveDuplicateTransactionOutcome
} from "../src/shared/broadcast/duplicate-transaction.js";
import { classifyStateMachineBroadcastError } from "../src/submissions/broadcast-adapter.js";
import {
  classifyStagePatchBroadcastError,
  STAGE_EXECUTOR_PATCH_BROADCAST_LABELS
} from "../src/stage-patches/broadcast-adapter.js";
import type { Hex } from "../src/shared/types.js";

const candidateTx = `0x${"ab".repeat(32)}` as Hex;
const otherTx = `0x${"cd".repeat(32)}` as Hex;

describe("duplicate-transaction lane matcher (shared)", () => {
  it("recognizes the three broadcaster nonce-conflict reports and nothing else", () => {
    expect(isDuplicateTransactionReport("nonce too low")).toBe(true);
    expect(isDuplicateTransactionReport("already known")).toBe(true);
    expect(isDuplicateTransactionReport("replacement transaction underpriced")).toBe(true);
    expect(isDuplicateTransactionReport("Error nonce too low for this account")).toBe(true);
    expect(isDuplicateTransactionReport("execution reverted: UnknownOrder()")).toBe(false);
    expect(isDuplicateTransactionReport("insufficient funds for gas")).toBe(false);
    expect(isDuplicateTransactionReport("the request timed out")).toBe(false);
  });

  it("both in-service classifiers route the lanes to duplicate_transaction with the taxonomy base verdict", () => {
    // 基础判定对齐 taxonomy nonce_conflict（不可重试、死信）；broadcast()
    // 捕获口再走回执探针改判——基础判定本身不能放宽。
    for (const text of ["nonce too low", "already known", "replacement transaction underpriced"]) {
      const submissionVerdict = classifyStateMachineBroadcastError(new Error(text)) as { errorCode: string; retryable: boolean; deadLetter: boolean };
      expect(submissionVerdict.errorCode, `submissions: "${text}"`).toBe("duplicate_transaction");
      expect(submissionVerdict.retryable).toBe(false);
      expect(submissionVerdict.deadLetter).toBe(true);

      const patchVerdict = classifyStagePatchBroadcastError(new Error(text), STAGE_EXECUTOR_PATCH_BROADCAST_LABELS) as { errorCode: string; retryable: boolean };
      expect(patchVerdict.errorCode, `stage-patches: "${text}"`).toBe("duplicate_transaction");
      expect(patchVerdict.retryable).toBe(false);
    }
  });

  it("keeps the lanes ahead of the generic revert fallback", () => {
    // 复合文本（revert + nonce 冲突）必须落 duplicate 车道而非泛 revert。
    const submissionVerdict = classifyStateMachineBroadcastError(
      new Error("execution reverted: nonce too low")
    ) as { errorCode: string };
    expect(submissionVerdict.errorCode).toBe("duplicate_transaction");
  });
});

describe("duplicate-transaction candidate txHash extraction (shared)", () => {
  it("collects txHash/transactionHash/hash fields from nested error objects, deduplicated and order-stable", () => {
    const error = new Error("already known") as Error & { readonly txHash?: string; readonly cause?: unknown };
    (error as { txHash?: string }).txHash = candidateTx;
    (error as { cause?: unknown }).cause = {
      transaction: { transactionHash: `0x${"cd".repeat(32).toUpperCase()}` },
      details: [{ hash: candidateTx }, { hash: "not-a-hash" }]
    };
    expect(duplicateTransactionTxHashCandidates(error)).toEqual([candidateTx, otherTx]);
  });

  it("appends the prior recorded hash last and skips non-hash-like values", () => {
    const error = new Error("nonce too low") as Error & { txHash?: string };
    (error as { txHash?: string }).txHash = candidateTx;
    expect(duplicateTransactionTxHashCandidates(error, otherTx)).toEqual([candidateTx, otherTx]);
    expect(duplicateTransactionTxHashCandidates(new Error("nonce too low"))).toEqual([]);
    expect(duplicateTransactionTxHashCandidates(new Error("already known"), undefined)).toEqual([]);
  });
});

describe("duplicate-transaction receipt adjudication (shared)", () => {
  it("treats a missing probe as unresolved: candidates keep the receipt-unknown lane", async () => {
    await expect(adjudicateDuplicateTransaction(
      Object.assign(new Error("already known"), { txHash: candidateTx }),
      undefined,
      undefined
    )).resolves.toEqual({ kind: "receipt_unknown", txHash: candidateTx });
  });

  it("returns reassemblable_nonce_race when the report carries no attributable hash", async () => {
    await expect(adjudicateDuplicateTransaction(new Error("nonce too low"), undefined, undefined))
      .resolves.toEqual({ kind: "reassemblable_nonce_race" });
  });

  it("resolves submitted for a success receipt, carrying the block number", async () => {
    await expect(adjudicateDuplicateTransaction(
      Object.assign(new Error("already known"), { txHash: candidateTx }),
      undefined,
      async () => ({ status: "success", blockNumber: 42n })
    )).resolves.toEqual({ kind: "submitted", txHash: candidateTx, blockNumber: "42" });
  });

  it("resolves receipt_failed only for an explicit revert/failure receipt", async () => {
    await expect(adjudicateDuplicateTransaction(
      Object.assign(new Error("already known"), { txHash: candidateTx }),
      undefined,
      async () => ({ status: "reverted" })
    )).resolves.toEqual({ kind: "receipt_failed", txHash: candidateTx });
    expect(duplicateTransactionReceiptVerdict({ status: "failed" })).toBe("failed");
  });

  it("keeps receipt_unknown when the probe throws or the receipt has an extension status", async () => {
    const onProbeError = vi.fn();
    await expect(adjudicateDuplicateTransaction(
      Object.assign(new Error("already known"), { txHash: candidateTx }),
      undefined,
      async () => {
        throw new Error("RPC read failed");
      },
      onProbeError
    )).resolves.toEqual({ kind: "receipt_unknown", txHash: candidateTx });
    expect(onProbeError).toHaveBeenCalledWith(candidateTx, expect.any(Error));

    await expect(adjudicateDuplicateTransaction(
      Object.assign(new Error("already known"), { txHash: candidateTx }),
      undefined,
      async () => ({ status: "something-extension-specific" })
    )).resolves.toEqual({ kind: "receipt_unknown", txHash: candidateTx });
  });

  it("falls through to the next candidate when an earlier probe is unresolved", async () => {
    const probed: Hex[] = [];
    await expect(adjudicateDuplicateTransaction(
      Object.assign(new Error("already known"), { txHash: candidateTx }),
      otherTx,
      async (txHash) => {
        probed.push(txHash);
        return txHash === otherTx ? { status: "success", blockNumber: 7n } : undefined;
      }
    )).resolves.toEqual({ kind: "submitted", txHash: otherTx, blockNumber: "7" });
    expect(probed).toEqual([candidateTx, otherTx]);
  });

  it("resolveDuplicateTransactionOutcome maps the four adjudications through the injected builders", async () => {
    const labels: string[] = [];
    const builders = {
      onSubmitted: () => { labels.push("submitted"); return "r:submitted"; },
      onReceiptFailed: () => { labels.push("receipt_failed"); return "r:receipt_failed"; },
      onReceiptUnknown: () => { labels.push("receipt_unknown"); return "r:receipt_unknown"; },
      onReassemblableNonceRace: () => { labels.push("reassemblable"); return "r:reassemblable"; }
    };
    await expect(resolveDuplicateTransactionOutcome(new Error("nonce too low"), undefined, builders))
      .resolves.toBe("r:reassemblable");
    await expect(resolveDuplicateTransactionOutcome(
      Object.assign(new Error("already known"), { txHash: candidateTx }),
      async () => ({ status: "success" }),
      builders
    )).resolves.toBe("r:submitted");
    await expect(resolveDuplicateTransactionOutcome(
      Object.assign(new Error("already known"), { txHash: candidateTx }),
      async () => ({ status: "reverted" }),
      builders
    )).resolves.toBe("r:receipt_failed");
    await expect(resolveDuplicateTransactionOutcome(
      Object.assign(new Error("already known"), { txHash: candidateTx }),
      undefined,
      builders
    )).resolves.toBe("r:receipt_unknown");
    expect(labels).toEqual(["reassemblable", "submitted", "receipt_failed", "receipt_unknown"]);
  });
});
