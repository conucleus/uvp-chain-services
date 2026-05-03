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

export interface PlanAttestationHashInput {
  readonly domainId: Hex;
  readonly planId: Hex;
  readonly planHash: Hex;
  readonly artifactHash: Hex;
  readonly review?: GovernanceReviewHashInput;
  readonly metadata?: unknown;
  readonly policy?: unknown;
}

export interface SupplierAttestationHashInput {
  readonly domainId: Hex;
  readonly supplierSubjectId: Hex;
  readonly wallet: string;
  readonly review?: GovernanceReviewHashInput;
  readonly metadata?: unknown;
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

export function hashPlanMetadata(input: PlanAttestationHashInput): Hex {
  return hashGovernanceCanonicalJson({
    version: 1,
    kind: "planAttestationMetadata",
    domainId: input.domainId,
    planId: input.planId,
    planHash: input.planHash,
    artifactHash: input.artifactHash,
    review: input.review ? buildGovernanceReviewMetadataDocument(input.review) : null,
    metadata: input.metadata ?? null
  }, "metadataHash");
}

export function hashPlanPolicy(input: PlanAttestationHashInput): Hex {
  return hashGovernanceCanonicalJson({
    version: 1,
    kind: "planAttestationPolicy",
    domainId: input.domainId,
    planId: input.planId,
    planHash: input.planHash,
    artifactHash: input.artifactHash,
    reviewPolicy: input.review ? buildGovernanceReviewPolicyDocument(input.review) : null,
    policy: input.policy ?? null
  }, "policyHash");
}

export function hashSupplierMetadata(input: SupplierAttestationHashInput): Hex {
  return hashGovernanceCanonicalJson({
    version: 1,
    kind: "supplierAttestationMetadata",
    domainId: input.domainId,
    supplierSubjectId: input.supplierSubjectId,
    wallet: input.wallet.toLowerCase(),
    review: input.review ? buildGovernanceReviewMetadataDocument(input.review) : null,
    metadata: input.metadata ?? null
  }, "metadataHash");
}

export function hashSupplierProfile(input: SupplierAttestationHashInput): Hex {
  return hashGovernanceCanonicalJson({
    version: 1,
    kind: "supplierProfile",
    domainId: input.domainId,
    supplierSubjectId: input.supplierSubjectId,
    wallet: input.wallet.toLowerCase(),
    profile: input.profile ?? input.metadata ?? null,
    review: input.review ? publicReviewHashMaterial(input.review) : null
  }, "profileHash");
}

export function hashSupplierCapability(input: SupplierAttestationHashInput): Hex {
  return hashGovernanceCanonicalJson({
    version: 1,
    kind: "supplierCapability",
    domainId: input.domainId,
    supplierSubjectId: input.supplierSubjectId,
    wallet: input.wallet.toLowerCase(),
    capability: input.capability ?? null
  }, "capabilityHash");
}

export function hashSupplierReputation(input: SupplierAttestationHashInput): Hex {
  return hashGovernanceCanonicalJson({
    version: 1,
    kind: "supplierReputation",
    domainId: input.domainId,
    supplierSubjectId: input.supplierSubjectId,
    wallet: input.wallet.toLowerCase(),
    reputation: input.reputation ?? null,
    risk: input.review ? publicReviewHashMaterial(input.review) : null
  }, "reputationHash");
}

export function hashRevocationReason(input: {
  readonly subjectType: GovernanceSubjectType;
  readonly domainId: Hex;
  readonly subjectId: Hex;
  readonly reason?: string;
  readonly metadata?: unknown;
  readonly review?: GovernanceReviewHashInput;
}): Hex {
  return hashGovernanceCanonicalJson({
    version: 1,
    kind: "revocationReason",
    subjectType: input.subjectType,
    domainId: input.domainId,
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
