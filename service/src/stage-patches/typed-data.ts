import { encodeAbiParameters, keccak256, recoverTypedDataAddress, stringToHex } from "viem";
import {
  DOCKED_ORDER_LINK_DOMAIN_NAME,
  DOCKED_ORDER_LINK_DOMAIN_VERSION,
  DOCKED_ORDER_LINK_PRIMARY_TYPE,
  STAGE_EXECUTOR_PATCH_DOMAIN_NAME,
  STAGE_EXECUTOR_PATCH_DOMAIN_VERSION,
  STAGE_EXECUTOR_PATCH_PRIMARY_TYPE,
  STAGE_RESOURCE_PATCH_DOMAIN_NAME,
  STAGE_RESOURCE_PATCH_DOMAIN_VERSION,
  STAGE_RESOURCE_PATCH_PRIMARY_TYPE,
  buildDockedOrderLinkTypedData as buildProtocolDockedOrderLinkTypedData,
  hashDockedOrderLinkPayload as hashProtocolDockedOrderLinkPayload,
  recoverDockedOrderLinkSigner as recoverProtocolDockedOrderLinkSigner
} from "@uvp-eth/protocol-bindings";
import { ConfigError, assertHex, normalizeAddress, type Address, type Hex } from "../shared/types.js";
import type {
  DockedOrderLinkTypedData,
  DockedSignalBindingDTO,
  StageExecutorPatchMode,
  StageExecutorPatchTypedData,
  StagePatchTypedDataField,
  StageResourcePatchTypedData
} from "./types.js";

export const STAGE_PATCH_DOMAIN_NAME = STAGE_EXECUTOR_PATCH_DOMAIN_NAME;
export const STAGE_PATCH_DOMAIN_VERSION = STAGE_EXECUTOR_PATCH_DOMAIN_VERSION;
export const EXECUTOR_PATCH_MODE_ASSIGN = stringToHex("assign", { size: 32 }) as Hex;
export const EXECUTOR_PATCH_MODE_HANDOFF = stringToHex("handoff", { size: 32 }) as Hex;
export const EXECUTOR_PATCH_MODE_REPLACEMENT = stringToHex("replacement", { size: 32 }) as Hex;

export const STAGE_EXECUTOR_PATCH_TYPED_DATA_FIELDS = [
  { name: "orderId", type: "bytes32" },
  { name: "selectorStageId", type: "bytes32" },
  { name: "targetStageId", type: "bytes32" },
  { name: "executor", type: "address" },
  { name: "role", type: "bytes32" },
  { name: "executorMetadataHash", type: "bytes32" },
  { name: "mode", type: "bytes32" },
  { name: "previousExecutor", type: "address" },
  { name: "approvalSourceId", type: "bytes32" },
  { name: "approvalSignalId", type: "bytes32" },
  { name: "patchHash", type: "bytes32" },
  { name: "patchNonce", type: "uint256" },
  { name: "metadataURI", type: "string" },
  { name: "selector", type: "address" },
  { name: "deadline", type: "uint256" }
] as const satisfies readonly StagePatchTypedDataField[];

export const STAGE_RESOURCE_PATCH_TYPED_DATA_FIELDS = [
  { name: "orderId", type: "bytes32" },
  { name: "selectorStageId", type: "bytes32" },
  { name: "targetStageId", type: "bytes32" },
  { name: "resourceKey", type: "bytes32" },
  { name: "manifestHash", type: "bytes32" },
  { name: "policyHash", type: "bytes32" },
  { name: "patchHash", type: "bytes32" },
  { name: "patchNonce", type: "uint256" },
  { name: "manifestURI", type: "string" },
  { name: "selector", type: "address" },
  { name: "deadline", type: "uint256" }
] as const satisfies readonly StagePatchTypedDataField[];

export const DOCKED_ORDER_LINK_TYPED_DATA_FIELDS = [
  { name: "localOrderId", type: "bytes32" },
  { name: "selectorStageId", type: "bytes32" },
  { name: "localSourceId", type: "bytes32" },
  { name: "linkedOrderId", type: "bytes32" },
  { name: "linkedPlanId", type: "bytes32" },
  { name: "linkHash", type: "bytes32" },
  { name: "linkNonce", type: "uint256" },
  { name: "signalBindingsHash", type: "bytes32" },
  { name: "metadataURI", type: "string" },
  { name: "selector", type: "address" },
  { name: "deadline", type: "uint256" }
] as const satisfies readonly StagePatchTypedDataField[];

export interface StageExecutorPatchPayload {
  readonly orderId: Hex;
  readonly selectorStageId: Hex;
  readonly targetStageId: Hex;
  readonly executor: Address;
  readonly role: Hex;
  readonly executorMetadataHash: Hex;
  readonly mode: Hex;
  readonly previousExecutor: Address;
  readonly approvalSourceId: Hex;
  readonly approvalSignalId: Hex;
  readonly patchNonce: string;
  readonly metadataURI: string;
}

export interface BuildStageExecutorPatchTypedDataInput extends StageExecutorPatchPayload {
  readonly chainId: number;
  readonly verifyingContract: Address | string;
  readonly patchHash: Hex;
  readonly selector: Address | string;
  readonly deadline: string;
}

export interface StageResourcePatchPayload {
  readonly orderId: Hex;
  readonly selectorStageId: Hex;
  readonly targetStageId: Hex;
  readonly resourceKey: Hex;
  readonly manifestHash: Hex;
  readonly policyHash: Hex;
  readonly patchNonce: string;
  readonly manifestURI: string;
}

export interface BuildStageResourcePatchTypedDataInput extends StageResourcePatchPayload {
  readonly chainId: number;
  readonly verifyingContract: Address | string;
  readonly patchHash: Hex;
  readonly selector: Address | string;
  readonly deadline: string;
}

export interface DockedOrderLinkPayload {
  readonly localOrderId: Hex;
  readonly selectorStageId: Hex;
  readonly localSourceId: Hex;
  readonly linkedOrderId: Hex;
  readonly linkedPlanId: Hex;
  readonly linkNonce: string;
  readonly metadataURI: string;
  readonly signalBindings: readonly DockedSignalBindingDTO[];
}

export interface BuildDockedOrderLinkTypedDataInput extends DockedOrderLinkPayload {
  readonly chainId: number;
  readonly verifyingContract: Address | string;
  readonly linkHash: Hex;
  readonly selector: Address | string;
  readonly deadline: string;
}

const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000" as const;

export function hashStageExecutorPatchPayload(payload: StageExecutorPatchPayload): Hex {
  try {
    return nonZeroHash(
      keccak256(encodeAbiParameters(
        [
          { name: "selectorStageId", type: "bytes32" },
          { name: "targetStageId", type: "bytes32" },
          { name: "executor", type: "address" },
          { name: "role", type: "bytes32" },
          { name: "executorMetadataHash", type: "bytes32" },
          { name: "mode", type: "bytes32" },
          { name: "previousExecutor", type: "address" },
          { name: "approvalSourceId", type: "bytes32" },
          { name: "approvalSignalId", type: "bytes32" },
          { name: "patchNonce", type: "uint256" },
          { name: "metadataURI", type: "string" }
        ],
        [
          payload.selectorStageId,
          payload.targetStageId,
          payload.executor,
          payload.role,
          payload.executorMetadataHash,
          payload.mode,
          payload.previousExecutor,
          payload.approvalSourceId,
          payload.approvalSignalId,
          BigInt(payload.patchNonce),
          payload.metadataURI
        ]
      )),
      "patchHash"
    );
  } catch (error) {
    throw new ConfigError(error instanceof Error ? error.message : "invalid stage executor patch payload");
  }
}

export function hashStageResourcePatchPayload(payload: StageResourcePatchPayload): Hex {
  try {
    return nonZeroHash(
      keccak256(encodeAbiParameters(
        [
          { name: "selectorStageId", type: "bytes32" },
          { name: "targetStageId", type: "bytes32" },
          { name: "resourceKey", type: "bytes32" },
          { name: "manifestHash", type: "bytes32" },
          { name: "policyHash", type: "bytes32" },
          { name: "patchNonce", type: "uint256" },
          { name: "manifestURI", type: "string" }
        ],
        [
          payload.selectorStageId,
          payload.targetStageId,
          payload.resourceKey,
          payload.manifestHash,
          payload.policyHash,
          BigInt(payload.patchNonce),
          payload.manifestURI
        ]
      )),
      "patchHash"
    );
  } catch (error) {
    throw new ConfigError(error instanceof Error ? error.message : "invalid stage resource patch payload");
  }
}

export function hashDockedOrderLinkPayload(payload: DockedOrderLinkPayload): Hex {
  try {
    return nonZeroHash(
      hashProtocolDockedOrderLinkPayload({
        selectorStageId: payload.selectorStageId,
        localSourceId: payload.localSourceId,
        linkedOrderId: payload.linkedOrderId,
        linkedPlanId: payload.linkedPlanId,
        linkNonce: payload.linkNonce,
        metadataURI: payload.metadataURI,
        signalBindings: payload.signalBindings
      }),
      "linkHash"
    );
  } catch (error) {
    throw new ConfigError(error instanceof Error ? error.message : "invalid docked order link payload");
  }
}

export function buildStageExecutorPatchTypedData(input: BuildStageExecutorPatchTypedDataInput): StageExecutorPatchTypedData {
  try {
    return {
      domain: {
        name: STAGE_PATCH_DOMAIN_NAME,
        version: STAGE_PATCH_DOMAIN_VERSION,
        chainId: input.chainId,
        verifyingContract: input.verifyingContract.toLowerCase() as Address
      },
      types: {
        UVPStagePatchModuleStageExecutorPatch: STAGE_EXECUTOR_PATCH_TYPED_DATA_FIELDS
      },
      primaryType: STAGE_EXECUTOR_PATCH_PRIMARY_TYPE,
      message: {
        orderId: input.orderId,
        selectorStageId: input.selectorStageId,
        targetStageId: input.targetStageId,
        executor: input.executor,
        role: input.role,
        executorMetadataHash: input.executorMetadataHash,
        mode: input.mode,
        previousExecutor: input.previousExecutor,
        approvalSourceId: input.approvalSourceId,
        approvalSignalId: input.approvalSignalId,
        patchHash: input.patchHash,
        patchNonce: input.patchNonce,
        metadataURI: input.metadataURI,
        selector: input.selector.toLowerCase() as Address,
        deadline: input.deadline
      }
    };
  } catch (error) {
    throw new ConfigError(error instanceof Error ? error.message : "invalid stage executor patch typed data");
  }
}

export function buildStageResourcePatchTypedData(input: BuildStageResourcePatchTypedDataInput): StageResourcePatchTypedData {
  try {
    return {
      domain: {
        name: STAGE_PATCH_DOMAIN_NAME,
        version: STAGE_PATCH_DOMAIN_VERSION,
        chainId: input.chainId,
        verifyingContract: input.verifyingContract.toLowerCase() as Address
      },
      types: {
        UVPStagePatchModuleStageResourcePatch: STAGE_RESOURCE_PATCH_TYPED_DATA_FIELDS
      },
      primaryType: STAGE_RESOURCE_PATCH_PRIMARY_TYPE,
      message: {
        orderId: input.orderId,
        selectorStageId: input.selectorStageId,
        targetStageId: input.targetStageId,
        resourceKey: input.resourceKey,
        manifestHash: input.manifestHash,
        policyHash: input.policyHash,
        patchHash: input.patchHash,
        patchNonce: input.patchNonce,
        manifestURI: input.manifestURI,
        selector: input.selector.toLowerCase() as Address,
        deadline: input.deadline
      }
    };
  } catch (error) {
    throw new ConfigError(error instanceof Error ? error.message : "invalid stage resource patch typed data");
  }
}

export function buildDockedOrderLinkTypedData(input: BuildDockedOrderLinkTypedDataInput): DockedOrderLinkTypedData {
  try {
    return buildProtocolDockedOrderLinkTypedData({
      chainId: input.chainId,
      verifyingContract: input.verifyingContract,
      localOrderId: input.localOrderId,
      selectorStageId: input.selectorStageId,
      localSourceId: input.localSourceId,
      linkedOrderId: input.linkedOrderId,
      linkedPlanId: input.linkedPlanId,
      linkHash: input.linkHash,
      linkNonce: input.linkNonce,
      metadataURI: input.metadataURI,
      signalBindings: input.signalBindings,
      selector: input.selector,
      deadline: input.deadline
    }) as DockedOrderLinkTypedData;
  } catch (error) {
    throw new ConfigError(error instanceof Error ? error.message : "invalid docked order link typed data");
  }
}

export async function recoverStageExecutorPatchSigner(
  typedData: StageExecutorPatchTypedData,
  signature: Hex | string
): Promise<Address> {
  const recovered = await recoverTypedDataAddress({
    domain: typedData.domain,
    types: typedData.types,
    primaryType: typedData.primaryType,
    message: typedData.message,
    signature: normalizeSignature(signature)
  });
  return normalizeAddress(recovered, "recoveredSelector");
}

export async function recoverStageResourcePatchSigner(
  typedData: StageResourcePatchTypedData,
  signature: Hex | string
): Promise<Address> {
  const recovered = await recoverTypedDataAddress({
    domain: typedData.domain,
    types: typedData.types,
    primaryType: typedData.primaryType,
    message: typedData.message,
    signature: normalizeSignature(signature)
  });
  return normalizeAddress(recovered, "recoveredSelector");
}

export async function recoverDockedOrderLinkSigner(
  typedData: DockedOrderLinkTypedData,
  signature: Hex | string
): Promise<Address> {
  return recoverProtocolDockedOrderLinkSigner(typedData, signature);
}

export function hashResourceManifest(manifest: unknown): Hex {
  return nonZeroHash(keccak256(stringToHex(stableJson(manifest))), "manifestHash");
}

export function normalizeSignature(value: Hex | string): Hex {
  assertHex(value, "signature");
  if (!/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new ConfigError("signature must be a non-empty 0x-prefixed hex string");
  }
  return value.toLowerCase() as Hex;
}

export function signatureHashFor(signature: Hex): Hex {
  return keccak256(signature);
}

export function executorPatchModeHash(mode: StageExecutorPatchMode): Hex {
  switch (mode) {
    case "assign":
      return EXECUTOR_PATCH_MODE_ASSIGN;
    case "handoff":
      return EXECUTOR_PATCH_MODE_HANDOFF;
    case "replacement":
      return EXECUTOR_PATCH_MODE_REPLACEMENT;
  }
}

function nonZeroHash(value: Hex, fieldName: string): Hex {
  if (value === ZERO_BYTES32) {
    throw new ConfigError(`${fieldName} must not be zero`);
  }
  return value;
}

export function textHash(value: string): Hex {
  return keccak256(stringToHex(value));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
