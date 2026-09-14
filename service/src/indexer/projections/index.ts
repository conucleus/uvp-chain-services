// 原 indexer/projections.ts 的对外导出面（纯搬迁拆分后保持不变）。
// 重放编排入口（rebuildOrderProjections / countReplayAnomalies /
// countDuplicateActiveEventAnomalies）见 ../replay.ts。
export type {
  ProjectionProvenance,
  StateMachineProofProjection,
  EventProofArgs,
  StateMachineTimelineEventProjection
} from "./proof.js";
export type {
  StateMachineOrderStatus,
  StateMachineOrderTriggerLinkProjection,
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
  StateMachineSignalCapabilityProjection
} from "./plan.js";
export type {
  StateMachineSignalProjection,
  StateMachineSignalAuthorizationProjection,
  StateMachineSignalDelegationProjection,
  SignalAuthorizationHookMatchInput
} from "./signal.js";
export { signalAuthorizationMatchesHook } from "./signal.js";
export type {
  StateMachineStageExecutorPatchMode,
  StateMachineStageExecutorOverlayProjection,
  StateMachineStageResourceOverlayProjection,
  StateMachineHookStatus,
  StateMachineHookProjection
} from "./stage.js";
export type {
  StateMachineDockInputDeliveryProjection,
  StateMachineDockOutputDeliveryProjection,
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
  ProjectionSnapshot
} from "./snapshot.js";
export { createEmptyProjectionSnapshot } from "./snapshot.js";
