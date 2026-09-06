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

  it("records duplicate signer nonce attempts as dead-letter duplicate failures", async () => {
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
      retryable: false,
      retryState: "dead_letter",
      deadLetter: true
    });
    expect(recorded).toEqual(expect.arrayContaining([
      expect.objectContaining({ errorCode: "duplicate_signer_nonce" })
    ]));
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
