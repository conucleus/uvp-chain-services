import { randomUUID } from "node:crypto";
import type { Address } from "../../shared/types.js";
import type {
  StoreEntityRegistrationRecord,
  StoreEntityRegistrationStatus,
  StoreEntityRegistrationStore
} from "./types.js";

export type {
  StoreEntityRegistrationRecord,
  StoreEntityRegistrationStatus,
  StoreEntityRegistrationStore
} from "./types.js";

export interface StoreEntityRegistrationDTO {
  readonly registrationId: string;
  readonly accountAddress: Address;
  readonly accountId?: string;
  readonly legalName: string;
  readonly registrationNumber: string;
  readonly contactName: string;
  readonly status: StoreEntityRegistrationStatus;
  readonly verified: false;
  readonly chainWritten: false;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface StoreEntityRegistrationActor {
  readonly accountAddress: Address;
  readonly accountId?: string;
}

export class StoreEntityRegistrationServiceError extends Error {
  override readonly name = "StoreEntityRegistrationServiceError";

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export interface StoreEntityRegistrationService {
  registerEntity(input: unknown, actor: StoreEntityRegistrationActor): Promise<StoreEntityRegistrationDTO>;
  getMyRegistration(accountAddress: Address): Promise<StoreEntityRegistrationDTO | undefined>;
}

export interface StoreEntityRegistrationServiceOptions {
  readonly store: StoreEntityRegistrationStore;
  readonly now?: () => Date;
}

const FIELD_LIMITS = {
  legalName: { label: "实体名称", maxLength: 120 },
  registrationNumber: { label: "注册号", maxLength: 64 },
  contactName: { label: "联系人", maxLength: 40 }
} as const;

const CLIENT_RESERVED_FIELDS = [
  "account",
  "accountAddress",
  "walletAddress",
  "registrationId",
  "status",
  "verified",
  "chainWritten",
  "createdAt",
  "updatedAt"
] as const;

export function createStoreEntityRegistrationService(
  options: StoreEntityRegistrationServiceOptions,
): StoreEntityRegistrationService {
  const now = options.now ?? (() => new Date());

  return {
    async registerEntity(input, actor) {
      const body = requireBodyRecord(input);
      rejectClientReservedFields(body);
      const timestamp = now().toISOString();
      const existing = await options.store.getRegistrationByAccount(actor.accountAddress);
      const accountId = actor.accountId ?? existing?.accountId;
      const record: StoreEntityRegistrationRecord = {
        registrationId: existing?.registrationId ?? `registration_${randomUUID()}`,
        accountAddress: actor.accountAddress,
        ...(accountId !== undefined ? { accountId } : {}),
        legalName: requiredBoundedString(body, "legalName"),
        registrationNumber: requiredBoundedString(body, "registrationNumber"),
        contactName: requiredBoundedString(body, "contactName"),
        status: "self_declared",
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp
      };
      const persisted = await options.store.upsertRegistration(record);
      return registrationDto(persisted);
    },

    async getMyRegistration(accountAddress) {
      const record = await options.store.getRegistrationByAccount(accountAddress);
      return record ? registrationDto(record) : undefined;
    }
  };
}

function registrationDto(record: StoreEntityRegistrationRecord): StoreEntityRegistrationDTO {
  return {
    registrationId: record.registrationId,
    accountAddress: record.accountAddress,
    ...(record.accountId !== undefined ? { accountId: record.accountId } : {}),
    legalName: record.legalName,
    registrationNumber: record.registrationNumber,
    contactName: record.contactName,
    status: record.status,
    verified: false,
    chainWritten: false,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

function requireBodyRecord(input: unknown): Record<string, unknown> {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  throw new StoreEntityRegistrationServiceError(
    400,
    "invalid_body",
    "request body must be a JSON object",
  );
}

function rejectClientReservedFields(record: Record<string, unknown>): void {
  for (const field of CLIENT_RESERVED_FIELDS) {
    if (Object.hasOwn(record, field)) {
      throw new StoreEntityRegistrationServiceError(
        400,
        "immutable_field",
        `${field} is derived by the server and cannot be set by clients`,
      );
    }
  }
}

function requiredBoundedString(record: Record<string, unknown>, field: keyof typeof FIELD_LIMITS): string {
  const value = record[field];
  if (typeof value !== "string") {
    throw new StoreEntityRegistrationServiceError(
      400,
      "invalid_body",
      `${field} must be a string`,
    );
  }
  const trimmed = value.trim();
  const { label, maxLength } = FIELD_LIMITS[field];
  if (trimmed.length === 0) {
    throw new StoreEntityRegistrationServiceError(
      400,
      "invalid_body",
      `${field} (${label}) must be a non-empty string`,
    );
  }
  if (trimmed.length > maxLength) {
    throw new StoreEntityRegistrationServiceError(
      400,
      "invalid_body",
      `${field} (${label}) must be at most ${maxLength} characters`,
    );
  }
  return trimmed;
}
