import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, getEventSelector, parseAbi, type Hex, type Log } from "viem";
import { INDEXER_EVENT_ABIS, ViemChainEventSource } from "../src/indexer/viem-event-source.js";
import { createChainEventSourceForTarget } from "../src/chain-adapters/events.js";
import type { ChainServicesConfig } from "../src/config/index.js";
import { UnsupportedChainTargetError } from "../src/shared/types.js";

describe("ViemChainEventSource", () => {
  it("binds every indexed event topic to the frozen protocol ABI fixtures", () => {
    const fixtures: Readonly<Record<keyof typeof INDEXER_EVENT_ABIS, string>> = {
      UVPStateMachine: "uvp-state-machine.v0.9.json",
      UVPIdentityRegistry: "uvp-identity-registry.v0.1.json",
      UVPDeploymentRegistry: "uvp-deployment-registry.v0.2.json",
      UVPStagePatchModule: "uvp-stage-patch-module.v0.1.json",
      UVPPlanMetadataModule: "uvp-plan-metadata-module.v0.2.json",
      UVPDerivedSignalModule: "uvp-derived-signal-module.v0.1.json",
      UVPOrderLinkModule: "uvp-order-link-module.v0.1.json",
      UVPDockingModule: "uvp-docking-module.v2.0.json"
    };
    const artifacts: Readonly<Record<keyof typeof INDEXER_EVENT_ABIS, string>> = {
      UVPStateMachine: "UVPStateMachine.sol/UVPStateMachine.json",
      UVPIdentityRegistry: "UVPIdentityRegistry.sol/UVPIdentityRegistry.json",
      UVPDeploymentRegistry: "UVPDeploymentRegistry.sol/UVPDeploymentRegistry.json",
      UVPStagePatchModule: "UVPStagePatchModule.sol/UVPStagePatchModule.json",
      UVPPlanMetadataModule: "UVPPlanMetadataModule.sol/UVPPlanMetadataModule.json",
      UVPDerivedSignalModule: "UVPDerivedSignalModule.sol/UVPDerivedSignalModule.json",
      UVPOrderLinkModule: "UVPOrderLinkModule.sol/UVPOrderLinkModule.json",
      UVPDockingModule: "UVPDockingModule.sol/UVPDockingModule.json"
    };

    for (const [contractName, fixtureName] of Object.entries(fixtures)) {
      const fixture = JSON.parse(readFileSync(
        new URL(`../../../uvp-protocol/contracts/uvp-contracts/fixtures/${fixtureName}`, import.meta.url),
        "utf8"
      )) as {
        readonly events: Readonly<Record<string, { readonly topic: Hex }>>;
      };
      const abi = INDEXER_EVENT_ABIS[contractName as keyof typeof INDEXER_EVENT_ABIS];
      const actualTopics = Object.fromEntries(
        abi
          .filter((item) => item.type === "event")
          .map((item) => [item.name, getEventSelector(item)])
      );
      const expectedTopics = Object.fromEntries(
        Object.entries(fixture.events).map(([eventName, event]) => [eventName, event.topic])
      );
      expect(actualTopics, contractName).toEqual(expectedTopics);

      // A topic alone cannot reveal an indexed/non-indexed layout drift. Read
      // the compiled Solidity artifact as a second protocol source, so the
      // decoder cannot pass when its hand-written ABI and log encoder share a
      // mistaken indexed layout.
      const artifact = JSON.parse(readFileSync(
        new URL(
          `../../../uvp-protocol/contracts/uvp-contracts/out/${artifacts[contractName as keyof typeof INDEXER_EVENT_ABIS]}`,
          import.meta.url,
        ),
        "utf8",
      )) as { readonly abi: readonly AbiEvent[] };
      const actualEvents = abi
        .filter((item) => item.type === "event")
        .map(eventShape)
        .sort(compareEventShape);
      const artifactEvents = artifact.abi
        .filter((item) => item.type === "event")
        .map(eventShape)
        .sort(compareEventShape);
      expect(actualEvents, `${contractName} event ABI`).toEqual(artifactEvents);
    }
  });

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

  it("fails the index range when a configured contract emits an undecodable log", async () => {
    const invalidLog = {
      ...planRegisteredLog(),
      data: "0x01" as Hex
    } as Log;
    const eventSource = new ViemChainEventSource({
      publicClient: {
        async getBlockNumber() {
          return 0n;
        },
        async getLogs() {
          return [invalidLog];
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
    )).rejects.toThrow(/failed to decode UVPStateMachine event at block 100/);
  });
});

type AbiEvent = {
  readonly type: "event";
  readonly name: string;
  readonly anonymous?: boolean;
  readonly inputs: readonly {
    readonly name?: string;
    readonly type: string;
    readonly indexed?: boolean;
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

function stageExecutorActivatedLog(): Log {
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
        "ipfs://stage-executor-patch/1"
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
