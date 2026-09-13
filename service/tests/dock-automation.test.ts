import { describe, expect, it } from "vitest";
import { DockAutomationWorker } from "../src/dock-automation/service.js";
import type { DockRouteRecord } from "../src/dock-automation/types.js";
import { MemoryProjectionStore } from "../src/storage/projection-store.js";
import type { ChainEvent } from "../src/indexer/events.js";
import type { Hex } from "../src/shared/types.js";

const contractAddress = "0x1111111111111111111111111111111111111111" as Hex;
const dockingModuleAddress = "0x6666666666666666666666666666666666666666" as Hex;
const signer = "0x4444444444444444444444444444444444444444" as Hex;
const chainId = 31337;
const planId = bytes32Hex("0101");
const planHash = bytes32Hex("0a0a");
const orderId = bytes32Hex("0202");
const hookId = bytes32Hex("0303");
const amendHookId = bytes32Hex("0808");
const linkedOrderId = bytes32Hex("0303");
const targetPlanId = bytes32Hex("0404");
const routeId = bytes32Hex("0505");
const dockInstanceId = bytes32Hex("0900");
const entranceBindingHash = bytes32Hex("0606");
const amendBindingHash = bytes32Hex("0707");
const payloadHash = bytes32Hex("0b0b");
const signalId = bytes32Hex("0505");
const sourceId = bytes32Hex("0404");
const interfaceNameId = bytes32Text("production_service");

describe("dock liveness keeper", () => {

  it("stays idle with a loud warning when enabled but no route source/submitter is wired", async () => {
    // 交付形态未装配 routeSource/submitter——enabled 时不得空转
    // 轮询并宣称 started。
    const warnings: string[] = [];
    const infos: string[] = [];
    const logger = {
      warn: (message: string) => warnings.push(message),
      info: (message: string) => infos.push(message),
      debug: () => undefined,
      error: () => undefined
    };
    const worker = new DockAutomationWorker({
      config: { enabled: true, pollIntervalMs: 5, redeliveryWindowMs: 60_000, maxCandidatesPerRun: 5 },
      projectionStore: new MemoryProjectionStore(),
      dockingAddress: "0x6666666666666666666666666666666666666666",
      chainId: 31337,
      logger
    });

    await worker.start();
    expect(warnings.some((message) => message.includes("no route source/submitter"))).toBe(true);
    expect(infos).toEqual([]);
    // 未启动轮询：等待一个以上轮询周期后仍是 idle。
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(worker.getLastSummary()).toBeUndefined();
  });
  it("does not re-broadcast the same binding inside the finality window and retries after it", async () => {
    // 最终性窗口内同一 binding 每轮（默认 5s）重复广播 no-op
    // 交易是纯 gas 浪费。窗口内去重跳过（计数 deduplicated）；窗口过后
    // 投影仍未呈现 delivery 才重试（覆盖交易丢失）。
    const store = new MemoryProjectionStore();
    await store.resetFromEvents({ deploymentBlock: 0n, events: dockEvents() });

    let nowMs = 1_000_000;
    const submitted: string[] = [];
    const worker = new DockAutomationWorker({
      config: {
        enabled: true,
        pollIntervalMs: 5_000,
        maxCandidatesPerRun: 4,
        redeliveryWindowMs: 60_000
      },
      projectionStore: store,
      dockingAddress: dockingModuleAddress,
      chainId,
      routeSource: { listRoutes: async () => [dockRoute()] },
      submitter: {
        submit: async (submission) => {
          submitted.push(submission.data);
          return "0x" + "ab".repeat(32) as Hex;
        }
      },
      now: () => new Date(nowMs)
    });

    // 第一轮：候选成立，广播一次。
    const first = await worker.runOnce();
    expect(first).toMatchObject({ inputCandidates: 1, submitted: 1, deduplicated: 0 });
    expect(submitted.length).toBe(1);

    // 第二轮（10s 后，仍在 60s 窗口内）：投影未呈现 delivery，去重跳过。
    nowMs += 10_000;
    const second = await worker.runOnce();
    expect(second).toMatchObject({ inputCandidates: 1, submitted: 0, deduplicated: 1 });
    expect(submitted.length).toBe(1);

    // 第三轮（窗口过后仍未投递）：重试一次。
    nowMs += 60_000;
    const third = await worker.runOnce();
    expect(third).toMatchObject({ inputCandidates: 1, submitted: 1, deduplicated: 0 });
    expect(submitted.length).toBe(2);
  });

  it("rate-bounds failed broadcasts with the same finality window", async () => {
    // 持续失败的绑定若不占窗会每轮重发，gas 燃烧无速率上限；成败同占
    // 窗口后，每绑定每窗口至多一次尝试，失败仍在 summary.skipped 可见。
    const store = new MemoryProjectionStore();
    await store.resetFromEvents({ deploymentBlock: 0n, events: dockEvents() });

    let nowMs = 1_000_000;
    let submitCalls = 0;
    const worker = new DockAutomationWorker({
      config: {
        enabled: true,
        pollIntervalMs: 5_000,
        maxCandidatesPerRun: 4,
        redeliveryWindowMs: 60_000
      },
      projectionStore: store,
      dockingAddress: dockingModuleAddress,
      chainId,
      routeSource: { listRoutes: async () => [dockRoute()] },
      submitter: {
        submit: async () => {
          submitCalls += 1;
          throw new Error("reverted: binding hash mismatch");
        }
      },
      now: () => new Date(nowMs)
    });

    const first = await worker.runOnce();
    expect(first).toMatchObject({ inputCandidates: 1, submitted: 0, deduplicated: 0 });
    expect(first.skipped.length).toBe(1);
    expect(submitCalls).toBe(1);

    // 窗口内的后续轮次不再重发失败的绑定。
    nowMs += 10_000;
    const second = await worker.runOnce();
    expect(second).toMatchObject({ inputCandidates: 1, submitted: 0, deduplicated: 1 });
    expect(second.skipped.length).toBe(0);
    expect(submitCalls).toBe(1);

    // 窗口过后允许重试一次（投影仍未呈现 delivery）。
    nowMs += 60_000;
    const third = await worker.runOnce();
    expect(third).toMatchObject({ inputCandidates: 1, submitted: 0, deduplicated: 0 });
    expect(third.skipped.length).toBe(1);
    expect(submitCalls).toBe(2);
  });

  it("stops submitting once the projection reflects the delivery", async () => {
    const events = [
      ...dockEvents(),
      chainEvent(6n, 0, "DockInputSubmitted", {
        dockInstanceId,
        linkedOrderId,
        inputBindingHash: amendBindingHash,
        localPlanId: planId,
        localOrderId: orderId,
        targetPlanId,
        targetSignalId: signalId,
        payloadHash,
        submitter: signer
      }, dockingModuleAddress)
    ];
    const store = new MemoryProjectionStore();
    await store.resetFromEvents({ deploymentBlock: 0n, events });

    const submitted: string[] = [];
    const worker = new DockAutomationWorker({
      config: {
        enabled: true,
        pollIntervalMs: 5_000,
        maxCandidatesPerRun: 4,
        redeliveryWindowMs: 60_000
      },
      projectionStore: store,
      dockingAddress: dockingModuleAddress,
      chainId,
      routeSource: { listRoutes: async () => [dockRoute()] },
      submitter: {
        submit: async (submission) => {
          submitted.push(submission.data);
          return "0x" + "ab".repeat(32) as Hex;
        }
      }
    });

    const summary = await worker.runOnce();
    expect(summary).toMatchObject({ inputCandidates: 0, submitted: 0, deduplicated: 0 });
    expect(submitted.length).toBe(0);
  });

  it("treats a sibling-satisfied output binding as delivered instead of re-broadcasting forever", async () => {
    // 同一本地事实键的两条 output 绑定：首条真实交付（Submitted），兄弟绑定
    // 在链上被等价交付吸收（Satisfied）。Satisfied 事件必须把投影台账收敛为
    // 已交付——否则 keeper 每个重发窗口都会把兄弟绑定再广播一次（永不收敛
    // 的 gas 循环）。
    const doneBindingHash = bytes32Hex("0d0d");
    const progressBindingHash = bytes32Hex("0e0e");
    const outputs = [
      {
        bindingHash: doneBindingHash,
        localSourceId: sourceId,
        localSignalId: signalId,
        targetSourceId: sourceId,
        targetSignalId: signalId
      },
      {
        bindingHash: progressBindingHash,
        localSourceId: sourceId,
        localSignalId: signalId,
        targetSourceId: sourceId,
        targetSignalId: signalId
      }
    ];
    const route: DockRouteRecord = { ...dockRoute(), inputs: [], outputs };
    const baseEvents: readonly ChainEvent[] = [
      ...dockEvents(),
      chainEvent(6n, 0, "SignalSubmitted", {
        orderId: linkedOrderId,
        sourceId,
        signalId,
        payloadHash,
        idempotencyKey: bytes32Hex("0aaa"),
        submitter: signer
      }),
      chainEvent(7n, 0, "DockOutputSubmitted", {
        dockInstanceId,
        linkedOrderId,
        outputBindingHash: doneBindingHash,
        localPlanId: planId,
        localOrderId: orderId,
        targetPlanId,
        targetSignalId: signalId,
        localSignalId: signalId,
        payloadHash,
        submitter: signer
      }, dockingModuleAddress)
    ];
    const satisfiedEvent: ChainEvent = chainEvent(8n, 0, "DockOutputSatisfied", {
      dockInstanceId,
      linkedOrderId,
      outputBindingHash: progressBindingHash,
      localPlanId: planId,
      localOrderId: orderId,
      targetPlanId,
      targetSignalId: signalId,
      localSignalId: signalId,
      payloadHash,
      submitter: signer
    }, dockingModuleAddress);

    const buildWorker = async (events: readonly ChainEvent[]) => {
      const store = new MemoryProjectionStore();
      await store.resetFromEvents({ deploymentBlock: 0n, events });
      const submitted: string[] = [];
      const worker = new DockAutomationWorker({
        config: {
          enabled: true,
          pollIntervalMs: 5_000,
          maxCandidatesPerRun: 4,
          redeliveryWindowMs: 60_000
        },
        projectionStore: store,
        dockingAddress: dockingModuleAddress,
        chainId,
        routeSource: { listRoutes: async () => [route] },
        submitter: {
          submit: async (submission) => {
            submitted.push(submission.data);
            return "0x" + "ab".repeat(32) as Hex;
          }
        }
      });
      return { worker, submitted };
    };

    // 反例（无 Satisfied 事件）：兄弟绑定仍被视为未交付，候选成立。
    const without = await buildWorker(baseEvents);
    const withoutSummary = await without.worker.runOnce();
    expect(withoutSummary).toMatchObject({ outputCandidates: 1, submitted: 1 });
    expect(without.submitted.length).toBe(1);

    // 正例（含 Satisfied 事件）：两条绑定台账齐备，候选归零、不再广播。
    const withSatisfied = await buildWorker([...baseEvents, satisfiedEvent]);
    const summary = await withSatisfied.worker.runOnce();
    expect(summary).toMatchObject({ outputCandidates: 0, submitted: 0, deduplicated: 0 });
    expect(withSatisfied.submitted.length).toBe(0);
  });
});

function dockRoute(): DockRouteRecord {
  return {
    chainId,
    localPlanId: planId,
    localOrderId: orderId,
    targetPlanId,
    linkedOrderId,
    routeId,
    routeHash: planHash,
    interfaceName: "production_service",
    orderMode: "new",
    inputs: [
      {
        // entrance（new 模式唯一 input 绑定，open 原子投递）。
        bindingHash: entranceBindingHash,
        localHookId: hookId,
        targetSourceId: sourceId,
        targetSignalId: signalId
      },
      {
        bindingHash: amendBindingHash,
        localHookId: amendHookId,
        targetSourceId: sourceId,
        targetSignalId: signalId
      }
    ],
    outputs: []
  };
}

function dockEvents(): readonly ChainEvent[] {
  return [
    chainEvent(1n, 0, "PlanRegistered", {
      planId,
      planHash,
      hookCount: 1n
    }),
    chainEvent(2n, 0, "OrderRegistered", {
      orderId,
      planId
    }),
    chainEvent(3n, 0, "StateMachineModuleSet", {
      moduleId: bytes32Text("uvp.module.docking.v1"),
      previousModule: "0x0000000000000000000000000000000000000000",
      newModule: dockingModuleAddress
    }),
    chainEvent(4n, 0, "HookStatusChanged", {
      orderId,
      planId,
      hookId: amendHookId,
      previousStatus: 0,
      newStatus: 2,
      dueAt: 0n
    }),
    chainEvent(5n, 0, "DockOpened", {
      dockInstanceId,
      localOrderId: orderId,
      linkedOrderId,
      interfaceNameId,
      localPlanId: planId,
      targetPlanId,
      routeId,
      routeHash: planHash,
      depth: 1n,
      opener: signer
    }, dockingModuleAddress)
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

function bytes32Text(value: string): Hex {
  return `0x${Buffer.from(value, "utf8").toString("hex").padEnd(64, "0")}` as Hex;
}
