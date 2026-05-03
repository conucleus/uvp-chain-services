import { randomUUID } from "node:crypto";
import type { AuditEvent, AuditOutcome, AuditSink } from "../security/audit.js";
import { redactSecrets } from "../security/redaction.js";
import type { StoreAccessLevel, StoreAccessState, StoreAuthMode, StoreCapability, StoreRole } from "./access.js";

const REDACTED_AUDIT_VALUE = "[redacted]";
const SENSITIVE_AUDIT_KEY_PATTERN =
  /(privatekey|jwt|token|authorization|signature|credential|password|secret|plaintext|privatenotes|payload|content|calldata)/i;

export interface StoreAuditResource {
  readonly type: string;
  readonly id?: string;
  readonly parentId?: string;
}

export interface StoreAuditInput {
  readonly action: StoreCapability;
  readonly outcome: AuditOutcome;
  readonly access: StoreAccessState;
  readonly resource: StoreAuditResource;
  readonly headers?: Readonly<Record<string, string | undefined>>;
  readonly errorCode?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface StoreAuditRecord {
  readonly auditId: string;
  readonly createdAt: string;
  readonly actor: string;
  readonly action: StoreCapability;
  readonly outcome: AuditOutcome;
  readonly resourceType: string;
  readonly resourceId?: string;
  readonly parentId?: string;
  readonly accessLevel: StoreAccessLevel;
  readonly authMode: StoreAuthMode;
  readonly roles: readonly StoreRole[];
  readonly errorCode?: string;
  readonly requestId?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface StoreAuditQuery {
  readonly resourceType?: string;
  readonly resourceId?: string;
  readonly actor?: string;
  readonly action?: string;
  readonly outcome?: AuditOutcome;
  readonly limit?: number;
}

export interface StoreAuditStore {
  append(record: StoreAuditRecord): Promise<void>;
  query(query?: StoreAuditQuery): Promise<readonly StoreAuditRecord[]>;
}

export interface RecordStoreAuditOptions {
  readonly store?: StoreAuditStore;
  readonly now?: () => Date;
}

export class MemoryStoreAuditStore implements StoreAuditStore {
  readonly #records: StoreAuditRecord[] = [];

  async append(record: StoreAuditRecord): Promise<void> {
    this.#records.push(record);
  }

  async query(query: StoreAuditQuery = {}): Promise<readonly StoreAuditRecord[]> {
    return filterStoreAuditRecords(this.#records, query);
  }
}

export async function recordStoreAudit(
  audit: AuditSink,
  input: StoreAuditInput,
  options: RecordStoreAuditOptions = {}
): Promise<void> {
  const createdAt = (options.now ?? (() => new Date()))().toISOString();
  const requestIdValue = requestId(input.headers);
  const metadata = sanitizeAuditMetadata({
    ...(requestIdValue ? { requestId: requestIdValue } : {}),
    ...(input.metadata ?? {})
  });
  const record: StoreAuditRecord = {
    auditId: `store_audit_${createdAt.replace(/[^0-9]/g, "")}_${randomUUID()}`,
    createdAt,
    action: input.action,
    outcome: input.outcome,
    actor: input.access.principalId ?? "anonymous",
    resourceType: input.resource.type,
    ...(input.resource.id ? { resourceId: input.resource.id } : {}),
    ...(input.resource.parentId ? { parentId: input.resource.parentId } : {}),
    accessLevel: input.access.level,
    authMode: input.access.authMode,
    roles: input.access.roles,
    ...(input.errorCode ? { errorCode: input.errorCode } : {}),
    ...(requestIdValue ? { requestId: requestIdValue } : {}),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {})
  };
  const event: AuditEvent = {
    type: "store.operator",
    action: record.action,
    outcome: record.outcome,
    actor: record.actor,
    subject: {
      resourceType: record.resourceType,
      ...(record.resourceId ? { resourceId: record.resourceId } : {}),
      ...(record.parentId ? { parentId: record.parentId } : {}),
      accessLevel: record.accessLevel,
      authMode: record.authMode,
      roles: record.roles
    },
    ...(record.errorCode ? { errorCode: record.errorCode } : {}),
    ...(record.metadata ? { metadata: record.metadata } : {}),
    createdAt
  };

  let durableError: unknown;
  if (options.store) {
    try {
      await options.store.append(record);
    } catch (error) {
      durableError = error;
    }
  }

  await audit.record(event);
  if (durableError) {
    throw durableError;
  }
}

export function filterStoreAuditRecords(
  records: readonly StoreAuditRecord[],
  query: StoreAuditQuery = {}
): readonly StoreAuditRecord[] {
  const limit = query.limit ?? 100;
  return records
    .filter((record) => query.resourceType === undefined || record.resourceType === query.resourceType)
    .filter((record) => query.resourceId === undefined || record.resourceId === query.resourceId)
    .filter((record) => query.actor === undefined || record.actor === query.actor)
    .filter((record) => query.action === undefined || record.action === query.action)
    .filter((record) => query.outcome === undefined || record.outcome === query.outcome)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.auditId.localeCompare(left.auditId))
    .slice(0, limit);
}

function requestId(headers: StoreAuditInput["headers"]): string | undefined {
  return readHeader(headers, "x-uvp-request-id") ?? readHeader(headers, "x-request-id");
}

function readHeader(
  headers: Readonly<Record<string, string | undefined>> | undefined,
  name: string
): string | undefined {
  if (!headers) {
    return undefined;
  }
  return headers[name] ?? headers[name.toLowerCase()] ?? Object.entries(headers)
    .find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

function sanitizeAuditMetadata(metadata: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return scrubSensitiveAuditValues(redactSecrets(metadata)) as Record<string, unknown>;
}

function scrubSensitiveAuditValues(value: unknown, key?: string): unknown {
  if (key && SENSITIVE_AUDIT_KEY_PATTERN.test(key.replace(/[^a-zA-Z0-9]/g, "").toLowerCase())) {
    return REDACTED_AUDIT_VALUE;
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubSensitiveAuditValues(item, key));
  }
  return Object.fromEntries(
    Object.entries(value).map(([entryKey, entryValue]) => [entryKey, scrubSensitiveAuditValues(entryValue, entryKey)])
  );
}
