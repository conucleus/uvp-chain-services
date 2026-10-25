import type { Address, Hex } from "../shared/types.js";

// dock liveness 自动化配置与 route 数据/交易提交端口（keeper 只提供活性）。

export interface DockAutomationConfig {
  readonly enabled: boolean;
  readonly pollIntervalMs: number;
  readonly maxCandidatesPerRun: number;
  readonly maxGasPerTx?: bigint;
  readonly redeliveryWindowMs: number;
}

export type DockOrderMode = "new" | "existing";

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
  readonly openCalldata?: Hex;
  readonly attachCalldata?: Hex;
}

export interface DockRouteSource {
  listRoutes(): Promise<readonly DockRouteRecord[]>;
}

export interface DockAutomationSubmission {
  readonly to: Address;
  readonly data: Hex;
  readonly gas?: bigint;
}

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
  attempted: number;
  submitted: number;
  deduplicated: number;
  skipped: string[];
}
