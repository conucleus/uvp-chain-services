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
    readonly name: "UVPStateMachine";
    readonly version: "0.2";
    readonly chainId: number;
    readonly verifyingContract: Address;
  };
  readonly types: {
    readonly UVPStateMachineStageExecutorPatch: readonly StagePatchTypedDataField[];
  };
  readonly primaryType: "UVPStateMachineStageExecutorPatch";
  readonly message: {
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
    readonly name: "UVPStateMachine";
    readonly version: "0.2";
    readonly chainId: number;
    readonly verifyingContract: Address;
  };
  readonly types: {
    readonly UVPStateMachineStageResourcePatch: readonly StagePatchTypedDataField[];
  };
  readonly primaryType: "UVPStateMachineStageResourcePatch";
  readonly message: {
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

export interface DockedOrderLinkTypedData {
  readonly domain: {
    readonly name: "UVPStateMachine";
    readonly version: "0.2";
    readonly chainId: number;
    readonly verifyingContract: Address;
  };
  readonly types: {
    readonly UVPStateMachineDockedOrderLink: readonly StagePatchTypedDataField[];
  };
  readonly primaryType: "UVPStateMachineDockedOrderLink";
  readonly message: {
    readonly localOrderId: Hex;
    readonly selectorStageId: Hex;
    readonly localSourceId: Hex;
    readonly linkedOrderId: Hex;
    readonly linkedPlanId: Hex;
    readonly linkHash: Hex;
    readonly linkNonce: string;
    readonly signalBindingsHash: Hex;
    readonly metadataURI: string;
    readonly selector: Address;
    readonly deadline: string;
  };
}

export interface DockedSignalBindingDTO {
  readonly localSourceId: Hex;
  readonly localSignalId: Hex;
  readonly linkedSourceId: Hex;
  readonly linkedSignalId: Hex;
}

export interface PrepareProductStageExecutorPatchInput {
  readonly selectorWallet: string;
  readonly targetStageId: string;
  readonly executorWallet: string;
  readonly mode?: string;
  readonly previousExecutor?: string;
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

export interface PrepareProductDockedOrderLinkInput {
  readonly selectorWallet: string;
  readonly localSourceId: string;
  readonly linkedOrderId: string;
  readonly linkedPlanId: string;
  readonly signalBindings: readonly {
    readonly localSourceId: string;
    readonly localSignalId: string;
    readonly linkedSourceId: string;
    readonly linkedSignalId: string;
  }[];
  readonly metadataURI: string;
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

export interface SubmitProductDockedOrderLinkInput {
  readonly prepareId?: string;
  readonly selectorWallet: string;
  readonly typedData?: unknown;
  readonly signature: string;
  readonly link?: PreparedDockedOrderLinkDTO;
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

export interface DockedOrderLinkHumanSummaryDTO {
  readonly purpose: string;
  readonly localOrderId: string;
  readonly selectorTaskId: string;
  readonly selectorStageId: Hex;
  readonly localSourceId: Hex;
  readonly linkedOrderId: Hex;
  readonly linkedPlanId: Hex;
  readonly linkHash: Hex;
  readonly linkNonce: string;
  readonly metadataURI: string;
  readonly selectorWallet: Address;
  readonly signalBindings: readonly DockedSignalBindingDTO[];
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

export interface PreparedDockedOrderLinkDTO {
  readonly prepareId: string;
  readonly taskId: string;
  readonly localOrderId: string;
  readonly onchainLocalOrderId: Hex;
  readonly stateMachineAddress: Address;
  readonly selectorStageId: Hex;
  readonly localSourceId: Hex;
  readonly linkedOrderId: Hex;
  readonly linkedPlanId: Hex;
  readonly selectorWallet: Address;
  readonly linkHash: Hex;
  readonly linkNonce: string;
  readonly metadataURI: string;
  readonly signalBindings: readonly DockedSignalBindingDTO[];
  readonly deadline: string;
  readonly expiresAt: string;
  readonly status: "prepared";
  readonly typedData: DockedOrderLinkTypedData;
  readonly humanSummary: DockedOrderLinkHumanSummaryDTO;
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

export interface DockedOrderLinkSubmissionDTO {
  readonly submissionId: string;
  readonly prepareId: string;
  readonly taskId: string;
  readonly localOrderId: string;
  readonly onchainLocalOrderId: Hex;
  readonly stateMachineAddress: Address;
  readonly selectorStageId: Hex;
  readonly localSourceId: Hex;
  readonly linkedOrderId: Hex;
  readonly linkedPlanId: Hex;
  readonly selectorWallet: Address;
  readonly linkHash: Hex;
  readonly linkNonce: string;
  readonly metadataURI: string;
  readonly signalBindings: readonly DockedSignalBindingDTO[];
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

export interface PreparedDockedOrderLinkRecord extends PreparedDockedOrderLinkDTO, PreparedPatchRecordBase {}

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

export interface DockedOrderLinkBroadcastRequest {
  readonly prepared: PreparedDockedOrderLinkDTO;
  readonly signature: Hex;
  readonly recoveredSelector: Address;
}

export interface StageExecutorPatchBroadcastAdapter {
  broadcast(request: StageExecutorPatchBroadcastRequest): Promise<StagePatchBroadcastResult>;
}

export interface StageResourcePatchBroadcastAdapter {
  broadcast(request: StageResourcePatchBroadcastRequest): Promise<StagePatchBroadcastResult>;
}

export interface DockedOrderLinkBroadcastAdapter {
  broadcast(request: DockedOrderLinkBroadcastRequest): Promise<StagePatchBroadcastResult>;
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

export type ProductDockedOrderLinkStore = ProductStagePatchStore<
  PreparedDockedOrderLinkRecord,
  DockedOrderLinkSubmissionDTO
>;
