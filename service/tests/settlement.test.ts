// V3 settlement ledger: signature-driven custody instructions. Covers verdict
// signer checks, A+B co-signing, pluggable execute trigger (UVP fact source vs
// UVP contract caller), amount immutability, dispute blocking, idempotency,
// unknown-no-retry, foreign-tranche rejection and sqlite persistence.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { encodeAbiParameters, keccak256 } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { canonicalStageId, canonicalTrancheId } from "../src/binding/types.js";
import {
  MemorySettlementStore,
  SqliteSettlementStore,
  createSettlementFactSourceTrigger,
  createSettlementLedger,
  createSettlementRelayer,
  settlementInstructionRef,
  type BoundTrancheReader,
  type SettlementChainAdapter,
  type SettlementInstructionRecord,
  type SettlementInstructionView,
  type SettlementReceiptResult,
  type SettlementStore,
  type SettlementSubmissionResult
} from "../src/settlement/index.js";
import type { Address, Hex } from "../src/shared/types.js";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../migrations");
const chainId = 31337;
const escrowAddress = "0x1111111111111111111111111111111111111111" as Address;
const planId = `0x${"dd".repeat(32)}` as Hex;
const orderId = `0x${"aa".repeat(32)}` as Hex;
const stageKey = "sourcing";
const stageId = canonicalStageId(stageKey);
const sourceFactId = `0x${"bb".repeat(32)}` as Hex;
const now = new Date("2026-01-10T00:00:00.000Z");
const AMOUNT = "1000000";

const payerAccount = privateKeyToAccount(generatePrivateKey());
const payeeAccount = privateKeyToAccount(generatePrivateKey());
const verifierAccount = privateKeyToAccount(generatePrivateKey());
const outsider = privateKeyToAccount(generatePrivateKey());
const trancheId = canonicalTrancheId(orderId, stageId, payerAccount.address);

function bindingReader(overrides: Partial<{
  state: "bound" | "settled" | "mismatch" | "foreign";
  verifier: Address;
  amount: string;
}> = {}): BoundTrancheReader {
  return {
    async getBoundTranche() {
      return {
        state: overrides.state ?? "bound",
        amount: overrides.amount ?? AMOUNT,
        orderId,
        stageId,
        payer: payerAccount.address.toLowerCase() as Address,
        payee: payeeAccount.address.toLowerCase() as Address,
        verifier: (overrides.verifier ?? verifierAccount.address).toLowerCase() as Address
      };
    }
  };
}

class FakeAdapter implements SettlementChainAdapter {
  submitted: SettlementInstructionRecord[] = [];
  receiptCalls = 0;
  submitResult: SettlementSubmissionResult = { kind: "submitted", txHash: `0x${"cc".repeat(32)}` };
  receiptResult: SettlementReceiptResult = { kind: "pending" };

  async submitInstruction(input: { readonly instruction: SettlementInstructionRecord }): Promise<SettlementSubmissionResult> {
    this.submitted.push(input.instruction);
    return this.submitResult;
  }

  async getSettlementReceipt(): Promise<SettlementReceiptResult> {
    this.receiptCalls += 1;
    return this.receiptResult;
  }
}

function ledgerWith(options: { store?: SettlementStore; tranches?: BoundTrancheReader } = {}) {
  const store = options.store ?? new MemorySettlementStore();
  const ledger = createSettlementLedger({
    store,
    tranches: options.tranches ?? bindingReader(),
    now: () => now,
    nonceFactory: () => "7",
    defaultDeadlineSeconds: 3_600,
    idFactory: () => `instr_${Math.random().toString(16).slice(2)}`
  });
  return { store, ledger };
}

function toSignable(typedData: SettlementInstructionView["typedData"]) {
  return {
    domain: typedData.domain,
    types: typedData.types,
    primaryType: typedData.primaryType,
    message: typedData.message
  } as never;
}

async function sign(
  ledger: ReturnType<typeof ledgerWith>["ledger"],
  instruction: SettlementInstructionView,
  account: ReturnType<typeof privateKeyToAccount>
): Promise<SettlementInstructionView> {
  const signature = await account.signTypedData(toSignable(instruction.typedData));
  return (await ledger.addSignature({
    instructionId: instruction.instructionId,
    signer: account.address,
    signature
  })).instruction;
}

async function createVerdict(
  ledger: ReturnType<typeof ledgerWith>["ledger"],
  kind: "verdict_approve" | "verdict_reject"
): Promise<SettlementInstructionView> {
  const amounts = kind === "verdict_approve"
    ? { payerAmount: "0", payeeAmount: AMOUNT }
    : { payerAmount: AMOUNT, payeeAmount: "0" };
  return (await ledger.createInstruction({
    chainId,
    escrowAddress,
    planId,
    orderId,
    stageKey,
    kind,
    ...amounts,
    sourceFactId,
    payer: payerAccount.address
  })).instruction;
}

async function createCoSigned(
  ledger: ReturnType<typeof ledgerWith>["ledger"],
  kind: "refund_after_start" | "dispute" | "resolve_dispute",
  fact: Hex = sourceFactId
): Promise<SettlementInstructionView> {
  return (await ledger.createInstruction({
    chainId,
    escrowAddress,
    planId,
    orderId,
    stageKey,
    kind,
    payerAmount: "200000",
    payeeAmount: "800000",
    sourceFactId: fact,
    payer: payerAccount.address
  })).instruction;
}

async function readyExecute(kind: "execute_transfer" | "execute_refund") {
  const { ledger, store } = ledgerWith();
  const amounts = kind === "execute_transfer"
    ? { payerAmount: "0", payeeAmount: AMOUNT }
    : { payerAmount: AMOUNT, payeeAmount: "0" };
  const created = await ledger.createInstruction({
    chainId,
    escrowAddress,
    planId,
    orderId,
    stageKey,
    kind,
    ...amounts,
    sourceFactId,
    payer: payerAccount.address,
    executeEligibleAt: new Date(now.getTime() - 1_000).toISOString()
  });
  expect(created.instruction.status).toBe("execute_ready");
  return { store, instruction: created.instruction };
}

describe("instructionRef", () => {
  it("uses the fact-source formula keccak(abi.encode(domain, planId, orderId, stageId))", () => {
    const expected = keccak256(
      encodeAbiParameters(
        [{ type: "string" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
        ["uvp.factsource.instruction.v1", planId, orderId, stageId]
      )
    );
    expect(settlementInstructionRef({ planId, orderId, stageId })).toBe(expected);
    expect(
      settlementInstructionRef({ planId, orderId, stageId })
    ).toBe(settlementInstructionRef({ planId, orderId, stageId }));
  });
});

describe("verdict instructions", () => {
  it("only the assigned verifier C can sign; wrong verifier and outsider are rejected", async () => {
    const { ledger } = ledgerWith();
    const approve = await createVerdict(ledger, "verdict_approve");
    await expect(sign(ledger, approve, payerAccount)).rejects.toMatchObject({ status: 403, code: "signer_role_not_required" });
    await expect(sign(ledger, approve, outsider)).rejects.toMatchObject({ status: 403, code: "signer_not_authorized" });
    await expect(sign(ledger, approve, verifierAccount)).resolves.toMatchObject({ status: "ready" });

    const wrongVerifier = ledgerWith({ tranches: bindingReader({ verifier: outsider.address }) });
    const approve2 = await createVerdict(wrongVerifier.ledger, "verdict_approve");
    await expect(sign(wrongVerifier.ledger, approve2, verifierAccount)).rejects.toMatchObject({
      status: 403,
      code: "signer_not_authorized"
    });
  });

  it("locks verdict amounts to full transfer or full refund", async () => {
    const { ledger } = ledgerWith();
    const reject = await createVerdict(ledger, "verdict_reject");
    expect(reject.payerAmount).toBe(AMOUNT);
    expect(reject.payeeAmount).toBe("0");
  });
});

describe("payer/payee co-signed instructions", () => {
  it("requires both signatures; one signature never settles", async () => {
    const { ledger } = ledgerWith();
    const created = await createCoSigned(ledger, "refund_after_start");
    const payerSigned = await sign(ledger, created, payerAccount);
    expect(payerSigned.status).toBe("partially_signed");
    const { store } = ledgerWith();
    const adapter = new FakeAdapter();
    const relayer = createSettlementRelayer({ store, adapter, now: () => now });
    expect((await relayer.process(payerSigned.instructionId)).outcome).toBe("skipped");
    expect(adapter.submitted).toHaveLength(0);

    const ready = await sign(ledger, payerSigned, payeeAccount);
    expect(ready.status).toBe("ready");
    expect(ready.signatures.map((entry) => entry.role).sort()).toEqual(["payee", "payer"]);
    const replay = await sign(ledger, ready, payeeAccount);
    expect(replay.status).toBe("ready");
    expect(replay.signatures).toHaveLength(2);
  });

  it("replays an identical second signature idempotently", async () => {
    const { ledger } = ledgerWith();
    const created = await createCoSigned(ledger, "dispute");
    const signed = await sign(ledger, created, payerAccount);
    const signature = await payerAccount.signTypedData(toSignable(signed.typedData));
    const replay = await ledger.addSignature({
      instructionId: signed.instructionId,
      signer: payerAccount.address,
      signature
    });
    expect(replay.replayed).toBe(true);
    expect(replay.instruction.signatures).toHaveLength(1);
  });
});

describe("pluggable execute trigger", () => {
  it("uvp_fact_source: denies while fact missing, allows any relayer once present", async () => {
    const adapter = new FakeAdapter();
    const first = await readyExecute("execute_transfer");
    const deniedRelayer = createSettlementRelayer({
      store: first.store,
      adapter,
      bindings: bindingReader(),
      now: () => now,
      executeTrigger: createSettlementFactSourceTrigger({ async hasSettlementFact() { return false; } })
    });
    expect(await deniedRelayer.process(first.instruction.instructionId)).toMatchObject({
      status: "failed",
      errorCode: "settlement_fact_missing"
    });
    expect(adapter.submitted).toHaveLength(0);

    const second = await readyExecute("execute_transfer");
    const allowedRelayer = createSettlementRelayer({
      store: second.store,
      adapter,
      bindings: bindingReader(),
      now: () => now,
      executeTrigger: createSettlementFactSourceTrigger({ async hasSettlementFact() { return true; } })
    });
    expect((await allowedRelayer.process(second.instruction.instructionId)).outcome).toBe("submitted");
    expect(adapter.submitted).toHaveLength(1);
  });

  it("refuses execute after a co-signed dispute and keeps execute amounts immutable", async () => {
    const { store, instruction } = await readyExecute("execute_transfer");
    const { ledger } = ledgerWith({ store });
    const dispute = await createCoSigned(ledger, "dispute", `0x${"ee".repeat(32)}`);
    await sign(ledger, dispute, payerAccount);
    await sign(ledger, dispute, payeeAccount);
    const adapter = new FakeAdapter();
    const relayer = createSettlementRelayer({
      store,
      adapter,
      bindings: bindingReader(),
      now: () => now,
      executeTrigger: createSettlementFactSourceTrigger({ async hasSettlementFact() { return true; } })
    });
    expect(await relayer.process(instruction.instructionId)).toMatchObject({
      status: "failed",
      errorCode: "blocked_by_dispute"
    });
    expect(adapter.submitted).toHaveLength(0);

    await expect(ledger.createInstruction({
      chainId,
      escrowAddress,
      planId,
      orderId,
      stageKey,
      kind: "execute_transfer",
      payerAmount: "0",
      payeeAmount: "999999",
      sourceFactId,
      payer: payerAccount.address,
      executeEligibleAt: now.toISOString()
    })).rejects.toMatchObject({ code: "execute_amount_immutable" });
  });
});

describe("relayer idempotency / unknown / foreign", () => {
  it("relays once, confirms from matching receipt, and never re-sends", async () => {
    const { ledger, store } = ledgerWith();
    const approve = await createVerdict(ledger, "verdict_approve");
    const ready = await sign(ledger, approve, verifierAccount);
    const adapter = new FakeAdapter();
    const relayer = createSettlementRelayer({ store, adapter, bindings: bindingReader(), now: () => now });
    expect((await relayer.process(ready.instructionId)).outcome).toBe("submitted");
    expect((await relayer.process(ready.instructionId)).outcome).toBe("pending");
    expect(adapter.submitted).toHaveLength(1);
    adapter.receiptResult = {
      kind: "confirmed",
      receipt: {
        txHash: `0x${"cc".repeat(32)}`,
        blockNumber: "500",
        logIndex: 2,
        payerAmount: "0",
        payeeAmount: AMOUNT,
        feeAmount: "10000",
        instructionRef: ready.instructionRef
      }
    };
    expect((await relayer.process(ready.instructionId)).outcome).toBe("confirmed");
    expect((await relayer.process(ready.instructionId)).outcome).toBe("skipped");
  });

  it("unknown results are terminal and never auto-retried", async () => {
    const { ledger, store } = ledgerWith();
    const approve = await createVerdict(ledger, "verdict_approve");
    const ready = await sign(ledger, approve, verifierAccount);
    const adapter = new FakeAdapter();
    adapter.submitResult = { kind: "unknown", reason: "rpc timeout" };
    const relayer = createSettlementRelayer({ store, adapter, now: () => now });
    expect((await relayer.process(ready.instructionId)).status).toBe("unknown");
    expect((await relayer.process(ready.instructionId)).outcome).toBe("skipped");
    expect(adapter.submitted).toHaveLength(1);
  });

  it("foreign tranches never produce an instruction", async () => {
    const { ledger } = ledgerWith({ tranches: bindingReader({ state: "foreign" }) });
    await expect(createVerdict(ledger, "verdict_approve")).rejects.toMatchObject({ code: "tranche_is_foreign" });
  });
});

describe("sqlite settlement store", () => {
  it("persists per-role signatures, ready transition and receipt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "uvp-settlement-"));
    const store = new SqliteSettlementStore({
      databaseUrl: `sqlite://${join(dir, "settlement.sqlite3")}`,
      migrations: { autoRun: true, directory: MIGRATIONS_DIR }
    });
    try {
      const { ledger } = ledgerWith({ store });
      const created = await createCoSigned(ledger, "refund_after_start");
      const payerSigned = await sign(ledger, created, payerAccount);
      expect(await store.getInstruction(payerSigned.instructionId)).toMatchObject({ status: "partially_signed" });
      const ready = await sign(ledger, payerSigned, payeeAccount);
      expect(await store.getInstruction(ready.instructionId)).toMatchObject({ status: "ready" });
      expect(await store.markSubmittedFromReady(ready.instructionId, 1, now.toISOString())).toBe(true);
      const txHash = `0x${"cc".repeat(32)}` as Hex;
      expect(await store.setSubmittedTx(ready.instructionId, txHash, now.toISOString())).toBe(true);
      expect(await store.markConfirmed(ready.instructionId, {
        receiptId: "r1",
        instructionId: ready.instructionId,
        chainId,
        escrowAddress,
        orderId,
        stageId,
        trancheId,
        payerAmount: "200000",
        payeeAmount: "800000",
        feeAmount: "8000",
        instructionRef: ready.instructionRef,
        txHash,
        blockNumber: "500",
        logIndex: 0,
        confirmedAt: now.toISOString()
      })).toBe(true);
      expect(await store.getReceipt(ready.instructionId)).toMatchObject({ txHash });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
