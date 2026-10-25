// V3 binding: canonical payer-scoped ids, accepted-terms deposit intents,
// foreign-tranche projection, persistent-cursor indexer (resume/reorg/startBlock),
// visibility-trimmed reads, and sqlite parity.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, keccak256, stringToBytes } from "viem";
import {
  BINDING_EVENT_ABI,
  BindingIndexerService,
  MemoryBindingStore,
  SqliteBindingStore,
  applyBindingEvent,
  canonicalStageId,
  canonicalTrancheId,
  createBindingReadService,
  createDepositIntentService,
  decodeBindingLogs,
  type AcceptedStageTerms,
  type AcceptedStageTermsProvider,
  type BindingLogSource,
  type BindingScopeResolver,
  type DepositTypedData,
  type EscrowInstanceRecord,
  type RawBindingLog
} from "../src/binding/index.js";
import { hashCanonicalJson } from "../src/shared/canonical-json.js";
import type { Address, Hex } from "../src/shared/types.js";
import { StorageConstraintError } from "../src/storage/errors.js";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../migrations");
const chainId = 31337;
const escrowAddress = "0x1111111111111111111111111111111111111111" as Address;
const tokenAddress = "0x9999999999999999999999999999999999999999" as Address;
const buyer = "0x2222222222222222222222222222222222222222" as Address;
const attacker = "0x3333333333333333333333333333333333333333" as Address;
const payee = "0x4444444444444444444444444444444444444444" as Address;
const feeRecipient = "0x5555555555555555555555555555555555555555" as Address;
const verifierWallet = "0x8888888888888888888888888888888888888888" as Address;
const orderId = `0x${"aa".repeat(32)}` as Hex;
const stageKey = "sourcing";
const sourceFactId = `0x${"cc".repeat(32)}` as Hex;
const ZERO_HASH = `0x${"00".repeat(32)}` as Hex;
const now = new Date("2026-01-01T00:00:00.000Z");

function instance(): EscrowInstanceRecord {
  return {
    chainId,
    escrowAddress,
    tokenAddress,
    contractVersion: "v3",
    uvpAddress: "0x6666666666666666666666666666666666666666",
    deploymentBlock: "50",
    startBlock: "100",
    status: "active",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString()
  };
}

function stageTerms(overrides: Partial<{ payer: Address; stageKey: string; amount: string; feeBps: number }> = {}): AcceptedStageTerms {
  const resolvedStageKey = overrides.stageKey ?? stageKey;
  const terms = {
    orderId,
    stageKey: resolvedStageKey,
    stageId: canonicalStageId(resolvedStageKey),
    payer: overrides.payer ?? buyer,
    payee,
    verifier: verifierWallet,
    amount: overrides.amount ?? "1000000",
    feeBps: overrides.feeBps ?? 100,
    feeRecipient,
    stageTerms: { orderId, stageKey: resolvedStageKey, amount: overrides.amount ?? "1000000" }
  } as const;
  return {
    ...terms,
    termsHash: hashCanonicalJson(terms.stageTerms, "termsHash")
  };
}

class FixedTermsProvider implements AcceptedStageTermsProvider {
  constructor(private readonly terms: AcceptedStageTerms | undefined) {}
  async getAcceptedStageTerms(): Promise<AcceptedStageTerms | undefined> {
    return this.terms;
  }
}

function depositLog(input: {
  readonly payer: Address;
  readonly amount: bigint;
  readonly nonce: bigint;
  readonly blockNumber: bigint;
  readonly logIndex: number;
  readonly stageId?: Hex;
}): RawBindingLog {
  const stageId = input.stageId ?? canonicalStageId(stageKey);
  const trancheId = canonicalTrancheId(orderId, stageId, input.payer);
  const topics = encodeEventTopics({
    abi: BINDING_EVENT_ABI,
    eventName: "Deposited",
    args: { trancheId, orderId, stageId }
  });
  const data = encodeAbiParameters(
    [
      { type: "address" },
      { type: "address" },
      { type: "address" },
      { type: "uint256" },
      { type: "uint16" },
      { type: "address" },
      { type: "uint64" },
      { type: "uint256" },
      { type: "bytes32" }
    ],
    [input.payer, payee, verifierWallet, input.amount, 100, feeRecipient, 1_800_000_000n, input.nonce, ZERO_HASH]
  );
  return {
    address: escrowAddress,
    blockNumber: input.blockNumber,
    logIndex: input.logIndex,
    transactionHash: `0x${input.blockNumber.toString(16).padStart(64, "0")}` as Hex,
    data,
    topics: topics as readonly Hex[]
  };
}

function settledLog(input: {
  readonly payer: Address;
  readonly payerAmount: bigint;
  readonly payeeAmount: bigint;
  readonly fee: bigint;
  readonly instructionRef: Hex;
  readonly blockNumber: bigint;
  readonly logIndex: number;
}): RawBindingLog {
  const stageId = canonicalStageId(stageKey);
  const trancheId = canonicalTrancheId(orderId, stageId, input.payer);
  const topics = encodeEventTopics({
    abi: BINDING_EVENT_ABI,
    eventName: "Settled",
    args: { trancheId, orderId, stageId }
  });
  const data = encodeAbiParameters(
    [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes32" }],
    [input.payerAmount, input.payeeAmount, input.fee, input.instructionRef]
  );
  return {
    address: escrowAddress,
    blockNumber: input.blockNumber,
    logIndex: input.logIndex,
    transactionHash: `0x${(input.blockNumber + 1_000n).toString(16).padStart(64, "0")}` as Hex,
    data,
    topics: topics as readonly Hex[]
  };
}

class FakeLogSource implements BindingLogSource {
  latest = 100n;
  readonly logs: RawBindingLog[] = [];
  readonly blocks = new Map<bigint, { hash: Hex; timestamp: bigint }>();
  readonly calls: { fromBlock: bigint; toBlock: bigint }[] = [];

  constructor(seed = 1) {
    this.setBlocks(1n, 120n, seed);
  }

  setBlocks(from: bigint, to: bigint, seed: number): void {
    for (let block = from; block <= to; block += 1n) {
      this.blocks.set(block, {
        hash: `0x${(seed * 1000 + Number(block)).toString(16).padStart(64, "0")}` as Hex,
        timestamp: 1_760_000_000n + block
      });
    }
  }

  async getBlockNumber(): Promise<bigint> {
    return this.latest;
  }

  async getLogs(input: { readonly fromBlock: bigint; readonly toBlock: bigint }): Promise<readonly RawBindingLog[]> {
    this.calls.push(input);
    return this.logs.filter(
      (log) => log.blockNumber !== null && log.blockNumber >= input.fromBlock && log.blockNumber <= input.toBlock
    );
  }

  async getBlock(input: { readonly blockNumber: bigint }): Promise<{ hash: Hex | null; timestamp: bigint }> {
    return this.blocks.get(input.blockNumber) ?? { hash: null, timestamp: 0n };
  }
}

async function seededStore(): Promise<{ store: MemoryBindingStore; provider: FixedTermsProvider }> {
  const store = new MemoryBindingStore();
  await store.saveEscrowInstance(instance());
  const provider = new FixedTermsProvider(stageTerms());
  const deposits = createDepositIntentService({
    store,
    termsProvider: provider,
    chainId,
    escrowAddress,
    now: () => now,
    nonceFactory: () => "7",
    idFactory: () => `intent_${Math.random().toString(16).slice(2)}`
  });
  const created = await deposits.createIntent({
    orderId,
    stageKey,
    walletAddress: buyer
  });
  expect(created.replayed).toBe(false);
  return { store, provider };
}

describe("binding canonical identity", () => {
  it("derives stageId from stageKey and trancheId from (orderId, stageId, payer)", () => {
    expect(canonicalStageId("sourcing")).toBe(keccak256(stringToBytes("sourcing")));
    const buyerTranche = canonicalTrancheId(orderId, canonicalStageId("sourcing"), buyer);
    const attackerTranche = canonicalTrancheId(orderId, canonicalStageId("sourcing"), attacker);
    expect(buyerTranche).not.toBe(attackerTranche);
    expect(buyerTranche).toBe(
      keccak256(
        encodeAbiParameters(
          [{ type: "bytes32" }, { type: "bytes32" }, { type: "address" }],
          [orderId, canonicalStageId("sourcing"), buyer]
        )
      )
    );
  });
});

describe("event decoding", () => {
  it("decodes Deposited with the contract's verifier field", () => {
    const [event] = decodeLogs([
      depositLog({ payer: buyer, amount: 1_000_000n, nonce: 7n, blockNumber: 101n, logIndex: 3 })
    ]);
    expect(event?.eventName).toBe("Deposited");
    if (event?.eventName !== "Deposited") {
      throw new Error("expected a Deposited event");
    }
    expect(event.trancheId).toBe(canonicalTrancheId(orderId, canonicalStageId(stageKey), buyer));
    expect(event.args).toMatchObject({
      payer: buyer,
      payee,
      verifier: verifierWallet,
      amount: 1_000_000n,
      feeBps: 100,
      feeRecipient,
      nonce: 7n
    });
  });
});

describe("deposit intents", () => {
  it("builds the exact StageEscrowV3 deposit typed data from accepted terms", async () => {
    const store = new MemoryBindingStore();
    await store.saveEscrowInstance(instance());
    const deposits = createDepositIntentService({
      store,
      termsProvider: new FixedTermsProvider(stageTerms()),
      chainId,
      escrowAddress,
      now: () => now,
      nonceFactory: () => "42"
    });
    const result = await deposits.createIntent({ orderId, stageKey, walletAddress: buyer });
    const typedData: DepositTypedData = result.typedData;
    expect(result.intent.trancheId).toBe(canonicalTrancheId(orderId, canonicalStageId(stageKey), buyer));
    expect(typedData.domain).toMatchObject({
      name: "UVPStageEscrow",
      version: "3",
      chainId,
      verifyingContract: escrowAddress
    });
    expect(typedData.primaryType).toBe("DepositTerms");
    expect(typedData.message).toMatchObject({
      orderId,
      stageId: canonicalStageId(stageKey),
      payer: buyer,
      payee,
      verifier: verifierWallet,
      amount: "1000000",
      feeBps: 100,
      feeRecipient,
      nonce: "42"
    });
    expect(typedData.message.deadline).toBe(String(Math.floor(now.getTime() / 1000) + 900));
  });


  it("rejects a non-payer wallet and missing accepted terms", async () => {
    const store = new MemoryBindingStore();
    await store.saveEscrowInstance(instance());
    const deposits = createDepositIntentService({
      store,
      termsProvider: new FixedTermsProvider(stageTerms()),
      chainId,
      escrowAddress,
      now: () => now
    });
    await expect(deposits.createIntent({ orderId, stageKey, walletAddress: attacker })).rejects.toMatchObject({
      status: 403,
      code: "deposit_not_payer"
    });
    const noTerms = createDepositIntentService({
      store,
      termsProvider: new FixedTermsProvider(undefined),
      chainId,
      escrowAddress,
      now: () => now
    });
    await expect(noTerms.createIntent({ orderId, stageKey, walletAddress: buyer })).rejects.toMatchObject({
      status: 404,
      code: "accepted_terms_not_found"
    });
  });

  it("replays an equal intent and rejects a stored intent whose hash does not match stageTerms", async () => {
    const store = new MemoryBindingStore();
    await store.saveEscrowInstance(instance());
    const deposits = createDepositIntentService({
      store,
      termsProvider: new FixedTermsProvider(stageTerms()),
      chainId,
      escrowAddress,
      now: () => now,
      nonceFactory: () => "7"
    });
    const first = await deposits.createIntent({ orderId, stageKey, walletAddress: buyer, idempotencyKey: "k1" });
    const replay = await deposits.createIntent({ orderId, stageKey, walletAddress: buyer, idempotencyKey: "k1" });
    expect(replay.replayed).toBe(true);
    expect(replay.intent.intentId).toBe(first.intent.intentId);
    await expect(
      deposits.createIntent({ orderId, stageKey, walletAddress: buyer, idempotencyKey: "k2" })
    ).resolves.toMatchObject({ replayed: true });

    const tampered = stageTerms();
    const mismatchedProvider = new FixedTermsProvider({ ...tampered, termsHash: `0x${"ee".repeat(32)}` as Hex });
    const strictStore = new MemoryBindingStore();
    await strictStore.saveEscrowInstance(instance());
    const strict = createDepositIntentService({
      store: strictStore,
      termsProvider: mismatchedProvider,
      chainId,
      escrowAddress,
      now: () => now
    });
    await expect(strict.createIntent({ orderId, stageKey, walletAddress: buyer })).rejects.toMatchObject({
      status: 409,
      code: "accepted_terms_hash_mismatch"
    });
  });
});

describe("deposit projection and foreign tranches", () => {
  it("binds the accepted payer deposit and records another payer's deposit as foreign", async () => {
    const { store } = await seededStore();
    const stageId = canonicalStageId(stageKey);
    const buyerDeposit = depositLog({ payer: buyer, amount: 1_000_000n, nonce: 7n, blockNumber: 101n, logIndex: 0 });
    const foreignDeposit = depositLog({ payer: attacker, amount: 1n, nonce: 1n, blockNumber: 102n, logIndex: 0 });
    const decoded = decodeLogs([buyerDeposit, foreignDeposit]);
    expect(decoded).toHaveLength(2);
    const buyerResult = await applyBindingEvent(decoded[0]!, { store, minimumBlock: "100" });
    expect(buyerResult.applied).toBe(true);
    const foreignResult = await applyBindingEvent(decoded[1]!, { store, minimumBlock: "100" });
    expect(foreignResult.applied).toBe(true);

    const canonical = await store.findCanonicalBindingByStage(chainId, escrowAddress, orderId, stageId);
    expect(canonical?.state).toBe("bound");
    expect(canonical?.payer).toBe(buyer);
    const foreign = await store.getTrancheBinding(chainId, escrowAddress, foreignDepositTrancheId());
    expect(foreign?.state).toBe("foreign");
    expect(foreign?.payer).toBe(attacker);
    const anomalies = await store.listAnomalies(chainId, escrowAddress);
    expect(anomalies.map((anomaly) => anomaly.reason)).toContain("foreign_tranche");
  });

  it("flips to mismatch when the accepted payer deposits with non-matching terms", async () => {
    const { store } = await seededStore();
    const wrongAmount = depositLog({ payer: buyer, amount: 999_999n, nonce: 7n, blockNumber: 101n, logIndex: 0 });
    const [event] = decodeLogs([wrongAmount]);
    await applyBindingEvent(event!, { store, minimumBlock: "100" });
    const canonical = await store.findCanonicalBindingByStage(chainId, escrowAddress, orderId, canonicalStageId(stageKey));
    expect(canonical?.state).toBe("mismatch");
    expect((await store.listAnomalies(chainId, escrowAddress)).map((a) => a.reason)).toContain("deposit_terms_mismatch");
    expect(await store.findDepositIntentByStage(chainId, escrowAddress, orderId, canonicalStageId(stageKey), ["cancelled"]))
      .toBeDefined();
  });

  it("ignores a settlement event for a foreign tranche instead of settling it", async () => {
    const { store } = await seededStore();
    const [foreignEvent] = decodeLogs([
      depositLog({ payer: attacker, amount: 1n, nonce: 1n, blockNumber: 101n, logIndex: 0 })
    ]);
    await applyBindingEvent(foreignEvent!, { store, minimumBlock: "100" });
    const [settled] = decodeLogs([
      settledLog({
        payer: attacker,
        payerAmount: 0n,
        payeeAmount: 1n,
        fee: 0n,
        instructionRef: `0x${"dd".repeat(32)}` as Hex,
        blockNumber: 103n,
        logIndex: 0
      })
    ]);
    await applyBindingEvent(settled!, { store, minimumBlock: "100" });
    const foreign = await store.getTrancheBinding(chainId, escrowAddress, foreignDepositTrancheId());
    expect(foreign?.state).toBe("foreign");
    expect((await store.listAnomalies(chainId, escrowAddress)).map((a) => a.reason)).toContain("foreign_tranche");
  });
});

describe("binding indexer", () => {
  it("persists a cursor, resumes instead of rescanning, and rebuilds on reorg", async () => {
    const { store } = await seededStore();
    const source = new FakeLogSource();
    source.logs.push(depositLog({ payer: buyer, amount: 1_000_000n, nonce: 7n, blockNumber: 101n, logIndex: 0 }));
    source.latest = 101n;
    const indexer = new BindingIndexerService({
      chainId,
      escrowAddress,
      startBlock: 100n,
      deploymentBlock: 50n,
      store,
      source,
      now: () => now
    });
    const first = await indexer.refresh();
    expect(first.eventCount).toBe(1);
    expect(source.calls.length).toBe(1);
    expect((await store.getCursor(chainId, escrowAddress))?.nextBlock).toBe("102");

    source.latest = 104n;
    const second = await indexer.refresh();
    expect(second.rebuilt).toBe(false);
    expect(source.calls.at(-1)).toMatchObject({ fromBlock: 102n, toBlock: 104n });

    source.setBlocks(1n, 120n, 9);
    const third = await indexer.refresh();
    expect(third.rebuilt).toBe(true);
    expect(source.calls.at(-1)).toMatchObject({ fromBlock: 100n, toBlock: 104n });
    const canonical = await store.findCanonicalBindingByStage(
      chainId,
      escrowAddress,
      orderId,
      canonicalStageId(stageKey)
    );
    expect(canonical?.state).toBe("bound");
  });

  it("records events before the configured startBlock instead of dropping them silently", async () => {
    const { store } = await seededStore();
    const [early] = decodeLogs([
      depositLog({ payer: buyer, amount: 1_000_000n, nonce: 7n, blockNumber: 99n, logIndex: 0 })
    ]);
    await applyBindingEvent(early!, { store, minimumBlock: "100" });
    const anomalies = await store.listAnomalies(chainId, escrowAddress);
    expect(anomalies.some((anomaly) => anomaly.reason === "event_before_start_block")).toBe(true);
    expect(anomalies.some((anomaly) => anomaly.reason === "start_block_after_deployment")).toBe(false);

    const source = new FakeLogSource();
    const indexer = new BindingIndexerService({
      chainId,
      escrowAddress,
      startBlock: 100n,
      deploymentBlock: 50n,
      store,
      source,
      now: () => now
    });
    await indexer.rebuild();
    expect((await store.listAnomalies(chainId, escrowAddress)).some(
      (anomaly) => anomaly.reason === "start_block_after_deployment"
    )).toBe(true);
  });
});

describe("binding read visibility", () => {
  function scopeResolver(scopes: Record<string, { kind: "buyer" | "stage" | "operator" | "stranger"; stages: string[] }>): BindingScopeResolver {
    return {
      async resolveBindingScope(_orderId, wallet) {
        const normalized = String(wallet).toLowerCase();
        const scope = scopes[normalized];
        if (!scope) return { kind: "stranger", stages: new Set<string>() };
        return { kind: scope.kind, stages: new Set(scope.stages) };
      }
    };
  }

  it("returns buyer full view, stage-scoped own stage, operator minimal view, and 404 for strangers", async () => {
    const store = new MemoryBindingStore();
    await store.saveEscrowInstance(instance());
    const stageId = canonicalStageId(stageKey);
    await store.saveTrancheBinding({
      bindingId: "b1",
      chainId,
      escrowAddress,
      orderId,
      stageKey,
      stageId,
      trancheId: canonicalTrancheId(orderId, stageId, buyer),
      payer: buyer,
      payee,
      amount: "1000000",
      feeBps: 100,
      feeRecipient,
      state: "bound",
      origin: "intent",
      termsHash: `0x${"11".repeat(32)}` as Hex,
      depositTxHash: `0x${"22".repeat(32)}` as Hex,
      depositBlock: "101",
      depositLogIndex: 0,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString()
    });
    await store.saveCursor({
      chainId,
      escrowAddress,
      startBlock: "100",
      nextBlock: "102",
      lastBlock: "101",
      lastBlockHash: `0x${"33".repeat(32)}` as Hex,
      updatedAt: now.toISOString()
    });
    const resolver = scopeResolver({
      [buyer]: { kind: "buyer", stages: [] },
      [payee]: { kind: "stage", stages: [stageKey] },
      [feeRecipient]: { kind: "operator", stages: [] }
    });
    const reads = createBindingReadService({ store, scopeResolver: resolver });
    const buyerView = await reads.listOrderBindings(orderId, buyer);
    expect(buyerView.dataState).toBe("ok");
    expect(buyerView.bindings[0]?.payer).toBe(buyer);
    expect(buyerView.foreignTrancheCount).toBe(0);

    const stageView = await reads.listOrderBindings(orderId, payee);
    expect(stageView.bindings).toHaveLength(1);
    expect(stageView.bindings[0]?.amount).toBe("1000000");

    const operatorView = await reads.listOrderBindings(orderId, feeRecipient);
    expect(operatorView.bindings).toHaveLength(1);
    expect("payer" in operatorView.bindings[0]!).toBe(false);
    expect("amount" in operatorView.bindings[0]!).toBe(false);

    await expect(reads.listOrderBindings(orderId, attacker)).rejects.toMatchObject({
      status: 404,
      code: "order_not_found"
    });
  });

  it("returns pending while no cursor exists and 403 for another stage", async () => {
    const store = new MemoryBindingStore();
    await store.saveEscrowInstance(instance());
    const resolver = scopeResolver({
      [buyer]: { kind: "buyer", stages: [] },
      [payee]: { kind: "stage", stages: ["other"] }
    });
    const reads = createBindingReadService({ store, scopeResolver: resolver });
    expect((await reads.listOrderBindings(orderId, buyer)).dataState).toBe("pending");
    await expect(reads.getStageBinding(orderId, stageKey, payee)).rejects.toMatchObject({
      status: 403,
      code: "stage_scope_forbidden"
    });
  });
});

describe("sqlite binding store parity", () => {
  it("persists instance/intents/bindings, enforces payer-scoped uniqueness and reopens intents on reset", async () => {
    const dir = mkdtempSync(join(tmpdir(), "uvp-binding-"));
    const store = new SqliteBindingStore({
      databaseUrl: `sqlite://${join(dir, "binding.sqlite3")}`,
      migrations: { autoRun: true, directory: MIGRATIONS_DIR }
    });
    try {
      await store.saveEscrowInstance(instance());
      expect(await store.getEscrowInstance(chainId, escrowAddress)).toMatchObject({ chainId, startBlock: "100" });
      const deposits = createDepositIntentService({
        store,
        termsProvider: new FixedTermsProvider(stageTerms()),
        chainId,
        escrowAddress,
        now: () => now,
        nonceFactory: () => "7"
      });
      const created = await deposits.createIntent({ orderId, stageKey, walletAddress: buyer });
      expect(await store.getDepositIntent(created.intent.intentId)).toMatchObject({ status: "active" });

      const stageId = canonicalStageId(stageKey);
      const baseBinding = {
        chainId,
        escrowAddress,
        orderId,
        stageKey,
        stageId,
        payer: buyer,
        payee,
        amount: "1000000",
        feeBps: 100,
        feeRecipient,
        state: "bound" as const,
        origin: "intent" as const,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString()
      };
      await store.saveTrancheBinding({
        ...baseBinding,
        bindingId: "b1",
        trancheId: canonicalTrancheId(orderId, stageId, buyer)
      });
      await store.saveTrancheBinding({
        ...baseBinding,
        bindingId: "b2",
        payer: attacker,
        state: "foreign",
        trancheId: canonicalTrancheId(orderId, stageId, attacker)
      });
      expect((await store.listTrancheBindingsByOrder(orderId)).map((binding) => binding.state).sort())
        .toEqual(["bound", "foreign"]);
      await expect(
        store.saveTrancheBinding({
          ...baseBinding,
          bindingId: "b3",
          trancheId: canonicalTrancheId(orderId, stageId, buyer)
        })
      ).rejects.toBeInstanceOf(StorageConstraintError);

      await store.resetProjection(chainId, escrowAddress);
      expect(await store.listTrancheBindingsByOrder(orderId)).toEqual([]);
      expect((await store.getDepositIntent(created.intent.intentId))?.status).toBe("active");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function decodeLogs(logs: readonly RawBindingLog[]) {
  return decodeBindingLogs({
    chainId,
    escrowAddress,
    logs,
    blockTimestampOf: (blockNumber) => 1_760_000_000n + blockNumber
  }).events;
}

function foreignDepositTrancheId(): Hex {
  return canonicalTrancheId(orderId, canonicalStageId(stageKey), attacker);
}
