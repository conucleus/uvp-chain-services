import { randomUUID } from "node:crypto";
import { canonicalize } from "@uvp-eth/compiler";
import { hashCanonicalJson, hashEvidenceBytes, hashEvidencePayload } from "./hashing.js";
import { normalizeBytes32 } from "../shared/types.js";
import { InMemoryEvidenceMetadataStore, type EvidenceMetadataRecord, type EvidenceMetadataStore } from "./store.js";
import {
  assertEvidenceStorageProductionBoundary,
  assertProductionStorageURI,
  InMemoryEvidenceStorage,
  LocalEvidenceStorage,
  type EvidenceStorage,
  type EvidenceStorageRuntimeEnvironment
} from "./storage.js";
import type {
  BindEvidenceRequestDTO,
  CreateEvidenceRequestDTO,
  EvidenceAccessPolicyDTO,
  EvidenceAccessPolicyInputDTO,
  EvidenceContentDTO,
  EvidenceJsonObject,
  EvidenceJsonValue,
  EvidenceMetadataDTO,
  EvidenceMetadataInputDTO,
  EvidencePrincipal,
  EvidencePrincipalRole,
  EvidenceProofDTO,
  EvidenceRecordDTO,
  EvidenceUploadResponseDTO
} from "./types.js";

const DEFAULT_MAX_PAYLOAD_BYTES = 10 * 1024 * 1024;
const SUPPORTED_MIME_TYPES = new Set([
  "application/json",
  "application/octet-stream",
  "application/pdf",
  "image/jpeg",
  "image/png",
  "text/plain"
]);

export type EvidenceServiceErrorCode =
  | "evidence_not_found"
  | "evidence_already_bound"
  | "forbidden"
  | "invalid_request"
  | "payload_too_large"
  | "unauthenticated"
  | "unsupported_mime_type";

export class EvidenceServiceError extends Error {
  override readonly name = "EvidenceServiceError";

  constructor(
    readonly code: EvidenceServiceErrorCode,
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

export interface EvidenceServiceOptions {
  readonly metadataStore?: EvidenceMetadataStore;
  readonly storage?: EvidenceStorage;
  readonly now?: () => Date;
  readonly evidenceIdFactory?: () => string;
  readonly maxPayloadBytes?: number;
  readonly runtimeEnvironment?: EvidenceStorageRuntimeEnvironment;
}

export interface EvidenceService {
  uploadEvidence(input: CreateEvidenceRequestDTO, principal: EvidencePrincipal): Promise<EvidenceUploadResponseDTO>;
  getEvidence(evidenceId: string, principal: EvidencePrincipal): Promise<EvidenceRecordDTO | undefined>;
  getProof(evidenceId: string, principal: EvidencePrincipal): Promise<EvidenceProofDTO | undefined>;
  bindEvidence(input: BindEvidenceRequestDTO): Promise<EvidenceRecordDTO | undefined>;
}

export function createEvidenceService(options: EvidenceServiceOptions = {}): EvidenceService {
  const metadataStore = options.metadataStore ?? new InMemoryEvidenceMetadataStore();
  const storage = options.storage ?? new InMemoryEvidenceStorage();
  const now = options.now ?? (() => new Date());
  const evidenceIdFactory = options.evidenceIdFactory ?? (() => `ev_${randomUUID()}`);
  const maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
  const runtimeEnvironment = options.runtimeEnvironment ?? "local";
  assertEvidenceStorageProductionBoundary(storage, runtimeEnvironment);

  return {
    async uploadEvidence(input, principal) {
      const normalizedPrincipal = normalizePrincipal(principal);
      requireAuthenticated(normalizedPrincipal);

      const orderId = optionalNonEmptyString(input.orderId, "orderId");
      const draftId = optionalNonEmptyString(input.draftId, "draftId");
      if (!orderId && !draftId) {
        throw invalidRequest("either orderId or draftId is required");
      }

      const taskId = optionalNonEmptyString(input.taskId, "taskId");
      const stageIdentifier = requiredNonEmptyString(input.stageIdentifier, "stageIdentifier");
      const documentType = requiredNonEmptyString(input.documentType, "documentType");
      const ownerParticipantId = normalizeParticipantId(
        optionalNonEmptyString(input.ownerParticipantId, "ownerParticipantId") ?? normalizedPrincipal.id
      );
      const fileName = optionalNonEmptyString(input.fileName, "fileName") ?? defaultFileNameFor(input);
      const content = decodeEvidenceContent(input);
      const mimeType = optionalNonEmptyString(input.mimeType, "mimeType") ?? content.defaultMimeType;

      if (!SUPPORTED_MIME_TYPES.has(mimeType)) {
        throw new EvidenceServiceError("unsupported_mime_type", `${mimeType} is not supported by Evidence Service v1`, 415);
      }
      if (content.bytes.byteLength > maxPayloadBytes) {
        throw new EvidenceServiceError("payload_too_large", "evidence payload exceeds the configured size limit", 413);
      }

      const provisionalAccessPolicy = normalizeAccessPolicy({
        evidenceId: "pending",
        ownerParticipantId,
        ...(orderId ? { orderId } : {}),
        ...(input.accessPolicy ? { input: input.accessPolicy } : {})
      });
      if (!canWriteEvidence(normalizedPrincipal, ownerParticipantId, provisionalAccessPolicy)) {
        throw new EvidenceServiceError("forbidden", "principal cannot upload evidence for this owner", 403);
      }

      const evidenceId = evidenceIdFactory();
      const canonicalMetadata = canonicalMetadataFromInput(input.metadata, documentType);
      const metadata = metadataDtoFromCanonical(evidenceId, canonicalMetadata);
      const contentHash = hashEvidenceBytes(content.bytes, "contentHash");
      const metadataHash = hashCanonicalJson(canonicalMetadata, "metadataHash");
      const payloadHash = hashEvidencePayload({
        contentHash,
        metadataHash,
        documentType,
        ...(orderId ? { orderId } : {}),
        stageIdentifier
      });
      const stored = await storage.put({ evidenceId, bytes: content.bytes });
      if (runtimeEnvironment !== "local") {
        assertProductionStorageURI(stored.storageURI);
      }
      const createdAt = now().toISOString();
      const payloadRef = `uvp-evidence://product/${encodeURIComponent(evidenceId)}`;
      const evidence = {
        evidenceId,
        ...(orderId ? { orderId } : {}),
        ...(draftId ? { draftId } : {}),
        ...(taskId ? { taskId } : {}),
        stageIdentifier,
        ownerParticipantId,
        fileName,
        mimeType,
        size: stored.size,
        storageURI: stored.storageURI,
        contentHash,
        metadataHash,
        payloadHash,
        payloadRef,
        status: "uploaded" as const,
        createdAt
      };
      const accessPolicy = normalizeAccessPolicy({
        evidenceId,
        ownerParticipantId,
        ...(orderId ? { orderId } : {}),
        ...(input.accessPolicy ? { input: input.accessPolicy } : {})
      });

      const record: EvidenceMetadataRecord = {
        evidence,
        metadata,
        accessPolicy,
        canonicalMetadata
      };
      await metadataStore.put(record);

      return {
        evidence,
        metadata,
        accessPolicy,
        payloadHash,
        payloadRef
      };
    },

    async getEvidence(evidenceId, principal) {
      const record = await metadataStore.get(evidenceId);
      if (!record) {
        return undefined;
      }
      const normalizedPrincipal = normalizePrincipal(principal);
      authorizeRead(record, normalizedPrincipal);
      if (normalizedPrincipal.role === "admin") {
        await metadataStore.recordAdminRead({
          evidenceId,
          principalId: normalizedPrincipal.id ?? "admin",
          accessedAt: now().toISOString(),
          route: "evidence"
        });
      }
      return recordToDto(record);
    },

    async getProof(evidenceId, principal) {
      const record = await metadataStore.get(evidenceId);
      if (!record) {
        return undefined;
      }
      const normalizedPrincipal = normalizePrincipal(principal);
      authorizeRead(record, normalizedPrincipal);
      if (normalizedPrincipal.role === "admin") {
        await metadataStore.recordAdminRead({
          evidenceId,
          principalId: normalizedPrincipal.id ?? "admin",
          accessedAt: now().toISOString(),
          route: "proof"
        });
      }
      const verificationStatus = await verifyEvidenceRecord(record, storage);
      return {
        evidenceId,
        payloadHash: record.evidence.payloadHash,
        contentHash: record.evidence.contentHash,
        metadataHash: record.evidence.metadataHash,
        payloadRef: record.evidence.payloadRef,
        storageURI: record.evidence.storageURI,
        ...(record.evidence.boundSignalTxHash ? { boundSignalTxHash: record.evidence.boundSignalTxHash } : {}),
        ...(record.evidence.boundSubmissionId ? { boundSubmissionId: record.evidence.boundSubmissionId } : {}),
        ...(record.evidence.boundOnchainOrderId ? { boundOnchainOrderId: record.evidence.boundOnchainOrderId } : {}),
        ...(record.evidence.boundSourceId ? { boundSourceId: record.evidence.boundSourceId } : {}),
        ...(record.evidence.boundSignalId ? { boundSignalId: record.evidence.boundSignalId } : {}),
        ...(record.evidence.boundAt ? { boundAt: record.evidence.boundAt } : {}),
        verificationStatus
      };
    },

    async bindEvidence(input) {
      const binding = normalizeBinding(input, now);
      const record = await metadataStore.get(binding.evidenceId);
      if (!record) {
        return undefined;
      }
      assertBindable(record, binding);
      if (record.evidence.status === "bound") {
        return recordToDto(record);
      }
      const updated = metadataStore.markBound
        ? await metadataStore.markBound(binding)
        : await putBoundRecord(metadataStore, record, binding);
      return updated ? recordToDto(updated) : undefined;
    }
  };
}

export function createDefaultEvidenceService(): EvidenceService {
  return createEvidenceService({
    metadataStore: new InMemoryEvidenceMetadataStore(),
    storage: new LocalEvidenceStorage()
  });
}

export function principalFromHeaders(headers: Readonly<Record<string, string | undefined>> | undefined): EvidencePrincipal {
  const id = normalizeOptionalParticipantId(headers?.["x-uvp-principal-id"] ?? headers?.["x-principal-id"]);
  const roleHeader = headers?.["x-uvp-principal-role"] ?? headers?.["x-principal-role"];
  return {
    ...(id ? { id } : {}),
    role: normalizePrincipalRole(roleHeader, id)
  };
}

function recordToDto(record: EvidenceMetadataRecord): EvidenceRecordDTO {
  return {
    evidence: record.evidence,
    metadata: record.metadata,
    accessPolicy: record.accessPolicy
  };
}

async function putBoundRecord(
  metadataStore: EvidenceMetadataStore,
  record: EvidenceMetadataRecord,
  binding: BindEvidenceRequestDTO
): Promise<EvidenceMetadataRecord> {
  const updated: EvidenceMetadataRecord = {
    ...record,
    evidence: boundEvidence(record, binding)
  };
  await metadataStore.put(updated);
  return updated;
}

function boundEvidence(record: EvidenceMetadataRecord, binding: BindEvidenceRequestDTO): EvidenceRecordDTO["evidence"] {
  return {
    ...record.evidence,
    status: "bound",
    boundSignalTxHash: binding.txHash,
    ...(binding.submissionId ? { boundSubmissionId: binding.submissionId } : {}),
    boundOnchainOrderId: binding.onchainOrderId,
    boundSourceId: binding.sourceId,
    boundSignalId: binding.signalId,
    ...(binding.boundAt ? { boundAt: binding.boundAt } : {})
  };
}

async function verifyEvidenceRecord(
  record: EvidenceMetadataRecord,
  storage: EvidenceStorage
): Promise<EvidenceProofDTO["verificationStatus"]> {
  const bytes = await storage.get(record.evidence.storageURI);
  if (!bytes) {
    return "missing_file";
  }

  const actualContentHash = hashEvidenceBytes(bytes, "proof.contentHash");
  const actualMetadataHash = hashCanonicalJson(record.canonicalMetadata, "proof.metadataHash");
  if (actualContentHash !== record.evidence.contentHash || actualMetadataHash !== record.evidence.metadataHash) {
    return "mismatch";
  }

  return record.evidence.status === "bound" && record.evidence.boundSignalTxHash ? "matched" : "unbound";
}

function authorizeRead(record: EvidenceMetadataRecord, principal: EvidencePrincipal): void {
  requireAuthenticated(principal);
  if (canReadEvidence(principal, record)) {
    return;
  }
  throw new EvidenceServiceError("forbidden", "principal cannot read this evidence", 403);
}

function normalizeBinding(input: BindEvidenceRequestDTO, now: () => Date): BindEvidenceRequestDTO {
  const submissionId = optionalNonEmptyString(input.submissionId, "submissionId");
  return {
    evidenceId: requiredNonEmptyString(input.evidenceId, "evidenceId"),
    ...(submissionId ? { submissionId } : {}),
    txHash: normalizeBytes32(input.txHash, "txHash"),
    orderId: requiredNonEmptyString(input.orderId, "orderId"),
    onchainOrderId: normalizeBytes32(input.onchainOrderId, "onchainOrderId"),
    sourceId: normalizeBytes32(input.sourceId, "sourceId"),
    signalId: normalizeBytes32(input.signalId, "signalId"),
    boundAt: input.boundAt ? requiredNonEmptyString(input.boundAt, "boundAt") : now().toISOString()
  };
}

function assertBindable(record: EvidenceMetadataRecord, binding: BindEvidenceRequestDTO): void {
  if (record.evidence.orderId && record.evidence.orderId !== binding.orderId) {
    throw new EvidenceServiceError("invalid_request", "evidence belongs to a different order", 409);
  }
  if (record.evidence.status === "bound") {
    return;
  }
  if (record.evidence.status !== "uploaded") {
    throw new EvidenceServiceError("invalid_request", "evidence status cannot be bound", 409);
  }
}

function requireAuthenticated(principal: EvidencePrincipal): void {
  if (!principal.id) {
    throw new EvidenceServiceError("unauthenticated", "x-uvp-principal-id header is required", 401);
  }
}

function canWriteEvidence(
  principal: EvidencePrincipal,
  ownerParticipantId: string,
  accessPolicy: EvidenceAccessPolicyDTO
): boolean {
  if (principal.role === "admin") {
    return true;
  }
  const principalId = principal.id;
  if (!principalId) {
    return false;
  }
  return principalId === ownerParticipantId || accessPolicy.writers.includes(principalId);
}

function canReadEvidence(principal: EvidencePrincipal, record: EvidenceMetadataRecord): boolean {
  if (principal.role === "admin") {
    return true;
  }
  const principalId = principal.id;
  if (!principalId) {
    return false;
  }
  if (principalId === record.evidence.ownerParticipantId) {
    return true;
  }
  const policy = record.accessPolicy;
  if (policy.readers.includes(principalId) || policy.writers.includes(principalId)) {
    return true;
  }
  return principal.role === "adjudicator" && policy.disputeReaders.includes(principalId);
}

function normalizeAccessPolicy(input: {
  readonly evidenceId: string;
  readonly orderId?: string;
  readonly ownerParticipantId: string;
  readonly input?: EvidenceAccessPolicyInputDTO;
}): EvidenceAccessPolicyDTO {
  const readers = normalizeParticipantList(input.input?.readers, "accessPolicy.readers");
  const writers = normalizeParticipantList(input.input?.writers, "accessPolicy.writers");
  const adminReaders = normalizeParticipantList(input.input?.adminReaders, "accessPolicy.adminReaders");
  const disputeReaders = normalizeParticipantList(input.input?.disputeReaders, "accessPolicy.disputeReaders");

  return {
    evidenceId: input.evidenceId,
    ...(input.orderId ? { orderId: input.orderId } : {}),
    readers: uniqueParticipants([input.ownerParticipantId, ...readers]),
    writers: uniqueParticipants([input.ownerParticipantId, ...writers]),
    adminReaders,
    disputeReaders
  };
}

function canonicalMetadataFromInput(input: EvidenceMetadataInputDTO | undefined, documentType: string): EvidenceJsonObject {
  const metadataDocumentType = optionalNonEmptyString(input?.documentType, "metadata.documentType");
  if (metadataDocumentType && metadataDocumentType !== documentType) {
    throw invalidRequest("metadata.documentType must match documentType");
  }

  const canonical = {
    businessLabel: optionalNonEmptyString(input?.businessLabel, "metadata.businessLabel") ?? documentType,
    ...(input?.description ? { description: requiredNonEmptyString(input.description, "metadata.description") } : {}),
    documentType,
    ...(input?.issuer ? { issuer: requiredNonEmptyString(input.issuer, "metadata.issuer") } : {}),
    ...(input?.issuedAt ? { issuedAt: requiredNonEmptyString(input.issuedAt, "metadata.issuedAt") } : {}),
    fields: canonicalJsonObject(input?.fields ?? {}, "metadata.fields"),
    ...(typeof input?.redactionPolicy !== "undefined"
      ? { redactionPolicy: canonicalJsonValue(input.redactionPolicy, "metadata.redactionPolicy") }
      : {})
  };

  return canonicalJsonObject(canonical, "metadata");
}

function metadataDtoFromCanonical(evidenceId: string, canonical: EvidenceJsonObject): EvidenceMetadataDTO {
  return {
    evidenceId,
    businessLabel: requiredNonEmptyString(canonical.businessLabel, "metadata.businessLabel"),
    ...(typeof canonical.description === "string" ? { description: canonical.description } : {}),
    documentType: requiredNonEmptyString(canonical.documentType, "metadata.documentType"),
    ...(typeof canonical.issuer === "string" ? { issuer: canonical.issuer } : {}),
    ...(typeof canonical.issuedAt === "string" ? { issuedAt: canonical.issuedAt } : {}),
    fields: canonicalJsonObject(canonical.fields, "metadata.fields"),
    ...(typeof canonical.redactionPolicy !== "undefined" ? { redactionPolicy: canonical.redactionPolicy } : {})
  };
}

function decodeEvidenceContent(input: CreateEvidenceRequestDTO): {
  readonly bytes: Uint8Array;
  readonly defaultMimeType: string;
} {
  const content = normalizeContentInput(input);
  if (content.encoding === "text") {
    return {
      bytes: new TextEncoder().encode(content.value),
      defaultMimeType: "text/plain"
    };
  }
  if (content.encoding === "json") {
    return {
      bytes: new TextEncoder().encode(JSON.stringify(canonicalize(content.value, "content.value"))),
      defaultMimeType: "application/json"
    };
  }
  return {
    bytes: decodeBase64(content.value),
    defaultMimeType: "application/octet-stream"
  };
}

function normalizeContentInput(input: CreateEvidenceRequestDTO): EvidenceContentDTO {
  if (input.content) {
    return input.content;
  }
  if (typeof input.textPayload === "string") {
    return { encoding: "text", value: input.textPayload };
  }
  if (typeof input.base64Payload === "string") {
    return { encoding: "base64", value: input.base64Payload };
  }
  if (typeof input.jsonPayload !== "undefined") {
    return { encoding: "json", value: input.jsonPayload };
  }
  throw invalidRequest("content, textPayload, base64Payload, or jsonPayload is required");
}

function decodeBase64(value: string): Uint8Array {
  const compact = value.replace(/\s/g, "");
  if (compact.length === 0 || compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    throw invalidRequest("base64 evidence content is malformed");
  }
  return Buffer.from(compact, "base64");
}

function normalizePrincipal(principal: EvidencePrincipal): EvidencePrincipal {
  return {
    ...(principal.id ? { id: normalizeParticipantId(principal.id) } : {}),
    role: principal.role
  };
}

function normalizePrincipalRole(value: string | undefined, principalId: string | undefined): EvidencePrincipalRole {
  if (!value) {
    return principalId ? "participant" : "anonymous";
  }
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "participant" ||
    normalized === "adjudicator" ||
    normalized === "admin"
  ) {
    return normalized;
  }
  return principalId ? "participant" : "anonymous";
}

function normalizeParticipantList(value: readonly string[] | undefined, fieldName: string): readonly string[] {
  if (!value) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw invalidRequest(`${fieldName} must be an array`);
  }
  return uniqueParticipants(value.map((item, index) => normalizeParticipantId(requiredNonEmptyString(item, `${fieldName}[${index}]`))));
}

function uniqueParticipants(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function normalizeOptionalParticipantId(value: string | undefined): string | undefined {
  return value ? normalizeParticipantId(value) : undefined;
}

function normalizeParticipantId(value: string | undefined): string {
  if (!value) {
    throw invalidRequest("principal id is required");
  }
  return requiredNonEmptyString(value, "participantId").toLowerCase();
}

function canonicalJsonObject(value: unknown, path: string): EvidenceJsonObject {
  const canonical = canonicalJsonValue(value, path);
  if (!canonical || typeof canonical !== "object" || Array.isArray(canonical)) {
    throw invalidRequest(`${path} must be a JSON object`);
  }
  return canonical as EvidenceJsonObject;
}

function canonicalJsonValue(value: unknown, path: string): EvidenceJsonValue {
  try {
    return canonicalize(value, path) as EvidenceJsonValue;
  } catch (error) {
    if (error instanceof TypeError) {
      throw invalidRequest(error.message);
    }
    throw error;
  }
}

function requiredNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalidRequest(`${fieldName} is required`);
  }
  return value.trim();
}

function optionalNonEmptyString(value: unknown, fieldName: string): string | undefined {
  if (typeof value === "undefined") {
    return undefined;
  }
  if (typeof value !== "string") {
    throw invalidRequest(`${fieldName} must be a string`);
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function defaultFileNameFor(input: CreateEvidenceRequestDTO): string {
  if (input.content?.encoding === "json" || typeof input.jsonPayload !== "undefined") {
    return "evidence.json";
  }
  if (input.content?.encoding === "text" || typeof input.textPayload !== "undefined") {
    return "evidence.txt";
  }
  return "evidence.bin";
}

function invalidRequest(message: string): EvidenceServiceError {
  return new EvidenceServiceError("invalid_request", message, 400);
}
