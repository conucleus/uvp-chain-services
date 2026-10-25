// Binding persistence port plus the in-memory implementation used by tests and
// the memory driver. Row semantics mirror migrations/0033_binding_settlement_runtime.sql:
// one cursor/anomaly stream per escrow instance, one binding per tranche and per
// (order, stage), one active deposit intent per (order, stage).

import type { Address } from "../shared/types.js";
import { StorageConstraintError } from "../storage/errors.js";
import type {
  BindingEventAnomaly,
  BindingIndexCursor,
  DepositIntentRecord,
  DepositIntentStatus,
  EscrowInstanceRecord,
  TrancheBindingRecord
} from "./types.js";

export interface BindingStore {
  saveEscrowInstance(record: EscrowInstanceRecord): Promise<void>;
  getEscrowInstance(chainId: number, escrowAddress: Address): Promise<EscrowInstanceRecord | undefined>;
  listEscrowInstances(): Promise<readonly EscrowInstanceRecord[]>;

  saveDepositIntent(record: DepositIntentRecord): Promise<void>;
  updateDepositIntent(record: DepositIntentRecord): Promise<void>;
  getDepositIntent(intentId: string): Promise<DepositIntentRecord | undefined>;
  findDepositIntentByStage(
    chainId: number,
    escrowAddress: Address,
    orderId: string,
    stageId: string,
    statuses?: readonly DepositIntentStatus[]
  ): Promise<DepositIntentRecord | undefined>;
  findDepositIntentByIdempotencyKey(key: string): Promise<DepositIntentRecord | undefined>;

  saveTrancheBinding(record: TrancheBindingRecord): Promise<void>;
  getTrancheBinding(chainId: number, escrowAddress: Address, trancheId: string): Promise<TrancheBindingRecord | undefined>;
  getTrancheBindingByStage(
    chainId: number,
    escrowAddress: Address,
    orderId: string,
    stageId: string,
    payer: string
  ): Promise<TrancheBindingRecord | undefined>;
  findCanonicalBindingByStage(
    chainId: number,
    escrowAddress: Address,
    orderId: string,
    stageId: string
  ): Promise<TrancheBindingRecord | undefined>;
  listTrancheBindingsByOrder(orderId: string): Promise<readonly TrancheBindingRecord[]>;
  listTrancheBindings(chainId: number, escrowAddress: Address): Promise<readonly TrancheBindingRecord[]>;

  recordAnomaly(record: BindingEventAnomaly): Promise<void>;
  listAnomalies(chainId: number, escrowAddress: Address): Promise<readonly BindingEventAnomaly[]>;

  getCursor(chainId: number, escrowAddress: Address): Promise<BindingIndexCursor | undefined>;
  saveCursor(cursor: BindingIndexCursor): Promise<void>;

  resetProjection(chainId: number, escrowAddress: Address): Promise<void>;
}

function escrowKey(chainId: number, escrowAddress: string): string {
  return `${chainId}:${escrowAddress.toLowerCase()}`;
}

function bindingKey(chainId: number, escrowAddress: string, trancheId: string): string {
  return `${escrowKey(chainId, escrowAddress)}:${trancheId.toLowerCase()}`;
}

function anomalyKey(record: BindingEventAnomaly): string {
  return `${escrowKey(record.chainId, record.escrowAddress)}:${record.blockNumber}:${record.logIndex}:${record.reason}`;
}

export class MemoryBindingStore implements BindingStore {
  readonly #instances = new Map<string, EscrowInstanceRecord>();
  readonly #intents = new Map<string, DepositIntentRecord>();
  readonly #bindings = new Map<string, TrancheBindingRecord>();
  readonly #anomalies = new Map<string, BindingEventAnomaly>();
  readonly #cursors = new Map<string, BindingIndexCursor>();

  async saveEscrowInstance(record: EscrowInstanceRecord): Promise<void> {
    this.#instances.set(escrowKey(record.chainId, record.escrowAddress), record);
  }

  async getEscrowInstance(chainId: number, escrowAddress: Address): Promise<EscrowInstanceRecord | undefined> {
    return this.#instances.get(escrowKey(chainId, escrowAddress));
  }

  async listEscrowInstances(): Promise<readonly EscrowInstanceRecord[]> {
    return [...this.#instances.values()].sort((left, right) =>
      escrowKey(left.chainId, left.escrowAddress).localeCompare(escrowKey(right.chainId, right.escrowAddress))
    );
  }

  async saveDepositIntent(record: DepositIntentRecord): Promise<void> {
    for (const existing of this.#intents.values()) {
      if (existing.idempotencyKey === record.idempotencyKey) {
        throw new StorageConstraintError("deposit intent idempotency key already exists");
      }
      if (
        existing.status === "active" &&
        record.status === "active" &&
        existing.chainId === record.chainId &&
        existing.escrowAddress === record.escrowAddress &&
        existing.orderId === record.orderId &&
        existing.stageId === record.stageId
      ) {
        throw new StorageConstraintError("an active deposit intent already exists for this stage");
      }
    }
    this.#intents.set(record.intentId, record);
  }

  async updateDepositIntent(record: DepositIntentRecord): Promise<void> {
    this.#intents.set(record.intentId, record);
  }

  async getDepositIntent(intentId: string): Promise<DepositIntentRecord | undefined> {
    return this.#intents.get(intentId);
  }

  async findDepositIntentByStage(
    chainId: number,
    escrowAddress: Address,
    orderId: string,
    stageId: string,
    statuses?: readonly DepositIntentStatus[]
  ): Promise<DepositIntentRecord | undefined> {
    const address = escrowAddress.toLowerCase();
    const wanted = statuses ? new Set(statuses) : undefined;
    return [...this.#intents.values()]
      .filter((intent) =>
        intent.chainId === chainId &&
        intent.escrowAddress === address &&
        intent.orderId === orderId.toLowerCase() &&
        intent.stageId === stageId.toLowerCase() &&
        (wanted === undefined || wanted.has(intent.status))
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  }

  async findDepositIntentByIdempotencyKey(key: string): Promise<DepositIntentRecord | undefined> {
    return [...this.#intents.values()].find((intent) => intent.idempotencyKey === key);
  }

  async saveTrancheBinding(record: TrancheBindingRecord): Promise<void> {
    for (const existing of this.#bindings.values()) {
      if (existing.bindingId === record.bindingId) {
        continue;
      }
      if (
        existing.chainId === record.chainId &&
        existing.escrowAddress === record.escrowAddress &&
        (existing.trancheId === record.trancheId ||
          (existing.orderId === record.orderId &&
            existing.stageId === record.stageId &&
            existing.payer === record.payer))
      ) {
        throw new StorageConstraintError("tranche binding already exists for this tranche/payer");
      }
    }
    this.#bindings.set(bindingKey(record.chainId, record.escrowAddress, record.trancheId), record);
  }

  async getTrancheBinding(
    chainId: number,
    escrowAddress: Address,
    trancheId: string
  ): Promise<TrancheBindingRecord | undefined> {
    return this.#bindings.get(bindingKey(chainId, escrowAddress, trancheId));
  }

  async getTrancheBindingByStage(
    chainId: number,
    escrowAddress: Address,
    orderId: string,
    stageId: string,
    payer: string
  ): Promise<TrancheBindingRecord | undefined> {
    const address = escrowAddress.toLowerCase();
    const normalizedPayer = payer.toLowerCase();
    return [...this.#bindings.values()].find(
      (binding) =>
        binding.chainId === chainId &&
        binding.escrowAddress === address &&
        binding.orderId === orderId.toLowerCase() &&
        binding.stageId === stageId.toLowerCase() &&
        binding.payer === normalizedPayer
    );
  }

  async findCanonicalBindingByStage(
    chainId: number,
    escrowAddress: Address,
    orderId: string,
    stageId: string
  ): Promise<TrancheBindingRecord | undefined> {
    const address = escrowAddress.toLowerCase();
    return [...this.#bindings.values()]
      .filter(
        (binding) =>
          binding.chainId === chainId &&
          binding.escrowAddress === address &&
          binding.orderId === orderId.toLowerCase() &&
          binding.stageId === stageId.toLowerCase() &&
          binding.state !== "foreign"
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  }

  async listTrancheBindingsByOrder(orderId: string): Promise<readonly TrancheBindingRecord[]> {
    const normalized = orderId.toLowerCase();
    return [...this.#bindings.values()]
      .filter((binding) => binding.orderId === normalized)
      .sort((left, right) => left.stageId.localeCompare(right.stageId));
  }

  async listTrancheBindings(chainId: number, escrowAddress: Address): Promise<readonly TrancheBindingRecord[]> {
    const address = escrowAddress.toLowerCase();
    return [...this.#bindings.values()]
      .filter((binding) => binding.chainId === chainId && binding.escrowAddress === address)
      .sort((left, right) => left.stageId.localeCompare(right.stageId));
  }

  async recordAnomaly(record: BindingEventAnomaly): Promise<void> {
    const key = anomalyKey(record);
    if (!this.#anomalies.has(key)) {
      this.#anomalies.set(key, record);
    }
  }

  async listAnomalies(chainId: number, escrowAddress: Address): Promise<readonly BindingEventAnomaly[]> {
    const address = escrowAddress.toLowerCase();
    return [...this.#anomalies.values()]
      .filter((anomaly) => anomaly.chainId === chainId && anomaly.escrowAddress === address)
      .sort((left, right) =>
        left.blockNumber === right.blockNumber
          ? left.logIndex - right.logIndex
          : left.blockNumber.localeCompare(right.blockNumber)
      );
  }

  async getCursor(chainId: number, escrowAddress: Address): Promise<BindingIndexCursor | undefined> {
    return this.#cursors.get(escrowKey(chainId, escrowAddress));
  }

  async saveCursor(cursor: BindingIndexCursor): Promise<void> {
    this.#cursors.set(escrowKey(cursor.chainId, cursor.escrowAddress), cursor);
  }

  async resetProjection(chainId: number, escrowAddress: Address): Promise<void> {
    const key = escrowKey(chainId, escrowAddress);
    for (const [bindingMapKey, binding] of this.#bindings) {
      if (bindingKey(binding.chainId, binding.escrowAddress, binding.trancheId).startsWith(`${key}:`)) {
        this.#bindings.delete(bindingMapKey);
      }
    }
    for (const [anomalyMapKey, anomaly] of this.#anomalies) {
      if (anomalyKey(anomaly).startsWith(`${key}:`)) {
        this.#anomalies.delete(anomalyMapKey);
      }
    }
    for (const [intentId, intent] of this.#intents) {
      if (
        intent.chainId === chainId &&
        intent.escrowAddress === escrowAddress.toLowerCase() &&
        (intent.status === "deposited" || intent.status === "submitted")
      ) {
        this.#intents.set(intentId, { ...intent, status: "active" });
      }
    }
  }
}
