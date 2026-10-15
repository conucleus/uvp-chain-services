import { describe, expect, it } from "vitest";
import { decodeFunctionData } from "viem";
import { STATE_MACHINE_ABI } from "@uvp-eth/protocol-bindings";
import { TimerKeeperWorker } from "../src/timer-keeper/service.js";
import { createTimerKeeperWalletSubmitter } from "../src/timer-keeper/index.js";
import type { TimerKeeperSubmitter, TimerPokeTarget } from "../src/timer-keeper/types.js";
import { MemoryProjectionStore } from "../src/storage/projection-store.js";
import type { ChainEvent } from "../src/indexer/events.js";
import type { Address, Hex } from "../src/shared/types.js";

const contractAddress = "0x1111111111111111111111111111111111111111" as Address;
const chainId = 31337;
const planId = bytes32Hex("0101");
const orderId = bytes32Hex("0202");
const timerHookId = bytes32Hex("0303");
const readyHookId = bytes32Hex("0e0e");
const payloadHash = bytes32Hex("0b0b");

describe("timer keeper", () => {

  it("selects only finalized waiting hooks whose dueAt has passed", async () => {
    // 候选筛选语义：status!=waiting 不选、dueAt 未到不选、最近状态变更
    // 未最终（hook.updatedAt.blockNumber > finalizedBlock）不选——不对
    // 未最终区块抢跑。
    const poked: TimerPokeTarget[] = [];

    // dueAt 在未来（now=1_699_999_500s < dueAt=1_700_000_000s）：不选。
    const future = new TimerKeeperWorker({
      config: keeperConfig(),
      projectionStore: await freshStore(baseEvents(), 4n),
      stateMachineAddress: contractAddress,
      chainId,
      submitter: recordingSubmitter(poked),
      now: () => new Date(1_699_999_500_000)
    });
    expect(await future.runOnce()).toMatchObject({ pokeCandidates: 0, submitted: 0 });
    expect(poked).toEqual([]);

    // 到期（now=1_700_001_000s）：唯一 waiting+due 且已最终的 hook 成
    // 候选；ready 态对照 hook 不选。
    const due = new TimerKeeperWorker({
      config: keeperConfig(),
      projectionStore: await freshStore(baseEvents(), 4n),
      stateMachineAddress: contractAddress,
      chainId,
      submitter: recordingSubmitter(poked),
      now: () => new Date(1_700_001_000_000)
    });
    expect(await due.runOnce()).toMatchObject({ pokeCandidates: 1, submitted: 1 });
    expect(poked).toEqual([
      { planId, orderId, hookId: timerHookId, gas: 500_000n }
    ]);

    // 状态变更未最终（blockNumber=3 > finalizedBlock=2）：不抢跑。
    const unfinalized = new TimerKeeperWorker({
      config: keeperConfig(),
      projectionStore: await freshStore(baseEvents(), 2n),
      stateMachineAddress: contractAddress,
      chainId,
      submitter: recordingSubmitter(poked),
      now: () => new Date(1_700_001_000_000)
    });
    expect(await unfinalized.runOnce()).toMatchObject({ pokeCandidates: 0, submitted: 0 });
  });

  it("converges once the projection reflects the poke outcome", async () => {
    // poke 成功后移除候选：窗口内去重，投影呈现新状态（不再 waiting）
    // 后候选归零——不是每轮重发。
    let nowMs = 1_700_001_000_000;
    const store = await freshStore(baseEvents(), 4n);
    const poked: TimerPokeTarget[] = [];
    const worker = new TimerKeeperWorker({
      config: keeperConfig(),
      projectionStore: store,
      stateMachineAddress: contractAddress,
      chainId,
      submitter: recordingSubmitter(poked),
      now: () => new Date(nowMs)
    });

    expect(await worker.runOnce()).toMatchObject({ pokeCandidates: 1, submitted: 1 });

    // 窗口内：投影仍 waiting+due，去重跳过。
    nowMs += 10_000;
    expect(await worker.runOnce()).toMatchObject({ pokeCandidates: 1, submitted: 0, deduplicated: 1 });

    // 投影呈现 poke 后状态（HookStatusChanged → ready）：候选归零。
    await store.resetFromEvents({
      deploymentBlock: 0n,
      events: [
        ...baseEvents(),
        chainEvent(5n, 0, "HookStatusChanged", {
          orderId,
          planId,
          hookId: timerHookId,
          previousStatus: 1,
          newStatus: 2,
          dueAt: 0n
        })
      ]
    });
    await store.saveSyncState(syncState(5n));
    nowMs += 120_000;
    expect(await worker.runOnce()).toMatchObject({ pokeCandidates: 0, submitted: 0, deduplicated: 0 });
    expect(poked).toHaveLength(1);
  });

  it("treats TimerNotDue as convergence, not failure", async () => {
    // 到期秒边界：链上守门仍判未到期（pokedAt < dueAt）revert
    // TimerNotDue——按收敛处理：移出本轮候选、不计失败、不升级告警；
    // 窗口照常占窗限速（投影 lag 期内逐轮重发是纯 gas 浪费）。
    let nowMs = 1_700_001_000_000;
    const logger = new RecordingLogger();
    let attempts = 0;
    const worker = new TimerKeeperWorker({
      config: keeperConfig(),
      projectionStore: await freshStore(baseEvents(), 4n),
      stateMachineAddress: contractAddress,
      chainId,
      submitter: {
        pokeTimer: async () => {
          attempts += 1;
          throw new Error("reverted: TimerNotDue(planId, orderId, hookId)");
        }
      },
      logger,
      now: () => new Date(nowMs)
    });

    const first = await worker.runOnce();
    expect(first).toMatchObject({ pokeCandidates: 1, attempted: 1, submitted: 0, deduplicated: 0 });
    expect(first.converged[0]).toMatch(/TimerNotDue/);
    expect(first.skipped).toEqual([]);

    // 窗口内不再重试（收敛同样占窗）；连续窗口也不升级 error。
    nowMs += 10_000;
    expect(await worker.runOnce()).toMatchObject({ submitted: 0, deduplicated: 1 });
    expect(attempts).toBe(1);
    expect(logger.errors).toEqual([]);
  });

  it("treats a simulate-time TimerNotWaiting revert as convergence, not failure", async () => {
    // 写面先经 simulateContract 预演：链上必拒的 poke 以携 errorName 的
    // 合约执行错误抛回（已知自定义错误自动解码）——errorName 判定收敛，
    // 不计失败、不升级告警。
    const logger = new RecordingLogger();
    let attempts = 0;
    const worker = new TimerKeeperWorker({
      config: keeperConfig(),
      projectionStore: await freshStore(baseEvents(), 4n),
      stateMachineAddress: contractAddress,
      chainId,
      submitter: {
        pokeTimer: async () => {
          attempts += 1;
          const error = new Error("The contract function 'pokeTimer' reverted.");
          Object.assign(error, { errorName: "TimerNotWaiting" });
          throw error;
        }
      },
      logger,
      now: () => new Date(1_700_001_000_000)
    });

    const first = await worker.runOnce();
    expect(first).toMatchObject({ pokeCandidates: 1, attempted: 1, submitted: 0 });
    expect(first.converged[0]).toMatch(/TimerNotWaiting/);
    expect(first.skipped).toEqual([]);
    expect(logger.errors).toEqual([]);
    expect(attempts).toBe(1);
  });

  it("escalates a hook that keeps failing after consecutive redelivery windows", async () => {
    // 预演让链上会 revert 的 poke 在广播前失败：非收敛失败记逐 hook 连续
    // 失败窗口，连续 3 个窗口仍失败即升级 error 级告警（带 hook 身份与
    // 窗口数）；广播成功清零后从头数起。
    let nowMs = 1_700_001_000_000;
    const logger = new RecordingLogger();
    let fail = true;
    const worker = new TimerKeeperWorker({
      config: keeperConfig(),
      projectionStore: await freshStore(baseEvents(), 4n),
      stateMachineAddress: contractAddress,
      chainId,
      submitter: {
        pokeTimer: async () => {
          if (fail) {
            throw new Error("broadcast failed: keeper gas role unavailable");
          }
          return "0x" + "ab".repeat(32) as Hex;
        }
      },
      logger,
      now: () => new Date(nowMs)
    });

    // 前两个窗口：只有 skipped 留痕，无 error。
    await worker.runOnce();
    nowMs += 130_000;
    await worker.runOnce();
    expect(logger.errors).toEqual([]);

    // 第三个连续窗口：升级 error，带 hook 身份与窗口数。
    nowMs += 130_000;
    const third = await worker.runOnce();
    expect(third.skipped.length).toBe(1);
    expect(logger.errors).toHaveLength(1);
    expect(logger.errors[0]!.message).toMatch(/3 consecutive redelivery windows/);
    expect(logger.errors[0]!.context).toMatchObject({
      planId,
      orderId,
      hookId: timerHookId,
      windows: 3
    });

    // 广播成功：计数清零，后续连续失败从头数起。
    fail = false;
    nowMs += 130_000;
    await worker.runOnce();
    fail = true;
    nowMs += 130_000;
    await worker.runOnce();
    nowMs += 130_000;
    await worker.runOnce();
    expect(logger.errors).toHaveLength(1);
    nowMs += 130_000;
    await worker.runOnce();
    expect(logger.errors).toHaveLength(2);
    expect(logger.errors[1]!.context).toMatchObject({ windows: 3 });
  });

  it("bounds attempts, not successes, when every poke fails", async () => {
    // maxCandidatesPerRun 对 attempted（去重窗口放行后的实际尝试数）封顶：
    // 全失败轮不会扫穿全部候选——第二个 hook 留待下一轮。
    const secondOrderId = bytes32Hex("0203");
    const secondHookId = bytes32Hex("0304");
    const store = await freshStore([
      ...baseEvents(),
      chainEvent(5n, 0, "OrderRegistered", { orderId: secondOrderId, planId }),
      chainEvent(6n, 0, "HookStatusChanged", {
        orderId: secondOrderId,
        planId,
        hookId: secondHookId,
        previousStatus: 0,
        newStatus: 1,
        dueAt: 1_700_000_000n
      })
    ], 6n);
    let attempts = 0;
    const worker = new TimerKeeperWorker({
      config: { ...keeperConfig(), maxCandidatesPerRun: 1 },
      projectionStore: store,
      stateMachineAddress: contractAddress,
      chainId,
      submitter: {
        pokeTimer: async () => {
          attempts += 1;
          throw new Error("broadcast failed: keeper gas role unavailable");
        }
      },
      now: () => new Date(1_700_001_000_000)
    });

    const summary = await worker.runOnce();
    expect(summary).toMatchObject({ pokeCandidates: 2, attempted: 1, submitted: 0 });
    expect(summary.skipped.length).toBe(1);
    expect(attempts).toBe(1);
  });

  it("releases no candidate while a manual projection rebuild is in progress", async () => {
    // syncStatus=rebuilding：投影是半重建的中间态，整轮 fail-closed 不放行
    // 任何候选（finalizedBlock 存在也不放行）。
    const store = await freshStore(baseEvents(), 4n);
    await store.saveSyncState({ ...syncState(4n), syncStatus: "rebuilding" });
    const poked: TimerPokeTarget[] = [];
    const worker = new TimerKeeperWorker({
      config: keeperConfig(),
      projectionStore: store,
      stateMachineAddress: contractAddress,
      chainId,
      submitter: recordingSubmitter(poked),
      now: () => new Date(1_700_001_000_000)
    });

    const summary = await worker.runOnce();
    expect(summary).toMatchObject({ pokeCandidates: 0, attempted: 0, submitted: 0 });
    expect(summary.skipped[0]).toMatch(/rebuild is in progress/);
    expect(poked).toEqual([]);
  });

  it("stays idle when disabled or unwired", async () => {
    // 禁用即不启动：无轮询、无 summary；enabled 但无 submitter 同为
    // idle 并响亮告警。
    const infos: string[] = [];
    const warnings: string[] = [];
    const logger = {
      warn: (message: string) => warnings.push(message),
      info: (message: string) => infos.push(message),
      debug: () => undefined,
      error: () => undefined
    };
    const disabled = new TimerKeeperWorker({
      config: { ...keeperConfig(), enabled: false },
      projectionStore: await freshStore(baseEvents(), 4n),
      stateMachineAddress: contractAddress,
      chainId,
      submitter: recordingSubmitter([]),
      logger
    });
    await disabled.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(infos).toEqual([]);
    expect(disabled.getLastSummary()).toBeUndefined();

    const unwired = new TimerKeeperWorker({
      config: keeperConfig(),
      projectionStore: await freshStore(baseEvents(), 4n),
      stateMachineAddress: contractAddress,
      chainId,
      logger
    });
    await unwired.start();
    expect(warnings.some((message) => message.includes("no submitter"))).toBe(true);
    expect(infos).toEqual([]);
  });

  it("pins pokeTimer calldata, simulation args, and the gas cap on the wallet submitter", async () => {
    // 写面形状：广播前先 simulateContract 预演（同一 address/abi/args/
    // account），estimateGas 取模拟 gas 与上限比较，通过后以模拟 gas 为
    // limit 广播预演产出的 to/data；selector 与参数布局由
    // STATE_MACHINE_ABI 单源钉死。
    const keeperAddress = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Address;
    const sent: Array<{ readonly to: Address; readonly data: Hex; readonly gas?: bigint }> = [];
    const simulations: Array<Record<string, unknown>> = [];
    const estimates: Array<Record<string, unknown>> = [];
    const submitter = createTimerKeeperWalletSubmitter({
      stateMachineAddress: contractAddress,
      chainId,
      rpcUrl: "http://127.0.0.1:8545",
      walletClient: {
        account: { address: keeperAddress },
        sendTransaction: async (args) => {
          sent.push(args);
          return "0x" + "ab".repeat(32) as Hex;
        }
      },
      simulationClient: {
        simulateContract: async (input) => {
          simulations.push(input as unknown as Record<string, unknown>);
          return {};
        },
        estimateGas: async (input) => {
          estimates.push(input as unknown as Record<string, unknown>);
          return 120_000n;
        }
      }
    });

    const txHash = await submitter.pokeTimer({
      planId,
      orderId,
      hookId: timerHookId,
      gas: 500_000n
    });
    expect(txHash).toBe("0x" + "ab".repeat(32));
    expect(simulations).toEqual([
      {
        address: contractAddress,
        abi: expect.anything(),
        functionName: "pokeTimer",
        args: [planId, orderId, timerHookId],
        account: keeperAddress
      }
    ]);
    expect(estimates).toEqual([
      { to: contractAddress, data: expect.any(String), account: keeperAddress }
    ]);
    const decoded = decodeFunctionData({ abi: STATE_MACHINE_ABI, data: sent[0]!.data });
    expect(decoded.functionName).toBe("pokeTimer");
    expect(decoded.args).toEqual([planId, orderId, timerHookId]);
    expect(sent[0]!.to).toBe(contractAddress);
    expect(sent[0]!.gas).toBe(120_000n);

    // 模拟 gas 超过 keeper 上限：拒发（不进入广播面）。
    await expect(
      submitter.pokeTimer({ planId, orderId, hookId: timerHookId, gas: 100_000n })
    ).rejects.toThrow(/simulated gas 120000 exceeds the timer keeper gas cap 100000/);
    expect(sent).toHaveLength(1);
  });
});

function keeperConfig() {
  return {
    enabled: true,
    pollIntervalMs: 5_000,
    maxCandidatesPerRun: 4,
    maxGasPerTx: 500_000n,
    redeliveryWindowMs: 120_000,
    privateKeyEnv: "UVP_TIMER_KEEPER_PRIVATE_KEY"
  };
}

function recordingSubmitter(poked: TimerPokeTarget[]): TimerKeeperSubmitter {
  return {
    pokeTimer: async (target) => {
      poked.push(target);
      return "0x" + "ab".repeat(32) as Hex;
    }
  };
}

async function freshStore(events: readonly ChainEvent[], finalizedBlock: bigint): Promise<MemoryProjectionStore> {
  const store = new MemoryProjectionStore();
  await store.resetFromEvents({ deploymentBlock: 0n, events });
  await store.saveSyncState(syncState(finalizedBlock));
  return store;
}

function syncState(finalizedBlock: bigint) {
  return {
    chainId,
    contractAddress: contractAddress,
    syncStatus: "indexed" as const,
    latestIndexedBlock: finalizedBlock,
    finalizedBlock,
    confirmationDepth: 1,
    eventCount: 5,
    rebuild: { status: "completed" as const }
  };
}

/** 基座事件：order 出生 + timer hook →waiting（dueAt=1_700_000_000s，
 * blockNumber=3）+ ready 态对照 hook。 */
function baseEvents(): readonly ChainEvent[] {
  return [
    chainEvent(1n, 0, "PlanRegistered", { planId, planHash: payloadHash, hookCount: 2n }),
    chainEvent(2n, 0, "OrderRegistered", { orderId, planId }),
    chainEvent(3n, 0, "HookStatusChanged", {
      orderId,
      planId,
      hookId: timerHookId,
      previousStatus: 0,
      newStatus: 1,
      dueAt: 1_700_000_000n
    }),
    chainEvent(4n, 0, "HookStatusChanged", {
      orderId,
      planId,
      hookId: readyHookId,
      previousStatus: 1,
      newStatus: 2,
      dueAt: 0n
    })
  ];
}

function chainEvent(
  blockNumber: bigint,
  logIndex: number,
  eventName: string,
  args: Record<string, unknown>,
  eventContractAddress: Hex = contractAddress
): ChainEvent {
  return {
    chainId,
    contractAddress: eventContractAddress,
    blockNumber,
    transactionHash: `0x${blockNumber.toString(16).padStart(64, "0")}` as Hex,
    logIndex,
    eventName,
    args
  };
}

function bytes32Hex(value: string): Hex {
  return `0x${value.padStart(64, "0")}` as Hex;
}

class RecordingLogger {
  readonly errors: Array<{ readonly message: string; readonly context?: Record<string, unknown> }> = [];

  error(message: string, context?: Record<string, unknown>): void {
    this.errors.push({ message, ...(context ? { context } : {}) });
  }

  warn(): void {
  }

  info(): void {
  }

  debug(): void {
  }
}
