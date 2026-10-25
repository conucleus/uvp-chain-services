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
  readonly stagePatchesChecked: number;
  readonly evidenceBindsSwept: number;
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
