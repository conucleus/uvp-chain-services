// stage-patches 车道的 relay 适配：executor/resource 补丁广播共用同一安全核心
// （持久 dedupe/限流/重试/审计在 src/relay）。本文件只做 StagePatchBroadcastResult
// 词表映射、键派生与失败结果工厂，不含业务校验。

import type { AuditSink } from "../security/audit.js";
import { createRelayBroadcastSafety, type RelayBroadcastLane, type RelayFailureInput } from "../relay/safe-broadcast.js";
import type { RelayDedupeStore } from "../relay/dedupe-store.js";
import { stagePatchNonceKey } from "./keys.js";
import type {
  StageExecutorPatchBroadcastAdapter,
  StageExecutorPatchBroadcastRequest,
  StagePatchBroadcastResult,
  StageResourcePatchBroadcastAdapter,
  StageResourcePatchBroadcastRequest
} from "./types.js";

type StagePatchBroadcastRequest = StageExecutorPatchBroadcastRequest | StageResourcePatchBroadcastRequest;

type StagePatchKind = "executor" | "resource";

export interface SecureStagePatchBroadcastAdapterOptions {
  readonly maxInFlightPerOrder?: number;
  readonly maxInFlightPerSubmitter?: number;
  readonly maxRetry?: number;
  readonly maxRetryAttempts?: number;
  readonly retryBaseMs?: number;
  readonly retryMaxMs?: number;
  readonly now?: () => Date;
  readonly audit?: AuditSink;
  readonly dedupeStore?: RelayDedupeStore;
}

export interface SecureStageExecutorPatchBroadcastAdapterOptions
  extends SecureStagePatchBroadcastAdapterOptions {
  readonly adapter: StageExecutorPatchBroadcastAdapter;
}

export interface SecureStageResourcePatchBroadcastAdapterOptions
  extends SecureStagePatchBroadcastAdapterOptions {
  readonly adapter: StageResourcePatchBroadcastAdapter;
}

export function createSecureStageExecutorPatchBroadcastAdapter(
  options: SecureStageExecutorPatchBroadcastAdapterOptions
): StageExecutorPatchBroadcastAdapter {
  return secureStagePatchBroadcastAdapter("executor", options);
}

export function createSecureStageResourcePatchBroadcastAdapter(
  options: SecureStageResourcePatchBroadcastAdapterOptions
): StageResourcePatchBroadcastAdapter {
  return secureStagePatchBroadcastAdapter("resource", options);
}

export function stagePatchRelayDedupeKey(
  kind: StagePatchKind,
  request: StagePatchBroadcastRequest
): string {
  const prepared = request.prepared;
  return stagePatchNonceKey({
    kind,
    chainId: prepared.typedData.domain.chainId,
    stateMachineAddress: prepared.stateMachineAddress,
    orderId: prepared.onchainOrderId,
    targetStageId: prepared.targetStageId,
    ...(kind === "resource" && "resourceKey" in prepared ? { resourceKey: prepared.resourceKey } : {}),
    patchNonce: prepared.patchNonce
  });
}

interface SecureStagePatchAdapterOptions extends SecureStagePatchBroadcastAdapterOptions {
  readonly adapter: StageExecutorPatchBroadcastAdapter | StageResourcePatchBroadcastAdapter;
}

function secureStagePatchBroadcastAdapter(
  kind: StagePatchKind,
  options: SecureStagePatchAdapterOptions
): StageExecutorPatchBroadcastAdapter & StageResourcePatchBroadcastAdapter {
  const lane: RelayBroadcastLane<StagePatchBroadcastRequest, StagePatchBroadcastResult> = {
    actionOf: () => (kind === "executor" ? "stage_executor_patch" : "stage_resource_patch"),
    idempotencyKeyOf: (request) => stagePatchRelayDedupeKey(kind, request),
    orderKeyOf: (request) => request.prepared.onchainOrderId,
    submitterOf: (request) => request.prepared.selectorWallet,
    subjectOf: (request) => ({
      kind,
      prepareId: request.prepared.prepareId,
      taskId: request.prepared.taskId,
      orderId: request.prepared.orderId,
      onchainOrderId: request.prepared.onchainOrderId,
      targetStageId: request.prepared.targetStageId,
      selectorWallet: request.prepared.selectorWallet,
      patchNonce: request.prepared.patchNonce
    }),
    txHashOf: stagePatchBroadcastTxHash,
    isFailed: (result) => result.status === "failed",
    isRetryable: (result) => result.status === "failed" && result.retryable,
    errorCodeOf: (result) => ("errorCode" in result ? result.errorCode : undefined),
    failure: stagePatchFailedBroadcastResult
  };
  return createRelayBroadcastSafety<StagePatchBroadcastRequest, StagePatchBroadcastResult>({
    broadcast: (request) => options.adapter.broadcast(request as never),
    lane,
    ...(options.maxInFlightPerOrder !== undefined ? { maxInFlightPerOrder: options.maxInFlightPerOrder } : {}),
    ...(options.maxInFlightPerSubmitter !== undefined ? { maxInFlightPerSubmitter: options.maxInFlightPerSubmitter } : {}),
    ...(options.maxRetry !== undefined ? { maxRetry: options.maxRetry } : {}),
    ...(options.maxRetryAttempts !== undefined ? { maxRetryAttempts: options.maxRetryAttempts } : {}),
    ...(options.retryBaseMs !== undefined ? { retryBaseMs: options.retryBaseMs } : {}),
    ...(options.retryMaxMs !== undefined ? { retryMaxMs: options.retryMaxMs } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.audit !== undefined ? { audit: options.audit } : {}),
    ...(options.dedupeStore !== undefined ? { dedupeStore: options.dedupeStore } : {})
  });
}

function stagePatchBroadcastTxHash(result: StagePatchBroadcastResult): string | undefined {
  switch (result.status) {
    case "broadcasting":
    case "submitted":
    case "confirmed":
      return result.txHash;
    case "failed":
      return result.txHash ?? result.attempt?.txHash;
    case "not_attempted":
      return undefined;
  }
}

function stagePatchFailedBroadcastResult(input: RelayFailureInput): StagePatchBroadcastResult {
  const retryable = input.retryable;
  return {
    status: "failed",
    errorCode: input.errorCode,
    message: input.message,
    retryable,
    attempt: {
      status: "failed",
      errorCode: input.errorCode,
      errorMessage: input.message,
      retryable
    }
  };
}
