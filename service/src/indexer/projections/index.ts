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
  StateMachineExecutorCandidateProjection,
  PlanCapabilityEnrichmentStatus
} from "./plan.js";
export type {
  StateMachineSignalProjection,
  StateMachineSignalAuthorizationProjection,
  StateMachineDerivedSignalProjection,
  SignalAuthorizationHookMatchInput
} from "./signal.js";
export { signalAuthorizationMatchesHook } from "./signal.js";
export type {
  StateMachineStageExecutorPatchMode,
  StateMachineStageExecutorOverlayProjection,
  StateMachineStageResourceOverlayProjection,
  StateMachineStageMaterializationProjection,
  StateMachineHookStatus,
  StateMachineHookProjection
} from "./stage.js";
export type {
  StateMachineDockInputDeliveryProjection,
  StateMachineDockOutputDeliveryProjection,
  StateMachineDockMode,
  StateMachineDockProjection
} from "./docking.js";
export type {
  StateMachineTaskStatus,
  StateMachineTaskProjection,
  StateMachineTaskSubmitSignalProjection
} from "./task.js";
export type {
  StateMachineDeploymentStatus,
  StateMachineDeploymentProjection,
  ContractGovernanceProjection,
  ProjectionSnapshot
} from "./snapshot.js";
export { createEmptyProjectionSnapshot } from "./snapshot.js";
