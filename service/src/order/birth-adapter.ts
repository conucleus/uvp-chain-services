// outside-trigger 出生适配器：用 UVPStateMachine 的 triggerOrderFromOutsideFor
// 原语（出生签名必须由 plan 承诺的 birthAuthorizer 签；creator=买方）。
// 无广播实现时只做协议精确校验并返回派生 orderId（status=unknown），
// 不声称链上成功；广播结果只按 adapter 回报的 tx/status 落库。

import {
  buildTriggerOrderFromOutsideForCall,
  buildTriggerOrderFromOutsideTypedData,
  deriveTriggerOrderId,
  recoverTriggerOrderFromOutsideSigner,
  type SignalAuthorizationPayload,
  type TriggerOrderFromOutsideForCall,
  type TriggerOrderFromOutsideTypedData,
} from "@uvp-eth/protocol-bindings";
import { keccak256, stringToHex } from "viem";
import type { Address, Hex } from "../shared/types.js";
import type { OrderBirthInput, OrderBirthPort, OrderBirthResult } from "./ports.js";
import { OrderError } from "./types.js";

export interface ProtocolOrderBirthBroadcastResult {
  readonly status?: "confirmed" | "submitted" | "unknown";
  readonly txHash?: Hex;
}

export interface ProtocolOrderBirthAdapterOptions {
  readonly triggerSigner?: (typedData: TriggerOrderFromOutsideTypedData) => Promise<Hex>;
  readonly broadcast?: (
    call: TriggerOrderFromOutsideForCall,
    typedData: TriggerOrderFromOutsideTypedData,
    signature: Hex,
  ) => Promise<ProtocolOrderBirthBroadcastResult>;
    readonly onBroadcastError?: (error: unknown) => void;
}

export class ProtocolOrderBirthAdapter implements OrderBirthPort {
  readonly #triggerSigner: ProtocolOrderBirthAdapterOptions["triggerSigner"];
  readonly #broadcast: ProtocolOrderBirthAdapterOptions["broadcast"];
  readonly #onBroadcastError: ProtocolOrderBirthAdapterOptions["onBroadcastError"];

  constructor(options: ProtocolOrderBirthAdapterOptions = {}) {
    this.#triggerSigner = options.triggerSigner;
    this.#broadcast = options.broadcast;
    this.#onBroadcastError = options.onBroadcastError;
  }

  async birthOrder(input: OrderBirthInput): Promise<OrderBirthResult> {
    const deadline = Math.floor(Date.parse(input.deadline) / 1000);
    if (!Number.isSafeInteger(deadline) || deadline <= 0) {
      throw new OrderError(422, "invalid_deadline", "finalize authorization deadline is invalid");
    }
    const idempotencyKey = keccak256(
      stringToHex(`uvp.order.birth.v3:${input.draftId}:${input.termsHash}:${input.payloadHash}`),
    );
    const authorizations: readonly SignalAuthorizationPayload[] =
      (input.birth.authorizations ?? []).map((authorization) => ({
        sourceId: authorization.sourceId,
        signalId: authorization.signalId,
        submitter: authorization.submitter,
        role: authorization.role,
        metadataHash: authorization.metadataHash,
      }));
    if (input.birth.attribution === undefined) {
      throw new OrderError(
        503,
        "birth_attribution_missing",
        "capability plan birth requires birth.attribution (stageId + capabilityProof); zero attribution would revert InvalidSignalCapability",
      );
    }
    const birthFactAttribution = input.birth.attribution;
    const typedData = buildTriggerOrderFromOutsideTypedData({
      chainId: input.chainId,
      verifyingContract: input.stateMachine,
      planId: input.planId,
      creator: input.buyerWallet,
      triggerHookId: input.birth.triggerHookId,
      triggerStageId: input.birth.triggerStageId,
      sourceId: input.birth.sourceId,
      signalId: input.birth.signalId,
      payloadHash: input.payloadHash,
      idempotencyKey,
      submitter: input.birth.birthAuthorizer,
      deadline,
      authorizations,
    });
    const signer = this.#triggerSigner;
    if (!signer) {
      throw new OrderError(
        503,
        "birth_signer_unavailable",
        "birth signer (plan birthAuthorizer) is not configured",
      );
    }
    const signature = await signer(typedData);
    const recovered = await recoverTriggerOrderFromOutsideSigner(typedData, signature).catch(() => undefined);
    if (!recovered || recovered !== input.birth.birthAuthorizer) {
      throw new OrderError(
        503,
        "birth_signer_mismatch",
        "birth signature does not recover to the plan birthAuthorizer",
      );
    }
    const orderId = deriveTriggerOrderId(
      input.planId,
      input.birth.sourceId,
      input.birth.signalId,
      input.payloadHash,
    );
    if (!this.#broadcast) {
      return { orderId, stateMachine: input.stateMachine, status: "unknown" };
    }
    try {
      const call = buildTriggerOrderFromOutsideForCall(
        { stateMachineAddress: input.stateMachine, chainId: input.chainId },
        {
          planId: input.planId,
          creator: input.buyerWallet,
          triggerHookId: input.birth.triggerHookId,
          triggerStageId: input.birth.triggerStageId,
          sourceId: input.birth.sourceId,
          signalId: input.birth.signalId,
          payloadHash: input.payloadHash,
          idempotencyKey,
          submitter: input.birth.birthAuthorizer,
          deadline,
          authorizations,
          signature,
          birthFactAttribution,
        },
      );
      const result = await this.#broadcast(call, typedData, signature);
      return {
        orderId,
        stateMachine: input.stateMachine,
        status: result.status ?? (result.txHash ? "submitted" : "unknown"),
        ...(result.txHash !== undefined ? { txHash: result.txHash } : {}),
      };
    } catch (error) {
      if (error instanceof OrderError) {
        throw error;
      }
      this.#onBroadcastError?.(error);
      throw new OrderError(
        503,
        "birth_broadcast_failed",
        "outside-trigger broadcast failed",
        { cause: describeError(error) },
      );
    }
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const details = error as Error & {
      readonly shortMessage?: string;
      readonly details?: string;
      readonly cause?: unknown;
    };
    return [
      details.shortMessage,
      details.details,
      error.message,
      details.cause instanceof Error ? details.cause.message : undefined,
    ].filter((part): part is string => typeof part === "string" && part.length > 0).join(" | ");
  }
  return String(error);
}

export type { Address };
