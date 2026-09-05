import type { ChainServicesConfig } from "../config/index.js";
import type { ChainEventSource } from "../indexer/service.js";
import { ViemChainEventSource, hasConfiguredEvmIndexerContracts } from "../indexer/viem-event-source.js";
import type { Logger } from "../shared/types.js";
import { UnsupportedChainTargetError } from "../shared/types.js";

export function createChainEventSourceForTarget(
  config: ChainServicesConfig,
  options: { readonly logger?: Logger } = {},
): ChainEventSource | undefined {
  const target = config.network.chainTarget ?? "evm";
  switch (target) {
    case "evm":
      return hasConfiguredEvmIndexerContracts(config)
        ? new ViemChainEventSource({ ...(options.logger ? { logger: options.logger } : {}) })
        : undefined;
    case "solana":
      throw new UnsupportedChainTargetError("solana", "solana chain event source is reserved but not implemented");
  }
  throw new UnsupportedChainTargetError(String(target));
}
