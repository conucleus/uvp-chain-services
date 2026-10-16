/**
 * 链轨 chaos Stage 3：reorg 合成车道（消费者侧）。
 *
 * 不依赖 anvil 原生 reorg RPC——直接构造含 `removed:true`、乱序、重复的
 * 日志流喂索引器的墓碑/复活过滤与投影重建，断言：
 * - 墓碑把同位事件移出活跃集；复活（removed 后同位事件再现）抵消墓碑；
 * - `removedLogsFiltered` 只在终态真丢失事件时为 true（诚实口径）；
 * - 活跃集重放投影幂等：同流重放两次投影全等；
 * - 「好流」与「坏流 + 墓碑」终态一致（reorg 语义等价性）；
 * - 游标单调性（sortChainEvents 规范序不回退）。
 */
import { describe, expect, it } from "vitest";
import {
  buildActiveChainEventReplaySummary,
  filterActiveChainEvents,
  type ChainEvent,
} from "../src/indexer/events.ts";
import { rebuildOrderProjections } from "../src/indexer/replay.ts";

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
      orderId,
      stageId,
      triggerHookId: hookId,
      sourceId,
      signalId,
    }),
    chainEvent(5n, 0, "HookStatusChanged", {
      orderId,
      hookId,
      previousStatus: 0n,
      newStatus: 2n,
      dueAt: 0n,
    }),
    chainEvent(5n, 1, "HookReady", { orderId, hookId, stageId, hookName }),
  ];
}

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
  it("replaying the same active stream twice yields identical projections", () => {
    const stream = goodStream();
    const first = rebuildOrderProjections(filterActiveChainEvents(stream));
    const second = rebuildOrderProjections(filterActiveChainEvents([...stream, ...stream]));
    expect(orderSnapshots(second)).toEqual(orderSnapshots(first));
  });

  it("tombstoned stream projection equals the stream without the tombstoned event", () => {
    const stream = goodStream();
    const victim = stream[4] as ChainEvent;
    const withTombstone = [...stream, { ...victim, removed: true }];
    const withoutVictim = stream.filter((event) => event !== victim);
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
      })),
      (_key, value) => (typeof value === "bigint" ? value.toString() : value)
    )
  );
}
