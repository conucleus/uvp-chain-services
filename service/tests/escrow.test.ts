// StageEscrow V2 projection: replay/rebuild, lifecycle mapping, explicit
// unknown-tranche handling, and the session-anchored product read surface.

import { describe, expect, it } from "vitest";
import { keccak256, toHex } from "viem";
import { createApiRouter } from "../src/api/routes.js";
import { loadConfigFromEnv } from "../src/config/index.js";
import {
  createEscrowQueryService,
  decodeEscrowLogs,
  MemoryEscrowStore,
  rebuildEscrowProjection,
  replayEscrowEvents,
  trancheDTO,
  type EscrowEvent,
  type EscrowTrancheRecord
} from "../src/escrow/index.js";
import { MemoryProjectionStore } from "../src/storage/projection-store.js";
import type { Address, Hex } from "../src/shared/types.js";

const chainId = 31337;
const escrowAddress = "0x1111111111111111111111111111111111111111" as Address;
const orderId = `0x${"aa".repeat(32)}` as Hex;
const planId = `0x${"22".repeat(32)}` as Hex;
const stageId = `0x${"bb".repeat(32)}` as Hex;
const trancheId = `0x${"cc".repeat(32)}` as Hex;
const payer = "0x2222222222222222222222222222222222222222" as Address;
const payee = "0x3333333333333333333333333333333333333333" as Address;
const verifier = "0x4444444444444444444444444444444444444444" as Address;
const feeRecipient = "0x5555555555555555555555555555555555555555" as Address;
const thirdParty = "0x6666666666666666666666666666666666666666" as Address;
const otherVerifier = "0x7777777777777777777777777777777777777777" as Address;
const walletHeaders = { "x-uvp-wallet-address": payer };
const base = { chainId, escrowAddress, trancheId } as const;

function deposited(
  blockNumber: bigint,
  blockTimestamp: bigint,
  amount: bigint,
  overrides: {
    readonly payer?: Address;
    readonly verifier?: Address;
    readonly stageId?: Hex;
    readonly trancheId?: Hex;
  } = {}
): EscrowEvent {
  return {
    ...base,
    ...(overrides.trancheId ? { trancheId: overrides.trancheId } : {}),
    blockNumber,
    logIndex: 0,
    blockTimestamp,
    eventName: "TrancheDeposited",
    args: {
      orderId,
      stageId: overrides.stageId ?? stageId,
      payer: overrides.payer ?? payer,
      payee,
      verifier: overrides.verifier ?? verifier,
      feeRecipient,
      amount,
      observationDays: 14,
      feeBps: 100
    }
  };
}

function expectedRecord(
  record: EscrowTrancheRecord | undefined
): EscrowTrancheRecord {
  if (!record) {
    throw new Error("expected a projected tranche");
  }
  return record;
}

describe("StageEscrow projection replay", () => {
  it("projects deposit → started → approve → paid with the fee annotation and replays idempotently", async () => {
    const depositAt = 1_700_000_000n;
    const startedAt = 1_700_000_050n;
    const approveAt = 1_700_000_100n;
    const paidAt = 1_700_000_200n;
    const events: readonly EscrowEvent[] = [
      deposited(10n, depositAt, 1_000_000n),
      {
        ...base,
        blockNumber: 11n,
        logIndex: 1,
        blockTimestamp: startedAt,
        eventName: "TrancheStarted",
        args: { payee }
      },
      {
        ...base,
        blockNumber: 12n,
        logIndex: 2,
        blockTimestamp: approveAt,
        eventName: "TrancheApproved",
        args: {
          verifier,
          releaseTime: approveAt + 14n * 86_400n
        }
      },
      {
        ...base,
        blockNumber: 13n,
        logIndex: 3,
        blockTimestamp: paidAt,
        eventName: "TranchePaid",
        args: {
          payee,
          grossAmount: 1_000_000n,
          fee: 10_000n,
          netAmount: 990_000n,
          reason: 0
        }
      },
      {
        ...base,
        blockNumber: 13n,
        logIndex: 4,
        blockTimestamp: paidAt,
        eventName: "FeePaid",
        args: { feeRecipient, fee: 10_000n }
      }
    ];
    const store = new MemoryEscrowStore();
    const first = await replayEscrowEvents(store, events);
    expect(first).toMatchObject({ eventCount: 5, appliedCount: 5 });

    const paid = expectedRecord(
      (await store.listTranches(escrowAddress, orderId))[0]
    );
    expect(trancheDTO(paid)).toMatchObject({
      orderId,
      stageId,
      trancheId,
      state: "paid",
      approvedAt: new Date(Number(approveAt) * 1000).toISOString(),
      releaseAt: new Date(Number(paidAt) * 1000).toISOString(),
      payerAmount: "0",
      payeeAmount: "990000",
      feeAmount: "10000",
      feeRecipient
    });

    const replayed = await replayEscrowEvents(store, events);
    expect(replayed.appliedCount).toBe(0);
    const unchanged = expectedRecord(
      (await store.getTranche(escrowAddress, orderId, stageId))
    );
    expect(unchanged).toEqual(paid);

    const rebuilt = await rebuildEscrowProjection({
      store,
      escrowAddress,
      events
    });
    expect(rebuilt.appliedCount).toBe(5);
    expect(
      (await store.getTranche(escrowAddress, orderId, stageId))
    ).toEqual(paid);
  });

  it("projects markStarted to the started state and rebuilds it from the same events", async () => {
    const startedAt = 1_700_000_500n;
    const events: readonly EscrowEvent[] = [
      deposited(15n, 1_700_000_400n, 1_000n),
      {
        ...base,
        blockNumber: 16n,
        logIndex: 0,
        blockTimestamp: startedAt,
        eventName: "TrancheStarted",
        args: { payee }
      }
    ];
    const store = new MemoryEscrowStore();
    const summary = await replayEscrowEvents(store, events);
    expect(summary).toMatchObject({ eventCount: 2, appliedCount: 2 });

    const record = expectedRecord(
      (await store.getTranche(escrowAddress, orderId, stageId))
    );
    expect(trancheDTO(record)).toMatchObject({
      state: "started",
      updatedAt: new Date(Number(startedAt) * 1000).toISOString(),
      approvedAt: null,
      rejectedAt: null,
      releaseAt: null,
      refundAt: null
    });

    const replayed = await replayEscrowEvents(store, events);
    expect(replayed).toMatchObject({
      appliedCount: 0,
      staleEventCount: 1,
      duplicateEventCount: 1
    });

    const rebuilt = await rebuildEscrowProjection({
      store,
      escrowAddress,
      events
    });
    expect(rebuilt.appliedCount).toBe(2);
    expect(trancheDTO(expectedRecord(
      (await store.getTranche(escrowAddress, orderId, stageId))
    )).state).toBe("started");
  });

  it("decodes TrancheStarted from the contract topic layout", () => {
    const topic2 = `0x${"0".repeat(24)}${payee.slice(2)}` as Hex;
    const decoded = decodeEscrowLogs({
      chainId,
      escrowAddress,
      logs: [{
        address: escrowAddress,
        blockNumber: 70n,
        logIndex: 1,
        data: "0x",
        topics: [
          keccak256(toHex("TrancheStarted(bytes32,address)")),
          trancheId,
          topic2
        ]
      }],
      blockTimestampOf: () => 1_700_000_600n
    });

    expect(decoded.unknownLogCount).toBe(0);
    expect(decoded.events).toEqual([{
      ...base,
      blockNumber: 70n,
      logIndex: 1,
      blockTimestamp: 1_700_000_600n,
      eventName: "TrancheStarted",
      args: { payee }
    }]);
  });

  it("projects reject → refund as a full payer refund with no fee", async () => {
    const rejectedAt = 1_700_001_000n;
    const refundedAt = 1_700_001_100n;
    const store = new MemoryEscrowStore();
    const summary = await replayEscrowEvents(store, [
      deposited(20n, 1_700_000_900n, 500_000n),
      {
        ...base,
        blockNumber: 21n,
        logIndex: 1,
        blockTimestamp: rejectedAt,
        eventName: "TrancheRejected",
        args: { verifier, refundTime: rejectedAt + 48n * 3_600n }
      },
      {
        ...base,
        blockNumber: 22n,
        logIndex: 2,
        blockTimestamp: refundedAt,
        eventName: "TrancheRefunded",
        args: { payer, amount: 500_000n, reason: 2 }
      }
    ]);

    expect(summary.appliedCount).toBe(3);
    expect(
      trancheDTO(expectedRecord(
        (await store.getTranche(escrowAddress, orderId, stageId))
      ))
    ).toMatchObject({
      state: "refunded",
      rejectedAt: new Date(Number(rejectedAt) * 1000).toISOString(),
      refundAt: new Date(Number(refundedAt) * 1000).toISOString(),
      payerAmount: "500000",
      payeeAmount: "0",
      feeAmount: "0",
      releaseAt: null
    });
  });

  it("keeps a suspended split pending until the matching 20:80 settlement", async () => {
    const suspendedAt = 1_700_002_100n;
    const settledAt = 1_700_002_200n;
    const store = new MemoryEscrowStore();
    await replayEscrowEvents(store, [
      deposited(30n, 1_700_001_900n, 1_000n),
      {
        ...base,
        blockNumber: 31n,
        logIndex: 1,
        blockTimestamp: 1_700_002_000n,
        eventName: "TrancheApproved",
        args: { verifier, releaseTime: 1_700_002_000n + 14n * 86_400n }
      },
      {
        ...base,
        blockNumber: 32n,
        logIndex: 2,
        blockTimestamp: suspendedAt,
        eventName: "TrancheSuspended",
        args: { party: payer }
      },
      {
        ...base,
        blockNumber: 33n,
        logIndex: 3,
        blockTimestamp: 1_700_002_150n,
        eventName: "SettlementProposed",
        args: { party: payer, payerAmount: 200n, payeeAmount: 800n }
      }
    ]);

    const pending = expectedRecord(
      (await store.getTranche(escrowAddress, orderId, stageId))
    );
    expect(pending).toMatchObject({
      state: "suspended",
      suspendedAt: new Date(Number(suspendedAt) * 1000).toISOString()
    });
    expect(pending.payerAmount).toBeUndefined();
    expect(pending.payeeAmount).toBeUndefined();

    const summary = await replayEscrowEvents(store, [
      {
        ...base,
        blockNumber: 34n,
        logIndex: 4,
        blockTimestamp: settledAt,
        eventName: "TrancheSettled",
        args: { payerAmount: 200n, payeeAmount: 800n, fee: 8n }
      },
      {
        ...base,
        blockNumber: 34n,
        logIndex: 5,
        blockTimestamp: settledAt,
        eventName: "FeePaid",
        args: { feeRecipient, fee: 8n }
      }
    ]);

    expect(summary.appliedCount).toBe(2);
    expect(
      trancheDTO(expectedRecord(
        (await store.getTranche(escrowAddress, orderId, stageId))
      ))
    ).toMatchObject({
      state: "settled",
      payerAmount: "200",
      payeeAmount: "800",
      feeAmount: "8",
      releaseAt: new Date(Number(settledAt) * 1000).toISOString(),
      refundAt: new Date(Number(settledAt) * 1000).toISOString()
    });
  });

  it("drops logs that are not the configured escrow address or carry an unknown signature", () => {
    const unknownTopic = `0x${"99".repeat(32)}` as Hex;
    const decoded = decodeEscrowLogs({
      chainId,
      escrowAddress,
      logs: [
        {
          address: "0x9999999999999999999999999999999999999999",
          blockNumber: 50n,
          logIndex: 0,
          data: "0x",
          topics: [unknownTopic]
        },
        {
          address: escrowAddress,
          blockNumber: 51n,
          logIndex: 0,
          data: "0x",
          topics: [unknownTopic]
        }
      ],
      blockTimestampOf: () => 1_700_004_000n
    });

    expect(decoded.events).toEqual([]);
    expect(decoded.unknownLogCount).toBe(1);
  });

  it("skips unknown-tranche, duplicate, and conflicting-deposit events without fabricating rows", async () => {
    const store = new MemoryEscrowStore();
    const unknown = await replayEscrowEvents(store, [{
      ...base,
      blockNumber: 40n,
      logIndex: 0,
      blockTimestamp: 1_700_003_000n,
      eventName: "TrancheApproved",
      args: { verifier, releaseTime: 1_700_004_000n }
    }]);
    expect(unknown.unknownTrancheEventCount).toBe(1);
    expect(await store.listTranches(escrowAddress, orderId)).toEqual([]);

    const summary = await replayEscrowEvents(store, [
      deposited(41n, 1_700_003_100n, 1_000n),
      deposited(41n, 1_700_003_100n, 1_000n),
      deposited(42n, 1_700_003_200n, 2_000n)
    ]);
    expect(summary).toMatchObject({
      appliedCount: 1,
      duplicateEventCount: 1,
      conflictingDepositCount: 1
    });

    const stored = expectedRecord(
      (await store.getTranche(escrowAddress, orderId, stageId))
    );
    expect(stored.amount).toBe("1000");
    expect(stored.blockNumber).toBe("41");
  });
});

describe("StageEscrow product API", () => {
  it("serves the session-anchored list and stage read for a visible order", async () => {
    const projection = await projectionWithOrder();
    const escrowStore = new MemoryEscrowStore();
    await replayEscrowEvents(escrowStore, [
      deposited(10n, 1_700_000_000n, 1_000n),
      {
        ...base,
        blockNumber: 11n,
        logIndex: 0,
        blockTimestamp: 1_700_000_100n,
        eventName: "TrancheStarted",
        args: { payee }
      }
    ]);
    const router = escrowRouter(projection, escrowStore, true);

    const list = await router.handle({
      method: "GET",
      pathname: `/product/orders/${orderId}/escrow`,
      headers: walletHeaders
    });
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({
      orderId,
      tranches: [{
        orderId,
        stageId,
        trancheId,
        state: "started",
        amount: "1000",
        observationDays: 14,
        feeBps: 100,
        payee,
        verifier
      }]
    });

    const detail = await router.handle({
      method: "GET",
      pathname: `/product/orders/${orderId}`,
      headers: walletHeaders
    });
    expect(detail.status).toBe(200);

    const outsider = await router.handle({
      method: "GET",
      pathname: `/product/orders/${orderId}`,
      headers: { "x-uvp-wallet-address": thirdParty }
    });
    expect(outsider).toMatchObject({
      status: 404,
      body: { error: "product_order_not_found" }
    });

    const stage = await router.handle({
      method: "GET",
      pathname: `/product/orders/${orderId}/escrow/${stageId}`,
      headers: walletHeaders
    });
    expect(stage.status).toBe(200);
    expect(stage.body).toMatchObject({
      orderId,
      stageId,
      state: "started",
      payerAmount: null,
      feeAmount: null
    });

    const missingStage = await router.handle({
      method: "GET",
      pathname: `/product/orders/${orderId}/escrow/0x${"dd".repeat(32)}`,
      headers: walletHeaders
    });
    expect(missingStage).toMatchObject({
      status: 404,
      body: { error: "escrow_tranche_not_found" }
    });

    const unknownOrder = await router.handle({
      method: "GET",
      pathname: `/product/orders/0x${"ee".repeat(32)}/escrow`,
      headers: walletHeaders
    });
    expect(unknownOrder).toMatchObject({
      status: 404,
      body: { error: "product_order_not_found" }
    });

    const anonymous = await router.handle({
      method: "GET",
      pathname: `/product/orders/${orderId}/escrow`
    });
    expect(anonymous.status).toBe(401);
  });

  it("returns an empty tranche list for a configured escrow and 404 when escrow is unconfigured", async () => {
    const projection = await projectionWithOrder();
    const emptyRouter = escrowRouter(projection, new MemoryEscrowStore(), true);
    const empty = await emptyRouter.handle({
      method: "GET",
      pathname: `/product/orders/${orderId}/escrow`,
      headers: walletHeaders
    });
    expect(empty).toMatchObject({
      status: 200,
      body: { orderId, tranches: [] }
    });

    const disabledRouter = escrowRouter(projection, new MemoryEscrowStore(), false);
    const disabled = await disabledRouter.handle({
      method: "GET",
      pathname: `/product/orders/${orderId}/escrow`,
      headers: walletHeaders
    });
    expect(disabled).toMatchObject({
      status: 404,
      body: { error: "escrow_not_configured" }
    });
  });

  it("fails closed for an order with no judgeable participants", async () => {
    // OrderRegistered-only 投影：creator/指派/委任尚未到达，参与者集合为空
    // 不等于公开——任何钱包（含该订单 escrow 的 payer）都按不存在收口。
    const projection = await projectionWithOrder({ withCreator: false });
    const escrowStore = new MemoryEscrowStore();
    await replayEscrowEvents(escrowStore, [
      deposited(10n, 1_700_000_000n, 1_000n)
    ]);
    const router = escrowRouter(projection, escrowStore, true);

    for (const wallet of [payer, thirdParty]) {
      const list = await router.handle({
        method: "GET",
        pathname: `/product/orders/${orderId}/escrow`,
        headers: { "x-uvp-wallet-address": wallet }
      });
      expect(list).toMatchObject({
        status: 404,
        body: { error: "product_order_not_found" }
      });
    }
  });

  it("filters tranches whose payer is not an order participant", async () => {
    const foreignStageId = `0x${"ee".repeat(32)}` as Hex;
    const foreignTrancheId = `0x${"ff".repeat(32)}` as Hex;
    const projection = await projectionWithOrder();
    const escrowStore = new MemoryEscrowStore();
    await replayEscrowEvents(escrowStore, [
      deposited(10n, 1_700_000_000n, 1_000n),
      deposited(11n, 1_700_000_100n, 2_000n, {
        payer: thirdParty,
        stageId: foreignStageId,
        trancheId: foreignTrancheId
      })
    ]);
    const router = escrowRouter(projection, escrowStore, true);
    expect((await escrowStore.listTranches(escrowAddress, orderId)).map((record) => record.trancheId))
      .toEqual([trancheId, foreignTrancheId]);

    // 真实 tranche 的 payer 是参与者；payee/verifier 是第三方也不误杀。
    const list = await router.handle({
      method: "GET",
      pathname: `/product/orders/${orderId}/escrow`,
      headers: walletHeaders
    });
    expect(list.body).toMatchObject({
      orderId,
      tranches: [{
        trancheId,
        payer,
        payee,
        verifier,
        amount: "1000"
      }]
    });
    expect((list.body as { tranches: { trancheId: string }[] }).tranches
      .map((tranche) => tranche.trancheId)).toEqual([trancheId]);

    const foreignStage = await router.handle({
      method: "GET",
      pathname: `/product/orders/${orderId}/escrow/${foreignStageId}`,
      headers: walletHeaders
    });
    expect(foreignStage).toMatchObject({
      status: 404,
      body: { error: "escrow_tranche_not_found" }
    });

    // 全部 tranche 都被过滤时仍是可读订单的空列表，而不是 404。
    const filteredStore = new MemoryEscrowStore();
    await replayEscrowEvents(filteredStore, [
      deposited(10n, 1_700_000_000n, 2_000n, {
        payer: thirdParty,
        stageId: foreignStageId,
        trancheId: foreignTrancheId
      })
    ]);
    const filtered = await escrowRouter(projection, filteredStore, true).handle({
      method: "GET",
      pathname: `/product/orders/${orderId}/escrow`,
      headers: walletHeaders
    });
    expect(filtered).toMatchObject({
      status: 200,
      body: { orderId, tranches: [] }
    });
  });

  it("serves a third-party verifier only its own tranche and stage", async () => {
    const otherStageId = `0x${"dd".repeat(32)}` as Hex;
    const otherTrancheId = `0x${"ee".repeat(32)}` as Hex;
    const projection = await projectionWithOrder();
    const escrowStore = new MemoryEscrowStore();
    await replayEscrowEvents(escrowStore, [
      deposited(10n, 1_700_000_000n, 1_000n),
      deposited(11n, 1_700_000_100n, 2_000n, {
        verifier: otherVerifier,
        stageId: otherStageId,
        trancheId: otherTrancheId
      })
    ]);
    const router = escrowRouter(projection, escrowStore, true);

    const verifierList = await router.handle({
      method: "GET",
      pathname: `/product/orders/${orderId}/escrow`,
      headers: { "x-uvp-wallet-address": verifier }
    });
    expect(verifierList.status).toBe(200);
    expect((verifierList.body as { tranches: { trancheId: string }[] }).tranches
      .map((tranche) => tranche.trancheId)).toEqual([trancheId]);

    const ownStage = await router.handle({
      method: "GET",
      pathname: `/product/orders/${orderId}/escrow/${stageId}`,
      headers: { "x-uvp-wallet-address": verifier }
    });
    expect(ownStage).toMatchObject({ status: 200, body: { stageId, verifier } });

    const otherStage = await router.handle({
      method: "GET",
      pathname: `/product/orders/${orderId}/escrow/${otherStageId}`,
      headers: { "x-uvp-wallet-address": verifier }
    });
    expect(otherStage).toMatchObject({
      status: 404,
      body: { error: "escrow_tranche_not_found" }
    });

    // payee 同为第三方，也按 "自己那段" 读，而不是按订单可见性。
    const payeeStage = await router.handle({
      method: "GET",
      pathname: `/product/orders/${orderId}/escrow/${stageId}`,
      headers: { "x-uvp-wallet-address": payee }
    });
    expect(payeeStage).toMatchObject({ status: 200, body: { stageId, payee } });

    // 参与者仍读全部（含 verifier 是其他第三方的段）。
    const payerList = await router.handle({
      method: "GET",
      pathname: `/product/orders/${orderId}/escrow`,
      headers: walletHeaders
    });
    expect((payerList.body as { tranches: { trancheId: string }[] }).tranches
      .map((tranche) => tranche.trancheId)).toEqual([trancheId, otherTrancheId]);

    const outsiderList = await router.handle({
      method: "GET",
      pathname: `/product/orders/${orderId}/escrow`,
      headers: { "x-uvp-wallet-address": thirdParty }
    });
    expect(outsiderList).toMatchObject({
      status: 404,
      body: { error: "product_order_not_found" }
    });

    const outsiderStage = await router.handle({
      method: "GET",
      pathname: `/product/orders/${orderId}/escrow/${stageId}`,
      headers: { "x-uvp-wallet-address": thirdParty }
    });
    expect(outsiderStage).toMatchObject({
      status: 404,
      body: { error: "escrow_tranche_not_found" }
    });
  });

  it("does not let a forged payer tranche promote a third party", async () => {
    const forgedStageId = `0x${"dd".repeat(32)}` as Hex;
    const forgedTrancheId = `0x${"ee".repeat(32)}` as Hex;
    const projection = await projectionWithOrder();
    const escrowStore = new MemoryEscrowStore();
    await replayEscrowEvents(escrowStore, [
      deposited(10n, 1_700_000_000n, 2_000n, {
        payer: thirdParty,
        stageId: forgedStageId,
        trancheId: forgedTrancheId
      })
    ]);
    const router = escrowRouter(projection, escrowStore, true);

    // verifier 是伪 tranche 的参与方，但 payer 不是订单参与者；空结果收口为
    // 404，而不是 200 空列表（不泄露该 order 下存在 tranche）。
    const list = await router.handle({
      method: "GET",
      pathname: `/product/orders/${orderId}/escrow`,
      headers: { "x-uvp-wallet-address": verifier }
    });
    expect(list).toMatchObject({
      status: 404,
      body: { error: "product_order_not_found" }
    });

    const stage = await router.handle({
      method: "GET",
      pathname: `/product/orders/${orderId}/escrow/${forgedStageId}`,
      headers: { "x-uvp-wallet-address": verifier }
    });
    expect(stage).toMatchObject({
      status: 404,
      body: { error: "escrow_tranche_not_found" }
    });
  });
});

describe("StageEscrow config", () => {
  it("keeps escrow disabled by default and loads the address, chain, and start block when set", () => {
    const env = {
      CHAIN_SERVICES_RUNTIME_ENV: "local",
      CHAIN_SERVICES_DATABASE_DRIVER: "memory",
      CHAIN_SERVICES_DATABASE_URL: "memory://projection-store",
      UVP_PRODUCT_BFF_REGISTRATION_ADAPTER: "memory-trigger"
    } as const;

    expect(loadConfigFromEnv(env).escrow).toBeUndefined();
    expect(loadConfigFromEnv({
      ...env,
      UVP_ESCROW_ADDRESS: "0x1111111111111111111111111111111111111111",
      UVP_ESCROW_CHAIN_ID: "31337",
      UVP_ESCROW_DEPLOYMENT_BLOCK: "42"
    }).escrow).toEqual({
      address: escrowAddress,
      chainId,
      startBlock: 42n
    });
  });
});

async function projectionWithOrder(
  options: { readonly withCreator?: boolean } = {}
): Promise<MemoryProjectionStore> {
  const store = new MemoryProjectionStore();
  await store.resetFromEvents({
    deploymentBlock: 0n,
    events: [
      {
        chainId,
        contractAddress: escrowAddress,
        blockNumber: 3n,
        transactionIndex: 0,
        transactionHash: `0x${"44".repeat(32)}` as Hex,
        logIndex: 0,
        eventName: "OrderRegistered",
        args: { orderId, planId }
      },
      ...(options.withCreator === false
        ? []
        : [{
            chainId,
            contractAddress: escrowAddress,
            blockNumber: 4n,
            transactionIndex: 0,
            transactionHash: `0x${"45".repeat(32)}` as Hex,
            logIndex: 0,
            eventName: "OrderRelayerRecorded",
            args: {
              orderId,
              planId,
              relayer: payer,
              creator: payer
            }
          }])
    ]
  });
  return store;
}

function escrowRouter(
  projection: MemoryProjectionStore,
  escrowStore: MemoryEscrowStore,
  configured: boolean
) {
  return createApiRouter(projection, {
    submissionChainId: chainId,
    submissionVerifyingContract: escrowAddress,
    productRuntimeEnvironment: "local",
    escrowService: createEscrowQueryService({
      store: escrowStore,
      ...(configured
        ? { config: { address: escrowAddress, chainId } }
        : {})
    })
  });
}
