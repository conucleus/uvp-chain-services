// Executor profile (uvp.executor-profile/v1): business-owned action/ABI data.
// chain-services only validates structure and never interprets action keys.

import { encodeFunctionData, getAbiItem, type Abi } from "viem";
import type { Address } from "../shared/types.js";

export const EXECUTOR_PROFILE_SCHEMA = "uvp.executor-profile/v1" as const;
export const EXECUTOR_AMOUNT_RULES = ["none", "full_pay", "full_refund", "verdict", "split"] as const;
export type ExecutorAmountRule = (typeof EXECUTOR_AMOUNT_RULES)[number];
export type ExecutorFactGate = "uvp_fact_source";

export interface ExecutorActionSpec {
  readonly key: string;
  readonly method: string;
  readonly args: readonly string[];
  readonly signers: readonly string[];
  readonly amountRule: ExecutorAmountRule;
  readonly factGate?: ExecutorFactGate;
}

export interface ExecutorRuntimeMapping {
  readonly match: string;
  readonly actionKey: string;
}

export interface ExecutorProfileV1 {
  readonly schema: typeof EXECUTOR_PROFILE_SCHEMA;
  readonly profileId: string;
  readonly target: {
    readonly kind: "contract";
    readonly addressEnv: string;
    readonly chainIdEnv?: string;
  };
  readonly abi: Abi;
  readonly actions: readonly ExecutorActionSpec[];
  readonly runtime?: readonly ExecutorRuntimeMapping[];
}

export class ExecutorProfileError extends Error {
  override readonly name = "ExecutorProfileError";

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export function parseExecutorProfile(value: unknown): ExecutorProfileV1 {
  const record = requireRecord(value, "executorProfile");
  if (record.schema !== EXECUTOR_PROFILE_SCHEMA) {
    throw invalid(`schema must be ${EXECUTOR_PROFILE_SCHEMA}`);
  }
  const profileId = requireNonEmpty(record.profileId, "profileId");
  const target = requireRecord(record.target, "target");
  if (target.kind !== "contract") {
    throw invalid("target.kind must be contract");
  }
  const addressEnv = requireNonEmpty(target.addressEnv, "target.addressEnv");
  if (target.chainIdEnv !== undefined) {
    requireNonEmpty(target.chainIdEnv, "target.chainIdEnv");
  }
  if (!Array.isArray(record.abi) || record.abi.length === 0) {
    throw invalid("abi must be a non-empty array");
  }
  const abi = record.abi as Abi;
  if (!Array.isArray(record.actions) || record.actions.length === 0) {
    throw invalid("actions must be a non-empty array");
  }
  const keys = new Set<string>();
  const actions: ExecutorActionSpec[] = record.actions.map((entry, index) => {
    const action = requireRecord(entry, `actions[${index}]`);
    const key = requireNonEmpty(action.key, `actions[${index}].key`);
    if (keys.has(key)) {
      throw invalid(`duplicate action key ${key}`);
    }
    keys.add(key);
    const method = requireNonEmpty(action.method, `actions[${index}].method`);
    const args = parseStringArray(action.args, `actions[${index}].args`);
    const signers = parseStringArray(action.signers ?? [], `actions[${index}].signers`);
    if (new Set(signers).size !== signers.length) {
      throw invalid(`actions[${index}].signers must be unique`);
    }
    const amountRule = action.amountRule ?? "none";
    if (!EXECUTOR_AMOUNT_RULES.includes(amountRule as ExecutorAmountRule)) {
      throw invalid(`actions[${index}].amountRule must be one of ${EXECUTOR_AMOUNT_RULES.join("|")}`);
    }
    const factGate = action.factGate;
    if (factGate !== undefined && factGate !== "uvp_fact_source") {
      throw invalid(`actions[${index}].factGate must be uvp_fact_source`);
    }
    assertMethodShape(abi, method, args, index);
    return {
      key,
      method,
      args,
      signers,
      amountRule: amountRule as ExecutorAmountRule,
      ...(factGate !== undefined ? { factGate: factGate as ExecutorFactGate } : {}),
    };
  });
  const runtime = record.runtime === undefined
    ? undefined
    : parseRuntimeMappings(record.runtime, keys);
  return {
    schema: EXECUTOR_PROFILE_SCHEMA,
    profileId,
    target: {
      kind: "contract",
      addressEnv,
      ...(target.chainIdEnv !== undefined ? { chainIdEnv: target.chainIdEnv as string } : {}),
    },
    abi,
    actions,
    ...(runtime !== undefined ? { runtime } : {}),
  };
}

export function executorAction(profile: ExecutorProfileV1, actionKey: string): ExecutorActionSpec {
  const action = profile.actions.find((candidate) => candidate.key === actionKey);
  if (!action) {
    throw new ExecutorProfileError(422, "executor_action_unknown", `action ${actionKey} is not declared by profile ${profile.profileId}`);
  }
  return action;
}

export function resolveRuntimeActionKey(
  profile: ExecutorProfileV1,
  match: string,
): string | undefined {
  return profile.runtime?.find((entry) => entry.match === match)?.actionKey;
}

export function buildExecutorCalldata(input: {
  readonly profile: ExecutorProfileV1;
  readonly actionKey: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly targetAddress: Address;
}): { readonly to: Address; readonly data: `0x${string}` } {
  const action = executorAction(input.profile, input.actionKey);
  const functionAbi = getAbiItem({ abi: input.profile.abi, name: action.method });
  if (!functionAbi || functionAbi.type !== "function") {
    throw new ExecutorProfileError(503, "executor_profile_invalid", `method ${action.method} is not a function in profile ABI`);
  }
  const ordered: unknown[] = [];
  for (const parameter of functionAbi.inputs) {
    if (parameter.name === undefined || parameter.name.length === 0) {
      throw new ExecutorProfileError(503, "executor_profile_invalid", `method ${action.method} has an unnamed input`);
    }
    if (!(parameter.name in input.args)) {
      throw new ExecutorProfileError(422, "executor_args_missing", `arg ${parameter.name} is required for ${action.method}`);
    }
    ordered.push(input.args[parameter.name]);
  }
  for (const key of Object.keys(input.args)) {
    if (!functionAbi.inputs.some((parameter) => parameter.name === key)) {
      throw new ExecutorProfileError(422, "executor_args_unknown", `arg ${key} is not declared for ${action.method}`);
    }
  }
  const data = encodeFunctionData({
    abi: input.profile.abi,
    functionName: action.method,
    args: ordered,
  });
  return { to: input.targetAddress, data };
}

function assertMethodShape(abi: Abi, method: string, args: readonly string[], index: number): void {
  const item = getAbiItem({ abi, name: method });
  if (!item || item.type !== "function") {
    throw invalid(`actions[${index}].method ${method} is not a function in abi`);
  }
  const parameterNames = item.inputs.map((parameter) => parameter.name);
  if (parameterNames.length !== args.length) {
    throw invalid(`actions[${index}].args must cover every ${method} input`);
  }
  for (let argIndex = 0; argIndex < args.length; argIndex += 1) {
    if (args[argIndex] !== parameterNames[argIndex]) {
      throw invalid(`actions[${index}].args[${argIndex}] must be ${parameterNames[argIndex]}`);
    }
  }
}

function parseStringArray(value: unknown, fieldName: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw invalid(`${fieldName} must be an array`);
  }
  return value.map((entry, index) => requireNonEmpty(entry, `${fieldName}[${index}]`));
}

function parseRuntimeMappings(
  value: unknown,
  actionKeys: ReadonlySet<string>,
): readonly ExecutorRuntimeMapping[] {
  if (!Array.isArray(value)) {
    throw invalid("runtime must be an array");
  }
  return value.map((entry, index) => {
    const record = requireRecord(entry, `runtime[${index}]`);
    const match = requireNonEmpty(record.match, `runtime[${index}].match`);
    const actionKey = requireNonEmpty(record.actionKey, `runtime[${index}].actionKey`);
    if (!actionKeys.has(actionKey)) {
      throw invalid(`runtime[${index}].actionKey ${actionKey} is not declared`);
    }
    return { match, actionKey };
  });
}

function requireRecord(value: unknown, fieldName: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalid(`${fieldName} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireNonEmpty(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw invalid(`${fieldName} must be a non-empty string`);
  }
  return value;
}

function invalid(message: string): ExecutorProfileError {
  return new ExecutorProfileError(422, "executor_profile_invalid", message);
}
