import type { Address, Hex } from "../shared/types.js";

/**
 * 链上时钟拨表 keeper 配置（keeper 只提供活性：pokeTimer 是链上时钟的
 * 拨表面，relayer 代付非业务签名）。候选完全来自投影（status=waiting 且
 * dueAt 已到的 hook），keeper 不发明任何协议 word。
 */
export interface TimerKeeperConfig {
  readonly enabled: boolean;
  readonly pollIntervalMs: number;
  readonly maxCandidatesPerRun: number;
  readonly maxGasPerTx?: bigint;
  /**
   * 最终性窗口去重（与 dock keeper 同口径）：同一 hook 广播后，投影要等
   * 链事件 finalize+索引后才呈现新状态，窗口内逐轮重发是纯 gas 浪费的
   * no-op 交易；窗口过后投影仍呈 waiting+due 才重试（覆盖交易丢失）。
   */
  readonly redeliveryWindowMs: number;
  /** keeper 独立 gas 角色私钥所在环境变量名（默认 UVP_TIMER_KEEPER_PRIVATE_KEY）。 */
  readonly privateKeyEnv: string;
  /** 期望地址（UVP_TIMER_KEEPER_ADDRESS）：preflight/诊断侧一致性比对。 */
  readonly expectedAddress?: Address;
}

export interface TimerPokeTarget {
  readonly planId: Hex;
  readonly orderId: Hex;
  readonly hookId: Hex;
  /** 广播 gas 上限：写面先经 simulateContract 预演并取模拟 gas，模拟
   * gas 超过本上限即拒发；未超则以模拟 gas 为 limit 广播。 */
  readonly gas?: bigint;
}

/** 写面端口：由 relayer broadcast 原语实现（见 timer-keeper/broadcast.ts）。 */
export interface TimerKeeperSubmitter {
  pokeTimer(target: TimerPokeTarget): Promise<Hex>;
}

export interface TimerKeeperRunSummary {
  scannedOrders: number;
  /** 投影中 status=waiting 的 hook 总数（含未到期与未最终者）。 */
  waitingHooks: number;
  pokeCandidates: number;
  /** 本轮去重窗口放行后实际尝试广播的候选数（成败/收敛同计）——
   * maxCandidatesPerRun 对该数封顶，全失败轮不会扫穿全部候选。 */
  attempted: number;
  submitted: number;
  /** 最终性窗口内被去重跳过的重复广播次数。 */
  deduplicated: number;
  /**
   * 收敛 revert（TimerNotWaiting/TimerNotDue）：链上守门口径已越过投影
   * 判据（投影 lag / 到期秒边界），移出本轮候选、不计失败、不升级。
   */
  converged: string[];
  skipped: string[];
}
