import { keccak256Hex } from "@uvp-eth/compiler";
import { canonicalJson, hashCanonicalJson as hashSharedCanonicalJson } from "../shared/canonical-json.js";
import { normalizeBytes32, type Hex } from "../shared/types.js";

export interface EvidencePayloadHashInput {
  readonly contentHash: Hex;
  readonly metadataHash: Hex;
  readonly documentType: string;
  readonly orderId?: string;
  readonly stageIdentifier: string;
}

export interface EvidencePayloadHashDocument {
  readonly contentHash: Hex;
  readonly metadataHash: Hex;
  readonly documentType: string;
  readonly orderId: string | null;
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
    orderId: input.orderId ?? null,
    stageIdentifier: input.stageIdentifier
  };
}

export function hashEvidencePayload(input: EvidencePayloadHashInput): Hex {
  return hashCanonicalJson(buildPayloadHashDocument(input), "payloadHash");
}
