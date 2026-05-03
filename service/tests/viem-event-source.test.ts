import { describe, expect, it } from "vitest";
import { ViemChainEventSource } from "../src/indexer/viem-event-source.js";
import type { ChainServicesConfig } from "../src/config/index.js";

describe("ViemChainEventSource", () => {
  it("chunks getLogs requests under public RPC range limits", async () => {
    const calls: Array<{ address: string; fromBlock: bigint; toBlock: bigint }> = [];
    const eventSource = new ViemChainEventSource({
      publicClient: {
        async getBlockNumber() {
          return 0n;
        },
        async getLogs(input) {
          calls.push(input);
          return [];
        }
      }
    });

    await eventSource.readEvents(
      {
        chainId: 84532,
        fromBlock: 100n,
        toBlock: 20_150n
      },
      chainServicesConfig()
    );

    expect(calls).toEqual([
      {
        address: "0x1111111111111111111111111111111111111111",
        fromBlock: 100n,
        toBlock: 10_099n
      },
      {
        address: "0x1111111111111111111111111111111111111111",
        fromBlock: 10_100n,
        toBlock: 20_099n
      },
      {
        address: "0x1111111111111111111111111111111111111111",
        fromBlock: 20_100n,
        toBlock: 20_150n
      }
    ]);
  });
});

function chainServicesConfig(): ChainServicesConfig {
  return {
    network: {
      chainId: 84532,
      rpcUrl: "https://sepolia.base.org",
      deploymentBlock: 100n,
      finalityConfirmations: 2,
      reorgBufferBlocks: 12,
      contracts: {
        UVPStateMachine: "0x1111111111111111111111111111111111111111"
      }
    }
  } as unknown as ChainServicesConfig;
}
