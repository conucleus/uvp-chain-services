import type { ProjectionStore } from "../storage/projection-store.js";
import { noopLogger, type Hex, type LifecycleService, type Logger } from "../shared/types.js";
import { redactErrorMessage } from "../security/redaction.js";
import { findErrorName } from "../shared/broadcast/kit.js";
import type {
  TimerKeeperConfig,
  TimerKeeperRunSummary,
  TimerKeeperSubmitter
} from "./types.js";

/**
 * 链上时钟拨表 keeper（keeper 只提供活性）。
 *
 * 候选发现完全来自投影：order.hooks 里 status=waiting 且 dueAt≤now 的
 * hook，pokeTimer(planId, orderId, hookId) 与 submissions 写面同属
 * UVPStateMachine。keeper 是 relayer 代付面——链上时钟拨表不是业务签名
 * 面（与 dock keeper 的 submitDockedInput 同族），参与者密钥零参与。
 *
 * 守门与收敛口径镜像合约（statemachine/src/chain.ts 的 TimerPokeGate）：
 * 非 waiting 态 revert TimerNotWaiting、未到期 revert TimerNotDue——两类
 * revert 说明链上口径已越过投影判据（投影 lag / 到期秒边界），按收敛
 * 处理：移出本轮候选、不计失败、不升级告警，最终性窗口照常占窗限速。
 * 其余 revert/gas 错误记逐 hook 连续失败窗口，连续
 * FAILURE_ESCALATION_WINDOWS 个窗口仍失败即升级 error 级告警（无死信
 * 机制，留痕之外需人工裁决）。
 *
 * 最终性口径与 notifications/indexer 同门：候选的最近状态变更必须已在
 * finalizedBlock 之内（hook.updatedAt.blockNumber ≤ finalizedBlock），不对
 * 未最终区块抢跑；sync state 缺失（最终性上界未知）或人工 rebuild 进行中
 * （syncStatus=rebuilding，投影是半重建的中间态）时本轮不放行任何候选
 * 并留痕，不放行 = fail-closed。
 */
export class TimerKeeperWorker implements LifecycleService {
  readonly name = "timer-keeper";

  readonly #config: TimerKeeperConfig;
  readonly #projectionStore: ProjectionStore;
  readonly #stateMachineAddress: Hex;
  readonly #chainId: number;
  readonly #submitter: TimerKeeperSubmitter | undefined;
  readonly #logger: Logger;
  readonly #now: () => Date;
  #timer: NodeJS.Timeout | undefined;
  #running = false;
  #checking = false;
  #lastSummary: TimerKeeperRunSummary | undefined;
  /** 广播 + 最终性窗口去重（成败同占窗，与 dock keeper 同口径）。 */
  readonly #lastBroadcastAt = new Map<string, number>();
  /** 逐 hook 连续失败窗口计数（收敛 revert 不计；广播成功清零）。 */
  readonly #failureWindows = new Map<string, { windows: number }>();

  constructor(options: {
    readonly config: TimerKeeperConfig;
    readonly projectionStore: ProjectionStore;
    readonly stateMachineAddress: Hex;
    readonly chainId: number;
    readonly submitter?: TimerKeeperSubmitter;
    readonly logger?: Logger;
    readonly now?: () => Date;
  }) {
    this.#config = options.config;
    this.#projectionStore = options.projectionStore;
    this.#stateMachineAddress = options.stateMachineAddress;
    this.#chainId = options.chainId;
    this.#submitter = options.submitter;
    this.#logger = options.logger ?? noopLogger;
    this.#now = options.now ?? (() => new Date());
  }

  async start(): Promise<void> {
    if (!this.#config.enabled || this.#running) {
      return;
    }
    // enabled 但 submitter 未装配（keeper 私钥缺失/状态机地址缺失）：
    // 候选扫描恒归零，不启动空转轮询，响亮声明装配缺口。
    if (!this.#submitter) {
      this.#logger.warn(
        "timer keeper is enabled but no submitter is wired; the keeper stays idle until the assembly provides one"
      );
      return;
    }
    this.#running = true;
    if (this.#config.pollIntervalMs <= 0) {
      // 轮询间隔非正数会让 setInterval 退化成热循环（对齐 reconcile worker
      // 与 indexer 轮询的守卫）：响亮告警并保持不轮询。
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
      const nowSeconds = BigInt(Math.floor(this.#now().getTime() / 1000));
      const summary: TimerKeeperRunSummary = {
        scannedOrders: 0,
        waitingHooks: 0,
        pokeCandidates: 0,
        attempted: 0,
        submitted: 0,
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
          // 守门镜像：dueAt 缺失/未到期即 TimerNotDue 面，链上必拒，
          // 投影判据先行过滤（到期秒边界由收敛车道兜底）。
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
      // 预算对 attempted（去重窗口放行后的实际尝试数）封顶：失败/收敛轮
      // 同样消耗预算，全失败轮不会扫穿全部候选。
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
          await submitter.pokeTimer({
            planId: candidate.planId,
            orderId: candidate.orderId,
            hookId: candidate.hookId,
            ...(this.#config.maxGasPerTx ? { gas: this.#config.maxGasPerTx } : {})
          });
          summary.submitted += 1;
          this.#failureWindows.delete(candidate.key);
        } catch (error) {
          const message = redactErrorMessage(error);
          const convergedReason = convergedRevertReasonOf(error, message);
          if (convergedReason) {
            // 收敛：链上口径已越过投影判据，移出本轮候选、不算失败；
            // 窗口照常占窗（投影 lag 期内逐轮重发是纯 gas 浪费）。
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

  /**
   * 进程内跟踪态淘汰：候选已消失（hook 不再 waiting+due，或投递事实已
   * 呈现）或距上次广播超过 4×去重窗的键即清理——去重窗语义只覆盖
   * redeliveryWindowMs 内的记录，无淘汰的 Map 会随历史 hook 单调增长。
   */
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

/** 收敛 revert：合约守门两闸（TimerNotWaiting/TimerNotDue）——写面先经
 * simulateContract 预演，revert 以携 errorName 的错误抛回（已知自定义错误
 * 自动解码）；失败原因从 errorName 判定，errorName 缺席时退回已脱敏
 * 消息文本匹配。 */
const CONVERGED_REVERT = /TimerNotWaiting|TimerNotDue/;

/** 同一 hook 连续失败达该窗口数即升级 error 级告警。 */
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
    deduplicated: 0,
    converged: [],
    skipped: []
  };
}
