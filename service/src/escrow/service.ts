// Escrow read service and rebuild entry. The service is stateless above the
// projection store: reads are scoped to the configured escrow address, and a
// rebuild is "clear one address + replay the same canonical events".

import type { Address } from "../shared/types.js";
import { replayEscrowEvents, trancheDTO } from "./projection.js";
import {
  type EscrowEvent,
  type EscrowProjectionStore,
  type EscrowQueryConfig,
  type EscrowQueryService,
  type EscrowReplaySummary,
  type EscrowTrancheDTO
} from "./types.js";

export interface CreateEscrowQueryServiceOptions {
  readonly store: EscrowProjectionStore;
  readonly config?: EscrowQueryConfig;
}

export function createEscrowQueryService(
  options: CreateEscrowQueryServiceOptions
): EscrowQueryService {
  const config = options.config;
  return {
    configured: config !== undefined,
    async listTranches(orderId: string): Promise<readonly EscrowTrancheDTO[]> {
      if (!config) {
        return [];
      }
      const records = await options.store.listTranches(
        config.address,
        orderId.toLowerCase()
      );
      return records.map(trancheDTO);
    },
    async getTranche(
      orderId: string,
      stageId: string
    ): Promise<EscrowTrancheDTO | undefined> {
      if (!config) {
        return undefined;
      }
      const record = await options.store.getTranche(
        config.address,
        orderId.toLowerCase(),
        stageId.toLowerCase()
      );
      return record ? trancheDTO(record) : undefined;
    }
  };
}

export async function rebuildEscrowProjection(options: {
  readonly store: EscrowProjectionStore;
  readonly escrowAddress: Address;
  readonly events: readonly EscrowEvent[];
}): Promise<EscrowReplaySummary> {
  await options.store.clear(options.escrowAddress);
  return replayEscrowEvents(options.store, options.events);
}
