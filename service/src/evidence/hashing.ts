/**
 * Evidence payload 文档构造与 payload hash 编排：业务形状（content/metadata/
 * documentType/order 绑定）归本模块，canonical JSON 与 keccak 哈希单源在
 * @uvp-eth/canonical-json。
 */

import { hashCanonicalJson } from "@uvp-eth/canonical-json";
import { normalizeBytes32, type Hex } from "../shared/types.js";

export interface EvidencePayloadHashInput {
  readonly contentHash: Hex;
  readonly metadataHash: Hex;
  readonly documentType: string;
  readonly orderId?: string;
  readonly draftId?: string;
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

export function buildPayloadHashDocument(input: EvidencePayloadHashInput): EvidencePayloadHashDocument {
  return {
    contentHash: normalizeBytes32(input.contentHash, "payload.contentHash"),
    metadataHash: normalizeBytes32(input.metadataHash, "payload.metadataHash"),
    documentType: input.documentType,
    orderId: input.orderId ?? null,
    ...(input.orderId ? {} : input.draftId ? { draftId: input.draftId } : {}),
    ...(input.taskId ? { taskId: input.taskId } : {}),
    stageIdentifier: input.stageIdentifier
  };
}

export function hashEvidencePayload(input: EvidencePayloadHashInput): Hex {
  return hashCanonicalJson(buildPayloadHashDocument(input));
}
