import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, parseAbi, type Hex, type Log } from "viem";
import { ViemChainEventSource } from "../src/indexer/viem-event-source.js";
import { createChainEventSourceForTarget } from "../src/chain-adapters/events.js";
import type { ChainServicesConfig } from "../src/config/index.js";
import { UnsupportedChainTargetError } from "@uvp-eth/service-runtime";
import { toWire } from "@uvp-eth/chain-read-contract";
import { proofOf } from "../src/indexer/projections/proof.js";
import { keccak256Hex } from "@uvp-eth/compiler";
import { dockRegisteredLog } from "./dock-fixtures.js";

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

  it("decodes identity registry logs from configured contracts", async () => {
    const supplierLog = supplierCapabilityLog();
    const eventSource = new ViemChainEventSource({
      publicClient: {
        async getBlockNumber() {
          return 0n;
        },
        async getLogs(input) {
          return [supplierLog].filter((log) => log.address === input.address);
        }
      }
    });

    const events = await eventSource.readEvents(
      {
        chainId: 84532,
        fromBlock: 100n,
        toBlock: 100n
      },
      registryConfig()
    );

    expect(events).toHaveLength(1);
    expect(events).toEqual([
      expect.objectContaining({
        contractAddress: identityRegistryAddress,
        eventName: "SupplierRegistered",
        args: {
          supplierId: bytes32Hex("0b"),
          account: "0x2222222222222222222222222222222222222222"
        }
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

  it("fails closed with a named error when an indexed contract log cannot be decoded", async () => {
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

    const error = await captureRejection(eventSource.readEvents(
      {
        chainId: 84532,
        fromBlock: 100n,
        toBlock: 100n
      },
      chainServicesConfig()
    ));

    expect(error).toMatchObject({
      name: "UndecodableChainLogError",
      chainId: 84532,
      contract: "UVPStateMachine",
      address: stateMachineAddress,
      blockNumber: 100n,
      transactionHash: bytes32Hex("cd"),
      logIndex: 0
    });
    expect((error as Error).message).toContain("the indexed contract ABI does not decode this log");
    expect("unresolvedLogCount" in eventSource).toBe(false);
  });

  it("rejects a batch instead of returning the decodable prefix when any later log is undecodable", async () => {
    const validLog = planRegisteredLog();
    const invalidLog = {
      ...planRegisteredLog(),
      logIndex: 1,
      data: "0x01" as Hex
    } as Log;
    const eventSource = new ViemChainEventSource({
      publicClient: {
        async getBlockNumber() {
          return 0n;
        },
        async getLogs() {
          return [validLog, invalidLog];
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
    )).rejects.toMatchObject({
      name: "UndecodableChainLogError",
      logIndex: 1
    });
  });

  it("fails loudly on a malformed log address instead of swallowing it as undecodable", async () => {
    const malformedAddressLog = {
      ...planRegisteredLog(),
      address: "0xnot-an-address"
    } as Log;
    const eventSource = new ViemChainEventSource({
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
  });

  it("decodes DockRegistered nested uint64 tuple args into a JSON-serializable proof", async () => {
    const docHash = keccak256Hex("dock-document-tuple");
    const log = dockRegisteredLog({ address: dockRegistryAddress, docHash });
    const eventSource = new ViemChainEventSource({
      publicClient: {
        async getBlockNumber() {
          return 0n;
        },
        async getLogs(input) {
          return input.address === dockRegistryAddress ? [log] : [];
        }
      }
    });

    const events = await eventSource.readEvents(
      {
        chainId: 84532,
        fromBlock: 100n,
        toBlock: 100n
      },
      dockRegistryConfig()
    );

    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.eventName).toBe("DockRegistered");
    const outputs = event.args.outputs as readonly {
      readonly signalId: string;
      readonly atoms: readonly { readonly stageId: string }[];
      readonly window: readonly { readonly delaySeconds: bigint }[];
    }[];
    expect(outputs[0]?.signalId).toBe(`0x${outputs[0]?.signalId.slice(2).toLowerCase()}`);
    expect(outputs[0]?.window[0]?.delaySeconds).toBe(15n);

    const proof = proofOf(event);
    expect(typeof proof.args.outputs).toBe("string");
    expect(proof.args.outputs).toContain('"delaySeconds":"15"');
    expect(() => JSON.stringify(proof.args)).not.toThrow();
    expect(() => JSON.stringify(toWire(proof))).not.toThrow();
  });
});

async function captureRejection(run: Promise<unknown>): Promise<unknown> {
  try {
    await run;
  } catch (error) {
    return error;
  }
  throw new Error("expected the read to reject");
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

const stateMachineAddress = "0x1111111111111111111111111111111111111111";
const identityRegistryAddress = "0x5555555555555555555555555555555555555555";
const dockRegistryAddress = "0x6666666666666666666666666666666666666666";

const stateMachineTestAbi = parseAbi([
  "event PlanRegistered(bytes32 indexed planId,bytes32 planHash,uint256 hookCount)"
]);

const identityRegistryTestAbi = parseAbi([
  "event SupplierRegistered(bytes32 indexed supplierId,address indexed account)"
]);

function planRegisteredLog(input: { readonly removed?: boolean } = {}): Log {
  const planId = "0x0000000000000000000000000000000000000000000000000000000000000101";
  const planHash = "0x0000000000000000000000000000000000000000000000000000000000000201";
  return {
    address: stateMachineAddress,
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

function supplierCapabilityLog(): Log {
  return {
    address: identityRegistryAddress,
    blockNumber: 100n,
    blockHash: bytes32Hex("ab"),
    transactionHash: bytes32Hex("cf"),
    transactionIndex: 0,
    logIndex: 1,
    data: "0x",
    topics: encodeEventTopics({
      abi: identityRegistryTestAbi,
      eventName: "SupplierRegistered",
      args: {
        supplierId: bytes32Hex("0b"),
        account: "0x2222222222222222222222222222222222222222"
      }
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
        UVPStateMachine: stateMachineAddress
      }
    }
  } as unknown as ChainServicesConfig;
}

function dockRegistryConfig(): ChainServicesConfig {
  const base = chainServicesConfig();
  return {
    ...base,
    network: {
      ...base.network,
      contracts: {
        ...base.network.contracts,
        UVPDockRegistry: dockRegistryAddress
      }
    }
  } as unknown as ChainServicesConfig;
}

function registryConfig(): ChainServicesConfig {
  const base = chainServicesConfig();
  return {
    ...base,
    network: {
      ...base.network,
      contracts: {
        ...base.network.contracts,
        UVPIdentityRegistry: identityRegistryAddress
      }
    }
  } as unknown as ChainServicesConfig;
}
