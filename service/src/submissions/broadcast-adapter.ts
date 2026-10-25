import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  STATE_MACHINE_ABI,
  buildSubmitSignalForCall,
  type SignalAttributionCallStruct,
  type SignalAttributionPayload
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
import { zeroFactAttribution } from "./capability-proofs.js";
import type { SubmissionBroadcastAdapter, SubmissionBroadcastResult } from "./types.js";

export interface StateMachineSubmissionPublicClient {
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

export interface StateMachineSubmitSignalForCall {
  readonly address: Address;
  readonly abi: typeof STATE_MACHINE_ABI;
  readonly functionName: "submitSignalFor";
  readonly args: readonly [
    Hex,
    Hex,
    Hex,
    Hex,
    Hex,
    Hex,
    Address,
    bigint,
    Hex,
    SignalAttributionCallStruct
  ];
  readonly data?: Hex;
  readonly chainId?: number;
}

export interface StateMachineSubmissionWalletClient {
  readonly account?: { readonly address?: string };
  writeContract(call: StateMachineSubmitSignalForCall): Promise<Hex>;
}

export interface StateMachineSubmissionBroadcastAdapterOptions {
  readonly stateMachineAddress: Address;
  readonly chainId: number;
  readonly rpcUrl?: string;
  readonly relayerPrivateKey?: Hex;
  readonly relayerPrivateKeyEnv?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly publicClient?: StateMachineSubmissionPublicClient;
  readonly walletClient?: StateMachineSubmissionWalletClient;
  readonly waitForReceipt?: boolean;
  readonly confirmOnReceipt?: boolean;
  readonly rejectGasPayerAsSubmitter?: boolean;
  readonly receiptTimeoutMs?: number;
  readonly now?: () => Date;
}

export interface ClassifiedStateMachineBroadcastError {
  readonly errorCode: string;
  readonly errorLabel: string;
  readonly message: string;
  readonly operatorDetail: string;
  readonly retryable: boolean;
  readonly deadLetter: boolean;
  readonly revertReason?: string;
}

const DEFAULT_RELAYER_PRIVATE_KEY_LABEL = "state-machine submission broadcast";

export function createStateMachineSubmissionBroadcastAdapter(
  options: StateMachineSubmissionBroadcastAdapterOptions
): SubmissionBroadcastAdapter {
  const stateMachineAddress = normalizeAddress(options.stateMachineAddress, "stateMachineAddress");
  if (stateMachineAddress === ZERO_ADDRESS) {
    throw new ConfigError("stateMachineAddress must not be zero");
  }
  const now = options.now ?? (() => new Date());
  const chain = options.rpcUrl ? chainFor(options.chainId, options.rpcUrl) : undefined;
  const publicClient: StateMachineSubmissionPublicClient = options.publicClient ?? createPublicClient({
    ...(chain ? { chain } : {}),
    transport: http(requiredRpcUrl(options.rpcUrl, DEFAULT_RELAYER_PRIVATE_KEY_LABEL))
  });
  const account = options.walletClient ? undefined : privateKeyToAccount(loadRelayerPrivateKey(options, DEFAULT_RELAYER_PRIVATE_KEY_LABEL));
  const walletClient: StateMachineSubmissionWalletClient = options.walletClient ?? (createWalletClient({
    account,
    ...(chain ? { chain } : {}),
    transport: http(requiredRpcUrl(options.rpcUrl, DEFAULT_RELAYER_PRIVATE_KEY_LABEL))
  }) as unknown as StateMachineSubmissionWalletClient);
  const gasPayer = normalizeGasPayer(options.walletClient?.account?.address ?? account?.address);
  const waitForReceipt = options.waitForReceipt ?? true;

  return {
    async broadcast(request): Promise<SubmissionBroadcastResult> {
      const planId = normalizePlanId(request.prepared.planId);
      if (!planId) {
        return failedResult(
          "order_plan_unresolved",
          "prepared submission has no non-zero planId for the plan-scoped submitSignalFor ABI",
          false,
          gasPayer
        );
      }
      const currentSeconds = BigInt(Math.floor(now().getTime() / 1000));
      if (BigInt(request.prepared.deadline) < currentSeconds) {
        return failedResult("expired_signal_signature", "signature deadline has expired", false, gasPayer);
      }
      if (request.recoveredSubmitter !== request.prepared.submitter) {
        return failedResult(
          "invalid_signal_signature",
          "wallet signature does not match the prepared submitter",
          false,
          gasPayer,
          "RecoveredSubmitterMismatch"
        );
      }
      if (options.rejectGasPayerAsSubmitter && gasPayer === request.prepared.submitter) {
        return failedResult(
          "relayer_business_signer_reuse",
          "relayer gas payer must not be the participant business signer",
          false,
          gasPayer,
          "RelayerBusinessSignerReuse"
        );
      }

      let rpcChainId: number | undefined;
      try {
        rpcChainId = await publicClient.getChainId?.();
      } catch (error) {
        const classified = classifyStateMachineBroadcastError(error);
        return failedResult(
          classified.errorCode,
          classified.message,
          classified.retryable,
          gasPayer,
          classified.revertReason
        );
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
        const attribution: SignalAttributionPayload = request.prepared.attribution ??
          zeroFactAttribution(request.prepared.sourceId, request.prepared.signalId);
        const call = buildSubmitSignalForCall({
          stateMachineAddress: request.prepared.typedData.domain.verifyingContract ?? stateMachineAddress,
          chainId: options.chainId
        }, {
          planId,
          orderId: request.prepared.onchainOrderId,
          sourceId: request.prepared.sourceId,
          signalId: request.prepared.signalId,
          payloadHash: request.prepared.payloadHash,
          idempotencyKey: request.prepared.idempotencyKey,
          submitter: request.prepared.submitter,
          deadline: request.prepared.deadline,
          signature: request.signature,
          attribution
        });
        txHash = await walletClient.writeContract(call);
      } catch (error) {
        const classified = classifyStateMachineBroadcastError(error);
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
                    retryable: false,
                    retryState: "not_applicable",
                    deadLetter: false
                  }
                } satisfies SubmissionBroadcastResult;
              },
              onReceiptFailed: ({ txHash: failedTxHash, blockNumber }) =>
                failedResult(
                  "transaction_reverted",
                  "the duplicate transaction was mined and reverted on chain",
                  false,
                  gasPayer,
                  "transaction_reverted",
                  failedTxHash,
                  blockNumber
                ),
              onReceiptUnknown: ({ txHash: candidateTxHash }) =>
                failedResult(
                  "transaction_receipt_unknown",
                  "broadcaster reported a duplicate transaction but no receipt is available yet; the candidate hash is retained for the next probe",
                  true,
                  gasPayer,
                  "transaction_receipt_unknown",
                  candidateTxHash
                ),
              onReassemblableNonceRace: () =>
                failedResult(
                  "duplicate_transaction",
                  "broadcaster reported a nonce race without an attributable transaction hash; the payload can be re-assembled with a fresh gas nonce",
                  true,
                  gasPayer
                )
            }
          );
        }
        return failedResult(
          classified.errorCode,
          classified.message,
          classified.retryable,
          gasPayer,
          classified.revertReason
        );
      }

      if (!waitForReceipt) {
        return {
          status: "submitted",
          txHash,
          attempt: {
            status: "submitted",
            txHash,
            gasPayer,
            retryable: false,
            retryState: "not_applicable",
            deadLetter: false
          }
        };
      }

      try {
        const receipt = await publicClient.waitForTransactionReceipt?.({
          hash: txHash,
          ...(options.receiptTimeoutMs && options.receiptTimeoutMs > 0 ? { timeout: options.receiptTimeoutMs } : {})
        });
        if (receipt?.status === "reverted" || receipt?.status === "failed") {
          return failedResult(
            "transaction_reverted",
            "transaction reverted",
            false,
            gasPayer,
            "transaction_reverted",
            txHash,
            receipt.blockNumber?.toString()
          );
        }
        if (receipt?.status !== "success") {
          return failedResult(
            "transaction_receipt_unknown",
            "transaction receipt is missing or has an unknown status",
            true,
            gasPayer,
            "transaction_receipt_unknown",
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
            retryable: false,
            retryState: "not_applicable",
            deadLetter: false
          }
        };
      } catch (error) {
        const classified = classifyStateMachineBroadcastError(error);
        return failedResult(
          classified.errorCode,
          classified.message,
          classified.retryable,
          gasPayer,
          classified.revertReason,
          txHash
        );
      }
    }
  };
}

export function classifyStateMachineBroadcastError(error: unknown): ClassifiedStateMachineBroadcastError {
  const name = findErrorName(error);
  const text = errorText(error);
  const haystack = `${name ?? ""} ${text}`;

  if (haystack.includes("UnauthorizedSignalSubmitter")) {
    return classifiedBroadcastError(
      "unauthorized_signal_submitter",
      "current wallet is not authorized to submit this signal",
      false,
      text,
      "UnauthorizedSignalSubmitter"
    );
  }
  if (haystack.includes("SignalAlreadyExists")) {
    return classifiedBroadcastError(
      "signal_already_exists",
      "this task signal has already been submitted",
      false,
      text,
      "SignalAlreadyExists"
    );
  }
  if (haystack.includes("UnknownOrder")) {
    return classifiedBroadcastError(
      "unknown_order",
      "order is not registered on the state machine",
      true,
      text,
      "UnknownOrder"
    );
  }
  if (haystack.includes("ExpiredSignalSignature")) {
    return classifiedBroadcastError(
      "expired_signal_signature",
      "signature deadline has expired",
      false,
      text,
      "ExpiredSignalSignature"
    );
  }
  if (haystack.includes("InvalidSignalSignature")) {
    return classifiedBroadcastError(
      "invalid_signal_signature",
      "wallet signature does not match the submitter payload",
      false,
      text,
      name?.includes("InvalidSignalSignature") ? name : "InvalidSignalSignature"
    );
  }
  if (/nonce too low|replacement transaction underpriced|already known/i.test(haystack)) {
    return classifiedBroadcastError(
      "duplicate_transaction",
      "broadcaster reported a duplicate or already-used transaction nonce",
      true,
      text
    );
  }
  if (/execution reverted|transaction reverted|reverted/i.test(haystack)) {
    return classifiedBroadcastError(
      "transaction_reverted",
      "state-machine transaction reverted before the signal was accepted",
      false,
      text
    );
  }
  if (/insufficient funds/i.test(haystack)) {
    return classifiedBroadcastError(
      "relayer_insufficient_funds",
      "relayer gas payer has insufficient funds",
      true,
      text
    );
  }
  if (/timeout|timed out|ETIMEDOUT|AbortError|ECONNRESET/i.test(haystack)) {
    return classifiedBroadcastError(
      "rpc_timeout",
      "RPC request timed out while broadcasting the signal",
      true,
      text
    );
  }

  return classifiedBroadcastError(
    "state_machine_broadcast_failed",
    "state-machine signal broadcast failed",
    true,
    text || "unknown broadcast failure"
  );
}

function classifiedBroadcastError(
  errorCode: string,
  message: string,
  retryable: boolean,
  operatorDetail: string,
  revertReason?: string
): ClassifiedStateMachineBroadcastError {
  return {
    errorCode,
    errorLabel: errorLabelForBroadcastError(errorCode),
    message,
    operatorDetail: operatorDetail || message,
    retryable,
    deadLetter: deadLetterForBroadcastError(errorCode, retryable),
    ...(revertReason ? { revertReason } : {})
  };
}

function failedResult(
  errorCode: string,
  message: string,
  retryable: boolean,
  gasPayer: Address,
  revertReason?: string,
  txHash?: Hex,
  blockNumber?: string
): SubmissionBroadcastResult {
  const deadLetter = deadLetterForBroadcastError(errorCode, retryable);
  const errorLabel = errorLabelForBroadcastError(errorCode);
  const retryState = deadLetter ? "dead_letter" : retryable ? "retryable" : "not_retryable";
  const core = broadcastFailureCore({ errorCode, message, retryable, gasPayer, ...(txHash ? { txHash } : {}), ...(blockNumber ? { blockNumber } : {}) });
  return {
    ...core,
    errorLabel,
    retryState,
    deadLetter,
    attempt: {
      ...core.attempt,
      errorLabel,
      ...(revertReason ? { revertReason } : {}),
      retryState,
      deadLetter
    }
  };
}

function errorLabelForBroadcastError(errorCode: string): string {
  switch (errorCode) {
    case "unauthorized_signal_submitter":
      return "Submitter is not authorized";
    case "signal_already_exists":
      return "Signal was already submitted";
    case "unknown_order":
      return "Order is not registered yet";
    case "expired_signal_signature":
      return "Wallet signature expired";
    case "invalid_signal_signature":
      return "Wallet signature is invalid";
    case "chain_id_mismatch":
      return "RPC chain does not match configuration";
    case "duplicate_transaction":
      return "Duplicate transaction";
    case "relayer_insufficient_funds":
      return "Relayer gas payer needs funds";
    case "relayer_business_signer_reuse":
      return "Relayer key reused as participant";
    case "rpc_timeout":
      return "RPC request timed out";
    case "transaction_reverted":
      return "Transaction reverted";
    case "transaction_receipt_unknown":
      return "Transaction receipt is unknown";
    case "state_machine_broadcast_failed":
      return "Broadcast failed";
    default:
      return errorCode;
  }
}

function deadLetterForBroadcastError(errorCode: string, retryable: boolean): boolean {
  if (retryable) {
    return false;
  }
  switch (errorCode) {
    case "chain_id_mismatch":
    case "expired_signal_signature":
    case "invalid_signal_signature":
    case "order_plan_unresolved":
    case "relayer_business_signer_reuse":
    case "signal_already_exists":
    case "transaction_reverted":
    case "unauthorized_signal_submitter":
      return true;
    default:
      return false;
  }
}

function normalizePlanId(value: Hex | string | undefined): Hex | undefined {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    return undefined;
  }
  const normalized = value.toLowerCase() as Hex;
  return normalized === ZERO_BYTES32 ? undefined : normalized;
}
