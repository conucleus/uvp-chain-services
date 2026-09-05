import { createPublicClient, createWalletClient, http, type Chain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  buildApplyStageExecutorPatchForCall,
  buildApplyStageResourcePatchForCall,
  type ApplyStageExecutorPatchForCall,
  type ApplyStageResourcePatchForCall
} from "@uvp-eth/protocol-bindings";
import { ConfigError, assertHex, normalizeAddress, type Address, type Hex } from "../shared/types.js";
import { redactErrorMessage } from "../security/redaction.js";
import type {
  PreparedStageExecutorPatchDTO,
  PreparedStageResourcePatchDTO,
  StageExecutorPatchBroadcastAdapter,
  StagePatchBroadcastResult,
  StageResourcePatchBroadcastAdapter
} from "./types.js";

// C15：本地手抄的 applyStageExecutorPatchFor/applyStageResourcePatchFor
// ABI 副本已删除——以 @uvp-eth/protocol-bindings 导出的
// STAGE_PATCH_MODULE_ABI（fixtures 同源）与调用构造器为准，杜绝再次漂移
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

export type StateMachineStageExecutorPatchBroadcastAdapterOptions = StateMachineStagePatchBroadcastAdapterOptions;
export type StateMachineStageResourcePatchBroadcastAdapterOptions = StateMachineStagePatchBroadcastAdapterOptions;

const DEFAULT_RELAYER_PRIVATE_KEY_ENV = "UVP_STATE_MACHINE_RELAYER_PRIVATE_KEY";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;
const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex;

export function createStateMachineStageExecutorPatchBroadcastAdapter(
  options: StateMachineStageExecutorPatchBroadcastAdapterOptions
): StageExecutorPatchBroadcastAdapter {
  return createStagePatchBroadcastAdapter(options, {
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
  });
}

export function createStateMachineStageResourcePatchBroadcastAdapter(
  options: StateMachineStageResourcePatchBroadcastAdapterOptions
): StageResourcePatchBroadcastAdapter {
  return createStagePatchBroadcastAdapter(options, {
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
  });
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
    transport: http(requiredRpcUrl(options.rpcUrl))
  });
  const account = options.walletClient ? undefined : privateKeyToAccount(loadRelayerPrivateKey(options));
  const walletClient: StateMachineStagePatchWalletClient = options.walletClient ?? (createWalletClient({
    account,
    ...(chain ? { chain } : {}),
    transport: http(requiredRpcUrl(options.rpcUrl))
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

function classifyStagePatchBroadcastError<TPrepared extends PreparedPatchForBroadcast>(
  error: unknown,
  labels: StagePatchBroadcastAdapterLabels<TPrepared>
): ClassifiedBroadcastError {
  const text = errorText(error);
  const name = findErrorName(error);
  const haystack = `${name ?? ""} ${text}`;
  if (
    haystack.includes("InvalidStagePatchSignature") ||
    haystack.includes("InvalidStageExecutorPatchSignature") ||
    haystack.includes("InvalidStageResourcePatchSignature")
  ) {
    return {
      errorCode: labels.invalidSignatureError,
      message: `wallet signature does not match the ${labels.label} payload`,
      retryable: false
    };
  }
  if (
    haystack.includes("StaleStagePatchNonce") ||
    haystack.includes("StaleStageExecutorPatchNonce") ||
    haystack.includes("StaleStageResourcePatchNonce")
  ) {
    return {
      errorCode: labels.staleNonceError,
      message: `${labels.label} nonce has already been used`,
      retryable: false
    };
  }
  if (
    haystack.includes("UnauthorizedSignalSubmitter") ||
    haystack.includes("UnauthorizedStageSelector") ||
    haystack.includes("UnauthorizedStageResourceSelector")
  ) {
    return {
      errorCode: "selector_not_authorized",
      message: "selector wallet is not authorized to patch this stage",
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
  return {
    status: "failed",
    ...(txHash ? { txHash } : {}),
    ...(blockNumber ? { blockNumber } : {}),
    errorCode,
    message,
    retryable,
    attempt: {
      status: "failed",
      ...(txHash ? { txHash } : {}),
      ...(blockNumber ? { blockNumber } : {}),
      gasPayer,
      errorCode,
      errorMessage: message,
      retryable
    }
  };
}

function loadRelayerPrivateKey(options: StateMachineStagePatchBroadcastAdapterOptions): Hex {
  const privateKey = options.relayerPrivateKey ?? (options.env ?? process.env)[
    options.relayerPrivateKeyEnv ?? DEFAULT_RELAYER_PRIVATE_KEY_ENV
  ];
  if (!privateKey) {
    throw new ConfigError(`${options.relayerPrivateKeyEnv ?? DEFAULT_RELAYER_PRIVATE_KEY_ENV} is required for stage patch broadcast`);
  }
  assertHex(privateKey, options.relayerPrivateKeyEnv ?? DEFAULT_RELAYER_PRIVATE_KEY_ENV);
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new ConfigError(`${options.relayerPrivateKeyEnv ?? DEFAULT_RELAYER_PRIVATE_KEY_ENV} must be a 32-byte private key`);
  }
  return privateKey.toLowerCase() as Hex;
}

function normalizeGasPayer(value: string | undefined): Address {
  if (!value) {
    throw new ConfigError("relayer gas payer address is required");
  }
  const address = normalizeAddress(value, "relayer gas payer");
  if (address === ZERO_ADDRESS) {
    throw new ConfigError("relayer gas payer address must not be zero");
  }
  return address;
}

function requiredRpcUrl(rpcUrl: string | undefined): string {
  // fail-closed：无显式 RPC 配置即抛错，不回落 127.0.0.1:8545（本地环境
  // 也必须显式传 UVP_RPC_URL）。
  if (!rpcUrl) {
    throw new ConfigError("UVP_RPC_URL is required for stage patch broadcast; refusing to fall back to a default RPC endpoint");
  }
  return rpcUrl;
}

function chainFor(chainId: number, rpcUrl: string): Chain {
  return {
    id: chainId,
    name: `uvp-${chainId}`,
    nativeCurrency: {
      name: "Ether",
      symbol: "ETH",
      decimals: 18
    },
    rpcUrls: {
      default: {
        http: [rpcUrl]
      }
    }
  };
}

function findErrorName(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const record = error as Record<string, unknown>;
  if (typeof record.errorName === "string") {
    return record.errorName;
  }
  if (record.cause) {
    return findErrorName(record.cause);
  }
  return undefined;
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    const causeText = "cause" in error ? errorText((error as { readonly cause?: unknown }).cause) : "";
    return redactErrorMessage([error.message, causeText].filter(Boolean).join(" "));
  }
  if (typeof error === "string") {
    return redactErrorMessage(error);
  }
  return "";
}
