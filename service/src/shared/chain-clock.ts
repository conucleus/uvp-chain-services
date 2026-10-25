import { createPublicClient, http } from "viem";

export interface ChainClock {
  latestBlockTimestampSeconds(): Promise<number>;
}

export function createViemChainClock(rpcUrl: string): ChainClock {
  const client = createPublicClient({ transport: http(rpcUrl) });
  return {
    async latestBlockTimestampSeconds(): Promise<number> {
      const block = await client.getBlock({ blockTag: "latest" });
      return Number(block.timestamp);
    }
  };
}
