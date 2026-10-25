// Runtime wiring: concrete (permissionless) ports for the time/hook runtime.
// Time expressions come from published config (`stage.time[].expr`) and are
// stored as data; no duration constant lives here. Execution remains UVP-gated:
// this module only creates execute_ready instructions and pokes the UVP timer.

import type { ConfigTimeV3 } from "@uvp-eth/product-dto";
import type { BindingStore } from "../binding/store.js";
import type { SettlementLedger } from "../settlement/service.js";
import type { OrderV3Service } from "../order/v3/service.js";
import { noopLogger, type Address, type Hex, type Logger } from "../shared/types.js";
import type { SettlementInstructionCreator, RuntimeFactSource, RuntimeStore, UvpTimerPoker } from "./types.js";

export interface RuntimeFactWiringOptions {
  readonly orderV3Service: OrderV3Service;
}

export function createOrderSnapshotFactSource(
  options: RuntimeFactWiringOptions
): RuntimeFactSource {
  return {
    async listFacts(orderId, stageKey) {
      const snapshot = await options.orderV3Service.loadOrderSnapshotForVisibility(orderId);
      if (!snapshot) {
        return [];
      }
      const facts = [];
      for (const stage of snapshot.stages) {
        if (stageKey !== undefined && stage.stageKey !== stageKey) {
          continue;
        }
        facts.push({
          factId: `stage:${stage.stageKey}:${stage.status}`,
          orderId: snapshot.order.orderId as Hex,
          stageKey: stage.stageKey,
          signalName: stage.status,
          occurredAt: stage.updatedAt,
        });
        for (const slot of snapshot.slots.filter((candidate) => candidate.stageKey === stage.stageKey)) {
          if (slot.status !== "accepted") {
            continue;
          }
          facts.push({
            factId: `slot:${stage.stageKey}:${slot.slotKey}`,
            orderId: snapshot.order.orderId as Hex,
            stageKey: stage.stageKey,
            signalName: `slot_${slot.slotKey}_accepted`,
            occurredAt: slot.acceptedAt ?? slot.updatedAt,
          });
        }
      }
      return facts;
    },
  };
}

export interface BindingInstructionCreatorOptions {
  readonly bindingStore: BindingStore;
  readonly settlementLedger: SettlementLedger;
  readonly loadOrder: (orderId: string) => Promise<{ readonly planId?: string } | undefined>;
}

export function createBindingSettlementInstructionCreator(
  options: BindingInstructionCreatorOptions
): SettlementInstructionCreator {
  return {
    async createFromFact(input) {
      const instances = (await options.bindingStore.listEscrowInstances()).filter(
        (instance) => instance.status === "active" && instance.contractVersion === "v3"
      );
      if (instances.length === 0) {
        throw new Error("no active StageEscrowV3 instance for runtime instruction creation");
      }
      const instance = instances[0]!;
      const bindings = await options.bindingStore.listTrancheBindingsByOrder(input.orderId);
      const binding = bindings.find((candidate) => candidate.stageKey === input.stageKey);
      if (!binding) {
        throw new Error(`no bound tranche for order ${input.orderId} stage ${input.stageKey}`);
      }
      if (binding.state === "foreign" || binding.state === "mismatch") {
        throw new Error(`tranche for stage ${input.stageKey} is not settleable (${binding.state})`);
      }
      const amounts = amountsForKind(input.kind, binding.amount, input.payerAmount, input.payeeAmount);
      const created = await options.settlementLedger.createInstruction({
        chainId: instance.chainId,
        escrowAddress: instance.escrowAddress,
        planId: input.planId,
        orderId: input.orderId,
        stageKey: input.stageKey,
        kind: input.kind,
        payerAmount: amounts.payerAmount,
        payeeAmount: amounts.payeeAmount,
        sourceFactId: input.sourceFactId,
        payer: binding.payer,
        payee: binding.payee,
        ...(binding.verifier !== undefined ? { verifier: binding.verifier } : {}),
        executeEligibleAt: input.executeEligibleAt,
      });
      return { instructionId: created.instruction.instructionId };
    },
  };
}

function amountsForKind(
  kind: string,
  bindingAmount: string,
  payerAmount: string | undefined,
  payeeAmount: string | undefined
): { readonly payerAmount: string; readonly payeeAmount: string } {
  switch (kind) {
    case "execute_transfer":
    case "verdict_approve":
      return { payerAmount: "0", payeeAmount: bindingAmount };
    case "execute_refund":
    case "verdict_reject":
    case "refund_before_start":
      return { payerAmount: bindingAmount, payeeAmount: "0" };
    case "start":
      return { payerAmount: "0", payeeAmount: "0" };
    default:
      if (payerAmount === undefined || payeeAmount === undefined) {
        throw new Error(`instruction kind ${kind} requires explicit payerAmount/payeeAmount`);
      }
      return { payerAmount, payeeAmount };
  }
}

export async function seedRuntimeRulesFromOrder(options: {
  readonly orderV3Service: OrderV3Service;
  readonly store: RuntimeStore;
  readonly orderId: string;
  readonly now?: () => Date;
}): Promise<number> {
  const snapshot = await options.orderV3Service.loadOrderSnapshotForVisibility(options.orderId);
  if (!snapshot) {
    return 0;
  }
  const now = options.now ?? (() => new Date());
  let created = 0;
  for (const stage of snapshot.config.stages) {
    for (const time of stage.time ?? []) {
      const expression = (time as ConfigTimeV3).expr;
      if (!expression) {
        continue;
      }
      const actionKind = runtimeActionForTimeName(time.name);
      await options.store.saveRule({
        ruleId: `${snapshot.order.orderId}:${stage.key}:${time.name}`,
        planId: snapshot.order.planId as Hex,
        orderId: snapshot.order.orderId as Hex,
        stageKey: stage.key,
        name: time.name,
        expression,
        actionKind,
        createdAt: now().toISOString(),
      });
      created += 1;
    }
  }
  return created;
}

function runtimeActionForTimeName(name: string): "execute_transfer" | "execute_refund" {
  return /refund|return/i.test(name) ? "execute_refund" : "execute_transfer";
}

export function createTimerKeeperPoker(options: {
  readonly poke?: () => Promise<unknown>;
  readonly logger?: Logger;
}): UvpTimerPoker {
  const logger = options.logger ?? noopLogger;
  return {
    async poke(input) {
      if (!options.poke) {
        logger.warn("runtime timer poke has no chain transport; timer keeper must be running", {
          orderId: input.orderId,
          instructionId: input.instructionId,
        });
        return;
      }
      await options.poke();
    },
  };
}

export interface RuntimeWorkerOptions {
  readonly runtimeStore: RuntimeStore;
  readonly runtime: {
    processOrder(orderId: string): Promise<unknown>;
  };
  readonly logger?: Logger;
}

export class RuntimeWorker {
  readonly #store: RuntimeStore;
  readonly #runtime: RuntimeWorkerOptions["runtime"];
  readonly #logger: Logger;
  #timer: ReturnType<typeof setInterval> | undefined;
  #running = false;

  constructor(options: RuntimeWorkerOptions) {
    this.#store = options.runtimeStore;
    this.#runtime = options.runtime;
    this.#logger = options.logger ?? noopLogger;
  }

  async runOnce(): Promise<{ readonly orders: number; readonly failed: number }> {
    if (this.#running) {
      return { orders: 0, failed: 0 };
    }
    this.#running = true;
    try {
      const rules = await this.#store.listAllRules();
      const orderIds = [...new Set(rules.map((rule) => rule.orderId))];
      let failed = 0;
      for (const orderId of orderIds) {
        try {
          await this.#runtime.processOrder(orderId);
        } catch (error) {
          failed += 1;
          this.#logger.error("runtime order materialisation failed", {
            orderId,
            message: error instanceof Error ? error.message : "unknown error",
          });
        }
      }
      return { orders: orderIds.length, failed };
    } finally {
      this.#running = false;
    }
  }

  start(intervalMs: number): void {
    if (this.#timer || intervalMs <= 0) {
      return;
    }
    this.#timer = setInterval(() => {
      void this.runOnce().catch((error: unknown) => {
        this.#logger.error("runtime worker tick failed", {
          message: error instanceof Error ? error.message : "unknown error",
        });
      });
    }, intervalMs);
    this.#timer.unref?.();
    this.#logger.info("runtime worker started", { intervalMs });
  }

  async stop(): Promise<void> {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }
}
