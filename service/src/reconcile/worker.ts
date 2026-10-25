import { createPublicClient, defineChain, http } from "viem";
import type { GovernanceStore, GovernanceTxLogScanCursor } from "../governance/store.js";
import type { GovernanceBroadcastStatus, GovernanceTxLogDTO, GovernanceTxLogStatus, IdentityTxLogDTO } from "../governance/types.js";
import type { BindEvidenceRequestDTO, EvidencePrincipal, EvidenceProofDTO, EvidenceRecordDTO } from "../evidence/types.js";
import type { ProductBffStore } from "../product/query/bff/store.js";
import type {
  ProductOrderDraftDTO,
  ProductOrderTriggerRecord,
  ProductOrderTriggerStatus
} from "../product/query/bff/types.js";
import type { AuditSink } from "../security/audit.js";
import type { Address, Logger, Hex, LifecycleService } from "../shared/types.js";
import { noopLogger } from "../shared/types.js";
import type { ProjectionStore } from "../storage/projection-store.js";
import type { ProductSubmissionDTO, ProductSubmissionScanCursor, ProductSubmissionStore } from "../submissions/types.js";
import type {
  PreparedStageExecutorPatchRecord,
  PreparedStageResourcePatchRecord,
  ProductStageExecutorPatchStore,
  ProductStageResourcePatchStore,
  StageExecutorPatchSubmissionDTO,
  StagePatchSubmissionScanCursor,
  StageResourcePatchSubmissionDTO
} from "../stage-patches/types.js";
import type { StateMachineOrderProjection } from "../indexer/projection-types.js";
import { redactErrorMessage } from "../security/redaction.js";
import {
  isReopenableFailedTriggerRecord,
  type ReconcileRunSummary,
  type ReconcileWorkerDiagnostics,
  type TxReconcileFields
} from "./status.js";

export interface ReconcileWorkerConfig {
  readonly enabled: boolean;
  readonly pollIntervalMs: number;
  readonly txTimeoutMs: number;
  readonly scanPageSize?: number;
}

export const DEFAULT_RECONCILE_SCAN_PAGE_SIZE = 200;

const FAILED_TX_RECHECK_BASE_INTERVAL_MS = 5 * 60 * 1000;
const FAILED_TX_RECHECK_MAX_INTERVAL_MS = 60 * 60 * 1000;
const FAILED_TX_RECHECK_HORIZON_MS = 7 * 24 * 60 * 60 * 1000;

export interface ReconcileReceipt {
  readonly status?: "success" | "reverted" | "failed" | string;
  readonly blockNumber?: bigint | number | string;
}

export interface ReconcileReceiptClient {
  getTransactionReceipt(txHash: Hex): Promise<ReconcileReceipt | undefined>;
}

export interface ViemReconcileReceiptClientOptions {
  readonly rpcUrl: string;
  readonly chainId: number;
}

export interface EvidenceBindingSweeper {
  getProof(evidenceId: string, principal: EvidencePrincipal): Promise<EvidenceProofDTO | undefined>;
  bindEvidence(input: BindEvidenceRequestDTO, principal: EvidencePrincipal): Promise<EvidenceRecordDTO | undefined>;
}

export interface TxReconcileWorkerOptions {
  readonly config: ReconcileWorkerConfig;
  readonly receiptClient: ReconcileReceiptClient;
  readonly projectionStore: ProjectionStore;
  readonly productStore?: ProductBffStore;
  readonly submissionStore?: ProductSubmissionStore;
  readonly governanceStore?: GovernanceStore;
  readonly stageExecutorPatchStore?: ProductStageExecutorPatchStore;
  readonly stageResourcePatchStore?: ProductStageResourcePatchStore;
  readonly evidenceBinder?: EvidenceBindingSweeper;
  readonly audit?: AuditSink;
  readonly logger?: Logger;
  readonly now?: () => Date;
}

type ReconcileableTxRecord = {
  readonly txHash?: Hex;
  readonly createdAt: string;
  readonly preparedAt?: string;
  readonly status: string;
};

export class TxReconcileWorker implements LifecycleService {
  readonly name = "tx-indexer-reconcile";

  readonly #config: ReconcileWorkerConfig;
  readonly #receiptClient: ReconcileReceiptClient;
  readonly #projectionStore: ProjectionStore;
  readonly #productStore: ProductBffStore | undefined;
  readonly #submissionStore: ProductSubmissionStore | undefined;
  readonly #governanceStore: GovernanceStore | undefined;
  readonly #stageExecutorPatchStore: ProductStageExecutorPatchStore | undefined;
  readonly #stageResourcePatchStore: ProductStageResourcePatchStore | undefined;
  readonly #evidenceBinder: EvidenceBindingSweeper | undefined;
  readonly #audit: AuditSink | undefined;
  readonly #logger: Logger;
  readonly #now: () => Date;
  #timer: NodeJS.Timeout | undefined;
  #running = false;
  #checking = false;
  #lastRunAt: string | undefined;
  #lastSummary: ReconcileRunSummary | undefined;
  #lastError: string | undefined;
  readonly #orphanRevokedAlerted = new Set<string>();
  readonly #failedRecheckExhaustedAlerted = new Set<string>();

  constructor(options: TxReconcileWorkerOptions) {
    this.#config = options.config;
    this.#receiptClient = options.receiptClient;
    this.#projectionStore = options.projectionStore;
    this.#productStore = options.productStore;
    this.#submissionStore = options.submissionStore;
    this.#governanceStore = options.governanceStore;
    this.#stageExecutorPatchStore = options.stageExecutorPatchStore;
    this.#stageResourcePatchStore = options.stageResourcePatchStore;
    this.#evidenceBinder = options.evidenceBinder;
    this.#audit = options.audit;
    this.#logger = options.logger ?? noopLogger;
    this.#now = options.now ?? (() => new Date());
  }

  get running(): boolean {
    return this.#running;
  }

  getDiagnostics(): ReconcileWorkerDiagnostics {
    return {
      enabled: this.#config.enabled,
      running: this.#running,
      checking: this.#checking,
      pollIntervalMs: this.#config.pollIntervalMs,
      txTimeoutMs: this.#config.txTimeoutMs,
      ...(this.#lastRunAt ? { lastRunAt: this.#lastRunAt } : {}),
      ...(this.#lastSummary ? { lastSummary: this.#lastSummary } : {}),
      ...(this.#lastError ? { lastError: this.#lastError } : {})
    };
  }

  async start(): Promise<void> {
    if (!this.#config.enabled) {
      this.#logger.info("reconcile worker disabled");
      return;
    }
    if (this.#running) {
      return;
    }

    this.#running = true;
    this.#logger.info("reconcile worker started", {
      pollIntervalMs: this.#config.pollIntervalMs,
      txTimeoutMs: this.#config.txTimeoutMs
    });

    void this.#runOnceSafely();
    if (this.#config.pollIntervalMs > 0) {
      this.#timer = setInterval(() => {
        void this.#runOnceSafely();
      }, this.#config.pollIntervalMs);
    }
  }

  async stop(): Promise<void> {
    this.#running = false;
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    this.#logger.info("reconcile worker stopped");
  }

  async runOnce(): Promise<ReconcileRunSummary> {
    if (this.#checking) {
      return {
        registrationsChecked: 0,
        submissionsChecked: 0,
        governanceLogsChecked: 0,
        stagePatchesChecked: 0,
        evidenceBindsSwept: 0,
        evidenceBindsRepaired: 0,
        updated: 0,
        failed: 0
      };
    }
    this.#checking = true;
    try {
      return await this.#runReconcilePass();
    } finally {
      this.#checking = false;
    }
  }

  async #runReconcilePass(): Promise<ReconcileRunSummary> {
    const summary = {
      registrationsChecked: 0,
      submissionsChecked: 0,
      governanceLogsChecked: 0,
      stagePatchesChecked: 0,
      evidenceBindsSwept: 0,
      evidenceBindsRepaired: 0,
      updated: 0,
      failed: 0
    };

    await this.#sweepEvidenceBinds(summary);

    if (this.#productStore) {
      for (const registration of (await this.#productStore.listRegistrations()).filter(isReconcileableRegistration)) {
        if (registration.status === "failed" && !this.#failedTxRecheckDue(`registration:${registration.triggerId}`, registration)) {
          continue;
        }
        summary.registrationsChecked += 1;
        try {
          const updated = await this.#reconcileRegistration(registration);
          if (updated) {
            summary.updated += 1;
            if (updated.status === "failed") {
              summary.failed += 1;
            }
          }
        } catch (error) {
          summary.failed += 1;
          this.#logger.warn("reconcile worker skipped a broken registration record", {
            triggerId: registration.triggerId,
            orderId: registration.orderId,
            message: redactErrorMessage(error)
          });
        }
      }
    }

    if (this.#submissionStore) {
      for await (const submission of iterateOpenSubmissions(
        this.#submissionStore,
        this.#config.scanPageSize ?? DEFAULT_RECONCILE_SCAN_PAGE_SIZE
      )) {
        if (!isReconcileableSubmission(submission)) {
          continue;
        }
        if (submission.status === "failed" && !this.#failedTxRecheckDue(`submission:${submission.submissionId}`, submission)) {
          continue;
        }
        summary.submissionsChecked += 1;
        try {
          const updated = await this.#reconcileSubmission(submission);
          if (updated) {
            summary.updated += 1;
            if (updated.status === "failed") {
              summary.failed += 1;
            }
          }
        } catch (error) {
          summary.failed += 1;
          this.#logger.warn("reconcile worker skipped a broken submission record", {
            submissionId: submission.submissionId,
            orderId: submission.orderId,
            message: redactErrorMessage(error)
          });
        }
      }
    }

    if (this.#governanceStore) {
      let skippedSimulatedCount = 0;
      for await (const log of iterateOpenGovernanceLogs(
        this.#governanceStore,
        this.#config.scanPageSize ?? DEFAULT_RECONCILE_SCAN_PAGE_SIZE
      )) {
        if (!isReconcileableGovernanceLog(log)) {
          continue;
        }
        if (isSimulatedGovernanceLog(log)) {
          skippedSimulatedCount += 1;
          continue;
        }
        if (log.status === "failed" && !this.#failedTxRecheckDue(`governance-log:${log.logId}`, log)) {
          continue;
        }
        summary.governanceLogsChecked += 1;
        try {
          const updated = await this.#reconcileGovernanceLog(log);
          if (updated) {
            summary.updated += 1;
            if (updated.status === "failed") {
              summary.failed += 1;
            }
          }
        } catch (error) {
          summary.failed += 1;
          this.#logger.warn("reconcile worker skipped a broken governance ledger record", {
            logId: log.logId,
            message: redactErrorMessage(error)
          });
        }
      }
      if (skippedSimulatedCount > 0) {
        this.#logger.warn("reconcile worker skipped simulated governance ledger entries; they never hit chain and cannot be reconciled", {
          skippedSimulatedCount
        });
      }
      await this.#sweepOrphanRevokedReviews(summary);
    }

    await this.#reconcileStagePatches(summary);

    this.#lastRunAt = this.#now().toISOString();
    this.#lastSummary = summary;
    this.#lastError = undefined;
    return summary;
  }

  async #sweepEvidenceBinds(summary: ReconcileRunSummaryDraft): Promise<void> {
    if (!this.#submissionStore || !this.#evidenceBinder) {
      return;
    }
    for await (const submission of iterateOpenSubmissions(
      this.#submissionStore,
      this.#config.scanPageSize ?? DEFAULT_RECONCILE_SCAN_PAGE_SIZE
    )) {
      if (!isEvidenceBindSweepable(submission)) {
        continue;
      }
      summary.evidenceBindsSwept += 1;
      try {
        summary.evidenceBindsRepaired += await this.#repairSubmissionEvidenceBinds(submission);
      } catch (error) {
        summary.failed += 1;
        this.#logger.warn("reconcile worker failed to rebind submission evidence", {
          submissionId: submission.submissionId,
          orderId: submission.orderId,
          message: redactErrorMessage(error)
        });
      }
    }
  }

  async #repairSubmissionEvidenceBinds(submission: ProductSubmissionDTO): Promise<number> {
    if (!this.#evidenceBinder || !submission.txHash) {
      return 0;
    }
    const evidenceIds = submission.evidenceIds ?? [];
    const binderPrincipal: EvidencePrincipal = {
      id: submission.submitter.toLowerCase(),
      role: "participant"
    };
    const repaired: string[] = [];
    for (const evidenceId of evidenceIds) {
      const proof = await this.#evidenceBinder.getProof(evidenceId, binderPrincipal);
      if (proof?.verificationStatus !== "unbound") {
        continue;
      }
      await this.#evidenceBinder.bindEvidence({
        evidenceId,
        submissionId: submission.submissionId,
        txHash: submission.txHash,
        orderId: submission.orderId,
        onchainOrderId: submission.onchainOrderId,
        sourceId: submission.sourceId,
        signalId: submission.signalId,
        boundAt: this.#now().toISOString()
      }, binderPrincipal);
      repaired.push(evidenceId);
    }
    if (repaired.length > 0) {
      await this.#audit?.record({
        type: "reconcile.evidence_bind.succeeded",
        action: submission.signalName,
        outcome: "succeeded",
        subject: {
          submissionId: submission.submissionId,
          prepareId: submission.prepareId,
          taskId: submission.taskId,
          orderId: submission.orderId,
          onchainOrderId: submission.onchainOrderId,
          stageIdentifier: submission.stageIdentifier,
          signalName: submission.signalName,
          submitter: submission.submitter
        },
        ...(submission.txHash ? { txHash: submission.txHash } : {}),
        metadata: {
          repairedEvidenceIds: repaired
        }
      });
    }
    return repaired.length;
  }

  async #sweepOrphanRevokedReviews(summary: ReconcileRunSummaryDraft): Promise<void> {
    if (!this.#governanceStore || !this.#projectionStore) {
      return;
    }
    const revokedReviews = await this.#governanceStore.listReviews({
      subjectType: "supplier",
      status: "revoked"
    });
    if (revokedReviews.length === 0) {
      return;
    }
    const loggedSubjectIds = new Set(
      (await this.#governanceStore.listIdentityTxLogs()).map((log) => log.subjectId.toLowerCase())
    );
    for (const review of revokedReviews) {
      const subjectKey = review.subjectId.toLowerCase();
      if (loggedSubjectIds.has(subjectKey)) {
        continue;
      }
      const activeBindings = await this.#projectionStore.listIdentityBindings({
        subjectId: review.subjectId,
        activeOnly: true
      });
      if (activeBindings.length === 0) {
        continue;
      }
      if (this.#orphanRevokedAlerted.has(review.reviewId)) {
        continue;
      }
      this.#orphanRevokedAlerted.add(review.reviewId);
      summary.failed += 1;
      await this.#audit?.record({
        type: "reconcile.governance_revoke_orphan",
        action: "revoke_identity",
        outcome: "failed",
        actor: "tx-indexer-reconcile",
        subject: {
          reviewId: review.reviewId,
          subjectId: review.subjectId
        },
        retryable: true,
        metadata: {
          fork: "review is marked revoked with no governance tx log while the on-chain binding is still active; re-issue revoke-identity to rebuild the ledger entry"
        }
      });
    }
  }

  async #reconcileStagePatches(summary: ReconcileRunSummaryDraft): Promise<void> {
    if (this.#stageExecutorPatchStore?.listOpenSubmissionsPage) {
      await this.#reconcileStagePatchLane<
        PreparedStageExecutorPatchRecord,
        StageExecutorPatchSubmissionDTO
      >(this.#stageExecutorPatchStore, summary, (submission) =>
        confirmExecutorPatchProjection(this.#projectionStore, submission));
    }
    if (this.#stageResourcePatchStore?.listOpenSubmissionsPage) {
      await this.#reconcileStagePatchLane<
        PreparedStageResourcePatchRecord,
        StageResourcePatchSubmissionDTO
      >(this.#stageResourcePatchStore, summary, (submission) =>
        confirmResourcePatchProjection(this.#projectionStore, submission));
    }
  }

  async #reconcileStagePatchLane<
    TPrepared,
    TSubmission extends StageExecutorPatchSubmissionDTO | StageResourcePatchSubmissionDTO
  >(
    store: {
      putSubmission(submission: TSubmission): Promise<void>;
      listOpenSubmissionsPage?: (
        after: StagePatchSubmissionScanCursor | undefined,
        limit: number
      ) => Promise<readonly TSubmission[]>;
    },
    summary: ReconcileRunSummaryDraft,
    confirm: (submission: TSubmission) => Promise<ProjectionConfirmation | undefined>
  ): Promise<void> {
    const listOpen = store.listOpenSubmissionsPage?.bind(store);
    if (!listOpen) {
      return;
    }
    for await (const submission of iterateOpenStagePatches(
      { listOpenSubmissionsPage: listOpen },
      this.#config.scanPageSize ?? DEFAULT_RECONCILE_SCAN_PAGE_SIZE
    )) {
      if (submission.status === "failed" && !this.#failedTxRecheckDue(`stage-patch:${submission.submissionId}`, submission)) {
        continue;
      }
      summary.stagePatchesChecked += 1;
      try {
        const outcome = await this.#resolveOutcome(
          submission,
          () => confirm(submission),
          `stage-patch:${submission.submissionId}`
        );
        if (!outcome) {
          continue;
        }
        const updated = stagePatchSubmissionFromOutcome(submission, outcome);
        await store.putSubmission(updated);
        summary.updated += 1;
        if (updated.status === "failed") {
          summary.failed += 1;
        }
      } catch (error) {
        summary.failed += 1;
        this.#logger.warn("reconcile worker skipped a broken stage patch submission record", {
          submissionId: submission.submissionId,
          orderId: submission.orderId,
          message: redactErrorMessage(error)
        });
      }
    }
  }

  async #runOnceSafely(): Promise<void> {
    try {
      const summary = await this.runOnce();
      this.#logger.info("reconcile worker run completed", { ...summary });
    } catch (error) {
      this.#lastRunAt = this.#now().toISOString();
      this.#lastError = redactErrorMessage(error);
      this.#logger.warn("reconcile worker run failed", {
        message: this.#lastError
      });
    }
  }

  async #reconcileRegistration(
    registration: ProductOrderTriggerRecord
  ): Promise<ProductOrderTriggerRecord | undefined> {
    const outcome = await this.#resolveOutcome(
      registration,
      () => registrationProjectionConfirmation(
        this.#projectionStore,
        registration
      ),
      `registration:${registration.triggerId}`
    );
    if (!outcome) {
      return undefined;
    }

    const updated: ProductOrderTriggerRecord = {
      ...registration,
      status: outcome.registrationStatus,
      ...outcome.fields,
      ...(outcome.txHash ? { txHash: outcome.txHash } : {}),
      ...(outcome.blockNumber ? { blockNumber: outcome.blockNumber } : {}),
      ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
      ...(outcome.errorMessage ? { errorMessage: outcome.errorMessage } : {}),
      retryable: outcome.retryable,
      updatedAt: outcome.checkedAt
    };
    await this.#productStore?.updateRegistration(updated);

    const draft = await this.#productStore?.getDraft(registration.draftId);
    if (draft) {
      await this.#productStore?.updateDraft(draftFromReconciledRegistration(draft, updated, outcome.checkedAt));
    }

    return updated;
  }

  async #reconcileSubmission(submission: ProductSubmissionDTO): Promise<ProductSubmissionDTO | undefined> {
    const outcome = await this.#resolveOutcome(
      submission,
      () => submissionProjectionConfirmation(
        this.#projectionStore,
        submission
      ),
      `submission:${submission.submissionId}`
    );
    if (!outcome) {
      return undefined;
    }

    const submissionStatus = submissionStatusFromOutcome(outcome, submission);
    const deadLetter = submissionDeadLetterFromOutcome(outcome, submissionStatus);
    const updated: ProductSubmissionDTO = {
      ...submission,
      status: submissionStatus,
      broadcastStatus: submissionStatus === "confirmed"
        ? "confirmed"
        : submissionStatus === "failed"
          ? "failed"
          : submission.broadcastStatus,
      ...outcome.fields,
      ...(outcome.txHash ? { txHash: outcome.txHash } : {}),
      ...(outcome.blockNumber ? { blockNumber: outcome.blockNumber } : {}),
      ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
      ...(outcome.errorMessage ? { errorMessage: outcome.errorMessage } : {}),
      retryable: outcome.retryable,
      retryState: submissionRetryStateFromOutcome(outcome, submissionStatus, deadLetter),
      deadLetter,
      attempts: updateSubmissionAttempts(submission, outcome),
      updatedAt: outcome.checkedAt
    };
    await this.#submissionStore?.putSubmission(updated);
    return updated;
  }

  async #reconcileGovernanceLog(log: GovernanceTxLogDTO): Promise<GovernanceTxLogDTO | undefined> {
    const outcome = await this.#resolveOutcome(
      log,
      () => governanceProjectionConfirmation(
        this.#projectionStore,
        log
      ),
      `governance-log:${log.logId}`
    );
    if (!outcome) {
      return undefined;
    }

    const status = governanceStatusFromOutcome(outcome);
    const updated: GovernanceTxLogDTO = {
      ...log,
      status,
      broadcastStatus: governanceBroadcastStatusFromOutcome(log.broadcastStatus, outcome),
      ...outcome.fields,
      ...(outcome.txHash ? { txHash: outcome.txHash } : {}),
      ...(outcome.blockNumber ? { blockNumber: outcome.blockNumber } : {}),
      ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
      ...(outcome.errorMessage ? { errorMessage: outcome.errorMessage } : {}),
      retryable: outcome.retryable,
      updatedAt: outcome.checkedAt
    };
    await this.#governanceStore?.updateTxLog(updated);
    if (
      log.action === "revoke_identity" &&
      outcome.kind === "failed" &&
      log.status !== "failed"
    ) {
      await this.#audit?.record({
        type: "reconcile.governance_revoke_reverted",
        action: "revoke_identity",
        outcome: "failed",
        actor: "tx-indexer-reconcile",
        subject: {
          logId: log.logId,
          subjectId: log.subjectId,
          ...(log.bindingId ? { bindingId: log.bindingId } : {}),
          ...(log.txHash ? { txHash: log.txHash } : {})
        },
        ...(log.txHash ? { txHash: log.txHash } : {}),
        ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
        retryable: outcome.retryable,
        metadata: {
          beforeStatus: log.status,
          afterStatus: status,
          fork: "review is marked revoked while the on-chain binding is still active; re-issue revoke-identity to re-broadcast"
        }
      });
    }
    return updated;
  }

  #failedTxRecheckDue(
    key: string,
    record: {
      readonly createdAt: string;
      readonly preparedAt?: string;
      readonly updatedAt?: string;
    }
  ): boolean {
    const nowMs = this.#now().getTime();
    const anchorMs = Date.parse(record.preparedAt ?? record.createdAt);
    if (Number.isNaN(anchorMs)) {
      return true;
    }
    const ageMs = nowMs - anchorMs;
    if (ageMs > FAILED_TX_RECHECK_HORIZON_MS) {
      if (!this.#failedRecheckExhaustedAlerted.has(key)) {
        this.#failedRecheckExhaustedAlerted.add(key);
        this.#logger.warn(
          "reconcile worker exhausted the bounded re-check horizon for a failed record with a transaction hash; it stays failed and requires manual adjudication",
          { record: key }
        );
      }
      return false;
    }
    if (record.updatedAt === undefined) {
      return true;
    }
    const sinceCheckMs = nowMs - Date.parse(record.updatedAt);
    if (Number.isNaN(sinceCheckMs) || sinceCheckMs <= 0) {
      return true;
    }
    const intervalMs = Math.min(
      Math.max(Math.floor(ageMs / 16), FAILED_TX_RECHECK_BASE_INTERVAL_MS),
      FAILED_TX_RECHECK_MAX_INTERVAL_MS
    );
    return sinceCheckMs >= intervalMs;
  }

  async #resolveOutcome(
    record: ReconcileableTxRecord,
    projectionConfirmation: () => Promise<ProjectionConfirmation | undefined>,
    recordLabel: string
  ): Promise<ResolvedReconcileOutcome | undefined> {
    const checkedAt = this.#now().toISOString();
    if (!record.txHash) {
      if (!timedOut(record, this.#config.txTimeoutMs, this.#now())) {
        return {
          kind: "pending",
          registrationStatus: record.status as ProductOrderTriggerStatus,
          checkedAt,
          fields: {
            reconcileStatus: "broadcasting",
            lastCheckedAt: checkedAt,
            receiptStatus: "not_checked",
            projectionStatus: "not_checked"
          },
          retryable: true
        };
      }
      const projectedWithoutHash = await projectionConfirmation();
      if (projectedWithoutHash) {
        return this.#confirmedFromProjection(checkedAt, projectedWithoutHash);
      }
      return staleOutcome(checkedAt);
    }

    const projectedBeforeReceipt = await projectionConfirmation();
    if (projectedBeforeReceipt) {
      this.#logProjectionHashMismatch(record, projectedBeforeReceipt, recordLabel);
      return this.#confirmedFromProjection(checkedAt, projectedBeforeReceipt);
    }

    const receipt = await this.#receiptClient.getTransactionReceipt(record.txHash);
    if (!receipt) {
      if (timedOut(record, this.#config.txTimeoutMs, this.#now())) {
        return staleOutcome(checkedAt);
      }
      return {
        kind: "pending",
        registrationStatus: record.status as ProductOrderTriggerStatus,
        checkedAt,
        fields: {
          reconcileStatus: "submitted",
          lastCheckedAt: checkedAt,
          receiptStatus: "missing",
          projectionStatus: "not_checked"
        },
        retryable: true
      };
    }

    const blockNumber = normalizeBlockNumber(receipt.blockNumber);
    if (receipt.status === "reverted" || receipt.status === "failed") {
      return {
        kind: "failed",
        registrationStatus: "failed",
        checkedAt,
        fields: {
          reconcileStatus: "failed",
          lastCheckedAt: checkedAt,
          receiptStatus: "failed",
          projectionStatus: "not_checked"
        },
        ...(blockNumber ? { blockNumber } : {}),
        errorCode: "transaction_reverted",
        errorMessage: `transaction receipt status ${receipt.status ?? "failed"}`,
        retryable: false
      };
    }
    if (receipt.status !== "success") {
      return {
        kind: "pending",
        registrationStatus: record.status as ProductOrderTriggerStatus,
        checkedAt,
        fields: {
          reconcileStatus: "submitted",
          lastCheckedAt: checkedAt,
          receiptStatus: "unknown",
          projectionStatus: "not_checked"
        },
        ...(blockNumber ? { blockNumber } : {}),
        retryable: true
      };
    }

    const projected = await projectionConfirmation();
    if (!projected) {
      return {
        kind: "indexing",
        registrationStatus: "indexing",
        checkedAt,
        fields: {
          reconcileStatus: "indexing",
          lastCheckedAt: checkedAt,
          receiptStatus: "success",
          projectionStatus: "missing"
        },
        ...(blockNumber ? { blockNumber } : {}),
        retryable: false
      };
    }

    this.#logProjectionHashMismatch(record, projected, recordLabel);
    return this.#confirmedFromProjection(checkedAt, projected, blockNumber);
  }

  #confirmedFromProjection(
    checkedAt: string,
    projection: ProjectionConfirmation,
    fallbackBlockNumber?: string
  ): ResolvedReconcileOutcome {
    return {
      ...confirmedOutcome(checkedAt, projection.blockNumber ?? fallbackBlockNumber),
      ...(projection.hashMismatch ? { txHash: projection.transactionHash } : {})
    };
  }

  #logProjectionHashMismatch(
    record: ReconcileableTxRecord,
    projection: ProjectionConfirmation,
    recordLabel: string
  ): void {
    if (!projection.hashMismatch) {
      return;
    }
    this.#logger.warn(
      "reconcile confirmed a business-identity projection match whose transaction hash differs from the ledger record; state recalculated from chain and the ledger hash follows the chain",
      {
        record: recordLabel,
        ledgerTxHash: record.txHash,
        chainTxHash: projection.transactionHash,
        blockNumber: projection.blockNumber
      }
    );
  }
}

function confirmedOutcome(checkedAt: string, blockNumber?: string): ResolvedReconcileOutcome {
  return {
    kind: "confirmed",
    registrationStatus: "confirmed",
    checkedAt,
    fields: {
      reconcileStatus: "confirmed",
      lastCheckedAt: checkedAt,
      receiptStatus: "success",
      projectionStatus: "present"
    },
    ...(blockNumber ? { blockNumber } : {}),
    retryable: false
  };
}

interface ProjectionConfirmation {
  readonly transactionHash: Hex;
  readonly blockNumber: string;
  readonly hashMismatch?: boolean;
}

interface ProjectionProvenanceLike {
  readonly transactionHash: Hex;
  readonly blockNumber: bigint;
}

function projectionConfirmationFromProvenance(
  provenance: ProjectionProvenanceLike | undefined,
  expectedTxHash: Hex | undefined
): ProjectionConfirmation | undefined {
  if (!provenance) {
    return undefined;
  }
  const confirmation: ProjectionConfirmation = {
    transactionHash: provenance.transactionHash,
    blockNumber: provenance.blockNumber.toString()
  };
  if (
    expectedTxHash &&
    provenance.transactionHash.toLowerCase() !== expectedTxHash.toLowerCase()
  ) {
    return { ...confirmation, hashMismatch: true };
  }
  return confirmation;
}

export function createViemReconcileReceiptClient(
  options: ViemReconcileReceiptClientOptions
): ReconcileReceiptClient {
  const chain = defineChain({
    id: options.chainId,
    name: `uvp-${options.chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [options.rpcUrl] } }
  });
  const client = createPublicClient({
    chain,
    transport: http(options.rpcUrl)
  });

  return {
    async getTransactionReceipt(txHash) {
      try {
        return await client.getTransactionReceipt({ hash: txHash });
      } catch (error) {
        if (isReceiptMissingError(error)) {
          return undefined;
        }
        throw error;
      }
    }
  };
}

interface ResolvedReconcileOutcome {
  readonly kind: "pending" | "indexing" | "confirmed" | "failed" | "stale_pending";
  readonly registrationStatus: ProductOrderTriggerStatus;
  readonly checkedAt: string;
  readonly fields: Required<Pick<TxReconcileFields, "reconcileStatus" | "lastCheckedAt" | "receiptStatus" | "projectionStatus">>;
  readonly blockNumber?: string;
  readonly txHash?: Hex;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly retryable: boolean;
}

type ReconcileRunSummaryDraft = {
  -readonly [K in keyof ReconcileRunSummary]: ReconcileRunSummary[K];
};

function staleOutcome(checkedAt: string): ResolvedReconcileOutcome {
  return {
    kind: "stale_pending",
    registrationStatus: "failed",
    checkedAt,
    fields: {
      reconcileStatus: "stale_pending",
      lastCheckedAt: checkedAt,
      receiptStatus: "timeout",
      projectionStatus: "not_checked"
    },
    errorCode: "tx_reconcile_timeout",
    errorMessage: "transaction did not produce a receipt before the reconcile timeout",
    retryable: true
  };
}

function isReconcileableRegistration(registration: ProductOrderTriggerRecord): boolean {
  if (registration.status === "failed") {
    return !isReopenableFailedTriggerRecord(registration)
      && Boolean(registration.txHash);
  }
  return registration.status === "submitted" || registration.status === "indexing";
}

function isReconcileableSubmission(submission: ProductSubmissionDTO): boolean {
  if (submission.status === "failed") {
    return Boolean(submission.txHash);
  }
  return submission.status === "broadcasting" || submission.status === "submitted" || submission.status === "indexing";
}

function isEvidenceBindSweepable(submission: ProductSubmissionDTO): boolean {
  if (!submission.txHash || !submission.evidenceIds?.length) {
    return false;
  }
  return submission.status === "broadcasting"
    || submission.status === "submitted"
    || submission.status === "indexing";
}

function isReconcileableGovernanceLog(log: GovernanceTxLogDTO): boolean {
  if (log.status === "failed") {
    return Boolean(log.txHash);
  }
  return log.status === "pending" || log.status === "broadcasting" || log.status === "indexing";
}

function isSimulatedGovernanceLog(log: GovernanceTxLogDTO): boolean {
  return log.executionMode === "simulated" || log.broadcastStatus === "simulated_tx";
}

async function* iterateOpenStagePatches<TSubmission extends {
  readonly submissionId: string;
  readonly createdAt: string;
  readonly status: string;
  readonly txHash?: Hex;
}>(
  store: { listOpenSubmissionsPage(after: StagePatchSubmissionScanCursor | undefined, limit: number): Promise<readonly TSubmission[]> },
  pageSize: number
): AsyncGenerator<TSubmission, void, unknown> {
  let after: StagePatchSubmissionScanCursor | undefined;
  while (true) {
    const page = await store.listOpenSubmissionsPage(after, pageSize);
    if (page.length === 0) {
      return;
    }
    for (const submission of page) {
      yield submission;
    }
    const last = page[page.length - 1]!;
    after = { createdAt: last.createdAt, submissionId: last.submissionId };
    if (page.length < pageSize) {
      return;
    }
  }
}

async function confirmExecutorPatchProjection(
  projectionStore: ProjectionStore,
  submission: StageExecutorPatchSubmissionDTO
): Promise<ProjectionConfirmation | undefined> {
  const order = await findStagePatchOrder(projectionStore, submission);
  const overlay = order?.stageExecutorOverlays[submission.targetStageId.toLowerCase()];
  if (!overlay || overlay.patchHash.toLowerCase() !== submission.patchHash.toLowerCase()) {
    return undefined;
  }
  return {
    transactionHash: overlay.updatedAt.transactionHash,
    blockNumber: overlay.updatedAt.blockNumber.toString()
  };
}

async function confirmResourcePatchProjection(
  projectionStore: ProjectionStore,
  submission: StageResourcePatchSubmissionDTO
): Promise<ProjectionConfirmation | undefined> {
  const order = await findStagePatchOrder(projectionStore, submission);
  const overlay = order?.stageResourceOverlays[`${submission.targetStageId.toLowerCase()}:${submission.resourceKey.toLowerCase()}`];
  if (!overlay || overlay.patchHash.toLowerCase() !== submission.patchHash.toLowerCase()) {
    return undefined;
  }
  return {
    transactionHash: overlay.updatedAt.transactionHash,
    blockNumber: overlay.updatedAt.blockNumber.toString()
  };
}

async function findStagePatchOrder(
  projectionStore: ProjectionStore,
  submission: { readonly onchainOrderId: Hex; readonly planId: Hex; readonly stateMachineAddress: Address }
): Promise<StateMachineOrderProjection | undefined> {
  const order = await projectionStore.getStateMachineOrder(submission.onchainOrderId, submission.planId);
  if (!order) {
    return undefined;
  }
  if (order.contractAddress.toLowerCase() !== submission.stateMachineAddress.toLowerCase()) {
    return undefined;
  }
  return order;
}

function stagePatchSubmissionFromOutcome<TSubmission extends StageExecutorPatchSubmissionDTO | StageResourcePatchSubmissionDTO>(
  submission: TSubmission,
  outcome: ResolvedReconcileOutcome
): TSubmission {
  let status: TSubmission["status"];
  let broadcastStatus: TSubmission["broadcastStatus"];
  switch (outcome.kind) {
    case "confirmed":
      status = "confirmed";
      broadcastStatus = "confirmed";
      break;
    case "failed":
    case "stale_pending":
      status = "failed";
      broadcastStatus = "failed";
      break;
    case "indexing":
      status = "submitted";
      broadcastStatus = "submitted";
      break;
    case "pending":
      status = submission.txHash ? "submitted" : "broadcasting";
      broadcastStatus = submission.txHash ? "submitted" : "broadcasting";
      break;
  }
  return {
    ...submission,
    status,
    broadcastStatus,
    ...(outcome.txHash ? { txHash: outcome.txHash } : {}),
    ...(outcome.blockNumber ? { blockNumber: outcome.blockNumber } : {}),
    ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
    ...(outcome.errorMessage ? { errorMessage: outcome.errorMessage } : {}),
    retryable: outcome.retryable,
    updatedAt: outcome.checkedAt
  };
}

async function* iterateOpenSubmissions(
  store: ProductSubmissionStore,
  pageSize: number
): AsyncGenerator<ProductSubmissionDTO, void, unknown> {
  if (!store.listOpenSubmissionsPage) {
    for (const submission of await store.listSubmissions()) {
      yield submission;
    }
    return;
  }
  let after: ProductSubmissionScanCursor | undefined;
  while (true) {
    const page = await store.listOpenSubmissionsPage(after, pageSize);
    if (page.length === 0) {
      return;
    }
    for (const submission of page) {
      yield submission;
    }
    const last = page[page.length - 1]!;
    after = { createdAt: last.createdAt, submissionId: last.submissionId };
    if (page.length < pageSize) {
      return;
    }
  }
}

async function* iterateOpenGovernanceLogs(
  store: GovernanceStore,
  pageSize: number
): AsyncGenerator<IdentityTxLogDTO, void, unknown> {
  if (!store.listOpenIdentityTxLogsPage) {
    for (const log of await store.listIdentityTxLogs()) {
      yield log;
    }
    return;
  }
  let after: GovernanceTxLogScanCursor | undefined;
  while (true) {
    const page = await store.listOpenIdentityTxLogsPage(after, pageSize);
    if (page.length === 0) {
      return;
    }
    for (const log of page) {
      yield log;
    }
    const last = page[page.length - 1]!;
    after = { createdAt: last.createdAt, logId: last.logId };
    if (page.length < pageSize) {
      return;
    }
  }
}

async function registrationProjectionConfirmation(
  projectionStore: ProjectionStore,
  registration: ProductOrderTriggerRecord
): Promise<ProjectionConfirmation | undefined> {
  const order = await projectionStore.getStateMachineOrder(
    registration.orderId,
    registration.planId
  );
  if (!order?.registeredAt) {
    return undefined;
  }
  if (
    registration.stateMachineAddress &&
    order.contractAddress.toLowerCase() !== registration.stateMachineAddress.toLowerCase()
  ) {
    return undefined;
  }
  return projectionConfirmationFromProvenance(order.registeredAt, registration.txHash);
}

export async function submissionProjectionConfirmation(
  projectionStore: ProjectionStore,
  submission: {
    readonly onchainOrderId: Hex;
    readonly planId: Hex;
    readonly sourceId: Hex;
    readonly signalId: Hex;
    readonly submitter: Address;
    readonly payloadHash: Hex;
    readonly idempotencyKey: Hex;
    readonly txHash?: Hex;
  }
): Promise<ProjectionConfirmation | undefined> {
  const order = await projectionStore.getStateMachineOrder(submission.onchainOrderId, submission.planId);
  if (!order) {
    return undefined;
  }
  const signal = order?.signals[`${submission.sourceId}:${submission.signalId}`];
  const matches = Boolean(
    signal &&
    signal.orderId === submission.onchainOrderId &&
    signal.sourceId === submission.sourceId &&
    signal.signalId === submission.signalId &&
    signal.submitter === submission.submitter &&
    signal.payloadHash === submission.payloadHash &&
    signal.idempotencyKey === submission.idempotencyKey
  );
  return matches ? projectionConfirmationFromProvenance(signal?.submittedAt, submission.txHash) : undefined;
}

async function governanceProjectionConfirmation(
  projectionStore: ProjectionStore,
  log: GovernanceTxLogDTO
): Promise<ProjectionConfirmation | undefined> {
  const identities = await projectionStore.listIdentityBindings({
    ...(log.bindingId ? { bindingId: log.bindingId } : {}),
    subjectId: log.subjectId
  });
  if (log.action === "register_identity") {
    const identity = identities.find((item) =>
      item.subjectId === log.subjectId &&
      (!log.account || item.account.toLowerCase() === log.account.toLowerCase()) &&
      (!log.txHash || item.registeredAt.transactionHash.toLowerCase() === log.txHash.toLowerCase())
    );
    return projectionConfirmationFromProvenance(identity?.registeredAt, log.txHash);
  }
  const identity = identities.find((item) =>
    item.bindingId === log.bindingId &&
    item.status === "revoked" &&
    (!log.txHash || item.revokedAt?.transactionHash.toLowerCase() === log.txHash.toLowerCase())
  );
  return projectionConfirmationFromProvenance(identity?.revokedAt, log.txHash);
}

function draftFromReconciledRegistration(
  draft: ProductOrderDraftDTO,
  registration: ProductOrderTriggerRecord,
  updatedAt: string
): ProductOrderDraftDTO {
  if (registration.status === "confirmed") {
    return {
      ...draft,
      status: "triggered",
      triggeredOrderId: registration.orderId,
      ...(registration.txHash ? { triggerTxHash: registration.txHash } : {}),
      updatedAt
    };
  }
  if (registration.status === "failed") {
    return {
      ...draft,
      status: "failed",
      updatedAt
    };
  }
  return {
    ...draft,
    status: "triggering",
    updatedAt
  };
}

function submissionStatusFromOutcome(
  outcome: ResolvedReconcileOutcome,
  submission: ProductSubmissionDTO
): ProductSubmissionDTO["status"] {
  switch (outcome.kind) {
    case "confirmed":
      return "confirmed";
    case "failed":
    case "stale_pending":
      return "failed";
    case "indexing":
      return "indexing";
    case "pending":
      return submission.txHash ? "submitted" : submission.status;
  }
}

function governanceStatusFromOutcome(outcome: ResolvedReconcileOutcome): GovernanceTxLogStatus {
  switch (outcome.kind) {
    case "confirmed":
      return "confirmed";
    case "failed":
    case "stale_pending":
      return "failed";
    case "indexing":
      return "indexing";
    case "pending":
      return "pending";
  }
}

function governanceBroadcastStatusFromOutcome(
  current: GovernanceBroadcastStatus,
  outcome: ResolvedReconcileOutcome
): GovernanceBroadcastStatus {
  switch (outcome.kind) {
    case "confirmed":
      return "confirmed";
    case "failed":
    case "stale_pending":
      return "failed";
    case "pending":
    case "indexing":
      return current === "broadcasting" ? "submitted" : current;
  }
}

function updateSubmissionAttempts(
  submission: ProductSubmissionDTO,
  outcome: ResolvedReconcileOutcome
): ProductSubmissionDTO["attempts"] {
  if (!submission.txHash) {
    return submission.attempts;
  }
  const attemptStatus = outcome.kind === "confirmed"
    ? "confirmed"
    : outcome.kind === "failed" || outcome.kind === "stale_pending"
      ? "failed"
      : "submitted";
  return submission.attempts.map((attempt) => {
    if (attempt.txHash !== submission.txHash) {
      return attempt;
    }
    const deadLetter = attemptStatus === "failed" && !outcome.retryable;
    return {
      ...attempt,
      status: attemptStatus,
      ...(outcome.blockNumber ? { blockNumber: outcome.blockNumber } : {}),
      ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
      ...(outcome.errorMessage ? { errorMessage: outcome.errorMessage } : {}),
      retryable: outcome.retryable,
      retryState: attemptRetryStateFromOutcome(attemptStatus, outcome.retryable, deadLetter),
      deadLetter,
      updatedAt: outcome.checkedAt
    };
  });
}

function submissionDeadLetterFromOutcome(
  outcome: ResolvedReconcileOutcome,
  status: ProductSubmissionDTO["status"]
): boolean {
  return status === "failed" && !outcome.retryable;
}

function submissionRetryStateFromOutcome(
  outcome: ResolvedReconcileOutcome,
  status: ProductSubmissionDTO["status"],
  deadLetter: boolean
): ProductSubmissionDTO["retryState"] {
  if (deadLetter) {
    return "dead_letter";
  }
  if (outcome.retryable) {
    return "retryable";
  }
  if (status === "failed" || status === "expired") {
    return "not_retryable";
  }
  return "not_applicable";
}

function attemptRetryStateFromOutcome(
  status: ProductSubmissionDTO["attempts"][number]["status"],
  retryable: boolean,
  deadLetter: boolean
): ProductSubmissionDTO["attempts"][number]["retryState"] {
  if (deadLetter) {
    return "dead_letter";
  }
  if (retryable) {
    return "retryable";
  }
  if (status === "failed") {
    return "not_retryable";
  }
  return "not_applicable";
}

function timedOut(record: ReconcileableTxRecord, timeoutMs: number, now: Date): boolean {
  if (timeoutMs <= 0) {
    return false;
  }
  const clockMs = Date.parse(record.preparedAt ?? record.createdAt);
  return Number.isFinite(clockMs) && now.getTime() - clockMs >= timeoutMs;
}

function normalizeBlockNumber(blockNumber: ReconcileReceipt["blockNumber"]): string | undefined {
  if (blockNumber === undefined) {
    return undefined;
  }
  return typeof blockNumber === "bigint" ? blockNumber.toString() : String(blockNumber);
}

function isReceiptMissingError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const name = "name" in error ? String(error.name) : "";
  if (/ReceiptNotFound|TransactionReceiptNotFound/i.test(name)) {
    return true;
  }
  return /\b(?:transaction|receipt)\s+(?:with\s+hash\s+\S+\s+)?(?:could\s+not\s+be\s+found|not\s+found)/i.test(error.message);
}
