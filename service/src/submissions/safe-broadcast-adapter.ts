// submissions 车道的 relay 适配：把 SubmissionBroadcastResult 的形状映射到
// relay 安全核心（dedupe/限流/重试/审计单源在 src/relay）。本文件只保留
// submissions 的结果词表与失败结果工厂，不复制安全机制。

import type { AuditSink } from "../security/audit.js";
import { createRelayBroadcastSafety, type RelayBroadcastLane, type RelayFailureInput } from "../relay/safe-broadcast.js";
import { relayRetryStateFor } from "../relay/retry.js";
import type { RelayDedupeStore } from "../relay/dedupe-store.js";
import type {
  SubmissionBroadcastAdapter,
  SubmissionBroadcastRequest,
  SubmissionBroadcastResult
} from "./types.js";
import type { BroadcastDedupeStore } from "./broadcast-dedupe-postgres-store.js";

type FailedSubmissionBroadcastResult = Extract<SubmissionBroadcastResult, { readonly status: "failed" }>;

export interface SecureSubmissionBroadcastAdapterOptions {
  readonly adapter: SubmissionBroadcastAdapter;
  readonly maxInFlightPerOrder?: number;
  readonly maxInFlightPerSubmitter?: number;
  readonly maxRetry?: number;
  readonly maxRetryAttempts?: number;
  readonly retryBaseMs?: number;
  readonly retryMaxMs?: number;
  readonly now?: () => Date;
  readonly audit?: AuditSink;
  readonly dedupeStore?: BroadcastDedupeStore;
}

const submissionLane: RelayBroadcastLane<SubmissionBroadcastRequest, SubmissionBroadcastResult> = {
  actionOf: (request) => request.prepared.signalName,
  idempotencyKeyOf: (request) => request.prepared.idempotencyKey,
  orderKeyOf: (request) => request.prepared.onchainOrderId,
  submitterOf: (request) => request.prepared.submitter,
  subjectOf: auditSubject,
  txHashOf: broadcastResultTxHash,
  isFailed: (result) => result.status === "failed",
  isRetryable: (result) => result.status === "failed" && result.retryable,
  deadLetterOf: (result) => (result.status === "failed" ? result.deadLetter : undefined),
  nextRetryAtOf: (result) => (result.status === "failed" ? result.nextRetryAt : undefined),
  errorCodeOf: (result) => (result.status === "failed" ? result.errorCode : undefined),
  failure: failedBroadcastResult,
  withAttempt: withAttemptMetadata,
  failureAuditMetadata: (result) => {
    if (result.status !== "failed") {
      return {};
    }
    const retryState = result.retryState ?? relayRetryStateFor(result.retryable, result.deadLetter ?? !result.retryable);
    const deadLetter = result.deadLetter ?? !result.retryable;
    return {
      retryState,
      deadLetter,
      ...(result.nextRetryAt ? { nextRetryAt: result.nextRetryAt } : {})
    };
  }
};

export function createSecureSubmissionBroadcastAdapter(
  options: SecureSubmissionBroadcastAdapterOptions
): SubmissionBroadcastAdapter {
  const dedupeStore: RelayDedupeStore | undefined = options.dedupeStore;
  return createRelayBroadcastSafety<SubmissionBroadcastRequest, SubmissionBroadcastResult>({
    broadcast: (request) => options.adapter.broadcast(request),
    lane: submissionLane,
    attemptsBroadcast: options.adapter.attemptsBroadcast !== false,
    ...(options.maxInFlightPerOrder !== undefined ? { maxInFlightPerOrder: options.maxInFlightPerOrder } : {}),
    ...(options.maxInFlightPerSubmitter !== undefined ? { maxInFlightPerSubmitter: options.maxInFlightPerSubmitter } : {}),
    ...(options.maxRetry !== undefined ? { maxRetry: options.maxRetry } : {}),
    ...(options.maxRetryAttempts !== undefined ? { maxRetryAttempts: options.maxRetryAttempts } : {}),
    ...(options.retryBaseMs !== undefined ? { retryBaseMs: options.retryBaseMs } : {}),
    ...(options.retryMaxMs !== undefined ? { retryMaxMs: options.retryMaxMs } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.audit !== undefined ? { audit: options.audit } : {}),
    ...(dedupeStore !== undefined ? { dedupeStore } : {})
  });
}

function withAttemptMetadata(
  result: SubmissionBroadcastResult,
  attempt: {
    readonly attemptNumber: number;
    readonly retryState: "retryable" | "not_retryable" | "dead_letter";
    readonly deadLetter: boolean;
    readonly nextRetryAt?: string;
  }
): SubmissionBroadcastResult {
  if (result.status === "failed") {
    const retryState = result.retryState ?? attempt.retryState;
    const deadLetter = result.deadLetter ?? attempt.deadLetter;
    const previousAttempt = result.attempt ?? { status: "failed" as const };
    return {
      ...result,
      retryState,
      deadLetter,
      ...(attempt.nextRetryAt ? { nextRetryAt: attempt.nextRetryAt } : {}),
      attempt: {
        ...previousAttempt,
        attemptNumber: previousAttempt.attemptNumber ?? attempt.attemptNumber,
        retryable: previousAttempt.retryable ?? result.retryable,
        retryState: previousAttempt.retryState ?? retryState,
        deadLetter: previousAttempt.deadLetter ?? deadLetter,
        ...(attempt.nextRetryAt ? { nextRetryAt: attempt.nextRetryAt } : {})
      }
    };
  }
  if (!("attempt" in result) || !result.attempt) {
    return result;
  }
  return {
    ...result,
    attempt: {
      ...result.attempt,
      attemptNumber: result.attempt.attemptNumber ?? attempt.attemptNumber,
      retryable: result.attempt.retryable ?? false,
      retryState: result.attempt.retryState ?? "not_applicable",
      deadLetter: result.attempt.deadLetter ?? false
    }
  };
}

function failedBroadcastResult(input: RelayFailureInput): FailedSubmissionBroadcastResult {
  const deadLetter = input.deadLetter ?? !input.retryable;
  const retryState = relayRetryStateFor(input.retryable, deadLetter);
  return {
    status: "failed",
    errorCode: input.errorCode,
    errorLabel: errorLabelForBroadcastError(input.errorCode),
    message: input.message,
    retryable: input.retryable,
    retryState,
    deadLetter,
    ...(input.nextRetryAt ? { nextRetryAt: input.nextRetryAt } : {}),
    attempt: {
      status: "failed",
      errorCode: input.errorCode,
      errorLabel: errorLabelForBroadcastError(input.errorCode),
      errorMessage: input.message,
      attemptNumber: input.attempts + 1,
      retryable: input.retryable,
      retryState,
      deadLetter,
      ...(input.nextRetryAt ? { nextRetryAt: input.nextRetryAt } : {})
    }
  };
}

function broadcastResultTxHash(result: SubmissionBroadcastResult): string | undefined {
  return result.status === "submitted" || result.status === "confirmed" || result.status === "broadcasting"
    ? result.txHash
    : result.status === "failed"
      ? result.attempt?.txHash
      : undefined;
}

function auditSubject(request: SubmissionBroadcastRequest): Record<string, unknown> {
  return {
    prepareId: request.prepared.prepareId,
    taskId: request.prepared.taskId,
    orderId: request.prepared.orderId,
    onchainOrderId: request.prepared.onchainOrderId,
    signalName: request.prepared.signalName,
    idempotencyKey: request.prepared.idempotencyKey,
    submitter: request.prepared.submitter
  };
}

function errorLabelForBroadcastError(errorCode: string): string {
  switch (errorCode) {
    case "broadcast_rate_limited":
      return "Broadcast is rate limited";
    case "broadcast_retry_exhausted":
      return "Retry limit reached";
    case "duplicate_tx_hash":
      return "Duplicate transaction hash";
    case "invalid_signal_signature":
      return "Wallet signature is invalid";
    case "rpc_timeout":
      return "RPC request timed out";
    default:
      return errorCode;
  }
}
