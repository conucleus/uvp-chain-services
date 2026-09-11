import type { Address, Hex } from "../shared/types.js";

export interface StagePatchTypedDataField {
  readonly name: string;
  readonly type: string;
}

export type StageExecutorPatchMode = "assign" | "handoff" | "replacement";

export type StageExecutorPatchSignatureStatus = "not_verified" | "signature_verified";

export type PreviousExecutorSignatureStatus = "not_required" | "not_verified" | "signature_verified";

export interface StageExecutorPatchTypedData {
  readonly domain: {
    readonly name: "UVPStagePatchModule";
    readonly version: "0.1";
    readonly chainId: number;
    readonly verifyingContract: Address;
  };
  readonly types: {
    readonly UVPStagePatchModuleStageExecutorPatch: readonly StagePatchTypedDataField[];
  };
  readonly primaryType: "UVPStagePatchModuleStageExecutorPatch";
  readonly message: {
    readonly planId: Hex;
    readonly orderId: Hex;
    readonly selectorStageId: Hex;
    readonly targetStageId: Hex;
    readonly executor: Address;
    readonly role: Hex;
    readonly executorMetadataHash: Hex;
    readonly mode: Hex;
    readonly previousExecutor: Address;
    readonly approvalSourceId: Hex;
    readonly approvalSignalId: Hex;
    readonly patchHash: Hex;
    readonly patchNonce: string;
    readonly metadataURI: string;
    readonly selector: Address;
    readonly deadline: string;
  };
}

export interface StageResourcePatchTypedData {
  readonly domain: {
    readonly name: "UVPStagePatchModule";
    readonly version: "0.1";
    readonly chainId: number;
    readonly verifyingContract: Address;
  };
  readonly types: {
    readonly UVPStagePatchModuleStageResourcePatch: readonly StagePatchTypedDataField[];
  };
  readonly primaryType: "UVPStagePatchModuleStageResourcePatch";
  readonly message: {
    readonly planId: Hex;
    readonly orderId: Hex;
    readonly selectorStageId: Hex;
    readonly targetStageId: Hex;
    readonly resourceKey: Hex;
    readonly manifestHash: Hex;
    readonly policyHash: Hex;
    readonly patchHash: Hex;
    readonly patchNonce: string;
    readonly manifestURI: string;
    readonly selector: Address;
    readonly deadline: string;
  };
}

export interface PrepareProductStageExecutorPatchInput {
  readonly selectorWallet: string;
  readonly targetStageId: string;
  readonly executorWallet: string;
  readonly mode?: string;
  readonly previousExecutorWallet?: string;
  readonly approvalSourceId?: string;
  readonly approvalSignalId?: string;
  readonly approval?: unknown;
  readonly roleHash?: string;
  readonly executorMetadataHash?: string;
  readonly supplierReferenceHash?: string;
  readonly metadataURI: string;
}

export interface PrepareProductStageResourcePatchInput {
  readonly selectorWallet: string;
  readonly targetStageId: string;
  readonly resourceKey: string;
  readonly manifestHash: string;
  readonly policyHash: string;
  readonly manifestURI: string;
}

export interface SubmitProductStageExecutorPatchInput {
  readonly prepareId?: string;
  readonly selectorWallet: string;
  readonly typedData?: unknown;
  readonly signature: string;
  readonly patch?: PreparedStageExecutorPatchDTO;
  readonly previousExecutorSignature?: string;
}

export interface SubmitProductStageResourcePatchInput {
  readonly prepareId?: string;
  readonly selectorWallet: string;
  readonly typedData?: unknown;
  readonly signature: string;
  readonly patch?: PreparedStageResourcePatchDTO;
}

export interface StageExecutorPatchHumanSummaryDTO {
  readonly purpose: string;
  readonly orderId: string;
  readonly selectorTaskId: string;
  readonly selectorStageId: Hex;
  readonly targetStageId: Hex;
  readonly executorWallet: Address;
  readonly mode: StageExecutorPatchMode;
  readonly modeHash: Hex;
  readonly previousExecutor?: Address;
  readonly approvalSourceId?: Hex;
  readonly approvalSignalId?: Hex;
  readonly patchHash: Hex;
  readonly patchNonce: string;
  readonly metadataURI: string;
  readonly selectorWallet: Address;
  readonly selectorSignatureStatus: "required";
  readonly previousExecutorSignatureStatus: "required" | "not_required";
  readonly validUntil: string;
  readonly chainId: number;
  readonly verifyingContract: Address;
}

export interface StageResourcePatchHumanSummaryDTO {
  readonly purpose: string;
  readonly orderId: string;
  readonly selectorTaskId: string;
  readonly selectorStageId: Hex;
  readonly targetStageId: Hex;
  readonly resourceKey: Hex;
  readonly manifestHash: Hex;
  readonly policyHash: Hex;
  readonly patchHash: Hex;
  readonly patchNonce: string;
  readonly manifestURI: string;
  readonly selectorWallet: Address;
  readonly validUntil: string;
  readonly chainId: number;
  readonly verifyingContract: Address;
}

export interface PreparedStageExecutorPatchDTO {
  readonly prepareId: string;
  readonly taskId: string;
  readonly orderId: string;
  readonly onchainOrderId: Hex;
  readonly stateMachineAddress: Address;
  /** plan-scoped 补丁身份：applyStageExecutorPatchFor 首参，必填。 */
  readonly planId: Hex;
  readonly selectorStageId: Hex;
  readonly targetStageId: Hex;
  readonly selectorWallet: Address;
  readonly executorWallet: Address;
  readonly mode: StageExecutorPatchMode;
  readonly modeHash: Hex;
  readonly previousExecutor?: Address;
  readonly approvalSourceId?: Hex;
  readonly approvalSignalId?: Hex;
  readonly roleHash: Hex;
  readonly executorMetadataHash: Hex;
  readonly patchHash: Hex;
  readonly patchNonce: string;
  readonly metadataURI: string;
  readonly deadline: string;
  readonly expiresAt: string;
  readonly status: "prepared";
  readonly typedData: StageExecutorPatchTypedData;
  readonly humanSummary: StageExecutorPatchHumanSummaryDTO;
}

export interface PreparedStageResourcePatchDTO {
  readonly prepareId: string;
  readonly taskId: string;
  readonly orderId: string;
  readonly onchainOrderId: Hex;
  readonly stateMachineAddress: Address;
  /** plan-scoped 补丁身份：applyStageResourcePatchFor 首参，必填。 */
  readonly planId: Hex;
  readonly selectorStageId: Hex;
  readonly targetStageId: Hex;
  readonly resourceKey: Hex;
  readonly selectorWallet: Address;
  readonly manifestHash: Hex;
  readonly policyHash: Hex;
  readonly patchHash: Hex;
  readonly patchNonce: string;
  readonly manifestURI: string;
  readonly deadline: string;
  readonly expiresAt: string;
  readonly status: "prepared";
  readonly typedData: StageResourcePatchTypedData;
  readonly humanSummary: StageResourcePatchHumanSummaryDTO;
}

export type StagePatchSubmissionStatus =
  | "signature_received"
  | "broadcasting"
  | "submitted"
  | "confirmed"
  | "failed"
  | "expired";

export type StagePatchBroadcastStatus =
  | "not_attempted"
  | "broadcasting"
  | "submitted"
  | "confirmed"
  | "failed";

export interface StagePatchProofRowDTO {
  readonly label: string;
  readonly value: string;
}

export interface StageExecutorPatchSubmissionDTO {
  readonly submissionId: string;
  readonly prepareId: string;
  readonly taskId: string;
  readonly orderId: string;
  readonly onchainOrderId: Hex;
  readonly stateMachineAddress: Address;
  readonly selectorStageId: Hex;
  readonly targetStageId: Hex;
  readonly selectorWallet: Address;
  readonly executorWallet: Address;
  readonly mode: StageExecutorPatchMode;
  readonly modeHash: Hex;
  readonly previousExecutor?: Address;
  readonly approvalSourceId?: Hex;
  readonly approvalSignalId?: Hex;
  readonly roleHash: Hex;
  readonly executorMetadataHash: Hex;
  readonly patchHash: Hex;
  readonly patchNonce: string;
  readonly metadataURI: string;
  readonly deadline: string;
  readonly status: StagePatchSubmissionStatus;
  readonly signatureStatus: "not_verified" | "signature_verified";
  readonly selectorSignatureStatus: StageExecutorPatchSignatureStatus;
  readonly previousExecutorSignatureStatus: PreviousExecutorSignatureStatus;
  readonly signatureHash?: Hex;
  readonly previousExecutorSignatureHash?: Hex;
  readonly recoveredSelector?: Address;
  readonly recoveredPreviousExecutor?: Address;
  readonly broadcastStatus: StagePatchBroadcastStatus;
  readonly txHash?: Hex;
  readonly blockNumber?: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly retryable: boolean;
  readonly proofRows: readonly StagePatchProofRowDTO[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface StageResourcePatchSubmissionDTO {
  readonly submissionId: string;
  readonly prepareId: string;
  readonly taskId: string;
  readonly orderId: string;
  readonly onchainOrderId: Hex;
  readonly stateMachineAddress: Address;
  readonly selectorStageId: Hex;
  readonly targetStageId: Hex;
  readonly resourceKey: Hex;
  readonly selectorWallet: Address;
  readonly manifestHash: Hex;
  readonly policyHash: Hex;
  readonly patchHash: Hex;
  readonly patchNonce: string;
  readonly manifestURI: string;
  readonly deadline: string;
  readonly status: StagePatchSubmissionStatus;
  readonly signatureStatus: "not_verified" | "signature_verified";
  readonly signatureHash?: Hex;
  readonly recoveredSelector?: Address;
  readonly broadcastStatus: StagePatchBroadcastStatus;
  readonly txHash?: Hex;
  readonly blockNumber?: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly retryable: boolean;
  readonly proofRows: readonly StagePatchProofRowDTO[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PreparedPatchRecordBase {
  readonly nonceKey: string;
  readonly prepareId: string;
  readonly usedAt?: string;
  readonly submissionId?: string;
}

export interface PreparedStageExecutorPatchRecord extends PreparedStageExecutorPatchDTO, PreparedPatchRecordBase {}

export interface PreparedStageResourcePatchRecord extends PreparedStageResourcePatchDTO, PreparedPatchRecordBase {}

export interface StagePatchBroadcastAttemptResult {
  readonly status: "broadcasting" | "submitted" | "confirmed" | "failed";
  readonly txHash?: Hex;
  readonly blockNumber?: string;
  readonly gasPayer?: Address;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly retryable?: boolean;
}

export type StagePatchBroadcastResult =
  | {
      readonly status: "broadcasting";
      readonly txHash?: Hex;
      readonly attempt?: StagePatchBroadcastAttemptResult;
    }
  | {
      readonly status: "submitted";
      readonly txHash: Hex;
      readonly blockNumber?: string;
      readonly attempt?: StagePatchBroadcastAttemptResult;
    }
  | {
      readonly status: "confirmed";
      readonly txHash: Hex;
      readonly blockNumber?: string;
      readonly attempt?: StagePatchBroadcastAttemptResult;
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
      readonly message: string;
      readonly retryable: boolean;
      readonly attempt?: StagePatchBroadcastAttemptResult;
    };

export interface StageExecutorPatchBroadcastRequest {
  readonly prepared: PreparedStageExecutorPatchDTO;
  readonly signature: Hex;
  readonly previousExecutorSignature?: Hex;
  readonly recoveredSelector: Address;
  readonly recoveredPreviousExecutor?: Address;
}

export interface StageResourcePatchBroadcastRequest {
  readonly prepared: PreparedStageResourcePatchDTO;
  readonly signature: Hex;
  readonly recoveredSelector: Address;
}

export interface StageExecutorPatchBroadcastAdapter {
  broadcast(request: StageExecutorPatchBroadcastRequest): Promise<StagePatchBroadcastResult>;
}

export interface StageResourcePatchBroadcastAdapter {
  broadcast(request: StageResourcePatchBroadcastRequest): Promise<StagePatchBroadcastResult>;
}

export interface StagePatchSubmissionBase {
  readonly submissionId: string;
}

export interface ProductStagePatchStore<
  TPrepared extends PreparedPatchRecordBase,
  TSubmission extends StagePatchSubmissionBase
> {
  /**
   * 可选事务能力（sqlite/postgres 实现）：putSubmission 与 nonce 收尾
   * （释放或 markPreparedUsed）必须同事务提交——分开提交时事务间崩溃
   * 会留下"nonce 行已插、prepare 未标 used"的组合，同 prepareId 的合法
   * 重试将永久 409（全库无其他释放口）。
   */
  withTransaction?<T>(operation: () => Promise<T>): Promise<T>;
  putPrepared(record: TPrepared): Promise<void>;
  getPrepared(prepareId: string): Promise<TPrepared | undefined>;
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
   * reserve 之后的 broadcast/存储写入抛错时，提交服务会先释放
   * nonce 再 rethrow，保证同一 prepareId 在瞬时 RPC/存储失败后仍可重试。
   * 与 ProductSubmissionStore.releaseNonce 相同的可选能力语义：实现缺失时
   * patch 服务按 nonce 已消费处理（fail-closed，不重试）。
   */
  releaseNonce?(key: string): Promise<void>;
  /**
   * 过期 prepare 清扫：删除 deadline（unix 秒字符串）小于
   * deadlineBeforeSeconds 的行，返回删除行数。prepare 入口未设配额，
   * 只插不删会让内存表/持久表无界堆叠；由服务层在写入时顺带触发
   * （同 store-sessions 挑战表口径）。可选能力：实现缺失时跳过清扫，
   * memory 驱动自身的硬上限仍然兜底。
   */
  deleteExpiredPrepared?(deadlineBeforeSeconds: string): Promise<number>;
  putSubmission(submission: TSubmission): Promise<void>;
  getSubmission(submissionId: string): Promise<TSubmission | undefined>;
}

export type ProductStageExecutorPatchStore = ProductStagePatchStore<
  PreparedStageExecutorPatchRecord,
  StageExecutorPatchSubmissionDTO
>;

export type ProductStageResourcePatchStore = ProductStagePatchStore<
  PreparedStageResourcePatchRecord,
  StageResourcePatchSubmissionDTO
>;
;
