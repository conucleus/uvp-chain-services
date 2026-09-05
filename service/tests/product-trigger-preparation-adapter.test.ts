import { describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, keccak256, stringToBytes } from "viem";
import {
  AnvilProductOrderTriggerBroadcastAdapter,
  productSignalId,
  productSignalSourceId,
  type ProductTriggerBroadcastPublicClient,
  type ProductTriggerBroadcastWalletClient
} from "../src/product/bff/trigger.js";
import { deriveTriggerOrderId } from "@uvp-eth/protocol-bindings";
import type { Address, Hex } from "../src/shared/types.js";

const stateMachineAddress = address("1111");
const registrarAddress = address("2222");
const orderId = bytes32("1001");
const startTxHash = bytes32("bbbb");
const planId = bytes32("2001");
const payloadHash = bytes32("3001");
const idempotencyKey = bytes32("3002");
const signature = `0x${"11".repeat(65)}` as Hex;
const triggerHookId = productSignalId("v0.9.create-order.trigger");
const triggerStageId = productSignalSourceId("v0.9.create-order.stage");
const sourceId = productSignalSourceId("order");
const signalId = productSignalId("registered");
const signalSubmittedTopic = keccak256(stringToBytes("SignalSubmitted(bytes32,bytes32,bytes32,bytes32,bytes32,bytes32,address)")) as Hex;
const signalSubmittedData = encodeAbiParameters(
  [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "address" }],
  [signalId, payloadHash, idempotencyKey, registrarAddress]
);

describe("Product BFF trigger broadcast adapter", () => {
  it("submits signed trigger order and confirms the trigger signal", async () => {
    const walletClient: ProductTriggerBroadcastWalletClient = {
      account: { address: registrarAddress },
      writeContract: vi.fn(async () => {
        return startTxHash;
      })
    };
    const publicClient: ProductTriggerBroadcastPublicClient = {
      waitForTransactionReceipt: vi.fn(async () => ({
        status: "success",
        blockNumber: 12n,
        logs: [{
          address: stateMachineAddress,
          // 一事一单：链上订单 id 由合约派生——回执事件携带派生 id。
          topics: [signalSubmittedTopic, planId, deriveTriggerOrderId(planId, sourceId, signalId, payloadHash), sourceId],
          data: signalSubmittedData
        }]
      }))
    };
    const adapter = adapterWithClients(publicClient, walletClient);

    const result = await adapter.broadcastOutsideTrigger({
      draftId: "draft_1",
      triggerId: "trigger_1",
      orderId,
      planId,
      creator: registrarAddress,
      triggerHookId,
      triggerStageId,
      sourceId,
      signalId,
      stateMachineAddress,
      payloadHash,
      idempotencyKey,
      authorizations: [],
      submitter: registrarAddress,
      deadline: "9999999999",
      signature
    });

    expect(result).toMatchObject({
      status: "confirmed",
      txHash: startTxHash,
      blockNumber: "12",
      retryable: false
    });
    expect(walletClient.writeContract).toHaveBeenCalledTimes(1);
    expect(publicClient.waitForTransactionReceipt).toHaveBeenCalledWith({ hash: startTxHash });
  });

  it("reports failed trigger order receipts", async () => {
    const walletClient: ProductTriggerBroadcastWalletClient = {
      account: { address: registrarAddress },
      writeContract: vi.fn(async () => {
        return startTxHash;
      })
    };
    const publicClient: ProductTriggerBroadcastPublicClient = {
      waitForTransactionReceipt: vi.fn(async () => ({
        status: "reverted",
        blockNumber: 11n,
        logs: []
      }))
    };
    const adapter = adapterWithClients(publicClient, walletClient);

    const result = await adapter.broadcastOutsideTrigger({
      draftId: "draft_1",
      triggerId: "trigger_1",
      orderId,
      planId,
      creator: registrarAddress,
      triggerHookId,
      triggerStageId,
      sourceId,
      signalId,
      stateMachineAddress,
      payloadHash,
      idempotencyKey,
      authorizations: [],
      submitter: registrarAddress,
      deadline: "9999999999",
      signature
    });

    expect(result).toMatchObject({
      status: "failed",
      errorCode: "trigger_order_reverted",
      retryable: false
    });
    expect(walletClient.writeContract).toHaveBeenCalledTimes(1);
    expect(publicClient.waitForTransactionReceipt).toHaveBeenCalledWith({ hash: startTxHash });
  });

  it("carries the broadcast txHash through failures after writeContract succeeded", async () => {
    // writeContract 成功（交易已上链）后等待回执抛错：failed 结果不得丢失 txHash。
    const walletClient: ProductTriggerBroadcastWalletClient = {
      account: { address: registrarAddress },
      writeContract: vi.fn(async () => startTxHash)
    };
    const publicClient: ProductTriggerBroadcastPublicClient = {
      waitForTransactionReceipt: vi.fn(async () => {
        throw new Error("receipt wait timed out");
      })
    };
    const adapter = adapterWithClients(publicClient, walletClient);

    const result = await adapter.broadcastOutsideTrigger({
      draftId: "draft_1",
      triggerId: "trigger_1",
      orderId,
      planId,
      creator: registrarAddress,
      triggerHookId,
      triggerStageId,
      sourceId,
      signalId,
      stateMachineAddress,
      payloadHash,
      idempotencyKey,
      authorizations: [],
      submitter: registrarAddress,
      deadline: "9999999999",
      signature
    });

    expect(result).toMatchObject({
      status: "indexing",
      errorCode: "transaction_receipt_unknown",
      txHash: startTxHash,
      retryable: true
    });
  });

  it("keeps an unknown receipt in indexing instead of claiming success or revert", async () => {
    const walletClient: ProductTriggerBroadcastWalletClient = {
      account: { address: registrarAddress },
      writeContract: vi.fn(async () => startTxHash)
    };
    const publicClient: ProductTriggerBroadcastPublicClient = {
      waitForTransactionReceipt: vi.fn(async () => ({
        status: "pending",
        logs: []
      }))
    };
    const adapter = adapterWithClients(publicClient, walletClient);

    await expect(adapter.broadcastOutsideTrigger({
      draftId: "draft_1",
      triggerId: "trigger_1",
      orderId,
      planId,
      creator: registrarAddress,
      triggerHookId,
      triggerStageId,
      sourceId,
      signalId,
      stateMachineAddress,
      payloadHash,
      idempotencyKey,
      authorizations: [],
      submitter: registrarAddress,
      deadline: "9999999999",
      signature
    })).resolves.toMatchObject({
      status: "indexing",
      txHash: startTxHash,
      errorCode: "transaction_receipt_unknown",
      retryable: true
    });
  });

  it("marks deterministic write reverts non-retryable", async () => {
    const walletClient: ProductTriggerBroadcastWalletClient = {
      account: { address: registrarAddress },
      writeContract: vi.fn(async () => {
        throw new Error("execution reverted: UnknownOrder");
      })
    };
    const publicClient: ProductTriggerBroadcastPublicClient = {
      waitForTransactionReceipt: vi.fn()
    };
    const adapter = adapterWithClients(publicClient, walletClient);

    await expect(adapter.broadcastOutsideTrigger({
      draftId: "draft_1",
      triggerId: "trigger_1",
      orderId,
      planId,
      creator: registrarAddress,
      triggerHookId,
      triggerStageId,
      sourceId,
      signalId,
      stateMachineAddress,
      payloadHash,
      idempotencyKey,
      authorizations: [],
      submitter: registrarAddress,
      deadline: "9999999999",
      signature
    })).resolves.toMatchObject({
      status: "failed",
      errorCode: "trigger_order_reverted",
      retryable: false
    });
  });
});

function adapterWithClients(
  publicClient: ProductTriggerBroadcastPublicClient,
  walletClient: ProductTriggerBroadcastWalletClient
): AnvilProductOrderTriggerBroadcastAdapter {
  return new AnvilProductOrderTriggerBroadcastAdapter({
    rpcUrl: "http://127.0.0.1:8545",
    chainId: 31337,
    stateMachineAddress,
    registrarAddress,
    waitForReceipt: true,
    publicClient,
    walletClient,
    unknownOrderRetryDelayMs: 0,
    unknownOrderMaxRetries: 2
  });
}

function bytes32(value: string): Hex {
  return `0x${value.padStart(64, "0")}` as Hex;
}

function address(value: string): Address {
  return `0x${value.padStart(40, "0")}` as Address;
}
