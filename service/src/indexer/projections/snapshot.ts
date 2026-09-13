// 快照族：重放快照形状、空快照与部署注册表快照读取选择器（部署注册表状态
// 随快照存储，其写入事件族见 indexer/replay.ts）。
import { compareChainPointers, type Address, type Hex } from "../../shared/types.js";
import type { ProjectionProvenance, StateMachineProofProjection } from "./proof.js";
import type {
  OrderProjection,
  StateMachineModuleProjection,
  StateMachineOrderProjection
} from "./order.js";
import type { MutableStateMachinePlanProjection, StateMachinePlanProjection } from "./plan.js";
import type { StateMachineDockProjection } from "./docking.js";
import type { StateMachineTaskProjection } from "./task.js";

export type StateMachineDeploymentStatus =
  | "candidate"
  | "canary"
  | "active"
  | "deprecated"
    | "retired"
    | "unknown";

export interface StateMachineDeploymentProjection {
  readonly deploymentId: Hex;
  readonly stateMachineAddress: Address;
  readonly artifactHash: Hex;
  readonly abiHash: Hex;
  readonly deploymentBlock: string;
  readonly activatedAtBlock?: string;
  readonly evidenceHash?: Hex;
  readonly metadataURI: string;
  readonly status: StateMachineDeploymentStatus;
  readonly registeredAt: ProjectionProvenance;
  readonly updatedAt: ProjectionProvenance;
  readonly proof: StateMachineProofProjection;
}

export interface ProjectionSnapshot {
  readonly rebuildable: true;
  readonly eventCount: number;
  readonly orders: Readonly<Record<string, OrderProjection>>;
  readonly activeStateMachineDeploymentId?: Hex;
  readonly stateMachineDeployments: Readonly<Record<string, StateMachineDeploymentProjection>>;
  readonly stateMachineModules: Readonly<Record<string, StateMachineModuleProjection>>;
  readonly stateMachinePlans: Readonly<Record<string, StateMachinePlanProjection>>;
  readonly stateMachineOrders: Readonly<Record<string, StateMachineOrderProjection>>;
  readonly stateMachineDocks: Readonly<Record<string, StateMachineDockProjection>>;
  readonly stateMachineTasks: Readonly<Record<string, StateMachineTaskProjection>>;
  readonly lastEvent?: ProjectionProvenance;
  /**
   * P0 幻影订单诊断计数：订单维度事件（patch/dock/link/derived）本应由已
   * 登记的模块合约发出，但 replay 时其 emitting 地址无法通过
   * stateMachineModules 唯一归因到所属状态机（模块未登记/replay 顺序中
   * StateMachineModuleSet 尚未出现/一址多机）。这类事件保持事件自带地址
   * 建桶（现状），但必须在此显式计数，不允许静默。
   */
  readonly unresolvedModuleOrderEventCount?: number;
  /**
   * Dock 事件（input/output）无法定位已开启 dock 桶的显式计数
   * （dock 未开启 / 模块未登记 / 回放顺序中 DockOpened 缺失）。不允许静默。
   */
  readonly unresolvedDockEventCount?: number;
  /**
   * StageExecutorActivated 到达时目标 stage 没有既有 overlay 的显式计数
   * （激活前补丁事件缺失）。不允许静默。
   */
  readonly unresolvedStageActivationEventCount?: number;
  /**
   * DockOpened 的跨部署子订单归桶诊断计数：linkedOrderId/targetPlanId 的
   * 子订单按 local 状态机地址建桶（现状行为），但 targetPlan 无法在 local
   * 状态机下定位已登记 plan（跨部署 dock / plan 未登记 / 回放顺序缺口）
   * 时，子订单归属未经证实——显式计数，不允许静默。
   */
  readonly unresolvedDockTargetDeploymentCount?: number;
}

export type Writable<TValue> = {
  -readonly [TKey in keyof TValue]: TValue[TKey];
};

export type MutableStateMachineDeploymentProjection = Writable<StateMachineDeploymentProjection>;

/** P0 幻影订单：单次 replay 内累计的显式诊断计数。 */
export interface ProjectionReplayDiagnostics {
  unresolvedModuleOrderEventCount: number;
  unresolvedDockEventCount: number;
  unresolvedStageActivationEventCount: number;
  unresolvedDockTargetDeploymentCount: number;
}

export function createEmptyProjectionSnapshot(): ProjectionSnapshot {
  return {
    rebuildable: true,
    eventCount: 0,
    orders: {},
    stateMachineDeployments: {},
    stateMachineModules: {},
    stateMachinePlans: {},
    stateMachineOrders: {},
    stateMachineDocks: {},
    stateMachineTasks: {},
    unresolvedModuleOrderEventCount: 0,
    unresolvedDockEventCount: 0,
    unresolvedStageActivationEventCount: 0,
    unresolvedDockTargetDeploymentCount: 0
  };
}

export function findDeploymentByStateMachine(
  deployments: Map<string, MutableStateMachineDeploymentProjection>,
  chainId: number,
  stateMachineAddress: Address
): MutableStateMachineDeploymentProjection | undefined {
  const normalizedStateMachine = stateMachineAddress.toLowerCase();
  return [...deployments.values()]
    .filter((deployment) =>
      deployment.registeredAt.chainId === chainId && deployment.stateMachineAddress.toLowerCase() === normalizedStateMachine
    )
    .sort(compareDeploymentSelection)[0];
}

export function orderDeploymentIdFromPlanOrStateMachine(
  plan: MutableStateMachinePlanProjection | undefined,
  deployments: Map<string, MutableStateMachineDeploymentProjection>,
  chainId: number,
  stateMachineAddress: Address
): Hex | undefined {
  return plan?.deploymentId ?? findDeploymentByStateMachine(deployments, chainId, stateMachineAddress)?.deploymentId;
}

function compareDeploymentSelection(
  left: StateMachineDeploymentProjection,
  right: StateMachineDeploymentProjection
): number {
  const status = deploymentStatusPriority(left.status) - deploymentStatusPriority(right.status);
  if (status !== 0) {
    return status;
  }
  const position = compareChainPointers(right.updatedAt, left.updatedAt);
  if (position !== 0) {
    return position;
  }
  return left.deploymentId.localeCompare(right.deploymentId);
}

function deploymentStatusPriority(status: StateMachineDeploymentStatus): number {
  switch (status) {
    case "active":
      return 0;
    case "canary":
      return 1;
    case "candidate":
      return 2;
    case "deprecated":
      return 3;
    case "retired":
      return 4;
    default:
      return 5;
  }
}
