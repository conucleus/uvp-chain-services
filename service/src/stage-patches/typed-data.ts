import { keccak256, recoverTypedDataAddress, stringToHex } from "viem";
import {
  STAGE_EXECUTOR_PATCH_DOMAIN_NAME,
  STAGE_EXECUTOR_PATCH_DOMAIN_VERSION,
  STAGE_EXECUTOR_PATCH_PRIMARY_TYPE,
  STAGE_EXECUTOR_PATCH_TYPED_DATA_FIELDS as PROTOCOL_STAGE_EXECUTOR_PATCH_TYPED_DATA_FIELDS,
  STAGE_RESOURCE_PATCH_DOMAIN_NAME,
  STAGE_RESOURCE_PATCH_DOMAIN_VERSION,
  STAGE_RESOURCE_PATCH_PRIMARY_TYPE,
  STAGE_RESOURCE_PATCH_TYPED_DATA_FIELDS as PROTOCOL_STAGE_RESOURCE_PATCH_TYPED_DATA_FIELDS,
  hashResourceManifest as hashProtocolResourceManifest,
  hashStageExecutorPatchPayload as hashProtocolStageExecutorPatchPayload,
  hashStageResourcePatchPayload as hashProtocolStageResourcePatchPayload,
  type ResourceManifestV1
} from "@uvp-eth/protocol-bindings";
import {
  EXECUTOR_PATCH_MODE_ASSIGN,
  EXECUTOR_PATCH_MODE_HANDOFF,
  EXECUTOR_PATCH_MODE_REPLACEMENT
} from "../shared/protocol-constants.js";
import { ConfigError, assertHex, normalizeAddress, type Address, type Hex } from "../shared/types.js";
import type {
  StageExecutorPatchMode,
  StageExecutorPatchTypedData,
  StagePatchTypedDataField,
  StageResourcePatchTypedData
} from "./types.js";

export const STAGE_PATCH_DOMAIN_NAME = STAGE_EXECUTOR_PATCH_DOMAIN_NAME;
export const STAGE_PATCH_DOMAIN_VERSION = STAGE_EXECUTOR_PATCH_DOMAIN_VERSION;
export {
  EXECUTOR_PATCH_MODE_ASSIGN,
  EXECUTOR_PATCH_MODE_HANDOFF,
  EXECUTOR_PATCH_MODE_REPLACEMENT
} from "../shared/protocol-constants.js";

// patch 模块的 EIP-712 结构以 planId 开头
// （UVPStagePatchModuleStageExecutorPatch(bytes32 planId,bytes32 orderId,...)）。
// 字段表从 protocol-bindings 导入，禁止本地漂移。
export const STAGE_EXECUTOR_PATCH_TYPED_DATA_FIELDS =
  PROTOCOL_STAGE_EXECUTOR_PATCH_TYPED_DATA_FIELDS;

export const STAGE_RESOURCE_PATCH_TYPED_DATA_FIELDS =
  PROTOCOL_STAGE_RESOURCE_PATCH_TYPED_DATA_FIELDS;


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
  /** 订单所属 plan，签名首字段。 */
  readonly planId: Hex;
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
  /** 订单所属 plan，签名首字段。 */
  readonly planId: Hex;
  readonly chainId: number;
  readonly verifyingContract: Address | string;
  readonly patchHash: Hex;
  readonly selector: Address | string;
  readonly deadline: string;
}



const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000" as const;

export function hashStageExecutorPatchPayload(payload: StageExecutorPatchPayload): Hex {
  // patchHash 口径唯一：preimage 的域常量首槽、字段规范化与 ABI 编码全部以
  // protocol-bindings 为准；本地复制 preimage 会在两栈间产出不同的链上
  // patchHash（签名可恢复但合约校验失败）。这里只做错误面（ConfigError）
  // 与非零守卫。
  try {
    return nonZeroHash(
      hashProtocolStageExecutorPatchPayload(payload),
      "patchHash"
    );
  } catch (error) {
    if (error instanceof ConfigError) {
      throw error;
    }
    throw new ConfigError(error instanceof Error ? error.message : "invalid stage executor patch payload");
  }
}

export function hashStageResourcePatchPayload(payload: StageResourcePatchPayload): Hex {
  // 同上：resource patch 与 executor patch 共用 protocol-bindings 的
  // 域分离 preimage，链上服务不得持有第二种哈希变体。
  try {
    return nonZeroHash(
      hashProtocolStageResourcePatchPayload(payload),
      "patchHash"
    );
  } catch (error) {
    if (error instanceof ConfigError) {
      throw error;
    }
    throw new ConfigError(error instanceof Error ? error.message : "invalid stage resource patch payload");
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
        planId: input.planId,
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
        planId: input.planId,
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


export function hashResourceManifest(manifest: ResourceManifestV1): Hex {
  // manifest hash 必须与 protocol-bindings 的 canonical 实现
  // （带 domain 与 normalization）一致——两栈只维护一种哈希口径，
  // 不做本地变体。
  try {
    return nonZeroHash(
      hashProtocolResourceManifest(manifest),
      "manifestHash",
    );
  } catch (error) {
    throw new ConfigError(
      error instanceof Error ? error.message : "invalid resource manifest",
    );
  }
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
