// Time/hook runtime domain: configuration supplies expressions, orders supply
// facts, the runtime only projects and materialises them. It never mutates
// escrow directly and there is deliberately no hard-coded 14d/2d/48h window —
// durations come from the expression string stored as config data.

import type { Address, Hex } from "../shared/types.js";
import { SettlementError } from "../settlement/types.js";
import type { SettlementInstructionKind } from "../settlement/types.js";

export const RUNTIME_ACTION_KINDS = ["execute_transfer", "execute_refund"] as const;
export type RuntimeActionKind = (typeof RUNTIME_ACTION_KINDS)[number];

export const RUNTIME_DUE_STATUSES = [
  "due",
  "signal_submitted",
  "instruction_created",
  "failed"
] as const;
export type RuntimeDueStatus = (typeof RUNTIME_DUE_STATUSES)[number];

export class RuntimeError extends Error {
  override readonly name = "RuntimeError";

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
  }
}

export interface RuntimeRule {
  readonly ruleId: string;
  readonly planId: Hex;
  readonly orderId: Hex;
  readonly stageKey: string;
  readonly name: string;
  readonly expression: string;
  readonly actionKind: RuntimeActionKind;
  readonly payerAmount?: string;
  readonly payeeAmount?: string;
  readonly createdAt: string;
}

export interface RuntimeFact {
  readonly factId: string;
  readonly orderId: Hex;
  readonly stageKey: string;
  readonly signalName: string;
  readonly occurredAt: string;
}

export interface RuntimeDueFact {
  readonly factKey: string;
  readonly planId: Hex;
  readonly orderId: Hex;
  readonly stageKey: string;
  readonly ruleName: string;
  readonly actionKind: RuntimeActionKind;
  readonly sourceFactId: Hex;
  readonly basisFactIds: readonly string[];
  readonly payerAmount?: string;
  readonly payeeAmount?: string;
  readonly dueAt: string;
  readonly status: RuntimeDueStatus;
  readonly signalSubmissionId?: string;
  readonly instructionId?: string;
  readonly errorCode?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RuntimeSignalSubmission {
  readonly submissionId: string;
  readonly factKey: string;
  readonly planId: Hex;
  readonly orderId: Hex;
  readonly stageKey: string;
  readonly signalName: string;
  readonly submitter: Address;
  readonly status: "submitted" | "failed";
  readonly txHash?: Hex;
  readonly errorCode?: string;
  readonly createdAt: string;
}

export interface RuntimeStore {
  saveRule(rule: RuntimeRule): Promise<void>;
  listRules(orderId: string): Promise<readonly RuntimeRule[]>;
  listAllRules(): Promise<readonly RuntimeRule[]>;
  saveDueFact(record: RuntimeDueFact): Promise<void>;
  getDueFact(factKey: string): Promise<RuntimeDueFact | undefined>;
  listDueFacts(orderId: string): Promise<readonly RuntimeDueFact[]>;
  saveSignalSubmission(record: RuntimeSignalSubmission): Promise<void>;
}

export interface RuntimeFactSource {
  listFacts(orderId: string, stageKey?: string): Promise<readonly RuntimeFact[]>;
}

export interface AuthorizedSignalSubmitter {
  submitSignal(input: {
    readonly submitter: Address;
    readonly factKey: string;
    readonly orderId: Hex;
    readonly stageKey: string;
    readonly signalName: string;
  }): Promise<{ readonly txHash?: Hex }>;
}

export interface SettlementInstructionCreator {
  createFromFact(input: {
    readonly planId: Hex;
    readonly orderId: Hex;
    readonly stageKey: string;
    readonly kind: SettlementInstructionKind;
    readonly sourceFactId: Hex;
    readonly payerAmount?: string;
    readonly payeeAmount?: string;
    readonly uvpExecutorAddress: Address;
    readonly executeEligibleAt: string;
  }): Promise<{ readonly instructionId: string }>;
}

export interface UvpTimerPoker {
  poke(input: {
    readonly orderId: Hex;
    readonly stageKey: string;
    readonly kind: string;
    readonly instructionId: string;
  }): Promise<void>;
}

export function runtimeActionToSettlementKind(kind: RuntimeActionKind): SettlementInstructionKind {
  return kind;
}

export const RUNTIME_FACT_KINDS = {
  start: "start",
  verdict_approve: "verdict_approve",
  verdict_reject: "verdict_reject",
  refund_before_start: "refund_before_start",
  refund_after_start: "refund_after_start",
  dispute: "dispute",
  resolve_dispute: "resolve_dispute"
} as const satisfies Readonly<Record<string, SettlementInstructionKind>>;

export type RuntimeFactName = keyof typeof RUNTIME_FACT_KINDS;

export { SettlementError };
