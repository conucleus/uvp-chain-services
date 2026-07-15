import { randomUUID } from "node:crypto";
import { ConfigError, normalizeAddress, normalizeBytes32, type Address, type Hex } from "../shared/types.js";
import type { TxReconcileFields } from "../reconcile/status.js";
import {
  createSimulatedGovernanceChainAdapter,
  type GovernanceChainAdapter
} from "./adapter.js";
import {
  hashGovernanceCanonicalJson,
  hashGovernanceReviewMetadata,
  hashGovernanceReviewPolicy,
  hashRevocationReason,
  hashIdentityDescriptor,
  type GovernanceReviewHashInput
} from "./hashing.js";
import { noopAuditSink, type AuditSink } from "../security/audit.js";
import { redactErrorMessage } from "../security/redaction.js";
import { InMemoryGovernanceStore, type GovernanceReviewQuery, type GovernanceStore } from "./store.js";
import type {
  GovernanceBroadcastResultDTO,
  GovernanceChainRequestDTO,
  GovernancePrincipal,
  GovernanceReviewDTO,
  GovernanceReviewResultDTO,
  GovernanceReviewStatus,
  GovernanceSubjectType,
  GovernanceIdentityRegistrationResultDTO,
  GovernanceIdentityRevocationResultDTO,
  GovernanceTxAction,
  GovernanceTxLogDTO,
  PublicGovernanceReviewDTO,
  IdentityTxLogDTO,
  IdentityRegistrationRequestDTO,
  IdentityRevocationRequestDTO
} from "./types.js";

export class GovernanceServiceError extends Error {
  override readonly name = "GovernanceServiceError";

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
  }
}

export interface GovernanceServiceOptions {
  readonly store?: GovernanceStore;
  readonly adapter?: GovernanceChainAdapter;
  readonly now?: () => Date;
  readonly audit?: AuditSink;
}

export interface GovernanceService {
  listReviews(query?: Readonly<Record<string, string | undefined>>): Promise<readonly GovernanceReviewDTO[]>;
  getTxLog(txLogId: string): Promise<GovernanceTxLogDTO | undefined>;
  reviewZhixu(input: unknown, principal: GovernancePrincipal): Promise<GovernanceReviewResultDTO>;
  reviewSupplier(input: unknown, principal: GovernancePrincipal): Promise<GovernanceReviewResultDTO>;
  registerIdentity(input: unknown, principal: GovernancePrincipal): Promise<GovernanceIdentityRegistrationResultDTO>;
  revokeIdentity(input: unknown, principal: GovernancePrincipal): Promise<GovernanceIdentityRevocationResultDTO>;
}

export function createGovernanceService(options: GovernanceServiceOptions = {}): GovernanceService {
  const store = options.store ?? new InMemoryGovernanceStore();
  const adapter = options.adapter ?? createSimulatedGovernanceChainAdapter();
  const now = options.now ?? (() => new Date());
  const audit = options.audit ?? noopAuditSink;

  return {
    async listReviews(query = {}) {
      return store.listReviews(parseReviewQuery(query));
    },

    async getTxLog(txLogId) {
      return store.getTxLog(txLogId);
    },

    async reviewZhixu(input, principal) {
      return saveReview({
        store,
        subjectType: "zhixu",
        input,
        principal,
        now,
        nextReviewId: (subjectId) => nextId("review", subjectId)
      });
    },

    async reviewSupplier(input, principal) {
      return saveReview({
        store,
        subjectType: "supplier",
        input,
        principal,
        now,
        nextReviewId: (subjectId) => nextId("review", subjectId)
      });
    },

    async registerIdentity(input, principal) {
      const record = requireBodyRecord(input);
      const subjectId = requiredBytes32(record, "subjectId");
      const account = requiredAddress(record, "account");
      const review = await resolveReview(store, record, "supplier", subjectId);
      const reviewHash = review ? reviewHashInput(review) : reviewHashInputFromRecord(record, "supplier", subjectId, "approved_for_broadcast");
      assertReviewAllowsIdentityRegistration(reviewHash.status);
      const descriptorInput = {
        subjectId,
        account,
        review: reviewHash,
        ...optionalSupplierHashPayload(record)
      };
      const descriptorHash = hashIdentityDescriptor(descriptorInput);
      const descriptorURI = review?.metadataURI ?? defaultMetadataURI(descriptorHash);
      const request: IdentityRegistrationRequestDTO = {
        kind: "registerIdentity",
        subjectId,
        account,
        descriptorHash,
        descriptorURI,
        ...(review ? { reviewId: review.reviewId } : {})
      };
      const duplicate = await reusableDuplicateIdentityLog(store, "register_identity", request);
      if (duplicate) {
        await auditGovernanceLog(audit, duplicate, "duplicate");
        return { request, broadcast: broadcastFromLog(duplicate), log: duplicate };
      }
      const broadcast = await safeBroadcast(() => broadcastIdentityRegistration(adapter, request));
      const timestamp = now().toISOString();
      const log = identityLog(nextId("identity_log"), "register_identity", request, broadcast, principal, timestamp);
      await store.appendIdentityTxLog(log);
      await auditGovernanceLog(audit, log, auditOutcomeFromBroadcast(broadcast));
      return { request, broadcast, log };
    },

    async revokeIdentity(input, principal) {
      const record = requireBodyRecord(input);
      const subjectId = requiredBytes32(record, "subjectId");
      const bindingId = requiredBytes32(record, "bindingId");
      const review = await markReviewRevoked(store, record, "supplier", subjectId, principal, now);
      const reason = optionalString(record, "reason") ?? optionalString(record, "publicSummary") ?? "governance revocation";
      const reasonHash = hashRevocationReason({
        subjectType: "supplier",
        subjectId,
        reason,
        ...(optionalUnknown(record, "metadata") !== undefined ? { metadata: record.metadata } : {}),
        ...(review ? { review: reviewHashInput(review) } : {})
      });
      const reasonURI = defaultMetadataURI(reasonHash);
      const request: IdentityRevocationRequestDTO = {
        kind: "revokeIdentity",
        bindingId,
        subjectId,
        reasonHash,
        reasonURI,
        ...(review ? { reviewId: review.reviewId } : {})
      };
      const duplicate = await reusableDuplicateIdentityLog(store, "revoke_identity", request);
      if (duplicate) {
        await auditGovernanceLog(audit, duplicate, "duplicate");
        return { request, broadcast: broadcastFromLog(duplicate), log: duplicate };
      }
      const broadcast = await safeBroadcast(() => broadcastIdentityRevocation(adapter, request));
      const timestamp = now().toISOString();
      const log = identityLog(nextId("identity_log"), "revoke_identity", request, broadcast, principal, timestamp);
      await store.appendIdentityTxLog(log);
      await auditGovernanceLog(audit, log, auditOutcomeFromBroadcast(broadcast));
      return { request, broadcast, log };
    }
  };
}

function broadcastIdentityRegistration(
  adapter: GovernanceChainAdapter,
  request: IdentityRegistrationRequestDTO
): Promise<GovernanceBroadcastResultDTO> {
  return adapter.registerIdentity(request);
}

function broadcastIdentityRevocation(
  adapter: GovernanceChainAdapter,
  request: IdentityRevocationRequestDTO
): Promise<GovernanceBroadcastResultDTO> {
  return adapter.revokeIdentity(request);
}

export function toPublicGovernanceReview(review: GovernanceReviewDTO): PublicGovernanceReviewDTO {
  const {
    internalNotes: _internalNotes,
    reviewer: _reviewer,
    ...publicReview
  } = review;
  return publicReview;
}

export function isPubliclyDiscoverableReview(review: Pick<GovernanceReviewDTO, "status">): boolean {
  return review.status === "approved_for_broadcast" || review.status === "approved" || review.status === "restricted";
}

export function isRecommendedReview(review: Pick<GovernanceReviewDTO, "status">): boolean {
  return review.status === "approved_for_broadcast" || review.status === "approved";
}

export function filterPublicGovernanceReviews(
  reviews: readonly GovernanceReviewDTO[]
): readonly PublicGovernanceReviewDTO[] {
  return reviews.filter(isPubliclyDiscoverableReview).map(toPublicGovernanceReview);
}

function saveReview(options: {
  readonly store: GovernanceStore;
  readonly subjectType: GovernanceSubjectType;
  readonly input: unknown;
  readonly principal: GovernancePrincipal;
  readonly now: () => Date;
  readonly nextReviewId: (subjectId: string) => string;
}): Promise<GovernanceReviewResultDTO> {
  return saveReviewFromRecord({
    ...options,
    record: requireBodyRecord(options.input)
  });
}

async function saveReviewFromRecord(options: {
  readonly store: GovernanceStore;
  readonly subjectType: GovernanceSubjectType;
  readonly record: Record<string, unknown>;
  readonly principal: GovernancePrincipal;
  readonly now: () => Date;
  readonly nextReviewId: (subjectId: string) => string;
}): Promise<GovernanceReviewResultDTO> {
  const record = options.record;
  const reviewId = optionalString(record, "reviewId");
  const existing = reviewId ? await options.store.getReview(reviewId) : undefined;
  if (reviewId && !existing) {
    throw new GovernanceServiceError(404, "review_not_found", "review not found");
  }
  if (existing && existing.subjectType !== options.subjectType) {
    throw new GovernanceServiceError(409, "review_subject_type_mismatch", "review subject type cannot change");
  }

  const subjectId = requiredString(record, "subjectId");
  if (existing && existing.subjectId !== subjectId) {
    throw new GovernanceServiceError(409, "review_subject_mismatch", "review subject cannot change");
  }

  const status = requiredReviewStatus(record, "status");
  if (existing && !canTransitionReviewStatus(existing.status, status)) {
    throw new GovernanceServiceError(409, "invalid_review_transition", `${existing.status} cannot transition to ${status}`);
  }

  const riskLevel = optionalString(record, "riskLevel") ?? existing?.riskLevel ?? "unknown";
  const riskTags = optionalStringArray(record, "riskTags") ?? existing?.riskTags ?? [];
  const publicSummary = optionalString(record, "publicSummary") ?? existing?.publicSummary ?? "";
  const internalNotes = optionalString(record, "internalNotes") ?? existing?.internalNotes ?? "";
  const hashInput = reviewHashInputFromFields({
    subjectType: options.subjectType,
    subjectId,
    status,
    riskLevel,
    riskTags,
    publicSummary,
    metadata: optionalUnknown(record, "metadata"),
    policy: optionalUnknown(record, "policy")
  });
  const metadataHash = hashGovernanceReviewMetadata(hashInput);
  const policyHash = hashGovernanceReviewPolicy(hashInput);
  const timestamp = options.now().toISOString();
  const review: GovernanceReviewDTO = {
    reviewId: existing?.reviewId ?? options.nextReviewId(subjectId),
    subjectType: options.subjectType,
    subjectId,
    status,
    riskLevel,
    riskTags,
    publicSummary,
    internalNotes,
    policyHash,
    metadataHash,
    metadataURI: optionalString(record, "metadataURI") ?? existing?.metadataURI ?? defaultMetadataURI(metadataHash),
    reviewer: options.principal.adminId,
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp
  };
  await options.store.putReview(review);
  return {
    review,
    publicReview: toPublicGovernanceReview(review)
  };
}

function canTransitionReviewStatus(from: GovernanceReviewStatus, to: GovernanceReviewStatus): boolean {
  if (from === to) {
    return true;
  }
  switch (from) {
    case "draft":
      return to === "submitted" || to === "approved_for_broadcast" || to === "approved" || to === "restricted" ||
        to === "rejected" || to === "revoked";
    case "submitted":
      return to === "draft" || to === "approved_for_broadcast" || to === "approved" || to === "restricted" ||
        to === "rejected" || to === "revoked";
    case "approved_for_broadcast":
      return to === "restricted" || to === "revoked";
    case "approved":
      return to === "restricted" || to === "revoked";
    case "restricted":
      return to === "approved_for_broadcast" || to === "approved" || to === "rejected" || to === "revoked";
    case "rejected":
      return to === "draft" || to === "submitted" || to === "revoked";
    case "revoked":
      return false;
  }
}

async function resolveReview(
  store: GovernanceStore,
  record: Record<string, unknown>,
  subjectType: GovernanceSubjectType,
  subjectId: string
): Promise<GovernanceReviewDTO | undefined> {
  const reviewId = optionalString(record, "reviewId");
  if (reviewId) {
    const review = await store.getReview(reviewId);
    if (!review) {
      throw new GovernanceServiceError(404, "review_not_found", "review not found");
    }
    if (review.subjectType !== subjectType || review.subjectId !== subjectId) {
      throw new GovernanceServiceError(409, "review_subject_mismatch", "review does not match identity subject");
    }
    return review;
  }
  return store.findLatestReview(subjectType, subjectId);
}

async function markReviewRevoked(
  store: GovernanceStore,
  record: Record<string, unknown>,
  subjectType: GovernanceSubjectType,
  subjectId: string,
  principal: GovernancePrincipal,
  now: () => Date
): Promise<GovernanceReviewDTO | undefined> {
  const review = await resolveReview(store, record, subjectType, subjectId);
  if (!review || review.status === "revoked") {
    return review;
  }
  if (!canTransitionReviewStatus(review.status, "revoked")) {
    throw new GovernanceServiceError(409, "invalid_review_transition", `${review.status} cannot transition to revoked`);
  }
  const status = "revoked";
  const publicSummary = optionalString(record, "publicSummary") ?? optionalString(record, "reason") ?? review.publicSummary;
  const internalNotes = optionalString(record, "internalNotes") ?? review.internalNotes;
  const hashInput = reviewHashInputFromFields({
    subjectType,
    subjectId,
    status,
    riskLevel: review.riskLevel,
    riskTags: review.riskTags,
    publicSummary
  });
  const updated: GovernanceReviewDTO = {
    ...review,
    status,
    publicSummary,
    internalNotes,
    metadataHash: hashGovernanceReviewMetadata(hashInput),
    policyHash: hashGovernanceReviewPolicy(hashInput),
    metadataURI: optionalString(record, "metadataURI") ?? review.metadataURI,
    reviewer: principal.adminId,
    updatedAt: now().toISOString()
  };
  await store.putReview(updated);
  return updated;
}

function assertReviewAllowsIdentityRegistration(status: GovernanceReviewStatus): void {
  if (status !== "approved_for_broadcast" && status !== "approved" && status !== "restricted") {
    throw new GovernanceServiceError(409, "review_not_approved", `${status} review cannot register an identity`);
  }
}

function reviewHashInput(review: GovernanceReviewDTO): GovernanceReviewHashInput {
  return reviewHashInputFromFields({
    subjectType: review.subjectType,
    subjectId: review.subjectId,
    status: review.status,
    riskLevel: review.riskLevel,
    riskTags: review.riskTags,
    publicSummary: review.publicSummary
  });
}

function reviewHashInputFromRecord(
  record: Record<string, unknown>,
  subjectType: GovernanceSubjectType,
  subjectId: string,
  defaultStatus: GovernanceReviewStatus
): GovernanceReviewHashInput {
  return reviewHashInputFromFields({
    subjectType,
    subjectId,
    status: optionalReviewStatus(record, "status") ?? defaultStatus,
    riskLevel: optionalString(record, "riskLevel") ?? "unknown",
    riskTags: optionalStringArray(record, "riskTags") ?? [],
    publicSummary: optionalString(record, "publicSummary") ?? "",
    metadata: optionalUnknown(record, "metadata"),
    policy: optionalUnknown(record, "policy")
  });
}

function reviewHashInputFromFields(input: {
  readonly subjectType: GovernanceSubjectType;
  readonly subjectId: string;
  readonly status: GovernanceReviewStatus;
  readonly riskLevel: string;
  readonly riskTags: readonly string[];
  readonly publicSummary: string;
  readonly metadata?: unknown;
  readonly policy?: unknown;
}): GovernanceReviewHashInput {
  return {
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    status: input.status,
    riskLevel: input.riskLevel,
    riskTags: [...input.riskTags].map((tag) => tag.trim()).filter((tag) => tag.length > 0).sort(),
    publicSummary: input.publicSummary,
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    ...(input.policy !== undefined ? { policy: input.policy } : {})
  };
}

function identityLog(
  logId: string,
  action: "register_identity" | "revoke_identity",
  request: IdentityRegistrationRequestDTO | IdentityRevocationRequestDTO,
  broadcast: GovernanceBroadcastResultDTO,
  principal: GovernancePrincipal,
  createdAt: string
): IdentityTxLogDTO {
  return {
    logId,
    txLogId: logId,
    action,
    subjectId: request.subjectId,
    ...(request.kind === "registerIdentity" ? {
      account: request.account,
      descriptorHash: request.descriptorHash,
      descriptorURI: request.descriptorURI
    } : {
      bindingId: request.bindingId,
      reasonHash: request.reasonHash,
      reasonURI: request.reasonURI
    }),
    ...(broadcast.txHash ? { txHash: broadcast.txHash } : {}),
    ...(broadcast.blockNumber ? { blockNumber: broadcast.blockNumber } : {}),
    ...(broadcast.signer ? { signer: broadcast.signer } : {}),
    requester: principal.adminId,
    status: txLogStatusFromBroadcast(broadcast.status),
    broadcastStatus: broadcast.status,
    ...defaultGovernanceReconcileFields(broadcast),
    ...(broadcast.errorCode ? { errorCode: broadcast.errorCode } : {}),
    ...(broadcast.message ? { errorMessage: broadcast.message } : {}),
    retryable: broadcast.retryable,
    request,
    createdAt,
    updatedAt: createdAt
  };
}

async function reusableDuplicateIdentityLog(
  store: GovernanceStore,
  action: "register_identity" | "revoke_identity",
  request: IdentityRegistrationRequestDTO | IdentityRevocationRequestDTO
): Promise<IdentityTxLogDTO | undefined> {
  const key = governanceRequestKey(action, request);
  const duplicate = (await store.listIdentityTxLogs())
    .find((log) => log.action === action && governanceRequestKey(log.action, log.request) === key);
  return duplicate && isReusableDuplicateLog(duplicate) ? duplicate : undefined;
}

function isReusableDuplicateLog(log: GovernanceTxLogDTO): boolean {
  return log.status !== "failed" || !log.retryable;
}

function governanceRequestKey(action: GovernanceTxAction, request: GovernanceChainRequestDTO): Hex {
  return hashGovernanceCanonicalJson({
    version: 1,
    kind: "governanceDuplicateRequest",
    action,
    request
  }, "governance duplicate request");
}

function broadcastFromLog(log: GovernanceTxLogDTO): GovernanceBroadcastResultDTO {
  return {
    status: log.broadcastStatus,
    ...(log.txHash ? { txHash: log.txHash } : {}),
    ...(log.blockNumber ? { blockNumber: log.blockNumber } : {}),
    ...(log.signer ? { signer: log.signer } : {}),
    ...(log.errorCode ? { errorCode: log.errorCode } : {}),
    ...(log.errorMessage ? { message: log.errorMessage } : {}),
    retryable: log.retryable,
    simulated: log.broadcastStatus === "simulated_tx"
  };
}

async function auditGovernanceLog(
  audit: AuditSink,
  log: GovernanceTxLogDTO,
  outcome: "duplicate" | "failed" | "succeeded"
): Promise<void> {
  await audit.record({
    type: "governance.broadcast",
    action: log.action,
    outcome,
    actor: log.requester,
    subject: {
      subjectId: log.subjectId,
      txLogId: log.txLogId,
      broadcastStatus: log.broadcastStatus
    },
    ...(log.txHash ? { txHash: log.txHash } : {}),
    ...(log.errorCode ? { errorCode: log.errorCode } : {}),
    retryable: log.retryable,
    metadata: {
      beforeStatus: "pending",
      afterStatus: log.status,
      ...(log.blockNumber ? { blockNumber: log.blockNumber } : {})
    }
  });
}

function auditOutcomeFromBroadcast(broadcast: GovernanceBroadcastResultDTO): "failed" | "succeeded" {
  return broadcast.status === "failed" ? "failed" : "succeeded";
}

async function safeBroadcast(action: () => Promise<GovernanceBroadcastResultDTO>): Promise<GovernanceBroadcastResultDTO> {
  try {
    return await action();
  } catch (error) {
    return {
      status: "failed",
      errorCode: "governance_adapter_failed",
      message: error instanceof Error ? redactGovernanceAdapterError(error) : "unknown governance adapter failure",
      retryable: true,
      simulated: false
    };
  }
}

function txLogStatusFromBroadcast(status: GovernanceBroadcastResultDTO["status"]): IdentityTxLogDTO["status"] {
  switch (status) {
    case "simulated_tx":
    case "submitted":
      return "pending";
    case "confirmed":
      return "indexing";
    case "broadcasting":
    case "failed":
      return status;
  }
}

function defaultGovernanceReconcileFields(broadcast: GovernanceBroadcastResultDTO): TxReconcileFields {
  if (broadcast.status === "confirmed") {
    return {
      reconcileStatus: "indexing",
      receiptStatus: broadcast.txHash ? "success" : "not_checked",
      projectionStatus: "missing"
    };
  }
  if (broadcast.status === "failed") {
    return {
      reconcileStatus: "failed",
      receiptStatus: broadcast.txHash ? "failed" : "not_checked",
      projectionStatus: "not_checked"
    };
  }
  return {
    reconcileStatus: broadcast.txHash ? "submitted" : "broadcasting",
    receiptStatus: "not_checked",
    projectionStatus: "not_checked"
  };
}

function parseReviewQuery(query: Readonly<Record<string, string | undefined>>): GovernanceReviewQuery {
  const subjectType = query.subjectType ? parseSubjectType(query.subjectType) : undefined;
  const subjectId = query.subjectId?.trim();
  const status = query.status ? parseReviewStatus(query.status) : undefined;
  return {
    ...(subjectType ? { subjectType } : {}),
    ...(subjectId ? { subjectId } : {}),
    ...(status ? { status } : {})
  };
}

function optionalHashPayload(record: Record<string, unknown>): { readonly metadata?: unknown; readonly policy?: unknown } {
  return {
    ...(optionalUnknown(record, "metadata") !== undefined ? { metadata: record.metadata } : {}),
    ...(optionalUnknown(record, "policy") !== undefined ? { policy: record.policy } : {})
  };
}

function optionalSupplierHashPayload(record: Record<string, unknown>): {
  readonly metadata?: unknown;
  readonly profile?: unknown;
  readonly capability?: unknown;
  readonly reputation?: unknown;
} {
  const capability = optionalSupplierCapability(record);
  return {
    ...(optionalUnknown(record, "metadata") !== undefined ? { metadata: record.metadata } : {}),
    ...(optionalUnknown(record, "profile") !== undefined ? { profile: record.profile } : {}),
    ...(capability !== undefined ? { capability } : {}),
    ...(optionalUnknown(record, "reputation") !== undefined ? { reputation: record.reputation } : {})
  };
}

function optionalSupplierCapability(record: Record<string, unknown>): unknown | undefined {
  const directCapability = optionalUnknown(record, "capability");
  if (directCapability !== undefined) {
    return directCapability;
  }

  const metadata = optionalUnknown(record, "metadata");
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return undefined;
  }
  return optionalUnknown(metadata as Record<string, unknown>, "capability");
}

function requireBodyRecord(body: unknown): Record<string, unknown> {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  throw new GovernanceServiceError(400, "invalid_body", "request body must be a JSON object");
}

function requiredString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new GovernanceServiceError(400, "invalid_body", `${field} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(record: Record<string, unknown>, field: string): string | undefined {
  if (!Object.hasOwn(record, field)) {
    return undefined;
  }
  const value = record[field];
  if (value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new GovernanceServiceError(400, "invalid_body", `${field} must be a string`);
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function optionalStringArray(record: Record<string, unknown>, field: string): readonly string[] | undefined {
  if (!Object.hasOwn(record, field)) {
    return undefined;
  }
  const value = record[field];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new GovernanceServiceError(400, "invalid_body", `${field} must be an array of strings`);
  }
  return value.map((item) => item.trim()).filter((item) => item.length > 0).sort();
}

function optionalUnknown(record: Record<string, unknown>, field: string): unknown | undefined {
  return Object.hasOwn(record, field) ? record[field] : undefined;
}

function requiredBytes32(record: Record<string, unknown>, field: string): Hex {
  try {
    return normalizeBytes32(requiredString(record, field), field);
  } catch (error) {
    if (error instanceof ConfigError) {
      throw new GovernanceServiceError(400, "invalid_body", error.message);
    }
    throw error;
  }
}

function requiredAddress(record: Record<string, unknown>, field: string): Address {
  try {
    return normalizeAddress(requiredString(record, field), field);
  } catch (error) {
    if (error instanceof ConfigError) {
      throw new GovernanceServiceError(400, "invalid_body", error.message);
    }
    throw error;
  }
}

function requiredReviewStatus(record: Record<string, unknown>, field: string): GovernanceReviewStatus {
  return parseReviewStatus(requiredString(record, field));
}

function optionalReviewStatus(record: Record<string, unknown>, field: string): GovernanceReviewStatus | undefined {
  const value = optionalString(record, field);
  return value ? parseReviewStatus(value) : undefined;
}

function parseReviewStatus(value: string): GovernanceReviewStatus {
  switch (value) {
    case "draft":
    case "submitted":
    case "approved_for_broadcast":
    case "approved":
    case "restricted":
    case "rejected":
    case "revoked":
      return value;
    default:
      throw new GovernanceServiceError(400, "invalid_body", `unsupported review status: ${value}`);
  }
}

function parseSubjectType(value: string): GovernanceSubjectType {
  switch (value) {
    case "zhixu":
    case "supplier":
      return value;
    default:
      throw new GovernanceServiceError(400, "invalid_query", `unsupported subjectType: ${value}`);
  }
}

function nextId(prefix: string, subjectId?: string): string {
  const suffix = subjectId ? `_${slugId(subjectId).slice(0, 20)}` : "";
  return `${prefix}_${randomUUID()}${suffix}`;
}

function slugId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "subject";
}

function defaultMetadataURI(hash: Hex): string {
  return `uvp-governance://metadata/${hash}`;
}

function redactGovernanceAdapterError(error: Error): string {
  return redactErrorMessage(error).replace(
    /\b(private(?:\s|-|_)?key|secret|token|password)\b\s*[:=]?\s*0x[0-9a-fA-F]{64}/gi,
    (_match, label: string) => `${label} [redacted:secret]`
  );
}
