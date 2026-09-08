import { keccak256Hex } from "@uvp-eth/compiler";
import { canonicalJson, hashCanonicalJson as hashSharedCanonicalJson } from "../shared/canonical-json.js";
import { normalizeBytes32, type Hex } from "../shared/types.js";

export interface EvidencePayloadHashInput {
  readonly contentHash: Hex;
  readonly metadataHash: Hex;
  readonly documentType: string;
  readonly orderId?: string;
  /**
   * 草稿期（orderId 缺失）以 draftId 替代订单成分参与指纹
   * （《证据与存证规则》二.4）。否则同 owner 同内容的不同草稿会得到
   * 同一 payloadHash，被 (owner, payload_hash) 幂等归并互相错记。
   */
  readonly draftId?: string;
  /**
   * 任务维度：同一订单内同内容证据归属不同任务时指纹必须不同，否则
   * (owner, payload_hash) 幂等会把 A 任务的凭证错记到 B 任务名下。
   */
  readonly taskId?: string;
  readonly stageIdentifier: string;
}

export interface EvidencePayloadHashDocument {
  readonly contentHash: Hex;
  readonly metadataHash: Hex;
  readonly documentType: string;
  readonly orderId: string | null;
  readonly draftId?: string;
  readonly taskId?: string;
  readonly stageIdentifier: string;
}

export { canonicalJson };

export function hashEvidenceBytes(bytes: Uint8Array, fieldName = "contentHash"): Hex {
  return normalizeBytes32(keccak256Hex(bytes), fieldName);
}

export function hashCanonicalJson(value: unknown, fieldName: string): Hex {
  return hashSharedCanonicalJson(value, fieldName);
}

export function buildPayloadHashDocument(input: EvidencePayloadHashInput): EvidencePayloadHashDocument {
  return {
    contentHash: normalizeBytes32(input.contentHash, "payload.contentHash"),
    metadataHash: normalizeBytes32(input.metadataHash, "payload.metadataHash"),
    documentType: input.documentType,
    // orderId 与 draftId 至少提供其一（service 侧强制）；两者同给时
    // 订单已存在，以 orderId 为准。订单形态的文档保持原有四元组结构，
    // 草稿形态追加 draftId 成分；taskId 提供时无论订单/草稿形态均入指纹。
    orderId: input.orderId ?? null,
    ...(input.orderId ? {} : input.draftId ? { draftId: input.draftId } : {}),
    ...(input.taskId ? { taskId: input.taskId } : {}),
    stageIdentifier: input.stageIdentifier
  };
}

export function hashEvidencePayload(input: EvidencePayloadHashInput): Hex {
  return hashCanonicalJson(buildPayloadHashDocument(input), "payloadHash");
}
