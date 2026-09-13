import { describe, expect, it, vi } from "vitest";
import {
  classifyRelaySubmitterError,
  createRelayerService,
  MemoryRelayNonceStore,
  MemoryRelayRetryBudgetStore,
  MemoryRelaySubmissionStore,
  RelayRejection
} from "../src/relayer/service.js";
import type {
  BusinessSignatureVerifier,
  RelayRequest,
  RelaySubmission,
  RelaySubmissionStore,
  TransactionSubmitter
} from "../src/relayer/types.js";
import type { Address, Hex } from "../src/shared/types.js";

const signer: Address = "0x4444444444444444444444444444444444444444";
const verifyingContract: Address = "0x1111111111111111111111111111111111111111";
const signature: Hex = "0xaaaaaaaa";
const txHash: Hex = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("relayer non-signing boundary", () => {
  it("submits only after a participant business signature verifies", async () => {
    const verifier: BusinessSignatureVerifier = {
      verify: vi.fn(async () => ({ valid: true, signer }))
    };
    const submitter: TransactionSubmitter = {
      submit: vi.fn(async () => ({ txHash }))
    };

    const relayer = createRelayerService({
      verifier,
      submitter,
      nonceStore: new MemoryRelayNonceStore(),
      now: () => new Date("2026-01-01T00:00:00Z")
    });

    const submission = await relayer.relay(request("nonce-1"));

    expect(submission.status).toBe("submitted");
    expect(submission.txHash).toBe(txHash);
    expect(submission.retryState).toBe("not_applicable");
    expect(submission.deadLetter).toBe(false);
    expect(verifier.verify).toHaveBeenCalledOnce();
    expect(submitter.submit).toHaveBeenCalledOnce();
    expect("signBusinessPayload" in relayer).toBe(false);
  });

  it("rejects a signature that resolves to a different signer", async () => {
    const relayer = createRelayerService({
      verifier: {
        verify: async () => ({
          valid: true,
          signer: "0x5555555555555555555555555555555555555555"
        })
      },
      submitter: {
        submit: async () => ({ txHash })
      },
      now: () => new Date("2026-01-01T00:00:00Z")
    });

    await expect(relayer.relay(request("nonce-2"))).rejects.toThrow(RelayRejection);
  });

  it("keeps retryable failed submissions observable and reusable without leaking raw errors", async () => {
    const recorded: RelaySubmission[] = [];
    const submissionStore: RelaySubmissionStore = {
      record: async (submission) => {
        recorded.push(submission);
      }
    };

    const relayer = createRelayerService({
      verifier: {
        verify: async () => ({ valid: true, signer })
      },
      submitter: {
        submit: async () => {
          throw new Error("rpc unavailable");
        }
      },
      nonceStore: new MemoryRelayNonceStore(),
      submissionStore,
      now: () => new Date("2026-01-01T00:00:00Z")
    });

    const first = await relayer.relay(request("nonce-3"));
    const second = await relayer.relay(request("nonce-3"));

    expect(first).toMatchObject({
      status: "failed",
      errorCode: "rpc_unavailable",
      failureCategory: "retryable",
      retryable: true,
      retryState: "retryable",
      deadLetter: false
    });
    expect(second).toMatchObject({
      status: "failed",
      errorCode: "rpc_unavailable",
      retryable: true
    });
    expect(recorded).toHaveLength(2);
  });

  it("records an irreversible persist_failed row after broadcast and keeps the nonce reserved", async () => {
    const recorded: RelaySubmission[] = [];
    const released: string[] = [];
    let recordCalls = 0;
    const persistenceError = new Error("durable ledger unavailable");
    const relayer = createRelayerService({
      verifier: {
        verify: async () => ({ valid: true, signer })
      },
      submitter: {
        submit: async () => ({ txHash })
      },
      nonceStore: {
        reserve: async () => true,
        release: async (_signer, nonce) => {
          released.push(nonce);
        }
      },
      submissionStore: {
        record: async (submission) => {
          recordCalls += 1;
          if (recordCalls === 1) {
            throw persistenceError;
          }
          recorded.push(submission);
        },
        load: async () => recorded.at(-1)
      },
      now: () => new Date("2026-01-01T00:00:00Z")
    });

    await expect(relayer.relay(request("nonce-persist-failed"))).rejects.toBe(persistenceError);

    expect(recordCalls).toBe(2);
    expect(released).toHaveLength(0);
    expect(recorded).toEqual([expect.objectContaining({
      status: "failed",
      txHash,
      errorCode: "persist_failed",
      retryable: false,
      retryState: "dead_letter",
      deadLetter: true,
      attemptNumber: 1
    })]);
  });

  it("hydrates the retry budget from the durable ledger and writes a final DLQ", async () => {
    const store = new MemoryRelaySubmissionStore();
    const retryBudgetStore = new MemoryRelayRetryBudgetStore();
    const nonceStore = new MemoryRelayNonceStore();
    let broadcasts = 0;
    const options = {
      verifier: {
        verify: async () => ({ valid: true, signer })
      },
      submitter: {
        submit: async () => {
          broadcasts += 1;
          throw new Error("rpc unavailable");
        }
      },
      nonceStore,
      submissionStore: store,
      retryBudgetStore,
      maxRetryAttempts: 1,
      now: () => new Date("2026-01-01T00:00:00Z")
    } satisfies Parameters<typeof createRelayerService>[0];

    const first = await createRelayerService(options).relay(request("nonce-durable-budget"));
    expect(first).toMatchObject({
      status: "failed",
      errorCode: "rpc_unavailable",
      retryable: true,
      retryState: "retryable",
      deadLetter: false,
      attemptNumber: 1,
      retryBudgetRemaining: 1
    });

    const second = await createRelayerService(options).relay(request("nonce-durable-budget"));
    expect(second).toMatchObject({
      status: "failed",
      errorCode: "rpc_unavailable",
      retryable: true,
      retryState: "retryable",
      deadLetter: false,
      attemptNumber: 2,
      retryBudgetRemaining: 0
    });
    expect(broadcasts).toBe(2);

    const third = await createRelayerService(options).relay(request("nonce-durable-budget"));
    expect(third).toMatchObject({
      status: "failed",
      errorCode: "broadcast_retry_exhausted",
      retryable: false,
      retryState: "dead_letter",
      deadLetter: true,
      attemptNumber: 2,
      retryBudgetRemaining: 0
    });
    expect(broadcasts).toBe(2);
    await expect(store.load(first.id)).resolves.toMatchObject({
      errorCode: "broadcast_retry_exhausted",
      deadLetter: true
    });
    await expect(retryBudgetStore.load(first.id)).resolves.toMatchObject({
      failedAttempts: 2,
      lastSubmission: expect.objectContaining({
        errorCode: "broadcast_retry_exhausted",
        deadLetter: true
      })
    });
  });

  it("treats insufficient gas funds as recoverable and releases the nonce", async () => {
    let broadcasts = 0;
    const released: string[] = [];
    const relayer = createRelayerService({
      verifier: {
        verify: async () => ({ valid: true, signer })
      },
      submitter: {
        submit: async () => {
          broadcasts += 1;
          if (broadcasts === 1) {
            throw new Error("insufficient funds for gas * price + value");
          }
          return { txHash };
        }
      },
      nonceStore: {
        reserve: async () => true,
        release: async (_signer, nonce) => {
          released.push(nonce);
        }
      },
      now: () => new Date("2026-01-01T00:00:00Z")
    });

    const first = await relayer.relay(request("nonce-funds"));
    expect(first).toMatchObject({
      status: "failed",
      errorCode: "relayer_insufficient_funds",
      failureCategory: "broadcaster",
      retryable: true,
      retryState: "retryable",
      deadLetter: false,
      attemptNumber: 1
    });
    expect(released).toEqual(["nonce-funds"]);

    await expect(relayer.relay(request("nonce-funds"))).resolves.toMatchObject({
      status: "submitted",
      txHash,
      attemptNumber: 2
    });
  });

  it("dead-letters permanent authorization failures with redacted diagnostics", async () => {
    const privateKey = `0x${"1".repeat(64)}`;
    const rawSignature = `0x${"2".repeat(130)}`;
    const recorded: unknown[] = [];
    const relayer = createRelayerService({
      verifier: {
        verify: async () => ({ valid: true, signer })
      },
      submitter: {
        submit: async () => {
          throw new Error(`UnauthorizedSignalSubmitter privateKey ${privateKey} signature ${rawSignature}`);
        }
      },
      nonceStore: new MemoryRelayNonceStore(),
      submissionStore: {
        record: async (submission) => {
          recorded.push(submission);
        }
      },
      now: () => new Date("2026-01-01T00:00:00Z")
    });

    const submission = await relayer.relay(request("nonce-dead-letter"));

    expect(submission).toMatchObject({
      status: "failed",
      errorCode: "unauthorized_signal_submitter",
      failureCategory: "authorization",
      retryable: false,
      retryState: "dead_letter",
      deadLetter: true
    });
    expect(JSON.stringify(submission)).not.toContain(privateKey.slice(2));
    expect(JSON.stringify(recorded)).not.toContain(rawSignature.slice(2));
  });

  it("serializes in-flight submissions per order while allowing the first transaction to finish", async () => {
    const submitStarted = deferred<void>();
    const submitRelease = deferred<void>();
    const submitter: TransactionSubmitter = {
      submit: vi.fn(async () => {
        submitStarted.resolve();
        await submitRelease.promise;
        return { txHash };
      })
    };
    const relayer = createRelayerService({
      verifier: {
        verify: async () => ({ valid: true, signer })
      },
      submitter,
      nonceStore: new MemoryRelayNonceStore(),
      now: () => new Date("2026-01-01T00:00:00Z")
    });

    const first = relayer.relay(request("nonce-order-1"));
    await submitStarted.promise;
    const second = await relayer.relay(request("nonce-order-2"));
    submitRelease.resolve();

    await expect(first).resolves.toMatchObject({
      status: "submitted",
      txHash
    });
    expect(second).toMatchObject({
      status: "failed",
      errorCode: "order_relay_in_flight",
      failureCategory: "retryable",
      retryable: true,
      retryState: "retryable",
      deadLetter: false
    });
    expect(submitter.submit).toHaveBeenCalledOnce();
  });

  it("treats a recorded submitted outcome as terminal and replays it idempotently", async () => {
    const store = new MemoryRelaySubmissionStore();
    const retryBudgetStore = new MemoryRelayRetryBudgetStore();
    let broadcasts = 0;
    const options = {
      verifier: {
        verify: async () => ({ valid: true, signer })
      },
      submitter: {
        submit: async () => {
          broadcasts += 1;
          return { txHash };
        }
      },
      nonceStore: new MemoryRelayNonceStore(),
      submissionStore: store,
      retryBudgetStore,
      now: () => new Date("2026-01-01T00:00:00Z")
    } satisfies Parameters<typeof createRelayerService>[0];

    const first = await createRelayerService(options).relay(request("nonce-replay-submitted"));
    expect(first).toMatchObject({ status: "submitted", txHash });

    // 同载荷重放:成功提交已消费链上 nonce,必须幂等返回原结果,不得因
    // nonce 仍被占用而把台账覆写成 duplicate_signer_nonce 死信。
    const replay = await createRelayerService(options).relay(request("nonce-replay-submitted"));
    expect(replay).toMatchObject({ status: "submitted", txHash });
    expect(broadcasts).toBe(1);

    await expect(store.load(first.id)).resolves.toMatchObject({
      status: "submitted",
      txHash
    });
    await expect(retryBudgetStore.load(first.id)).resolves.toMatchObject({
      failedAttempts: 0,
      lastSubmission: expect.objectContaining({ status: "submitted", txHash })
    });
  });

  it("records duplicate signer nonce attempts as retryable pending failures, never terminal dead letters", async () => {
    // 预留失败不是终态——并发/在途的同 nonce 提交结果未知，钉成
    // dead_letter 会让 nonce 释放后的合法重试被终态台账永久拒绝。
    const submitStarted = deferred<void>();
    const submitRelease = deferred<void>();
    const recorded: unknown[] = [];
    const submitter: TransactionSubmitter = {
      submit: vi.fn(async () => {
        submitStarted.resolve();
        await submitRelease.promise;
        return { txHash };
      })
    };
    const relayer = createRelayerService({
      verifier: {
        verify: async () => ({ valid: true, signer })
      },
      submitter,
      nonceStore: new MemoryRelayNonceStore(),
      submissionStore: {
        record: async (submission) => {
          recorded.push(submission);
        }
      },
      now: () => new Date("2026-01-01T00:00:00Z")
    });

    const first = relayer.relay(request("nonce-duplicate"));
    await submitStarted.promise;
    const duplicate = await relayer.relay(request("nonce-duplicate"));
    submitRelease.resolve();

    await expect(first).resolves.toMatchObject({ status: "submitted" });
    expect(duplicate).toMatchObject({
      status: "failed",
      errorCode: "duplicate_signer_nonce",
      failureCategory: "duplicate",
      retryable: true,
      retryState: "retryable",
      deadLetter: false
    });
    expect(recorded).toEqual(expect.arrayContaining([
      expect.objectContaining({ errorCode: "duplicate_signer_nonce" })
    ]));
  });

  it("does not let a concurrent duplicate failure overwrite the winner's submitted ledger entry", async () => {
    // 状态守卫：胜者 record 已落库（budget 尚未跟上）时，败者的
    // duplicate_signer_nonce 失败行不得覆盖 submitted 成功台账。
    const duplicateEnteredReserve = deferred<void>();
    const winnerRecorded = deferred<void>();
    const recorded: unknown[] = [];
    let reserveCalls = 0;
    const relayer = createRelayerService({
      verifier: {
        verify: async () => ({ valid: true, signer })
      },
      submitter: {
        submit: async () => ({ txHash })
      },
      nonceStore: {
        reserve: async () => {
          reserveCalls += 1;
          if (reserveCalls === 1) {
            return true;
          }
          duplicateEnteredReserve.resolve();
          await winnerRecorded.promise;
          return false;
        },
        release: async () => undefined
      },
      submissionStore: {
        record: async (submission) => {
          if (submission.status === "submitted") {
            // 胜者的成功台账先落库，saveRetryState 尚未跟上——正是守卫
            // 必须覆盖的窗口。
            await duplicateEnteredReserve.promise;
            recorded.push(submission);
            winnerRecorded.resolve();
            return;
          }
          recorded.push(submission);
        },
        load: async (submissionId: string) => {
          const found = recorded.find((entry) => (entry as { readonly id: string }).id === submissionId);
          return found as never;
        }
      },
      now: () => new Date("2026-01-01T00:00:00Z")
    });

    const first = relayer.relay(request("nonce-guard"));
    const duplicate = await relayer.relay(request("nonce-guard"));
    await expect(first).resolves.toMatchObject({ status: "submitted", txHash });

    // 败者拿到胜者的 submitted 结果，台账只保留成功行。
    expect(duplicate).toMatchObject({ status: "submitted", txHash });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ status: "submitted" });
  });

  it("returns the winner's submitted result on the submitter failure path when the outcome guard fires", async () => {
    // SVC-3：submitter 抛错路径不得丢弃 persistOutcome 的胜者结果——
    // 并发竞速中台账已是 submitted+txHash 时，调用方必须拿到与台账
    // 一致的 submitted，而不是本地构造的 failed+retryable（否则会对已
    // 消费的 nonce 诱导重签）。
    const winnerSubmitStarted = deferred<void>();
    const failureLoadEntered = deferred<void>();
    const winnerRecorded = deferred<void>();
    const recorded: unknown[] = [];
    let submitCalls = 0;
    const relayer = createRelayerService({
      verifier: {
        verify: async () => ({ valid: true, signer })
      },
      // 同一订单的两笔并发（胜者+败者）都要进入 submitter，不设单订单
      // 在途门。
      maxInFlightPerOrder: 0,
      submitter: {
        submit: vi.fn(async () => {
          submitCalls += 1;
          if (submitCalls === 1) {
            // 胜者先进入 submit，等败者的台账读取就位后再返回 txHash。
            winnerSubmitStarted.resolve();
            await failureLoadEntered.promise;
            return { txHash };
          }
          throw new Error("rpc connection reset");
        })
      },
      nonceStore: {
        reserve: async () => true,
        release: async () => undefined
      },
      submissionStore: {
        record: async (submission: RelaySubmission) => {
          if (submission.status === "submitted") {
            recorded.push(submission);
            winnerRecorded.resolve();
            return;
          }
          recorded.push(submission);
        },
        // loadRetryState 在每次 relay 入口都会 load——只在败者已抛错后的
        // 守卫读取上阻塞，制造"胜者 record 已落库、budget 未跟上"的
        // 竞速窗口。
        load: async (submissionId: string) => {
          if (submitCalls >= 2) {
            failureLoadEntered.resolve();
            await winnerRecorded.promise;
          }
          const found = recorded.find((entry) => (entry as { readonly id: string }).id === submissionId);
          return found as never;
        }
      },
      now: () => new Date("2026-01-01T00:00:00Z")
    });

    const first = relayer.relay(request("nonce-winner-guard"));
    await winnerSubmitStarted.promise;
    const failure = relayer.relay(request("nonce-winner-guard"));
    await failureLoadEntered.promise;
    await winnerRecorded.promise;

    await expect(first).resolves.toMatchObject({ status: "submitted", txHash });
    await expect(failure).resolves.toMatchObject({ status: "submitted", txHash });
    // 台账只保留成功行——败者的 failed 行被守卫拦下。
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ status: "submitted" });
  });

  it("treats nonce-too-low without a txHash as a retryable re-assembly, not a terminal dead letter", async () => {
    // gas nonce 冲突是瞬态（换 nonce 重组装即自愈）：错误不携带 txHash、
    // 探针无可探对象——不得钉 dead_letter 终态（否则同载荷重放被
    // isTerminalSubmission 永久短路），且须释放服务侧 nonce 让重试可广播。
    let submitCalls = 0;
    const relayer = createRelayerService({
      verifier: {
        verify: async () => ({ valid: true, signer })
      },
      submitter: {
        submit: async () => {
          submitCalls += 1;
          if (submitCalls === 1) {
            throw new Error("nonce too low");
          }
          return { txHash };
        }
      },
      nonceStore: new MemoryRelayNonceStore(),
      now: () => new Date("2026-01-01T00:00:00Z")
    });

    const first = await relayer.relay(request("nonce-too-low"));
    expect(first).toMatchObject({
      status: "failed",
      errorCode: "duplicate_transaction",
      retryable: true,
      retryState: "retryable",
      deadLetter: false
    });

    // 同一载荷重试：nonce 已释放，重组装广播成功。
    const retried = await relayer.relay(request("nonce-too-low"));
    expect(retried).toMatchObject({ status: "submitted", txHash });
    expect(submitCalls).toBe(2);
  });

  it("keeps a pool-pending duplicate transaction retryable with its candidate hash and self-heals on the next probe", async () => {
    // 事故形态："already known" 带候选 txHash 但交易仍在池中尚未挖出——
    // 单次 getTransactionReceipt 探不到不是失败裁决。钉 failed 终态死信
    // 会让同载荷幂等重放被 isTerminalSubmission 永久短路、reconcile 无该
    // 台账复核通道。对齐 submissions 的 transaction_receipt_unknown 口径：
    // 可重试、不释放 nonce、候选哈希留台账，下轮重放重探。
    const candidateTx = `0x${"cc".repeat(32)}` as Hex;
    const store = new MemoryRelaySubmissionStore();
    const retryBudgetStore = new MemoryRelayRetryBudgetStore();
    const nonceStore = new MemoryRelayNonceStore();
    const receipts = new Map<string, { status?: "success" | "reverted" | string }>();
    const relayer = createRelayerService({
      verifier: {
        verify: async () => ({ valid: true, signer })
      },
      submitter: {
        submit: async () => {
          const error = new Error("already known") as Error & { txHash?: string };
          error.txHash = candidateTx;
          throw error;
        },
        getTransactionReceipt: async (txHash: Hex) => receipts.get(txHash)
      },
      nonceStore,
      submissionStore: store,
      retryBudgetStore,
      now: () => new Date("2026-01-01T00:00:00Z")
    });

    const first = await relayer.relay(request("nonce-dup-pending"));
    expect(first).toMatchObject({
      status: "failed",
      errorCode: "transaction_receipt_unknown",
      failureCategory: "retryable",
      retryable: true,
      retryState: "retryable",
      deadLetter: false,
      txHash: candidateTx
    });

    // nonce 不释放：候选交易可能随后上链消费 nonce——服务侧预留必须仍在
    // （重放走 reserve 失败路径，正是"下轮重探"的入口）。
    await expect(nonceStore.reserve(signer, "nonce-dup-pending")).resolves.toBe(false);

    // 重放重探：回执仍未产出 → 仍是可重试的未知，不升级为终态。
    const stillUnknown = await relayer.relay(request("nonce-dup-pending"));
    expect(stillUnknown).toMatchObject({
      status: "failed",
      errorCode: "duplicate_signer_nonce",
      retryable: true,
      deadLetter: false
    });

    // 回执挖出且成功 → 闭环 submitted（带候选哈希），不再是失败。
    receipts.set(candidateTx, { status: "success" });
    const healed = await relayer.relay(request("nonce-dup-pending"));
    expect(healed).toMatchObject({ status: "submitted", txHash: candidateTx });
    await expect(store.load(healed.id)).resolves.toMatchObject({
      status: "submitted",
      txHash: candidateTx
    });
  });

  it("dead-letters a duplicate transaction only once its mined receipt proves a revert", async () => {
    // 回执已产出且明确 revert：链上已裁决该交易失败、nonce 已被消费——
    // 终态 dead letter（transaction_reverted），重放幂等返回已记录结果。
    const candidateTx = `0x${"dd".repeat(32)}` as Hex;
    const store = new MemoryRelaySubmissionStore();
    const relayer = createRelayerService({
      verifier: {
        verify: async () => ({ valid: true, signer })
      },
      submitter: {
        submit: async () => {
          const error = new Error("already known") as Error & { txHash?: string };
          error.txHash = candidateTx;
          throw error;
        },
        getTransactionReceipt: async () => ({ status: "reverted" })
      },
      nonceStore: new MemoryRelayNonceStore(),
      submissionStore: store,
      now: () => new Date("2026-01-01T00:00:00Z")
    });

    const first = await relayer.relay(request("nonce-dup-reverted"));
    expect(first).toMatchObject({
      status: "failed",
      errorCode: "transaction_reverted",
      retryable: false,
      retryState: "dead_letter",
      deadLetter: true,
      txHash: candidateTx
    });

    const replay = await relayer.relay(request("nonce-dup-reverted"));
    expect(replay).toMatchObject({
      status: "failed",
      errorCode: "transaction_reverted",
      deadLetter: true
    });
  });

  it("returns the recorded terminal outcome for a replay whose deadline has since expired", async () => {
    // 终态台账查询先于 deadline 校验：已上链提交的结果在 deadline 过后
    // 必须幂等取回（含 txHash），否则过期拒绝会误导参与方对已消费 nonce
    // 重签。无台账记录的过期载荷仍按 expired_payload_deadline 拒绝。
    const store = new MemoryRelaySubmissionStore();
    const retryBudgetStore = new MemoryRelayRetryBudgetStore();
    let currentTime = new Date("2026-01-01T00:00:00Z");
    const relayer = createRelayerService({
      verifier: {
        verify: async () => ({ valid: true, signer })
      },
      submitter: {
        submit: async () => ({ txHash })
      },
      nonceStore: new MemoryRelayNonceStore(),
      submissionStore: store,
      retryBudgetStore,
      now: () => currentTime
    });

    const first = await relayer.relay(request("nonce-expired-replay"));
    expect(first).toMatchObject({ status: "submitted", txHash });

    // deadline（2_000_000_000s ≈ 2033）已过：同载荷重放幂等返回台账终态。
    currentTime = new Date("2034-01-01T00:00:00Z");
    const replay = await relayer.relay(request("nonce-expired-replay"));
    expect(replay).toMatchObject({ status: "submitted", txHash });

    // 对照：无台账记录的过期载荷仍被永久拒绝。
    await expect(relayer.relay(request("nonce-expired-fresh"))).rejects.toMatchObject({
      name: "RelayRejection",
      errorCode: "expired_payload_deadline"
    });
  });

  it("escalates retryable failure delays exponentially and resets after success", async () => {
    let failing = true;
    const recorded: unknown[] = [];
    const relayer = createRelayerService({
      verifier: {
        verify: async () => ({ valid: true, signer })
      },
      submitter: {
        submit: async () => {
          if (failing) {
            throw new Error("rpc unavailable");
          }
          return { txHash };
        }
      },
      nonceStore: {
        reserve: async () => true,
        release: async () => undefined
      },
      submissionStore: {
        record: async (submission) => {
          recorded.push(submission);
        }
      },
      now: () => new Date("2026-01-01T00:00:00Z"),
      maxRetryAttempts: 10,
      retryBaseMs: 250,
      retryMaxMs: 2_000
    });

    const baseTime = Date.parse("2026-01-01T00:00:00Z");

    const first = await relayer.relay(request("nonce-backoff"));
    expect(first).toMatchObject({ status: "failed", retryable: true });
    expect(first.nextRetryAt).toBe(new Date(baseTime + 250).toISOString());

    const second = await relayer.relay(request("nonce-backoff"));
    expect(second.nextRetryAt).toBe(new Date(baseTime + 500).toISOString());

    failing = false;
    const third = await relayer.relay(request("nonce-backoff"));
    expect(third).toMatchObject({ status: "submitted" });

    // 同载荷重放已因 submitted 终态而幂等返回,退避重置由新 nonce 的新提交体现。
    failing = true;
    const fourth = await relayer.relay(request("nonce-backoff-2"));
    expect(fourth.nextRetryAt).toBe(new Date(baseTime + 250).toISOString());
    expect(recorded).toHaveLength(4);
  });

  it("caps retryable failure delays at retryMaxMs without overflowing", async () => {
    let failures = 0;
    const relayer = createRelayerService({
      verifier: {
        verify: async () => ({ valid: true, signer })
      },
      submitter: {
        submit: async () => {
          failures += 1;
          throw new Error("rpc unavailable");
        }
      },
      nonceStore: new MemoryRelayNonceStore(),
      now: () => new Date("2026-01-01T00:00:00Z"),
      retryBaseMs: 250,
      retryMaxMs: 1_000,
      maxRetryAttempts: 10
    });

    const baseTime = Date.parse("2026-01-01T00:00:00Z");
    const expectedDelays = [250, 500, 1_000, 1_000, 1_000];
    for (const expectedDelay of expectedDelays) {
      const submission = await relayer.relay(request("nonce-backoff-cap"));
      expect(submission.nextRetryAt).toBe(new Date(baseTime + expectedDelay).toISOString());
    }
    expect(failures).toBe(expectedDelays.length);
  });

  it("classifies relayer submitter failures for release diagnostics", () => {
    expect(classifyRelaySubmitterError(new Error("UnknownOrder"))).toMatchObject({
      errorCode: "unknown_order",
      failureCategory: "retryable",
      retryable: true,
      deadLetter: false
    });
    expect(classifyRelaySubmitterError(new Error("execution reverted"))).toMatchObject({
      errorCode: "transaction_reverted",
      failureCategory: "permanent",
      retryable: false,
      deadLetter: true
    });
    expect(classifyRelaySubmitterError(new Error("insufficient funds for gas"))).toMatchObject({
      errorCode: "relayer_insufficient_funds",
      failureCategory: "broadcaster",
      retryable: true,
      deadLetter: false
    });
    expect(classifyRelaySubmitterError(Object.assign(new Error("balance too low"), {
      name: "InsufficientFundsError"
    }))).toMatchObject({
      errorCode: "relayer_insufficient_funds",
      retryable: true,
      deadLetter: false
    });
    expect(classifyRelaySubmitterError(new Error("SignalAlreadyExists"))).toMatchObject({
      errorCode: "signal_already_exists",
      failureCategory: "duplicate",
      retryable: false,
      deadLetter: true
    });
  });
});

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function request(nonce: string): RelayRequest {
  return {
    business: {
      chainId: 31337,
      verifyingContract,
      orderId: "order-1",
      stageId: "stage-1",
      signal: "approve",
      evidenceHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      signer,
      nonce,
      deadline: 2_000_000_000n
    },
    typedData: {
      domain: {
        name: "UVP",
        chainId: 31337,
        verifyingContract
      },
      types: {
        ApproveStage: [
          { name: "orderId", type: "bytes32" },
          { name: "stageId", type: "bytes32" },
          { name: "nonce", type: "uint256" }
        ]
      },
      primaryType: "ApproveStage",
      message: {
        orderId: "order-1",
        stageId: "stage-1",
        nonce
      },
      signature
    }
  };
}
