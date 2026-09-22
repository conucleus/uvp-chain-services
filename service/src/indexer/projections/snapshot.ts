// 快照族：重放快照形状、空快照与部署注册表快照读取选择器（部署注册表状态
// 随快照存储，其写入事件族见 indexer/replay.ts）。
import { compareChainPointers, type Address, type Hex } from "../../shared/types.js";
import type { ProjectionProvenance, StateMachineProofProjection } from "./proof.js";
import type {
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
  readonly activeStateMachineDeploymentId?: Hex;
  readonly stateMachineDeployments: Readonly<Record<string, StateMachineDeploymentProjection>>;
  readonly stateMachineModules: Readonly<Record<string, StateMachineModuleProjection>>;
  readonly stateMachinePlans: Readonly<Record<string, StateMachinePlanProjection>>;
  readonly stateMachineOrders: Readonly<Record<string, StateMachineOrderProjection>>;
  readonly stateMachineDocks: Readonly<Record<string, StateMachineDockProjection>>;
  /**
   * 目标侧"谁挂了我"索引：键 = 目标单的 plan 作用域复合键
   * (chainId, stateMachineAddress, targetPlanId, linkedOrderId)，值为该
   * 目标单名下 dock 实例键的集合。existing 模式（DockAttached）天然
   * N:1——多个父单可挂同一目标单，索引必须是集合；链上 dockByTargetOrder
   * 是 new 模式子单出生键（单值、existing 不写），投影不镜像其单值语义。
   */
  readonly stateMachineDocksByTargetOrder: Readonly<Record<string, readonly string[]>>;
  readonly stateMachineTasks: Readonly<Record<string, StateMachineTaskProjection>>;
  readonly lastEvent?: ProjectionProvenance;
  /**
   * 幻影订单诊断计数：订单维度事件（patch/dock/link/derived）本应由已
   * 登记的模块合约发出，但 replay 时其 emitting 地址无法通过
   * stateMachineModules 唯一归因到所属状态机（模块未登记/replay 顺序中
   * StateMachineModuleSet 尚未出现/一址多机）。这类事件保持事件自带地址
   * 建桶（现状），但必须在此显式计数，不允许静默。
   */
  readonly unresolvedModuleOrderEventCount?: number;
  /**
   * Dock 事件（input/output）无法定位已出生 dock 桶的显式计数
   * （dock 未开启/未挂接 / 模块未登记 / 回放顺序中出生事件缺失）。
   * 不允许静默。
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
  /**
   * 词表产物富集的 fail-closed 计数：store 域产物两表按 planId 命中，但
   * planHash/capabilitiesRoot 断言不过（产物过期/被改写/锚错版本），
   * 该 plan 两表保持为空（词表相关推导退化为不可用）。不允许静默。
   */
  readonly capabilityEnrichmentMismatchCount?: number;
}

export type Writable<TValue> = {
  -readonly [TKey in keyof TValue]: TValue[TKey];
};

export type MutableStateMachineDeploymentProjection = Writable<StateMachineDeploymentProjection>;

/** 单次 replay 内累计的显式诊断计数（幻影订单等回放异常）。 */
export interface ProjectionReplayDiagnostics {
  unresolvedModuleOrderEventCount: number;
  unresolvedDockEventCount: number;
  unresolvedStageActivationEventCount: number;
  unresolvedDockTargetDeploymentCount: number;
  capabilityEnrichmentMismatchCount: number;
}

export function createEmptyProjectionSnapshot(): ProjectionSnapshot {
  return {
    rebuildable: true,
    eventCount: 0,
    stateMachineDeployments: {},
    stateMachineModules: {},
    stateMachinePlans: {},
    stateMachineOrders: {},
    stateMachineDocks: {},
    stateMachineDocksByTargetOrder: {},
    stateMachineTasks: {},
    unresolvedModuleOrderEventCount: 0,
    unresolvedDockEventCount: 0,
    unresolvedStageActivationEventCount: 0,
    unresolvedDockTargetDeploymentCount: 0,
    capabilityEnrichmentMismatchCount: 0
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
