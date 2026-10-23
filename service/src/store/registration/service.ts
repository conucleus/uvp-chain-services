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

/**
 * 实体自助登记服务。
 *
 * 口径（与 used-car 产品定义一致）：v1 只做「实体登记 + 人工核验 + 钱包
 * 绑定」中的登记与账号锚定；核验仍靠人工/接通 A 机构，链上身份绑定仍走
 * 治理登记。因此：
 * - 对外 DTO 的 `verified` 恒为 false，`chainWritten` 恒为 false；
 * - 不写链、不创建供应商、不调用 governance register-identity；
 * - 账号地址由路由层从会话锚定地址传入，服务端不接受客户端自报。
 */
export interface StoreEntityRegistrationDTO {
  readonly registrationId: string;
  readonly accountAddress: Address;
  readonly accountId?: string;
  readonly legalName: string;
  readonly registrationNumber: string;
  readonly contactName: string;
  readonly status: StoreEntityRegistrationStatus;
  /** 自助登记未经人工核验：接口不提供改真通道，恒为 false。 */
  readonly verified: false;
  /** 只存链下档案：没有链上身份绑定或治理登记记录。 */
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
  /** 自助登记/重复提交更新当前会话锚定地址的档案；返回未核验的登记事实。 */
  registerEntity(input: unknown, actor: StoreEntityRegistrationActor): Promise<StoreEntityRegistrationDTO>;
  /** 读取当前会话锚定地址的登记档案；未登记返回 undefined。 */
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

/** 客户端不得自报的服务端事实：账号地址由会话派生，状态/核验由服务端给。 */
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
      // 会话账号 id 缺失（如 local dev 锚定头）时保留已有值，不把锚定账号
      // 关联擦成 null；地址唯一键仍是单账号单记录的主锚。
      const accountId = actor.accountId ?? existing?.accountId;
      const record: StoreEntityRegistrationRecord = {
        // 首次登记由服务端生成 id；重复提交在 store 层保留首次 id/createdAt。
        registrationId: existing?.registrationId ?? `registration_${randomUUID()}`,
        accountAddress: actor.accountAddress,
        ...(accountId !== undefined ? { accountId } : {}),
        legalName: requiredBoundedString(body, "legalName"),
        registrationNumber: requiredBoundedString(body, "registrationNumber"),
        contactName: requiredBoundedString(body, "contactName"),
        // 重复提交会改动申报内容，核验态回到自助申报（人工核验需重新进行）。
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
