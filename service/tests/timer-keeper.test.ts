import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeFunctionData } from "viem";
import { STATE_MACHINE_ABI } from "@uvp-eth/protocol-bindings";
import { TimerKeeperWorker } from "../src/timer-keeper/service.js";
import { createTimerKeeperWalletSubmitter } from "../src/timer-keeper/index.js";
import { TimerPokeReceiptRevertedError, type TimerKeeperSubmitter, type TimerPokeOutcome, type TimerPokeTarget } from "../src/timer-keeper/types.js";
import { createChainServicesStores, type ChainServicesStores } from "../src/storage/factory.js";
import { projectionScopeContractAddress, type ProjectionStore } from "../src/storage/projection-store.js";
import { createPostgresTestDatabase } from "./postgres.js";

let stores: ChainServicesStores;

beforeAll(async () => {
  stores = createChainServicesStores({
    database: { url: await createPostgresTestDatabase(), migrationsAutoRun: true },
    chainId: 31337
  });
});

afterAll(async () => {
  await stores.close();
});
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
    const poked: TimerPokeTarget[] = [];

    const future = new TimerKeeperWorker({
      config: keeperConfig(),
      projectionStore: await freshStore(baseEvents(), 4n),
      stateMachineAddress: contractAddress,
      chainId,
      submitter: recordingSubmitter(poked),
      now: () => new Date(1_699_999_500_000),
      chainClock: chainClockAt(() => 1_699_999_500)
    });
    expect(await future.runOnce()).toMatchObject({ pokeCandidates: 0, submitted: 0 });
    expect(poked).toEqual([]);

    const due = new TimerKeeperWorker({
      config: keeperConfig(),
      projectionStore: await freshStore(baseEvents(), 4n),
      stateMachineAddress: contractAddress,
      chainId,
      submitter: recordingSubmitter(poked),
      now: () => new Date(1_700_001_000_000),
      chainClock: chainClockAt(() => 1_700_001_000)
    });
    expect(await due.runOnce()).toMatchObject({ pokeCandidates: 1, submitted: 1 });
    expect(poked).toEqual([
      { planId, orderId, hookId: timerHookId, gas: 500_000n }
    ]);

    const unfinalized = new TimerKeeperWorker({
      config: keeperConfig(),
      projectionStore: await freshStore(baseEvents(), 2n),
      stateMachineAddress: contractAddress,
      chainId,
      submitter: recordingSubmitter(poked),
      now: () => new Date(1_700_001_000_000),
      chainClock: chainClockAt(() => 1_700_001_000)
    });
    expect(await unfinalized.runOnce()).toMatchObject({ pokeCandidates: 0, submitted: 0 });
  });

  it("converges once the projection reflects the poke outcome", async () => {
    let nowMs = 1_700_001_000_000;
    const store = await freshStore(baseEvents(), 4n);
    const poked: TimerPokeTarget[] = [];
    const worker = new TimerKeeperWorker({
      config: keeperConfig(),
      projectionStore: store,
      stateMachineAddress: contractAddress,
      chainId,
      submitter: recordingSubmitter(poked),
      now: () => new Date(nowMs),
      chainClock: chainClockAt(() => Math.floor(nowMs / 1000))
    });

    expect(await worker.runOnce()).toMatchObject({ pokeCandidates: 1, submitted: 1 });

    nowMs += 10_000;
    expect(await worker.runOnce()).toMatchObject({ pokeCandidates: 1, submitted: 0, deduplicated: 1 });

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
      now: () => new Date(nowMs),
      chainClock: chainClockAt(() => Math.floor(nowMs / 1000))
    });

    const first = await worker.runOnce();
    expect(first).toMatchObject({ pokeCandidates: 1, attempted: 1, submitted: 0, deduplicated: 0 });
    expect(first.converged[0]).toMatch(/TimerNotDue/);
    expect(first.skipped).toEqual([]);

    nowMs += 10_000;
    expect(await worker.runOnce()).toMatchObject({ submitted: 0, deduplicated: 1 });
    expect(attempts).toBe(1);
    expect(logger.errors).toEqual([]);
  });

  it("treats a simulate-time TimerNotWaiting revert as convergence, not failure", async () => {
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
      now: () => new Date(1_700_001_000_000),
      chainClock: chainClockAt(() => 1_700_001_000)
    });

    const first = await worker.runOnce();
    expect(first).toMatchObject({ pokeCandidates: 1, attempted: 1, submitted: 0 });
    expect(first.converged[0]).toMatch(/TimerNotWaiting/);
    expect(first.skipped).toEqual([]);
    expect(logger.errors).toEqual([]);
    expect(attempts).toBe(1);
  });

  it("escalates a hook that keeps failing after consecutive redelivery windows", async () => {
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
          return confirmedOutcome();
        }
      },
      logger,
      now: () => new Date(nowMs),
      chainClock: chainClockAt(() => Math.floor(nowMs / 1000))
    });

    await worker.runOnce();
    nowMs += 130_000;
    await worker.runOnce();
    expect(logger.errors).toEqual([]);

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
      now: () => new Date(1_700_001_000_000),
      chainClock: chainClockAt(() => 1_700_001_000)
    });

    const summary = await worker.runOnce();
    expect(summary).toMatchObject({ pokeCandidates: 2, attempted: 1, submitted: 0 });
    expect(summary.skipped.length).toBe(1);
    expect(attempts).toBe(1);
  });

  it("releases no candidate while a manual projection rebuild is in progress", async () => {
    const store = await freshStore(baseEvents(), 4n);
    await store.saveSyncState({ ...syncState(4n), syncStatus: "rebuilding" });
    const poked: TimerPokeTarget[] = [];
    const worker = new TimerKeeperWorker({
      config: keeperConfig(),
      projectionStore: store,
      stateMachineAddress: contractAddress,
      chainId,
      submitter: recordingSubmitter(poked),
      now: () => new Date(1_700_001_000_000),
      chainClock: chainClockAt(() => 1_700_001_000)
    });

    const summary = await worker.runOnce();
    expect(summary).toMatchObject({ pokeCandidates: 0, attempted: 0, submitted: 0 });
    expect(summary.skipped[0]).toMatch(/rebuild is in progress/);
    expect(poked).toEqual([]);
  });

  it("stays idle when disabled or unwired", async () => {
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
        },
        waitForTransactionReceipt: async () => ({ status: "success" as const, blockNumber: 4n })
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

    const outcome = await submitter.pokeTimer({
      planId,
      orderId,
      hookId: timerHookId,
      gas: 500_000n
    });
    expect(outcome).toEqual({ txHash: "0x" + "ab".repeat(32), receipt: "confirmed" });
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
    expect(sent[0]!.gas).toBe(144_000n);

    await expect(
      submitter.pokeTimer({ planId, orderId, hookId: timerHookId, gas: 100_000n })
    ).rejects.toThrow(/broadcast gas limit 144000 exceeds the timer keeper gas cap 100000/);
    expect(sent).toHaveLength(1);
  });

  it("classifies a reverted receipt as a keeper failure and an unreadable receipt as unknown", async () => {
    const keeperAddress = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Address;
    const baseClient = {
      account: { address: keeperAddress },
      sendTransaction: async () => "0x" + "ab".repeat(32) as Hex
    };
    const simulationClient = {
      simulateContract: async () => ({}),
      estimateGas: async () => 120_000n
    };
    const reverted = createTimerKeeperWalletSubmitter({
      stateMachineAddress: contractAddress,
      chainId,
      rpcUrl: "http://127.0.0.1:8545",
      walletClient: {
        ...baseClient,
        waitForTransactionReceipt: async () => ({ status: "reverted" as const, blockNumber: 4n })
      },
      simulationClient
    });
    await expect(reverted.pokeTimer({ planId, orderId, hookId: timerHookId })).rejects.toBeInstanceOf(
      TimerPokeReceiptRevertedError
    );

    const timedOut = createTimerKeeperWalletSubmitter({
      stateMachineAddress: contractAddress,
      chainId,
      rpcUrl: "http://127.0.0.1:8545",
      walletClient: {
        ...baseClient,
        waitForTransactionReceipt: async () => {
          throw new Error("Transaction reception timed out after 60,000 milliseconds");
        }
      },
      simulationClient
    });
    await expect(timedOut.pokeTimer({ planId, orderId, hookId: timerHookId })).resolves.toEqual({
      txHash: "0x" + "ab".repeat(32),
      receipt: "unknown"
    });

    const unreadable = createTimerKeeperWalletSubmitter({
      stateMachineAddress: contractAddress,
      chainId,
      rpcUrl: "http://127.0.0.1:8545",
      walletClient: {
        ...baseClient,
        waitForTransactionReceipt: async () => undefined
      },
      simulationClient
    });
    await expect(unreadable.pokeTimer({ planId, orderId, hookId: timerHookId })).resolves.toEqual({
      txHash: "0x" + "ab".repeat(32),
      receipt: "unknown"
    });
  });

  it("counts receipt-reverted pokes into the failure escalation lane and receipt-unknown pokes as submitted", async () => {
    let nowMs = 1_700_001_000_000;
    const logger = new RecordingLogger();
    const revertedWorker = new TimerKeeperWorker({
      config: keeperConfig(),
      projectionStore: await freshStore(baseEvents(), 4n),
      stateMachineAddress: contractAddress,
      chainId,
      submitter: {
        pokeTimer: async () => {
          throw new TimerPokeReceiptRevertedError(
            "timer poke transaction 0x" + "ab".repeat(31) + " was mined but reverted on chain"
          );
        }
      },
      logger,
      now: () => new Date(nowMs),
      chainClock: chainClockAt(() => Math.floor(nowMs / 1000))
    });
    const first = await revertedWorker.runOnce();
    expect(first).toMatchObject({ attempted: 1, submitted: 0, receiptReverted: 1, receiptUnknown: 0 });
    expect(first.converged).toEqual([]);
    expect(first.skipped.length).toBe(1);
    nowMs += 130_000;
    await revertedWorker.runOnce();
    nowMs += 130_000;
    const third = await revertedWorker.runOnce();
    expect(third.receiptReverted).toBe(1);
    expect(logger.errors).toHaveLength(1);
    expect(logger.errors[0]!.message).toMatch(/3 consecutive redelivery windows/);

    const unknownWorker = new TimerKeeperWorker({
      config: keeperConfig(),
      projectionStore: await freshStore(baseEvents(), 4n),
      stateMachineAddress: contractAddress,
      chainId,
      submitter: {
        pokeTimer: async () => ({ txHash: "0x" + "ab".repeat(32) as Hex, receipt: "unknown" })
      },
      logger,
      now: () => new Date(nowMs),
      chainClock: chainClockAt(() => Math.floor(nowMs / 1000))
    });
    const unknown = await unknownWorker.runOnce();
    expect(unknown).toMatchObject({ attempted: 1, submitted: 1, receiptUnknown: 1, receiptReverted: 0 });
    expect(unknown.skipped).toEqual([]);
    expect(unknown.converged).toEqual([]);

    nowMs += 130_000;
    await unknownWorker.runOnce();
    expect(logger.errors).toHaveLength(1);
    nowMs += 130_000;
    const thirdUnknown = await unknownWorker.runOnce();
    expect(thirdUnknown.receiptUnknown).toBe(1);
    expect(logger.errors).toHaveLength(2);
    expect(logger.errors[1]!.message).toMatch(/stayed unreadable for 3 consecutive redelivery windows/);
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

function chainClockAt(seconds: () => number) {
  return { latestBlockTimestampSeconds: async (): Promise<number> => seconds() };
}

function recordingSubmitter(poked: TimerPokeTarget[]): TimerKeeperSubmitter {
  return {
    pokeTimer: async (target) => {
      poked.push(target);
      return confirmedOutcome();
    }
  };
}

function confirmedOutcome(): TimerPokeOutcome {
  return { txHash: "0x" + "ab".repeat(32) as Hex, receipt: "confirmed" };
}

async function freshStore(events: readonly ChainEvent[], finalizedBlock: bigint): Promise<ProjectionStore> {
  const store = stores.projectionStore;
  await store.resetFromEvents({ deploymentBlock: 0n, events });
  await store.saveSyncState(syncState(finalizedBlock));
  return store;
}

function syncState(finalizedBlock: bigint) {
  return {
    chainId,
    contractAddress: projectionScopeContractAddress,
    syncStatus: "indexed" as const,
    latestIndexedBlock: finalizedBlock,
    finalizedBlock,
    confirmationDepth: 1,
    eventCount: 5,
    rebuild: { status: "completed" as const }
  };
}

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
