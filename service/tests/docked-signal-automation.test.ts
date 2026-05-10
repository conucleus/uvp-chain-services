import { describe, expect, it, vi } from "vitest";
import {
  createDockedSignalAutomationService,
  createStateMachineDockedSignalBroadcastAdapter,
  discoverDockedSignalCandidates,
  dockedSignalIdempotencyKey,
  type DockedSignalBroadcastAdapter,
  type SubmitDockedSignalCall
} from "../src/docked-signals/index.js";
import {
  stateMachineScopedKey,
  type ProjectionProvenance,
  type ProjectionSnapshot,
  type StateMachineDockedSignalBindingProjection,
  type StateMachineOrderProjection,
  type StateMachineProofProjection,
  type StateMachineSignalProjection
} from "../src/indexer/projections.js";
import type { TrustProjectionSnapshot } from "../src/indexer/trust-projections.js";
import type { Address, Hex } from "../src/shared/types.js";

const chainId = 31337;
const stateMachineAddress = "0x1111111111111111111111111111111111111111" as Address;
const dockingModuleAddress = "0x2222222222222222222222222222222222222222" as Address;
const gasPayer = "0x3333333333333333333333333333333333333333" as Address;
const localOrderId = bytes32("1");
const linkedOrderId = bytes32("2");
const localSourceId = bytes32("3");
const localSignalId = bytes32("4");
const linkedSourceId = bytes32("5");
const linkedSignalId = bytes32("6");
const payloadHash = bytes32("7");
const linkedIdempotencyKey = bytes32("8");
const localPlanId = bytes32("100");
const localPlanHash = bytes32("101");
const linkedPlanId = bytes32("102");
const linkedPlanHash = bytes32("103");
const trustRegistryAddress = "0x4444444444444444444444444444444444444444" as Address;

describe("docked signal automation", () => {
  it("discovers a linked signal that has not been mapped into the local order", () => {
    const snapshot = projectionSnapshot();

    const discovery = discoverDockedSignalCandidates(snapshot, {
      dockingModuleAddress,
      maxCandidates: 10
    });

    expect(discovery).toMatchObject({
      scannedBindings: 1,
      capped: false
    });
    expect(discovery.candidates).toHaveLength(1);
    expect(discovery.candidates[0]).toMatchObject({
      chainId,
      dockingModuleAddress,
      idempotencyKey: dockedSignalIdempotencyKey(
        stateMachineOrder(localOrderId, { docked: true }),
        binding(),
        linkedSignal()
      )
    });
  });

  it("does not rediscover a docked signal after the local mapped signal exists", () => {
    const snapshot = projectionSnapshot({
      localSignals: {
        [`${localSourceId}:${localSignalId}`]: signal(localOrderId, localSourceId, localSignalId)
      }
    });

    const discovery = discoverDockedSignalCandidates(snapshot, {
      dockingModuleAddress,
      maxCandidates: 10
    });

    expect(discovery.candidates).toEqual([]);
  });

  it("requires active Store plan trust when the trusted-plan policy is enabled", () => {
    const snapshot = projectionSnapshot();

    const untrustedDiscovery = discoverDockedSignalCandidates(snapshot, {
      dockingModuleAddress,
      maxCandidates: 10,
      requireTrustedPlans: true
    });
    const trustedDiscovery = discoverDockedSignalCandidates(snapshot, {
      dockingModuleAddress,
      maxCandidates: 10,
      requireTrustedPlans: true,
      trustSnapshot: trustSnapshot()
    });

    expect(untrustedDiscovery.candidates).toEqual([]);
    expect(trustedDiscovery.candidates).toHaveLength(1);
  });

  it("does not automate a docked signal after either Zhixu plan is revoked", () => {
    const discovery = discoverDockedSignalCandidates(projectionSnapshot(), {
      dockingModuleAddress,
      maxCandidates: 10,
      requireTrustedPlans: true,
      trustSnapshot: trustSnapshot({ linkedRevoked: true })
    });

    expect(discovery.candidates).toEqual([]);
  });

  it("keeps submitted candidates suppressed until the projection catches up", async () => {
    const broadcast = vi.fn(async (candidate) => ({
      status: "submitted" as const,
      candidateId: candidate.candidateId,
      txHash: bytes32("99"),
      attempt: {
        status: "submitted" as const,
        txHash: bytes32("99"),
        retryable: false
      }
    }));
    const service = createDockedSignalAutomationService({
      config: {
        enabled: true,
        maxCandidatesPerRun: 4,
        requireTrustedPlans: false,
        maxGasPerTx: 500_000n,
        waitForReceipt: true
      },
      dockingModuleAddress,
      broadcastAdapter: { broadcast } satisfies DockedSignalBroadcastAdapter
    });
    const snapshot = projectionSnapshot();

    await service.processProjection(snapshot);
    await service.processProjection(snapshot);

    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it("skips broadcast when estimated gas exceeds the configured cap", async () => {
    const walletClient = {
      account: { address: gasPayer },
      writeContract: vi.fn(async () => bytes32("10"))
    };
    const publicClient = {
      getChainId: vi.fn(async () => chainId),
      estimateContractGas: vi.fn(async () => 600_000n),
      waitForTransactionReceipt: vi.fn(async () => ({ status: "success" as const, blockNumber: 12n }))
    };
    const adapter = createStateMachineDockedSignalBroadcastAdapter({
      chainId,
      publicClient,
      walletClient,
      maxGasPerTx: 500_000n
    });
    const candidate = discoverDockedSignalCandidates(projectionSnapshot(), {
      dockingModuleAddress,
      maxCandidates: 10
    }).candidates[0]!;

    const result = await adapter.broadcast(candidate);

    expect(result).toMatchObject({
      status: "skipped",
      attempt: {
        status: "skipped",
        errorCode: "estimated_gas_exceeds_cap",
        estimatedGas: "600000"
      }
    });
    expect(walletClient.writeContract).not.toHaveBeenCalled();
  });

  it("writes submitDockedSignal with deterministic args under the gas cap", async () => {
    const walletClient = {
      account: { address: gasPayer },
      writeContract: vi.fn(async (_call: SubmitDockedSignalCall) => bytes32("11"))
    };
    const publicClient = {
      getChainId: vi.fn(async () => chainId),
      estimateContractGas: vi.fn(async () => 120_000n),
      waitForTransactionReceipt: vi.fn(async () => ({ status: "success" as const, blockNumber: 12n }))
    };
    const adapter = createStateMachineDockedSignalBroadcastAdapter({
      chainId,
      publicClient,
      walletClient,
      maxGasPerTx: 500_000n,
      confirmOnReceipt: true
    });
    const candidate = discoverDockedSignalCandidates(projectionSnapshot(), {
      dockingModuleAddress,
      maxCandidates: 10
    }).candidates[0]!;

    const result = await adapter.broadcast(candidate);

    expect(result).toMatchObject({
      status: "confirmed",
      txHash: bytes32("11"),
      blockNumber: "12"
    });
    expect(walletClient.writeContract).toHaveBeenCalledWith(expect.objectContaining({
      address: dockingModuleAddress,
      functionName: "submitDockedSignal",
      args: [localOrderId, linkedOrderId, linkedSourceId, linkedSignalId, candidate.idempotencyKey]
    }));
  });
});

function projectionSnapshot(options: {
  readonly localSignals?: Readonly<Record<string, StateMachineSignalProjection>>;
} = {}): ProjectionSnapshot {
  const localOrder = stateMachineOrder(localOrderId, {
    docked: true,
    ...(options.localSignals ? { signals: options.localSignals } : {})
  });
  const linkedOrder = stateMachineOrder(linkedOrderId, {
    planId: linkedPlanId,
    planHash: linkedPlanHash,
    signals: {
      [`${linkedSourceId}:${linkedSignalId}`]: linkedSignal()
    }
  });
  return {
    rebuildable: true,
    eventCount: 1,
    orders: {},
    stateMachinePlans: {},
    stateMachineModules: {},
    stateMachineDeployments: {},
    stateMachineOrders: {
      [stateMachineScopedKey(chainId, stateMachineAddress, localOrderId)]: localOrder,
      [stateMachineScopedKey(chainId, stateMachineAddress, linkedOrderId)]: linkedOrder
    },
    stateMachineTasks: {}
  };
}

function stateMachineOrder(orderId: Hex, options: {
  readonly docked?: boolean;
  readonly signals?: Readonly<Record<string, StateMachineSignalProjection>>;
  readonly planId?: Hex;
  readonly planHash?: Hex;
} = {}): StateMachineOrderProjection {
  return {
    orderId,
    chainId,
    contractAddress: stateMachineAddress,
    planId: options.planId ?? localPlanId,
    planHash: options.planHash ?? localPlanHash,
    status: "running",
    authorizations: {},
    signals: options.signals ?? {},
    stageExecutorOverlays: {},
    stageResourceOverlays: {},
    dockedOrderLinks: options.docked
      ? {
          [linkedOrderId]: {
            localOrderId,
            selectorStageId: bytes32("12"),
            localSourceId,
            linkedOrderId,
            linkedPlanId,
            selectorWallet: gasPayer,
            linkHash: bytes32("104"),
            linkNonce: "1",
            metadataURI: "",
            signalBindings: {
              [`${linkedSourceId}:${linkedSignalId}`]: binding()
            },
            updatedAt: provenance(1),
            proof: proof("DockedOrderLinked", 1)
          }
        }
      : {},
    hooks: {},
    tasks: {},
    timeline: [],
    proof: [],
    updatedAt: provenance(1)
  };
}

function trustSnapshot(options: {
  readonly localRevoked?: boolean;
  readonly linkedRevoked?: boolean;
} = {}): TrustProjectionSnapshot {
  return {
    rebuildable: true,
    eventCount: 2,
    plans: {
      local: planTrust(localPlanId, localPlanHash, options.localRevoked ?? false, 40),
      linked: planTrust(linkedPlanId, linkedPlanHash, options.linkedRevoked ?? false, 41)
    },
    suppliers: {}
  };
}

function planTrust(planId: Hex, planHash: Hex, revoked: boolean, index: number): TrustProjectionSnapshot["plans"][string] {
  const updatedAt = provenance(index);
  return {
    registryAddress: trustRegistryAddress,
    planId,
    planHash,
    artifactHash: bytes32(String(index + 100)),
    policyHash: bytes32(String(index + 101)),
    metadataHash: bytes32(String(index + 102)),
    metadataURI: "",
    attester: gasPayer,
    status: revoked ? "revoked" : "attested",
    revoked,
    attestedAt: provenance(index - 1),
    updatedAt,
    ...(revoked ? {
      revokeReasonHash: bytes32(String(index + 103)),
      revokeReasonURI: "",
      revokedAt: updatedAt
    } : {})
  };
}

function binding(): StateMachineDockedSignalBindingProjection {
  return {
    localOrderId,
    linkedOrderId,
    localSourceId,
    localSignalId,
    linkedSourceId,
    linkedSignalId,
    updatedAt: provenance(2),
    proof: proof("DockedSignalMapped", 2)
  };
}

function linkedSignal(): StateMachineSignalProjection {
  return signal(linkedOrderId, linkedSourceId, linkedSignalId);
}

function signal(orderId: Hex, sourceId: Hex, signalId: Hex): StateMachineSignalProjection {
  return {
    orderId,
    sourceId,
    signalId,
    payloadHash,
    idempotencyKey: linkedIdempotencyKey,
    submitter: gasPayer,
    submittedAt: provenance(3),
    proof: proof("SignalSubmitted", 3)
  };
}

function proof(eventName: string, index: number): StateMachineProofProjection {
  return {
    ...provenance(index),
    eventId: `event-${index}`,
    eventName,
    args: {}
  };
}

function provenance(index: number): ProjectionProvenance {
  return {
    chainId,
    contractAddress: stateMachineAddress,
    blockNumber: BigInt(index),
    transactionHash: bytes32(String(index + 20)),
    logIndex: index
  };
}

function bytes32(value: string): Hex {
  return `0x${value.padStart(64, "0")}` as Hex;
}
