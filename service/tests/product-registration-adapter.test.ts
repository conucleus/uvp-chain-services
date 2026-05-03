import { describe, expect, it, vi } from "vitest";
import { keccak256, stringToBytes } from "viem";
import {
  AnvilProductOrderRegistrationAdapter,
  PRODUCT_INITIAL_TRIGGER_SIGNAL_ID,
  PRODUCT_INITIAL_TRIGGER_SOURCE_ID,
  type ProductRegistrationPublicClient,
  type ProductRegistrationWalletClient
} from "../src/product/bff/registration.js";
import type { Address, Hex } from "../src/shared/types.js";

const stateMachineAddress = address("1111");
const registrarAddress = address("2222");
const orderId = bytes32("1001");
const otherOrderId = bytes32("1002");
const registrationTxHash = bytes32("aaaa");
const startTxHash = bytes32("bbbb");
const planId = bytes32("2001");
const payloadHash = bytes32("3001");
const idempotencyKey = bytes32("3002");
const orderRegisteredTopic = keccak256(stringToBytes("OrderRegistered(bytes32,bytes32)")) as Hex;
const signalSubmittedTopic = keccak256(stringToBytes("SignalSubmitted(bytes32,bytes32,bytes32,bytes32,bytes32,address)")) as Hex;

describe("Product BFF registration adapter", () => {
  it("retries initial trigger UnknownOrder once the registration tx proves the order exists", async () => {
    let writes = 0;
    const walletClient: ProductRegistrationWalletClient = {
      account: { address: registrarAddress },
      writeContract: vi.fn(async () => {
        writes += 1;
        if (writes === 1) {
          throw unknownOrderError();
        }
        return startTxHash;
      })
    };
    const publicClient: ProductRegistrationPublicClient = {
      waitForTransactionReceipt: vi.fn(async ({ hash }) => {
        if (hash === registrationTxHash) {
          return {
            status: "success",
            blockNumber: 11n,
            logs: [{
              address: stateMachineAddress,
              topics: [orderRegisteredTopic, orderId, planId]
            }]
          };
        }
        return {
          status: "success",
          blockNumber: 12n,
          logs: [{
            address: stateMachineAddress,
            topics: [signalSubmittedTopic, orderId, PRODUCT_INITIAL_TRIGGER_SOURCE_ID, PRODUCT_INITIAL_TRIGGER_SIGNAL_ID]
          }]
        };
      })
    };
    const adapter = adapterWithClients(publicClient, walletClient);

    const result = await adapter.submitInitialTrigger({
      startId: "start_1",
      registrationId: "registration_1",
      orderId,
      sourceId: PRODUCT_INITIAL_TRIGGER_SOURCE_ID,
      signalId: PRODUCT_INITIAL_TRIGGER_SIGNAL_ID,
      stateMachineAddress,
      registrationTxHash,
      registrationBlockNumber: "11",
      payloadHash,
      idempotencyKey
    });

    expect(result).toMatchObject({
      status: "confirmed",
      txHash: startTxHash,
      blockNumber: "12",
      retryable: false
    });
    expect(walletClient.writeContract).toHaveBeenCalledTimes(2);
    expect(publicClient.waitForTransactionReceipt).toHaveBeenCalledWith({ hash: registrationTxHash });
    expect(publicClient.waitForTransactionReceipt).toHaveBeenCalledWith({ hash: startTxHash });
  });

  it("does not retry UnknownOrder when the registration tx does not prove the same order", async () => {
    const walletClient: ProductRegistrationWalletClient = {
      account: { address: registrarAddress },
      writeContract: vi.fn(async () => {
        throw unknownOrderError();
      })
    };
    const publicClient: ProductRegistrationPublicClient = {
      waitForTransactionReceipt: vi.fn(async () => ({
        status: "success",
        blockNumber: 11n,
        logs: [{
          address: stateMachineAddress,
          topics: [orderRegisteredTopic, otherOrderId, planId]
        }]
      }))
    };
    const adapter = adapterWithClients(publicClient, walletClient);

    const result = await adapter.submitInitialTrigger({
      startId: "start_1",
      registrationId: "registration_1",
      orderId,
      sourceId: PRODUCT_INITIAL_TRIGGER_SOURCE_ID,
      signalId: PRODUCT_INITIAL_TRIGGER_SIGNAL_ID,
      stateMachineAddress,
      registrationTxHash,
      registrationBlockNumber: "11",
      payloadHash,
      idempotencyKey
    });

    expect(result).toMatchObject({
      status: "failed",
      errorCode: "submit_initial_trigger_broadcast_failed",
      retryable: true
    });
    expect(walletClient.writeContract).toHaveBeenCalledTimes(1);
    expect(publicClient.waitForTransactionReceipt).toHaveBeenCalledWith({ hash: registrationTxHash });
  });
});

function adapterWithClients(
  publicClient: ProductRegistrationPublicClient,
  walletClient: ProductRegistrationWalletClient
): AnvilProductOrderRegistrationAdapter {
  return new AnvilProductOrderRegistrationAdapter({
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

function unknownOrderError(): Error {
  return new Error("The contract function \"submitSignal\" reverted with selector 0xb838de96");
}

function bytes32(value: string): Hex {
  return `0x${value.padStart(64, "0")}` as Hex;
}

function address(value: string): Address {
  return `0x${value.padStart(40, "0")}` as Address;
}
