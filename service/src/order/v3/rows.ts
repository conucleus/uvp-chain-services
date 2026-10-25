// V3 订单域持久化行 ↔ 记录映射：sqlite/postgres 共用同一列名与 JSON
// 编码，避免两套驱动各自解释字段。

import type { ConfigBundleV3, OrderConfigStatusV3, StageStandardRefV3 } from "@uvp-eth/product-dto";
import { parseStorageJson } from "../../storage/json.js";
import {
  numberColumn,
  optionalStringColumn,
  rowObject,
  stringColumn,
} from "../../storage/postgres-rows.js";
import type { Address, Hex } from "../../shared/types.js";
import type {
  ConfigVersionRecord,
  IdempotencyRecord,
  OrderDraftRecord,
  OrderInviteRecord,
  OrderRecord,
  OrderStageRecord,
  OrderStageSlotRecord,
} from "./types.js";

export function configRecord(row: unknown): ConfigVersionRecord {
  const record = rowObject(row);
  return {
    configId: stringColumn(record, "config_id"),
    version: stringColumn(record, "version"),
    status: stringColumn(record, "status") as OrderConfigStatusV3,
    configHash: stringColumn(record, "config_hash") as Hex,
    ...(optionalStringColumn(record, "plan_id") !== undefined
      ? { planId: optionalStringColumn(record, "plan_id") as Hex }
      : {}),
    ...(optionalStringColumn(record, "plan_hash") !== undefined
      ? { planHash: optionalStringColumn(record, "plan_hash") as Hex }
      : {}),
    ...(optionalStringColumn(record, "birth_json") !== undefined
      ? { birth: parseStorageJson<NonNullable<ConfigVersionRecord["birth"]>>(optionalStringColumn(record, "birth_json")!) }
      : {}),
    bundle: parseStorageJson<ConfigBundleV3>(stringColumn(record, "bundle_json")),
    createdBy: stringColumn(record, "created_by") as Address,
    createdAt: stringColumn(record, "created_at"),
    ...(optionalStringColumn(record, "published_at") !== undefined
      ? { publishedAt: optionalStringColumn(record, "published_at")! }
      : {}),
    updatedAt: stringColumn(record, "updated_at"),
  };
}

export function draftRecord(row: unknown): OrderDraftRecord {
  const record = rowObject(row);
  return {
    draftId: stringColumn(record, "draft_id"),
    configId: stringColumn(record, "config_id"),
    configVersion: stringColumn(record, "config_version"),
    configHash: stringColumn(record, "config_hash") as Hex,
    buyerWallet: stringColumn(record, "buyer_wallet") as Address,
    chainId: numberColumn(record, "chain_id"),
    stateMachine: stringColumn(record, "state_machine") as Address,
    title: stringColumn(record, "title"),
    currency: stringColumn(record, "currency"),
    stageSubset: parseStorageJson<readonly string[]>(stringColumn(record, "stage_subset_json")),
    status: stringColumn(record, "status") as OrderDraftRecord["status"],
    ...(optionalStringColumn(record, "terms_hash") !== undefined
      ? { termsHash: optionalStringColumn(record, "terms_hash") as Hex }
      : {}),
    ...(optionalStringColumn(record, "finalize_nonce") !== undefined
      ? { finalizeNonce: optionalStringColumn(record, "finalize_nonce")! }
      : {}),
    ...(optionalStringColumn(record, "finalize_deadline") !== undefined
      ? { finalizeDeadline: optionalStringColumn(record, "finalize_deadline")! }
      : {}),
    ...(optionalStringColumn(record, "order_id") !== undefined
      ? { orderId: optionalStringColumn(record, "order_id")! }
      : {}),
    ...(optionalStringColumn(record, "plan_id") !== undefined
      ? { planId: optionalStringColumn(record, "plan_id")! }
      : {}),
    createdAt: stringColumn(record, "created_at"),
    updatedAt: stringColumn(record, "updated_at"),
    ...(optionalStringColumn(record, "frozen_at") !== undefined
      ? { frozenAt: optionalStringColumn(record, "frozen_at")! }
      : {}),
  };
}

export function stageRecord(row: unknown): OrderStageRecord {
  const record = rowObject(row);
  return {
    draftId: stringColumn(record, "draft_id"),
    stageKey: stringColumn(record, "stage_key"),
    stageId: stringColumn(record, "stage_id") as Hex,
    stageIndex: numberColumn(record, "stage_index"),
    amount: stringColumn(record, "amount"),
    slots: parseStorageJson<Readonly<Record<string, Address>>>(stringColumn(record, "slots_json")),
    ...(optionalStringColumn(record, "profile_ref") !== undefined
      ? { profileRef: optionalStringColumn(record, "profile_ref")! }
      : {}),
    ...(optionalStringColumn(record, "standard_json") !== undefined
      ? { standard: parseStorageJson<StageStandardRefV3>(optionalStringColumn(record, "standard_json")!) }
      : {}),
    finalStandardHash: stringColumn(record, "final_standard_hash") as Hex,
    inviteDeadline: stringColumn(record, "invite_deadline"),
    workDeadline: stringColumn(record, "work_deadline"),
    termsHash: stringColumn(record, "terms_hash") as Hex,
    status: stringColumn(record, "status"),
    createdAt: stringColumn(record, "created_at"),
    updatedAt: stringColumn(record, "updated_at"),
  };
}

export function slotRecord(row: unknown): OrderStageSlotRecord {
  const record = rowObject(row);
  return {
    draftId: stringColumn(record, "draft_id"),
    stageKey: stringColumn(record, "stage_key"),
    slotKey: stringColumn(record, "slot_key"),
    required: numberColumn(record, "required") === 1,
    ...(optionalStringColumn(record, "subject_label") !== undefined
      ? { subjectLabel: optionalStringColumn(record, "subject_label")! }
      : {}),
    ...(optionalStringColumn(record, "contact_ref") !== undefined
      ? { contactRef: optionalStringColumn(record, "contact_ref")! }
      : {}),
    ...(optionalStringColumn(record, "wallet") !== undefined
      ? { wallet: optionalStringColumn(record, "wallet") as Address }
      : {}),
    status: stringColumn(record, "status") as OrderStageSlotRecord["status"],
    ...(optionalStringColumn(record, "invite_id") !== undefined
      ? { inviteId: optionalStringColumn(record, "invite_id")! }
      : {}),
    ...(optionalStringColumn(record, "accepted_terms_hash") !== undefined
      ? { acceptedTermsHash: optionalStringColumn(record, "accepted_terms_hash") as Hex }
      : {}),
    ...(optionalStringColumn(record, "accepted_at") !== undefined
      ? { acceptedAt: optionalStringColumn(record, "accepted_at")! }
      : {}),
    ...(optionalStringColumn(record, "signature") !== undefined
      ? { signature: optionalStringColumn(record, "signature") as Hex }
      : {}),
    createdAt: stringColumn(record, "created_at"),
    updatedAt: stringColumn(record, "updated_at"),
  };
}

export function inviteRecord(row: unknown): OrderInviteRecord {
  const record = rowObject(row);
  return {
    inviteId: stringColumn(record, "invite_id"),
    draftId: stringColumn(record, "draft_id"),
    stageKey: stringColumn(record, "stage_key"),
    stageId: stringColumn(record, "stage_id") as Hex,
    slotKey: stringColumn(record, "slot_key"),
    subjectLabel: stringColumn(record, "subject_label"),
    ...(optionalStringColumn(record, "contact_ref") !== undefined
      ? { contactRef: optionalStringColumn(record, "contact_ref")! }
      : {}),
    ...(optionalStringColumn(record, "wallet") !== undefined
      ? { wallet: optionalStringColumn(record, "wallet") as Address }
      : {}),
    tokenHash: stringColumn(record, "token_hash"),
    nonce: stringColumn(record, "nonce"),
    status: stringColumn(record, "status") as OrderInviteRecord["status"],
    expiresAt: stringColumn(record, "expires_at"),
    createdBy: stringColumn(record, "created_by") as Address,
    ...(optionalStringColumn(record, "accepted_by") !== undefined
      ? { acceptedBy: optionalStringColumn(record, "accepted_by") as Address }
      : {}),
    ...(optionalStringColumn(record, "accepted_at") !== undefined
      ? { acceptedAt: optionalStringColumn(record, "accepted_at")! }
      : {}),
    createdAt: stringColumn(record, "created_at"),
    updatedAt: stringColumn(record, "updated_at"),
  };
}

export function orderRecord(row: unknown): OrderRecord {
  const record = rowObject(row);
  return {
    orderId: stringColumn(record, "order_id"),
    draftId: stringColumn(record, "draft_id"),
    planId: stringColumn(record, "plan_id"),
    stateMachine: stringColumn(record, "state_machine") as Address,
    chainId: numberColumn(record, "chain_id"),
    buyerWallet: stringColumn(record, "buyer_wallet") as Address,
    termsHash: stringColumn(record, "terms_hash") as Hex,
    status: stringColumn(record, "status"),
    ...(optionalStringColumn(record, "tx_hash") !== undefined
      ? { txHash: optionalStringColumn(record, "tx_hash") as Hex }
      : {}),
    createdAt: stringColumn(record, "created_at"),
    updatedAt: stringColumn(record, "updated_at"),
  };
}

export function idempotencyRecord(row: unknown): IdempotencyRecord {
  const record = rowObject(row);
  return {
    principalWallet: stringColumn(record, "principal_wallet") as Address,
    operation: stringColumn(record, "operation"),
    idemKey: stringColumn(record, "idem_key"),
    requestHash: stringColumn(record, "request_hash") as Hex,
    ...(optionalStringColumn(record, "resource_id") !== undefined
      ? { resourceId: optionalStringColumn(record, "resource_id")! }
      : {}),
    responseJson: stringColumn(record, "response_json"),
    status: stringColumn(record, "status"),
    createdAt: stringColumn(record, "created_at"),
    expiresAt: stringColumn(record, "expires_at"),
  };
}

