import { describe, expect, it } from "vitest";
import { onchainSignalKey } from "@uvp-eth/compiler";
import { IndexerService, type ChainEventSource } from "../src/indexer/service.js";
import { runSemanticOracleReplay, type SemanticOraclePlan } from "../src/indexer/semantic-oracle.js";
import { MemoryProjectionStore } from "../src/storage/projection-store.js";
import { hasProjectionDiagnosticsAnomalies } from "../src/storage/projection-store.js";
import type { ChainEvent } from "../src/indexer/events.js";
import type { ChainServicesConfig } from "../src/config/index.js";
import type { Hex } from "../src/shared/types.js";

const contractAddress = "0x1111111111111111111111111111111111111111";
const planId = "0x0000000000000000000000000000000000000000000000000000000000000101";
const planHash = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const orderId = "0x0000000000000000000000000000000000000000000000000000000000000202";
const hookId = "0x0000000000000000000000000000000000000000000000000000000000000303";
const stageId = "0x0000000000000000000000000000000000000000000000000000000000000a0a";
const hookName = "0x0000000000000000000000000000000000000000000000000000000000000b0b";
const sourceId = "0x0000000000000000000000000000000000000000000000000000000000000404";
const signalId = "0x0000000000000000000000000000000000000000000000000000000000000505";
const signalKey = onchainSignalKey(sourceId as Hex, signalId as Hex);
const signer = "0x4444444444444444444444444444444444444444";

function oraclePlan(instructions: readonly Record<string, unknown>[] = [
  { op: "SIGNAL", sourceId, signalId, signalKey }
]): SemanticOraclePlan {
  return {
    planId,
    zhixuId: "zhixu-1",
    compiledHooks: [
      {
        hookId,
        stageId,
        stageIdentifier: "stage-example",
        hookName: "example-review",
        orderTriggerKind: "none",
        emitReady: true,
        instructions
      }
    ],
    dependencyIndex: { [signalKey]: [hookId] }
  };
}

function baseEvents(): readonly ChainEvent[] {
  return [
    chainEvent(1n, 0, "PlanRegistered", { planId, planHash, hookCount: 1n }),
    chainEvent(2n, 0, "OrderRegistered", { orderId, planId }),
    chainEvent(3n, 0, "SignalSubmitted", {
      orderId,
      planId,
      sourceId,
      signalId,
      payloadHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      idempotencyKey: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      submitter: signer
    })
  ];
}

describe("indexer semantic oracle", () => {
  it("certifies a semantically consistent event stream against the plan artifact", () => {
    const summary = runSemanticOracleReplay(
      [...baseEvents(), hookReadyEvent(4n)],
      [oraclePlan()]
    );
    expect(summary).toEqual({
      semanticOracleCheckedPlanCount: 1,
      semanticOracleMismatchCount: 0,
      semanticOracleErrorCount: 0,
      semanticOracleExcludedPlanCount: 0
    });
  });

  it("counts an injected semantic fork without throwing", () => {
    // 语义分叉：链上观测到 HookReady，但事件流没有任何使该 hook 就绪的
    // 信号——oracle 的期望面与观测面分叉，计数非零且不 crash。
    const forked = runSemanticOracleReplay(
      [...baseEvents(), hookReadyEvent(4n), hookReadyEvent(5n, "0x0000000000000000000000000000000000000000000000000000000000000313")],
      [oraclePlan()]
    );
    expect(forked.semanticOracleMismatchCount).toBeGreaterThan(0);
    expect(forked.semanticOracleCheckedPlanCount).toBe(1);

    // 信号缺席（观测到 ready 但从未提交信号）同属分叉。
    const missingSignal = runSemanticOracleReplay(
      [baseEvents()[0]!, baseEvents()[1]!, hookReadyEvent(4n)],
      [oraclePlan()]
    );
    expect(missingSignal.semanticOracleMismatchCount).toBeGreaterThan(0);
  });

  it("excludes DELAY-carrying plans honestly instead of replaying them on a fabricated clock", () => {
    // 索引事件流无区块时间戳：DELAY 语义需要 submittedAt/pokedAt 时钟，
    // 喂假时钟只会制造假分叉——该 plan 整体不进喂给面，覆盖面计数为 0。
    const delayPlan = oraclePlan([
      { op: "SIGNAL", sourceId, signalId, signalKey },
      { op: "DELAY", delaySeconds: 5 }
    ]);
    const summary = runSemanticOracleReplay([...baseEvents(), hookReadyEvent(4n)], [delayPlan]);
    expect(summary).toEqual({
      semanticOracleCheckedPlanCount: 0,
      semanticOracleMismatchCount: 0,
      semanticOracleErrorCount: 0,
      // DELAY 排除的 plan 伴随计数（覆盖面分母诚实），不算异常不进 mismatch。
      semanticOracleExcludedPlanCount: 1
    });
  });

  it("checks only plans with a resolved artifact", () => {
    const events = [...baseEvents(), hookReadyEvent(4n)];
    expect(runSemanticOracleReplay(events, [])).toEqual({
      semanticOracleCheckedPlanCount: 0,
      semanticOracleMismatchCount: 0,
      semanticOracleErrorCount: 0,
      semanticOracleExcludedPlanCount: 0
    });
    // 产物指向别的 plan：本流不可校验。
    const otherPlan = { ...oraclePlan(), planId: `0x${"ee".repeat(32)}` as Hex };
    expect(runSemanticOracleReplay(events, [otherPlan]).semanticOracleCheckedPlanCount).toBe(0);
  });

  it("carries the oracle counts through the indexer sync state diagnostics", async () => {
    // 服务接线：resolveSemanticOraclePlan 产物 + 分叉事件流 → sync state
    // 诊断携带 semanticOracleMismatchCount（>0 命中 hasProjectionDiagnostics
    // Anomalies → /healthz operationalDegradedReasons），投影不被覆盖。
    const store = new MemoryProjectionStore();
    const events = [...baseEvents(), hookReadyEvent(4n), hookReadyEvent(5n, "0x0000000000000000000000000000000000000000000000000000000000000313")];
    const eventSource: ChainEventSource = {
      async getFinalizedBlock() {
        return 9n;
      },
      async readEvents() {
        return events;
      }
    };
    const indexer = new IndexerService({
      config: testConfig(),
      eventSource,
      store,
      resolveSemanticOraclePlan: async (anchorPlanId, anchorPlanHash) =>
        anchorPlanId.toLowerCase() === planId && anchorPlanHash.toLowerCase() === planHash
          ? oraclePlan()
          : undefined
    });

    const result = await indexer.rebuildFromDeploymentBlockWithSummary();
    const syncState = await store.getSyncState();

    expect(result.summary.mismatchCount).toBe(0);
    expect(syncState?.projectionDiagnostics).toMatchObject({
      semanticOracleCheckedPlanCount: 1,
      semanticOracleMismatchCount: expect.any(Number)
    });
    expect(syncState?.projectionDiagnostics?.semanticOracleMismatchCount).toBeGreaterThan(0);
    expect(hasProjectionDiagnosticsAnomalies(syncState?.projectionDiagnostics)).toBe(true);
    // 投影以链为真：分叉只报告，链上 HookReady 事件照常投影。
    const orderKey = `31337:${contractAddress}:${planId}:${orderId}`;
    expect(result.snapshot.stateMachineOrders[orderKey]?.hooks["0x0000000000000000000000000000000000000000000000000000000000000313"]?.status).toBe("ready");
  });
});

function hookReadyEvent(blockNumber: bigint, readyHookId: string = hookId): ChainEvent {
  return chainEvent(blockNumber, 0, "HookReady", {
    orderId,
    hookId: readyHookId,
    stageId,
    hookName
  });
}

function chainEvent(
  blockNumber: bigint,
  logIndex: number,
  eventName: string,
  args: Record<string, unknown>
): ChainEvent {
  return {
    chainId: 31337,
    contractAddress,
    blockNumber,
    transactionHash: `0x${blockNumber.toString(16).padStart(64, "0")}` as Hex,
    logIndex,
    eventName,
    args
  };
}

function testConfig(): ChainServicesConfig {
  return {
    network: {
      chainId: 31337,
      rpcUrl: "http://127.0.0.1:8545",
      deploymentBlock: 0n,
      finalityAnchor: "confirmations",
      finalityConfirmations: 2,
      contracts: {}
    },
    database: { driver: "memory", url: "memory://projection-store", migrationsAutoRun: false },
    api: { host: "127.0.0.1", port: 8787, indexerPollIntervalMs: 5000 },
    relayer: {
      businessSigning: "forbidden",
      broadcastEnabled: false,
      stateMachinePrivateKeyEnv: "UVP_STATE_MACHINE_RELAYER_PRIVATE_KEY",
      maxRetries: 3
    },
    governance: {
      broadcastEnabled: false,
      signerPrivateKeyEnv: "GOVERNANCE_SIGNER_PRIVATE_KEY",
      rpcUrl: "http://127.0.0.1:8545",
      chainId: 31337,
      txConfirmations: 1,
      allowedOperators: []
    },
    productBff: {
      registrationAdapter: "memory-trigger",
      registrarPrivateKeyEnv: "UVP_PRODUCT_BFF_REGISTRAR_PRIVATE_KEY",
      waitForReceipt: false
    },
    operatorRoles: {
      deployerPrivateKeyEnv: "UVP_ETH_DEPLOYER_PRIVATE_KEY",
      participantWallets: [],
      adminReviewers: []
    },
    reconcile: { enabled: false, pollIntervalMs: 5000, txTimeoutMs: 30_000 },
    dockAutomation: {
      enabled: false,
      pollIntervalMs: 5000,
      maxCandidatesPerRun: 4,
      maxGasPerTx: 500_000n,
      redeliveryWindowMs: 120_000
    },
    timerKeeper: {
      enabled: false,
      pollIntervalMs: 5000,
      maxCandidatesPerRun: 4,
      maxGasPerTx: 500_000n,
      redeliveryWindowMs: 120_000,
      privateKeyEnv: "UVP_TIMER_KEEPER_PRIVATE_KEY"
    },
    evidenceStorage: { adapter: "local", objectNamespace: "uvp-rehearsal" },
    security: {
      environment: "local",
      preflightStrict: false,
      logRedactionEnabled: true,
      broadcastMaxInFlightPerOrder: 1,
      broadcastMaxRetry: 3,
      broadcastRetryBaseMs: 250,
      broadcastRetryMaxMs: 5000,
      broadcastReceiptTimeoutMs: 0
    }
  };
}
