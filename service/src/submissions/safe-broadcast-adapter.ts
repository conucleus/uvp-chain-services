import type { AuditSink } from "../security/audit.js";
import { noopAuditSink } from "../security/audit.js";
import type {
  SubmissionBroadcastAdapter,
  SubmissionBroadcastRequest,
  SubmissionBroadcastResult
} from "./types.js";
import type { BroadcastDedupeStore } from "./broadcast-dedupe-sqlite-store.js";

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
  /**
   * ETH-07：可选持久化去重存储。进程内 Map 仍是主缓存（语义不变），
   * 持久层保证重启后同一 idempotencyKey / txHash 依旧被去重。
   */
  readonly dedupeStore?: BroadcastDedupeStore;
}

interface BroadcastState {
  readonly attempts: number;
  readonly lastResult: SubmissionBroadcastResult;
}

const DEFAULT_MAX_IN_FLIGHT_PER_ORDER = 1;
const DEFAULT_MAX_IN_FLIGHT_PER_SUBMITTER = 1;
const DEFAULT_MAX_RETRY = 3;
const DEFAULT_RETRY_BASE_MS = 250;
const DEFAULT_RETRY_MAX_MS = 5_000;

export function createSecureSubmissionBroadcastAdapter(
  options: SecureSubmissionBroadcastAdapterOptions
): SubmissionBroadcastAdapter {
  const audit = options.audit ?? noopAuditSink;
  const maxInFlightPerOrder = options.maxInFlightPerOrder ?? DEFAULT_MAX_IN_FLIGHT_PER_ORDER;
  const maxInFlightPerSubmitter = options.maxInFlightPerSubmitter ?? DEFAULT_MAX_IN_FLIGHT_PER_SUBMITTER;
  const maxRetry = options.maxRetryAttempts ?? options.maxRetry ?? DEFAULT_MAX_RETRY;
  const retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
  const retryMaxMs = options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS;
  const now = options.now ?? (() => new Date());
  const states = new Map<string, BroadcastState>();
  const inFlightByOrder = new Map<string, number>();
  const inFlightBySubmitter = new Map<string, number>();
  const txHashOwners = new Map<string, string>();
  const dedupeStore = options.dedupeStore;

  const currentStateFor = async (idempotencyKey: string): Promise<BroadcastState | undefined> =>
    states.get(idempotencyKey) ?? (dedupeStore ? await dedupeStore.load(idempotencyKey) : undefined);

  return {
    attemptsBroadcast: options.adapter.attemptsBroadcast !== false,
    async broadcast(request) {
      const idempotencyKey = request.prepared.idempotencyKey;
      const orderKey = request.prepared.onchainOrderId;
      const submitterKey = request.prepared.submitter;
      const currentState = await currentStateFor(idempotencyKey);
      const duplicate = duplicateResult(currentState, maxRetry);
      if (duplicate) {
        const duplicateFailure = duplicate.status === "failed" ? duplicate : undefined;
        await audit.record({
          type: "relayer.broadcast.duplicate",
          action: request.prepared.signalName,
          outcome: duplicateFailure ? "blocked" : "duplicate",
          subject: auditSubject(request),
          ...(duplicateFailure ? {
            errorCode: duplicateFailure.errorCode,
            retryable: duplicateFailure.retryable
          } : {})
        });
        return duplicate;
      }

      // TOCTOU 修复：在任何 await 之前同步占位（先占后查），并发进入的
      // 同单/同人广播各自拿到递增的占位数，超额者立即释放并限流返回，
      // 不再出现"双方都读到 0、双双放行"的穿透窗口。
      const acquiredOrderInFlight = (inFlightByOrder.get(orderKey) ?? 0) + 1;
      inFlightByOrder.set(orderKey, acquiredOrderInFlight);
      const acquiredSubmitterInFlight = (inFlightBySubmitter.get(submitterKey) ?? 0) + 1;
      inFlightBySubmitter.set(submitterKey, acquiredSubmitterInFlight);
      try {
        if (acquiredOrderInFlight > maxInFlightPerOrder) {
          const result = failedBroadcastResult(
            "broadcast_rate_limited",
            "another broadcast is already in flight for this order",
            true,
            currentState?.attempts ?? 0,
            retrySchedule(currentState?.attempts ?? 0, { now, retryBaseMs, retryMaxMs })
          );
          await audit.record({
            type: "relayer.broadcast.rate_limited",
            action: request.prepared.signalName,
            outcome: "blocked",
            subject: auditSubject(request),
            errorCode: result.errorCode,
            retryable: result.retryable
          });
          return result;
        }
        if (acquiredSubmitterInFlight > maxInFlightPerSubmitter) {
          const result = failedBroadcastResult(
            "broadcast_rate_limited",
            "another broadcast is already in flight for this submitter",
            true,
            currentState?.attempts ?? 0,
            retrySchedule(currentState?.attempts ?? 0, { now, retryBaseMs, retryMaxMs })
          );
          await audit.record({
            type: "relayer.broadcast.rate_limited",
            action: request.prepared.signalName,
            outcome: "blocked",
            subject: auditSubject(request),
            errorCode: result.errorCode,
            retryable: result.retryable
          });
          return result;
        }

        const attemptNumber = (currentState?.attempts ?? 0) + 1;
        if (attemptNumber > 1) {
          await audit.record({
            type: "relayer.broadcast.retry",
            action: request.prepared.signalName,
            outcome: "retry",
            subject: auditSubject(request),
            metadata: { attemptNumber }
          });
        } else {
          await audit.record({
            type: "relayer.submit.request",
            action: request.prepared.signalName,
            outcome: "accepted",
            subject: auditSubject(request)
          });
        }

        const broadcast = withAttemptMetadata(await options.adapter.broadcast(request), attemptNumber, {
          now,
          retryBaseMs,
          retryMaxMs
        });
        const duplicateTxHash = await duplicateTxHashResult(idempotencyKey, broadcast, txHashOwners, attemptNumber, dedupeStore);
        const result = duplicateTxHash ?? broadcast;
        const newState = {
          attempts: attemptNumber,
          lastResult: result
        };
        states.set(idempotencyKey, newState);
        // ETH-07：写穿持久层；失败不吞——与内存路径同等严格。
        await dedupeStore?.save(idempotencyKey, newState);

        if (result.status === "failed") {
          await audit.record({
            type: "relayer.broadcast.failed",
            action: request.prepared.signalName,
            outcome: "failed",
            subject: auditSubject(request),
            errorCode: result.errorCode,
            retryable: result.retryable,
            metadata: {
              retryState: result.retryState ?? retryStateFor(result.retryable, result.deadLetter ?? !result.retryable),
              deadLetter: result.deadLetter ?? !result.retryable,
              ...(result.nextRetryAt ? { nextRetryAt: result.nextRetryAt } : {})
            }
          });
        }
        return result;
      } finally {
        releaseInFlight(inFlightByOrder, orderKey);
        releaseInFlight(inFlightBySubmitter, submitterKey);
      }
    }
  };
}

function releaseInFlight(counts: Map<string, number>, key: string): void {
  const next = (counts.get(key) ?? 1) - 1;
  if (next <= 0) {
    counts.delete(key);
  } else {
    counts.set(key, next);
  }
}

function duplicateResult(
  state: BroadcastState | undefined,
  maxRetry: number
): SubmissionBroadcastResult | undefined {
  if (!state) {
    return undefined;
  }

  const lastResult = state.lastResult;
  if (lastResult.status === "failed") {
    if (!lastResult.retryable) {
      return failedBroadcastResult("broadcast_retry_blocked", "last broadcast failure is not retryable", false, state.attempts, {
        deadLetter: true
      });
    }
    if (state.attempts > maxRetry) {
      return failedBroadcastResult("broadcast_retry_exhausted", "broadcast retry limit has been reached", false, state.attempts, {
        deadLetter: true
      });
    }
    return undefined;
  }

  return lastResult;
}

async function duplicateTxHashResult(
  idempotencyKey: string,
  result: SubmissionBroadcastResult,
  txHashOwners: Map<string, string>,
  attemptNumber: number,
  dedupeStore: BroadcastDedupeStore | undefined
): Promise<SubmissionBroadcastResult | undefined> {
  const txHash = result.status === "submitted" || result.status === "confirmed" || result.status === "broadcasting"
    ? result.txHash
    : result.status === "failed"
      ? result.attempt?.txHash
      : undefined;
  if (!txHash) {
    return undefined;
  }

  const normalizedTxHash = txHash.toLowerCase();
  let owner = txHashOwners.get(normalizedTxHash);
  if (!owner && dedupeStore) {
    // ETH-07：内存未命中时问持久层；无归属则登记归属。
    owner = await dedupeStore.claimTxHash(normalizedTxHash, idempotencyKey);
  }
  if (!owner) {
    txHashOwners.set(normalizedTxHash, idempotencyKey);
    return undefined;
  }
  if (owner === idempotencyKey) {
    return undefined;
  }
  return failedBroadcastResult("duplicate_tx_hash", "broadcast returned a txHash already recorded for another submission", false, attemptNumber, {
    deadLetter: true
  });
}

function withAttemptMetadata(
  result: SubmissionBroadcastResult,
  attemptNumber: number,
  scheduleOptions: {
    readonly now: () => Date;
    readonly retryBaseMs: number;
    readonly retryMaxMs: number;
  }
): SubmissionBroadcastResult {
  if (result.status === "failed") {
    const deadLetter = result.deadLetter ?? !result.retryable;
    const retryState = result.retryState ?? retryStateFor(result.retryable, deadLetter);
    const schedule = result.nextRetryAt
      ? { nextRetryAt: result.nextRetryAt }
      : result.retryable
        ? retrySchedule(attemptNumber, scheduleOptions)
        : {};
    const attempt = result.attempt ?? { status: "failed" as const };
    return {
      ...result,
      retryState,
      deadLetter,
      ...schedule,
      attempt: {
        ...attempt,
        attemptNumber: attempt.attemptNumber ?? attemptNumber,
        retryable: attempt.retryable ?? result.retryable,
        retryState: attempt.retryState ?? retryState,
        deadLetter: attempt.deadLetter ?? deadLetter,
        ...("nextRetryAt" in schedule && schedule.nextRetryAt ? { nextRetryAt: schedule.nextRetryAt } : {})
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
      attemptNumber: result.attempt.attemptNumber ?? attemptNumber,
      retryable: result.attempt.retryable ?? false,
      retryState: result.attempt.retryState ?? "not_applicable",
      deadLetter: result.attempt.deadLetter ?? false
    }
  };
}

function failedBroadcastResult(
  errorCode: string,
  message: string,
  retryable: boolean,
  attempts: number,
  options: {
    readonly deadLetter?: boolean;
    readonly nextRetryAt?: string;
  } = {}
): FailedSubmissionBroadcastResult {
  const deadLetter = options.deadLetter ?? !retryable;
  const retryState = retryStateFor(retryable, deadLetter);
  return {
    status: "failed",
    errorCode,
    errorLabel: errorLabelForBroadcastError(errorCode),
    message,
    retryable,
    retryState,
    deadLetter,
    ...(options.nextRetryAt ? { nextRetryAt: options.nextRetryAt } : {}),
    attempt: {
      status: "failed",
      errorCode,
      errorLabel: errorLabelForBroadcastError(errorCode),
      errorMessage: message,
      attemptNumber: attempts + 1,
      retryable,
      retryState,
      deadLetter,
      ...(options.nextRetryAt ? { nextRetryAt: options.nextRetryAt } : {})
    }
  };
}

function retrySchedule(
  attempts: number,
  options: {
    readonly now: () => Date;
    readonly retryBaseMs: number;
    readonly retryMaxMs: number;
  }
): { readonly nextRetryAt?: string } {
  if (options.retryBaseMs <= 0 || options.retryMaxMs <= 0) {
    return {};
  }
  const exponent = Math.max(attempts - 1, 0);
  const delayMs = Math.min(options.retryMaxMs, options.retryBaseMs * 2 ** exponent);
  return {
    nextRetryAt: new Date(options.now().getTime() + delayMs).toISOString()
  };
}

function retryStateFor(retryable: boolean, deadLetter: boolean): "retryable" | "not_retryable" | "dead_letter" {
  if (deadLetter) {
    return "dead_letter";
  }
  return retryable ? "retryable" : "not_retryable";
}

function errorLabelForBroadcastError(errorCode: string): string {
  switch (errorCode) {
    case "broadcast_rate_limited":
      return "Broadcast is rate limited";
    case "broadcast_retry_blocked":
      return "Retry is blocked";
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
