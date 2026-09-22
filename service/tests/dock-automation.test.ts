import { describe, expect, it } from "vitest";
import { decodeFunctionData, type Abi } from "viem";
import { capabilitiesRootOf } from "@uvp-eth/compiler";
import { DOCKING_MODULE_ABI } from "@uvp-eth/protocol-bindings";
import { DockAutomationWorker } from "../src/dock-automation/service.js";
import type { DockRouteRecord } from "../src/dock-automation/types.js";
import { MemoryProjectionStore } from "../src/storage/projection-store.js";
import type { PlanCapabilityTablesInput } from "../src/indexer/projections/plan.js";
import type { ChainEvent } from "../src/indexer/events.js";
import type { Hex } from "../src/shared/types.js";

const contractAddress = "0x1111111111111111111111111111111111111111" as Hex;
const dockingModuleAddress = "0x6666666666666666666666666666666666666666" as Hex;
const signer = "0x4444444444444444444444444444444444444444" as Hex;
const chainId = 31337;
const planId = bytes32Hex("0101");
const planHash = bytes32Hex("0a0a");
const targetPlanHash = bytes32Hex("0c0c");
const orderId = bytes32Hex("0202");
const hookId = bytes32Hex("0303");
const amendHookId = bytes32Hex("0808");
const linkedOrderId = bytes32Hex("0303");
const targetPlanId = bytes32Hex("0404");
const routeId = bytes32Hex("0505");
const dockInstanceId = bytes32Hex("0900");
const entranceBindingHash = bytes32Hex("0606");
const amendBindingHash = bytes32Hex("0707");
const outputBindingHash = bytes32Hex("0d0d");
const payloadHash = bytes32Hex("0b0b");
const signalId = bytes32Hex("0505");
const sourceId = bytes32Hex("0404");
const interfaceNameId = bytes32Text("production_service");
const zeroBytes32 = ("0x" + "00".repeat(32)) as Hex;

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

  it("fails closed on route records with missing or malformed identity fields", async () => {
    // route 数据来自链下来源：keeper 只提交可由链上 committed 投影推导的
    // 就绪性——记录身份字段缺失/零值/跨链/new 模式缺 openCalldata 或
    // existing 模式缺 attachCalldata（各自模式的唯一交易载荷）即整轮
    // 响亮报错，不静默跳过、不带可疑数据继续提交。
    const store = new MemoryProjectionStore();
    await store.resetFromEvents({ deploymentBlock: 0n, events: dockEvents() });
    const submitted: string[] = [];
    const build = (routes: readonly DockRouteRecord[]) =>
      new DockAutomationWorker({
        config: { enabled: true, pollIntervalMs: 5_000, redeliveryWindowMs: 60_000, maxCandidatesPerRun: 4 },
        projectionStore: store,
        dockingAddress: dockingModuleAddress,
        chainId,
        routeSource: { listRoutes: async () => routes },
        submitter: {
          submit: async (submission) => {
            submitted.push(submission.data);
            return "0x" + "ab".repeat(32) as Hex;
          }
        }
      });

    await expect(build([{ ...dockRoute(), chainId: 31338 }]).runOnce())
      .rejects.toThrow(/routes\[0\]\.chainId .* does not match the keeper chain/);
    await expect(build([{ ...dockRoute(), routeId: "0x" + "00".repeat(32) as Hex }]).runOnce())
      .rejects.toThrow(/routes\[0\]\.routeId must be a non-zero bytes32/);
    const { openCalldata: _omitted, ...missingOpen } = dockRoute();
    void _omitted;
    await expect(build([missingOpen as DockRouteRecord]).runOnce())
      .rejects.toThrow(/routes\[0\]\.openCalldata must be pre-assembled calldata hex for a new-mode route/);
    await expect(build([{ ...dockRoute(), inputs: [] }]).runOnce())
      .rejects.toThrow(/routes\[0\]: new-mode route must carry the entrance input binding/);
    await expect(build([{
      ...dockRoute(),
      inputs: [...dockRoute().inputs.slice(1), { ...dockRoute().inputs[1]!, bindingHash: "0x1234" as Hex }]
    }]).runOnce())
      .rejects.toThrow(/routes\[0\]\.inputs\[1\]\.bindingHash must be a non-zero bytes32/);
    const { attachCalldata: _omittedAttach, ...missingAttach } = existingDockRoute();
    void _omittedAttach;
    await expect(build([missingAttach as DockRouteRecord]).runOnce())
      .rejects.toThrow(/routes\[0\]\.attachCalldata must be pre-assembled calldata hex for an existing-mode route/);
    // 无提交发生：校验在任何广播之前完成。
    expect(submitted).toEqual([]);
  });

  it("relays the pre-assembled attach calldata once both endpoint orders are born, and stops once attached", async () => {
    // attach 同意门三腿（目标单 creator / 在任执行者 / publisher attach
    // 预授权）都不含中继 keeper——keeper 只广播 route 来源预组装的
    // attachCalldata 原文，不组装、不补签；挂接前提（父单与目标单出生）
    // 以投影为准，未出生前不广播（否则必 revert 白烧 gas）。
    const buildWorker = async (events: readonly ChainEvent[]) => {
      const store = new MemoryProjectionStore();
      await store.resetFromEvents({ deploymentBlock: 0n, events });
      const submitted: string[] = [];
      const worker = new DockAutomationWorker({
        config: { enabled: true, pollIntervalMs: 5_000, maxCandidatesPerRun: 4, redeliveryWindowMs: 60_000 },
        projectionStore: store,
        dockingAddress: dockingModuleAddress,
        chainId,
        routeSource: { listRoutes: async () => [existingDockRoute()] },
        submitter: {
          submit: async (submission) => {
            submitted.push(submission.data);
            return "0x" + "ab".repeat(32) as Hex;
          }
        }
      });
      return { worker, submitted };
    };

    // 目标单未出生（且未挂接）：attach 不成候选，也不发任何交付交易。
    const withoutTarget = await buildWorker(
      attachedEvents().filter(
        (event) =>
          event.eventName !== "DockAttached" &&
          !(event.eventName === "OrderRegistered" && event.args["orderId"] === linkedOrderId)
      )
    );
    expect(await withoutTarget.worker.runOnce()).toMatchObject({ attachCandidates: 0, submitted: 0 });
    expect(withoutTarget.submitted).toEqual([]);

    // 两端出生且尚未挂接：广播预组装 calldata 原文。
    const pending = await buildWorker(attachedEvents().filter((event) => event.eventName !== "DockAttached"));
    const summary = await pending.worker.runOnce();
    expect(summary).toMatchObject({ attachCandidates: 1, submitted: 1 });
    expect(pending.submitted).toEqual([existingDockRoute().attachCalldata]);

    // 已挂接（投影含 dock 实例）：进入交付车道（input 活交付候选成立），
    // 不再发 attach。
    const attached = await buildWorker(attachedEvents());
    const attachedSummary = await attached.worker.runOnce();
    expect(attachedSummary).toMatchObject({ attachCandidates: 0, inputCandidates: 1, submitted: 1 });
    expect(attached.submitted).not.toContain(existingDockRoute().attachCalldata);
  });

  it("does not re-broadcast the same binding inside the finality window and retries after it", async () => {
    // 最终性窗口内同一 binding 每轮（默认 5s）重复广播 no-op
    // 交易是纯 gas 浪费。窗口内去重跳过（计数 deduplicated）；窗口过后
    // 投影仍未呈现 delivery 才重试（覆盖交易丢失）。
    const store = new MemoryProjectionStore();
    await store.resetFromEvents({ deploymentBlock: 0n, events: attachedEvents() });

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
      routeSource: { listRoutes: async () => [existingDockRoute()] },
      submitter: {
        submit: async (submission) => {
          submitted.push(submission.data);
          return "0x" + "ab".repeat(32) as Hex;
        }
      },
      now: () => new Date(nowMs)
    });

    // 第一轮：候选成立，广播一次；existing 无出生锚，inputs[0] 也是活交付面。
    const first = await worker.runOnce();
    expect(first).toMatchObject({ inputCandidates: 1, submitted: 1, deduplicated: 0 });
    expect(submitted.length).toBe(1);
    // 4.4 写面形状：submitDockedInput 三参数（dockInstanceId/localHookId/
    // inputBindingHash），selector 由 bindings 单源切片决定。
    const decoded = decodeFunctionData({
      abi: DOCKING_MODULE_ABI as Abi,
      data: submitted[0] as Hex
    });
    expect(decoded.functionName).toBe("submitDockedInput");
    expect(decoded.args).toEqual([dockInstanceId, amendHookId, amendBindingHash]);

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
    await store.resetFromEvents({ deploymentBlock: 0n, events: attachedEvents() });

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
      routeSource: { listRoutes: async () => [existingDockRoute()] },
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
      ...attachedEvents(),
      chainEvent(8n, 0, "DockInputSubmitted", {
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
      routeSource: { listRoutes: async () => [existingDockRoute()] },
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

  it("has no live input lane for new-mode docks because the entrance is delivered atomically at open", async () => {
    // 4.4 链上 new 模式只登记出生锚绑定（open 原子投递）：非 entrance 的
    // input 绑定没有链上活面，keeper 对 new 模式提交它们只会收获
    // DockInputNotFound revert。活交付面只在 existing（attached）一侧。
    const store = new MemoryProjectionStore();
    await store.resetFromEvents({ deploymentBlock: 0n, events: dockEvents() });

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
    expect(summary).toMatchObject({ inputCandidates: 0, submitted: 0 });
    expect(submitted).toEqual([]);
  });

  it("backfills attached-dock outputs with the 4-arg submitDockedSignal and converges on the delivery event", async () => {
    // attach 不内联已成立输出清单：回填 = 按路由产物枚举 output 绑定逐条
    // 重放 submitDockedSignal（payload 读 StateMachine 存储）。4.4 起该调用
    // 携 attribution/selectorBinding 造证——无词表 plan 造全零结构，由链上
    // 词表闸裁决。
    const baseEvents: readonly ChainEvent[] = [
      ...attachedEvents(),
      chainEvent(8n, 0, "SignalSubmitted", {
        orderId: linkedOrderId,
        sourceId,
        signalId,
        payloadHash,
        idempotencyKey: bytes32Hex("0aaa"),
        submitter: signer
      })
    ];
    const route: DockRouteRecord = { ...existingDockRoute(), inputs: [], outputs: [{
      bindingHash: outputBindingHash,
      localSourceId: sourceId,
      localSignalId: signalId,
      targetSourceId: sourceId,
      targetSignalId: signalId
    }] };

    let nowMs = 1_000_000;
    const store = new MemoryProjectionStore();
    await store.resetFromEvents({ deploymentBlock: 0n, events: baseEvents });
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
      },
      now: () => new Date(nowMs)
    });

    // 第一轮：目标事实已在投影（attach 前成立），回填候选成立并广播。
    const first = await worker.runOnce();
    expect(first).toMatchObject({ outputCandidates: 1, submitted: 1, deduplicated: 0 });
    expect(submitted.length).toBe(1);
    const decoded = decodeFunctionData({
      abi: DOCKING_MODULE_ABI as Abi,
      data: submitted[0] as Hex
    });
    expect(decoded.functionName).toBe("submitDockedSignal");
    expect(decoded.args).toEqual([
      dockInstanceId,
      outputBindingHash,
      { sourceId, signalId, stageId: zeroBytes32, capabilityProof: [] },
      { selectorStageId: zeroBytes32, proof: [] }
    ]);

    // 窗口内：投影尚未呈现 delivery，去重跳过（交易可能仍在途）。
    nowMs += 10_000;
    expect(await worker.runOnce()).toMatchObject({ outputCandidates: 1, submitted: 0, deduplicated: 1 });

    // 窗口过后：仍未呈现 delivery，重试一次（覆盖交易丢失）。
    nowMs += 60_000;
    expect(await worker.runOnce()).toMatchObject({ outputCandidates: 1, submitted: 1, deduplicated: 0 });
    expect(submitted.length).toBe(2);

    // 投影呈现 DockOutputSubmitted：候选归零，收敛。
    await store.resetFromEvents({ deploymentBlock: 0n, events: [
      ...baseEvents,
      chainEvent(9n, 0, "DockOutputSubmitted", {
        dockInstanceId,
        linkedOrderId,
        outputBindingHash,
        localPlanId: planId,
        localOrderId: orderId,
        targetPlanId,
        targetSignalId: signalId,
        localSignalId: signalId,
        payloadHash,
        submitter: signer
      }, dockingModuleAddress)
    ] });
    const converged = await worker.runOnce();
    expect(converged).toMatchObject({ outputCandidates: 0, submitted: 0, deduplicated: 0 });
  });

  it("retries a DockOutputNotReady revert only once per finality window", async () => {
    // 未成立的目标输出链上 revert DockOutputNotReady：与广播失败同占窗口
    //（否则持续 NotReady 的绑定每轮重发，gas 无速率上限），失败进
    // skipped 可见；窗口过后投影仍未呈现事实才再试。
    const store = new MemoryProjectionStore();
    await store.resetFromEvents({
      deploymentBlock: 0n,
      events: [
        ...attachedEvents(),
        chainEvent(8n, 0, "SignalSubmitted", {
          orderId: linkedOrderId,
          sourceId,
          signalId,
          payloadHash,
          idempotencyKey: bytes32Hex("0aaa"),
          submitter: signer
        })
      ]
    });
    const route: DockRouteRecord = { ...existingDockRoute(), inputs: [], outputs: [{
      bindingHash: outputBindingHash,
      localSourceId: sourceId,
      localSignalId: signalId,
      targetSourceId: sourceId,
      targetSignalId: signalId
    }] };

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
      routeSource: { listRoutes: async () => [route] },
      submitter: {
        submit: async () => {
          submitCalls += 1;
          throw new Error("reverted: DockOutputNotReady(dockInstanceId, outputBindingHash)");
        }
      },
      now: () => new Date(nowMs)
    });

    const first = await worker.runOnce();
    expect(first).toMatchObject({ outputCandidates: 1, submitted: 0, deduplicated: 0 });
    expect(first.skipped[0]).toMatch(/DockOutputNotReady/);
    expect(submitCalls).toBe(1);

    nowMs += 10_000;
    expect(await worker.runOnce()).toMatchObject({ outputCandidates: 1, submitted: 0, deduplicated: 1 });
    expect(submitCalls).toBe(1);

    nowMs += 60_000;
    expect(await worker.runOnce()).toMatchObject({ outputCandidates: 1, submitted: 0, deduplicated: 0 });
    expect(submitCalls).toBe(2);
  });

  it("mints vocabulary-backed attribution for the mirrored parent fact and skips while enrichment state is unknown", async () => {
    // 词表内事实必须携证（全零必被 InvalidSignalCapability 拒绝）：镜像事实
    // 落父单，attribution 按父 plan 词表铸造；富集 failed（解析故障轮）时
    // 词表状态未知——跳过留痕而不是全零造证，白烧 gas 等 revert 才暴露。
    const signalCapabilities = [
      { stageId: hookId, targetSourceId: sourceId, signalId, targetOrderRelation: 0 as const },
      { stageId: hookId, targetSourceId: sourceId, signalId: bytes32Hex("0f0f"), targetOrderRelation: 0 as const }
    ];
    const vocabulary = {
      planId,
      planHash,
      selectorBindings: [],
      signalCapabilities
    };
    const events: readonly ChainEvent[] = [
      ...attachedEvents(),
      chainEvent(8n, 0, "SignalSubmitted", {
        orderId: linkedOrderId,
        sourceId,
        signalId,
        payloadHash,
        idempotencyKey: bytes32Hex("0aaa"),
        submitter: signer
      })
    ];
    const route: DockRouteRecord = { ...existingDockRoute(), inputs: [], outputs: [{
      bindingHash: outputBindingHash,
      localSourceId: sourceId,
      localSignalId: signalId,
      targetSourceId: sourceId,
      targetSignalId: signalId
    }] };

    const buildWorker = async (
      planCapabilityTables: readonly PlanCapabilityTablesInput[],
      resolutionFailures?: readonly Hex[]
    ) => {
      const store = new MemoryProjectionStore();
      await store.resetFromEvents({
        deploymentBlock: 0n,
        events: planPublishEvents(capabilitiesRootOf([], signalCapabilities)).concat(events),
        ...(planCapabilityTables.length > 0 ? { planCapabilityTables } : {}),
        ...(resolutionFailures ? { planCapabilityResolutionFailures: resolutionFailures } : {})
      });
      const submitted: string[] = [];
      const worker = new DockAutomationWorker({
        config: { enabled: true, pollIntervalMs: 5_000, maxCandidatesPerRun: 4, redeliveryWindowMs: 60_000 },
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

    // 词表命中：attribution 携属主阶段与能力叶 proof（selectorBindings 空 →
    // selectorBinding 全零，合约按"未声明"放行）。
    const enriched = await buildWorker([vocabulary]);
    const enrichedSummary = await enriched.worker.runOnce();
    expect(enrichedSummary).toMatchObject({ outputCandidates: 1, submitted: 1, skipped: [] });
    const decoded = decodeFunctionData({
      abi: DOCKING_MODULE_ABI as Abi,
      data: enriched.submitted[0] as Hex
    });
    expect(decoded.args).toEqual([
      dockInstanceId,
      outputBindingHash,
      { sourceId, signalId, stageId: hookId, capabilityProof: [expect.any(String)] },
      { selectorStageId: zeroBytes32, proof: [] }
    ]);

    // 富集 failed（resolver 故障轮，无产物两表可富集）：词表状态未知，绑定
    // 跳过进 skipped，不广播。
    const failed = await buildWorker([], [planId]);
    const failedSummary = await failed.worker.runOnce();
    expect(failedSummary).toMatchObject({ outputCandidates: 1, submitted: 0 });
    expect(failedSummary.skipped[0]).toMatch(/enrichment failed/);
    expect(failed.submitted).toEqual([]);
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
    // entrance-only inputs：跳过 input 候选路径，聚焦 output 车道。
    const route: DockRouteRecord = { ...dockRoute(), inputs: [dockRoute().inputs[0]!], outputs };
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
    openCalldata: "0xabcd1234" as Hex,
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

function existingDockRoute(): DockRouteRecord {
  return {
    chainId,
    localPlanId: planId,
    localOrderId: orderId,
    targetPlanId,
    linkedOrderId,
    routeId,
    routeHash: planHash,
    interfaceName: "production_service",
    orderMode: "existing",
    attachCalldata: "0xabef5678" as Hex,
    inputs: [
      {
        // existing 无出生锚：全部 input 绑定（含首条）都是活交付面。
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

/** existing 模式事件基座：父单/目标单/两 plan 出生 + docking 模块登记 +
 * amend hook Ready + DockAttached。 */
function attachedEvents(): readonly ChainEvent[] {
  return [
    chainEvent(1n, 0, "PlanRegistered", {
      planId,
      planHash,
      hookCount: 1n
    }),
    chainEvent(2n, 0, "PlanRegistered", {
      planId: targetPlanId,
      planHash: targetPlanHash,
      hookCount: 1n
    }),
    chainEvent(3n, 0, "OrderRegistered", {
      orderId,
      planId
    }),
    chainEvent(4n, 0, "OrderRegistered", {
      orderId: linkedOrderId,
      planId: targetPlanId
    }),
    chainEvent(5n, 0, "StateMachineModuleSet", {
      moduleId: bytes32Text("uvp.module.docking.v1"),
      previousModule: "0x0000000000000000000000000000000000000000",
      newModule: dockingModuleAddress
    }),
    chainEvent(6n, 0, "HookStatusChanged", {
      orderId,
      planId,
      hookId: amendHookId,
      previousStatus: 0,
      newStatus: 2,
      dueAt: 0n
    }),
    chainEvent(7n, 0, "DockAttached", {
      dockInstanceId,
      localOrderId: orderId,
      linkedOrderId,
      interfaceNameId,
      localPlanId: planId,
      targetPlanId,
      routeId,
      routeHash: planHash,
      depth: 1n,
      attacher: signer
    }, dockingModuleAddress)
  ];
}

/** 父 plan 两步发布事件（词表富集的链上 root 载体）。 */
function planPublishEvents(capabilitiesRoot: Hex): readonly ChainEvent[] {
  return [
    chainEvent(0n, 0, "PlanCommitted", {
      planId,
      planHash,
      publisher: signer,
      hooksHash: bytes32Hex("0e01"),
      capabilitiesRoot,
      hookCount: 1n,
      dockRoutesRoot: bytes32Hex("0e03"),
      dockInterfaceRoot: bytes32Hex("0e04")
    }),
    chainEvent(0n, 1, "PlanPublisherRecorded", {
      planId,
      publisher: signer
    }),
    chainEvent(0n, 2, "PlanFinalized", {
      planId,
      planHash,
      capabilitiesRoot
    }),
    chainEvent(0n, 3, "PlanRegistered", {
      planId,
      planHash,
      hookCount: 1n
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

function bytes32Text(value: string): Hex {
  return `0x${Buffer.from(value, "utf8").toString("hex").padEnd(64, "0")}` as Hex;
}
