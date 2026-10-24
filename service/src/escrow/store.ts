// In-memory escrow tranche store for tests and the memory storage driver.
// Semantics match the sqlite/postgres implementations: rows are keyed by
// (escrow address, tranche id) and reads are scoped to one escrow address.

import type { Address } from "../shared/types.js";
import { escrowRecordKey } from "./projection.js";
import type {
  EscrowProjectionStore,
  EscrowTrancheRecord
} from "./types.js";

export class MemoryEscrowStore implements EscrowProjectionStore {
  readonly #tranches = new Map<string, EscrowTrancheRecord>();

  async listTranches(
    escrowAddress: Address,
    orderId: string
  ): Promise<readonly EscrowTrancheRecord[]> {
    const address = escrowAddress.toLowerCase();
    const normalizedOrderId = orderId.toLowerCase();
    return [...this.#tranches.values()]
      .filter(
        (record) =>
          record.escrowAddress === address && record.orderId === normalizedOrderId
      )
      .sort((left, right) => left.stageId.localeCompare(right.stageId));
  }

  async getTranche(
    escrowAddress: Address,
    orderId: string,
    stageId: string
  ): Promise<EscrowTrancheRecord | undefined> {
    const address = escrowAddress.toLowerCase();
    const normalizedOrderId = orderId.toLowerCase();
    const normalizedStageId = stageId.toLowerCase();
    return [...this.#tranches.values()].find(
      (record) =>
        record.escrowAddress === address &&
        record.orderId === normalizedOrderId &&
        record.stageId === normalizedStageId
    );
  }

  async getTrancheById(
    escrowAddress: Address,
    trancheId: string
  ): Promise<EscrowTrancheRecord | undefined> {
    return this.#tranches.get(
      escrowRecordKey(escrowAddress, trancheId as `0x${string}`)
    );
  }

  async saveTranche(record: EscrowTrancheRecord): Promise<void> {
    this.#tranches.set(escrowRecordKey(record.escrowAddress, record.trancheId), record);
  }

  async clear(escrowAddress: Address): Promise<void> {
    const address = escrowAddress.toLowerCase();
    for (const [key, record] of this.#tranches) {
      if (record.escrowAddress === address) {
        this.#tranches.delete(key);
      }
    }
  }
}
