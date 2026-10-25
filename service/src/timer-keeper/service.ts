import type { ProjectionStore } from "../storage/projection-store.js";
import { ConfigError, noopLogger, type Hex, type LifecycleService, type Logger } from "../shared/types.js";
import { redactErrorMessage } from "../security/redaction.js";
import type { ChainClock } from "../shared/chain-clock.js";
import { findErrorName } from "../shared/broadcast/kit.js";
import {
  TimerPokeReceiptRevertedError,
  type TimerKeeperConfig,
  type TimerKeeperRunSummary,
  type TimerKeeperSubmitter
} from "./types.js";

export class TimerKeeperWorker implements LifecycleService {
  readonly name = "timer-keeper";

  readonly #config: TimerKeeperConfig;
  readonly #projectionStore: ProjectionStore;
  readonly #stateMachineAddress: Hex;
  readonly #chainId: number;
  readonly #submitter: TimerKeeperSubmitter | undefined;
  readonly #logger: Logger;
  readonly #now: () => Date;
  readonly #chainClock: ChainClock | undefined;
  #timer: NodeJS.Timeout | undefined;
  #running = false;
  #checking = false;
  #lastSummary: TimerKeeperRunSummary | undefined;
  readonly #lastBroadcastAt = new Map<string, number>();
  readonly #failureWindows = new Map<string, { windows: number }>();

  constructor(options: {
    readonly config: TimerKeeperConfig;
    readonly projectionStore: ProjectionStore;
    readonly stateMachineAddress: Hex;
    readonly chainId: number;
    readonly submitter?: TimerKeeperSubmitter;
    readonly logger?: Logger;
    readonly now?: () => Date;
    readonly chainClock?: ChainClock;
  }) {
    this.#config = options.config;
    this.#projectionStore = options.projectionStore;
    this.#stateMachineAddress = options.stateMachineAddress;
    this.#chainId = options.chainId;
    this.#submitter = options.submitter;
    this.#logger = options.logger ?? noopLogger;
    this.#now = options.now ?? (() => new Date());
    this.#chainClock = options.chainClock;
  }

  async start(): Promise<void> {
    if (!this.#config.enabled || this.#running) {
      return;
    }
    if (!this.#submitter) {
      this.#logger.warn(
        "timer keeper is enabled but no submitter is wired; the keeper stays idle until the assembly provides one"
      );
      return;
    }
    if (this.#config.maxCandidatesPerRun <= 0) {
      throw new ConfigError(
        "UVP_TIMER_KEEPER_MAX_CANDIDATES_PER_RUN must be positive when the timer keeper is enabled (0 would silently disable every run)"
      );
    }
    if (this.#config.redeliveryWindowMs <= 0) {
      throw new ConfigError(
        "UVP_TIMER_KEEPER_REDELIVERY_WINDOW_MS must be positive when the timer keeper is enabled (0 disables deduplication and re-broadcasts every run)"
      );
    }
    this.#running = true;
    if (this.#config.pollIntervalMs <= 0) {
      this.#logger.warn(
        "timer keeper polling is disabled (UVP_TIMER_KEEPER_POLL_INTERVAL_MS<=0): no timer candidate will ever be poked until the interval is positive"
      );
      return;
    }
    this.#timer = setInterval(() => {
      void this.runOnce().catch((error) => {
        this.#logger.warn(`timer keeper run failed: ${redactErrorMessage(error)}`);
      });
    }, this.#config.pollIntervalMs);
    this.#timer.unref?.();
    this.#logger.info("timer keeper worker started");
  }

  async stop(): Promise<void> {
    if (!this.#running) {
      return;
    }
    this.#running = false;
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    this.#logger.info("timer keeper worker stopped");
  }

  getLastSummary(): TimerKeeperRunSummary | undefined {
    return this.#lastSummary;
  }

  async runOnce(): Promise<TimerKeeperRunSummary> {
    if (!this.#config.enabled || this.#checking) {
      return emptySummary();
    }
    this.#checking = true;
    try {
      const snapshot = await this.#projectionStore.getOrderSnapshot();
      const syncState = await this.#projectionStore.getSyncState();
      const finalizedBlock = syncState?.finalizedBlock;
      const summary: TimerKeeperRunSummary = {
        scannedOrders: 0,
        waitingHooks: 0,
        pokeCandidates: 0,
        attempted: 0,
        submitted: 0,
        receiptReverted: 0,
        receiptUnknown: 0,
        deduplicated: 0,
        converged: [],
        skipped: []
      };
      if (finalizedBlock === undefined) {
        summary.skipped.push(
          "finality: projection sync state carries no finalizedBlock; no timer candidate is released this run"
        );
        this.#lastSummary = summary;
        return summary;
      }
      if (syncState?.syncStatus === "rebuilding") {
        summary.skipped.push(
          "finality: projection rebuild is in progress; no timer candidate is released this run"
        );
        this.#lastSummary = summary;
        return summary;
      }
      if (!this.#chainClock) {
        throw new ConfigError(
          "timer keeper requires a chain clock (latest block timestamp) to judge hook dueAt; wire the chainClock option"
        );
      }
      const nowSeconds = BigInt(await this.#chainClock.latestBlockTimestampSeconds());
      const candidates: {
        readonly key: string;
        readonly planId: Hex;
        readonly orderId: Hex;
        readonly hookId: Hex;
      }[] = [];
      for (const order of [...new Set(Object.values(snapshot.stateMachineOrders))]) {
        if (
          order.chainId !== this.#chainId ||
          order.contractAddress.toLowerCase() !== this.#stateMachineAddress.toLowerCase()
        ) {
          continue;
        }
        summary.scannedOrders += 1;
        for (const hook of Object.values(order.hooks)) {
          if (hook.status !== "waiting") {
            continue;
          }
          summary.waitingHooks += 1;
          if (!hook.dueAt || BigInt(hook.dueAt) > nowSeconds) {
            continue;
          }
          if (hook.updatedAt.blockNumber > finalizedBlock) {
            continue;
          }
          candidates.push({
            key: `${this.#chainId}:${order.contractAddress.toLowerCase()}:${order.planId.toLowerCase()}:${order.orderId.toLowerCase()}:${hook.hookId.toLowerCase()}`,
            planId: order.planId,
            orderId: order.orderId,
            hookId: hook.hookId
          });
        }
      }
      summary.pokeCandidates = candidates.length;
      const submitter = this.#submitter;
      if (!submitter || candidates.length === 0) {
        this.#evictStaleTracking(candidates, this.#now().getTime());
        this.#lastSummary = summary;
        return summary;
      }
      for (const candidate of candidates) {
        if (summary.attempted >= this.#config.maxCandidatesPerRun) {
          break;
        }
        const nowMs = this.#now().getTime();
        const lastBroadcastAt = this.#lastBroadcastAt.get(candidate.key);
        if (
          lastBroadcastAt !== undefined &&
          nowMs - lastBroadcastAt < this.#config.redeliveryWindowMs
        ) {
          summary.deduplicated += 1;
          continue;
        }
        summary.attempted += 1;
        this.#lastBroadcastAt.set(candidate.key, nowMs);
        try {
          const outcome = await submitter.pokeTimer({
            planId: candidate.planId,
            orderId: candidate.orderId,
            hookId: candidate.hookId,
            ...(this.#config.maxGasPerTx ? { gas: this.#config.maxGasPerTx } : {})
          });
          summary.submitted += 1;
          if (outcome.receipt === "unknown") {
            summary.receiptUnknown += 1;
            const streak = this.#failureWindows.get(candidate.key);
            const windows = streak ? streak.windows + 1 : 1;
            this.#failureWindows.set(candidate.key, { windows });
            if (windows >= FAILURE_ESCALATION_WINDOWS) {
              this.#logger.error(
                `timer keeper poke receipt has stayed unreadable for ${windows} consecutive redelivery windows; manual adjudication is required (check the keeper RPC or the transaction receipt scanner)`,
                {
                  planId: candidate.planId,
                  orderId: candidate.orderId,
                  hookId: candidate.hookId,
                  windows
                }
              );
            }
          } else {
            this.#failureWindows.delete(candidate.key);
          }
        } catch (error) {
          const message = redactErrorMessage(error);
          if (error instanceof TimerPokeReceiptRevertedError) {
            summary.receiptReverted += 1;
          }
          const convergedReason = convergedRevertReasonOf(error, message);
          if (convergedReason) {
            summary.converged.push(
              `poke:${candidate.orderId}:${candidate.hookId}:${convergedReason}`
            );
            this.#failureWindows.delete(candidate.key);
            continue;
          }
          summary.skipped.push(`poke:${candidate.orderId}:${candidate.hookId}:${message}`);
          const streak = this.#failureWindows.get(candidate.key);
          const windows = streak ? streak.windows + 1 : 1;
          this.#failureWindows.set(candidate.key, { windows });
          if (windows < FAILURE_ESCALATION_WINDOWS) {
            continue;
          }
          this.#logger.error(
            `timer keeper poke has failed for ${windows} consecutive redelivery windows; manual adjudication is required (check the keeper gas role, the RPC, or the projected hook state)`,
            {
              planId: candidate.planId,
              orderId: candidate.orderId,
              hookId: candidate.hookId,
              windows
            }
          );
        }
      }
      this.#evictStaleTracking(candidates, this.#now().getTime());
      this.#lastSummary = summary;
      return summary;
    } finally {
      this.#checking = false;
    }
  }

  #evictStaleTracking(
    candidates: readonly { readonly key: string }[],
    nowMs: number
  ): void {
    const liveKeys = new Set(candidates.map((candidate) => candidate.key));
    const evictionHorizonMs = 4 * this.#config.redeliveryWindowMs;
    for (const [key, lastBroadcastAt] of this.#lastBroadcastAt) {
      if (!liveKeys.has(key) || nowMs - lastBroadcastAt > evictionHorizonMs) {
        this.#lastBroadcastAt.delete(key);
        this.#failureWindows.delete(key);
      }
    }
  }
}

const CONVERGED_REVERT = /TimerNotWaiting|TimerNotDue/;

const FAILURE_ESCALATION_WINDOWS = 3;

function convergedRevertReasonOf(error: unknown, redactedMessage: string): string | undefined {
  const errorName = findErrorName(error);
  if (errorName && CONVERGED_REVERT.test(errorName)) {
    return errorName;
  }
  return CONVERGED_REVERT.exec(redactedMessage)?.[0];
}

function emptySummary(): TimerKeeperRunSummary {
  return {
    scannedOrders: 0,
    waitingHooks: 0,
    pokeCandidates: 0,
    attempted: 0,
    submitted: 0,
    receiptReverted: 0,
    receiptUnknown: 0,
    deduplicated: 0,
    converged: [],
    skipped: []
  };
}
