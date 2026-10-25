// Deposit-intent service: the only place a V3 deposit authorization is built.
// It compares the requested stage against the server-held accepted terms,
// derives stageId/trancheId locally, issues a one-time nonce and deadline, and
// returns the exact EIP-712 payload the contract verifies. Anything that does
// not match the accepted terms fails closed; the client never supplies stageId.

import { randomBytes, randomUUID } from "node:crypto";
import { hashCanonicalJson } from "../shared/canonical-json.js";
import { StorageConstraintError } from "../storage/errors.js";
import { normalizeBytes32, type Address } from "../shared/types.js";
import type { BindingStore } from "./store.js";
import {
  BindingError,
  assertDepositTermsConsistent,
  buildDepositTypedData,
  canonicalStageId,
  normalizeOrderId,
  normalizeWallet,
  type AcceptedStageTermsProvider,
  type DepositIntentRecord,
  type DepositIntentResult,
  type EscrowInstanceRecord
} from "./types.js";

export interface DepositIntentServiceOptions {
  readonly store: BindingStore;
  readonly termsProvider: AcceptedStageTermsProvider;
  readonly chainId?: number;
  readonly escrowAddress?: Address;
  readonly deadlineTtlSeconds?: number;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  readonly nonceFactory?: () => string;
}

export interface DepositIntentRequest {
  readonly orderId: string;
  readonly stageKey: string;
  readonly walletAddress: string;
  readonly idempotencyKey?: string;
}

export interface DepositIntentService {
  createIntent(request: DepositIntentRequest): Promise<DepositIntentResult>;
  getIntent(intentId: string): Promise<DepositIntentRecord | undefined>;
}

const DEFAULT_DEADLINE_TTL_SECONDS = 900;

export function createDepositIntentService(
  options: DepositIntentServiceOptions
): DepositIntentService {
  const now = options.now ?? (() => new Date());
  const idFactory = options.idFactory ?? (() => `dint_${randomUUID()}`);
  const nonceFactory = options.nonceFactory ?? (() => BigInt(`0x${randomBytes(16).toString("hex")}`).toString(10));
  const ttlSeconds = options.deadlineTtlSeconds ?? DEFAULT_DEADLINE_TTL_SECONDS;
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error("deadlineTtlSeconds must be a positive safe integer");
  }

  async function resolveInstance(): Promise<EscrowInstanceRecord> {
    const instances = (await options.store.listEscrowInstances()).filter(
      (instance) => instance.status === "active" && instance.contractVersion === "v3"
    );
    const filtered = instances.filter((instance) =>
      (options.chainId === undefined || instance.chainId === options.chainId) &&
      (options.escrowAddress === undefined ||
        instance.escrowAddress.toLowerCase() === options.escrowAddress.toLowerCase())
    );
    if (filtered.length === 0) {
      throw new BindingError(
        503,
        "escrow_instance_unavailable",
        "no active StageEscrowV3 instance is registered for binding",
        { chainId: options.chainId ?? null, escrowAddress: options.escrowAddress ?? null }
      );
    }
    if (filtered.length > 1) {
      throw new BindingError(
        400,
        "escrow_instance_ambiguous",
        "more than one active escrow instance matches; multi-escrow routing is deferred",
        { matches: filtered.map((instance) => `${instance.chainId}:${instance.escrowAddress}`) }
      );
    }
    return filtered[0]!;
  }

  return {
    async createIntent(request) {
      const instance = await resolveInstance();
      const orderId = normalizeOrderId(request.orderId);
      const stageKey = request.stageKey.trim();
      if (stageKey.length === 0) {
        throw new BindingError(400, "invalid_stage_key", "stageKey must be a non-empty string");
      }
      const wallet = normalizeWallet(request.walletAddress, "walletAddress");
      const stageId = canonicalStageId(stageKey);

      const accepted = await options.termsProvider.getAcceptedStageTerms(orderId, stageKey);
      if (!accepted) {
        throw new BindingError(
          404,
          "accepted_terms_not_found",
          "the order stage has no accepted terms; invite/accept must finish first",
          { orderId, stageKey }
        );
      }
      if (normalizeWallet(accepted.payer, "acceptedTerms.payer") !== wallet) {
        throw new BindingError(
          403,
          "deposit_not_payer",
          "only the accepted payer may authorize a deposit for this stage",
          { orderId, stageKey }
        );
      }
      const recomputedTermsHash = hashCanonicalJson(accepted.stageTerms, "acceptedTermsHash");
      if (recomputedTermsHash !== normalizeBytes32(accepted.termsHash, "acceptedTerms.termsHash")) {
        throw new BindingError(
          409,
          "accepted_terms_hash_mismatch",
          "the accepted terms hash does not match its canonical stageTerms payload",
          { orderId, stageKey }
        );
      }
      const terms = assertDepositTermsConsistent({
        chainId: instance.chainId,
        escrowAddress: instance.escrowAddress,
        terms: accepted,
        stageKey
      });

      const existingByKey = request.idempotencyKey
        ? await options.store.findDepositIntentByIdempotencyKey(request.idempotencyKey)
        : undefined;
      if (existingByKey) {
        if (
          existingByKey.orderId === orderId &&
          existingByKey.stageId === stageId &&
          existingByKey.termsHash === accepted.termsHash &&
          existingByKey.chainId === instance.chainId &&
          existingByKey.escrowAddress === instance.escrowAddress
        ) {
          if (!intentStillValid(existingByKey, now)) {
            throw new BindingError(
              409,
              "deposit_intent_expired",
              "the stored deposit intent for this idempotency key has expired; request a new intent",
              { intentId: existingByKey.intentId, deadline: existingByKey.deadline }
            );
          }
          return { intent: existingByKey, typedData: existingByKey.typedData, replayed: true };
        }
        throw new BindingError(
          409,
          "idempotency_key_conflict",
          "the idempotency key was already used for a different deposit intent",
          { idempotencyKey: request.idempotencyKey }
        );
      }

      const active = await options.store.findDepositIntentByStage(
        instance.chainId,
        instance.escrowAddress,
        orderId,
        stageId,
        ["active"]
      );
      if (active) {
        const stillValid = intentStillValid(active, now);
        if (stillValid && active.termsHash === accepted.termsHash) {
          return { intent: active, typedData: active.typedData, replayed: true };
        }
        if (stillValid && active.termsHash !== accepted.termsHash) {
          await options.store.updateDepositIntent({
            ...active,
            status: "cancelled",
            updatedAt: now().toISOString()
          });
        } else {
          await options.store.updateDepositIntent({
            ...active,
            status: "expired",
            updatedAt: now().toISOString()
          });
        }
      }

      const payerBinding = await options.store.getTrancheBindingByStage(
        instance.chainId,
        instance.escrowAddress,
        orderId,
        stageId,
        terms.payer
      );
      if (payerBinding) {
        throw new BindingError(
          409,
          "tranche_already_bound",
          "the accepted payer already has a tranche for this order stage",
          { orderId, stageKey, trancheId: payerBinding.trancheId, state: payerBinding.state }
        );
      }
      const canonical = await options.store.findCanonicalBindingByStage(
        instance.chainId,
        instance.escrowAddress,
        orderId,
        stageId
      );
      if (canonical) {
        throw new BindingError(
          409,
          "tranche_already_bound",
          "a canonical tranche is already bound to this order stage",
          { orderId, stageKey, trancheId: canonical.trancheId, state: canonical.state }
        );
      }

      const createdAt = now();
      const deadline = BigInt(Math.floor(createdAt.getTime() / 1000) + ttlSeconds).toString();
      const nonce = normalizeDecimal(nonceFactory(), "nonce");
      const typedData = buildDepositTypedData({
        chainId: instance.chainId,
        escrowAddress: instance.escrowAddress,
        orderId: terms.orderId,
        stageId: terms.stageId,
        payer: terms.payer,
        payee: terms.payee,
        verifier: terms.verifier,
        amount: terms.amount,
        feeBps: terms.feeBps,
        feeRecipient: terms.feeRecipient,
        deadline,
        nonce
      });
      const record: DepositIntentRecord = {
        intentId: idFactory(),
        chainId: instance.chainId,
        escrowAddress: instance.escrowAddress,
        orderId: terms.orderId,
        stageKey,
        stageId: terms.stageId,
        trancheId: terms.trancheId,
        payer: terms.payer,
        payee: terms.payee,
        verifier: terms.verifier,
        amount: terms.amount,
        feeBps: terms.feeBps,
        feeRecipient: terms.feeRecipient,
        termsHash: normalizeBytes32(accepted.termsHash, "acceptedTerms.termsHash"),
        nonce,
        deadline,
        status: "active",
        idempotencyKey: request.idempotencyKey ?? `stage:${instance.chainId}:${instance.escrowAddress}:${orderId}:${stageId}`,
        typedData,
        createdAt: createdAt.toISOString(),
        updatedAt: createdAt.toISOString()
      };
      try {
        await options.store.saveDepositIntent(record);
      } catch (error) {
        if (error instanceof StorageConstraintError) {
          throw new BindingError(
            409,
            "deposit_intent_conflict",
            "a conflicting deposit intent already exists for this stage",
            { orderId, stageKey }
          );
        }
        throw error;
      }
      return { intent: record, typedData, replayed: false };
    },

    async getIntent(intentId) {
      const intent = await options.store.getDepositIntent(intentId);
      return intent ? expireIfNeeded(intent, now) : undefined;
    }
  };
}

function expireIfNeeded(
  intent: DepositIntentRecord,
  now: () => Date
): DepositIntentRecord {
  if (intent.status === "active" && !intentStillValid(intent, now)) {
    return { ...intent, status: "expired" };
  }
  return intent;
}

function intentStillValid(intent: DepositIntentRecord, now: () => Date): boolean {
  let deadline: bigint;
  try {
    deadline = BigInt(intent.deadline);
  } catch {
    return false;
  }
  const nowSeconds = BigInt(Math.floor(now().getTime() / 1000));
  return deadline > nowSeconds;
}

function normalizeDecimal(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (!/^(0|[1-9][0-9]*)$/.test(trimmed) || trimmed === "0") {
    throw new BindingError(500, "invalid_nonce_factory", `${fieldName} factory must return a positive decimal string`);
  }
  return trimmed;
}
