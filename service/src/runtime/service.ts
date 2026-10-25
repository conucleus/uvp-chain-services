// Time/hook runtime service: evaluates configuration expressions against
// projected facts, then materialises each due fact exactly once by (a) asking
// the authorized submitter for the UVP signal and (b) asking the settlement
// ledger for an instruction. `unknown`/failed facts are never auto-retried;
// escrow is never touched here.

import { randomUUID } from "node:crypto";
import { hashCanonicalJson } from "../shared/canonical-json.js";
import { normalizeBytes32, type Address, type Hex } from "../shared/types.js";
import { evaluateTimeExpression } from "./expression.js";
import type { RuntimeStore } from "./types.js";
import {
  RUNTIME_FACT_KINDS,
  RuntimeError,
  runtimeActionToSettlementKind,
  type RuntimeFactName,
  type AuthorizedSignalSubmitter,
  type RuntimeActionKind,
  type RuntimeDueFact,
  type RuntimeFact,
  type RuntimeFactSource,
  type RuntimeRule,
  type SettlementInstructionCreator,
  type UvpTimerPoker
} from "./types.js";

export interface TimeRuntimeOptions {
  readonly store: RuntimeStore;
  readonly facts: RuntimeFactSource;
  readonly submitter?: AuthorizedSignalSubmitter;
  readonly instructions: SettlementInstructionCreator;
  readonly signalSubmitter?: Address;
  readonly uvpExecutorAddress: Address;
  readonly timerPoker?: UvpTimerPoker;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
}

export interface RuntimeDueFactView {
  readonly factKey: string;
  readonly orderId: Hex;
  readonly stageKey: string;
  readonly ruleName: string;
  readonly actionKind: RuntimeActionKind;
  readonly sourceFactId: Hex;
  readonly payerAmount?: string;
  readonly payeeAmount?: string;
  readonly dueAt: string;
  readonly status: RuntimeDueFact["status"];
  readonly instructionId?: string;
  readonly errorCode?: string;
}

export interface RuntimeProcessSummary {
  readonly orderId: Hex;
  readonly due: number;
  readonly submitted: number;
  readonly instructed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly facts: readonly RuntimeDueFactView[];
}

export interface RuntimeFactInstructionInput {
  readonly planId: string;
  readonly orderId: string;
  readonly stageKey: string;
  readonly factName: RuntimeFactName;
  readonly sourceFactId: string;
  readonly payerAmount?: string;
  readonly payeeAmount?: string;
  readonly idempotencyKey?: string;
}

export interface TimeRuntime {
  dueFacts(orderId: string): Promise<readonly RuntimeDueFactView[]>;
  processOrder(orderId: string): Promise<RuntimeProcessSummary>;
  materializeFact(input: RuntimeFactInstructionInput): Promise<{ readonly instructionId: string }>;
}

export function createTimeRuntime(options: TimeRuntimeOptions): TimeRuntime {
  const now = options.now ?? (() => new Date());
  const idFactory = options.idFactory ?? (() => `rt_${randomUUID()}`);

  async function evaluateOrder(orderId: string): Promise<readonly RuntimeDueFact[]> {
    const normalizedOrderId = normalizeBytes32(orderId, "orderId");
    const rules = await options.store.listRules(normalizedOrderId);
    const facts = await options.facts.listFacts(normalizedOrderId);
    const due: RuntimeDueFact[] = [];
    for (const rule of rules) {
      const stageFacts = facts.filter((fact) => fact.stageKey === rule.stageKey);
      const evaluation = evaluateTimeExpression(rule.expression, stageFacts, now());
      if (!evaluation.value) {
        continue;
      }
      const basisFactIds = [...evaluation.basisFactIds].sort();
      const factKey = hashCanonicalJson({
        kind: "uvp.runtime.due-fact.v1",
        orderId: normalizedOrderId,
        stageKey: rule.stageKey,
        ruleName: rule.name,
        basisFactIds
      }, "factKey");
      const sourceFactId = hashCanonicalJson({
        kind: "uvp.runtime.source-fact.v1",
        orderId: normalizedOrderId,
        stageKey: rule.stageKey,
        ruleName: rule.name,
        basisFactIds
      }, "sourceFactId");
      const existing = await options.store.getDueFact(factKey);
      if (existing) {
        due.push(existing);
        continue;
      }
      const timestamp = now().toISOString();
      const record: RuntimeDueFact = {
        factKey,
        planId: rule.planId,
        orderId: normalizedOrderId,
        stageKey: rule.stageKey,
        ruleName: rule.name,
        actionKind: rule.actionKind,
        sourceFactId,
        basisFactIds,
        ...(rule.payerAmount !== undefined ? { payerAmount: rule.payerAmount } : {}),
        ...(rule.payeeAmount !== undefined ? { payeeAmount: rule.payeeAmount } : {}),
        dueAt: evaluation.dueAt ?? timestamp,
        status: "due",
        createdAt: timestamp,
        updatedAt: timestamp
      };
      await options.store.saveDueFact(record);
      due.push(record);
    }
    return due;
  }

  return {
    async dueFacts(orderId) {
      const due = await evaluateOrder(orderId);
      return due.map(dueFactView);
    },

    async materializeFact(input) {
      const kind = RUNTIME_FACT_KINDS[input.factName];
      if (!kind) {
        throw new RuntimeError(400, "unsupported_runtime_fact", `unsupported runtime fact: ${input.factName}`);
      }
      const created = await options.instructions.createFromFact({
        planId: normalizeBytes32(input.planId, "planId"),
        orderId: normalizeBytes32(input.orderId, "orderId"),
        stageKey: input.stageKey,
        kind,
        sourceFactId: normalizeBytes32(input.sourceFactId, "sourceFactId"),
        ...(input.payerAmount !== undefined ? { payerAmount: input.payerAmount } : {}),
        ...(input.payeeAmount !== undefined ? { payeeAmount: input.payeeAmount } : {}),
        uvpExecutorAddress: options.uvpExecutorAddress,
        executeEligibleAt: now().toISOString()
      });
      return { instructionId: created.instructionId };
    },

    async processOrder(orderId) {
      const normalizedOrderId = normalizeBytes32(orderId, "orderId");
      const due = await evaluateOrder(normalizedOrderId);
      let submitted = 0;
      let instructed = 0;
      let failed = 0;
      let skipped = 0;
      const results: RuntimeDueFactView[] = [];
      for (const original of due) {
        let record = original;
        if (record.status === "instruction_created") {
          skipped += 1;
          results.push(dueFactView(record));
          continue;
        }
        if (record.status === "failed") {
          skipped += 1;
          results.push(dueFactView(record));
          continue;
        }
        try {
          if (record.status === "due" && options.submitter) {
            const submissionId = idFactory();
            await options.submitter.submitSignal({
              submitter: options.signalSubmitter ?? options.uvpExecutorAddress,
              factKey: record.factKey,
              orderId: normalizeBytes32(record.orderId, "orderId"),
              stageKey: record.stageKey,
              signalName: signalNameFor(record)
            });
            const timestamp = now().toISOString();
            await options.store.saveSignalSubmission({
              submissionId,
              factKey: record.factKey,
              planId: normalizeBytes32(record.planId, "planId"),
              orderId: normalizeBytes32(record.orderId, "orderId"),
              stageKey: record.stageKey,
              signalName: signalNameFor(record),
              submitter: options.signalSubmitter ?? options.uvpExecutorAddress,
              status: "submitted",
              createdAt: timestamp
            });
            record = {
              ...record,
              status: "signal_submitted",
              signalSubmissionId: submissionId,
              updatedAt: timestamp
            };
            await options.store.saveDueFact(record);
            submitted += 1;
          }
          const created = await options.instructions.createFromFact({
            planId: normalizeBytes32(record.planId, "planId"),
            orderId: normalizeBytes32(record.orderId, "orderId"),
            stageKey: record.stageKey,
            kind: runtimeActionToSettlementKind(record.actionKind),
            sourceFactId: record.sourceFactId,
            ...(record.payerAmount !== undefined ? { payerAmount: record.payerAmount } : {}),
            ...(record.payeeAmount !== undefined ? { payeeAmount: record.payeeAmount } : {}),
            uvpExecutorAddress: options.uvpExecutorAddress,
            executeEligibleAt: record.dueAt
          });
          if (options.timerPoker) {
            await options.timerPoker.poke({
              orderId: normalizeBytes32(record.orderId, "orderId"),
              stageKey: record.stageKey,
              kind: record.actionKind,
              instructionId: created.instructionId
            });
          }
          record = {
            ...record,
            status: "instruction_created",
            instructionId: created.instructionId,
            updatedAt: now().toISOString()
          };
          await options.store.saveDueFact(record);
          instructed += 1;
        } catch (error) {
          const code = error instanceof RuntimeError || hasCode(error)
            ? (error as { code: string }).code
            : "runtime_materialize_failed";
          record = {
            ...record,
            status: "failed",
            errorCode: code,
            updatedAt: now().toISOString()
          };
          await options.store.saveDueFact(record);
          failed += 1;
        }
        results.push(dueFactView(record));
      }
      return {
        orderId: normalizedOrderId,
        due: due.length,
        submitted,
        instructed,
        failed,
        skipped,
        facts: results
      };
    }
  };
}

function signalNameFor(record: RuntimeDueFact): string {
  return record.ruleName;
}

function dueFactView(record: RuntimeDueFact): RuntimeDueFactView {
  return {
    factKey: record.factKey,
    orderId: record.orderId,
    stageKey: record.stageKey,
    ruleName: record.ruleName,
    actionKind: record.actionKind,
    sourceFactId: record.sourceFactId,
    ...(record.payerAmount !== undefined ? { payerAmount: record.payerAmount } : {}),
    ...(record.payeeAmount !== undefined ? { payeeAmount: record.payeeAmount } : {}),
    dueAt: record.dueAt,
    status: record.status,
    ...(record.instructionId !== undefined ? { instructionId: record.instructionId } : {}),
    ...(record.errorCode !== undefined ? { errorCode: record.errorCode } : {})
  };
}

function hasCode(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && typeof (error as { code: unknown }).code === "string");
}

export type { RuntimeFact };
