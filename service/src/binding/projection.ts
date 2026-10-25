// Binding projection: chain facts in, binding rows out. Deposits match the
// stored accepted-terms intent by every on-chain term; a mismatch flips the
// binding to "mismatch" and records an anomaly. Settlements verify conservation
// and fee before flipping to "settled". Nothing is coerced into a success.

import { randomUUID } from "node:crypto";
import { hashCanonicalJson } from "../shared/canonical-json.js";
import type { Address, Hex } from "../shared/types.js";
import type { BindingEvent } from "./events.js";
import type { BindingStore } from "./store.js";
import {
  BindingError,
  type BindingAnomalyReason,
  type BindingEventAnomaly,
  type DepositIntentRecord,
  type TrancheBindingRecord
} from "./types.js";

export interface BindingProjectionOptions {
  readonly store: BindingStore;
  readonly minimumBlock?: string;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
}

export type BindingProjectionReason = "duplicate" | "conflict" | "anomaly";

export interface BindingProjectionResult {
  readonly applied: boolean;
  readonly reason?: BindingProjectionReason;
}

export async function applyBindingEvent(
  event: BindingEvent,
  options: BindingProjectionOptions
): Promise<BindingProjectionResult> {
  const now = options.now ?? (() => new Date());
  const idFactory = options.idFactory ?? (() => `bind_${randomUUID()}`);
  const timestamp = new Date(Number(event.blockTimestamp) * 1000).toISOString();
  if (options.minimumBlock !== undefined && event.blockNumber < BigInt(options.minimumBlock)) {
    await recordAnomaly(options.store, {
      chainId: event.chainId,
      escrowAddress: event.escrowAddress,
      blockNumber: event.blockNumber.toString(),
      logIndex: event.logIndex,
      txHash: event.transactionHash,
      reason: "event_before_start_block",
      details: { startBlock: options.minimumBlock },
      createdAt: now().toISOString()
    }, idFactory);
  }
  return event.eventName === "Deposited"
    ? applyDeposited(event, { ...options, now, idFactory, timestamp })
    : applySettled(event, { ...options, now, idFactory, timestamp });
}

async function applyDeposited(
  event: Extract<BindingEvent, { eventName: "Deposited" }>,
  options: BindingProjectionOptions & {
    readonly timestamp: string;
    readonly idFactory: () => string;
  }
): Promise<BindingProjectionResult> {
  const store = options.store;
  const existing = await store.getTrancheBinding(event.chainId, event.escrowAddress, event.trancheId);
  if (existing) {
    const sameDeposit =
      existing.orderId === event.args.orderId &&
      existing.stageId === event.args.stageId &&
      existing.payer === event.args.payer &&
      existing.payee === event.args.payee &&
      existing.amount === event.args.amount.toString() &&
      existing.feeBps === event.args.feeBps &&
      existing.feeRecipient === event.args.feeRecipient;
    if (sameDeposit) {
      return { applied: false, reason: "duplicate" };
    }
    await store.saveTrancheBinding({ ...existing, state: "mismatch", updatedAt: options.timestamp });
    await recordAnomaly(store, {
      chainId: event.chainId,
      escrowAddress: event.escrowAddress,
      blockNumber: event.blockNumber.toString(),
      logIndex: event.logIndex,
      txHash: event.transactionHash,
      reason: "binding_conflict",
      details: {
        trancheId: event.trancheId,
        existingBindingId: existing.bindingId,
        observed: depositTermsOf(event)
      },
      createdAt: options.timestamp
    }, options.idFactory);
    return { applied: false, reason: "conflict" };
  }

  const intent = await store.findDepositIntentByStage(
    event.chainId,
    event.escrowAddress,
    event.args.orderId,
    event.args.stageId,
    ["active", "submitted", "deposited"]
  );

  const legitimateIntent = intent !== undefined &&
    intent.payer === event.args.payer &&
    intent.trancheId === event.trancheId;
  if (!legitimateIntent) {
    const eventTermsHash = hashCanonicalJson(depositTermsOf(event), "depositTermsHash");
    await store.saveTrancheBinding({
      bindingId: options.idFactory(),
      chainId: event.chainId,
      escrowAddress: event.escrowAddress,
      orderId: event.args.orderId,
      stageKey: intent && intent.payer === event.args.payer ? intent.stageKey : stageKeyFromEvent(event),
      stageId: event.args.stageId,
      trancheId: event.trancheId,
      payer: event.args.payer,
      payee: event.args.payee,
      amount: event.args.amount.toString(),
      feeBps: event.args.feeBps,
      feeRecipient: event.args.feeRecipient,
      state: "foreign",
      origin: intent ? "intent" : "event_only",
      ...(intent !== undefined ? { termsHash: intent.termsHash } : { termsHash: eventTermsHash }),
      depositTxHash: event.transactionHash,
      depositBlock: event.blockNumber.toString(),
      depositLogIndex: event.logIndex,
      createdAt: options.timestamp,
      updatedAt: options.timestamp
    });
    await recordAnomaly(store, {
      chainId: event.chainId,
      escrowAddress: event.escrowAddress,
      blockNumber: event.blockNumber.toString(),
      logIndex: event.logIndex,
      txHash: event.transactionHash,
      reason: intent === undefined ? "deposit_without_intent" : "foreign_tranche",
      details: {
        trancheId: event.trancheId,
        observedPayer: event.args.payer,
        ...(intent !== undefined ? { expectedPayer: intent.payer, intentId: intent.intentId } : {}),
        observed: depositTermsOf(event)
      },
      createdAt: options.timestamp
    }, options.idFactory);
    return { applied: true, reason: "anomaly" };
  }

  if (!intentMatchesEvent(intent, event)) {
    await store.saveTrancheBinding({
      bindingId: options.idFactory(),
      chainId: event.chainId,
      escrowAddress: event.escrowAddress,
      orderId: event.args.orderId,
      stageKey: intent.stageKey,
      stageId: event.args.stageId,
      trancheId: event.trancheId,
      payer: event.args.payer,
      payee: event.args.payee,
      verifier: intent.verifier,
      amount: event.args.amount.toString(),
      feeBps: event.args.feeBps,
      feeRecipient: event.args.feeRecipient,
      state: "mismatch",
      origin: "intent",
      termsHash: intent.termsHash,
      depositTxHash: event.transactionHash,
      depositBlock: event.blockNumber.toString(),
      depositLogIndex: event.logIndex,
      createdAt: options.timestamp,
      updatedAt: options.timestamp
    });
    await store.updateDepositIntent({ ...intent, status: "cancelled", updatedAt: options.timestamp });
    await recordAnomaly(store, {
      chainId: event.chainId,
      escrowAddress: event.escrowAddress,
      blockNumber: event.blockNumber.toString(),
      logIndex: event.logIndex,
      txHash: event.transactionHash,
      reason: "deposit_terms_mismatch",
      details: {
        intentId: intent.intentId,
        expected: intentTermsOf(intent),
        observed: depositTermsOf(event)
      },
      createdAt: options.timestamp
    }, options.idFactory);
    return { applied: true, reason: "conflict" };
  }

  await store.saveTrancheBinding({
    bindingId: options.idFactory(),
    chainId: event.chainId,
    escrowAddress: event.escrowAddress,
    orderId: event.args.orderId,
    stageKey: intent.stageKey,
    stageId: event.args.stageId,
    trancheId: event.trancheId,
    payer: event.args.payer,
    payee: event.args.payee,
    verifier: intent.verifier,
    amount: event.args.amount.toString(),
    feeBps: event.args.feeBps,
    feeRecipient: event.args.feeRecipient,
    state: "bound",
    origin: "intent",
    termsHash: intent.termsHash,
    depositTxHash: event.transactionHash,
    depositBlock: event.blockNumber.toString(),
    depositLogIndex: event.logIndex,
    createdAt: options.timestamp,
    updatedAt: options.timestamp
  });
  await store.updateDepositIntent({ ...intent, status: "deposited", updatedAt: options.timestamp });
  return { applied: true };
}

async function applySettled(
  event: Extract<BindingEvent, { eventName: "Settled" }>,
  options: BindingProjectionOptions & {
    readonly timestamp: string;
    readonly idFactory: () => string;
  }
): Promise<BindingProjectionResult> {
  const store = options.store;
  const binding = await store.getTrancheBinding(event.chainId, event.escrowAddress, event.trancheId);
  if (binding && binding.state === "foreign") {
    await recordAnomaly(store, {
      chainId: event.chainId,
      escrowAddress: event.escrowAddress,
      blockNumber: event.blockNumber.toString(),
      logIndex: event.logIndex,
      txHash: event.transactionHash,
      reason: "foreign_tranche",
      details: {
        phase: "settle",
        trancheId: event.trancheId,
        instructionRef: event.args.instructionRef
      },
      createdAt: options.timestamp
    }, options.idFactory);
    return { applied: false, reason: "anomaly" };
  }
  if (!binding) {
    await recordAnomaly(store, {
      chainId: event.chainId,
      escrowAddress: event.escrowAddress,
      blockNumber: event.blockNumber.toString(),
      logIndex: event.logIndex,
      txHash: event.transactionHash,
      reason: "settlement_without_binding",
      details: {
        orderId: event.args.orderId,
        stageId: event.args.stageId,
        instructionRef: event.args.instructionRef
      },
      createdAt: options.timestamp
    }, options.idFactory);
    return { applied: false, reason: "anomaly" };
  }
  if (binding.state === "settled") {
    if (
      binding.instructionRef === event.args.instructionRef &&
      binding.settledTxHash === event.transactionHash
    ) {
      return { applied: false, reason: "duplicate" };
    }
    await recordAnomaly(store, {
      chainId: event.chainId,
      escrowAddress: event.escrowAddress,
      blockNumber: event.blockNumber.toString(),
      logIndex: event.logIndex,
      txHash: event.transactionHash,
      reason: "binding_conflict",
      details: {
        bindingId: binding.bindingId,
        existingInstructionRef: binding.instructionRef ?? null,
        observedInstructionRef: event.args.instructionRef
      },
      createdAt: options.timestamp
    }, options.idFactory);
    return { applied: false, reason: "conflict" };
  }
  const conservationError = settlementConservationError(binding, event);
  if (conservationError !== undefined) {
    await store.saveTrancheBinding({ ...binding, state: "mismatch", updatedAt: options.timestamp });
    await recordAnomaly(store, {
      chainId: event.chainId,
      escrowAddress: event.escrowAddress,
      blockNumber: event.blockNumber.toString(),
      logIndex: event.logIndex,
      txHash: event.transactionHash,
      reason: "binding_conflict",
      details: { bindingId: binding.bindingId, error: conservationError },
      createdAt: options.timestamp
    }, options.idFactory);
    return { applied: false, reason: "conflict" };
  }
  await store.saveTrancheBinding({
    ...binding,
    state: "settled",
    payerAmount: event.args.payerAmount.toString(),
    payeeAmount: event.args.payeeAmount.toString(),
    feeAmount: event.args.fee.toString(),
    instructionRef: event.args.instructionRef,
    settledTxHash: event.transactionHash,
    settledBlock: event.blockNumber.toString(),
    updatedAt: options.timestamp
  });
  return { applied: true };
}

function settlementConservationError(
  binding: TrancheBindingRecord,
  event: Extract<BindingEvent, { eventName: "Settled" }>
): string | undefined {
  const total = BigInt(binding.amount);
  const payer = event.args.payerAmount;
  const payee = event.args.payeeAmount;
  if (payer + payee !== total) {
    return `payerAmount+payeeAmount (${payer + payee}) != bound amount (${total})`;
  }
  if (event.args.orderId !== binding.orderId || event.args.stageId !== binding.stageId) {
    return "settlement orderId/stageId does not match the binding";
  }
  const expectedFee = (payee * BigInt(binding.feeBps)) / 10_000n;
  if (event.args.fee !== expectedFee) {
    return `fee (${event.args.fee}) != payeeAmount*feeBps/10000 (${expectedFee})`;
  }
  return undefined;
}

function intentMatchesEvent(
  intent: DepositIntentRecord,
  event: Extract<BindingEvent, { eventName: "Deposited" }>
): boolean {
  return intent.orderId === event.args.orderId &&
    intent.stageId === event.args.stageId &&
    intent.trancheId === event.trancheId &&
    intent.payer === event.args.payer &&
    intent.payee === event.args.payee &&
    intent.amount === event.args.amount.toString() &&
    intent.feeBps === event.args.feeBps &&
    intent.feeRecipient === event.args.feeRecipient &&
    intent.nonce === event.args.nonce.toString();
}

function depositTermsOf(event: Extract<BindingEvent, { eventName: "Deposited" }>): Record<string, string | number> {
  return {
    orderId: event.args.orderId,
    stageId: event.args.stageId,
    payer: event.args.payer,
    payee: event.args.payee,
    amount: event.args.amount.toString(),
    feeBps: event.args.feeBps,
    feeRecipient: event.args.feeRecipient,
    nonce: event.args.nonce.toString()
  };
}

function intentTermsOf(intent: DepositIntentRecord): Record<string, string | number> {
  return {
    orderId: intent.orderId,
    stageId: intent.stageId,
    payer: intent.payer,
    payee: intent.payee,
    amount: intent.amount,
    feeBps: intent.feeBps,
    feeRecipient: intent.feeRecipient,
    nonce: intent.nonce
  };
}

function stageKeyFromEvent(event: Extract<BindingEvent, { eventName: "Deposited" }>): string {
  if (BigInt(event.args.stageId) === 0n) {
    throw new BindingError(409, "event_stage_id_zero", "Deposited event carries a zero stageId");
  }
  return `unknown:${event.args.stageId.toLowerCase()}`;
}

async function recordAnomaly(
  store: BindingStore,
  input: {
    readonly chainId: number;
    readonly escrowAddress: Address;
    readonly blockNumber: string;
    readonly logIndex: number;
    readonly txHash: Hex;
    readonly reason: BindingAnomalyReason;
    readonly details: unknown;
    readonly createdAt: string;
  },
  idFactory: () => string
): Promise<void> {
  const anomaly: BindingEventAnomaly = {
    anomalyId: idFactory(),
    chainId: input.chainId,
    escrowAddress: input.escrowAddress,
    blockNumber: input.blockNumber,
    logIndex: input.logIndex,
    txHash: input.txHash,
    reason: input.reason,
    details: input.details,
    createdAt: input.createdAt
  };
  await store.recordAnomaly(anomaly);
}
