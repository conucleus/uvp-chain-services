import { canonicalStringify, keccak256Hex } from "@uvp-eth/compiler";
import { normalizeBytes32, type Hex } from "../shared/types.js";
import type { GovernanceReviewStatus, GovernanceSubjectType } from "./types.js";

export interface GovernanceReviewHashInput {
  readonly subjectType: GovernanceSubjectType;
  readonly subjectId: string;
  readonly status: GovernanceReviewStatus;
  readonly riskLevel: string;
  readonly riskTags: readonly string[];
  readonly publicSummary: string;
  readonly metadata?: unknown;
  readonly policy?: unknown;
}

export interface IdentityDescriptorHashInput {
  readonly subjectId: Hex;
  readonly account: string;
  readonly review?: GovernanceReviewHashInput;
  readonly metadata?: unknown;
  /** 供应商档案主体必须进 descriptor 哈希。 */
  readonly profile?: unknown;
  readonly capability?: unknown;
  readonly reputation?: unknown;
}

export function hashGovernanceReviewMetadata(input: GovernanceReviewHashInput): Hex {
  return hashGovernanceCanonicalJson(buildGovernanceReviewMetadataDocument(input), "metadataHash");
}

export function hashGovernanceReviewPolicy(input: GovernanceReviewHashInput): Hex {
  return hashGovernanceCanonicalJson(buildGovernanceReviewPolicyDocument(input), "policyHash");
}

export function hashIdentityDescriptor(input: IdentityDescriptorHashInput): Hex {
  // descriptor 哈希必须覆盖 profile/capability/reputation 全部三块档案，
  // 否则档案可在不改变 descriptorHash 的情况下被替换，链上指纹形同虚设。
  return hashGovernanceCanonicalJson({
    version: 1,
    kind: "identityDescriptor",
    subjectId: input.subjectId,
    account: input.account.toLowerCase(),
    review: input.review ? buildGovernanceReviewMetadataDocument(input.review) : null,
    metadata: input.metadata ?? null,
    profile: input.profile ?? null,
    capability: input.capability ?? null,
    reputation: input.reputation ?? null
  }, "descriptorHash");
}

export function hashRevocationReason(input: {
  readonly subjectType: GovernanceSubjectType;
  readonly subjectId: Hex;
  readonly reason?: string;
  readonly metadata?: unknown;
  readonly review?: GovernanceReviewHashInput;
}): Hex {
  return hashGovernanceCanonicalJson({
    version: 1,
    kind: "revocationReason",
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    reason: input.reason ?? "",
    metadata: input.metadata ?? null,
    review: input.review ? publicReviewHashMaterial(input.review) : null
  }, "reasonHash");
}

export function hashGovernanceCanonicalJson(value: unknown, fieldName: string): Hex {
  return normalizeBytes32(keccak256Hex(canonicalStringify(value)), fieldName);
}

function buildGovernanceReviewMetadataDocument(input: GovernanceReviewHashInput): Record<string, unknown> {
  return {
    version: 1,
    kind: "governanceReviewMetadata",
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    status: input.status,
    riskLevel: input.riskLevel,
    riskTags: [...input.riskTags].sort(),
    publicSummary: input.publicSummary,
    metadata: input.metadata ?? null
  };
}

function buildGovernanceReviewPolicyDocument(input: GovernanceReviewHashInput): Record<string, unknown> {
  return {
    version: 1,
    kind: "governanceReviewPolicy",
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    status: input.status,
    riskLevel: input.riskLevel,
    riskTags: [...input.riskTags].sort(),
    policy: input.policy ?? null
  };
}

function publicReviewHashMaterial(input: GovernanceReviewHashInput): Record<string, unknown> {
  return {
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    status: input.status,
    riskLevel: input.riskLevel,
    riskTags: [...input.riskTags].sort(),
    publicSummary: input.publicSummary
  };
}
