// Generic permissionless executor: profile ABI + typed args build calldata;
// optional generic UVP fact gate (uvp_fact_source) checks the instruction ref
// before broadcasting. No action-key interpretation.

import type { Hex } from "../shared/types.js";
import {
  buildExecutorCalldata,
  executorAction,
  type ExecutorProfileV1,
} from "./profile.js";
import type {
  ExecutorInstructionRecord,
  ExecutorInstructionStore,
} from "./instruction.js";
import { EXECUTOR_INSTRUCTION_DOMAIN, EXECUTOR_INSTRUCTION_TYPES } from "./instruction.js";

export const UVP_FACT_SOURCE_READ_ABI = [
  {
    type: "function",
    name: "expectedInstructionRef",
    stateMutability: "view",
    inputs: [
      { name: "orderId", type: "bytes32" },
      { name: "stageId", type: "bytes32" },
    ],
    outputs: [{ name: "", type: "bytes32" }],
  },
] as const;

export interface ExecutorFactReader {
  expectedInstructionRef(orderId: Hex, stageId: Hex): Promise<Hex>;
}

export interface ExecutorChainAdapter {
  send(input: {
    readonly chainId: number;
    readonly to: `0x${string}`;
    readonly data: `0x${string}`;
  }): Promise<{ readonly txHash: Hex; readonly status: "success" | "reverted" }>;
}

export interface ExecutorRunResult {
  readonly instructionId: string;
  readonly status: ExecutorInstructionRecord["status"];
  readonly txHash?: Hex;
  readonly errorCode?: string;
}

export interface ExecutorOptions {
  readonly profiles: readonly ExecutorProfileV1[];
  readonly store: ExecutorInstructionStore;
  readonly adapter: ExecutorChainAdapter;
  readonly factReader?: ExecutorFactReader;
  readonly now?: () => Date;
}

export function createExecutor(options: ExecutorOptions) {
  const now = options.now ?? (() => new Date());

  async function run(instructionId: string): Promise<ExecutorRunResult> {
    const record = await options.store.get(instructionId);
    if (!record) {
      return { instructionId, status: "unknown", errorCode: "instruction_not_found" };
    }
    if (record.status !== "ready") {
      return { instructionId, status: record.status, errorCode: "instruction_not_ready" };
    }
    const profile = options.profiles.find((candidate) => candidate.profileId === record.profileId);
    if (!profile) {
      return finish(record, "failed", "executor_profile_unknown");
    }
    const action = executorAction(profile, record.actionKey);
    if (action.factGate === "uvp_fact_source") {
      if (!options.factReader) {
        return finish(record, "failed", "executor_fact_source_unavailable");
      }
      const expectedRef = await options.factReader.expectedInstructionRef(record.orderId, record.stageId)
        .catch(() => undefined);
      if (expectedRef === undefined || expectedRef.toLowerCase() !== record.instructionRef.toLowerCase()) {
        return finish(record, "failed", "executor_fact_gate_rejected");
      }
    }
    const call = buildExecutorCalldata({
      profile,
      actionKey: record.actionKey,
      args: record.args,
      targetAddress: record.targetAddress,
    });
    const sent = await options.adapter.send({ chainId: record.chainId, to: call.to, data: call.data });
    return finish(
      { ...record, txHash: sent.txHash, updatedAt: now().toISOString() },
      sent.status === "success" ? "submitted" : "failed",
      sent.status === "success" ? undefined : "executor_tx_reverted",
    );
  }

  async function finish(
    record: ExecutorInstructionRecord,
    status: ExecutorInstructionRecord["status"],
    errorCode: string | undefined,
  ): Promise<ExecutorRunResult> {
    const updated = {
      ...record,
      status,
      updatedAt: now().toISOString(),
      ...(errorCode !== undefined ? { errorCode } : {}),
    };
    await options.store.save(updated);
    return {
      instructionId: record.instructionId,
      status,
      ...(updated.txHash !== undefined ? { txHash: updated.txHash } : {}),
      ...(errorCode !== undefined ? { errorCode } : {}),
    };
  }

  return { run };
}

/** Runtime mapping is config data: exact fact/time name → actionKey. */
export function runtimeActionFor(
  profile: ExecutorProfileV1,
  match: string,
): string | undefined {
  return profile.runtime?.find((entry) => entry.match === match)?.actionKey;
}

export { EXECUTOR_INSTRUCTION_DOMAIN, EXECUTOR_INSTRUCTION_TYPES };
