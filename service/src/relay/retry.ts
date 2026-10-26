// relay 重试调度单源：退避时刻与 retry 状态词由本模块给出，广播安全层与
// 各车道失败结果工厂共用；不引入业务状态。

export interface RelayRetryPolicy {
  readonly maxRetry: number;
  readonly retryBaseMs: number;
  readonly retryMaxMs: number;
  readonly now: () => Date;
}

export type RelayRetryState = "retryable" | "not_retryable" | "dead_letter";

export function relayRetryStateFor(retryable: boolean, deadLetter: boolean): RelayRetryState {
  if (deadLetter) {
    return "dead_letter";
  }
  return retryable ? "retryable" : "not_retryable";
}

export function relayRetrySchedule(
  attempts: number,
  policy: Pick<RelayRetryPolicy, "retryBaseMs" | "retryMaxMs" | "now">
): { readonly nextRetryAt?: string } {
  if (policy.retryBaseMs <= 0 || policy.retryMaxMs <= 0) {
    return {};
  }
  const exponent = Math.max(attempts - 1, 0);
  const delayMs = Math.min(policy.retryMaxMs, policy.retryBaseMs * 2 ** exponent);
  return {
    nextRetryAt: new Date(policy.now().getTime() + delayMs).toISOString()
  };
}
