// On-chain execute path for the A-only model. Any permissionless relayer may
// call escrow.execute(trancheId, instructionRef); escrow itself verifies the
// immutable fact source. This adapter never decides business outcomes and never
// marks success without a matching event.

import { createPublicClient, createWalletClient, decodeEventLog, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "../shared/types.js";
import {
  SettlementError,
  type SettlementChainAdapter,
  type SettlementChainReceipt,
  type SettlementInstructionRecord,
  type SettlementReceiptResult,
  type SettlementSubmissionResult,
} from "./types.js";

const EXECUTE_ABI = ["function execute(bytes32 trancheId, bytes32 instructionRef)"] as const;

const SETTLEMENT_EVENT_ABI = [
  "event Settled(bytes32 indexed trancheId, bytes32 indexed orderId, bytes32 indexed stageId, uint256 payerAmount, uint256 payeeAmount, uint256 fee, bytes32 instructionRef)",
  "event Executed(bytes32 indexed trancheId, bytes32 indexed instructionRef, uint256 payerAmount, uint256 payeeAmount, uint256 fee)",
] as const;

export interface EscrowExecuteAdapterOptions {
  readonly rpcUrl: string;
  readonly privateKey: Hex;
  readonly escrowAddress: Address;
  readonly chainId: number;
}

export function createEscrowExecuteAdapter(options: EscrowExecuteAdapterOptions): SettlementChainAdapter {
  const account = privateKeyToAccount(options.privateKey);
  const transport = http(options.rpcUrl);
  const publicClient = createPublicClient({ transport, chain: undefined });
  const walletClient = createWalletClient({ account, transport, chain: undefined });
  const escrow = options.escrowAddress;

  return {
    async submitInstruction(input: { readonly instruction: SettlementInstructionRecord }): Promise<SettlementSubmissionResult> {
      if (input.instruction.kind !== "execute_transfer" && input.instruction.kind !== "execute_refund") {
        return { kind: "failed", errorCode: "unsupported_instruction_kind" };
      }
      if (input.instruction.trancheId === undefined) {
        return { kind: "failed", errorCode: "tranche_id_missing" };
      }
      try {
        const txHash = await walletClient.writeContract({
          address: escrow,
          abi: EXECUTE_ABI,
          functionName: "execute",
          args: [input.instruction.trancheId, input.instruction.instructionRef],
          account,
          chain: null,
        });
        return { kind: "submitted", txHash };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { kind: "unknown", reason: `execute_broadcast_unknown: ${message.slice(0, 120)}` };
      }
    },

    async getSettlementReceipt(input: {
      readonly chainId: number;
      readonly escrowAddress: Address;
      readonly txHash: Hex;
    }): Promise<SettlementReceiptResult> {
      const receipt = await publicClient.getTransactionReceipt({ hash: input.txHash }).catch(() => undefined);
      if (!receipt) {
        return { kind: "not_found" };
      }
      if (receipt.status !== "success") {
        return { kind: "reverted", errorCode: "execute_reverted" };
      }
      let decoded: { readonly args: Record<string, unknown>; readonly logIndex: number } | undefined;
      for (const log of receipt.logs) {
        try {
          const event = decodeEventLog({
            abi: SETTLEMENT_EVENT_ABI,
            data: log.data,
            topics: log.topics,
          });
          if (event.eventName === "Settled" || event.eventName === "Executed") {
            decoded = {
              args: event.args as unknown as Record<string, unknown>,
              logIndex: log.logIndex,
            };
            break;
          }
        } catch {
          continue;
        }
      }
      if (!decoded) {
        return { kind: "confirmed", receipt: failedReceipt(input.txHash, receipt.blockNumber) };
      }
      const args = decoded.args;
      const instructionRef = typeof args.instructionRef === "string" ? (args.instructionRef as Hex) : undefined;
      if (!instructionRef) {
        return { kind: "confirmed", receipt: failedReceipt(input.txHash, receipt.blockNumber) };
      }
      const settlementReceipt: SettlementChainReceipt = {
        txHash: input.txHash as Hex,
        blockNumber: receipt.blockNumber.toString(),
        logIndex: decoded.logIndex,
        payerAmount: String(args.payerAmount ?? "0"),
        payeeAmount: String(args.payeeAmount ?? "0"),
        feeAmount: String(args.fee ?? "0"),
        instructionRef,
      };
      return { kind: "confirmed", receipt: settlementReceipt };
    },
  };
}

function failedReceipt(txHash: Hex, blockNumber: bigint | null): SettlementChainReceipt {
  return {
    txHash,
    blockNumber: blockNumber === null ? "0" : blockNumber.toString(),
    logIndex: 0,
    payerAmount: "0",
    payeeAmount: "0",
    feeAmount: "0",
    instructionRef: `0x${"00".repeat(32)}`,
  };
}

export interface OnchainSettlementFactSourceOptions {
  readonly rpcUrl: string;
  readonly factSourceAddress: Address;
}

const FACT_SOURCE_ABI = [
  "function hasSettlementFact(bytes32 planId, bytes32 orderId, bytes32 stageId) view returns (bool)",
] as const;

export function createOnchainSettlementFactSource(
  options: OnchainSettlementFactSourceOptions
): { hasSettlementFact(input: { planId: string; orderId: string; stageId: string; instructionRef: string; kind: string }): Promise<boolean> } {
  const client = createPublicClient({ transport: http(options.rpcUrl) });
  return {
    async hasSettlementFact(input) {
      try {
        const present = await client.readContract({
          address: options.factSourceAddress,
          abi: FACT_SOURCE_ABI,
          functionName: "hasSettlementFact",
          args: [
            input.planId as Hex,
            input.orderId as Hex,
            input.stageId as Hex,
          ],
        });
        return present === true;
      } catch (error) {
        throw new SettlementError(503, "fact_source_unavailable", "could not read the UVP fact source", {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
