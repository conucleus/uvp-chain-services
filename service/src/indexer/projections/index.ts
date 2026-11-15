// projections 族的对外导出面；重放编排入口见 ../replay.ts。
export type {
  ProjectionProvenance,
  StateMachineProofProjection,
  EventProofArgs,
  StateMachineTimelineEventProjection
} from "./proof.js";
export type {
  StateMachineOrderStatus,
  StateMachineOrderTriggerLinkProjection,
  StateMachineOrderForkProjection,
  StateMachineOrderProjection,
  StateMachineModuleProjection
} from "./order.js";
export {
  stateMachineOrderProjectionKey,
  stateMachineTaskProjectionKey,
  stateMachineScopedKey
} from "./order.js";
export type {
  StateMachinePlanProjection,
  StateMachineStageSelectorBindingProjection,
  StateMachineSignalTargetRelation,
  StateMachineSignalCapabilityProjection,
  StateMachineExecutorBindingProjection,
  StateMachineExecutorBindingKind,
  PlanCapabilityEnrichmentStatus
} from "./plan.js";
export type {
  StateMachineSignalProjection,
  StateMachineDerivedSignalProjection
} from "./signal.js";
export type {
  StateMachineStageExecutorOverlayProjection,
  StateMachineStageMaterializationProjection,
  StateMachineHookStatus,
  StateMachineHookProjection
} from "./stage.js";
export type {
  StateMachineStageFileEntryProjection,
  StateMachineStageFileMapProjection
} from "./stage-files.js";
export type {
  StateMachineDockAtomProjection,
  StateMachineDockOutputProjection,
  StateMachineDockProjection,
  StateMachineDockBindingProjection
} from "./dock.js";
export type {
  StateMachineTaskStatus,
  StateMachineTaskProjection,
  StateMachineTaskSubmitSignalProjection
} from "./task.js";
export type {
  StateMachineSupplierProjection
} from "./supplier.js";
export type {
  StateMachineDeploymentStatus,
  StateMachineDeploymentProjection,
  ContractGovernanceProjection,
  ProjectionSnapshot
} from "./snapshot.js";
export { createEmptyProjectionSnapshot } from "./snapshot.js";
