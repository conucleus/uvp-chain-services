// 信号提交授权：从 config stage 的 senders/slots/signals + 已接受
// stage_slot 绑定 + plan `signalCapabilities`（协议原语）派生候选与授权；
// plan 词表不可用即 503，
// 词表无行即 403——不静默放行。

import type { ConfigBundle, ConfigStage } from "@uvp-eth/product-dto";
import { onchainSignalId } from "@uvp-eth/compiler";
import type { Address, Hex } from "../shared/types.js";
import type { OrderVisibilitySnapshot } from "./service.js";
import { OrderError } from "./types.js";
import type { PlanCapabilityTables } from "../submissions/capability-proofs.js";
import type { VisibilityResolver } from "../visibility/types.js";

export interface SignalCandidate {
  readonly stageKey: string;
  readonly slotKey: string;
  readonly signalName: string;
  readonly signalId: Hex;
  readonly sourceId?: Hex;
  readonly planVerified: boolean;
  readonly taskKind?: "perform_stage" | "verify_stage";
}

export interface SignalServiceOptions {
  readonly visibility: VisibilityResolver;
  readonly loadOrder: (orderId: string) => Promise<OrderVisibilitySnapshot | undefined>;
  readonly loadPlanCapabilities: (planId: Hex) => Promise<PlanCapabilityTables | undefined>;
}

export interface SignalService {
  listCandidates(orderId: string, stageKey: string | undefined, wallet: Address): Promise<readonly SignalCandidate[]>;
  authorize(input: {
    readonly orderId: string;
    readonly stageKey: string;
    readonly wallet: Address;
    readonly signalName: string;
  }): Promise<SignalCandidate>;
}

export function createSignalService(options: SignalServiceOptions): SignalService {
  return {
    async listCandidates(orderId, stageKey, wallet) {
      const { decision, snapshot } = await resolve(options, orderId, stageKey, wallet);
      if (decision.scope === "operator") {
        return [];
      }
      const planTables = await options.loadPlanCapabilities(snapshot.order.planId as Hex);
      const candidates: SignalCandidate[] = [];
      for (const stage of snapshot.stages) {
        if (!decision.stageKeys.has(stage.stageKey)) {
          continue;
        }
        const stageConfig = stageConfigOf(snapshot.config, stage.stageKey);
        if (!stageConfig) {
          continue;
        }
        for (const slot of snapshot.slots.filter(
          (candidate) =>
            candidate.stageKey === stage.stageKey &&
            candidate.status === "accepted" &&
            candidate.wallet?.toLowerCase() === decision.wallet,
        )) {
          for (const signalName of signalNamesForSlot(stageConfig, slot.slotKey)) {
            const signalId = onchainSignalId(signalName);
            const capability = planTables?.signalCapabilities.find(
              (row) => row.stageId.toLowerCase() === stage.stageId.toLowerCase() && row.signalId.toLowerCase() === signalId.toLowerCase(),
            );
            candidates.push({
              stageKey: stage.stageKey,
              slotKey: slot.slotKey,
              signalName,
              signalId,
              ...(capability ? { sourceId: capability.targetSourceId } : {}),
              planVerified: capability !== undefined,
              ...(taskKindForSignal(signalName) !== undefined ? { taskKind: taskKindForSignal(signalName)! } : {}),
            });
          }
        }
      }
      return candidates;
    },

    async authorize(input) {
      const { decision, snapshot } = await resolve(options, input.orderId, input.stageKey, input.wallet);
      const stage = snapshot.stages.find((candidate) => candidate.stageKey === input.stageKey);
      if (!stage) {
        throw new OrderError(404, "stage_not_found", "stage was not found on this order");
      }
      if (decision.scope === "operator") {
        throw new OrderError(403, "visibility_denied", "operator scope cannot submit signals");
      }
      const stageConfig = stageConfigOf(snapshot.config, stage.stageKey);
      if (!stageConfig) {
        throw new OrderError(404, "stage_not_found", "stage config was not found");
      }
      const accepted = snapshot.slots.find(
        (slot) =>
          slot.stageKey === stage.stageKey &&
          slot.status === "accepted" &&
          slot.wallet?.toLowerCase() === decision.wallet,
      );
      if (!accepted) {
        throw new OrderError(403, "wallet_scope_forbidden", "the session wallet has no accepted slot on this stage", {
          stageKey: stage.stageKey,
        });
      }
      if (!signalNamesForSlot(stageConfig, accepted.slotKey).includes(input.signalName)) {
        throw new OrderError(403, "signal_not_allowed", "the config does not allow this slot to send the signal", {
          stageKey: stage.stageKey,
          slotKey: accepted.slotKey,
          signalName: input.signalName,
        });
      }
      const signalId = onchainSignalId(input.signalName);
      const planTables = await options.loadPlanCapabilities(snapshot.order.planId as Hex);
      if (!planTables) {
        throw new OrderError(503, "plan_capability_unavailable", "plan signalCapabilities are not available", {
          retryable: false,
        });
      }
      const capability = planTables.signalCapabilities.find(
        (row) => row.stageId.toLowerCase() === stage.stageId.toLowerCase() && row.signalId.toLowerCase() === signalId.toLowerCase(),
      );
      if (!capability) {
        throw new OrderError(403, "signal_capability_missing", "the plan signalCapabilities do not include this stage signal", {
          stageKey: stage.stageKey,
          signalName: input.signalName,
        });
      }
      return {
        stageKey: stage.stageKey,
        slotKey: accepted.slotKey,
        signalName: input.signalName,
        signalId,
        sourceId: capability.targetSourceId,
        planVerified: true,
        ...(taskKindForSignal(input.signalName) !== undefined ? { taskKind: taskKindForSignal(input.signalName)! } : {}),
      };
    },
  };
}

async function resolve(
  options: SignalServiceOptions,
  orderId: string,
  stageKey: string | undefined,
  wallet: Address,
): Promise<{ readonly decision: Awaited<ReturnType<VisibilityResolver["resolveVisibility"]>>; readonly snapshot: OrderVisibilitySnapshot }> {
  const decision = await options.visibility.resolveVisibility(orderId, stageKey, wallet);
  const snapshot = await options.loadOrder(orderId);
  if (!snapshot) {
    throw new OrderError(404, "order_not_found", "order was not found");
  }
  return { decision, snapshot };
}

function stageConfigOf(config: ConfigBundle, stageKey: string): ConfigStage | undefined {
  return config.stages.find((stage) => stage.key === stageKey);
}

function signalNamesForSlot(stage: ConfigStage, slotKey: string): readonly string[] {
  const names = new Set<string>();
  const declared = (stage.signals ?? []).map((signal) => signal.name);
  for (const sender of stage.senders ?? []) {
    if (typeof sender === "string") {
      if (sender === slotKey) {
        (stage.signals ?? [])
          .filter((signal) => signal.by === undefined || signal.by === slotKey)
          .forEach((signal) => names.add(signal.name));
      }
      continue;
    }
    if (sender.slot !== slotKey) {
      continue;
    }
    const allowed = sender.signals ?? declared;
    allowed.forEach((name) => names.add(name));
  }
  for (const signal of stage.signals ?? []) {
    if (signal.by === slotKey) {
      names.add(signal.name);
    }
  }
  return [...names];
}

function taskKindForSignal(signalName: string): "perform_stage" | "verify_stage" | undefined {
  if (signalName === "str" || signalName === "submitted" || signalName === "completed") {
    return "perform_stage";
  }
  if (signalName === "approved" || signalName === "rejected") {
    return "verify_stage";
  }
  return undefined;
}
