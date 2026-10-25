// Binding read surface: server-side visibility trimming + projection dataState.
// Buyer reads every stage of the order; an own-stage payee/verifier reads only
// its assigned stages; operator gets a minimal structural view (no wallets or
// amounts); a stranger gets a flat 404. `pending` is returned while the escrow
// projection has no cursor, so "not indexed yet" can never look empty.

import type { Address, Hex } from "../shared/types.js";
import type { BindingStore } from "./store.js";
import {
  BindingError,
  canonicalStageId,
  normalizeOrderId,
  normalizeWallet,
  type BindingDataState,
  type BindingReadResult,
  type BindingScopeResolver,
  type BindingVisibilityScope,
  type TrancheBindingRecord,
  type TrancheBindingView
} from "./types.js";

export interface BindingReadServiceOptions {
  readonly store: BindingStore;
  readonly scopeResolver: BindingScopeResolver;
}

export interface StageBindingReadResult {
  readonly orderId: Hex;
  readonly stageKey: string;
  readonly dataState: BindingDataState;
  readonly binding: TrancheBindingView;
  readonly foreignTrancheCount: number;
}

export interface BindingReadService {
  listOrderBindings(orderId: string, walletAddress: string): Promise<BindingReadResult>;
  getStageBinding(orderId: string, stageKey: string, walletAddress: string): Promise<StageBindingReadResult>;
}

export function createBindingReadService(
  options: BindingReadServiceOptions
): BindingReadService {
  async function resolveScope(orderId: Hex, walletAddress: string): Promise<{
    readonly wallet: Address;
    readonly scope: BindingVisibilityScope;
    readonly dataState: BindingDataState;
  }> {
    const wallet = normalizeWallet(walletAddress, "walletAddress");
    const scope = await options.scopeResolver.resolveBindingScope(orderId, wallet);
    if (scope.kind === "stranger") {
      throw new BindingError(404, "order_not_found", "order not found");
    }
    const dataState = await projectionDataState(options.store);
    return { wallet, scope, dataState };
  }

  return {
    async listOrderBindings(orderId, walletAddress) {
      const normalizedOrderId = normalizeOrderId(orderId);
      const { scope, dataState } = await resolveScope(normalizedOrderId, walletAddress);
      const bindings = await options.store.listTrancheBindingsByOrder(normalizedOrderId);
      const scoped = bindings.filter((binding) =>
        scope.kind === "buyer" ||
        scope.kind === "operator" ||
        scope.stages.has(binding.stageKey)
      );
      const foreignTrancheCount = scoped.filter((binding) => binding.state === "foreign").length;
      const visible = scoped.filter((binding) => binding.state !== "foreign");
      return {
        orderId: normalizedOrderId,
        dataState,
        bindings: visible.map((binding) => bindingView(binding, scope)),
        foreignTrancheCount
      };
    },

    async getStageBinding(orderId, stageKey, walletAddress) {
      const normalizedOrderId = normalizeOrderId(orderId);
      const normalizedStageKey = stageKey.trim();
      if (normalizedStageKey.length === 0) {
        throw new BindingError(400, "invalid_stage_key", "stageKey must be a non-empty string");
      }
      const { scope, dataState } = await resolveScope(normalizedOrderId, walletAddress);
      if (scope.kind === "stage" && !scope.stages.has(normalizedStageKey)) {
        throw new BindingError(
          403,
          "stage_scope_forbidden",
          "this wallet is not a participant of the requested stage",
          { stageKey: normalizedStageKey }
        );
      }
      if (scope.kind === "operator") {
        throw new BindingError(
          403,
          "visibility_denied",
          "operator scope cannot read stage-level tranche details",
          { stageKey: normalizedStageKey }
        );
      }
      const stageId = canonicalStageId(normalizedStageKey);
      const bindings = await options.store.listTrancheBindingsByOrder(normalizedOrderId);
      const stageBindings = bindings.filter(
        (candidate) => candidate.stageKey === normalizedStageKey || candidate.stageId === stageId
      );
      const foreignTrancheCount = stageBindings.filter((binding) => binding.state === "foreign").length;
      const binding = stageBindings
        .filter((candidate) => candidate.state !== "foreign")
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
      if (!binding) {
        throw new BindingError(
          404,
          "binding_not_found",
          "no canonical tranche binding exists for this order stage",
          { orderId: normalizedOrderId, stageKey: normalizedStageKey, dataState, foreignTrancheCount }
        );
      }
      return {
        orderId: normalizedOrderId,
        stageKey: normalizedStageKey,
        dataState,
        binding: bindingView(binding, scope),
        foreignTrancheCount
      };
    }
  };
}

async function projectionDataState(store: BindingStore): Promise<BindingDataState> {
  const instances = (await store.listEscrowInstances()).filter(
    (instance) => instance.status === "active" && instance.contractVersion === "v3"
  );
  if (instances.length === 0) {
    throw new BindingError(
      503,
      "escrow_instance_unavailable",
      "no active StageEscrowV3 instance is registered for binding reads"
    );
  }
  for (const instance of instances) {
    const cursor = await store.getCursor(instance.chainId, instance.escrowAddress);
    if (!cursor) {
      return "pending";
    }
  }
  return "ok";
}

function bindingView(
  binding: TrancheBindingRecord,
  scope: BindingVisibilityScope
): TrancheBindingView {
  const base = {
    bindingId: binding.bindingId,
    orderId: binding.orderId,
    stageKey: binding.stageKey,
    stageId: binding.stageId,
    trancheId: binding.trancheId,
    chainId: binding.chainId,
    escrowAddress: binding.escrowAddress,
    state: binding.state,
    origin: binding.origin,
    updatedAt: binding.updatedAt
  } as const;
  if (scope.kind === "operator") {
    return base;
  }
  return {
    ...base,
    payer: binding.payer,
    payee: binding.payee,
    ...(binding.verifier !== undefined ? { verifier: binding.verifier } : {}),
    amount: binding.amount,
    feeBps: binding.feeBps,
    feeRecipient: binding.feeRecipient,
    ...(binding.depositTxHash !== undefined ? { depositTxHash: binding.depositTxHash } : {}),
    ...(binding.depositBlock !== undefined ? { depositBlock: binding.depositBlock } : {}),
    ...(binding.payerAmount !== undefined ? { payerAmount: binding.payerAmount } : {}),
    ...(binding.payeeAmount !== undefined ? { payeeAmount: binding.payeeAmount } : {}),
    ...(binding.feeAmount !== undefined ? { feeAmount: binding.feeAmount } : {}),
    ...(binding.settledTxHash !== undefined ? { settledTxHash: binding.settledTxHash } : {}),
    ...(binding.instructionRef !== undefined ? { instructionRef: binding.instructionRef } : {})
  };
}
