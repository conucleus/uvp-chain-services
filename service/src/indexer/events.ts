import { compareChainPointers, type ChainPointer } from "../shared/types.js";

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
   * Audit #33: honest metric — true only when this replay actually filtered at
   * least one `removed` log (removedEventCount > 0). It never reports a
   * vacuous true for replays that saw no removed logs at all.
   */
  readonly removedLogsFiltered: boolean;
}

export interface EventCursor {
  readonly chainId: number;
  readonly deploymentBlock: bigint;
  readonly nextBlock: bigint;
  readonly finalizedBlock?: bigint;
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
      removedEventIds.add(eventId);
      removedEventCount += 1;
      activeByEventId.delete(eventId);
      continue;
    }
    if (removedEventIds.has(eventId)) {
      continue;
    }
    activeByEventId.set(eventId, event);
  }

  const activeEvents = sortChainEvents([...activeByEventId.values()]);
  return {
    activeEvents,
    activeEventCount: activeEvents.length,
    removedEventCount,
    removedLogsFiltered: removedEventCount > 0
  };
}
