import type { ProductTaskDTO } from "@uvp-eth/product-dto";
import type { ProductSubmitTypedData, ProductSubmitTypedDataField } from "@uvp-eth/protocol-bindings";
import type { EvidencePrincipal, EvidenceRecordDTO, EvidenceService } from "../evidence/index.js";
import type { TxReconcileFields } from "../reconcile/status.js";
import type { Address, Hex } from "../shared/types.js";

export type { ProductSubmitTypedData, ProductSubmitTypedDataField };

export type ProductSubmitIntent = "confirm_stage" | "reject_stage" | "raise_dispute" | "resolve_dispute";

export type ProductSubmissionStatus =
  | "prepared"
  | "signature_received"
  | "broadcasting"
  | "submitted"
  | "indexing"
  | "confirmed"
  | "failed"
  | "expired"
  | "replaced";

export type ProductSubmissionBroadcastStatus =
  | "not_attempted"
  | "broadcasting"
  | "submitted"
  | "confirmed"
  | "failed";

export type ProductSubmissionAttemptStatus = "broadcasting" | "submitted" | "confirmed" | "failed";

export type ProductSubmissionRetryState = "not_applicable" | "retryable" | "not_retryable" | "dead_letter";

export interface PrepareProductTaskSubmitInput {
  readonly evidenceIds: readonly string[];
  readonly walletAddress: string;
  readonly intent: ProductSubmitIntent;
}

export interface SubmitProductTaskInput {
  readonly prepareId: string;
  readonly signature: string;
  readonly walletAddress: string;
}

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
   * Audit #10: the state machine ABI is plan-scoped. The prepared signature
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

export interface ProductSubmissionProofRowDTO {
  readonly label: string;
  readonly value: string;
}

export interface ProductSubmissionAttemptDTO {
  readonly attemptId: string;
  readonly submissionId: string;
  readonly orderId: string;
  readonly sourceId: Hex;
  readonly signalId: Hex;
  readonly submitter: Address;
  readonly txHash?: Hex;
  readonly blockNumber?: string;
  readonly status: ProductSubmissionAttemptStatus;
  readonly errorCode?: string;
  readonly errorLabel?: string;
  readonly errorMessage?: string;
  readonly revertReason?: string;
  readonly gasPayer?: Address;
  readonly attemptNumber: number;
  readonly retryable: boolean;
  readonly retryState: ProductSubmissionRetryState;
  readonly deadLetter: boolean;
  readonly nextRetryAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ProductSubmissionDTO extends TxReconcileFields {
  readonly submissionId: string;
  readonly prepareId: string;
  readonly taskId: string;
  readonly orderId: string;
  readonly onchainOrderId: Hex;
  /** The plan-scoped identity committed by the prepared EIP-712 signature. */
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
  readonly status: ProductSubmissionStatus;
  readonly statusLabel?: string;
  readonly signatureStatus: "not_verified" | "signature_verified";
  readonly signatureHash?: Hex;
  readonly recoveredSubmitter?: Address;
  readonly broadcastStatus: ProductSubmissionBroadcastStatus;
  readonly txHash?: Hex;
  readonly blockNumber?: string;
  readonly errorCode?: string;
  readonly errorLabel?: string;
  readonly errorMessage?: string;
  readonly retryable: boolean;
  readonly retryState: ProductSubmissionRetryState;
  readonly deadLetter: boolean;
  readonly nextRetryAt?: string;
  readonly attempts: readonly ProductSubmissionAttemptDTO[];
  readonly attemptCount: number;
  readonly proofRows: readonly ProductSubmissionProofRowDTO[];
  readonly createdAt: string;
  readonly updatedAt: string;
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

export interface ProductSubmissionStore {
  withTransaction?<T>(operation: () => Promise<T>): Promise<T>;
  putPrepared(record: PreparedSubmissionRecord): Promise<void>;
  getPrepared(prepareId: string): Promise<PreparedSubmissionRecord | undefined>;
  markPreparedUsed(prepareId: string, submissionId: string, usedAt: string): Promise<void>;
  reserveNonce(key: string): Promise<boolean>;
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
}

export interface PreparedSubmissionRecord extends PreparedSubmissionDTO {
  readonly evidenceRecords: readonly EvidenceRecordDTO[];
  readonly usedAt?: string;
  readonly submissionId?: string;
}
