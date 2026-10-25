// Runtime persistence port + in-memory implementation. Rules are config data,
// due facts are derived (one row per order/stage/rule/basis), and signal
// submissions are recorded once per fact key so a crash cannot double-submit.

import { StorageConstraintError } from "../storage/errors.js";
import type {
  RuntimeDueFact,
  RuntimeRule,
  RuntimeSignalSubmission,
  RuntimeStore
} from "./types.js";

export class MemoryRuntimeStore implements RuntimeStore {
  readonly #rules = new Map<string, RuntimeRule>();
  readonly #dueFacts = new Map<string, RuntimeDueFact>();
  readonly #submissions = new Map<string, RuntimeSignalSubmission>();

  async saveRule(rule: RuntimeRule): Promise<void> {
    for (const existing of this.#rules.values()) {
      if (
        existing.orderId === rule.orderId &&
        existing.stageKey === rule.stageKey &&
        existing.name === rule.name &&
        existing.ruleId !== rule.ruleId
      ) {
        throw new StorageConstraintError("runtime rule already exists for this order/stage/name");
      }
    }
    this.#rules.set(rule.ruleId, rule);
  }

  async listRules(orderId: string): Promise<readonly RuntimeRule[]> {
    const normalized = orderId.toLowerCase();
    return [...this.#rules.values()]
      .filter((rule) => rule.orderId === normalized)
      .sort((left, right) =>
        left.stageKey === right.stageKey
          ? left.name.localeCompare(right.name)
          : left.stageKey.localeCompare(right.stageKey)
      );
  }

  async listAllRules(): Promise<readonly RuntimeRule[]> {
    return [...this.#rules.values()].sort((left, right) =>
      left.orderId === right.orderId
        ? left.stageKey.localeCompare(right.stageKey)
        : left.orderId.localeCompare(right.orderId)
    );
  }

  async saveDueFact(record: RuntimeDueFact): Promise<void> {
    const existing = this.#dueFacts.get(record.factKey);
    if (existing && existing.status === "instruction_created") {
      return;
    }
    this.#dueFacts.set(record.factKey, record);
  }

  async getDueFact(factKey: string): Promise<RuntimeDueFact | undefined> {
    return this.#dueFacts.get(factKey);
  }

  async listDueFacts(orderId: string): Promise<readonly RuntimeDueFact[]> {
    const normalized = orderId.toLowerCase();
    return [...this.#dueFacts.values()]
      .filter((fact) => fact.orderId === normalized)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async saveSignalSubmission(record: RuntimeSignalSubmission): Promise<void> {
    for (const existing of this.#submissions.values()) {
      if (existing.factKey === record.factKey) {
        throw new StorageConstraintError("runtime signal submission already exists for this fact");
      }
    }
    this.#submissions.set(record.submissionId, record);
  }
}
