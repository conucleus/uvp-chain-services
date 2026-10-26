// 广播安全单一实现：持久 dedupe（幂等键 → attempts/lastResult + txHash 归属）、
// per-order/per-submitter in-flight 限流、重试上限、失败/重复审计。两条 relay
// 车道（submissions、stage-patches）只提供键/结果访问器与失败结果工厂；业务
// 状态、签名、证据、订单语义不进本模块。

import type { AuditSink } from "../security/audit.js";
import { noopAuditSink } from "../security/audit.js";
import type { RelayDedupeState, RelayDedupeStore } from "./dedupe-store.js";
import {
  relayRetrySchedule,
  relayRetryStateFor,
  type RelayRetryPolicy,
  type RelayRetryState
} from "./retry.js";

const DEFAULT_MAX_IN_FLIGHT_PER_ORDER = 1;
const DEFAULT_MAX_IN_FLIGHT_PER_SUBMITTER = 1;
const DEFAULT_MAX_RETRY = 3;
const DEFAULT_RETRY_BASE_MS = 250;
const DEFAULT_RETRY_MAX_MS = 5_000;

export interface RelayFailureInput {
  readonly errorCode: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly attempts: number;
  readonly deadLetter?: boolean;
  readonly nextRetryAt?: string;
}

export interface RelayAttemptInput {
  readonly attemptNumber: number;
  readonly retryState: RelayRetryState;
  readonly deadLetter: boolean;
  readonly nextRetryAt?: string;
}

export interface RelayBroadcastLane<TRequest, TResult> {
  readonly actionOf: (request: TRequest) => string;
  readonly idempotencyKeyOf: (request: TRequest) => string;
  readonly orderKeyOf: (request: TRequest) => string;
  readonly submitterOf: (request: TRequest) => string;
  readonly subjectOf: (request: TRequest) => Readonly<Record<string, unknown>>;
  readonly txHashOf: (result: TResult) => string | undefined;
  readonly isFailed: (result: TResult) => boolean;
  readonly isRetryable: (result: TResult) => boolean;
  readonly deadLetterOf?: (result: TResult) => boolean | undefined;
  readonly nextRetryAtOf?: (result: TResult) => string | undefined;
  readonly errorCodeOf: (result: TResult) => string | undefined;
  readonly failure: (input: RelayFailureInput) => TResult;
  readonly withAttempt?: (result: TResult, attempt: RelayAttemptInput) => TResult;
  readonly failureAuditMetadata?: (result: TResult) => Readonly<Record<string, unknown>>;
}

export interface RelayBroadcastSafetyOptions<TRequest, TResult> {
  readonly broadcast: (request: TRequest) => Promise<TResult>;
  readonly lane: RelayBroadcastLane<TRequest, TResult>;
  readonly attemptsBroadcast?: boolean;
  readonly maxInFlightPerOrder?: number;
  readonly maxInFlightPerSubmitter?: number;
  readonly maxRetry?: number;
  readonly maxRetryAttempts?: number;
  readonly retryBaseMs?: number;
  readonly retryMaxMs?: number;
  readonly now?: () => Date;
  readonly audit?: AuditSink;
  readonly dedupeStore?: RelayDedupeStore;
}

export interface RelayBroadcastAdapter<TRequest, TResult> {
  readonly attemptsBroadcast: boolean;
  broadcast(request: TRequest): Promise<TResult>;
}

interface BroadcastState<TResult> {
  readonly attempts: number;
  readonly lastResult: TResult;
}

export function createRelayBroadcastSafety<TRequest, TResult>(
  options: RelayBroadcastSafetyOptions<TRequest, TResult>
): RelayBroadcastAdapter<TRequest, TResult> {
  const audit = options.audit ?? noopAuditSink;
  const lane = options.lane;
  const maxInFlightPerOrder = options.maxInFlightPerOrder ?? DEFAULT_MAX_IN_FLIGHT_PER_ORDER;
  const maxInFlightPerSubmitter = options.maxInFlightPerSubmitter ?? DEFAULT_MAX_IN_FLIGHT_PER_SUBMITTER;
  const policy: RelayRetryPolicy = {
    maxRetry: options.maxRetryAttempts ?? options.maxRetry ?? DEFAULT_MAX_RETRY,
    retryBaseMs: options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS,
    retryMaxMs: options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS,
    now: options.now ?? (() => new Date())
  };
  const states = new Map<string, BroadcastState<TResult>>();
  const inFlightByOrder = new Map<string, number>();
  const inFlightBySubmitter = new Map<string, number>();
  const txHashOwners = new Map<string, string>();
  const dedupeStore = options.dedupeStore;

  const currentStateFor = async (idempotencyKey: string): Promise<BroadcastState<TResult> | undefined> => {
    const cached = states.get(idempotencyKey);
    if (cached) {
      return cached;
    }
    const persisted = await dedupeStore?.load(idempotencyKey);
    return persisted ? stateFromPersisted<TResult>(persisted) : undefined;
  };

  const rateLimited = (request: TRequest, message: string, state: BroadcastState<TResult> | undefined) =>
    lane.failure({
      errorCode: "broadcast_rate_limited",
      message,
      retryable: true,
      attempts: state?.attempts ?? 0,
      ...relayRetrySchedule(state?.attempts ?? 0, policy)
    });

  return {
    attemptsBroadcast: options.attemptsBroadcast !== false,
    async broadcast(request) {
      const idempotencyKey = lane.idempotencyKeyOf(request);
      const orderKey = lane.orderKeyOf(request);
      const submitterKey = lane.submitterOf(request);
      const currentState = await currentStateFor(idempotencyKey);
      const duplicate = duplicateResult(currentState, lane, policy.maxRetry);
      if (duplicate) {
        const failed = lane.isFailed(duplicate);
        const duplicateErrorCode = failed ? lane.errorCodeOf(duplicate) : undefined;
        await audit.record({
          type: "relayer.broadcast.duplicate",
          action: lane.actionOf(request),
          outcome: failed ? "blocked" : "duplicate",
          subject: lane.subjectOf(request),
          ...(failed && duplicateErrorCode !== undefined ? { errorCode: duplicateErrorCode } : {}),
          ...(failed ? { retryable: lane.isRetryable(duplicate) } : {})
        });
        return duplicate;
      }

      const acquiredOrderInFlight = (inFlightByOrder.get(orderKey) ?? 0) + 1;
      inFlightByOrder.set(orderKey, acquiredOrderInFlight);
      const acquiredSubmitterInFlight = (inFlightBySubmitter.get(submitterKey) ?? 0) + 1;
      inFlightBySubmitter.set(submitterKey, acquiredSubmitterInFlight);
      try {
        const orderRateLimited = acquiredOrderInFlight > maxInFlightPerOrder;
        const submitterRateLimited = acquiredSubmitterInFlight > maxInFlightPerSubmitter;
        if (orderRateLimited || submitterRateLimited) {
          const result = rateLimited(
            request,
            orderRateLimited
              ? "another broadcast is already in flight for this order"
              : "another broadcast is already in flight for this submitter",
            currentState
          );
          await audit.record({
            type: "relayer.broadcast.rate_limited",
            action: lane.actionOf(request),
            outcome: "blocked",
            subject: lane.subjectOf(request),
            errorCode: "broadcast_rate_limited",
            retryable: true
          });
          return result;
        }

        const attemptNumber = (currentState?.attempts ?? 0) + 1;
        if (attemptNumber > 1) {
          await audit.record({
            type: "relayer.broadcast.retry",
            action: lane.actionOf(request),
            outcome: "retry",
            subject: lane.subjectOf(request),
            metadata: { attemptNumber }
          });
        } else {
          await audit.record({
            type: "relayer.submit.request",
            action: lane.actionOf(request),
            outcome: "accepted",
            subject: lane.subjectOf(request)
          });
        }

        const raw = await options.broadcast(request);
        const broadcast = withAttemptMetadata(raw, attemptNumber, lane, policy);
        let result: TResult;
        try {
          const duplicateTxHash = await duplicateTxHashResult(idempotencyKey, broadcast, lane, txHashOwners, attemptNumber, dedupeStore, policy);
          result = duplicateTxHash ?? broadcast;
          const newState: BroadcastState<TResult> = {
            attempts: attemptNumber,
            lastResult: result
          };
          states.set(idempotencyKey, newState);
          await dedupeStore?.save(idempotencyKey, { attempts: newState.attempts, lastResult: newState.lastResult });
        } catch (error) {
          const broadcastTxHash = lane.txHashOf(broadcast);
          if (!broadcastTxHash) {
            throw error;
          }
          await audit.record({
            type: "relayer.broadcast.dedupe_persist_failed",
            action: lane.actionOf(request),
            outcome: "failed",
            subject: lane.subjectOf(request),
            txHash: broadcastTxHash,
            errorCode: "persist_failed",
            retryable: true,
            metadata: {
              message: "broadcast dedupe ledger write failed after a real broadcast; the txHash is returned so the submission keeps its nonce and reconcile can probe the receipt"
            }
          });
          return broadcast;
        }

        if (lane.isFailed(result)) {
          const resultErrorCode = lane.errorCodeOf(result);
          const resultRetryable = lane.isRetryable(result);
          await audit.record({
            type: "relayer.broadcast.failed",
            action: lane.actionOf(request),
            outcome: "failed",
            subject: lane.subjectOf(request),
            ...(resultErrorCode !== undefined ? { errorCode: resultErrorCode } : {}),
            retryable: resultRetryable,
            metadata: lane.failureAuditMetadata?.(result) ?? {
              retryState: relayRetryStateFor(
                resultRetryable,
                lane.deadLetterOf?.(result) ?? !resultRetryable
              ),
              deadLetter: lane.deadLetterOf?.(result) ?? !resultRetryable
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

function stateFromPersisted<TResult>(persisted: RelayDedupeState): BroadcastState<TResult> {
  return {
    attempts: persisted.attempts,
    lastResult: persisted.lastResult as TResult
  };
}

function duplicateResult<TRequest, TResult>(
  state: BroadcastState<TResult> | undefined,
  lane: RelayBroadcastLane<TRequest, TResult>,
  maxRetry: number
): TResult | undefined {
  if (!state) {
    return undefined;
  }
  const lastResult = state.lastResult;
  if (!lane.isFailed(lastResult)) {
    return lastResult;
  }
  if (!lane.isRetryable(lastResult)) {
    return lastResult;
  }
  if (state.attempts > maxRetry) {
    return lane.failure({
      errorCode: "broadcast_retry_exhausted",
      message: "broadcast retry limit has been reached",
      retryable: false,
      attempts: state.attempts,
      deadLetter: true
    });
  }
  return undefined;
}

async function duplicateTxHashResult<TRequest, TResult>(
  idempotencyKey: string,
  result: TResult,
  lane: RelayBroadcastLane<TRequest, TResult>,
  txHashOwners: Map<string, string>,
  attemptNumber: number,
  dedupeStore: RelayDedupeStore | undefined,
  policy: RelayRetryPolicy
): Promise<TResult | undefined> {
  const txHash = lane.txHashOf(result);
  if (!txHash) {
    return undefined;
  }

  const normalizedTxHash = txHash.toLowerCase();
  let owner = txHashOwners.get(normalizedTxHash);
  if (!owner && dedupeStore) {
    owner = await dedupeStore.claimTxHash(normalizedTxHash, idempotencyKey);
  }
  if (!owner) {
    txHashOwners.set(normalizedTxHash, idempotencyKey);
    return undefined;
  }
  if (owner === idempotencyKey) {
    return undefined;
  }
  return lane.failure({
    errorCode: "duplicate_tx_hash",
    message: "broadcast returned a txHash already recorded for another submission",
    retryable: false,
    attempts: attemptNumber,
    deadLetter: true,
    ...relayRetrySchedule(attemptNumber, policy)
  });
}

function withAttemptMetadata<TRequest, TResult>(
  result: TResult,
  attemptNumber: number,
  lane: RelayBroadcastLane<TRequest, TResult>,
  policy: RelayRetryPolicy
): TResult {
  if (!lane.withAttempt) {
    return result;
  }
  const failed = lane.isFailed(result);
  const retryable = lane.isRetryable(result);
  const deadLetter = failed ? (lane.deadLetterOf?.(result) ?? !retryable) : false;
  const explicitNextRetryAt = lane.nextRetryAtOf?.(result);
  const schedule = explicitNextRetryAt
    ? { nextRetryAt: explicitNextRetryAt }
    : failed && retryable
      ? relayRetrySchedule(attemptNumber, policy)
      : {};
  return lane.withAttempt(result, {
    attemptNumber,
    retryState: relayRetryStateFor(retryable, deadLetter),
    deadLetter,
    ...schedule
  });
}

function releaseInFlight(counts: Map<string, number>, key: string): void {
  const next = (counts.get(key) ?? 1) - 1;
  if (next <= 0) {
    counts.delete(key);
  } else {
    counts.set(key, next);
  }
}
