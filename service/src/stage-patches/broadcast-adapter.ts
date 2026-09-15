import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  buildApplyStageExecutorPatchForCall,
  buildApplyStageResourcePatchForCall,
  type ApplyStageExecutorPatchForCall,
  type ApplyStageResourcePatchForCall
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

// applyStageExecutorPatchFor/applyStageResourcePatchFor 的 ABI 以
// @uvp-eth/protocol-bindings 导出的
// STAGE_PATCH_MODULE_ABI（fixtures 同源）与调用构造器为准，杜绝本地漂移
//（本地副本缺 planId 首参时广播必然在链上 revert）。
export type StateMachineStagePatchCall =
  | ApplyStageExecutorPatchForCall
  | ApplyStageResourcePatchForCall;

export interface StateMachineStagePatchPublicClient {
  getChainId?(): Promise<number>;
  waitForTransactionReceipt?(args: { readonly hash: Hex; readonly timeout?: number }): Promise<{
    readonly status?: "success" | "reverted" | string;
    readonly blockNumber?: bigint;
  } | undefined>;
  /** duplicate-transaction 车道的回执探针（viem publicClient 自带同签名）。 */
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

/** 分类标签随工厂导出：conformance 测试复用同一份标签做"revert 名→检测模式"锁定。 */
export const STAGE_EXECUTOR_PATCH_BROADCAST_LABELS: StagePatchBroadcastAdapterLabels<PreparedStageExecutorPatchDTO> = {
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
        approvalSourceId: prepared.approvalSourceId ?? ZERO_BYTES32,
        approvalSignalId: prepared.approvalSignalId ?? ZERO_BYTES32,
        patchHash: prepared.patchHash,
        patchNonce: prepared.patchNonce,
        metadataURI: prepared.metadataURI
      },
      selector: prepared.selectorWallet,
      deadline: prepared.deadline,
      selectorSignature: request.signature,
      previousExecutorSignature: request.previousExecutorSignature ?? "0x"
    }
  )
};

export const STAGE_RESOURCE_PATCH_BROADCAST_LABELS: StagePatchBroadcastAdapterLabels<PreparedStageResourcePatchDTO> = {
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
      signature: request.signature
    }
  )
};

export function createStateMachineStageExecutorPatchBroadcastAdapter(
  options: StateMachineStageExecutorPatchBroadcastAdapterOptions
): StageExecutorPatchBroadcastAdapter {
  return createStagePatchBroadcastAdapter(options, STAGE_EXECUTOR_PATCH_BROADCAST_LABELS);
}

export function createStateMachineStageResourcePatchBroadcastAdapter(
  options: StateMachineStageResourcePatchBroadcastAdapterOptions
): StageResourcePatchBroadcastAdapter {
  return createStagePatchBroadcastAdapter(options, STAGE_RESOURCE_PATCH_BROADCAST_LABELS);
}

type PreparedPatchForBroadcast =
  | PreparedStageExecutorPatchDTO
  | PreparedStageResourcePatchDTO;
type StagePatchBroadcastRequestBase<TPrepared extends PreparedPatchForBroadcast> = {
  readonly prepared: TPrepared;
  readonly signature: Hex;
  readonly recoveredSelector: Address;
  readonly previousExecutorSignature?: Hex;
};

interface StagePatchBroadcastAdapterLabels<TPrepared extends PreparedPatchForBroadcast> {
  readonly label: string;
  readonly invalidSignatureError: string;
  readonly staleNonceError: string;
  readonly genericFailureError: string;
  buildCall(
    config: { readonly stagePatchModuleAddress: Address; readonly chainId?: number },
    prepared: TPrepared,
    request: StagePatchBroadcastRequestBase<TPrepared>
  ): StateMachineStagePatchCall;
}

function createStagePatchBroadcastAdapter<TPrepared extends PreparedPatchForBroadcast>(
  options: StateMachineStagePatchBroadcastAdapterOptions,
  labels: StagePatchBroadcastAdapterLabels<TPrepared>
): { broadcast(request: StagePatchBroadcastRequestBase<TPrepared>): Promise<StagePatchBroadcastResult> } {
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

      // 与 submissions 同构：chain-id 预检是一次普通 RPC 往返，传输故障必须
      // 分类为 failed 广播结果，绝不允许抛穿调用方（抛穿会在未记录任何提交
      // 的情况下消耗预留 nonce）。
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
        // duplicate-transaction 三车道（nonce too low / already known /
        // replacement underpriced）不是终态失败：交易可能已上链或仍在池中，
        // 先按候选 txHash 探回执裁决（成功按 submitted 落账、revert 终态、
        // 未知可重试并保留候选哈希），机制单源在 shared/broadcast。
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
        // Do not treat an absent receipt or an extension/unknown status as a
        // successful submission. The transaction hash is retained so an
        // operator/reconcile path can inspect it without broadcasting again.
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

/**
 * stage patch 广播错误的分类（viem 抛穿 writeContract/getChainId 的错误）。
 * 导出供 error-taxonomy conformance 测试做"合约 revert 名→检测模式"锁定；
 * 合约错误名以权威 ABI 为准——UVPStateMachine 的错误名可从
 * @uvp-eth/protocol-bindings 的 UVP_STATE_MACHINE_ARTIFACT_ABI 交叉验证
 * （error-taxonomy conformance 测试锁定），UVPStagePatchModule 自身的错误
 * 名以合约源为准。检测串必须是真实合约错误名：近似名（如历史上的
 * "StaleStagePatchNonce"/"UnauthorizedStageSelector"）与真实名
 * （StageExecutorPatchNonceNotIncreasing/UnauthorizedStageExecutorPatchSelector）
 * 互不为子串，失配会让一切持久性 revert 落进泛 retryable 分支，同一
 * prepare 被无限重试链上必拒的变更。
 */
export function classifyStagePatchBroadcastError<TPrepared extends PreparedPatchForBroadcast>(
  error: unknown,
  labels: StagePatchBroadcastAdapterLabels<TPrepared>
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
  // UnknownOrder 先于泛 reverted 判定：viem 的合约执行错误文本同时含
  // "reverted." 与 "Error: UnknownOrder()"，泛规则在前会把"订单尚未注册/
  // 索引未跟上"的典型瞬态永久死信（对齐 submissions 广播分类器的既有规则）。
  if (haystack.includes("UnknownOrder")) {
    return {
      errorCode: "unknown_order",
      message: "order is not registered on the state machine",
      retryable: true
    };
  }
  // duplicate-transaction 车道（broadcaster 的 nonce 冲突三形态）：基础判定
  // 对齐 taxonomy nonce_conflict（不可重试、死信），但 broadcast() 捕获口会
  // 先走回执探针裁决改判——直接死信会把已上链交易永久标记 failed。
  if (/nonce too low|replacement transaction underpriced|already known/i.test(haystack)) {
    return {
      errorCode: "duplicate_transaction",
      message: `broadcaster reported a duplicate or already-used transaction nonce for the ${labels.label}`,
      retryable: false
    };
  }
  if (/timeout|timed out|ETIMEDOUT|AbortError|ECONNRESET/i.test(haystack)) {
    return {
      errorCode: "rpc_timeout",
      message: `RPC request timed out while broadcasting the ${labels.label}`,
      retryable: true
    };
  }
  // 泛 revert 兜底（对齐 submissions/broadcast-adapter 既有规则）：发送前
  // viem 的 gas 预估（estimateGas）对必拒交易抛泛 revert——真实执行失败按
  // 永久失败处理，继续按可重试无限重放同一签名载荷只会重复烧 gas。位置
  // 必须在 UnknownOrder/timeout 等瞬态判定之后，否则复合文本的瞬态被误判。
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

