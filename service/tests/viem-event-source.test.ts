import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, parseAbi, type Hex, type Log } from "viem";
import { INDEXER_EVENT_ABIS, ViemChainEventSource } from "../src/indexer/viem-event-source.js";
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

  it("indexes module contracts configured through flat contract keys", async () => {
    const dockingModuleAddress = "0x6666666666666666666666666666666666666666";
    const dockInstanceId = "0x0000000000000000000000000000000000000000000000000000000000000901";
    const localOrderId = "0x0000000000000000000000000000000000000000000000000000000000000902";
    const linkedOrderId = "0x0000000000000000000000000000000000000000000000000000000000000903";
    const dockOpenedLog = {
      address: dockingModuleAddress,
      blockNumber: 100n,
      blockHash: bytes32Hex("ab"),
      transactionHash: bytes32Hex("cf"),
      transactionIndex: 0,
      logIndex: 0,
      data: encodeAbiParameters(
        [
          { type: "bytes32" },
          { type: "bytes32" },
          { type: "bytes32" },
          { type: "bytes32" },
          { type: "bytes32" },
          { type: "uint8" },
          { type: "address" }
        ],
        [
          "0x0000000000000000000000000000000000000000000000000000000000000904",
          "0x0000000000000000000000000000000000000000000000000000000000000905",
          "0x0000000000000000000000000000000000000000000000000000000000000906",
          "0x0000000000000000000000000000000000000000000000000000000000000907",
          "0x0000000000000000000000000000000000000000000000000000000000000908",
          1,
          "0x2222222222222222222222222222222222222222"
        ]
      ),
      topics: encodeEventTopics({
        abi: INDEXER_EVENT_ABIS.UVPDockingModule,
        eventName: "DockOpened",
        args: { dockInstanceId, localOrderId, linkedOrderId }
      }),
      removed: false
    } as Log;
    const queriedAddresses: string[] = [];
    const eventSource = new ViemChainEventSource({
      publicClient: {
        async getBlockNumber() {
          return 0n;
        },
        async getLogs(input) {
          queriedAddresses.push(input.address);
          return input.address === dockingModuleAddress ? [dockOpenedLog] : [];
        }
      }
    });

    const events = await eventSource.readEvents(
      { chainId: 84532, fromBlock: 100n, toBlock: 100n },
      {
        ...chainServicesConfig(),
        network: {
          ...chainServicesConfig().network,
          contracts: {
            UVPStateMachine: "0x1111111111111111111111111111111111111111",
            UVPDockingModule: dockingModuleAddress
          }
        }
      } as unknown as ChainServicesConfig
    );

    expect(queriedAddresses).toContain(dockingModuleAddress);
    expect(events).toEqual([
      expect.objectContaining({
        eventName: "DockOpened",
        contractAddress: dockingModuleAddress
      })
    ]);
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
        toBlock: 10_098n
      },
      {
        address: "0x1111111111111111111111111111111111111111",
        fromBlock: 10_099n,
        toBlock: 20_097n
      },
      {
        address: "0x1111111111111111111111111111111111111111",
        fromBlock: 20_098n,
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

  it("decodes StageExecutorActivated metadata URI from EVM logs", async () => {
    const activatedLog = stageExecutorActivatedLog();
    const eventSource = new ViemChainEventSource({
      publicClient: {
        async getBlockNumber() {
          return 0n;
        },
        async getLogs() {
          return [activatedLog];
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
        eventName: "StageExecutorActivated",
        args: expect.objectContaining({
          metadataURI: "ipfs://stage-executor-patch/1"
        })
      })
    ]);
  });

  it("anchors the finalized bound on the finalized tag by default and on confirmations when overridden", async () => {
    const blockCalls: unknown[] = [];
    const finalizedSource = new ViemChainEventSource({
      publicClient: {
        async getBlockNumber() {
          return 5_000n;
        },
        async getLogs() {
          return [];
        },
        async getBlock(input) {
          blockCalls.push(input);
          return { hash: "0xab", number: 4_950n };
        }
      }
    });
    await expect(finalizedSource.getFinalizedBlock(chainServicesConfig())).resolves.toBe(4_950n);
    expect(blockCalls).toEqual([{ blockTag: "finalized" }]);

    const confirmationsSource = new ViemChainEventSource({
      publicClient: {
        async getBlockNumber() {
          return 5_000n;
        },
        async getLogs() {
          return [];
        }
      }
    });
    await expect(confirmationsSource.getFinalizedBlock({
      ...chainServicesConfig(),
      network: {
        ...chainServicesConfig().network,
        finalityAnchor: "confirmations",
        finalityConfirmations: 2
      }
    } as unknown as ChainServicesConfig)).resolves.toBe(4_998n);
  });

  it("fails closed when the finalized anchor meets an RPC client without getBlock support", async () => {
    const source = new ViemChainEventSource({
      publicClient: {
        async getBlockNumber() {
          return 5_000n;
        },
        async getLogs() {
          return [];
        }
      }
    });
    await expect(source.getFinalizedBlock(chainServicesConfig()))
      .rejects.toThrow(/UVP_FINALITY_ANCHOR=confirmations/);
  });

  it("fails closed when the finalized block carries no number instead of silently anchoring at 0", async () => {
    const source = new ViemChainEventSource({
      publicClient: {
        async getBlockNumber() {
          return 5_000n;
        },
        async getLogs() {
          return [];
        },
        async getBlock() {
          return { hash: "0xab", number: null };
        }
      }
    });
    await expect(source.getFinalizedBlock(chainServicesConfig()))
      .rejects.toThrow(/carries no number/);
  });

  it("skips an undecodable log with an explicit count instead of failing the index range", async () => {
    const invalidLog = {
      ...planRegisteredLog(),
      data: "0x01" as Hex
    } as Log;
    const logger = new CapturingLogger();
    const eventSource = new ViemChainEventSource({
      logger,
      publicClient: {
        async getBlockNumber() {
          return 0n;
        },
        async getLogs() {
          return [invalidLog];
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

    expect(events).toEqual([]);
    expect(eventSource.unresolvedLogCount).toBe(1);
    expect(eventSource.consumeUnresolvedLogCount()).toBe(1);
    expect(eventSource.unresolvedLogCount).toBe(0);
    expect(logger.warns.some((line) => line.includes("skipped undecodable chain log"))).toBe(true);
  });

  it("fails loudly on a malformed log address instead of swallowing it as undecodable", async () => {
    const malformedAddressLog = {
      ...planRegisteredLog(),
      address: "0xnot-an-address"
    } as Log;
    const logger = new CapturingLogger();
    const eventSource = new ViemChainEventSource({
      logger,
      publicClient: {
        async getBlockNumber() {
          return 0n;
        },
        async getLogs() {
          return [malformedAddressLog];
        }
      }
    });

    await expect(eventSource.readEvents(
      {
        chainId: 84532,
        fromBlock: 100n,
        toBlock: 100n
      },
      chainServicesConfig()
    )).rejects.toThrow(/20-byte EVM address/);
    expect(eventSource.unresolvedLogCount).toBe(0);
  });

  it("keeps 0x-prefixed string event args verbatim while lowercasing bytes args", async () => {
    const eventSource = new ViemChainEventSource({
      publicClient: {
        async getBlockNumber() {
          return 0n;
        },
        async getLogs() {
          return [stageExecutorActivatedLog({ metadataURI: "ipfs://Stage-Executor-Patch/0XAb" })];
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
        eventName: "StageExecutorActivated",
        args: expect.objectContaining({
          metadataURI: "ipfs://Stage-Executor-Patch/0XAb"
        })
      })
    ]);
  });
});

class CapturingLogger {
  readonly warns: string[] = [];

  warn(message: string): void {
    this.warns.push(message);
  }

  info(): void {
  }

  error(): void {
  }

  debug(): void {
  }
}

type AbiEvent = {
  readonly type: "event";
  readonly name: string;
  readonly anonymous?: boolean | undefined;
  readonly inputs: readonly {
    readonly name?: string | undefined;
    readonly type: string;
    readonly indexed?: boolean | undefined;
  }[];
};

function eventShape(event: AbiEvent) {
  return {
    name: event.name,
    anonymous: event.anonymous === true,
    inputs: event.inputs.map((input) => ({
      name: input.name ?? "",
      type: input.type,
      indexed: input.indexed === true
    }))
  };
}

function compareEventShape(
  left: ReturnType<typeof eventShape>,
  right: ReturnType<typeof eventShape>
): number {
  return left.name.localeCompare(right.name);
}

const stateMachineTestAbi = parseAbi([
  "event PlanRegistered(bytes32 indexed planId,bytes32 planHash,uint256 hookCount)",
  "event StageExecutorActivated(bytes32 indexed planId,bytes32 indexed orderId,bytes32 indexed targetStageId,address executor,bytes32 role,bytes32 metadataHash,uint256 patchNonce,string metadataURI)"
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

function stageExecutorActivatedLog(
  input: { readonly metadataURI?: string } = {}
): Log {
  const planId = "0x0000000000000000000000000000000000000000000000000000000000000303";
  const orderId = "0x0000000000000000000000000000000000000000000000000000000000000101";
  const targetStageId = "0x0000000000000000000000000000000000000000000000000000000000000202";
  const executor = "0x2222222222222222222222222222222222222222";
  return {
    address: "0x1111111111111111111111111111111111111111",
    blockNumber: 100n,
    blockHash: bytes32Hex("ab"),
    transactionHash: bytes32Hex("ce"),
    transactionIndex: 0,
    logIndex: 0,
    data: encodeAbiParameters(
      [
        { type: "address" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "string" }
      ],
      [
        executor,
        bytes32Hex("01"),
        bytes32Hex("02"),
        1n,
        input.metadataURI ?? "ipfs://stage-executor-patch/1"
      ]
    ),
    topics: encodeEventTopics({
      abi: stateMachineTestAbi,
      eventName: "StageExecutorActivated",
      args: { planId, orderId, targetStageId }
    }),
    removed: false
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
      contracts: {
        UVPStateMachine: "0x1111111111111111111111111111111111111111"
      }
    }
  } as unknown as ChainServicesConfig;
}
