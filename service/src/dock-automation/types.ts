import type { Address, Hex } from "../shared/types.js";

/** dock liveness 自动化配置（keeper 只提供活性，不发明任何协议 word）。 */
export interface DockAutomationConfig {
  readonly enabled: boolean;
  readonly pollIntervalMs: number;
  readonly maxCandidatesPerRun: number;
  readonly maxGasPerTx?: bigint;
  /**
   * 最终性窗口去重：同一 binding 广播成功后，在该窗口内
   * 不重复广播——投影要等链事件 finalize+索引后才呈现 delivery，逐轮
   * 重发是纯 gas 浪费的 no-op 交易。窗口过后仍未投影为已投递才会重试
   * （覆盖交易丢失的情形）。
   */
  readonly redeliveryWindowMs: number;
}

/** dock 下单模式：new（openDockedOrder 铸子单，出生锚 open 原子投递）/
 * existing（attachDockedOrder 对等挂接既有目标单，input/output 全活交付）。 */
export type DockOrderMode = "new" | "existing";

/**
 * 解析后的 dock route 记录（来源：云编译产物 zhixu_dock_route +
 * resolution manifest，uvp.dockRoute.v2）。binding 全集只能来自链下
 * route 数据——链上事件只暴露已投递的 binding，未投递 binding 的发现
 * 依赖这里。
 */
export interface DockRouteInputBinding {
  readonly bindingHash: Hex;
  readonly localHookId: Hex;
  readonly targetSourceId: Hex;
  readonly targetSignalId: Hex;
}

export interface DockRouteOutputBinding {
  readonly bindingHash: Hex;
  readonly localSourceId: Hex;
  readonly localSignalId: Hex;
  readonly targetSourceId: Hex;
  readonly targetSignalId: Hex;
}

export interface DockRouteRecord {
  readonly chainId: number;
  readonly localPlanId: Hex;
  readonly localOrderId: Hex;
  readonly targetPlanId: Hex;
  readonly linkedOrderId: Hex;
  readonly routeId: Hex;
  readonly routeHash: Hex;
  readonly interfaceName: string;
  readonly orderMode: DockOrderMode;
  readonly inputs: readonly DockRouteInputBinding[];
  readonly outputs: readonly DockRouteOutputBinding[];
  /**
   * openDockedOrder 的完整 calldata（外部预组装：request/routeProof/
   * interfaceProof/bindings/permit 全部 word 由 route 来源按编译产物组装；
   * entrance permit 必须已含 publisher 签名）。keeper 不组装、不补签。
   *
   * 词表 Merkle 化形态下该 calldata 还须携带词表面参数（openDockedOrder 的
   * outputAttributions——((sourceId,signalId,stageId,proof)[]，出生/出
   * 端事实的能力叶 proof）），同样由 route 来源随产物一并预组装；本域
   * no-op 未接线，keeper 不实现造证（造证单源在
   * submissions/capability-proofs.ts，供接线方复用）。
   */
  readonly openCalldata?: Hex;
  /**
   * existing 模式对位载荷：attachDockedOrder 的完整 calldata（route 来源
   * 预组装）。attach 同意门三腿——目标单 creator / 在任执行者 / 目标 plan
   * publisher 的 attach 预授权——都不含中继 keeper 钱包（基础设施地址无
   * 业务身份），keeper 自发的 attach 只能走 calldata 内预组装的 publisher
   * 预授权腿，与 openCalldata 的 EntrancePermit 处理同构：keeper 不组装、
   * 不补签、不自选动态目标（候选集 membership proof 随 calldata 一并
   * 预组装）。
   */
  readonly attachCalldata?: Hex;
}

/** route 数据端口：由云编译数据库/manifest 服务实现。 */
export interface DockRouteSource {
  listRoutes(): Promise<readonly DockRouteRecord[]>;
}

export interface DockAutomationSubmission {
  readonly to: Address;
  readonly data: Hex;
  readonly gas?: bigint;
}

/** 交易提交端口：由 relayer broadcast 原语实现。 */
export interface DockAutomationSubmitter {
  submit(submission: DockAutomationSubmission): Promise<Hex>;
}

export interface DockAutomationRunSummary {
  scannedRoutes: number;
  scannedDocks: number;
  attachCandidates: number;
  openCandidates: number;
  inputCandidates: number;
  outputCandidates: number;
  submitted: number;
  /** 最终性窗口内被去重跳过的重复广播次数。 */
  deduplicated: number;
  skipped: string[];
}
