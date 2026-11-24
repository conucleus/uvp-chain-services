// Supplier 族：UVPIdentityRegistry 的 supplierId ↔ supplier account 永久绑定与
// 状态事件投影（SupplierRegistered/SupplierStatusChanged），以及 stage 指派的
// supplier account 重放期解析。链上注册表是唯一身份事实源：本模块只按事件顺序
// 重放，不保存链下身份/KYC 数据，account 永不改写。
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
import { findStageSupplierAssignment } from "./stage.js";
import type { Writable } from "./snapshot.js";

export type StateMachineSupplierStatus = "pending" | "active" | "suspended" | "revoked";

export interface StateMachineSupplierProjection {
  readonly supplierId: Hex;
  readonly account: Address;
  readonly status: StateMachineSupplierStatus;
  readonly registeredAt: ProjectionProvenance;
  readonly updatedAt: ProjectionProvenance;
  readonly proof: StateMachineProofProjection;
  readonly statusChangedAt?: ProjectionProvenance;
  readonly statusChangedProof?: StateMachineProofProjection;
  readonly revokedAt?: ProjectionProvenance;
  readonly revocationProof?: StateMachineProofProjection;
}

export type MutableStateMachineSupplierProjection = Writable<StateMachineSupplierProjection>;

export type StateMachineSupplierIndex = ReadonlyMap<string, MutableStateMachineSupplierProjection>;

export function applySupplierCapabilityEvent(
  suppliers: Map<string, MutableStateMachineSupplierProjection>,
  event: ChainEvent
): boolean {
  switch (event.eventName) {
    case "SupplierRegistered":
      applySupplierRegistered(suppliers, event);
      return true;
    case "SupplierStatusChanged":
      applySupplierStatusChanged(suppliers, event);
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
  const account = requiredAddressArg(event, "account");
  const key = supplierId.toLowerCase();
  if (suppliers.has(key)) {
    throw new ProjectionError(`${event.eventName} re-registers supplier ${supplierId}`);
  }
  suppliers.set(key, {
    supplierId,
    account,
    status: "pending",
    registeredAt: provenanceOf(event),
    updatedAt: provenanceOf(event),
    proof: proofOf(event)
  });
}

function applySupplierStatusChanged(
  suppliers: Map<string, MutableStateMachineSupplierProjection>,
  event: ChainEvent
): void {
  const supplierId = requiredBytes32Arg(event, "supplierId");
  const supplier = suppliers.get(supplierId.toLowerCase());
  if (!supplier) {
    throw new ProjectionError(`${event.eventName} references unregistered supplier ${supplierId}`);
  }
  const account = requiredAddressArg(event, "account");
  if (account !== supplier.account) {
    throw new ProjectionError(
      `${event.eventName} reports account ${account} for supplier ${supplierId} whose permanent account is ${supplier.account}`
    );
  }
  if (supplier.status === "revoked") {
    throw new ProjectionError(`${event.eventName} changes already revoked supplier ${supplierId}`);
  }
  const previousStatus = requiredSupplierStatusArg(event, "previousStatus");
  if (previousStatus !== supplier.status) {
    throw new ProjectionError(
      `${event.eventName} previousStatus ${previousStatus} does not match replayed status ${supplier.status} for supplier ${supplierId}`
    );
  }
  const newStatus = requiredSupplierStatusArg(event, "newStatus");
  const proof = proofOf(event);
  supplier.status = newStatus;
  supplier.statusChangedAt = provenanceOf(event);
  supplier.statusChangedProof = proof;
  supplier.updatedAt = provenanceOf(event);
  if (newStatus === "revoked") {
    supplier.revokedAt = provenanceOf(event);
    supplier.revocationProof = proof;
  }
}

function requiredSupplierStatusArg(event: ChainEvent, name: string): StateMachineSupplierStatus {
  const value = event.args[name];
  const numeric = typeof value === "bigint"
    ? Number(value)
    : typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : undefined;
  switch (numeric) {
    case 0:
      return "pending";
    case 1:
      return "active";
    case 2:
      return "suspended";
    case 3:
      return "revoked";
    default:
      throw new ProjectionError(`${event.eventName}.${name} is not a known SupplierStatus`);
  }
}

export function supplierAccountOf(
  suppliers: StateMachineSupplierIndex,
  supplierId: Hex | undefined
): Address | undefined {
  if (!supplierId || supplierId === ZERO_BYTES32) {
    return undefined;
  }
  return suppliers.get(supplierId.toLowerCase())?.account;
}

export function resolveStageSupplierAssignments(state: {
  suppliers: StateMachineSupplierIndex;
  plans: ReadonlyMap<string, StateMachinePlanProjection>;
  orders: Map<string, MutableStateMachineOrderProjection>;
}): void {
  for (const order of state.orders.values()) {
    const plan = state.plans.get(
      stateMachineScopedKey(order.chainId, order.contractAddress, order.planId)
    );
    for (const assignment of Object.values(order.stageSupplierAssignments)) {
      assignSupplierAccount(state.suppliers, assignment, assignment.supplierId);
    }
    for (const task of Object.values(order.tasks)) {
      const assignment = findStageSupplierAssignment(order, task.stageIdentifier);
      const supplierId = assignment?.supplierId ??
        planDefaultSupplierForStage(plan, task.stageIdentifier);
      if (!supplierId) {
        delete task.assigneeSupplierId;
        delete task.assigneeSupplierAccount;
        continue;
      }
      task.assigneeSupplierId = supplierId;
      const account = supplierAccountOf(state.suppliers, supplierId);
      if (account) {
        task.assigneeSupplierAccount = account;
      } else {
        delete task.assigneeSupplierAccount;
      }
    }
  }
}

function assignSupplierAccount(
  suppliers: StateMachineSupplierIndex,
  target: { supplierAccount?: Address },
  supplierId: Hex
): void {
  const account = supplierAccountOf(suppliers, supplierId);
  if (account) {
    target.supplierAccount = account;
  } else {
    delete target.supplierAccount;
  }
}
