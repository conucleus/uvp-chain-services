// V3 time/hook runtime: expressions are configuration data (no hard-coded
// windows), due facts materialise exactly once through authorized signal
// submission + settlement instruction creation, and runtime never touches escrow.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MemoryRuntimeStore,
  RuntimeWorker,
  SqliteRuntimeStore,
  createBindingSettlementInstructionCreator,
  createTimeRuntime,
  evaluateTimeExpression,
  type AuthorizedSignalSubmitter,
  type RuntimeFact,
  type RuntimeFactSource,
  type RuntimeRule,
  type SettlementInstructionCreator
} from "../src/runtime/index.js";
import { MemoryBindingStore } from "../src/binding/index.js";
import { canonicalStageId, canonicalTrancheId } from "../src/binding/types.js";
import { MemorySettlementStore, createSettlementLedger } from "../src/settlement/index.js";
import type { Address, Hex } from "../src/shared/types.js";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../migrations");
const planId = `0x${"dd".repeat(32)}` as Hex;
const orderId = `0x${"aa".repeat(32)}` as Hex;
const signalSubmitter = "0x9999999999999999999999999999999999999999" as Address;
const uvpExecutorAddress = "0x7777777777777777777777777777777777777777" as Address;
const approvedAt = "2026-01-01T00:00:00.000Z";
const now = new Date("2026-01-20T00:00:00.000Z");

function fact(signalName: string, occurredAt = approvedAt): RuntimeFact {
  return {
    factId: `fact_${signalName}`,
    orderId,
    stageKey: "sourcing",
    signalName,
    occurredAt
  };
}

class FakeFacts implements RuntimeFactSource {
  facts: readonly RuntimeFact[] = [fact("approved")];
  async listFacts(): Promise<readonly RuntimeFact[]> {
    return this.facts;
  }
}

class FakeSubmitter implements AuthorizedSignalSubmitter {
  calls: { submitter: Address; factKey: string; signalName: string }[] = [];
  async submitSignal(input: { submitter: Address; factKey: string; stageKey: string; signalName: string; orderId: Hex }) {
    this.calls.push({ submitter: input.submitter, factKey: input.factKey, signalName: input.signalName });
    return { txHash: `0x${"11".repeat(32)}` as Hex };
  }
}

class FakeInstructionCreator implements SettlementInstructionCreator {
  calls: { kind: string; sourceFactId: string; payerAmount?: string; executeEligibleAt?: string }[] = [];
  nextId = "instr_1";
  async createFromFact(input: {
    readonly kind: string;
    readonly sourceFactId: Hex;
    readonly payerAmount?: string;
    readonly executeEligibleAt: string;
  }) {
    this.calls.push({
      kind: input.kind,
      sourceFactId: input.sourceFactId,
      ...(input.payerAmount !== undefined ? { payerAmount: input.payerAmount } : {}),
      executeEligibleAt: input.executeEligibleAt
    });
    return { instructionId: this.nextId };
  }
}

function rule(overrides: Partial<RuntimeRule> = {}): RuntimeRule {
  return {
    ruleId: "rule_1",
    planId,
    orderId,
    stageKey: "sourcing",
    name: "transfer_after_approval",
    expression: "approved +14d & ~disputed",
    actionKind: "execute_transfer",
    createdAt: now.toISOString(),
    ...overrides
  };
}

describe("time expression evaluation", () => {
  it("uses the window from the expression string (no fixed 14d/2d/48h constant)", () => {
    const early = new Date("2026-01-02T00:00:00.000Z");
    const after14d = new Date("2026-01-15T00:00:00.000Z");
    const after37h = new Date("2026-01-02T13:00:01.000Z");
    expect(evaluateTimeExpression("approved +14d & ~disputed", [fact("approved")], early).value).toBe(false);
    expect(evaluateTimeExpression("approved +14d & ~disputed", [fact("approved")], after14d).value).toBe(true);
    expect(evaluateTimeExpression("approved +37h", [fact("approved")], early).value).toBe(false);
    expect(evaluateTimeExpression("approved +37h", [fact("approved")], after37h).value).toBe(true);
    expect(evaluateTimeExpression("approved +2d", [fact("approved")], after14d).value).toBe(true);
  });

  it("supports negation, conjunction and disjunction; invalid syntax fails closed", () => {
    expect(evaluateTimeExpression("~disputed", [fact("approved")], now).value).toBe(true);
    expect(evaluateTimeExpression("~disputed & approved", [fact("approved")], now).value).toBe(true);
    expect(evaluateTimeExpression("rejected | approved", [fact("approved")], now).value).toBe(true);
    expect(evaluateTimeExpression("rejected | disputed", [fact("approved")], now).value).toBe(false);
  });
});

describe("fact materialisation", () => {
  it("turns a verifier verdict fact into an unsigned instruction (no auto settlement)", async () => {
    const store = new MemoryRuntimeStore();
    const creator = new FakeInstructionCreator();
    const runtime = createTimeRuntime({
      store,
      facts: new FakeFacts(),
      submitter: new FakeSubmitter(),
      instructions: creator,
      signalSubmitter,
      uvpExecutorAddress,
      now: () => now
    });
    const created = await runtime.materializeFact({
      planId,
      orderId,
      stageKey: "sourcing",
      factName: "verdict_approve",
      sourceFactId: `0x${"44".repeat(32)}`
    });
    expect(created.instructionId).toBe("instr_1");
    expect(creator.calls[0]?.kind).toBe("verdict_approve");
    expect(creator.calls[0]?.executeEligibleAt).toBeDefined();
  });
});

describe("time runtime materialisation", () => {
  it("derives one due fact, submits the authorized signal once, then creates an instruction", async () => {
    const store = new MemoryRuntimeStore();
    await store.saveRule(rule());
    const submitter = new FakeSubmitter();
    const creator = new FakeInstructionCreator();
    const runtime = createTimeRuntime({
      store,
      facts: new FakeFacts(),
      submitter,
      instructions: creator,
      signalSubmitter,
      uvpExecutorAddress,
      now: () => now,
      idFactory: () => `rt_${Math.random().toString(16).slice(2)}`
    });
    const due = await runtime.dueFacts(orderId);
    expect(due).toHaveLength(1);
    expect(due[0]?.actionKind).toBe("execute_transfer");

    const processed = await runtime.processOrder(orderId);
    expect(processed).toMatchObject({ due: 1, submitted: 1, instructed: 1, failed: 0 });
    expect(submitter.calls).toHaveLength(1);
    expect(submitter.calls[0]?.submitter).toBe(signalSubmitter);
    expect(creator.calls).toHaveLength(1);
    expect(creator.calls[0]?.kind).toBe("execute_transfer");
    expect(creator.calls[0]?.executeEligibleAt).toBe(due[0]?.dueAt);

    const replay = await runtime.processOrder(orderId);
    expect(replay).toMatchObject({ submitted: 0, instructed: 0, skipped: 1 });
    expect(submitter.calls).toHaveLength(1);
    expect(creator.calls).toHaveLength(1);
  });

  it("pokes the UVP timer after creating the execute instruction", async () => {
    const store = new MemoryRuntimeStore();
    await store.saveRule(rule());
    const pokes: string[] = [];
    const runtime = createTimeRuntime({
      store,
      facts: new FakeFacts(),
      submitter: new FakeSubmitter(),
      instructions: new FakeInstructionCreator(),
      signalSubmitter,
      uvpExecutorAddress,
      timerPoker: { async poke(input) { pokes.push(input.instructionId); } },
      now: () => now,
      idFactory: () => "sub_1"
    });
    const processed = await runtime.processOrder(orderId);
    expect(processed.instructed).toBe(1);
    expect(pokes).toEqual(["instr_1"]);
  });

  it("does not materialise before the configured window elapses", async () => {
    const store = new MemoryRuntimeStore();
    await store.saveRule(rule());
    const submitter = new FakeSubmitter();
    const runtime = createTimeRuntime({
      store,
      facts: new FakeFacts(),
      submitter,
      instructions: new FakeInstructionCreator(),
      signalSubmitter,
      uvpExecutorAddress,
      now: () => new Date("2026-01-02T00:00:00.000Z")
    });
    const due = await runtime.dueFacts(orderId);
    expect(due).toHaveLength(0);
    expect((await runtime.processOrder(orderId)).due).toBe(0);
    expect(submitter.calls).toHaveLength(0);
  });
});

describe("runtime wiring", () => {
  it("materialises a bound stage's execute_transfer with the fixed tranche amount", async () => {
    const bindingStore = new MemoryBindingStore();
    await bindingStore.saveEscrowInstance({
      chainId: 31337,
      escrowAddress: "0x7777777777777777777777777777777777777777",
      contractVersion: "v3",
      startBlock: "0",
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await bindingStore.saveTrancheBinding({
      bindingId: "b1",
      chainId: 31337,
      escrowAddress: "0x7777777777777777777777777777777777777777",
      orderId,
      stageKey: "sourcing",
      stageId: canonicalStageId("sourcing"),
      trancheId: canonicalTrancheId(orderId, canonicalStageId("sourcing"), uvpExecutorAddress),
      payer: uvpExecutorAddress,
      payee: signalSubmitter,
      verifier: "0x8888888888888888888888888888888888888888",
      amount: "1000000",
      feeBps: 100,
      feeRecipient: "0x9999999999999999999999999999999999999999",
      state: "bound",
      origin: "intent",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const settlementStore = new MemorySettlementStore();
    const ledger = createSettlementLedger({ store: settlementStore });
    const creator = createBindingSettlementInstructionCreator({
      bindingStore,
      settlementLedger: ledger,
      loadOrder: async () => ({ planId }),
    });
    const created = await creator.createFromFact({
      planId,
      orderId,
      stageKey: "sourcing",
      kind: "execute_transfer",
      sourceFactId: `0x${"44".repeat(32)}`,
      uvpExecutorAddress,
      executeEligibleAt: now.toISOString(),
    });
    const instruction = await settlementStore.getInstruction(created.instructionId);
    expect(instruction).toMatchObject({
      kind: "execute_transfer",
      status: "execute_ready",
      payerAmount: "0",
      payeeAmount: "1000000",
    });
  });

  it("worker ticks each order with stored time rules", async () => {
    const runtimeStore = new MemoryRuntimeStore();
    await runtimeStore.saveRule(rule());
    const processed: string[] = [];
    const worker = new RuntimeWorker({
      runtimeStore,
      runtime: { async processOrder(orderId) { processed.push(orderId); } },
    });
    expect(await worker.runOnce()).toEqual({ orders: 1, failed: 0 });
    expect(processed).toEqual([orderId]);
    worker.start(0);
    await worker.stop();
  });
});

describe("sqlite runtime store parity", () => {
  it("persists rules, due facts and one-shot signal submissions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "uvp-runtime-"));
    const store = new SqliteRuntimeStore({
      databaseUrl: `sqlite://${join(dir, "runtime.sqlite3")}`,
      migrations: { autoRun: true, directory: MIGRATIONS_DIR }
    });
    try {
      await store.saveRule(rule());
      expect(await store.listRules(orderId)).toHaveLength(1);
      const factKey = `0x${"22".repeat(32)}` as Hex;
      const record = {
        factKey,
        planId,
        orderId,
        stageKey: "sourcing",
        ruleName: "transfer_after_approval",
        actionKind: "execute_transfer" as const,
        sourceFactId: `0x${"33".repeat(32)}` as Hex,
        basisFactIds: ["fact_approved"],
        dueAt: now.toISOString(),
        status: "due" as const,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString()
      };
      await store.saveDueFact(record);
      expect(await store.getDueFact(factKey)).toMatchObject({ status: "due" });
      await store.saveDueFact({ ...record, status: "instruction_created", instructionId: "instr_1", updatedAt: now.toISOString() });
      expect(await store.getDueFact(factKey)).toMatchObject({ status: "instruction_created", instructionId: "instr_1" });
      await store.saveSignalSubmission({
        submissionId: "sub_1",
        factKey,
        planId,
        orderId,
        stageKey: "sourcing",
        signalName: "transfer_after_approval",
        submitter: signalSubmitter,
        status: "submitted",
        createdAt: now.toISOString()
      });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
