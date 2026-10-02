// dock 投递与事件投影链的黑盒对抗测试（独立测试工程师视角）：
// 只依据行为规格构造事件流与 route 记录，不 mock 内部实现，验证
// - keeper：乱序到达（挂接前已 Ready 的钩子/挂接前已成立的目标事实）、
//   最终性窗口重播抑制与窗口后重试、DockInputConflict 预检留痕、
//   attribution 造证三态（词表命中/无词表全零/词表解析 failed）、
//   去重键组成（dockInstanceId+bindingHash）、预算公平性、并发 runOnce；
// - 投影：未知事件显式计数、OrderForked 血缘落库与 fork 单上的信号流、
//   两次重建幂等、fork 出生事件的 reorg 墓碑、未出生 dock 的交付事件
//   显式计数不静默。
import { describe, expect, it } from "vitest";
import { decodeFunctionData, type Abi } from "viem";
import { capabilitiesRootOf } from "@uvp-eth/compiler";
import { DOCKING_MODULE_ABI } from "@uvp-eth/protocol-bindings";
import { DockAutomationWorker } from "../src/dock-automation/service.js";
import type {
  DockAutomationSubmission,
  DockRouteInputBinding,
  DockRouteOutputBinding,
  DockRouteRecord
} from "../src/dock-automation/types.js";
import { rebuildOrderProjections } from "../src/indexer/replay.js";
import type { PlanCapabilityTablesInput } from "../src/indexer/projections/plan.js";
import { stateMachineScopedKey } from "../src/indexer/projections/index.js";
import { MemoryProjectionStore } from "../src/storage/projection-store.js";
import type { ChainEvent } from "../src/indexer/events.js";
import type { Hex } from "../src/shared/types.js";

const chainId = 31337;
const stateMachineAddress = "0x1111111111111111111111111111111111111111" as Hex;
const dockingModuleAddress = "0x6666666666666666666666666666666666666666" as Hex;
const deploymentRegistryAddress = "0x8888888888888888888888888888888888888888" as Hex;
const signer = "0x4444444444444444444444444444444444444444" as Hex;
const zeroAddress = "0x0000000000000000000000000000000000000000" as Hex;
const zeroBytes32 = ("0x" + "00".repeat(32)) as Hex;
const planId = bytes32Hex("a1");
const planHash = bytes32Hex("b101");
const targetPlanId = bytes32Hex("a2");
const targetPlanHash = bytes32Hex("b102");
const unregisteredPlanId = bytes32Hex("a3");
const parentOrderId = bytes32Hex("c1");
const targetOrderId = bytes32Hex("c2");
const hookId = bytes32Hex("d1");
const secondHookId = bytes32Hex("d2");
const thirdHookId = bytes32Hex("d3");
const dockInstanceId = bytes32Hex("e1");
const routeId = bytes32Hex("f1");
const targetStageId = bytes32Text("stage-b");
const sourceId = bytes32Hex("0501");
const signalId = bytes32Hex("0502");
const otherSourceId = bytes32Hex("0503");
const otherSignalId = bytes32Hex("0504");
const thirdSourceId = bytes32Hex("0505");
const thirdSignalId = bytes32Hex("0506");
const payloadHash = bytes32Hex("0601");
const idempotencyKey = bytes32Hex("0602");

describe("dock delivery & projection blackbox", () => {

  // ---------------------------------------------------------------------------
  // keeper（dock-automation）
  // ---------------------------------------------------------------------------

  it("delivers a hook that was already ready before the dock was attached (out-of-order arrival)", async () => {
    // 时序红线对抗：B 侧挂接建立之前，父单 hook 已经 Ready（跨源事件乱序
    // 到达）。keeper 每轮按投影快照扫描，不是只看"挂接后新 Ready"的钩子
    // ——挂接前已 Ready 的钩子必须同样被扫进来投递，否则该事实永久滞留。
    const events: readonly ChainEvent[] = [
      planRegistered(1n, planId, planHash),
      planRegistered(2n, targetPlanId, targetPlanHash),
      orderRegistered(3n, parentOrderId, planId),
      orderRegistered(4n, targetOrderId, targetPlanId),
      moduleSet(5n),
      hookReady(6n, parentOrderId, hookId, planId),
      dockAttached(7n, dockInstanceId, parentOrderId, targetOrderId, routeId)
    ];
    const route = existingRoute({
      routeId,
      inputs: [inputBinding("01", hookId, sourceId, signalId)]
    });
    const { worker, submitted } = await buildWorker({ events, routes: [route] });

    const summary = await worker.runOnce();
    expect(summary).toMatchObject({ inputCandidates: 1, submitted: 1, skipped: [] });
    const decoded = decodeFunctionData({ abi: DOCKING_MODULE_ABI as Abi, data: submitted[0] as Hex });
    expect(decoded.functionName).toBe("submitDockedInput");
    expect((decoded.args as unknown[]).slice(0, 3)).toEqual([
      dockInstanceId,
      hookId,
      bindingHash("01")
    ]);
  });

  it("backfills a target fact that was established before the dock was attached", async () => {
    // 乱序对抗的另一侧：目标事实（SignalSubmitted）先于 DockAttached 上链。
    // output 车道以投影快照为准做正向回填，attach 前已成立的事实也要重放
    // submitDockedSignal（4 参数造证形态，无词表 plan 全零造证由链上裁决）。
    const events: readonly ChainEvent[] = [
      planRegistered(1n, planId, planHash),
      planRegistered(2n, targetPlanId, targetPlanHash),
      orderRegistered(3n, parentOrderId, planId),
      orderRegistered(4n, targetOrderId, targetPlanId),
      moduleSet(5n),
      signalSubmitted(6n, targetOrderId, targetPlanId, sourceId, signalId),
      dockAttached(7n, dockInstanceId, parentOrderId, targetOrderId, routeId)
    ];
    const route = existingRoute({
      routeId,
      inputs: [],
      outputs: [outputBinding("02", sourceId, signalId, sourceId, signalId)]
    });
    const { worker, submitted } = await buildWorker({ events, routes: [route] });

    const summary = await worker.runOnce();
    expect(summary).toMatchObject({ outputCandidates: 1, submitted: 1, skipped: [] });
    const decoded = decodeFunctionData({ abi: DOCKING_MODULE_ABI as Abi, data: submitted[0] as Hex });
    expect(decoded.functionName).toBe("submitDockedSignal");
    expect(decoded.args).toEqual([
      dockInstanceId,
      bindingHash("02"),
      { sourceId, signalId, stageId: zeroBytes32, capabilityProof: [] },
      { selectorStageId: zeroBytes32, proof: [] }
    ]);
  });

  it("mints submitDockedInput attribution from the target plan vocabulary when available, zero structure otherwise", async () => {
    // attribution 造证两态（input 车道）：目标事实键在目标 plan 词表内 →
    // 属主阶段 + 能力叶 proof；目标 plan 已注册但产物词表不可用（外部发布
    // plan 的合法空词表）→ 全零结构由链上词表闸裁决，不阻断广播。
    const signalCapabilities = [
      { stageId: targetStageId, targetSourceId: sourceId, signalId, targetOrderRelation: 0 as const },
      { stageId: targetStageId, targetSourceId: sourceId, signalId: bytes32Hex("0f0f"), targetOrderRelation: 0 as const }
    ];
    const targetVocabulary: PlanCapabilityTablesInput = {
      planId: targetPlanId,
      planHash: targetPlanHash,
      selectorBindings: [],
      signalCapabilities
    };
    const baseEvents: readonly ChainEvent[] = [
      planRegistered(1n, planId, planHash),
      orderRegistered(3n, parentOrderId, planId),
      orderRegistered(4n, targetOrderId, targetPlanId),
      moduleSet(5n),
      hookReady(6n, parentOrderId, hookId, planId),
      dockAttached(7n, dockInstanceId, parentOrderId, targetOrderId, routeId)
    ];
    const route = existingRoute({
      routeId,
      inputs: [inputBinding("03", hookId, sourceId, signalId)]
    });

    // 词表命中：attribution 携属主阶段与成员资格证明。
    const enriched = await buildWorker({
      events: planPublishEvents(2n, targetPlanId, targetPlanHash, capabilitiesRootOf([], signalCapabilities))
        .concat(baseEvents),
      routes: [route],
      planCapabilityTables: [targetVocabulary]
    });
    const enrichedSummary = await enriched.worker.runOnce();
    expect(enrichedSummary).toMatchObject({ inputCandidates: 1, submitted: 1, skipped: [] });
    const enrichedDecode = decodeFunctionData({ abi: DOCKING_MODULE_ABI as Abi, data: enriched.submitted[0] as Hex });
    expect((enrichedDecode.args as unknown[])[3]).toEqual({
      sourceId,
      signalId,
      stageId: targetStageId,
      capabilityProof: [expect.any(String)]
    });

    // 无词表（目标 plan 只见 PlanRegistered，产物未富集）：全零 attribution。
    const plain = await buildWorker({
      events: [planRegistered(2n, targetPlanId, targetPlanHash)].concat(baseEvents),
      routes: [route]
    });
    const plainSummary = await plain.worker.runOnce();
    expect(plainSummary).toMatchObject({ inputCandidates: 1, submitted: 1, skipped: [] });
    const plainDecode = decodeFunctionData({ abi: DOCKING_MODULE_ABI as Abi, data: plain.submitted[0] as Hex });
    expect((plainDecode.args as unknown[])[3]).toEqual({
      sourceId,
      signalId,
      stageId: zeroBytes32,
      capabilityProof: []
    });
  });

  it("keeps the keeper alive when the input-lane vocabulary resolution failed: skip with a trace, never reject the round", async () => {
    // 目标 plan 词表富集 failed（indexer 按设计持久化该态直到 resolver
    // 恢复）：input 车道造证跳过留痕，runOnce 正常返回——整轮 reject 会
    // 冻结同 route 之后所有交付车道，keeper 活性归零。
    const baseEvents: readonly ChainEvent[] = [
      planRegistered(1n, planId, planHash),
      planRegistered(2n, targetPlanId, targetPlanHash),
      orderRegistered(3n, parentOrderId, planId),
      orderRegistered(4n, targetOrderId, targetPlanId),
      moduleSet(5n),
      hookReady(6n, parentOrderId, hookId, planId),
      dockAttached(7n, dockInstanceId, parentOrderId, targetOrderId, routeId)
    ];
    const route = existingRoute({
      routeId,
      inputs: [inputBinding("03", hookId, sourceId, signalId)]
    });
    const { worker, submitted } = await buildWorker({
      events: baseEvents,
      routes: [route],
      planCapabilityResolutionFailures: [targetPlanId]
    });
    const summary = await worker.runOnce();
    expect(summary.inputCandidates).toBe(1);
    expect(summary.submitted).toBe(0);
    expect(summary.skipped).toHaveLength(1);
    expect(summary.skipped[0]).toContain("input:");
    expect(submitted).toHaveLength(0);
    // 恢复后（词表富集可用）同一 worker 下一轮自然续上。
  });

  it("suppresses re-broadcasts inside the finality window, retries after it, and counts deduplicated", async () => {
    // 去重语义基线：同 (dockInstanceId, bindingHash) 在最终性窗口内已尝试
    // （成败同占窗）→ deduplicated 计数、不再广播；窗口过后投影仍未呈现
    // delivery → 恰好重试一次。
    const events = attachedBase([hookId]);
    const route = existingRoute({
      routeId,
      inputs: [inputBinding("05", hookId, sourceId, signalId)]
    });
    let nowMs = 1_000_000;
    const { worker, submitted } = await buildWorker({ events, routes: [route], now: () => new Date(nowMs) });

    const first = await worker.runOnce();
    expect(first).toMatchObject({ inputCandidates: 1, submitted: 1, deduplicated: 0 });
    expect(submitted).toHaveLength(1);

    nowMs += 10_000;
    const second = await worker.runOnce();
    expect(second).toMatchObject({ inputCandidates: 1, submitted: 0, deduplicated: 1 });
    expect(submitted).toHaveLength(1);

    nowMs += 60_000;
    const third = await worker.runOnce();
    expect(third).toMatchObject({ inputCandidates: 1, submitted: 1, deduplicated: 0 });
    expect(submitted).toHaveLength(2);
  });

  it("scopes the dedupe key to (dockInstanceId, bindingHash): the same bindingHash under two docks never eats the other's window", async () => {
    // 去重键对抗：同一 bindingHash 出现在两个不同 dock 实例（不同 route/
    // 订单）。若去重键只按 bindingHash，第一轮会吃掉第二个实例的广播；
    // 键必须含 dockInstanceId——两个实例各自独立投递、独立占窗。
    const parentB = bytes32Hex("c3");
    const targetB = bytes32Hex("c4");
    const hookB = bytes32Hex("d9");
    const routeIdB = bytes32Hex("f2");
    const dockInstanceB = bytes32Hex("e2");
    const events: readonly ChainEvent[] = [
      planRegistered(1n, planId, planHash),
      planRegistered(2n, targetPlanId, targetPlanHash),
      orderRegistered(3n, parentOrderId, planId),
      orderRegistered(3n, parentB, planId, 1),
      orderRegistered(4n, targetOrderId, targetPlanId, 0),
      orderRegistered(4n, targetB, targetPlanId, 1),
      moduleSet(5n),
      hookReady(6n, parentOrderId, hookId, planId),
      hookReady(6n, parentB, hookB, planId, 1),
      dockAttached(7n, dockInstanceId, parentOrderId, targetOrderId, routeId),
      dockAttached(7n, dockInstanceB, parentB, targetB, routeIdB, 1)
    ];
    const routes = [
      existingRoute({ routeId, inputs: [inputBinding("06", hookId, sourceId, signalId)] }),
      existingRoute({ routeId: routeIdB, localOrderId: parentB, linkedOrderId: targetB, inputs: [inputBinding("06", hookB, otherSourceId, otherSignalId)] })
    ];
    let nowMs = 1_000_000;
    const { worker, submitted } = await buildWorker({ events, routes, now: () => new Date(nowMs) });

    const first = await worker.runOnce();
    expect(first).toMatchObject({ inputCandidates: 2, submitted: 2, deduplicated: 0 });
    const decodedInstances = submitted.map((data) =>
      decodeFunctionData({ abi: DOCKING_MODULE_ABI as Abi, data: data as Hex }).args?.[0]
    );
    expect(decodedInstances).toEqual([dockInstanceId, dockInstanceB]);

    // 窗口内第二轮：两个实例各自去重，互不吞窗。
    nowMs += 10_000;
    const second = await worker.runOnce();
    expect(second).toMatchObject({ inputCandidates: 2, submitted: 0, deduplicated: 2 });
    expect(submitted).toHaveLength(2);
  });

  it("skips an occupied target fact slot with a per-round trace, never broadcasts it, and does not poison sibling bindings", async () => {
    // DockInputConflict 预检：目标事实槽已被占用 → 该绑定不广播、每轮
    // 留痕（skipped 语义可解释：冲突是持续状态，不是一次性事件）；同 dock
    // 的兄弟绑定不受毒害照常投递；冲突预检不占广播窗口（每轮照常检查）。
    const events: readonly ChainEvent[] = [
      ...attachedBase([hookId, secondHookId]),
      // 目标事实槽 (sourceId, signalId) 已被其他 provenance 占用。
      signalSubmitted(8n, targetOrderId, targetPlanId, sourceId, signalId)
    ];
    const route = existingRoute({
      routeId,
      inputs: [
        inputBinding("07", hookId, sourceId, signalId),
        inputBinding("08", secondHookId, otherSourceId, otherSignalId)
      ]
    });
    let nowMs = 1_000_000;
    const { worker, submitted } = await buildWorker({ events, routes: [route], now: () => new Date(nowMs) });

    const first = await worker.runOnce();
    expect(first).toMatchObject({ inputCandidates: 1, submitted: 1 });
    expect(first.skipped).toHaveLength(1);
    expect(first.skipped[0]).toMatch(/already occupied; submitDockedInput would revert DockInputConflict permanently/);
    expect(first.skipped[0]).toContain(bindingHash("07"));
    const decoded = decodeFunctionData({ abi: DOCKING_MODULE_ABI as Abi, data: submitted[0] as Hex });
    expect((decoded.args as unknown[])[2]).toBe(bindingHash("08"));

    // 第二轮（窗口内）：兄弟绑定去重，冲突绑定照常留痕（预检不占窗）。
    nowMs += 10_000;
    const second = await worker.runOnce();
    expect(second).toMatchObject({ inputCandidates: 1, submitted: 0, deduplicated: 1 });
    expect(second.skipped).toHaveLength(1);
    expect(second.skipped[0]).toContain(bindingHash("07"));
    expect(submitted).toHaveLength(1);
  });

  it("keeps the per-run candidate budget fair across rounds for a multi-binding dock", async () => {
    // 同 dockInstanceId 多 binding + maxCandidatesPerRun 预算：首轮按预算
    // 截断（先到先得），下一轮窗口去重不占预算、尾部绑定补投——预算在
    // 轮次间公平轮转，不饿死任何绑定。
    const events = attachedBase([hookId, secondHookId, thirdHookId]);
    const route = existingRoute({
      routeId,
      inputs: [
        inputBinding("09", hookId, sourceId, signalId),
        inputBinding("0a", secondHookId, otherSourceId, otherSignalId),
        inputBinding("0b", thirdHookId, thirdSourceId, thirdSignalId)
      ]
    });
    let nowMs = 1_000_000;
    const { worker, submitted } = await buildWorker({
      events,
      routes: [route],
      now: () => new Date(nowMs),
      maxCandidatesPerRun: 2
    });

    const first = await worker.runOnce();
    expect(first).toMatchObject({ inputCandidates: 2, submitted: 2, deduplicated: 0 });

    // 窗口内第二轮：前两条去重（去重不占预算），预算落到尾部绑定。
    nowMs += 30_000;
    const second = await worker.runOnce();
    expect(second).toMatchObject({ inputCandidates: 3, submitted: 1, deduplicated: 2 });

    // 窗口外第三轮：前两条窗口过期重试（预算再次截断），尾部绑定窗口未过。
    nowMs += 70_000;
    const third = await worker.runOnce();
    expect(third).toMatchObject({ inputCandidates: 2, submitted: 2, deduplicated: 0 });

    // 三条绑定都至少被广播过一次。
    const broadcastHashes = new Set(submitted.map((data) => {
      const decoded = decodeFunctionData({ abi: DOCKING_MODULE_ABI as Abi, data: data as Hex });
      return decoded.args?.[2];
    }));
    expect(broadcastHashes).toEqual(new Set([bindingHash("09"), bindingHash("0a"), bindingHash("0b")]));
  });

  it("makes a concurrent runOnce an explicit no-op summary instead of a second broadcast", async () => {
    // 并发对抗：上一轮仍在广播中时叠加的 runOnce 必须显式归零（不排队、
    // 不重入、不二次广播），返回可解释的空 summary。
    const events = attachedBase([hookId]);
    const route = existingRoute({
      routeId,
      inputs: [inputBinding("0c", hookId, sourceId, signalId)]
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let submissions = 0;
    const { worker } = await buildWorker({
      events,
      routes: [route],
      submit: async () => {
        submissions += 1;
        await gate;
        return bytes32Hex("feed");
      }
    });

    const firstRound = worker.runOnce();
    for (let attempt = 0; attempt < 100 && submissions === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(submissions).toBe(1);

    const overlapping = await worker.runOnce();
    expect(overlapping).toEqual({
      scannedRoutes: 0,
      scannedDocks: 0,
      attachCandidates: 0,
      openCandidates: 0,
      inputCandidates: 0,
      outputCandidates: 0,
      submitted: 0,
      deduplicated: 0,
      skipped: []
    });

    release();
    const first = await firstRound;
    expect(first.submitted).toBe(1);
  });

  it("treats a not-yet-ready hook as a silent waiting state (no candidates, no skip traces)", async () => {
    // skipped/deduplicated 语义可解释性：hook 未 Ready 是正常等待态——
    // 不产生候选、不产生 skipped 留痕（留痕只属于冲突/失败/结构性跳过）。
    const events: readonly ChainEvent[] = [
      planRegistered(1n, planId, planHash),
      planRegistered(2n, targetPlanId, targetPlanHash),
      orderRegistered(3n, parentOrderId, planId),
      orderRegistered(4n, targetOrderId, targetPlanId),
      moduleSet(5n),
      // hook 存在但处于 pending（status 1），未 Ready。
      chainEvent(6n, 0, "HookStatusChanged", {
        orderId: parentOrderId,
        planId,
        hookId,
        previousStatus: 0,
        newStatus: 1,
        dueAt: 0n
      }),
      dockAttached(7n, dockInstanceId, parentOrderId, targetOrderId, routeId)
    ];
    const route = existingRoute({
      routeId,
      inputs: [inputBinding("0d", hookId, sourceId, signalId)]
    });
    const { worker, submitted } = await buildWorker({ events, routes: [route] });

    const summary = await worker.runOnce();
    expect(summary).toMatchObject({
      inputCandidates: 0,
      submitted: 0,
      deduplicated: 0,
      skipped: []
    });
    expect(submitted).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // 投影重建（indexer replay）
  // ---------------------------------------------------------------------------

  it("counts genuinely unknown events explicitly and keeps neighbour projections intact", async () => {
    // 事件覆盖面对抗：未知事件必须显式计数（两个不同名未知事件 = 2），
    // 已收口家族（部署注册表族、零投影治理族）不得误计入未知；未知事件
    // 的存在不得污染相邻事件的投影。
    const events: readonly ChainEvent[] = [
      planRegistered(1n, planId, planHash),
      chainEvent(2n, 0, "OwnershipTransferred", {
        previousOwner: zeroAddress,
        newOwner: signer
      }),
      chainEvent(3n, 0, "SomeBrandNewEventV9", { planId }),
      chainEvent(3n, 1, "AnotherUnheardOfEvent", { planId }),
      chainEvent(4n, 0, "DeploymentRegistered", {
        deploymentId: bytes32Hex("7d01"),
        stateMachine: stateMachineAddress,
        artifactHash: planHash,
        abiHash: bytes32Hex("7d02"),
        deploymentBlock: 1n,
        metadataURI: "uvp-eth://deployments/blackbox"
      }, deploymentRegistryAddress),
      orderRegistered(5n, parentOrderId, planId)
    ];

    const snapshot = rebuildOrderProjections(events);
    expect(snapshot.unknownEventCount).toBe(2);
    expect(snapshot.eventCount).toBe(6);
    expect(snapshot.stateMachineDeployments[`${chainId}:${deploymentRegistryAddress}:${bytes32Hex("7d01")}`])
      .toMatchObject({ status: "candidate" });
    expect(snapshot.stateMachineOrders[stateMachineScopedKey(chainId, stateMachineAddress, planId, parentOrderId)])
      .toMatchObject({ status: "registered", planId });
  });

  it("projects OrderForked lineage and keeps the fork order an ordinary order that accepts signals", async () => {
    // fork 血缘：OrderForked 落 fork 单自己的行（forkLineage 含 parentOrderId
    // 与裁决信号），父单不回写；fork 单是普通订单——其上的 SignalSubmitted
    // 照常进 signals/timeline/proof，OrderForked 不落未知事件桶。
    const forkOrderId = bytes32Hex("c5");
    const events: readonly ChainEvent[] = [
      planRegistered(1n, planId, planHash),
      orderRegistered(2n, parentOrderId, planId),
      orderRegistered(3n, forkOrderId, planId),
      chainEvent(4n, 0, "OrderForked", {
        planId,
        orderId: forkOrderId,
        parentOrderId,
        approvalSourceId: bytes32Hex("8101"),
        approvalSignalId: bytes32Hex("8102"),
        initiator: signer
      }),
      signalSubmitted(5n, forkOrderId, planId, sourceId, signalId)
    ];

    const snapshot = rebuildOrderProjections(events);
    const fork = snapshot.stateMachineOrders[stateMachineScopedKey(chainId, stateMachineAddress, planId, forkOrderId)];
    expect(fork?.forkLineage).toMatchObject({
      orderId: forkOrderId,
      parentOrderId,
      approvalSourceId: bytes32Hex("8101"),
      approvalSignalId: bytes32Hex("8102"),
      initiator: signer
    });
    expect(fork?.status).toBe("registered");
    expect(fork?.signals[`${sourceId}:${signalId}`]).toMatchObject({ payloadHash, submitter: signer });
    const timelineNames = fork?.timeline.map((item) => item.eventName);
    expect(timelineNames).toContain("OrderRegistered");
    expect(timelineNames).toContain("OrderForked");
    expect(timelineNames).toContain("SignalSubmitted");

    const parent = snapshot.stateMachineOrders[stateMachineScopedKey(chainId, stateMachineAddress, planId, parentOrderId)];
    expect(parent?.forkLineage).toBeUndefined();
    expect(snapshot.unknownEventCount).toBe(0);
  });

  it("replays the same event stream twice into deeply equal snapshots (idempotent rebuild)", async () => {
    // 幂等对抗：同一条事件流（含 plan 发布、dock 挂接、投递台账、fork 血缘、
    // 信号、hook 状态）重建两次必须逐字段一致；store 重建路径与直接重放同构。
    const forkOrderId = bytes32Hex("c6");
    const events: readonly ChainEvent[] = [
      ...planPublishEvents(1n, planId, planHash, capabilitiesRootOf([], [])),
      planRegistered(2n, targetPlanId, targetPlanHash),
      orderRegistered(3n, parentOrderId, planId),
      orderRegistered(4n, targetOrderId, targetPlanId),
      moduleSet(5n),
      hookReady(6n, parentOrderId, hookId, planId),
      dockAttached(7n, dockInstanceId, parentOrderId, targetOrderId, routeId),
      chainEvent(8n, 0, "DockInputSubmitted", {
        dockInstanceId,
        linkedOrderId: targetOrderId,
        inputBindingHash: bindingHash("0e"),
        localPlanId: planId,
        localOrderId: parentOrderId,
        targetPlanId,
        targetSignalId: signalId,
        payloadHash,
        submitter: signer
      }, dockingModuleAddress),
      signalSubmitted(9n, targetOrderId, targetPlanId, sourceId, signalId),
      chainEvent(10n, 0, "DockOutputSubmitted", {
        dockInstanceId,
        linkedOrderId: targetOrderId,
        outputBindingHash: bindingHash("0f"),
        localPlanId: planId,
        localOrderId: parentOrderId,
        targetPlanId,
        targetSignalId: signalId,
        localSignalId: signalId,
        payloadHash,
        submitter: signer
      }, dockingModuleAddress),
      chainEvent(11n, 0, "OrderForked", {
        planId,
        orderId: forkOrderId,
        parentOrderId,
        approvalSourceId: bytes32Hex("8101"),
        approvalSignalId: bytes32Hex("8102"),
        initiator: signer
      }),
      signalSubmitted(12n, forkOrderId, planId, otherSourceId, otherSignalId),
      chainEvent(13n, 0, "TimerPoked", {
        orderId: parentOrderId,
        planId,
        hookId,
        dueAt: 0n
      })
    ];

    const first = rebuildOrderProjections(events);
    const second = rebuildOrderProjections(events);
    expect(second).toEqual(first);

    const store = new MemoryProjectionStore();
    const fromStoreFirst = await store.resetFromEvents({ deploymentBlock: 0n, events });
    const fromStoreSecond = await store.resetFromEvents({ deploymentBlock: 0n, events });
    expect(fromStoreSecond).toEqual(fromStoreFirst);
    expect(fromStoreFirst).toEqual(first);
  });

  it("drops a fork order that exists only through OrderForked when the birth log is reorged away", async () => {
    // fork 单出生只由 OrderForked 承载（补建路径）时，reorg 墓碑必须把
    // 该 fork 单从快照里同时摘除——投影是重放产物，不残留孤儿桶。
    const forkOrderId = bytes32Hex("c7");
    const forkedEvent = chainEvent(3n, 0, "OrderForked", {
      planId,
      orderId: forkOrderId,
      parentOrderId,
      approvalSourceId: bytes32Hex("8101"),
      approvalSignalId: bytes32Hex("8102"),
      initiator: signer
    });
    const base: readonly ChainEvent[] = [
      planRegistered(1n, planId, planHash),
      orderRegistered(2n, parentOrderId, planId)
    ];

    const withFork = rebuildOrderProjections([...base, forkedEvent]);
    const forkKey = stateMachineScopedKey(chainId, stateMachineAddress, planId, forkOrderId);
    expect(withFork.stateMachineOrders[forkKey]).toMatchObject({
      status: "registered",
      forkLineage: expect.objectContaining({ parentOrderId })
    });

    const rolled = rebuildOrderProjections([...base, forkedEvent, { ...forkedEvent, removed: true }]);
    expect(rolled.stateMachineOrders[forkKey]).toBeUndefined();
    expect(rolled.eventCount).toBe(2);
  });

  it("keeps the fork lineage when OrderForked arrives before the fork order's own OrderRegistered", async () => {
    // 乱序对抗：OrderForked 先补建 fork 单桶（血缘已落行），其后的
    // OrderRegistered（重放/同块排序差异）不得覆盖或清掉血缘——fork 单
    // 仍是带 forkLineage 的普通订单。
    const forkOrderId = bytes32Hex("c8");
    const events: readonly ChainEvent[] = [
      planRegistered(1n, planId, planHash),
      orderRegistered(2n, parentOrderId, planId),
      chainEvent(3n, 0, "OrderForked", {
        planId,
        orderId: forkOrderId,
        parentOrderId,
        approvalSourceId: bytes32Hex("8101"),
        approvalSignalId: bytes32Hex("8102"),
        initiator: signer
      }),
      orderRegistered(4n, forkOrderId, planId)
    ];

    const snapshot = rebuildOrderProjections(events);
    const fork = snapshot.stateMachineOrders[stateMachineScopedKey(chainId, stateMachineAddress, planId, forkOrderId)];
    expect(fork?.forkLineage).toMatchObject({ orderId: forkOrderId, parentOrderId });
    expect(fork?.status).toBe("registered");
    const timelineNames = fork?.timeline.map((item) => item.eventName);
    expect(timelineNames).toContain("OrderForked");
    expect(timelineNames).toContain("OrderRegistered");
  });

  it("counts delivery events for an unborn dock instance instead of silently dropping them", async () => {
    // 未出生 dock 的投递/满足事件（DockAttached 尚未发生或事件缺口）：
    // 显式计入 unresolvedDockEventCount，不静默丢弃、不崩溃；DockOpened
    // 的目标 plan 未登记时同样显式计入 unresolvedDockTargetDeploymentCount。
    const unknownDockInstance = bytes32Hex("e9");
    const childOrderId = bytes32Hex("c9");
    const events: readonly ChainEvent[] = [
      planRegistered(1n, planId, planHash),
      planRegistered(2n, targetPlanId, targetPlanHash),
      orderRegistered(3n, parentOrderId, planId),
      moduleSet(4n),
      chainEvent(5n, 0, "DockInputSubmitted", {
        dockInstanceId: unknownDockInstance,
        linkedOrderId: targetOrderId,
        inputBindingHash: bindingHash("10"),
        localPlanId: planId,
        localOrderId: parentOrderId,
        targetPlanId,
        targetSignalId: signalId,
        payloadHash,
        submitter: signer
      }, dockingModuleAddress),
      chainEvent(5n, 1, "DockOutputSubmitted", {
        dockInstanceId: unknownDockInstance,
        linkedOrderId: targetOrderId,
        outputBindingHash: bindingHash("11"),
        localPlanId: planId,
        localOrderId: parentOrderId,
        targetPlanId,
        targetSignalId: signalId,
        localSignalId: signalId,
        payloadHash,
        submitter: signer
      }, dockingModuleAddress),
      chainEvent(5n, 2, "DockOutputSatisfied", {
        dockInstanceId: unknownDockInstance,
        linkedOrderId: targetOrderId,
        outputBindingHash: bindingHash("12"),
        localPlanId: planId,
        localOrderId: parentOrderId,
        targetPlanId,
        targetSignalId: signalId,
        localSignalId: signalId,
        payloadHash,
        submitter: signer
      }, dockingModuleAddress),
      chainEvent(6n, 0, "DockOpened", {
        dockInstanceId: bytes32Hex("e8"),
        localOrderId: parentOrderId,
        linkedOrderId: childOrderId,
        interfaceNameId: bytes32Text("production_service"),
        localPlanId: planId,
        targetPlanId: unregisteredPlanId,
        routeId,
        routeHash: bytes32Hex("aa01"),
        depth: 1n,
        opener: signer
      }, dockingModuleAddress)
    ];

    const snapshot = rebuildOrderProjections(events);
    expect(snapshot.unresolvedDockEventCount).toBe(3);
    expect(snapshot.unresolvedDockTargetDeploymentCount).toBe(1);
    expect(snapshot.unresolvedModuleOrderEventCount).toBe(0);
    // 未出生实例不产生 dock 桶；已开启实例正常出生（目标 plan 未登记仍按
    // 链上事实补建子单桶）。
    expect(snapshot.stateMachineDocks[stateMachineScopedKey(chainId, stateMachineAddress, unknownDockInstance)])
      .toBeUndefined();
    expect(snapshot.stateMachineDocks[stateMachineScopedKey(chainId, stateMachineAddress, bytes32Hex("e8"))])
      .toMatchObject({ mode: "new", targetPlanId: unregisteredPlanId });
    expect(snapshot.stateMachineOrders[stateMachineScopedKey(chainId, stateMachineAddress, planId, parentOrderId)])
      .toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 造桩工具（黑盒：只构造链事件与 route 记录，不触碰内部实现）
// ---------------------------------------------------------------------------

async function buildWorker(options: {
  readonly events: readonly ChainEvent[];
  readonly routes: readonly DockRouteRecord[];
  readonly planCapabilityTables?: readonly PlanCapabilityTablesInput[];
  readonly planCapabilityResolutionFailures?: readonly Hex[];
  readonly now?: () => Date;
  readonly maxCandidatesPerRun?: number;
  readonly redeliveryWindowMs?: number;
  readonly submit?: (submission: DockAutomationSubmission) => Promise<Hex>;
}): Promise<{ readonly worker: DockAutomationWorker; readonly submitted: string[] }> {
  const store = new MemoryProjectionStore();
  await store.resetFromEvents({
    deploymentBlock: 0n,
    events: options.events,
    ...(options.planCapabilityTables ? { planCapabilityTables: options.planCapabilityTables } : {}),
    ...(options.planCapabilityResolutionFailures
      ? { planCapabilityResolutionFailures: options.planCapabilityResolutionFailures }
      : {})
  });
  const submitted: string[] = [];
  const worker = new DockAutomationWorker({
    config: {
      enabled: true,
      pollIntervalMs: 5_000,
      maxCandidatesPerRun: options.maxCandidatesPerRun ?? 8,
      redeliveryWindowMs: options.redeliveryWindowMs ?? 60_000
    },
    projectionStore: store,
    dockingAddress: dockingModuleAddress,
    chainId,
    routeSource: { listRoutes: async () => options.routes },
    submitter: {
      submit: options.submit ?? (async (submission) => {
        submitted.push(submission.data);
        return bytes32Hex(`feed${submitted.length}`);
      })
    },
    ...(options.now ? { now: options.now } : {})
  });
  return { worker, submitted };
}

/** existing 挂接基座：两 plan + 父/目标单出生 + 模块登记 + 指定父单 hooks Ready + DockAttached。 */
function attachedBase(hooks: readonly Hex[]): readonly ChainEvent[] {
  return [
    planRegistered(1n, planId, planHash),
    planRegistered(2n, targetPlanId, targetPlanHash),
    orderRegistered(3n, parentOrderId, planId),
    orderRegistered(4n, targetOrderId, targetPlanId),
    moduleSet(5n),
    ...hooks.map((hook, index) => hookReady(6n + BigInt(index), parentOrderId, hook, planId)),
    dockAttached(7n, dockInstanceId, parentOrderId, targetOrderId, routeId)
  ];
}

function existingRoute(input: {
  readonly routeId: Hex;
  readonly inputs: readonly DockRouteInputBinding[];
  readonly outputs?: readonly DockRouteOutputBinding[];
  readonly localOrderId?: Hex;
  readonly linkedOrderId?: Hex;
}): DockRouteRecord {
  return {
    chainId,
    localPlanId: planId,
    localOrderId: input.localOrderId ?? parentOrderId,
    targetPlanId,
    linkedOrderId: input.linkedOrderId ?? targetOrderId,
    routeId: input.routeId,
    routeHash: bytes32Hex("aa01"),
    interfaceName: "production_service",
    orderMode: "existing",
    attachCalldata: "0xabef5678" as Hex,
    inputs: input.inputs,
    outputs: input.outputs ?? []
  };
}

function inputBinding(
  tag: string,
  localHookId: Hex,
  targetSourceId: Hex,
  targetSignalId: Hex
): DockRouteInputBinding {
  return { bindingHash: bindingHash(tag), localHookId, targetSourceId, targetSignalId };
}

function outputBinding(
  tag: string,
  localSourceId: Hex,
  localSignalId: Hex,
  targetSourceId: Hex,
  targetSignalId: Hex
): DockRouteOutputBinding {
  return { bindingHash: bindingHash(tag), localSourceId, localSignalId, targetSourceId, targetSignalId };
}

/** 两步发布的真实链序：PlanCommitted → PlanPublisherRecorded → PlanFinalized → PlanRegistered。 */
function planPublishEvents(
  startBlock: bigint,
  publishedPlanId: Hex,
  publishedPlanHash: Hex,
  capabilitiesRoot: Hex
): readonly ChainEvent[] {
  return [
    chainEvent(startBlock, 0, "PlanCommitted", {
      planId: publishedPlanId,
      planHash: publishedPlanHash,
      publisher: signer,
      hooksHash: bytes32Hex("0e01"),
      capabilitiesRoot,
      hookCount: 1n,
      dockRoutesRoot: bytes32Hex("0e03"),
      dockInterfaceRoot: bytes32Hex("0e04")
    }),
    chainEvent(startBlock, 1, "PlanPublisherRecorded", {
      planId: publishedPlanId,
      publisher: signer
    }),
    chainEvent(startBlock + 1n, 0, "PlanFinalized", {
      planId: publishedPlanId,
      planHash: publishedPlanHash,
      capabilitiesRoot
    }),
    chainEvent(startBlock + 1n, 1, "PlanRegistered", {
      planId: publishedPlanId,
      planHash: publishedPlanHash,
      hookCount: 1n
    })
  ];
}

function planRegistered(block: bigint, registeredPlanId: Hex, registeredPlanHash: Hex): ChainEvent {
  return chainEvent(block, 0, "PlanRegistered", {
    planId: registeredPlanId,
    planHash: registeredPlanHash,
    hookCount: 1n
  });
}

function orderRegistered(block: bigint, order: Hex, orderPlanId: Hex, logIndex = 0): ChainEvent {
  return chainEvent(block, logIndex, "OrderRegistered", { orderId: order, planId: orderPlanId });
}

function hookReady(block: bigint, order: Hex, hook: Hex, orderPlanId: Hex, logIndex = 0): ChainEvent {
  return chainEvent(block, logIndex, "HookStatusChanged", {
    orderId: order,
    planId: orderPlanId,
    hookId: hook,
    previousStatus: 0,
    newStatus: 2,
    dueAt: 0n
  });
}

function signalSubmitted(
  block: bigint,
  order: Hex,
  orderPlanId: Hex,
  factSourceId: Hex,
  factSignalId: Hex
): ChainEvent {
  return chainEvent(block, 0, "SignalSubmitted", {
    orderId: order,
    planId: orderPlanId,
    sourceId: factSourceId,
    signalId: factSignalId,
    payloadHash,
    idempotencyKey,
    submitter: signer
  });
}

function moduleSet(block: bigint): ChainEvent {
  return chainEvent(block, 0, "StateMachineModuleSet", {
    moduleId: bytes32Text("uvp.module.docking.v1"),
    previousModule: zeroAddress,
    newModule: dockingModuleAddress
  });
}

function dockAttached(
  block: bigint,
  instance: Hex,
  localOrder: Hex,
  linkedOrder: Hex,
  attachedRouteId: Hex,
  logIndex = 0
): ChainEvent {
  return chainEvent(block, logIndex, "DockAttached", {
    dockInstanceId: instance,
    localOrderId: localOrder,
    linkedOrderId: linkedOrder,
    interfaceNameId: bytes32Text("production_service"),
    localPlanId: planId,
    targetPlanId,
    routeId: attachedRouteId,
    routeHash: bytes32Hex("aa01"),
    depth: 1n,
    attacher: signer
  }, dockingModuleAddress);
}

function chainEvent(
  blockNumber: bigint,
  logIndex: number,
  eventName: string,
  args: Record<string, unknown>,
  eventContractAddress: Hex = stateMachineAddress
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

function bindingHash(tag: string): Hex {
  return bytes32Hex(tag);
}

function bytes32Hex(value: string): Hex {
  return `0x${value.padStart(64, "0")}` as Hex;
}

function bytes32Text(value: string): Hex {
  return `0x${Buffer.from(value, "utf8").toString("hex").padEnd(64, "0")}` as Hex;
}
