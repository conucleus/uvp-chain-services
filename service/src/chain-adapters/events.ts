import type { ChainServicesConfig } from "../config/index.js";
import type { ChainEventSource } from "../indexer/service.js";
import { ViemChainEventSource, hasConfiguredEvmIndexerContracts } from "../indexer/viem-event-source.js";
import { UnsupportedChainTargetError } from "../shared/types.js";

export function createChainEventSourceForTarget(config: ChainServicesConfig): ChainEventSource | undefined {
  const target = config.network.chainTarget ?? "evm";
  switch (target) {
    case "evm":
      return hasConfiguredEvmIndexerContracts(config) ? new ViemChainEventSource() : undefined;
    case "solana":
      throw new UnsupportedChainTargetError("solana", "solana chain event source is reserved but not implemented");
  }
  throw new UnsupportedChainTargetError(String(target));
}
