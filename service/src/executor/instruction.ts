// Generic executor instruction: profileId + opaque actionKey + typed args +
// profile-declared signer roles + closed amountRule. No business action names.

import { randomUUID } from "node:crypto";
import { hashTypedData, keccak256, recoverTypedDataAddress, stringToHex } from "viem";
import { hashCanonicalJson } from "../shared/canonical-json.js";
import { normalizeAddress, normalizeBytes32, type Address, type Hex } from "../shared/types.js";
import {
  executorAction,
  type ExecutorAmountRule,
  type ExecutorProfileV1,
} from "./profile.js";

export const EXECUTOR_INSTRUCTION_STATUSES = [
  "unsigned",
  "partially_signed",
  "ready",
  "submitted",
  "confirmed",
  "failed",
  "unknown",
] as const;
export type ExecutorInstructionStatus = (typeof EXECUTOR_INSTRUCTION_STATUSES)[number];

export interface ExecutorSigner {
  readonly role: string;
  readonly address: Address;
}

export interface ExecutorSignature {
  readonly role: string;
  readonly signer: Address;
  readonly signature: Hex;
}

export interface ExecutorInstructionRecord {
  readonly instructionId: string;
  readonly profileId: string;
  readonly targetAddress: Address;
  readonly chainId: number;
  readonly orderId: Hex;
  readonly stageKey: string;
  readonly stageId: Hex;
  readonly actionKey: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly argsHash: Hex;
  readonly requiredSigners: readonly string[];
  readonly signers: readonly ExecutorSigner[];
  readonly amountRule: ExecutorAmountRule;
  readonly payerAmount: string;
  readonly payeeAmount: string;
  readonly sourceFactId: Hex;
  readonly instructionRef: Hex;
  readonly nonce: string;
  readonly deadline: string;
  readonly signatures: readonly ExecutorSignature[];
  readonly status: ExecutorInstructionStatus;
  readonly txHash?: Hex;
  readonly errorCode?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateExecutorInstructionInput {
  readonly profile: ExecutorProfileV1;
  readonly targetAddress: Address;
  readonly chainId: number;
  readonly orderId: string;
  readonly stageKey: string;
  readonly stageId?: string;
  readonly actionKey: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly signers: Readonly<Record<string, string>>;
  readonly payerAmount?: string;
  readonly payeeAmount?: string;
  readonly sourceFactId: string;
  readonly instructionRef: string;
  readonly nonce: string;
  readonly deadline: string;
}

export interface ExecutorInstructionStore {
  save(record: ExecutorInstructionRecord): Promise<void>;
  get(instructionId: string): Promise<ExecutorInstructionRecord | undefined>;
  listByOrder(orderId: string, limit: number): Promise<readonly ExecutorInstructionRecord[]>;
}

export class MemoryExecutorInstructionStore implements ExecutorInstructionStore {
  readonly #records = new Map<string, ExecutorInstructionRecord>();

  async save(record: ExecutorInstructionRecord): Promise<void> {
    this.#records.set(record.instructionId, record);
  }

  async get(instructionId: string): Promise<ExecutorInstructionRecord | undefined> {
    return this.#records.get(instructionId);
  }

  async listByOrder(orderId: string, limit: number): Promise<readonly ExecutorInstructionRecord[]> {
    return [...this.#records.values()]
      .filter((record) => record.orderId === orderId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .slice(0, limit);
  }
}

export function createExecutorInstruction(
  input: CreateExecutorInstructionInput,
  now = new Date(),
): ExecutorInstructionRecord {
  const action = executorAction(input.profile, input.actionKey);
  const signers = action.signers.map((role) => {
    const address = input.signers[role];
    if (typeof address !== "string") {
      throw invalid("executor_signers_missing", `signer role ${role} is required by action ${action.key}`);
    }
    return { role, address: normalizeAddress(address, `signers.${role}`) };
  });
  const argsHash = hashCanonicalJson(input.args, "argsHash");
  const timestamp = now.toISOString();
  return {
    instructionId: `xinst_${randomUUID()}`,
    profileId: input.profile.profileId,
    targetAddress: normalizeAddress(input.targetAddress, "targetAddress"),
    chainId: input.chainId,
    orderId: normalizeBytes32(input.orderId, "orderId"),
    stageKey: input.stageKey,
    stageId: input.stageId !== undefined
      ? normalizeBytes32(input.stageId, "stageId")
      : keccak256(stringToHex(input.stageKey)),
    actionKey: action.key,
    args: input.args,
    argsHash,
    requiredSigners: action.signers,
    signers,
    amountRule: action.amountRule,
    payerAmount: normalizeAmount(input.payerAmount, "payerAmount"),
    payeeAmount: normalizeAmount(input.payeeAmount, "payeeAmount"),
    sourceFactId: normalizeBytes32(input.sourceFactId, "sourceFactId"),
    instructionRef: normalizeBytes32(input.instructionRef, "instructionRef"),
    nonce: input.nonce,
    deadline: input.deadline,
    signatures: [],
    status: action.signers.length === 0 ? "ready" : "unsigned",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export const EXECUTOR_INSTRUCTION_DOMAIN = { name: "UVPExecutorProfile", version: "1" } as const;

export const EXECUTOR_INSTRUCTION_TYPES = {
  UVPExecutorInstruction: [
    { name: "profileId", type: "string" },
    { name: "actionKey", type: "string" },
    { name: "argsHash", type: "bytes32" },
    { name: "payerAmount", type: "uint256" },
    { name: "payeeAmount", type: "uint256" },
    { name: "sourceFactId", type: "bytes32" },
    { name: "instructionRef", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
} as const;

export function executorInstructionTypedData(record: ExecutorInstructionRecord) {
  return {
    domain: {
      name: EXECUTOR_INSTRUCTION_DOMAIN.name,
      version: EXECUTOR_INSTRUCTION_DOMAIN.version,
      chainId: record.chainId,
      verifyingContract: record.targetAddress,
    },
    types: EXECUTOR_INSTRUCTION_TYPES,
    primaryType: "UVPExecutorInstruction" as const,
    message: {
      profileId: record.profileId,
      actionKey: record.actionKey,
      argsHash: record.argsHash,
      payerAmount: record.payerAmount,
      payeeAmount: record.payeeAmount,
      sourceFactId: record.sourceFactId,
      instructionRef: record.instructionRef,
      nonce: record.nonce,
      deadline: record.deadline,
    },
  };
}

export async function addExecutorSignature(
  record: ExecutorInstructionRecord,
  input: { readonly role: string; readonly signature: Hex },
): Promise<ExecutorInstructionRecord> {
  if (!record.requiredSigners.includes(input.role)) {
    throw invalid("executor_signer_role_not_required", `role ${input.role} is not required by profile action`);
  }
  const signer = record.signers.find((candidate) => candidate.role === input.role);
  if (!signer) {
    throw invalid("executor_signers_missing", `signer address for role ${input.role} is missing`);
  }
  const signature = input.signature;
  const expectedAddress = signer.address;
  const recovered = await recoverTypedDataAddress({
    ...executorInstructionTypedData(record),
    signature,
  } as never);
  if (normalizeAddress(recovered, "recovered") !== expectedAddress) {
    throw invalid("executor_signature_mismatch", "signature does not recover to the declared signer");
  }
  const signatures = [
    ...record.signatures.filter((candidate) => candidate.role !== input.role),
    { role: input.role, signer: signer.address, signature },
  ];
  const ready = record.requiredSigners.every((role) => signatures.some((candidate) => candidate.role === role));
  return {
    ...record,
    signatures,
    status: ready ? "ready" : "partially_signed",
    updatedAt: new Date().toISOString(),
  };
}

export function executorTypedDataHash(record: ExecutorInstructionRecord): Hex {
  return hashTypedData(executorInstructionTypedData(record) as never);
}

function normalizeAmount(value: string | undefined, fieldName: string): string {
  const normalized = value ?? "0";
  if (!/^(0|[1-9][0-9]*)$/.test(normalized)) {
    throw invalid("executor_amount_invalid", `${fieldName} must be a base-10 non-negative integer string`);
  }
  return normalized;
}

function invalid(code: string, message: string): Error {
  const error = new Error(message);
  error.name = "ExecutorInstructionError";
  (error as Error & { code: string }).code = code;
  return error;
}
