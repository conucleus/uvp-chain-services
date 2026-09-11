import { compareChainPointers, type ChainPointer, type Hex } from "../shared/types.js";

export type EventArgs = Readonly<Record<string, unknown>>;

export interface ChainEvent<TArgs extends EventArgs = EventArgs> extends ChainPointer {
  readonly eventName: string;
  readonly args: TArgs;
  readonly removed?: boolean;
}

export interface ActiveChainEventReplaySummary<TEvent extends ChainEvent = ChainEvent> {
  readonly activeEvents: readonly TEvent[];
  readonly activeEventCount: number;
  readonly removedEventCount: number;
  /**
   * honest metric — true only when this replay's final active set actually
   * lost at least one event to a `removed` tombstone（终态仍被过滤的事件
   * id 数 > 0）。被复活抵消的墓碑（removed 后同位事件重新出现）不计入：
   * 那种回合活跃集没有任何丢失，报 true 会虚标"发生过过滤"。
   * removedEventCount 则保留"见过多少墓碑"的原始口径。
   */
  readonly removedLogsFiltered: boolean;
}

export interface EventCursor {
  readonly chainId: number;
  readonly deploymentBlock: bigint;
  readonly nextBlock: bigint;
  readonly finalizedBlock?: bigint;
  /**
   * cursor 高度（nextBlock - 1）区块的哈希。下一次追加前用它做
   * 哈希连续性校验；缺失（cursor 未持久化哈希或事件源不支持）时跳过校验。
   */
  readonly blockHash?: Hex;
}

export function chainEventKey(event: ChainEvent): string {
  return [
    event.chainId,
    event.contractAddress.toLowerCase(),
    event.blockNumber.toString(),
    event.transactionHash.toLowerCase(),
    event.logIndex
  ].join(":");
}

export function compareChainEvents(left: ChainEvent, right: ChainEvent): number {
  const position = compareChainPointers(left, right);
  if (position !== 0) {
    return position;
  }
  const contractCompare = left.contractAddress.localeCompare(right.contractAddress);
  if (contractCompare !== 0) {
    return contractCompare;
  }
  return 0;
}

export function sortChainEvents<TEvent extends ChainEvent>(events: readonly TEvent[]): TEvent[] {
  return [...events].sort(compareChainEvents);
}

export function filterActiveChainEvents<TEvent extends ChainEvent>(events: readonly TEvent[]): TEvent[] {
  return [...buildActiveChainEventReplaySummary(events).activeEvents];
}

export function buildActiveChainEventReplaySummary<TEvent extends ChainEvent>(
  events: readonly TEvent[]
): ActiveChainEventReplaySummary<TEvent> {
  const activeByEventId = new Map<string, TEvent>();
  const removedEventIds = new Set<string>();
  let removedEventCount = 0;

  for (const event of sortChainEvents(events)) {
    const eventId = chainEventKey(event);
    if (event.removed === true) {
      // removed 墓碑：把同位事件移出活跃 replay。
      removedEventIds.add(eventId);
      removedEventCount += 1;
      activeByEventId.delete(eventId);
      continue;
    }
    // 复活：同 (block,txHash,logIndex) 的非 removed 事件在此之后出现，
    // 覆盖先前的 removed 墓碑。墓碑只用于过滤“曾 removed 且此后未复活”
    // 的窗口，不得把 reorg 后重新出现的同位事件永久跳过。
    removedEventIds.delete(eventId);
    activeByEventId.set(eventId, event);
  }

  const activeEvents = sortChainEvents([...activeByEventId.values()]);
  return {
    activeEvents,
    activeEventCount: activeEvents.length,
    removedEventCount,
    // 终态仍留在 removedEventIds 里的事件 = 墓碑未复活 = 真正被过滤。
    removedLogsFiltered: removedEventIds.size > 0
  };
}
