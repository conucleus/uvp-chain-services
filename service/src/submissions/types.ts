import type {
  PrepareProductTaskSubmitInput,
  ProductSubmissionAttemptDTO,
  ProductSubmissionAttemptStatus,
  ProductSubmissionBroadcastStatus,
  ProductSubmissionDTO,
  ProductSubmissionProofRowDTO,
  ProductSubmissionRetryState,
  ProductSubmissionStatus,
  ProductSubmitIntent,
  SubmitProductTaskInput,
  ProductTaskDTO
} from "@uvp-eth/product-dto";
import type { ProductSubmitTypedData, ProductSubmitTypedDataField } from "@uvp-eth/protocol-bindings";
import type { EvidencePrincipal, EvidenceRecordDTO, EvidenceService } from "../evidence/index.js";
import type { Address, Hex } from "../shared/types.js";

export type { ProductSubmitTypedData, ProductSubmitTypedDataField };

// 写侧契约单源在 @uvp-eth/product-dto（write-side.ts，形状以本服务端真身
// 为权威）；此处仅再导出供仓内消费。statusLabel 必填的成立前提是
// withSubmissionReconcileDefaults（service.ts）对每次读取恒兜底产出。
export type {
  PrepareProductTaskSubmitInput,
  ProductSubmissionAttemptDTO,
  ProductSubmissionAttemptStatus,
  ProductSubmissionBroadcastStatus,
  ProductSubmissionDTO,
  ProductSubmissionProofRowDTO,
  ProductSubmissionRetryState,
  ProductSubmissionStatus,
  ProductSubmitIntent,
  SubmitProductTaskInput
};

export interface PreparedSubmissionEvidenceDTO {
  readonly evidenceId: string;
  readonly payloadHash: Hex;
  readonly payloadRef: string;
  readonly verificationStatus: string;
}

export interface PreparedSubmissionDTO {
  readonly prepareId: string;
  readonly taskId: string;
  readonly orderId: string;
  readonly onchainOrderId: Hex;
  /**
   * the state machine ABI is plan-scoped. The prepared signature
   * commits to (planId, orderId); the zero placeholder is never stored here.
   */
  readonly planId: Hex;
  readonly stageIdentifier: string;
  readonly signalName: string;
  readonly sourceId: Hex;
  readonly signalId: Hex;
  readonly intent: ProductSubmitIntent;
  readonly payloadHash: Hex;
  readonly payloadRef: string;
  readonly idempotencyKey: Hex;
  readonly submitter: Address;
  readonly nonce: string;
  readonly deadline: string;
  readonly expiresAt: string;
  readonly status: "prepared";
  readonly humanSummary: ProductSubmitHumanSummaryDTO;
  readonly typedData: ProductSubmitTypedData;
  readonly evidence: readonly PreparedSubmissionEvidenceDTO[];
  readonly authorization: {
    readonly source: string;
  };
}

export interface ProductSubmitHumanSummaryDTO {
  readonly purpose: string;
  readonly orderId: string;
  readonly taskTitle: string;
  readonly stage: string;
  readonly action: string;
  readonly payloadHash: Hex;
  readonly payloadRef: string;
  readonly submitter: Address;
  readonly validUntil: string;
  readonly chainId: number;
  readonly verifyingContract: Address;
}

export interface ProductTaskReader {
  getTask(taskId: string): Promise<ProductTaskDTO | undefined>;
}

export type ProductSubmissionEvidenceReader = Pick<EvidenceService, "getEvidence" | "getProof"> &
  Partial<Pick<EvidenceService, "bindEvidence">>;

export interface SubmissionAuthorizationRequest {
  readonly task: ProductTaskDTO;
  readonly orderId: string;
  readonly taskId: string;
  readonly stageIdentifier: string;
  readonly signalName: string;
  readonly onchainOrderId: Hex;
  readonly sourceId: Hex;
  readonly signalId: Hex;
  readonly intent: ProductSubmitIntent;
  readonly submitter: Address;
}

export interface SubmissionAuthorizationResult {
  readonly authorized: boolean;
  readonly source: string;
  readonly reason?: string;
}

export interface SubmissionAuthorizationAdapter {
  authorize(request: SubmissionAuthorizationRequest): Promise<SubmissionAuthorizationResult>;
}

export interface SubmissionBroadcastRequest {
  readonly prepared: PreparedSubmissionDTO;
  readonly signature: Hex;
  readonly recoveredSubmitter: Address;
  readonly evidence: readonly EvidenceRecordDTO[];
}

export interface SubmissionBroadcastAttemptResult {
  readonly status: ProductSubmissionAttemptStatus;
  readonly txHash?: Hex;
  readonly blockNumber?: string;
  readonly revertReason?: string;
  readonly gasPayer?: Address;
  readonly attemptNumber?: number;
  readonly errorCode?: string;
  readonly errorLabel?: string;
  readonly errorMessage?: string;
  readonly retryable?: boolean;
  readonly retryState?: ProductSubmissionRetryState;
  readonly deadLetter?: boolean;
  readonly nextRetryAt?: string;
}

export type SubmissionBroadcastResult =
  | {
      readonly status: "broadcasting";
      readonly txHash?: Hex;
      readonly attempt?: SubmissionBroadcastAttemptResult;
    }
  | {
      readonly status: "submitted";
      readonly txHash: Hex;
      readonly blockNumber?: string;
      readonly attempt?: SubmissionBroadcastAttemptResult;
    }
  | {
      readonly status: "confirmed";
      readonly txHash: Hex;
      readonly blockNumber?: string;
      readonly attempt?: SubmissionBroadcastAttemptResult;
    }
  | {
      readonly status: "not_attempted";
      readonly errorCode: string;
      readonly reason: string;
    }
  | {
      readonly status: "failed";
      readonly txHash?: Hex;
      readonly blockNumber?: string;
      readonly errorCode: string;
      readonly errorLabel?: string;
      readonly message: string;
      readonly retryable: boolean;
      readonly retryState?: ProductSubmissionRetryState;
      readonly deadLetter?: boolean;
      readonly nextRetryAt?: string;
      readonly attempt?: SubmissionBroadcastAttemptResult;
    };

export interface SubmissionBroadcastAdapter {
  /**
   * Capability flag: does this adapter actually broadcast to chain?
   * Adapters that cannot broadcast must declare `attemptsBroadcast: false`
   * so callers never reserve nonces or consume prepared submissions for
   * transactions that will never be sent.
   */
  readonly attemptsBroadcast?: boolean;
  broadcast(request: SubmissionBroadcastRequest): Promise<SubmissionBroadcastResult>;
}

/** 台账键序扫描游标：(createdAt, submissionId) 双键，created_at 不可变保证轮中更新不影响游标稳定性。 */
export interface ProductSubmissionScanCursor {
  readonly createdAt: string;
  readonly submissionId: string;
}

export interface ProductSubmissionStore {
  withTransaction?<T>(operation: () => Promise<T>): Promise<T>;
  putPrepared(record: PreparedSubmissionRecord): Promise<void>;
  getPrepared(prepareId: string): Promise<PreparedSubmissionRecord | undefined>;
  markPreparedUsed(prepareId: string, submissionId: string, usedAt: string): Promise<void>;
  /**
   * staleBefore：命中既有预留时，预留时间早于该阈值的行视为陈旧预留
   * （进程在 reserve 与落档之间硬崩溃的唯一泄漏形态——存活中的 submit
   * 要么在同一落档事务内收尾，要么显式释放，预留年龄不可能超过一个
   * 授权有效期）。陈旧行走条件更新接管并返回 true；未过期仍返回 false
   * 由调用方 409。阈值缺省时退化为纯 insert 语义。
   */
  reserveNonce(key: string, options?: { readonly staleBefore?: string }): Promise<boolean>;
  /**
   * Release a previously reserved nonce so the same prepared submission can be
   * retried after a failure that consumed the reservation without ever
   * recording a submission (transient RPC or store failure). Optional store
   * capability: submission-service treats a missing releaseNonce as
   * best-effort.
   */
  releaseNonce?(key: string): Promise<void>;
  putSubmission(submission: ProductSubmissionDTO): Promise<void>;
  getSubmission(submissionId: string): Promise<ProductSubmissionDTO | undefined>;
  listSubmissions(): Promise<readonly ProductSubmissionDTO[]>;
  /**
   * 对账/清扫车道的有界扫描（可选能力）：按 (createdAt, submissionId)
   * 键序返回"未闭环"的一页——status ∈ {broadcasting, submitted,
   * indexing, failed}。终态（confirmed/expired/signature_received/
   * replaced）随历史单调增长且每轮重扫是 O(全历史) 的根因，服务端直接
   * 剪除不返回。failed 是否可复核（需带 txHash）由调用方行级过滤。after
   * 为上一页末尾游标，缺省从头开始；实现缺失时调用方回退
   * listSubmissions() 全量。
   */
  listOpenSubmissionsPage?(
    after: ProductSubmissionScanCursor | undefined,
    limit: number
  ): Promise<readonly ProductSubmissionDTO[]>;
}

export interface PreparedSubmissionRecord extends PreparedSubmissionDTO {
  readonly evidenceRecords: readonly EvidenceRecordDTO[];
  readonly usedAt?: string;
  readonly submissionId?: string;
}
