// SQLite persistence for runtime rules, derived due facts and one-shot signal
// submissions (migration 0033_binding_settlement_runtime.sql).

import { runSqliteMigrations } from "../storage/migrations.js";
import {
  numberColumn,
  optionalStringColumn,
  rowObject,
  stringColumn
} from "../storage/sqlite-rows.js";
import { openSqliteDatabase, runSqliteWrite, type SqliteDatabase } from "../storage/sqlite.js";
import type { Address, Hex } from "../shared/types.js";
import type { RuntimeStore } from "./types.js";
import {
  RUNTIME_ACTION_KINDS,
  RUNTIME_DUE_STATUSES,
  type RuntimeActionKind,
  type RuntimeDueFact,
  type RuntimeDueStatus,
  type RuntimeRule,
  type RuntimeSignalSubmission
} from "./types.js";

export interface SqliteRuntimeStoreOptions {
  readonly databaseUrl?: string;
  readonly database?: SqliteDatabase;
  readonly migrations?: {
    readonly autoRun?: boolean;
    readonly directory?: string;
  };
}

export class SqliteRuntimeStore implements RuntimeStore {
  readonly #database: SqliteDatabase;
  readonly #ownsDatabase: boolean;

  constructor(options: SqliteRuntimeStoreOptions) {
    if (!options.database && !options.databaseUrl) {
      throw new Error("SqliteRuntimeStore requires database or databaseUrl");
    }
    this.#database = options.database ?? openSqliteDatabase(options.databaseUrl!);
    this.#ownsDatabase = !options.database;
    if (options.migrations?.autoRun === true) {
      runSqliteMigrations({
        database: this.#database,
        ...(options.migrations.directory ? { migrationsDirectory: options.migrations.directory } : {})
      });
    }
  }

  close(): void {
    if (this.#ownsDatabase) {
      this.#database.close();
    }
  }

  async saveRule(rule: RuntimeRule): Promise<void> {
    runSqliteWrite(() => {
      this.#database
        .prepare(
          `INSERT INTO runtime_time_rule (
             rule_id, plan_id, order_id, stage_key, name, expression, action_kind,
             payer_amount, payee_amount, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(order_id, stage_key, name) DO UPDATE SET
             expression = excluded.expression,
             action_kind = excluded.action_kind,
             payer_amount = excluded.payer_amount,
             payee_amount = excluded.payee_amount`
        )
        .run(
          rule.ruleId,
          rule.planId.toLowerCase(),
          rule.orderId.toLowerCase(),
          rule.stageKey,
          rule.name,
          rule.expression,
          rule.actionKind,
          rule.payerAmount ?? null,
          rule.payeeAmount ?? null,
          rule.createdAt
        );
    });
  }

  async listRules(orderId: string): Promise<readonly RuntimeRule[]> {
    return this.#database
      .prepare("SELECT * FROM runtime_time_rule WHERE order_id = ? ORDER BY stage_key, name")
      .all(orderId.toLowerCase())
      .map(ruleRow);
  }

  async listAllRules(): Promise<readonly RuntimeRule[]> {
    return this.#database
      .prepare("SELECT * FROM runtime_time_rule ORDER BY order_id, stage_key, name")
      .all()
      .map(ruleRow);
  }

  async saveDueFact(record: RuntimeDueFact): Promise<void> {
    runSqliteWrite(() => {
      this.#database
        .prepare(
          `INSERT INTO runtime_due_fact (
             fact_key, plan_id, order_id, stage_key, rule_name, action_kind, source_fact_id,
             basis_fact_ids_json, payer_amount, payee_amount, due_at, status,
             signal_submission_id, instruction_id, error_code, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(fact_key) DO UPDATE SET
             status = excluded.status,
             signal_submission_id = excluded.signal_submission_id,
             instruction_id = excluded.instruction_id,
             error_code = excluded.error_code,
             updated_at = excluded.updated_at`
        )
        .run(
          record.factKey,
          record.planId.toLowerCase(),
          record.orderId.toLowerCase(),
          record.stageKey,
          record.ruleName,
          record.actionKind,
          record.sourceFactId,
          JSON.stringify(record.basisFactIds),
          record.payerAmount ?? null,
          record.payeeAmount ?? null,
          record.dueAt,
          record.status,
          record.signalSubmissionId ?? null,
          record.instructionId ?? null,
          record.errorCode ?? null,
          record.createdAt,
          record.updatedAt
        );
    });
  }

  async getDueFact(factKey: string): Promise<RuntimeDueFact | undefined> {
    const row = this.#database.prepare("SELECT * FROM runtime_due_fact WHERE fact_key = ?").get(factKey);
    return row ? dueFactRow(row) : undefined;
  }

  async listDueFacts(orderId: string): Promise<readonly RuntimeDueFact[]> {
    return this.#database
      .prepare("SELECT * FROM runtime_due_fact WHERE order_id = ? ORDER BY created_at ASC")
      .all(orderId.toLowerCase())
      .map(dueFactRow);
  }

  async saveSignalSubmission(record: RuntimeSignalSubmission): Promise<void> {
    runSqliteWrite(() => {
      this.#database
        .prepare(
          `INSERT INTO runtime_signal_submission (
             submission_id, fact_key, plan_id, order_id, stage_key, signal_name, executor,
             status, tx_hash, error_code, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          record.submissionId,
          record.factKey,
          record.planId.toLowerCase(),
          record.orderId.toLowerCase(),
          record.stageKey,
          record.signalName,
          record.submitter.toLowerCase(),
          record.status,
          record.txHash ?? null,
          record.errorCode ?? null,
          record.createdAt
        );
    });
  }
}

function ruleRow(value: unknown): RuntimeRule {
  const row = rowObject(value);
  const payerAmount = optionalStringColumn(row, "payer_amount");
  const payeeAmount = optionalStringColumn(row, "payee_amount");
  return {
    ruleId: stringColumn(row, "rule_id"),
    planId: stringColumn(row, "plan_id") as Hex,
    orderId: stringColumn(row, "order_id") as Hex,
    stageKey: stringColumn(row, "stage_key"),
    name: stringColumn(row, "name"),
    expression: stringColumn(row, "expression"),
    actionKind: actionKind(stringColumn(row, "action_kind")),
    ...(payerAmount !== undefined ? { payerAmount } : {}),
    ...(payeeAmount !== undefined ? { payeeAmount } : {}),
    createdAt: stringColumn(row, "created_at")
  };
}

function dueFactRow(value: unknown): RuntimeDueFact {
  const row = rowObject(value);
  const payerAmount = optionalStringColumn(row, "payer_amount");
  const payeeAmount = optionalStringColumn(row, "payee_amount");
  const signalSubmissionId = optionalStringColumn(row, "signal_submission_id");
  const instructionId = optionalStringColumn(row, "instruction_id");
  const errorCode = optionalStringColumn(row, "error_code");
  return {
    factKey: stringColumn(row, "fact_key"),
    planId: stringColumn(row, "plan_id") as Hex,
    orderId: stringColumn(row, "order_id") as Hex,
    stageKey: stringColumn(row, "stage_key"),
    ruleName: stringColumn(row, "rule_name"),
    actionKind: actionKind(stringColumn(row, "action_kind")),
    sourceFactId: stringColumn(row, "source_fact_id") as Hex,
    basisFactIds: JSON.parse(stringColumn(row, "basis_fact_ids_json")) as string[],
    ...(payerAmount !== undefined ? { payerAmount } : {}),
    ...(payeeAmount !== undefined ? { payeeAmount } : {}),
    dueAt: stringColumn(row, "due_at"),
    status: dueStatus(stringColumn(row, "status")),
    ...(signalSubmissionId !== undefined ? { signalSubmissionId } : {}),
    ...(instructionId !== undefined ? { instructionId } : {}),
    ...(errorCode !== undefined ? { errorCode } : {}),
    createdAt: stringColumn(row, "created_at"),
    updatedAt: stringColumn(row, "updated_at")
  };
}

function actionKind(value: string): RuntimeActionKind {
  if (!(RUNTIME_ACTION_KINDS as readonly string[]).includes(value)) {
    throw new Error(`unknown runtime action kind in storage: ${value}`);
  }
  return value as RuntimeActionKind;
}

function dueStatus(value: string): RuntimeDueStatus {
  if (!(RUNTIME_DUE_STATUSES as readonly string[]).includes(value)) {
    throw new Error(`unknown runtime due status in storage: ${value}`);
  }
  return value as RuntimeDueStatus;
}
