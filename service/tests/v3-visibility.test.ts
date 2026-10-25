// V3 可见性/任务投影聚焦回归：矩阵（buyer/performer/verifier/operator/
// stranger）、跨 stage 金额/payee/tranche 不可见、403 vs 404、operator 无金额、
// dataState、tasks/next action、fileResources 无 locator、escrow none。

import { keccak256, stringToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { createApiRouter, type ApiRouter } from "../src/api/routes.js";
import {
  MemoryOrderV3Store,
  type OrderTriggerInput,
} from "../src/order/v3/index.js";
import type { EscrowTrancheDTO } from "../src/escrow/index.js";
import { MemoryBindingStore } from "../src/binding/index.js";
import { canonicalStageId, canonicalTrancheId } from "../src/binding/types.js";
import type { TrancheBindingRecord } from "../src/binding/types.js";
import { MemoryProjectionStore } from "../src/storage/projection-store.js";
import { MemorySettlementStore } from "../src/settlement/index.js";
import type { SettlementRelayer } from "../src/settlement/executor.js";
import type { Address } from "../src/shared/types.js";

const stateMachine = "0x9999999999999999999999999999999999999999" as Address;
const operator = privateKeyToAccount(`0x${"01".repeat(32)}`);
const buyer = privateKeyToAccount(`0x${"02".repeat(32)}`);
const performerA = privateKeyToAccount(`0x${"03".repeat(32)}`);
const performerB = privateKeyToAccount(`0x${"04".repeat(32)}`);
const verifierA = privateKeyToAccount(`0x${"05".repeat(32)}`);
const stranger = privateKeyToAccount(`0x${"06".repeat(32)}`);
const planId = `0x${"11".repeat(32)}`;
const planHash = `0x${"22".repeat(32)}`;
const orderId = `0x${"44".repeat(32)}`;
const alphaStageId = keccak256(stringToHex("alpha"));
const betaStageId = keccak256(stringToHex("beta"));
const alphaHash = `sha256:${"ab".repeat(32)}`;
const betaHash = `sha256:${"cd".repeat(32)}`;

function configBundle() {
  return {
    configId: "test/visibility",
    version: "1.0.0",
    status: "published",
    title: "Visibility flow",
    currency: "USDT",
    defaults: { fees: { feeBps: 100, feeRecipientPolicy: "fixed_at_deposit" } },
    windows: [{ key: "win", default: "7d", min: "1h", max: "30d" }],
    timeDefaults: [{ name: "win", expr: "approved +{{win}}" }],
    slots: [
      { key: "buyer", label: "Buyer", kind: "participant" },
      { key: "performer_a", label: "Performer A", kind: "participant" },
      { key: "performer_b", label: "Performer B", kind: "participant" },
      { key: "verifier_a", label: "Verifier A", kind: "participant" },
    ],
    stages: [
      {
        key: "alpha",
        name: "Alpha",
        index: 1,
        funded: true,
        slots: { payer: "buyer", payee: "performer_a", verifier: "verifier_a" },
        senders: ["performer_a", "verifier_a", "buyer"],
        acceptance: { mode: "third_party", verifierSlot: "verifier_a" },
        time: [{ name: "win" }],
        feeBps: 100,
        fileResources: [{ name: "std/alpha", version: "1", hash: alphaHash, ref: "harness/alpha.md" }],
      },
      {
        key: "beta",
        name: "Beta",
        index: 2,
        funded: true,
        slots: { payer: "buyer", payee: "performer_b", verifier: "buyer" },
        senders: ["performer_b", "buyer"],
        acceptance: { mode: "self", verifierSlot: "buyer" },
        time: [{ name: "win" }],
        feeBps: 100,
        fileResources: [{ name: "std/beta", version: "1", hash: betaHash, ref: "harness/beta.md" }],
      },
    ],
    fileResources: [
      { name: "std/alpha", ref: "harness/alpha.md", version: "1", hash: alphaHash },
      { name: "std/beta", ref: "harness/beta.md", version: "1", hash: betaHash },
    ],
    hashes: { algorithm: "sha256", fileResources: { "std/alpha": alphaHash, "std/beta": betaHash } },
  };
}

function term(stageKey: string) {
  return {
    stageKey,
    amount: stageKey === "alpha" ? "1000000" : "2000000",
    feeBps: 100,
    inviteDeadline: "2026-11-01T00:00:00.000Z",
    workDeadline: "2026-11-20T00:00:00.000Z",
  };
}

function identityProvider() {
  return {
    async resolve(headers: Record<string, string | undefined> | undefined) {
      const wallet = headers?.["x-test-wallet"];
      if (!wallet) {
        return {
          level: "anonymous_read" as const,
          roles: [] as const,
          capabilities: [] as const,
          authMode: "anonymous" as const,
          canWrite: false,
          canAdmin: false,
        };
      }
      return {
        level: "store_operator" as const,
        roles: [] as const,
        capabilities: [] as const,
        authMode: "dev_store_headers" as const,
        canWrite: true,
        canAdmin: false,
        anchoredAddress: wallet as Address,
        anchorSource: "dev_header" as const,
      };
    },
  };
}

function headers(wallet: string): Record<string, string> {
  return { "x-test-wallet": wallet.toLowerCase() };
}

function tranche(stageId: string, amount: string): EscrowTrancheDTO {
  return {
    orderId,
    stageId,
    trancheId: keccak256(stringToHex(`tranche:${stageId}`)),
    payer: buyer.address.toLowerCase(),
    payee: performerA.address.toLowerCase(),
    verifier: verifierA.address.toLowerCase(),
    amount,
    observationDays: 14,
    feeBps: 100,
    feeRecipient: operator.address.toLowerCase(),
    state: "frozen",
    approvedAt: null,
    rejectedAt: null,
    suspendedAt: null,
    releaseAt: null,
    refundAt: null,
    payerAmount: null,
    payeeAmount: null,
    feeAmount: null,
    updatedAt: "2026-10-25T00:00:00.000Z",
    blockNumber: "1",
    logIndex: 0,
  };
}

function alphaBinding(payer: Address, payee: Address): TrancheBindingRecord {
  return {
    bindingId: "binding_alpha",
    chainId: 31337,
    escrowAddress: "0x7777777777777777777777777777777777777777",
    orderId: orderId as `0x${string}`,
    stageKey: "alpha",
    stageId: alphaStageId,
    trancheId: canonicalTrancheId(orderId, alphaStageId, payer),
    payer,
    payee,
    verifier: verifierA.address.toLowerCase() as Address,
    amount: "1000000",
    feeBps: 100,
    feeRecipient: "0x8888888888888888888888888888888888888888",
    state: "bound",
    origin: "intent",
    termsHash: `0x${"33".repeat(32)}`,
    depositTxHash: `0x${"44".repeat(32)}`,
    depositBlock: "1",
    depositLogIndex: 0,
    createdAt: "2026-10-25T00:00:00.000Z",
    updatedAt: "2026-10-25T00:00:00.000Z",
  };
}

interface Setup {
  readonly router: ApiRouter;
  readonly store: MemoryOrderV3Store;
  readonly triggerCalls: OrderTriggerInput[];
}

async function setup(options: {
  readonly resourceResolver?: boolean;
  readonly escrowConfigured?: boolean;
  readonly settlementStore?: MemorySettlementStore;
  readonly settlementRelayer?: SettlementRelayer;
} = {}): Promise<Setup> {
  const store = new MemoryOrderV3Store();
  const triggerCalls: OrderTriggerInput[] = [];
  const payer = buyer.address.toLowerCase() as Address;
  const payee = performerA.address.toLowerCase() as Address;
  const bindingStore = new MemoryBindingStore();
  await bindingStore.saveEscrowInstance({
    chainId: 31337,
    escrowAddress: "0x7777777777777777777777777777777777777777",
    contractVersion: "v3",
    startBlock: "0",
    status: "active",
    createdAt: "2026-10-25T00:00:00.000Z",
    updatedAt: "2026-10-25T00:00:00.000Z",
  });
  await bindingStore.saveCursor({
    chainId: 31337,
    escrowAddress: "0x7777777777777777777777777777777777777777",
    startBlock: "0",
    nextBlock: "2",
    lastBlock: "1",
    lastBlockHash: `0x${"55".repeat(32)}`,
    updatedAt: "2026-10-25T00:00:00.000Z",
  });
  await bindingStore.saveTrancheBinding(alphaBinding(payer, payee));
  const settlementStore = options.settlementStore ?? new MemorySettlementStore();
  const router = createApiRouter(new MemoryProjectionStore(), {
    productRuntimeEnvironment: "local",
    submissionChainId: 31337,
    submissionVerifyingContract: stateMachine,
    productTriggerChainId: 31337,
    orderV3ChainId: 31337,
    orderV3StateMachineAddress: stateMachine,
    orderV3ConfigPublisherWallets: [operator.address.toLowerCase() as Address],
    orderV3OperatorWallets: [operator.address.toLowerCase() as Address],
    orderV3Store: store,
    orderV3TriggerPort: {
      async triggerOrder(input) {
        triggerCalls.push(input);
        return { orderId, stateMachine };
      },
    },
    ...(options.escrowConfigured === false ? {} : { bindingStore, settlementStore }),
    ...(options.settlementRelayer ? { settlementRelayer: options.settlementRelayer } : {}),
    ...(options.resourceResolver === false
      ? {}
      : {
          orderV3ResourceResolver: {
            async resolve(input: { readonly handleKey: string }) {
              if (input.handleKey === "std/alpha") {
                return { kind: "empty" as const };
              }
              if (input.handleKey === "std/beta") {
                return { kind: "resolve_failed" as const, message: "bad bytes" };
              }
              return { kind: "not_found" as const };
            },
          },
        }),
    storeIdentityProvider: identityProvider() as never,
    now: () => new Date("2026-10-25T00:00:00.000Z"),
  });

  const published = await router.handle({
    method: "POST",
    pathname: "/product/v3/configs",
    headers: { ...headers(operator.address), "content-type": "application/json" },
    body: { config: configBundle(), planId, planHash },
  });
  expect(published.status, JSON.stringify(published.body)).toBe(201);

  const draft = await router.handle({
    method: "POST",
    pathname: "/product/v3/order-drafts",
    headers: headers(buyer.address),
    body: {
      configId: "test/visibility",
      configVersion: "1.0.0",
      title: "Order",
      currency: "USDT",
      stageSubset: ["alpha", "beta"],
      stageTerms: [term("alpha"), term("beta")],
    },
  });
  expect(draft.status, JSON.stringify(draft.body)).toBe(201);
  const draftId = (draft.body as { draft: { draftId: string } }).draft.draftId;

  await inviteAndAccept(router, draftId, "alpha", "performer_a", performerA.address, "Performer A");
  await inviteAndAccept(router, draftId, "alpha", "verifier_a", verifierA.address, "Verifier A");
  await inviteAndAccept(router, draftId, "beta", "performer_b", performerB.address, "Performer B");

  const finalize = await router.handle({
    method: "POST",
    pathname: `/product/v3/order-drafts/${draftId}/finalize`,
    headers: headers(buyer.address),
    body: {},
  });
  expect(finalize.status, JSON.stringify(finalize.body)).toBe(200);
  expect((finalize.body as { orderId: string }).orderId).toBe(orderId);
  return { router, store, triggerCalls };
}

async function inviteAndAccept(
  router: ApiRouter,
  draftId: string,
  stageKey: string,
  slotKey: string,
  wallet: string,
  subjectLabel: string,
): Promise<void> {
  const invite = await router.handle({
    method: "POST",
    pathname: `/product/v3/order-drafts/${draftId}/invites`,
    headers: headers(buyer.address),
    body: {
      stageKey,
      slotKey,
      subjectLabel,
      wallet: wallet.toLowerCase(),
      expiresAt: "2026-11-01T00:00:00.000Z",
    },
  });
  expect(invite.status, JSON.stringify(invite.body)).toBe(201);
  const created = invite.body as { inviteId: string; inviteToken: string };
  const preview = await router.handle({
    method: "POST",
    pathname: `/product/v3/invites/${created.inviteId}/preview`,
    headers: headers(wallet),
    body: { token: created.inviteToken },
  });
  expect(preview.status, JSON.stringify(preview.body)).toBe(200);
  const typed = preview.body as {
    typedData: Parameters<typeof performerA.signTypedData>[0];
    terms: { termsHash: string };
  };
  const signer = wallet === performerA.address ? performerA : wallet === performerB.address ? performerB : verifierA;
  const signature = await signer.signTypedData(typed.typedData);
  const accept = await router.handle({
    method: "POST",
    pathname: `/product/v3/invites/${created.inviteId}/accept`,
    headers: headers(wallet),
    body: {
      token: created.inviteToken,
      signature,
      termsHash: typed.terms.termsHash,
      nonce: (typed.typedData.message as { nonce: string }).nonce,
    },
  });
  expect(accept.status, JSON.stringify(accept.body)).toBe(200);
}

describe("V3 visibility", () => {
  it("buyer sees all; performer/verifier see own stage only; stranger 404", async () => {
    const { router } = await setup();
    const buyerOrder = await router.handle({
      method: "GET",
      pathname: `/product/v3/orders/${orderId}`,
      headers: headers(buyer.address),
    });
    expect(buyerOrder.status).toBe(200);
    const buyerBody = buyerOrder.body as { stages: { stageKey: string; amount?: string; slots?: { wallet?: string }[] }[] };
    expect(buyerBody.stages.map((stage) => stage.stageKey)).toEqual(["alpha", "beta"]);
    expect(buyerBody.stages.map((stage) => stage.amount)).toEqual(["1000000", "2000000"]);

    const performerOrder = await router.handle({
      method: "GET",
      pathname: `/product/v3/orders/${orderId}`,
      headers: headers(performerA.address),
    });
    expect(performerOrder.status).toBe(200);
    const performerBody = performerOrder.body as {
      buyerWallet?: string;
      stages: { stageKey: string; amount?: string; slots?: { slotKey: string; wallet?: string }[] }[];
    };
    expect(performerBody.buyerWallet).toBeUndefined();
    expect(performerBody.stages.map((stage) => stage.stageKey)).toEqual(["alpha"]);
    expect(performerBody.stages[0]!.amount).toBe("1000000");
    expect(performerBody.stages[0]!.slots?.find((slot) => slot.slotKey === "buyer")?.wallet).toBeUndefined();
    expect(performerBody.stages[0]!.slots?.find((slot) => slot.slotKey === "performer_a")?.wallet).toBe(performerA.address.toLowerCase());

    const beta = await router.handle({
      method: "GET",
      pathname: `/product/v3/orders/${orderId}/stages/beta`,
      headers: headers(performerA.address),
    });
    expect(beta.status).toBe(403);
    expect((beta.body as { error: string }).error).toBe("wallet_scope_forbidden");

    const verifierOrder = await router.handle({
      method: "GET",
      pathname: `/product/v3/orders/${orderId}`,
      headers: headers(verifierA.address),
    });
    expect(verifierOrder.status).toBe(200);
    expect((verifierOrder.body as { stages: { stageKey: string }[] }).stages.map((stage) => stage.stageKey)).toEqual(["alpha"]);

    const strangerOrder = await router.handle({
      method: "GET",
      pathname: `/product/v3/orders/${orderId}`,
      headers: headers(stranger.address),
    });
    expect(strangerOrder.status).toBe(404);
    const strangerStage = await router.handle({
      method: "GET",
      pathname: `/product/v3/orders/${orderId}/stages/alpha`,
      headers: headers(stranger.address),
    });
    expect(strangerStage.status).toBe(404);
  });

  it("operator gets minimal order and stage summary without amounts/wallets", async () => {
    const { router } = await setup();
    const ops = await router.handle({
      method: "GET",
      pathname: `/product/v3/ops/orders/${orderId}`,
      headers: headers(operator.address),
    });
    expect(ops.status).toBe(200);
    const body = ops.body as { stages: Record<string, unknown>[]; exceptions: unknown[] };
    expect(body.stages).toHaveLength(2);
    for (const stage of body.stages) {
      expect(stage).not.toHaveProperty("amount");
      expect(stage).not.toHaveProperty("payer");
      expect(stage).not.toHaveProperty("payee");
      expect(stage).not.toHaveProperty("wallet");
    }
    expect(body.exceptions).toEqual([]);

    const operatorOrder = await router.handle({
      method: "GET",
      pathname: `/product/v3/orders/${orderId}`,
      headers: headers(operator.address),
    });
    expect(operatorOrder.status).toBe(200);
    const orderBody = operatorOrder.body as { buyerWallet?: string; stages: Record<string, unknown>[] };
    expect(orderBody.buyerWallet).toBeUndefined();
    for (const stage of orderBody.stages) {
      expect(stage).not.toHaveProperty("amount");
    }

    const buyerOps = await router.handle({
      method: "GET",
      pathname: `/product/v3/ops/orders/${orderId}`,
      headers: headers(buyer.address),
    });
    expect(buyerOps.status).toBe(404);
  });

  it("hides cross-stage escrow and returns none for missing tranche", async () => {
    const { router } = await setup();
    const own = await router.handle({
      method: "GET",
      pathname: `/product/v3/orders/${orderId}/stages/alpha/escrow`,
      headers: headers(performerA.address),
    });
    expect(own.status).toBe(200);
    expect((own.body as { amount: string }).amount).toBe("1000000");
    expect((own.body as { payee?: string }).payee).toBeUndefined();

    const binding = await router.handle({
      method: "GET",
      pathname: `/product/v3/orders/${orderId}/stages/alpha/binding`,
      headers: headers(performerA.address),
    });
    expect(binding.status).toBe(200);
    expect((binding.body as { amount: string }).amount).toBe("1000000");
    expect((binding.body as { slots: { slotKey: string; wallet?: string }[] }).slots.find((slot) => slot.slotKey === "buyer")?.wallet).toBeUndefined();

    const cross = await router.handle({
      method: "GET",
      pathname: `/product/v3/orders/${orderId}/stages/beta/escrow`,
      headers: headers(performerA.address),
    });
    expect(cross.status).toBe(403);

    const betaNone = await router.handle({
      method: "GET",
      pathname: `/product/v3/orders/${orderId}/stages/beta/escrow`,
      headers: headers(performerB.address),
    });
    expect(betaNone.status).toBe(200);
    expect((betaNone.body as { dataState: string }).dataState).toBe("none");

    const verifierEscrow = await router.handle({
      method: "GET",
      pathname: `/product/v3/orders/${orderId}/stages/alpha/escrow`,
      headers: headers(verifierA.address),
    });
    expect(verifierEscrow.status).toBe(200);
    expect((verifierEscrow.body as { amount?: string }).amount).toBeUndefined();
    expect((verifierEscrow.body as { state: string }).state).toBe("bound");
  });

  it("returns instruction projection none and resource handles without locator", async () => {
    const { router } = await setup();
    const instructions = await router.handle({
      method: "GET",
      pathname: `/product/v3/orders/${orderId}/stages/alpha/instructions`,
      headers: headers(performerA.address),
    });
    expect(instructions.status).toBe(200);
    expect((instructions.body as { dataState: string; items: unknown[] }).dataState).toBe("none");
    expect((instructions.body as { items: unknown[] }).items).toEqual([]);

    const resources = await router.handle({
      method: "GET",
      pathname: `/product/v3/orders/${orderId}/stages/alpha/resources`,
      headers: headers(performerA.address),
    });
    expect(resources.status).toBe(200);
    const body = resources.body as { dataState: string; items: Record<string, unknown>[] };
    expect(body.dataState).toBe("ok");
    expect(body.items[0]).toMatchObject({ handleKey: "std/alpha", version: "1" });
    expect(body.items[0]).not.toHaveProperty("ref");
    expect(JSON.stringify(body)).not.toContain("harness/alpha.md");

    const emptyHandle = await router.handle({
      method: "GET",
      pathname: `/product/v3/orders/${orderId}/stages/alpha/resources/std/alpha`,
      headers: headers(performerA.address),
    });
    expect(emptyHandle.status).toBe(200);
    expect((emptyHandle.body as { dataState: string }).dataState).toBe("none");

    const missingHandle = await router.handle({
      method: "GET",
      pathname: `/product/v3/orders/${orderId}/stages/alpha/resources/nope`,
      headers: headers(performerA.address),
    });
    expect(missingHandle.status).toBe(404);
    expect((missingHandle.body as { error: string }).error).toBe("handle_not_found");

    const parseFailed = await router.handle({
      method: "GET",
      pathname: `/product/v3/orders/${orderId}/stages/beta/resources/std/beta`,
      headers: headers(performerB.address),
    });
    expect(parseFailed.status).toBe(502);
    expect((parseFailed.body as { error: string }).error).toBe("resource_parse_failed");

    const cross = await router.handle({
      method: "GET",
      pathname: `/product/v3/orders/${orderId}/stages/beta/resources`,
      headers: headers(performerA.address),
    });
    expect(cross.status).toBe(403);
    const operator = await router.handle({
      method: "GET",
      pathname: `/product/v3/orders/${orderId}/stages/alpha/resources`,
      headers: headers(privateKeyToAccount(`0x${"01".repeat(32)}`).address),
    });
    expect(operator.status).toBe(403);
    expect((operator.body as { error: string }).error).toBe("visibility_denied");
  });

  it("projects tasks per slot and exposes next action; stage task view filters", async () => {
    const { router, store } = await setup();
    const buyerTasks = await router.handle({
      method: "GET",
      pathname: "/product/v3/tasks",
      headers: headers(buyer.address),
      query: { orderId },
    });
    expect(buyerTasks.status).toBe(200);
    const buyerBody = buyerTasks.body as { dataState: string; items: { kind: string; status: string; nextAction: string }[] };
    expect(buyerBody.dataState).toBe("ok");
    expect(buyerBody.items.some((task) => task.kind === "fund_stage" && task.status === "open" && task.nextAction === "冻款")).toBe(true);

    const performerTasks = await router.handle({
      method: "GET",
      pathname: "/product/v3/tasks",
      headers: headers(performerA.address),
      query: { orderId },
    });
    expect(performerTasks.status).toBe(200);
    const performerBody = performerTasks.body as { dataState: string; items: { kind: string; status: string; stageKey: string; blockedBy?: string[] }[] };
    expect(performerBody.dataState).toBe("pending");
    expect(performerBody.items).toHaveLength(1);
    expect(performerBody.items[0]).toMatchObject({ kind: "perform_stage", status: "blocked", stageKey: "alpha" });
    expect(performerBody.items[0]!.blockedBy).toContain("fund:alpha");

    const stageTasks = await router.handle({
      method: "GET",
      pathname: `/product/v3/orders/${orderId}/stages/alpha/tasks`,
      headers: headers(verifierA.address),
    });
    expect(stageTasks.status).toBe(200);
    expect((stageTasks.body as { items: { kind: string; status: string }[] }).items[0]).toMatchObject({
      kind: "verify_stage",
      status: "blocked",
    });

    const stages = await store.listStages((await store.getOrder(orderId))!.draftId);
    const alpha = stages.find((stage) => stage.stageKey === "alpha")!;
    await store.saveStage({ ...alpha, status: "funded" });
    const funded = await router.handle({
      method: "GET",
      pathname: "/product/v3/tasks",
      headers: headers(performerA.address),
      query: { orderId },
    });
    expect((funded.body as { items: { status: string }[] }).items[0]!.status).toBe("open");

    await store.saveStage({ ...alpha, status: "performed" });
    const performed = await router.handle({
      method: "GET",
      pathname: "/product/v3/tasks",
      headers: headers(verifierA.address),
      query: { orderId },
    });
    expect((performed.body as { items: { status: string }[] }).items[0]!.status).toBe("open");

    const operatorTasks = await router.handle({
      method: "GET",
      pathname: "/product/v3/tasks",
      headers: headers(operator.address),
      query: { orderId },
    });
    expect(operatorTasks.status).toBe(200);
    expect((operatorTasks.body as { dataState: string }).dataState).toBe("none");
  });

  it("lists execute_ready instructions and lets any wallet trigger the relayer", async () => {
    const settlementStore = new MemorySettlementStore();
    const instructionId = "instr_exec_1";
    await settlementStore.createInstruction({
      instructionId,
      idempotencyKey: instructionId,
      chainId: 31337,
      escrowAddress: "0x7777777777777777777777777777777777777777",
      planId: planId as `0x${string}`,
      orderId: orderId as `0x${string}`,
      stageKey: "alpha",
      stageId: alphaStageId,
      trancheId: canonicalTrancheId(orderId, alphaStageId, buyer.address.toLowerCase() as Address),
      kind: "execute_transfer",
      payerAmount: "0",
      payeeAmount: "1000000",
      sourceFactId: `0x${"66".repeat(32)}`,
      payer: buyer.address.toLowerCase() as Address,
      payee: performerA.address.toLowerCase() as Address,
      verifier: verifierA.address.toLowerCase() as Address,
      requiredSigners: [],
      signatures: [],
      instructionRef: `0x${"77".repeat(32)}`,
      typedDataHash: `0x${"88".repeat(32)}`,
      nonce: "7",
      deadline: "1893456000",
      status: "execute_ready",
      executeEligibleAt: "2026-01-01T00:00:00.000Z",
      blockedByDispute: false,
      attempts: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const calls: string[] = [];
    const { router } = await setup({
      settlementStore,
      settlementRelayer: {
        async process(id) {
          calls.push(id);
          return { instructionId: id, status: "submitted", outcome: "submitted" };
        },
        async runOnce() {
          return { ready: 0, submitted: 0, confirmed: 0, failed: 0, unknown: 0, pending: 0 };
        },
      },
    });
    const ready = await router.handle({
      method: "GET",
      pathname: "/product/v3/execution/execute-ready",
      headers: headers(performerA.address),
    });
    expect(ready.status).toBe(200);
    expect((ready.body as { instructions: { instructionId: string }[] }).instructions[0]?.instructionId).toBe(instructionId);

    const executed = await router.handle({
      method: "POST",
      pathname: `/product/v3/orders/${orderId}/stages/alpha/instructions/${instructionId}/execute`,
      headers: headers(performerB.address),
    });
    expect(executed.status).toBe(202);
    expect(calls).toEqual([instructionId]);
  });

  it("returns dataState unknown when no V3 escrow instance is registered", async () => {
    const { router } = await setup({ escrowConfigured: false });
    const response = await router.handle({
      method: "GET",
      pathname: `/product/v3/orders/${orderId}/stages/alpha/escrow`,
      headers: headers(performerA.address),
    });
    expect(response.status).toBe(200);
    expect((response.body as { dataState: string }).dataState).toBe("unknown");
  });

});
