import { createPublicClient, createWalletClient, encodeFunctionData, http, type Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { STATE_MACHINE_ABI } from "@uvp-eth/protocol-bindings";
import { normalizeAddress, type Address, type Hex } from "../shared/types.js";
import {
  chainFor,
  loadRelayerPrivateKey,
  requiredRpcUrl
} from "../shared/broadcast/kit.js";
import { TimerPokeReceiptRevertedError, type TimerKeeperSubmitter } from "./types.js";

const TIMER_KEEPER_BROADCAST_LABEL = "timer keeper poke";
const GAS_BUFFER_NUMERATOR = 12n;
const GAS_BUFFER_DENOMINATOR = 10n;
const RECEIPT_WAIT_TIMEOUT_MS = 60_000;

const timerWriteAbi: Abi = (STATE_MACHINE_ABI as Abi).filter(
  (entry) => entry.type === "function" && entry.name === "pokeTimer"
);

export interface TimerKeeperSimulationClient {
  simulateContract(input: {
    readonly address: Address;
    readonly abi: Abi;
    readonly functionName: "pokeTimer";
    readonly args: readonly [Hex, Hex, Hex];
    readonly account?: Address;
  }): Promise<unknown>;
  estimateGas(input: {
    readonly to: Address;
    readonly data: Hex;
    readonly account?: Address;
  }): Promise<bigint>;
}

export interface TimerKeeperWalletClient {
  readonly account?: { readonly address?: string };
  sendTransaction(args: {
    readonly to: Address;
    readonly data: Hex;
    readonly gas?: bigint;
  }): Promise<Hex>;
  waitForTransactionReceipt(args: {
    readonly hash: Hex;
    readonly timeout?: number;
  }): Promise<{
    readonly status?: "success" | "reverted" | string;
    readonly blockNumber?: bigint;
  } | undefined>;
}

export interface TimerKeeperWalletSubmitterOptions {
  readonly stateMachineAddress: Address;
  readonly chainId: number;
  readonly rpcUrl?: string;
  readonly privateKey?: Hex;
  readonly privateKeyEnv?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly walletClient?: TimerKeeperWalletClient;
  readonly simulationClient?: TimerKeeperSimulationClient;
}

export function createTimerKeeperWalletSubmitter(
  options: TimerKeeperWalletSubmitterOptions
): TimerKeeperSubmitter {
  const stateMachineAddress = normalizeAddress(options.stateMachineAddress, "stateMachineAddress");
  const rpcUrl = requiredRpcUrl(options.rpcUrl, TIMER_KEEPER_BROADCAST_LABEL);
  const chain = chainFor(options.chainId, rpcUrl);
  const account = options.walletClient
    ? undefined
    : privateKeyToAccount(
      loadRelayerPrivateKey(
        {
          ...(options.privateKey ? { relayerPrivateKey: options.privateKey } : {}),
          ...(options.privateKeyEnv ? { relayerPrivateKeyEnv: options.privateKeyEnv } : {}),
          ...(options.env ? { env: options.env } : {})
        },
        TIMER_KEEPER_BROADCAST_LABEL
      )
    );
  const accountAddress: Address | undefined = account?.address ??
    (options.walletClient?.account?.address as Address | undefined);
  const viemPublicClient = createPublicClient({
    chain,
    transport: http(rpcUrl)
  });
  const viemWalletClient = createWalletClient({
    account,
    chain,
    transport: http(rpcUrl)
  });
  const walletClient: TimerKeeperWalletClient = options.walletClient ?? ({
    ...(account ? { account: { address: account.address } } : {}),
    sendTransaction: (args: Parameters<TimerKeeperWalletClient["sendTransaction"]>[0]) =>
      viemWalletClient.sendTransaction(
        args as Parameters<typeof viemWalletClient.sendTransaction>[0]
      ),
    waitForTransactionReceipt: (args: Parameters<TimerKeeperWalletClient["waitForTransactionReceipt"]>[0]) =>
      viemPublicClient.waitForTransactionReceipt(args)
  } as unknown as TimerKeeperWalletClient);
  const simulationClient: TimerKeeperSimulationClient = options.simulationClient ??
    (viemPublicClient as unknown as TimerKeeperSimulationClient);
  return {
    async pokeTimer(target) {
      const data = encodeFunctionData({
        abi: timerWriteAbi,
        functionName: "pokeTimer",
        args: [target.planId, target.orderId, target.hookId]
      });
      await simulationClient.simulateContract({
        address: stateMachineAddress,
        abi: timerWriteAbi,
        functionName: "pokeTimer",
        args: [target.planId, target.orderId, target.hookId],
        ...(accountAddress ? { account: accountAddress } : {})
      });
      const simulatedGas = await simulationClient.estimateGas({
        to: stateMachineAddress,
        data,
        ...(accountAddress ? { account: accountAddress } : {})
      });
      const broadcastGas = simulatedGas * GAS_BUFFER_NUMERATOR / GAS_BUFFER_DENOMINATOR;
      if (target.gas !== undefined && broadcastGas > target.gas) {
        throw new Error(
          `pokeTimer broadcast gas limit ${broadcastGas} exceeds the timer keeper gas cap ${target.gas}`
        );
      }
      const txHash = await walletClient.sendTransaction({
        to: stateMachineAddress,
        data,
        gas: broadcastGas
      });
      try {
        const receipt = await walletClient.waitForTransactionReceipt({
          hash: txHash,
          timeout: RECEIPT_WAIT_TIMEOUT_MS
        });
        if (receipt?.status === "reverted" || receipt?.status === "failed") {
          throw new TimerPokeReceiptRevertedError(
            `timer poke transaction ${txHash} was mined but reverted on chain`
          );
        }
        return receipt?.status === "success"
          ? { txHash, receipt: "confirmed" }
          : { txHash, receipt: "unknown" };
      } catch (error) {
        if (error instanceof TimerPokeReceiptRevertedError) {
          throw error;
        }
        return { txHash, receipt: "unknown" };
      }
    }
  };
}
