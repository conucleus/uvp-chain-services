import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  buildApplyStageExecutorPatchForCall,
  buildApplyStageResourcePatchForCall,
  type ApplyStageExecutorPatchForCall,
  type ApplyStageResourcePatchForCall,
  type SelectorBindingPayload,
  type SignalAuthorizationPayload
} from "@uvp-eth/protocol-bindings";
import { ConfigError, normalizeAddress, type Address, type Hex } from "../shared/types.js";
import {
  ZERO_ADDRESS,
  ZERO_BYTES32,
  broadcastFailureCore,
  chainFor,
  errorText,
  findErrorName,
  loadRelayerPrivateKey,
  normalizeGasPayer,
  requiredRpcUrl
} from "../shared/broadcast/kit.js";
import { resolveDuplicateTransactionOutcome } from "../shared/broadcast/duplicate-transaction.js";
import type {
  PreparedStageExecutorPatchDTO,
  PreparedStageResourcePatchDTO,
  StageExecutorPatchBroadcastAdapter,
  StagePatchBroadcastResult,
  StageResourcePatchBroadcastAdapter
} from "./types.js";

export type StateMachineStagePatchCall =
  | ApplyStageExecutorPatchForCall
  | ApplyStageResourcePatchForCall;

export interface StateMachineStagePatchPublicClient {
  getChainId?(): Promise<number>;
  waitForTransactionReceipt?(args: { readonly hash: Hex; readonly timeout?: number }): Promise<{
    readonly status?: "success" | "reverted" | string;
    readonly blockNumber?: bigint;
  } | undefined>;
  getTransactionReceipt?(args: { readonly hash: Hex }): Promise<{
    readonly status?: "success" | "reverted" | string;
    readonly blockNumber?: bigint;
  } | undefined | null>;
}

export interface StateMachineStagePatchWalletClient {
  readonly account?: { readonly address?: string };
  writeContract(call: StateMachineStagePatchCall): Promise<Hex>;
}

export interface StateMachineStagePatchBroadcastAdapterOptions {
  readonly stateMachineAddress: Address;
  readonly chainId: number;
  readonly rpcUrl?: string;
  readonly relayerPrivateKey?: Hex;
  readonly relayerPrivateKeyEnv?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly publicClient?: StateMachineStagePatchPublicClient;
  readonly walletClient?: StateMachineStagePatchWalletClient;
  readonly waitForReceipt?: boolean;
  readonly confirmOnReceipt?: boolean;
  readonly rejectGasPayerAsSelector?: boolean;
  readonly receiptTimeoutMs?: number;
  readonly now?: () => Date;
}

const BROADCAST_LABEL = "stage patch broadcast";

export type StateMachineStageExecutorPatchBroadcastAdapterOptions = StateMachineStagePatchBroadcastAdapterOptions;
export type StateMachineStageResourcePatchBroadcastAdapterOptions = StateMachineStagePatchBroadcastAdapterOptions;

export const STAGE_EXECUTOR_PATCH_BROADCAST_LABELS: StagePatchBroadcastAdapterLabels<
  PreparedStageExecutorPatchDTO,
  import("./types.js").StageExecutorPatchBroadcastRequest
> = {
  label: "stage executor patch",
  invalidSignatureError: "invalid_stage_executor_patch_signature",
  staleNonceError: "stale_stage_executor_patch_nonce",
  genericFailureError: "stage_executor_patch_broadcast_failed",
  buildCall: (config, prepared, request) => buildApplyStageExecutorPatchForCall(
    {
      stagePatchModuleAddress: config.stagePatchModuleAddress,
      ...(config.chainId !== undefined ? { chainId: config.chainId } : {})
    },
    {
      planId: prepared.planId,
      orderId: prepared.onchainOrderId,
      patch: {
        selectorStageId: prepared.selectorStageId,
        targetStageId: prepared.targetStageId,
        executor: prepared.executorWallet,
        role: prepared.roleHash,
        executorMetadataHash: prepared.executorMetadataHash,
        mode: prepared.modeHash,
        previousExecutor: prepared.previousExecutor ?? ZERO_ADDRESS,
        authorizationsHash: prepared.authorizationsHash,
        patchHash: prepared.patchHash,
        patchNonce: prepared.patchNonce,
        metadataURI: prepared.metadataURI
      },
      selector: prepared.selectorWallet,
      deadline: prepared.deadline,
      selectorSignature: request.signature,
      previousExecutorSignature: request.previousExecutorSignature ?? "0x",
      bindingProof: request.bindingProof,
      candidateProof: request.candidateProof,
      executorAuthorizations: request.executorAuthorizations
    }
  )
};

export const STAGE_RESOURCE_PATCH_BROADCAST_LABELS: StagePatchBroadcastAdapterLabels<
  PreparedStageResourcePatchDTO,
  import("./types.js").StageResourcePatchBroadcastRequest
> = {
  label: "stage resource patch",
  invalidSignatureError: "invalid_stage_resource_patch_signature",
  staleNonceError: "stale_stage_resource_patch_nonce",
  genericFailureError: "stage_resource_patch_broadcast_failed",
  buildCall: (config, prepared, request) => buildApplyStageResourcePatchForCall(
    {
      stagePatchModuleAddress: config.stagePatchModuleAddress,
      ...(config.chainId !== undefined ? { chainId: config.chainId } : {})
    },
    {
      planId: prepared.planId,
      orderId: prepared.onchainOrderId,
      patch: {
        selectorStageId: prepared.selectorStageId,
        targetStageId: prepared.targetStageId,
        resourceKey: prepared.resourceKey,
        manifestHash: prepared.manifestHash,
        policyHash: prepared.policyHash,
        patchHash: prepared.patchHash,
        patchNonce: prepared.patchNonce,
        manifestURI: prepared.manifestURI
      },
      selector: prepared.selectorWallet,
      deadline: prepared.deadline,
      signature: request.signature,
      bindingProof: request.bindingProof
    }
  )
};

export function createStateMachineStageExecutorPatchBroadcastAdapter(
  options: StateMachineStageExecutorPatchBroadcastAdapterOptions
): StageExecutorPatchBroadcastAdapter {
  return createStagePatchBroadcastAdapter(
    options,
    STAGE_EXECUTOR_PATCH_BROADCAST_LABELS,
  );
}

export function createStateMachineStageResourcePatchBroadcastAdapter(
  options: StateMachineStageResourcePatchBroadcastAdapterOptions
): StageResourcePatchBroadcastAdapter {
  return createStagePatchBroadcastAdapter(
    options,
    STAGE_RESOURCE_PATCH_BROADCAST_LABELS,
  );
}

type PreparedPatchForBroadcast =
  | PreparedStageExecutorPatchDTO
  | PreparedStageResourcePatchDTO;
type StagePatchBroadcastRequestBase<TPrepared extends PreparedPatchForBroadcast> = {
  readonly prepared: TPrepared;
  readonly signature: Hex;
  readonly recoveredSelector: Address;
  readonly previousExecutorSignature?: Hex;
  readonly bindingProof: SelectorBindingPayload;
  readonly candidateProof?: readonly Hex[];
  readonly executorAuthorizations?: readonly SignalAuthorizationPayload[];
};

interface StagePatchBroadcastAdapterLabels<
  TPrepared extends PreparedPatchForBroadcast,
  TRequest extends StagePatchBroadcastRequestBase<TPrepared>
> {
  readonly label: string;
  readonly invalidSignatureError: string;
  readonly staleNonceError: string;
  readonly genericFailureError: string;
  buildCall(
    config: { readonly stagePatchModuleAddress: Address; readonly chainId?: number },
    prepared: TPrepared,
    request: TRequest
  ): StateMachineStagePatchCall;
}

function createStagePatchBroadcastAdapter<
  TPrepared extends PreparedPatchForBroadcast,
  TRequest extends StagePatchBroadcastRequestBase<TPrepared>
>(
  options: StateMachineStagePatchBroadcastAdapterOptions,
  labels: StagePatchBroadcastAdapterLabels<TPrepared, TRequest>
): { broadcast(request: TRequest): Promise<StagePatchBroadcastResult> } {
  const stateMachineAddress = normalizeAddress(options.stateMachineAddress, "stateMachineAddress");
  if (stateMachineAddress === ZERO_ADDRESS) {
    throw new ConfigError("stateMachineAddress must not be zero");
  }
  const now = options.now ?? (() => new Date());
  const chain = options.rpcUrl ? chainFor(options.chainId, options.rpcUrl) : undefined;
  const publicClient: StateMachineStagePatchPublicClient = options.publicClient ?? createPublicClient({
    ...(chain ? { chain } : {}),
    transport: http(requiredRpcUrl(options.rpcUrl, BROADCAST_LABEL))
  });
  const account = options.walletClient ? undefined : privateKeyToAccount(loadRelayerPrivateKey(options, BROADCAST_LABEL));
  const walletClient: StateMachineStagePatchWalletClient = options.walletClient ?? (createWalletClient({
    account,
    ...(chain ? { chain } : {}),
    transport: http(requiredRpcUrl(options.rpcUrl, BROADCAST_LABEL))
  }) as unknown as StateMachineStagePatchWalletClient);
  const gasPayer = normalizeGasPayer(options.walletClient?.account?.address ?? account?.address);
  const waitForReceipt = options.waitForReceipt ?? true;

  return {
    async broadcast(request): Promise<StagePatchBroadcastResult> {
      const currentSeconds = BigInt(Math.floor(now().getTime() / 1000));
      if (BigInt(request.prepared.deadline) < currentSeconds) {
        return failedResult(`expired_${labels.invalidSignatureError.replace(/^invalid_/, "")}`, `${labels.label} signature deadline has expired`, false, gasPayer);
      }
      if (request.recoveredSelector !== request.prepared.selectorWallet) {
        return failedResult(
          labels.invalidSignatureError,
          "wallet signature does not match the prepared selector",
          false,
          gasPayer
        );
      }
      if (options.rejectGasPayerAsSelector && gasPayer === request.prepared.selectorWallet) {
        return failedResult(
          "relayer_business_signer_reuse",
          "relayer gas payer must not be the selector business signer",
          false,
          gasPayer
        );
      }
      if (!request.prepared.planId || request.prepared.planId === ZERO_BYTES32) {
        return failedResult(
          "order_plan_unresolved",
          "prepared stage patch has no non-zero planId for the plan-scoped patch ABI",
          false,
          gasPayer
        );
      }

      let rpcChainId: number | undefined;
      try {
        rpcChainId = await publicClient.getChainId?.();
      } catch (error) {
        const classified = classifyStagePatchBroadcastError(error, labels);
        return failedResult(classified.errorCode, classified.message, classified.retryable, gasPayer);
      }
      if (rpcChainId !== undefined && rpcChainId !== options.chainId) {
        return failedResult(
          "chain_id_mismatch",
          `configured chainId ${options.chainId} does not match RPC chainId ${rpcChainId}`,
          false,
          gasPayer
        );
      }

      let txHash: Hex;
      try {
        const stagePatchModuleAddress = normalizeAddress(
          request.prepared.typedData.domain.verifyingContract ?? request.prepared.stateMachineAddress ?? stateMachineAddress,
          "prepared.typedData.domain.verifyingContract"
        );
        txHash = await walletClient.writeContract(labels.buildCall({
          stagePatchModuleAddress,
          chainId: options.chainId
        }, request.prepared, request));
      } catch (error) {
        const classified = classifyStagePatchBroadcastError(error, labels);
        if (classified.errorCode === "duplicate_transaction") {
          const getReceipt = publicClient.getTransactionReceipt
            ? (txHash: Hex) => publicClient.getTransactionReceipt!({ hash: txHash })
            : undefined;
          return resolveDuplicateTransactionOutcome(
            error,
            getReceipt,
            {
              onSubmitted: ({ txHash: probedTxHash, blockNumber }) => {
                const status = options.confirmOnReceipt ? "confirmed" : "submitted";
                return {
                  status,
                  txHash: probedTxHash,
                  ...(blockNumber !== undefined ? { blockNumber } : {}),
                  attempt: {
                    status,
                    txHash: probedTxHash,
                    ...(blockNumber !== undefined ? { blockNumber } : {}),
                    gasPayer,
                    retryable: false
                  }
                } satisfies StagePatchBroadcastResult;
              },
              onReceiptFailed: ({ txHash: failedTxHash, blockNumber }) =>
                failedResult(
                  "transaction_reverted",
                  "the duplicate transaction was mined and reverted on chain",
                  false,
                  gasPayer,
                  failedTxHash,
                  blockNumber
                ),
              onReceiptUnknown: ({ txHash: candidateTxHash }) =>
                failedResult(
                  "transaction_receipt_unknown",
                  "broadcaster reported a duplicate transaction but no receipt is available yet; the candidate hash is retained for the next probe",
                  true,
                  gasPayer,
                  candidateTxHash
                ),
              onReassemblableNonceRace: () =>
                failedResult(
                  "duplicate_transaction",
                  `broadcaster reported a nonce race without an attributable transaction hash; the ${labels.label} can be re-assembled with a fresh gas nonce`,
                  true,
                  gasPayer
                )
            }
          );
        }
        return failedResult(classified.errorCode, classified.message, classified.retryable, gasPayer);
      }

      if (!waitForReceipt) {
        return {
          status: "submitted",
          txHash,
          attempt: {
            status: "submitted",
            txHash,
            gasPayer,
            retryable: false
          }
        };
      }

      try {
        const receipt = await publicClient.waitForTransactionReceipt?.({
          hash: txHash,
          ...(options.receiptTimeoutMs && options.receiptTimeoutMs > 0 ? { timeout: options.receiptTimeoutMs } : {})
        });
        if (receipt?.status === "reverted" || receipt?.status === "failed") {
          return failedResult("transaction_reverted", "transaction reverted", false, gasPayer, txHash, receipt.blockNumber?.toString());
        }
        if (receipt?.status !== "success") {
          return failedResult(
            "transaction_receipt_unknown",
            "transaction receipt is missing or has an unknown status",
            true,
            gasPayer,
            txHash,
            receipt?.blockNumber?.toString()
          );
        }
        const status = options.confirmOnReceipt ? "confirmed" : "submitted";
        return {
          status,
          txHash,
          ...(receipt?.blockNumber !== undefined ? { blockNumber: receipt.blockNumber.toString() } : {}),
          attempt: {
            status,
            txHash,
            ...(receipt?.blockNumber !== undefined ? { blockNumber: receipt.blockNumber.toString() } : {}),
            gasPayer,
            retryable: false
          }
        };
      } catch (error) {
        const classified = classifyStagePatchBroadcastError(error, labels);
        return failedResult(classified.errorCode, classified.message, classified.retryable, gasPayer, txHash);
      }
    }
  };
}

export function notSupportedStageExecutorPatchBroadcastAdapter(): StageExecutorPatchBroadcastAdapter {
  return {
    async broadcast() {
      return {
        status: "not_attempted",
        errorCode: "broadcast_disabled",
        reason: "UVPStateMachine stage executor patch relayer broadcast is not configured; the selector signature was verified but no chain transaction was sent"
      };
    }
  };
}

export function notSupportedStageResourcePatchBroadcastAdapter(): StageResourcePatchBroadcastAdapter {
  return {
    async broadcast() {
      return {
        status: "not_attempted",
        errorCode: "broadcast_disabled",
        reason: "UVPStateMachine stage resource patch relayer broadcast is not configured; the selector signature was verified but no chain transaction was sent"
      };
    }
  };
}

interface ClassifiedBroadcastError {
  readonly errorCode: string;
  readonly message: string;
  readonly retryable: boolean;
}

export function classifyStagePatchBroadcastError<TPrepared extends PreparedPatchForBroadcast>(
  error: unknown,
  labels: StagePatchBroadcastAdapterLabels<
    TPrepared,
    StagePatchBroadcastRequestBase<TPrepared>
  >
): ClassifiedBroadcastError {
  const text = errorText(error);
  const name = findErrorName(error);
  const haystack = `${name ?? ""} ${text}`;
  if (
    haystack.includes("ExpiredStageExecutorPatchSignature") ||
    haystack.includes("ExpiredStageResourcePatchSignature")
  ) {
    return {
      errorCode: `expired_${labels.invalidSignatureError.replace(/^invalid_/, "")}`,
      message: `${labels.label} signature deadline has expired on chain`,
      retryable: false
    };
  }
  if (
    haystack.includes("InvalidStageExecutorPatchSignature") ||
    haystack.includes("InvalidStageResourcePatchSignature") ||
    haystack.includes("InvalidStageExecutorPatchSignatureLength") ||
    haystack.includes("InvalidStageResourcePatchSignatureLength")
  ) {
    return {
      errorCode: labels.invalidSignatureError,
      message: `wallet signature does not match the ${labels.label} payload`,
      retryable: false
    };
  }
  if (
    haystack.includes("StageExecutorPatchNonceNotIncreasing") ||
    haystack.includes("StageResourcePatchNonceNotIncreasing")
  ) {
    return {
      errorCode: labels.staleNonceError,
      message: `${labels.label} nonce has already been used`,
      retryable: false
    };
  }
  if (
    haystack.includes("UnauthorizedStageExecutorPatchSelector") ||
    haystack.includes("UnauthorizedStageResourcePatchSelector")
  ) {
    return {
      errorCode: "selector_not_authorized",
      message: "selector wallet is not authorized to patch this stage",
      retryable: false
    };
  }
  if (haystack.includes("StageExecutorNotCandidate")) {
    return {
      errorCode: "executor_not_in_candidate_set",
      message: "the patch executor is not a member of the plan's committed executor candidate set",
      retryable: false
    };
  }
  if (haystack.includes("UnknownOrder")) {
    return {
      errorCode: "unknown_order",
      message: "order is not registered on the state machine",
      retryable: true
    };
  }
  if (/nonce too low|replacement transaction underpriced|already known/i.test(haystack)) {
    return {
      errorCode: "duplicate_transaction",
      message: `broadcaster reported a duplicate or already-used transaction nonce for the ${labels.label}`,
      retryable: true
    };
  }
  if (/timeout|timed out|ETIMEDOUT|AbortError|ECONNRESET/i.test(haystack)) {
    return {
      errorCode: "rpc_timeout",
      message: `RPC request timed out while broadcasting the ${labels.label}`,
      retryable: true
    };
  }
  if (/execution reverted|transaction reverted|reverted/i.test(haystack)) {
    return {
      errorCode: "transaction_reverted",
      message: `state-machine transaction reverted before the ${labels.label} was accepted`,
      retryable: false
    };
  }
  return {
    errorCode: labels.genericFailureError,
    message: `${labels.label} broadcast failed`,
    retryable: true
  };
}

function failedResult(
  errorCode: string,
  message: string,
  retryable: boolean,
  gasPayer: Address,
  txHash?: Hex,
  blockNumber?: string
): StagePatchBroadcastResult {
  return broadcastFailureCore({ errorCode, message, retryable, gasPayer, ...(txHash ? { txHash } : {}), ...(blockNumber ? { blockNumber } : {}) });
}

