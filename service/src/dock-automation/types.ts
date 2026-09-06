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

/**
 * 解析后的 dock route 记录（来源：云编译产物 zhixu_dock_route +
 * resolution manifest）。binding 全集只能来自链下 route 数据——链上事件
 * 只暴露已投递的 binding，未投递 binding 的发现依赖这里。
 */
export interface DockRouteInputBinding {
  readonly bindingHash: Hex;
  readonly localHookId: Hex;
  readonly targetSourceId: Hex;
  readonly targetSignalId: Hex;
  readonly kind: "entrance" | "signal";
}

export interface DockRouteOutputBinding {
  readonly bindingHash: Hex;
  readonly localSourceId: Hex;
  readonly localSignalId: Hex;
  readonly targetSourceId: Hex;
  readonly targetSignalId: Hex;
  readonly terminal: "none" | "success" | "failure" | "cancelled";
}

export interface DockRouteRecord {
  readonly chainId: number;
  readonly localPlanId: Hex;
  readonly localOrderId: Hex;
  readonly targetPlanId: Hex;
  readonly linkedOrderId: Hex;
  readonly routeId: Hex;
  readonly routeHash: Hex;
  readonly accessPolicy: "open" | "permit";
  readonly entranceHookId: Hex;
  readonly inputs: readonly DockRouteInputBinding[];
  readonly outputs: readonly DockRouteOutputBinding[];
  /**
   * openDockedOrder 的完整 calldata（request/routeProof/interfaceLeaf/
   * bindings 全部 word 由 route 来源按编译产物组装；permit 路由由
   * publisher 离线签名后同样在此携带）。keeper 不组装、不补签。
   */
  readonly openCalldata?: Hex;
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
  openCandidates: number;
  inputCandidates: number;
  outputCandidates: number;
  submitted: number;
  /** 最终性窗口内被去重跳过的重复广播次数。 */
  deduplicated: number;
  skipped: string[];
}
