import { createPublicClient, createWalletClient, encodeFunctionData, http, type Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { STATE_MACHINE_ABI } from "@uvp-eth/protocol-bindings";
import { normalizeAddress, type Address, type Hex } from "../shared/types.js";
import {
  chainFor,
  loadRelayerPrivateKey,
  requiredRpcUrl
} from "../shared/broadcast/kit.js";
import type { TimerKeeperSubmitter } from "./types.js";

const TIMER_KEEPER_BROADCAST_LABEL = "timer keeper poke";

/** 写面滤 ABI：pokeTimer 取自 protocol-bindings 单源（STATE_MACHINE_ABI）
 * ——先放宽为泛型 Abi 再切片，直接在整表字面量类型上做 filter/
 * encodeFunctionData 参数推导会让 viem 的巨型条件类型爆栈（TS2589），
 * 与 dock-automation/service.ts 的写面切片同口径。 */
const timerWriteAbi: Abi = (STATE_MACHINE_ABI as Abi).filter(
  (entry) => entry.type === "function" && entry.name === "pokeTimer"
);

/**
 * 预演读面端口：simulateContract 把链上必拒的 poke 在广播前以携
 * errorName 的 ContractFunctionExecutionError 抛出（ABI 内已知自定义错误
 * 自动解码），estimateGas 提供模拟 gas 供上限比较。测试注入最小 fake。
 */
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

/**
 * pokeTimer 的 wallet-client 写面：relayer 代付面（链上时钟拨表，非业务
 * 签名面）。广播前先经 simulateContract 预演——raw 广播不等回执，链上会
 * revert 的 poke 会被节点接受并以 txHash 正常 resolve，收敛判定
 * （TimerNotWaiting/TimerNotDue）与连续失败升级将永远不触发；预演把
 * revert 抛成携 errorName 的错误交由 worker 分类。广播后仍不等回执——
 * 最终性窗口去重由 worker 承担，投影呈现 poke 后状态即收敛。
 */
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
  const walletClient: TimerKeeperWalletClient = options.walletClient ??
    (createWalletClient({
      account,
      chain,
      transport: http(rpcUrl)
    }) as unknown as TimerKeeperWalletClient);
  const simulationClient: TimerKeeperSimulationClient = options.simulationClient ??
    (createPublicClient({
      chain,
      transport: http(rpcUrl)
    }) as unknown as TimerKeeperSimulationClient);
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
      // gas 上限语义保留：模拟 gas 超过 keeper 上限即拒发（不广播注定
      // out-of-gas / 异常昂贵的 poke）；未超则以模拟 gas 为 limit 广播。
      if (target.gas !== undefined && simulatedGas > target.gas) {
        throw new Error(
          `pokeTimer simulated gas ${simulatedGas} exceeds the timer keeper gas cap ${target.gas}`
        );
      }
      return walletClient.sendTransaction({
        to: stateMachineAddress,
        data,
        gas: simulatedGas
      });
    }
  };
}
