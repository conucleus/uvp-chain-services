/**
 * 链轨 chaos Stage 3：reorg 合成车道（消费者侧）。
 *
 * 不依赖 anvil 原生 reorg RPC——直接构造含 `removed:true`、乱序、重复的
 * 日志流喂索引器的墓碑/复活过滤与投影重建，断言：
 * - 墓碑把同位事件移出活跃集；复活（removed 后同位事件再现）抵消墓碑；
 * - `removedLogsFiltered` 只在终态真丢失事件时为 true（诚实口径）；
 * - sortChainEvents 规范序：乱序流排出链序、等位事件保输入相对序；
 * - 活跃集重放投影幂等：重复事件行进事件面后投影不变（timeline 长度在
 *   比较面内，去重失效即翻红）且重复行计数入异常面；
 * - 「好流」与「坏流 + 墓碑」终态一致（reorg 语义等价性）；
 * - 游标单调性（sortChainEvents 规范序不回退）。
 *
 * 合成事件形状对齐 viem-event-source 解码面：indexed 首参 planId 进
 * StageMaterialized/HookStatusChanged/HookReady 的 args；PlanCommitted
 * 携 executorCandidatesRoot（第六承诺域）。
 */
import { describe, expect, it } from "vitest";
import {
  buildActiveChainEventReplaySummary,
  chainEventKey,
  filterActiveChainEvents,
  sortChainEvents,
  type ChainEvent,
} from "../src/indexer/events.js";
import { countDuplicateActiveEventAnomalies, rebuildOrderProjections } from "../src/indexer/replay.js";
import { compareChainPointers } from "../src/shared/types.js";

const contractAddress = "0x" + "24".repeat(20);
const planId = "0x0000000000000000000000000000000000000000000000000000000000000101";
const planHash = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const orderId = "0x0000000000000000000000000000000000000000000000000000000000000202";
const hookId = "0x0000000000000000000000000000000000000000000000000000000000000303";
const stageId = "0x0000000000000000000000000000000000000000000000000000000000000606";
const hookName = "0x0000000000000000000000000000000000000000000000000000000000000707";
const sourceId = "0x0000000000000000000000000000000000000000000000000000000000000404";
const signalId = "0x0000000000000000000000000000000000000000000000000000000000000505";
const payloadHash = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const idempotencyKey = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const signer = "0x4444444444444444444444444444444444444444";
const executorCandidatesRoot = "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
const dueAt = 99n;

function chainEvent(
  blockNumber: bigint,
  logIndex: number,
  eventName: string,
  args: Record<string, unknown>,
  overrides: Partial<Pick<ChainEvent, "transactionHash" | "removed" | "transactionIndex">> = {}
): ChainEvent {
  return {
    chainId: 31337,
    contractAddress: contractAddress as ChainEvent["contractAddress"],
    blockNumber,
    transactionHash: `0x${blockNumber.toString(16).padStart(64, "0")}`,
    logIndex,
    eventName,
    args,
    ...overrides,
  };
}

/** 与 indexer.replay.test.ts 的 stateMachineEvents 同口径（含 plan 两步发布前奏）。 */
function goodStream(): ChainEvent[] {
  return [
    chainEvent(1n, 0, "PlanCommitted", {
      planId,
      planHash,
      publisher: signer,
      hooksHash: "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      capabilitiesRoot: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      hookCount: 1n,
      dockRoutesRoot: "0x0000000000000000000000000000000000000000000000000000000000000000",
      dockInterfaceRoot: "0x0000000000000000000000000000000000000000000000000000000000000000",
      executorCandidatesRoot,
    }),
    chainEvent(1n, 1, "PlanPublisherRecorded", { planId, publisher: signer }),
    chainEvent(2n, 0, "PlanFinalized", {
      planId,
      planHash,
      capabilitiesRoot: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    }),
    chainEvent(2n, 1, "PlanRegistered", { planId, planHash, hookCount: 1n }),
    chainEvent(3n, 0, "OrderRegistered", { planId, orderId }),
    chainEvent(4n, 0, "SignalSubmitted", {
      planId,
      orderId,
      sourceId,
      signalId,
      payloadHash,
      idempotencyKey,
      submitter: signer,
    }),
    chainEvent(4n, 1, "OrderMaterialized", { orderId, planId, stageId }),
    chainEvent(4n, 2, "StageMaterialized", {
      planId,
      orderId,
      stageId,
      triggerHookId: hookId,
      sourceId,
      signalId,
    }),
    chainEvent(5n, 0, "HookStatusChanged", {
      planId,
      orderId,
      hookId,
      previousStatus: 0n,
      newStatus: 1n,
      dueAt,
    }),
    chainEvent(5n, 1, "HookReady", { planId, orderId, hookId, stageId, hookName }),
  ];
}

describe("reorg synthetic lane: canonical ordering", () => {
  it("sortChainEvents orders an out-of-order stream into canonical chain order", () => {
    const blockSix = chainEvent(6n, 5, "OrderMaterialized", { orderId, planId, stageId });
    const blockSevenLate = chainEvent(7n, 3, "SignalSubmitted", {
      planId,
      orderId,
      sourceId,
      signalId,
      payloadHash,
      idempotencyKey,
      submitter: signer,
    });
    const blockSevenEarly = chainEvent(7n, 1, "StageMaterialized", {
      planId,
      orderId,
      stageId,
      triggerHookId: hookId,
      sourceId,
      signalId,
    });
    const blockEightTxLater = chainEvent(8n, 0, "TimerPoked", { planId, orderId, hookId, dueAt }, {
      transactionIndex: 4,
    });
    const blockEightTxEarly = chainEvent(8n, 0, "TimerPoked", { planId, orderId, hookId, dueAt }, {
      transactionIndex: 2,
    });
    const stream = [blockSix, blockSevenEarly, blockSevenLate, blockEightTxEarly, blockEightTxLater];
    const shuffled = [
      blockEightTxLater,
      blockSevenLate,
      blockEightTxEarly,
      blockSevenEarly,
      blockSix,
    ];
    const sorted = sortChainEvents(shuffled);
    expect(sorted.map(eventKey)).toEqual(stream.map(eventKey));
    for (let i = 1; i < sorted.length; i += 1) {
      expect(compareChainPointers(sorted[i - 1]!, sorted[i]!)).toBeLessThanOrEqual(0);
    }
    // 规范序是幂等的固定点：排序后的流再排不变（游标不回退）。
    expect(sortChainEvents(sorted).map(eventKey)).toEqual(sorted.map(eventKey));
  });

  it("sortChainEvents is stable for equal pointers", () => {
    const base = {
      planId,
      orderId,
      hookId,
      previousStatus: 0n,
      newStatus: 1n,
      dueAt,
    };
    const first = chainEvent(9n, 2, "HookStatusChanged", base);
    const second = chainEvent(9n, 2, "HookStatusChanged", { ...base, dueAt: 199n });
    expect(compareChainPointers(first, second)).toBe(0);
    const sorted = sortChainEvents([second, first]);
    expect(sorted[0]).toBe(second);
    expect(sorted[1]).toBe(first);
    const roundTwo = sortChainEvents([first, second]);
    expect(roundTwo[0]).toBe(first);
    expect(roundTwo[1]).toBe(second);
  });
});

describe("reorg synthetic lane: tombstone/revive filter", () => {
  it("removed tombstone removes the same-position event from the active set", () => {
    const stream = goodStream();
    const victim = stream[3] as ChainEvent;
    const summary = buildActiveChainEventReplaySummary([...stream, { ...victim, removed: true }]);
    expect(summary.removedEventCount).toBe(1);
    expect(summary.removedLogsFiltered).toBe(true);
    expect(
      summary.activeEvents.some(
        (event) =>
          event.blockNumber === victim.blockNumber &&
          event.logIndex === victim.logIndex &&
          event.transactionHash === victim.transactionHash
      )
    ).toBe(false);
  });

  it("revival cancels the tombstone and the honest metric stays false", () => {
    const stream = goodStream();
    const victim = stream[3] as ChainEvent;
    const revived = [...stream, { ...victim, removed: true }, victim];
    const summary = buildActiveChainEventReplaySummary(revived);
    expect(summary.removedEventCount).toBe(1);
    expect(summary.removedLogsFiltered).toBe(false);
    expect(summary.activeEventCount).toBe(stream.length);
    expect(filterActiveChainEvents(revived)).toEqual(filterActiveChainEvents(stream));
  });

  it("out-of-order and duplicated logs converge to the same active set", () => {
    const stream = goodStream();
    const shuffled = [...stream].reverse();
    const duplicated = [...stream, ...stream];
    const canonical = filterActiveChainEvents(stream).map(eventKey);
    expect(filterActiveChainEvents(shuffled).map(eventKey)).toEqual(canonical);
    expect(filterActiveChainEvents(duplicated).map(eventKey)).toEqual(canonical);
  });

  it("tombstoning the reorged suffix then replaying the good suffix equals the good stream", () => {
    const stream = goodStream();
    const reorgedSuffix = stream.slice(3) as ChainEvent[];
    // reorg 后 canonical 链重放出同位事件：交易哈希换了（新块新序），
    // 但事件语义内容（eventName + blockNumber:logIndex + args）不变——
    // 等价性按内容判，不按 txHash 键判。
    const reorgStream: ChainEvent[] = [
      ...(stream.slice(0, 3) as ChainEvent[]),
      ...reorgedSuffix.map((event) => ({ ...event, removed: true })),
      ...reorgedSuffix.map((event) => ({
        ...event,
        transactionHash: `0x${(event.blockNumber + 10n).toString(16).padStart(64, "0")}` as const,
      })),
    ];
    expect(filterActiveChainEvents(reorgStream).map(eventContent)).toEqual(
      filterActiveChainEvents(stream).map(eventContent)
    );
  });
});

describe("reorg synthetic lane: projection idempotence", () => {
  it("duplicate rows marching through the event list leave projections unchanged and are counted", () => {
    const stream = goodStream();
    const duplicated = [...stream, ...stream];
    // 重复行进事件面：每一行重复都是一次可观测异常（事件去重计数）。
    expect(countDuplicateActiveEventAnomalies(duplicated)).toBe(stream.length);
    const snapshot = rebuildOrderProjections(duplicated);
    expect(snapshot.eventCount).toBe(stream.length);
    // 比较面含 timeline 长度：去重失效会让时间线翻倍翻红，不是恒真断言。
    expect(orderSnapshots(snapshot)).toEqual(orderSnapshots(rebuildOrderProjections(stream)));
  });

  it("tombstoned HookStatusChanged projection equals the stream without it", () => {
    const stream = goodStream();
    const victim = stream[8] as ChainEvent;
    const withTombstone = [...stream, { ...victim, removed: true }];
    const withoutVictim = stream.filter((event) => event !== victim);
    // 损伤金丝雀：比较面能看到该事件的投影足迹（dueAt/timeline 长度），
    // 去掉 victim 的投影必须先与好流可区分，等价断言才有红绿含义。
    expect(orderSnapshots(rebuildOrderProjections(filterActiveChainEvents(withoutVictim)))).not.toEqual(
      orderSnapshots(rebuildOrderProjections(filterActiveChainEvents(stream)))
    );
    expect(orderSnapshots(rebuildOrderProjections(filterActiveChainEvents(withTombstone)))).toEqual(
      orderSnapshots(rebuildOrderProjections(filterActiveChainEvents(withoutVictim)))
    );
  });

  it("tombstoned HookReady projection equals the stream without it", () => {
    const stream = goodStream();
    const victim = stream[9] as ChainEvent;
    const withTombstone = [...stream, { ...victim, removed: true }];
    const withoutVictim = stream.filter((event) => event !== victim);
    // 损伤金丝雀：HookReady 缺席时钩子状态停在 waiting 而非 ready。
    expect(orderSnapshots(rebuildOrderProjections(filterActiveChainEvents(withoutVictim)))).not.toEqual(
      orderSnapshots(rebuildOrderProjections(filterActiveChainEvents(stream)))
    );
    expect(orderSnapshots(rebuildOrderProjections(filterActiveChainEvents(withTombstone)))).toEqual(
      orderSnapshots(rebuildOrderProjections(filterActiveChainEvents(withoutVictim)))
    );
  });
});

function eventKey(event: ChainEvent): string {
  return `${event.blockNumber}:${event.transactionHash}:${event.logIndex}`;
}

function eventContent(event: ChainEvent): string {
  return `${event.eventName}@${event.blockNumber}:${event.logIndex}:${JSON.stringify(
    event.args,
    (_key, value) => (typeof value === "bigint" ? value.toString() : value)
  )}`;
}

function orderSnapshots(projections: ReturnType<typeof rebuildOrderProjections>): unknown {
  return JSON.parse(
    JSON.stringify(
      Object.entries(projections.stateMachineOrders).map(([key, order]) => ({
        key,
        orderId: order.orderId,
        hooks: Object.entries(order.hooks).map(([hookKey, hook]) => ({
          hookKey,
          status: hook.status,
          dueAt: hook.dueAt === undefined ? null : hook.dueAt.toString(),
        })),
        signals: Object.keys(order.signals).sort(),
        timelineLength: order.timeline.length,
        timelineTexts: order.timeline.map((entry) => entry.text),
      })),
      (_key, value) => (typeof value === "bigint" ? value.toString() : value)
    )
  );
}
