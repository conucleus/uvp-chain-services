// relay 安全机制的聚焦用例：持久 dedupe 跨重启去重、retry/attempt 上限、
// in-flight 限流、txHash 归属，以及 stage-patches dedupe 键与 prepare nonce
// 键同一派生。submissions 车道已有回归用例，本文件只覆盖共享行为。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresTestDatabase } from "./postgres.js";
import { PostgresBroadcastDedupeStore } from "../src/submissions/broadcast-dedupe-postgres-store.js";
import { createSecureStageExecutorPatchBroadcastAdapter, stagePatchRelayDedupeKey } from "../src/stage-patches/safe-broadcast-adapter.js";
import { stagePatchNonceKey } from "../src/stage-patches/keys.js";
import type {
  StageExecutorPatchBroadcastAdapter,
  StageExecutorPatchBroadcastRequest,
  StagePatchBroadcastResult
} from "../src/stage-patches/types.js";
import { InMemoryAuditSink } from "../src/security/audit.js";
import type { Address, Hex } from "../src/shared/types.js";

const stateMachineAddress = `0x${"91".repeat(20)}` as Address;
const onchainOrderId = `0x${"92".repeat(32)}` as Hex;
const targetStageId = `0x${"93".repeat(32)}` as Hex;
const selectorWallet = `0x${"94".repeat(20)}` as Address;
const txHash = `0x${"95".repeat(32)}` as Hex;

let dedupeStore: PostgresBroadcastDedupeStore;

beforeAll(async () => {
  dedupeStore = new PostgresBroadcastDedupeStore({
    databaseUrl: await createPostgresTestDatabase()
  });
});

afterAll(async () => {
  await dedupeStore.close();
});

function preparedDto(patchNonce: string) {
  return {
    prepareId: `prep-${patchNonce}`,
    taskId: "task-1",
    orderId: "order-1",
    onchainOrderId,
    stateMachineAddress,
    planId: `0x${"96".repeat(32)}`,
    selectorStageId: `0x${"97".repeat(32)}`,
    targetStageId,
    selectorWallet,
    executorWallet: `0x${"98".repeat(20)}`,
    mode: "assign",
    modeHash: `0x${"99".repeat(32)}`,
    executorAuthorizations: [],
    authorizationsHash: `0x${"9a".repeat(32)}`,
    roleHash: `0x${"9b".repeat(32)}`,
    executorMetadataHash: `0x${"9c".repeat(32)}`,
    patchHash: `0x${"9d".repeat(32)}`,
    patchNonce,
    metadataURI: "uvp://patch",
    deadline: "1893456000",
    expiresAt: "2030-01-01T00:00:00.000Z",
    status: "prepared",
    typedData: { domain: { chainId: 31337 } },
    humanSummary: {}
  };
}

function executorRequest(patchNonce: string): StageExecutorPatchBroadcastRequest {
  return {
    prepared: preparedDto(patchNonce) as never,
    signature: `0x${"aa".repeat(65)}` as Hex,
    recoveredSelector: selectorWallet,
    bindingProof: { targetSourceId: targetStageId, signalId: `0x${"ab".repeat(32)}`, stageId: targetStageId } as never,
    candidateProof: [],
    executorAuthorizations: []
  } as never;
}

function submittedResult(): StagePatchBroadcastResult {
  return { status: "submitted", txHash, attempt: { status: "submitted", txHash } };
}

function recordingAdapter(
  result: () => Promise<StagePatchBroadcastResult>
): StageExecutorPatchBroadcastAdapter & { readonly calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    async broadcast() {
      calls += 1;
      return result();
    }
  };
}

describe("stage-patches relay safety", () => {
  it("derives the relay dedupe key from the same inputs as the prepare nonce key", () => {
    const request = executorRequest("7");
    expect(stagePatchRelayDedupeKey("executor", request)).toBe(stagePatchNonceKey({
      kind: "executor",
      chainId: 31337,
      stateMachineAddress,
      orderId: onchainOrderId,
      targetStageId,
      patchNonce: "7"
    }));
  });

  it("does not re-broadcast a submitted patch after a relay restart (persistent dedupe)", async () => {
    const audit = new InMemoryAuditSink();
    const request = executorRequest("restart-1");
    const firstInner = recordingAdapter(async () => submittedResult());
    const first = createSecureStageExecutorPatchBroadcastAdapter({
      adapter: firstInner,
      dedupeStore,
      audit,
      now: () => new Date("2026-10-26T00:00:00.000Z")
    });
    const firstResult = await first.broadcast(request);
    expect(firstResult).toMatchObject({ status: "submitted", txHash });
    expect(firstInner.calls()).toBe(1);

    const restartedInner = recordingAdapter(async () => submittedResult());
    const restarted = createSecureStageExecutorPatchBroadcastAdapter({
      adapter: restartedInner,
      dedupeStore,
      audit,
      now: () => new Date("2026-10-26T00:00:00.000Z")
    });
    const duplicate = await restarted.broadcast(request);
    expect(duplicate).toMatchObject({ status: "submitted", txHash });
    expect(restartedInner.calls()).toBe(0);
    expect(audit.list()).toContainEqual(expect.objectContaining({
      type: "relayer.broadcast.duplicate",
      outcome: "duplicate"
    }));
  });

  it("retries retryable failures and dead-letters once the attempt budget is consumed", async () => {
    const request = executorRequest("retry-1");
    const inner = recordingAdapter(async () => ({
      status: "failed",
      errorCode: "rpc_timeout",
      message: "rpc timed out",
      retryable: true,
      attempt: { status: "failed", errorCode: "rpc_timeout", errorMessage: "rpc timed out", retryable: true }
    }));
    const adapter = createSecureStageExecutorPatchBroadcastAdapter({
      adapter: inner,
      maxRetry: 1,
      retryBaseMs: 1,
      retryMaxMs: 10,
      now: () => new Date("2026-10-26T00:00:00.000Z")
    });

    expect(await adapter.broadcast(request)).toMatchObject({ status: "failed", errorCode: "rpc_timeout", retryable: true });
    expect(await adapter.broadcast(request)).toMatchObject({ status: "failed", errorCode: "rpc_timeout", retryable: true });
    expect(inner.calls()).toBe(2);

    const exhausted = await adapter.broadcast(request);
    expect(exhausted).toMatchObject({ status: "failed", errorCode: "broadcast_retry_exhausted", retryable: false });
    expect(inner.calls()).toBe(2);
  });

  it("rate limits a second in-flight broadcast for the same order", async () => {
    const request = executorRequest("rate-1");
    const otherRequest = executorRequest("rate-2");
    let releaseFirst: ((result: StagePatchBroadcastResult) => void) | undefined;
    const inner: StageExecutorPatchBroadcastAdapter = {
      broadcast: () => new Promise<StagePatchBroadcastResult>((resolve) => {
        releaseFirst = resolve;
      })
    };
    const adapter = createSecureStageExecutorPatchBroadcastAdapter({ adapter: inner, maxRetry: 3 });

    const inFlight = adapter.broadcast(request);
    await Promise.resolve();
    const blocked = await adapter.broadcast(otherRequest);
    expect(blocked).toMatchObject({ status: "failed", errorCode: "broadcast_rate_limited", retryable: true });
    releaseFirst?.(submittedResult());
    await expect(inFlight).resolves.toMatchObject({ status: "submitted", txHash });
  });

  it("rejects a txHash already claimed by another patch", async () => {
    const firstInner = recordingAdapter(async () => submittedResult());
    const first = createSecureStageExecutorPatchBroadcastAdapter({
      adapter: firstInner,
      dedupeStore,
      now: () => new Date("2026-10-26T00:00:00.000Z")
    });
    await first.broadcast(executorRequest("tx-owner-1"));

    const secondInner = recordingAdapter(async () => submittedResult());
    const second = createSecureStageExecutorPatchBroadcastAdapter({
      adapter: secondInner,
      dedupeStore,
      now: () => new Date("2026-10-26T00:00:00.000Z")
    });
    const duplicate = await second.broadcast(executorRequest("tx-owner-2"));
    expect(duplicate).toMatchObject({ status: "failed", errorCode: "duplicate_tx_hash", retryable: false });
    expect(secondInner.calls()).toBe(1);
  });
});
