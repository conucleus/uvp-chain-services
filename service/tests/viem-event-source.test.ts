import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, parseAbi, type Hex, type Log } from "viem";
import { ViemChainEventSource } from "../src/indexer/viem-event-source.js";
import { createChainEventSourceForTarget } from "../src/chain-adapters/events.js";
import type { ChainServicesConfig } from "../src/config/index.js";
import { UnsupportedChainTargetError } from "../src/shared/types.js";

describe("ViemChainEventSource", () => {
  it("routes the default chain event source through the EVM adapter boundary", () => {
    expect(createChainEventSourceForTarget(chainServicesConfig())).toBeInstanceOf(ViemChainEventSource);
    expect(() =>
      createChainEventSourceForTarget({
        ...chainServicesConfig(),
        network: {
          ...chainServicesConfig().network,
          chainTarget: "solana"
        }
      })
    ).toThrow(UnsupportedChainTargetError);
  });

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

  it("preserves removed logs for active-chain replay filtering", async () => {
    const removedLog = planRegisteredLog({ removed: true });
    const eventSource = new ViemChainEventSource({
      publicClient: {
        async getBlockNumber() {
          return 0n;
        },
        async getLogs() {
          return [removedLog];
        }
      }
    });

    const events = await eventSource.readEvents(
      {
        chainId: 84532,
        fromBlock: 100n,
        toBlock: 100n
      },
      chainServicesConfig()
    );

    expect(events).toEqual([
      expect.objectContaining({
        eventName: "PlanRegistered",
        removed: true
      })
    ]);
  });
});

const stateMachineTestAbi = parseAbi([
  "event PlanRegistered(bytes32 indexed planId,bytes32 planHash,uint256 hookCount)"
]);

function planRegisteredLog(input: { readonly removed?: boolean } = {}): Log {
  const planId = "0x0000000000000000000000000000000000000000000000000000000000000101";
  const planHash = "0x0000000000000000000000000000000000000000000000000000000000000201";
  return {
    address: "0x1111111111111111111111111111111111111111",
    blockNumber: 100n,
    blockHash: bytes32Hex("ab"),
    transactionHash: bytes32Hex("cd"),
    transactionIndex: 0,
    logIndex: 0,
    data: encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }],
      [planHash, 1n]
    ),
    topics: encodeEventTopics({
      abi: stateMachineTestAbi,
      eventName: "PlanRegistered",
      args: { planId }
    }),
    removed: input.removed === true
  } as Log;
}

function bytes32Hex(byte: string): Hex {
  return `0x${byte.repeat(32)}`;
}

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
