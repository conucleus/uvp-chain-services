import type { Hex } from "../shared/types.js";

export type TxReconcileStatus =
  | "broadcasting"
  | "submitted"
  | "indexing"
  | "confirmed"
  | "failed"
  | "stale_pending";

export type TxReceiptStatus = "not_checked" | "missing" | "unknown" | "success" | "failed" | "timeout";

export type TxProjectionStatus = "not_checked" | "missing" | "present";

export interface TxReconcileFields {
  readonly reconcileStatus?: TxReconcileStatus;
  readonly lastCheckedAt?: string;
  readonly receiptStatus?: TxReceiptStatus;
  readonly projectionStatus?: TxProjectionStatus;
}

/**
 * 同身份重开闸（「重试=同身份重放」纪律的单一裁决点，UB-3/UA-2）：
 * 只有「无 txHash 的可重试失败」行可以被同身份重开——BFF prepare 对同一
 * draft 的重试必须复用该行的 prepareId/payloadHash/orderId（同身份重放），
 * 不得再生新身份派生第二个链上订单（一事两单）。带 txHash 的失败行
 * 永不重开：链上已有可探事实，回执/投影复核（对账接管）是其唯一收敛
 * 车道；无 txHash 且不可重试的失败也没有重放价值。
 * 与 stage-patches 的同款口径（"only a retryable failure with no txHash
 * is safe to reopen"）：BFF prepare 重建门、triggerOrder 直提门与本
 * worker 的 failed 行复核归属共用本判定，不留第二身份再生入口。
 */
export function isReopenableFailedTriggerRecord(
  record: {
    readonly status: string;
    readonly retryable: boolean;
    readonly txHash?: Hex;
  },
): boolean {
  return record.status === "failed" && record.retryable && !record.txHash;
}

export interface ReconcileRunSummary {
  readonly registrationsChecked: number;
  readonly submissionsChecked: number;
  readonly governanceLogsChecked: number;
  /** stage-patch 台账（执行者/资源补丁）本轮复核的未闭环行数。 */
  readonly stagePatchesChecked: number;
  /** 证据绑定清扫检查的提交数（持 txHash 且落库了证据引用的记录）。 */
  readonly evidenceBindsSwept: number;
  /** 本轮补绑成功的证据数。 */
  readonly evidenceBindsRepaired: number;
  readonly updated: number;
  readonly failed: number;
}

export interface ReconcileWorkerDiagnostics {
  readonly enabled: boolean;
  readonly running: boolean;
  readonly checking: boolean;
  readonly pollIntervalMs: number;
  readonly txTimeoutMs: number;
  readonly lastRunAt?: string;
  readonly lastSummary?: ReconcileRunSummary;
  readonly lastError?: string;
}
