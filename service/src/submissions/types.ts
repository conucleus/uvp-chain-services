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
import type { ProductSubmitTypedData, ProductSubmitTypedDataField, SelectorBindingPayload, SignalAttributionPayload } from "@uvp-eth/protocol-bindings";
import type { EvidencePrincipal, EvidenceRecordDTO, EvidenceService } from "../evidence/index.js";
import type { Address, Hex } from "../shared/types.js";

export type { ProductSubmitTypedData, ProductSubmitTypedDataField };

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
  readonly attribution: SignalAttributionPayload;
  readonly selectorBinding?: SelectorBindingPayload;
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
  readonly attemptsBroadcast?: boolean;
  broadcast(request: SubmissionBroadcastRequest): Promise<SubmissionBroadcastResult>;
}

export interface ProductSubmissionScanCursor {
  readonly createdAt: string;
  readonly submissionId: string;
}

export interface ProductSubmissionStore {
  withTransaction?<T>(operation: () => Promise<T>): Promise<T>;
  putPrepared(record: PreparedSubmissionRecord): Promise<void>;
  getPrepared(prepareId: string): Promise<PreparedSubmissionRecord | undefined>;
  markPreparedUsed(prepareId: string, submissionId: string, usedAt: string): Promise<void>;
  deleteExpiredPrepared?(deadlineBeforeSeconds: string): Promise<number>;
  reserveNonce(key: string, options?: { readonly staleBefore?: string }): Promise<boolean>;
  releaseNonce?(key: string): Promise<void>;
  putSubmission(submission: ProductSubmissionDTO): Promise<void>;
  getSubmission(submissionId: string): Promise<ProductSubmissionDTO | undefined>;
  listSubmissions(): Promise<readonly ProductSubmissionDTO[]>;
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
