// Supplier 族：UVPSupplierRegistry 的 supplierId ↔ executor 绑定事件投影
// （registration/rotation/revocation），以及 effective executor 的重放期解析。
// 链上只有绑定这一个事实源：本模块只按事件顺序重放，不保存身份/KYC 状态。
import { ProjectionError, type Address, type Hex } from "@uvp-eth/service-runtime";
import type { ChainEvent } from "../events.js";
import {
  ZERO_BYTES32,
  proofOf,
  provenanceOf,
  requiredAddressArg,
  requiredBytes32Arg,
  type ProjectionProvenance,
  type StateMachineProofProjection
} from "./proof.js";
import { stateMachineScopedKey, type MutableStateMachineOrderProjection } from "./order.js";
import { planDefaultSupplierForStage, type StateMachinePlanProjection } from "./plan.js";
import { dockSelectionKey, type StateMachineDockSelectionProjection } from "./dock.js";
import { findStageExecutorOverlay } from "./stage.js";
import type { Writable } from "./snapshot.js";

export interface StateMachineSupplierProjection {
  readonly supplierId: Hex;
  readonly executor: Address;
  readonly registeredAt: ProjectionProvenance;
  readonly updatedAt: ProjectionProvenance;
  readonly proof: StateMachineProofProjection;
  readonly rotatedAt?: ProjectionProvenance;
  readonly rotationProof?: StateMachineProofProjection;
  readonly revokedAt?: ProjectionProvenance;
  readonly revocationProof?: StateMachineProofProjection;
}

export type MutableStateMachineSupplierProjection = Writable<StateMachineSupplierProjection>;

export type StateMachineSupplierIndex = ReadonlyMap<string, MutableStateMachineSupplierProjection>;

export function applySupplierRegistryEvent(
  suppliers: Map<string, MutableStateMachineSupplierProjection>,
  event: ChainEvent
): boolean {
  switch (event.eventName) {
    case "SupplierRegistered":
      applySupplierRegistered(suppliers, event);
      return true;
    case "SupplierExecutorRotated":
      applySupplierExecutorRotated(suppliers, event);
      return true;
    case "SupplierRevoked":
      applySupplierRevoked(suppliers, event);
      return true;
    case "SupplierRegistrarSet":
      return true;
    default:
      return false;
  }
}

function applySupplierRegistered(
  suppliers: Map<string, MutableStateMachineSupplierProjection>,
  event: ChainEvent
): void {
  const supplierId = requiredBytes32Arg(event, "supplierId");
  const executor = requiredAddressArg(event, "executor");
  const key = supplierId.toLowerCase();
  const existing = suppliers.get(key);
  if (existing && existing.revokedAt === undefined) {
    throw new ProjectionError(
      `${event.eventName} re-registers supplier ${supplierId} while it is still bound to ${existing.executor}`
    );
  }
  suppliers.set(key, {
    supplierId,
    executor,
    registeredAt: provenanceOf(event),
    updatedAt: provenanceOf(event),
    proof: proofOf(event)
  });
}

function applySupplierExecutorRotated(
  suppliers: Map<string, MutableStateMachineSupplierProjection>,
  event: ChainEvent
): void {
  const supplierId = requiredBytes32Arg(event, "supplierId");
  const supplier = requireSupplier(suppliers, event, supplierId);
  if (supplier.revokedAt !== undefined) {
    throw new ProjectionError(
      `${event.eventName} rotates revoked supplier ${supplierId}`
    );
  }
  const newExecutor = requiredAddressArg(event, "newExecutor");
  const proof = proofOf(event);
  supplier.executor = newExecutor;
  supplier.rotatedAt = provenanceOf(event);
  supplier.rotationProof = proof;
  supplier.updatedAt = provenanceOf(event);
}

function applySupplierRevoked(
  suppliers: Map<string, MutableStateMachineSupplierProjection>,
  event: ChainEvent
): void {
  const supplierId = requiredBytes32Arg(event, "supplierId");
  const supplier = requireSupplier(suppliers, event, supplierId);
  if (supplier.revokedAt !== undefined) {
    throw new ProjectionError(
      `${event.eventName} revokes supplier ${supplierId} that is already revoked`
    );
  }
  supplier.revokedAt = provenanceOf(event);
  supplier.revocationProof = proofOf(event);
  supplier.updatedAt = provenanceOf(event);
}

function requireSupplier(
  suppliers: Map<string, MutableStateMachineSupplierProjection>,
  event: ChainEvent,
  supplierId: Hex
): MutableStateMachineSupplierProjection {
  const supplier = suppliers.get(supplierId.toLowerCase());
  if (!supplier) {
    throw new ProjectionError(
      `${event.eventName} references unregistered supplier ${supplierId}`
    );
  }
  return supplier;
}

export function supplierExecutorOf(
  suppliers: StateMachineSupplierIndex,
  supplierId: Hex | undefined
): Address | undefined {
  if (!supplierId || supplierId === ZERO_BYTES32) {
    return undefined;
  }
  const supplier = suppliers.get(supplierId.toLowerCase());
  if (!supplier || supplier.revokedAt !== undefined) {
    return undefined;
  }
  return supplier.executor;
}

export function resolveStageExecutorAssignments(state: {
  suppliers: StateMachineSupplierIndex;
  plans: ReadonlyMap<string, StateMachinePlanProjection>;
  orders: Map<string, MutableStateMachineOrderProjection>;
  dockSelections: ReadonlyMap<string, StateMachineDockSelectionProjection>;
}): void {
  for (const order of state.orders.values()) {
    const plan = state.plans.get(
      stateMachineScopedKey(order.chainId, order.contractAddress, order.planId)
    );
    for (const overlay of Object.values(order.stageExecutorOverlays)) {
      const selection = state.dockSelections.get(
        dockSelectionKey(order.planId, order.orderId, overlay.targetStageId)
      );
      if (selection && selection.patchNonce === overlay.patchNonce) {
        overlay.dockId = selection.dockId;
        overlay.fromPlanId = selection.fromPlanId;
        overlay.selector = overlay.selector ?? selection.selector;
      }
      assignExecutor(state.suppliers, overlay, overlay.supplierId);
    }
    for (const task of Object.values(order.tasks)) {
      const activeOverlay = findStageExecutorOverlay(order, task.stageIdentifier);
      const supplierId = activeOverlay?.supplierId ??
        planDefaultSupplierForStage(plan, task.stageIdentifier);
      if (!supplierId) {
        delete task.assigneeSupplierId;
        delete task.assigneeExecutor;
        continue;
      }
      task.assigneeSupplierId = supplierId;
      const executor = supplierExecutorOf(state.suppliers, supplierId);
      if (executor) {
        task.assigneeExecutor = executor;
      } else {
        delete task.assigneeExecutor;
      }
    }
  }
}

function assignExecutor(
  suppliers: StateMachineSupplierIndex,
  target: { effectiveExecutor?: Address },
  supplierId: Hex
): void {
  const executor = supplierExecutorOf(suppliers, supplierId);
  if (executor) {
    target.effectiveExecutor = executor;
  } else {
    delete target.effectiveExecutor;
  }
}
