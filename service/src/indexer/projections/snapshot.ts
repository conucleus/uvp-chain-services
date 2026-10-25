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

export interface ContractGovernanceProjection {
  readonly chainId: number;
  readonly contractAddress: Address;
  readonly owner: Address;
  readonly ownerUpdatedAt: ProjectionProvenance;
  readonly ownerProof: StateMachineProofProjection;
  readonly modulesFrozen?: boolean;
  readonly moduleSetHash?: Hex;
  readonly frozenAt?: ProjectionProvenance;
  readonly frozenProof?: StateMachineProofProjection;
}

export type MutableContractGovernanceProjection = Writable<ContractGovernanceProjection>;

export interface ProjectionSnapshot {
  readonly rebuildable: true;
  readonly eventCount: number;
  readonly activeStateMachineDeploymentId?: Hex;
  readonly stateMachineDeployments: Readonly<Record<string, StateMachineDeploymentProjection>>;
  readonly stateMachineModules: Readonly<Record<string, StateMachineModuleProjection>>;
  readonly contractGovernance: Readonly<Record<string, ContractGovernanceProjection>>;
  readonly stateMachinePlans: Readonly<Record<string, StateMachinePlanProjection>>;
  readonly stateMachineOrders: Readonly<Record<string, StateMachineOrderProjection>>;
  readonly stateMachineDocks: Readonly<Record<string, StateMachineDockProjection>>;
  readonly stateMachineDocksByTargetOrder: Readonly<Record<string, readonly string[]>>;
  readonly stateMachineOrderDockChainDepth: Readonly<Record<string, number>>;
  readonly stateMachineTasks: Readonly<Record<string, StateMachineTaskProjection>>;
  readonly lastEvent?: ProjectionProvenance;
  readonly unresolvedModuleOrderEventCount?: number;
  readonly unresolvedDockEventCount?: number;
  readonly unresolvedStageActivationEventCount?: number;
  readonly unresolvedDockTargetDeploymentCount?: number;
  readonly capabilityEnrichmentMismatchCount?: number;
  readonly unknownEventCount?: number;
}

export type Writable<TValue> = {
  -readonly [TKey in keyof TValue]: TValue[TKey];
};

export type MutableStateMachineDeploymentProjection = Writable<StateMachineDeploymentProjection>;

export interface ProjectionReplayDiagnostics {
  unresolvedModuleOrderEventCount: number;
  unresolvedDockEventCount: number;
  unresolvedStageActivationEventCount: number;
  unresolvedDockTargetDeploymentCount: number;
  capabilityEnrichmentMismatchCount: number;
  unknownEventCount: number;
}

export function createEmptyProjectionSnapshot(): ProjectionSnapshot {
  return {
    rebuildable: true,
    eventCount: 0,
    stateMachineDeployments: {},
    stateMachineModules: {},
    contractGovernance: {},
    stateMachinePlans: {},
    stateMachineOrders: {},
    stateMachineDocks: {},
    stateMachineDocksByTargetOrder: {},
    stateMachineOrderDockChainDepth: {},
    stateMachineTasks: {},
    unresolvedModuleOrderEventCount: 0,
    unresolvedDockEventCount: 0,
    unresolvedStageActivationEventCount: 0,
    unresolvedDockTargetDeploymentCount: 0,
    capabilityEnrichmentMismatchCount: 0,
    unknownEventCount: 0
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
