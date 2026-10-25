import { randomUUID } from "node:crypto";
import { canonicalStringify } from "@uvp-eth/compiler";
import { normalizeBytes32, type Hex } from "../shared/types.js";
import { hashIdentityDescriptor, type IdentityDescriptorHashInput } from "./hashing.js";

// 身份配对的 descriptor 托管：审核通过的档案在 registerIdentity 时以
// "被哈希的原文"形式追加为 append-only 快照，descriptorURI 指向 Store
// 托管端点，内容按 descriptorHash 锁定可重算验证。

export interface StoreIdentityDescriptorSnapshotRecord {
  readonly snapshotId: string;
  readonly subjectId: Hex;
  readonly descriptorHash: Hex;
  readonly descriptorDocument: unknown;
  readonly source: string;
  readonly createdBy: string;
  readonly createdAt: string;
}

export interface StoreIdentityDescriptorSnapshotStore {
  appendSnapshot(record: StoreIdentityDescriptorSnapshotRecord): Promise<void>;
  findSnapshot(subjectId: Hex, descriptorHash: Hex): Promise<StoreIdentityDescriptorSnapshotRecord | undefined>;
  listSnapshots(subjectId: Hex): Promise<readonly StoreIdentityDescriptorSnapshotRecord[]>;
}

export interface IdentityDescriptorSnapshotDTO {
  readonly subjectId: Hex;
  readonly descriptorHash: Hex;
  readonly hashScheme: "keccak256-canonical-json:identityDescriptor:v1";
  readonly descriptor: unknown;
  readonly descriptorJson: string;
  readonly verification: {
    readonly recomputedDescriptorHash: Hex;
    readonly matches: boolean;
  };
  readonly source: string;
  readonly createdAt: string;
}

export interface IdentityDescriptorSnapshotSummaryDTO {
  readonly subjectId: Hex;
  readonly descriptorHash: Hex;
  readonly source: string;
  readonly createdAt: string;
}

export class GovernanceDescriptorError extends Error {
  override readonly name = "GovernanceDescriptorError";

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
  }
}

export async function persistIdentityDescriptorSnapshot(options: {
  readonly store: StoreIdentityDescriptorSnapshotStore;
  readonly subjectId: Hex;
  readonly descriptorInput: IdentityDescriptorHashInput;
  readonly descriptorHash: Hex;
  readonly createdBy: string;
  readonly now: () => Date;
}): Promise<StoreIdentityDescriptorSnapshotRecord> {
  const existing = await options.store.findSnapshot(options.subjectId, options.descriptorHash);
  if (existing) {
    return existing;
  }
  const record: StoreIdentityDescriptorSnapshotRecord = {
    snapshotId: `desc_${randomUUID()}`,
    subjectId: options.subjectId,
    descriptorHash: options.descriptorHash,
    descriptorDocument: options.descriptorInput,
    source: "register_identity",
    createdBy: options.createdBy,
    createdAt: options.now().toISOString()
  };
  await options.store.appendSnapshot(record);
  return record;
}

export function buildDescriptorPublicUri(publicBaseUrl: string, subjectId: Hex, descriptorHash: Hex): string {
  const base = publicBaseUrl.replace(/\/+$/, "");
  return `${base}/identity/descriptors/${subjectId}/${descriptorHash}`;
}

export async function readIdentityDescriptorSnapshot(
  store: StoreIdentityDescriptorSnapshotStore,
  subjectIdRaw: string,
  descriptorHashRaw: string
): Promise<IdentityDescriptorSnapshotDTO> {
  const subjectId = normalizeDescriptorId(subjectIdRaw, "subjectId");
  const descriptorHash = normalizeDescriptorId(descriptorHashRaw, "descriptorHash");
  const snapshot = await store.findSnapshot(subjectId, descriptorHash);
  if (!snapshot) {
    throw new GovernanceDescriptorError(404, "descriptor_snapshot_not_found", "no descriptor snapshot matches this subject and hash");
  }
  const descriptorJson = canonicalStringify(snapshot.descriptorDocument);
  const recomputedDescriptorHash = hashIdentityDescriptor(snapshot.descriptorDocument as IdentityDescriptorHashInput);
  return {
    subjectId: snapshot.subjectId,
    descriptorHash: snapshot.descriptorHash,
    hashScheme: "keccak256-canonical-json:identityDescriptor:v1",
    descriptor: snapshot.descriptorDocument,
    descriptorJson,
    verification: {
      recomputedDescriptorHash,
      matches: recomputedDescriptorHash.toLowerCase() === snapshot.descriptorHash.toLowerCase()
    },
    source: snapshot.source,
    createdAt: snapshot.createdAt
  };
}

export async function listIdentityDescriptorSnapshots(
  store: StoreIdentityDescriptorSnapshotStore,
  subjectIdRaw: string
): Promise<{ readonly subjectId: Hex; readonly snapshots: readonly IdentityDescriptorSnapshotSummaryDTO[] }> {
  const subjectId = normalizeDescriptorId(subjectIdRaw, "subjectId");
  const snapshots = await store.listSnapshots(subjectId);
  return {
    subjectId,
    snapshots: snapshots.map((snapshot) => ({
      subjectId: snapshot.subjectId,
      descriptorHash: snapshot.descriptorHash,
      source: snapshot.source,
      createdAt: snapshot.createdAt
    }))
  };
}

function normalizeDescriptorId(value: string, field: string): Hex {
  try {
    return normalizeBytes32(value, field);
  } catch (error) {
    throw new GovernanceDescriptorError(400, "invalid_descriptor_id", `${field} must be a bytes32 hex value`);
  }
}
