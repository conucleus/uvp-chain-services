import { createPublicClient, http } from "viem";

/**
 * 链时钟端口：latest block timestamp（秒）。签名 deadline 与到期判定
 * 属协议面，一律以链时钟为源，宿主墙钟偏移不得影响。
 */
export interface ChainClock {
  latestBlockTimestampSeconds(): Promise<number>;
}

/** viem publicClient 的链时钟实现：每次读 latest block。 */
export function createViemChainClock(rpcUrl: string): ChainClock {
  const client = createPublicClient({ transport: http(rpcUrl) });
  return {
    async latestBlockTimestampSeconds(): Promise<number> {
      const block = await client.getBlock({ blockTag: "latest" });
      return Number(block.timestamp);
    }
  };
}
