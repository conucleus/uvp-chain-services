import type { Address, Hex } from "../shared/types.js";

/** PRD96 §15：dock liveness 自动化配置（keeper 只提供活性，不发明任何协议 word）。 */
export interface DockAutomationConfig {
  readonly enabled: boolean;
  readonly pollIntervalMs: number;
  readonly maxCandidatesPerRun: number;
  readonly maxGasPerTx?: bigint;
  readonly waitForReceipt: boolean;
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
  skipped: string[];
}
