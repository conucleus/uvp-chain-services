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
import type { Logger, Hex, LifecycleService } from "../shared/types.js";
import { noopLogger } from "../shared/types.js";
import type { ProjectionStore } from "../storage/projection-store.js";
import type { ProductSubmissionDTO, ProductSubmissionScanCursor, ProductSubmissionStore } from "../submissions/types.js";
import { redactErrorMessage } from "../security/redaction.js";
import type { ReconcileRunSummary, ReconcileWorkerDiagnostics, TxReconcileFields } from "./status.js";

export interface ReconcileWorkerConfig {
  readonly enabled: boolean;
  readonly pollIntervalMs: number;
  readonly txTimeoutMs: number;
  /**
   * 台账扫描页大小（可选能力）：submission/governance 车道按
   * (createdAt, id) 键序分页加载，避免每轮把全历史拉进内存。缺省用
   * DEFAULT_RECONCILE_SCAN_PAGE_SIZE。
   */
  readonly scanPageSize?: number;
}

/** 对账扫描缺省页大小：单轮内存占用有界，历史规模只影响轮时长。 */
export const DEFAULT_RECONCILE_SCAN_PAGE_SIZE = 200;

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

/**
 * 证据绑定清扫依赖的最小读场面：与 EvidenceService 结构子集对齐，
 * worker 不依赖完整证据服务面。
 */
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
  readonly evidenceBinder?: EvidenceBindingSweeper;
  readonly audit?: AuditSink;
  readonly logger?: Logger;
  readonly now?: () => Date;
}

type ReconcileableTxRecord = {
  readonly txHash?: Hex;
  readonly createdAt: string;
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

  constructor(options: TxReconcileWorkerOptions) {
    this.#config = options.config;
    this.#receiptClient = options.receiptClient;
    this.#projectionStore = options.projectionStore;
    this.#productStore = options.productStore;
    this.#submissionStore = options.submissionStore;
    this.#governanceStore = options.governanceStore;
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
    // 防重入守卫必须在 runOnce 本体：定时轮询（#runOnceSafely）、admin
    // 手动 runReconcile、retrySubmission 都会并发触达本方法，只在
    // #runOnceSafely 里挡 #checking 挡不住手动入口（对齐 dock-automation
    // 的守卫位置）。已在跑的一轮进行中时，后到触发直接返回空汇总。
    if (this.#checking) {
      return {
        registrationsChecked: 0,
        submissionsChecked: 0,
        governanceLogsChecked: 0,
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
      evidenceBindsSwept: 0,
      evidenceBindsRepaired: 0,
      updated: 0,
      failed: 0
    };

    // 每条记录独立 try/catch：单条坏记录（缺字段/投影查询异常）只计失败
    // 并继续，不把整轮（以及 /admin/ops/reconcile/run、retrySubmission）
    // 一起拖成 500。

    // 证据清扫先行：清扫对象是"在途未终"的提交，先跑可确保本轮即将被
    // reconcile 确认（终态剪除后不再进入清扫）的记录仍获得一次补绑机会。
    await this.#sweepEvidenceBinds(summary);

    if (this.#productStore) {
      for (const registration of (await this.#productStore.listRegistrations()).filter(isReconcileableRegistration)) {
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
      // 分页/终态剪除扫描：持久驱动按 (createdAt, submissionId) 键序 +
      // status 过滤只取未闭环行（见 listOpenSubmissionsPage）；能力缺失
      // （测试内存桩等）回退全量。行级 isReconcileableSubmission 仍兜底
      // 过滤（failed 还需 txHash 才可复核）。
      for await (const submission of iterateOpenSubmissions(
        this.#submissionStore,
        this.#config.scanPageSize ?? DEFAULT_RECONCILE_SCAN_PAGE_SIZE
      )) {
        if (!isReconcileableSubmission(submission)) {
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
      // 同 submission 车道：分页 + status 剪除，simulated 档（从未上链）
      // 逐条跳过并计数告警。
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
    }

    this.#lastRunAt = this.#now().toISOString();
    this.#lastSummary = summary;
    this.#lastError = undefined;
    return summary;
  }

  /**
   * 证据绑定清扫：链上提交已成功但证据绑定缺失的记录，用随提交落库的
   * 证据引用重试绑定（relayer.submit.evidence_bind_failed 的补账车道）。
   * 与回执复核相互独立：绑定缺失不是链上事实缺口，不写提交记录。
   * 终态 confirmed 不进清扫（对齐回执对账侧 isReconcileableSubmission 的
   * 终态剪除口径）：确认档随历史单调增长，纳入清扫会让每轮
   * O(全历史) 逐条 getProof。补绑车道因此以"本轮清扫先于 reconcile
   * 确认"收口——确认后仍缺失的绑定由 evidence_bind_failed 审计事件留痕
   * 供人工处置。
   */
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
    // 绑定主体与提交通路一致（业务签名者，prepare 时已过授权与签名核验），
    // 清扫不获得超出原绑定尝试的权限。
    const binderPrincipal: EvidencePrincipal = {
      id: submission.submitter.toLowerCase(),
      role: "participant"
    };
    const repaired: string[] = [];
    for (const evidenceId of evidenceIds) {
      const proof = await this.#evidenceBinder.getProof(evidenceId, binderPrincipal);
      // 只补可验证为未绑定的证据：读不到（无权/不存在）与哈希失配不是
      // 绑定缺口，清扫不得越权，也不得把其它故障类别混进补账。
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
      // 审计闭合：relayer.submit.evidence_bind_failed（failed）由本事件
      // （succeeded）收口。
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

  async #runOnceSafely(): Promise<void> {
    // 防重入由 runOnce 本体的 #checking 承担（定时/手动/重试入口共用）。
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
    const outcome = await this.#resolveOutcome(registration, () => registrationProjectionConfirmation(
      this.#projectionStore,
      registration
    ));
    if (!outcome) {
      return undefined;
    }

    const updated: ProductOrderTriggerRecord = {
      ...registration,
      status: outcome.registrationStatus,
      ...outcome.fields,
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
    const outcome = await this.#resolveOutcome(submission, () => submissionProjectionConfirmation(
      this.#projectionStore,
      submission
    ));
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
    const outcome = await this.#resolveOutcome(log, () => governanceProjectionConfirmation(
      this.#projectionStore,
      log
    ));
    if (!outcome) {
      return undefined;
    }

    const status = governanceStatusFromOutcome(outcome);
    const updated: GovernanceTxLogDTO = {
      ...log,
      status,
      broadcastStatus: governanceBroadcastStatusFromOutcome(log.broadcastStatus, outcome),
      ...outcome.fields,
      ...(outcome.blockNumber ? { blockNumber: outcome.blockNumber } : {}),
      ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
      ...(outcome.errorMessage ? { errorMessage: outcome.errorMessage } : {}),
      retryable: outcome.retryable,
      updatedAt: outcome.checkedAt
    };
    await this.#governanceStore?.updateTxLog(updated);
    // 撤销异步失败分叉的显式告警：revoke 广播 submitted/confirmed 后
    // reorg/revert，回执复核把 tx log 翻 failed，但 review 已在广播前翻成
    // revoked 且不可回退（revoked 是 review 状态机的终态，预撤销的哈希
    // 材料也无法从日志无损重建）——"库 revoked、链上 binding 仍 active"
    // 没有自动闭合路径。最小闭合是留痕告警：治理侧失败台账不再被
    // duplicate 复用短路（isReusableDuplicateLog 只认成功终态），运营
    // 重发 revoke-identity 即可携带原请求重新广播。仅在翻入 failed 的
    // 转变时告警一次，持续 failed 的复核轮不重复刷屏。
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

  async #resolveOutcome(
    record: ReconcileableTxRecord,
    projectionConfirmation: () => Promise<ProjectionConfirmation | undefined>
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
          // No transaction hash means no chain fact has been observed yet;
          // this is a pending/reconcile condition regardless of the adapter's
          // original retry flag. It must not be dead-lettered as a permanent
          // broadcast failure.
          retryable: true
        };
      }
      return staleOutcome(checkedAt);
    }

    const projectedBeforeReceipt = await projectionConfirmation();
    if (projectedBeforeReceipt) {
      return confirmedOutcome(checkedAt, projectedBeforeReceipt.blockNumber);
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
        // A missing receipt is a temporary observation gap, not a reverted
        // transaction. Keep probing until the timeout lane takes over.
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
      // Receipt status is an open input at the RPC boundary. Unknown,
      // pending, or omitted values must remain pending/retryable; treating
      // them as a revert can isolate a transaction which is actually still
      // mining (or already successful on the canonical chain).
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

    return confirmedOutcome(checkedAt, projected.blockNumber ?? blockNumber);
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
  if (expectedTxHash && provenance.transactionHash.toLowerCase() !== expectedTxHash.toLowerCase()) {
    return undefined;
  }
  return {
    transactionHash: provenance.transactionHash,
    blockNumber: provenance.blockNumber.toString()
  };
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
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly retryable: boolean;
}

/** 本轮内累加的进行中汇总（DTO 面只读，累加发生在 pass 内部）。 */
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
  // 与 submissions/governance 口径对齐：failed + txHash 必须继续复核——
  // 链上真相可能推翻本地失败标记（迟到成功自愈为 confirmed）；只认
  // submitted/indexing 会让超时置 failed 的注册永不再复核，product 侧重试
  // 只能开新单，同一稿产生两个 orderId。无 txHash 的 failed 从未上链，
  // 无回执可查。
  if (registration.status === "failed") {
    return Boolean(registration.txHash);
  }
  return registration.status === "submitted" || registration.status === "indexing";
}

function isReconcileableSubmission(submission: ProductSubmissionDTO): boolean {
  // 带 txHash 的 failed 必须复核回执：链上真相可能推翻本地失败标记
  // （回执成功且投影已呈现 → 自愈为 confirmed）。无 txHash 的 failed
  // 从未上链，没有回执可查。
  if (submission.status === "failed") {
    return Boolean(submission.txHash);
  }
  return submission.status === "broadcasting" || submission.status === "submitted" || submission.status === "indexing";
}

function isEvidenceBindSweepable(submission: ProductSubmissionDTO): boolean {
  // 清扫对象：链上提交已成功（持 txHash 的在途档）且随提交落库了证据
  // 引用。failed 即便带 txHash 也是回执失败/未知，不存在"提交已成功"的
  // 事实基础；expired/signature_received 从未上链；无证据引用的记录
  // 没有可重试的绑定载荷。终态 confirmed 不进清扫（对齐回执对账侧的
  // 终态剪除口径，见 #sweepEvidenceBinds 注释）。
  if (!submission.txHash || !submission.evidenceIds?.length) {
    return false;
  }
  return submission.status === "broadcasting"
    || submission.status === "submitted"
    || submission.status === "indexing";
}

function isReconcileableGovernanceLog(log: GovernanceTxLogDTO): boolean {
  // 同 registration 口径：failed + txHash 继续复核，迟到成功自愈。
  if (log.status === "failed") {
    return Boolean(log.txHash);
  }
  return log.status === "pending" || log.status === "broadcasting" || log.status === "indexing";
}

function isSimulatedGovernanceLog(log: GovernanceTxLogDTO): boolean {
  return log.executionMode === "simulated" || log.broadcastStatus === "simulated_tx";
}

/**
 * 未闭环提交的有界扫描：持久驱动提供 listOpenSubmissionsPage 时按
 * (createdAt, submissionId) 键序分页（服务端 status 剪除，终态不再返回），
 * 能力缺失时回退 listSubmissions() 全量（调用方行级过滤兜底）。键序基于
 * created_at（不可变），轮中对页内记录的状态更新不影响游标稳定性。
 */
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

/** 同 iterateOpenSubmissions 的 governance 台账版本（(createdAt, logId) 键序）。 */
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
  // 订单身份是 (planId, orderId)：registration.planId 必填（schema NOT
  // NULL），必须走复合键查询——裸 orderId 在同号订单跨 plan
  // 复用时永远查不中，registration 会永卡 indexing。
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

async function submissionProjectionConfirmation(
  projectionStore: ProjectionStore,
  submission: ProductSubmissionDTO
): Promise<ProjectionConfirmation | undefined> {
  // The state-machine identity is (planId, orderId), not bare orderId. The
  // composite lookup never returns another plan's projection for this signed
  // submission.
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
      // pending + 无 txHash = 仍在广播、回执未知：不得虚标 submitted
      // （投影不得替链说话），保持原状态（broadcasting）。有 txHash 的
      // pending 表示已广播、回执未落地，标 submitted 是如实的。
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
  const createdAtMs = Date.parse(record.createdAt);
  return Number.isFinite(createdAtMs) && now.getTime() - createdAtMs >= timeoutMs;
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
  // 泛 "not found" 会把网关类传输错误（"upstream/resource not found"）吞成
  // "回执缺失"→pending：真回执被误判缺失，超时车道随后把它标成
  // tx_reconcile_timeout 失败。viem 的错误文本必然包含方法名
  // eth_getTransactionReceipt，不能拿方法名当语境——not found 必须紧跟
  // transaction/receipt 词（geth "transaction not found"、viem "Transaction
  // receipt with hash … could not be found"）。其余传输错误原样上抛，
  // 由逐记录 catch 计失败并响亮记录。
  return /\b(?:transaction|receipt)\s+(?:with\s+hash\s+\S+\s+)?(?:could\s+not\s+be\s+found|not\s+found)/i.test(error.message);
}
