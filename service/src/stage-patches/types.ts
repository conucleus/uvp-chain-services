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
  putPrepared(record: TPrepared): Promise<void>;
  getPrepared(prepareId: string): Promise<TPrepared | undefined>;
  markPreparedUsed(prepareId: string, submissionId: string, usedAt: string): Promise<void>;
  reserveNonce(key: string): Promise<boolean>;
  /**
   * ETH-01：reserve 之后的 broadcast/存储写入抛错时，提交服务会先释放
   * nonce 再 rethrow，保证同一 prepareId 在瞬时 RPC/存储失败后仍可重试。
   * 与 ProductSubmissionStore.releaseNonce 相同的可选语义：旧实现缺失时
   * patch 服务按 nonce 已消费处理（保持向后兼容）。
   */
  releaseNonce?(key: string): Promise<void>;
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
