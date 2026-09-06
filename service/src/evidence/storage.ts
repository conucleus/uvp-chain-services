import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { hashEvidenceBytes } from "./hashing.js";

export type EvidenceStorageAdapterKind = "memory" | "local" | "object";
export type EvidenceStorageRuntimeEnvironment = "local" | "testnet" | "staging" | "production";

export interface EvidenceStoragePutInput {
  readonly evidenceId: string;
  readonly bytes: Uint8Array;
}

export interface EvidenceStoragePutResult {
  readonly storageURI: string;
  readonly size: number;
}

export interface EvidenceStorage {
  readonly adapterKind: EvidenceStorageAdapterKind;
  readonly productionSafe: boolean;
  readonly rehearsalOnly?: boolean;
  put(input: EvidenceStoragePutInput): Promise<EvidenceStoragePutResult>;
  get(storageURI: string): Promise<Uint8Array | undefined>;
  exists(storageURI: string): Promise<boolean>;
  delete?(storageURI: string): Promise<void>;
  /**
   * 主/备副本 URI 空间可能不同（不同 bucket、prefix 或 uriMode）。
   * 提供 evidenceId↔storageURI 的双向翻译，让
   * BackupEvidenceStorage 能用主存储的 URI 定位备份对象，而不是假设
   * 两边 URI 字符串相等。返回 undefined 表示该适配器不支持翻译。
   */
  storageURIForEvidenceId?(evidenceId: string): string | undefined;
  evidenceIdForStorageURI?(storageURI: string): string | undefined;
}

export class EvidenceStorageConfigurationError extends Error {
  override readonly name = "EvidenceStorageConfigurationError";
  readonly code = "evidence_storage_not_production_ready";
}

export class InMemoryEvidenceStorage implements EvidenceStorage {
  readonly adapterKind = "memory";
  readonly productionSafe = false;

  readonly #objects = new Map<string, Uint8Array>();

  async put(input: EvidenceStoragePutInput): Promise<EvidenceStoragePutResult> {
    const storageURI = `memory://evidence/${encodeURIComponent(input.evidenceId)}`;
    const bytes = copyBytes(input.bytes);
    this.#objects.set(storageURI, bytes);
    return {
      storageURI,
      size: bytes.byteLength
    };
  }

  async get(storageURI: string): Promise<Uint8Array | undefined> {
    const bytes = this.#objects.get(storageURI);
    return bytes ? copyBytes(bytes) : undefined;
  }

  async exists(storageURI: string): Promise<boolean> {
    return this.#objects.has(storageURI);
  }

  async delete(storageURI: string): Promise<void> {
    this.#objects.delete(storageURI);
  }

  storageURIForEvidenceId(evidenceId: string): string {
    return `memory://evidence/${encodeURIComponent(evidenceId)}`;
  }

  evidenceIdForStorageURI(storageURI: string): string {
    const prefix = "memory://evidence/";
    if (!storageURI.startsWith(prefix)) {
      throw new Error("storageURI is not managed by InMemoryEvidenceStorage");
    }
    return decodeURIComponent(storageURI.slice(prefix.length));
  }
}

export interface LocalEvidenceStorageOptions {
  readonly rootDir?: string;
}

export class LocalEvidenceStorage implements EvidenceStorage {
  readonly adapterKind = "local";
  readonly productionSafe = false;

  readonly #rootDir: string;

  constructor(options: LocalEvidenceStorageOptions = {}) {
    this.#rootDir = resolve(options.rootDir ?? defaultEvidenceStorageRoot());
  }

  async put(input: EvidenceStoragePutInput): Promise<EvidenceStoragePutResult> {
    await mkdir(this.#rootDir, { recursive: true });
    await writeFile(this.pathForStorageURI(storageURIForEvidenceId(input.evidenceId)), input.bytes);
    return {
      storageURI: storageURIForEvidenceId(input.evidenceId),
      size: input.bytes.byteLength
    };
  }

  async get(storageURI: string): Promise<Uint8Array | undefined> {
    try {
      return await readFile(this.pathForStorageURI(storageURI));
    } catch (error) {
      if (isNotFoundError(error)) {
        return undefined;
      }
      throw error;
    }
  }

  async exists(storageURI: string): Promise<boolean> {
    try {
      await readFile(this.pathForStorageURI(storageURI));
      return true;
    } catch (error) {
      if (isNotFoundError(error)) {
        return false;
      }
      throw error;
    }
  }

  async delete(storageURI: string): Promise<void> {
    await rm(this.pathForStorageURI(storageURI), { force: true });
  }

  pathForStorageURI(storageURI: string): string {
    const prefix = "local://evidence/";
    if (!storageURI.startsWith(prefix)) {
      throw new Error("storageURI is not managed by LocalEvidenceStorage");
    }
    const evidenceId = decodeURIComponent(storageURI.slice(prefix.length));
    if (!/^[a-zA-Z0-9._:-]+$/.test(evidenceId)) {
      throw new Error("storageURI evidence id contains unsupported characters");
    }
    return join(this.#rootDir, `${evidenceId}.bin`);
  }

  storageURIForEvidenceId(evidenceId: string): string {
    return storageURIForEvidenceId(evidenceId);
  }

  evidenceIdForStorageURI(storageURI: string): string {
    const prefix = "local://evidence/";
    if (!storageURI.startsWith(prefix)) {
      throw new Error("storageURI is not managed by LocalEvidenceStorage");
    }
    const evidenceId = decodeURIComponent(storageURI.slice(prefix.length));
    if (!/^[a-zA-Z0-9._:-]+$/.test(evidenceId)) {
      throw new Error("storageURI evidence id contains unsupported characters");
    }
    return evidenceId;
  }
}

export interface ObjectEvidenceStorageClient {
  put(input: EvidenceStoragePutInput): Promise<EvidenceStoragePutResult>;
  get(storageURI: string): Promise<Uint8Array | undefined>;
  exists(storageURI: string): Promise<boolean>;
  delete?(storageURI: string): Promise<void>;
  /** 主/备 URI 空间翻译（bucket/prefix/uriMode 不同时定位对象）。 */
  storageURIForEvidenceId?(evidenceId: string): string;
  evidenceIdForStorageURI?(storageURI: string): string;
}

export interface ObjectEvidenceStorageOptions {
  readonly client: ObjectEvidenceStorageClient;
  readonly productionSafe?: boolean;
}

export class ObjectEvidenceStorage implements EvidenceStorage {
  readonly adapterKind = "object";
  readonly productionSafe: boolean;

  readonly #client: ObjectEvidenceStorageClient;

  constructor(options: ObjectEvidenceStorageOptions) {
    this.#client = options.client;
    this.productionSafe = options.productionSafe ?? true;
  }

  async put(input: EvidenceStoragePutInput): Promise<EvidenceStoragePutResult> {
    const result = await this.#client.put({
      evidenceId: input.evidenceId,
      bytes: copyBytes(input.bytes)
    });
    if (this.productionSafe) {
      assertProductionStorageURI(result.storageURI);
    }
    return {
      storageURI: result.storageURI,
      size: result.size
    };
  }

  async get(storageURI: string): Promise<Uint8Array | undefined> {
    const bytes = await this.#client.get(storageURI);
    return bytes ? copyBytes(bytes) : undefined;
  }

  async exists(storageURI: string): Promise<boolean> {
    return this.#client.exists(storageURI);
  }

  async delete(storageURI: string): Promise<void> {
    if (this.#client.delete) {
      await this.#client.delete(storageURI);
    }
  }

  storageURIForEvidenceId(evidenceId: string): string | undefined {
    return this.#client.storageURIForEvidenceId?.(evidenceId);
  }

  evidenceIdForStorageURI(storageURI: string): string | undefined {
    return this.#client.evidenceIdForStorageURI?.(storageURI);
  }
}

export interface BackupEvidenceStorageOptions {
  readonly primary: EvidenceStorage;
  /** 第二副本存储：UVP_EVIDENCE_BACKUP_BUCKET 指定的第二 bucket（或同 bucket 备份前缀）。 */
  readonly backup: EvidenceStorage;
}

export interface EvidenceBackupVerifyResult {
  readonly backupPresent: boolean;
  readonly hashMatches: boolean;
}

/**
 * 证据第二副本。put 成功后立即写第二副本；备份写入失败按整体
 * 失败处理（上抛），不允许"主存成功、副本静默丢失"。提供按 hash 校验与
 * 从副本恢复主对象的能力。
 */
export class BackupEvidenceStorage implements EvidenceStorage {
  readonly adapterKind: EvidenceStorageAdapterKind;
  readonly productionSafe: boolean;
  readonly rehearsalOnly?: boolean;

  readonly #primary: EvidenceStorage;
  readonly #backup: EvidenceStorage;

  constructor(options: BackupEvidenceStorageOptions) {
    this.#primary = options.primary;
    this.#backup = options.backup;
    this.adapterKind = options.primary.adapterKind;
    this.productionSafe = options.primary.productionSafe;
    if (options.primary.rehearsalOnly) {
      this.rehearsalOnly = options.primary.rehearsalOnly;
    }
  }

  async put(input: EvidenceStoragePutInput): Promise<EvidenceStoragePutResult> {
    const result = await this.#primary.put(input);
    // 副本写入失败必须上抛：调用方（evidence service）尚未落 metadata，
    // 重试/告警仍能补救；静默吞掉会制造"看起来有副本"的假象。
    await this.#backup.put({ evidenceId: input.evidenceId, bytes: copyBytes(input.bytes) });
    return result;
  }

  async get(storageURI: string): Promise<Uint8Array | undefined> {
    return this.#primary.get(storageURI);
  }

  async exists(storageURI: string): Promise<boolean> {
    return this.#primary.exists(storageURI);
  }

  async delete(storageURI: string): Promise<void> {
    const primaryDelete = this.#primary.delete;
    if (primaryDelete) {
      await primaryDelete.call(this.#primary, storageURI);
    }
    const backupDelete = this.#backup.delete;
    if (backupDelete) {
      await backupDelete.call(this.#backup, this.backupURIFor(storageURI));
    }
  }

  /**
   * 主存储 URI → 备份存储 URI 的翻译。主/备
   * bucket、prefix 或 uriMode 不同时，两边 URI 字符串不相等——直接把
   * 主 URI 喂给备份适配器会抛 "storageURI is not managed by ..."。
   * 翻译链：primary.evidenceIdForStorageURI →
   * backup.storageURIForEvidenceId；适配器不支持翻译时退回原 URI（同
   * URI 空间的内存/本地存储场景）。
   */
  backupURIFor(storageURI: string, evidenceId?: string): string {
    const primaryTranslate = this.#primary.evidenceIdForStorageURI;
    const backupTranslate = this.#backup.storageURIForEvidenceId;
    if (!primaryTranslate || !backupTranslate) {
      return storageURI;
    }
    const id = evidenceId ?? primaryTranslate.call(this.#primary, storageURI);
    if (id === undefined) {
      return storageURI;
    }
    return backupTranslate.call(this.#backup, id) ?? storageURI;
  }

  /** 读取第二副本并按期望 hash 校验（链上/库内 contentHash，keccak256）。 */
  async verifyBackup(storageURI: string, expectedContentHash: string): Promise<EvidenceBackupVerifyResult> {
    const bytes = await this.#backup.get(this.backupURIFor(storageURI));
    if (!bytes) {
      return { backupPresent: false, hashMatches: false };
    }
    return {
      backupPresent: true,
      hashMatches: hashEvidenceBytes(bytes, "backup.contentHash") === expectedContentHash.toLowerCase()
    };
  }

  /**
   * 主对象损坏/缺失时从第二副本恢复：副本字节摘要必须与期望 hash 一致
   * 才允许写回主存储；成功返回 true。
   */
  async restoreFromBackup(storageURI: string, evidenceId: string, expectedContentHash: string): Promise<boolean> {
    const bytes = await this.#backup.get(this.backupURIFor(storageURI, evidenceId));
    if (!bytes) {
      return false;
    }
    if (hashEvidenceBytes(bytes, "backup.contentHash") !== expectedContentHash.toLowerCase()) {
      return false;
    }
    await this.#primary.put({ evidenceId, bytes });
    return true;
  }

  get backupStorage(): EvidenceStorage {
    return this.#backup;
  }
}

export function assertEvidenceStorageProductionBoundary(
  storage: EvidenceStorage,
  environment: EvidenceStorageRuntimeEnvironment
): void {
  if (environment === "local") {
    return;
  }
  if (storage.adapterKind !== "object" || !storage.productionSafe) {
    throw new EvidenceStorageConfigurationError(
      `${environment} evidence storage requires a production-safe object adapter; ${storage.adapterKind} is non-production only`
    );
  }
  if ((environment === "staging" || environment === "production") && storage.rehearsalOnly) {
    throw new EvidenceStorageConfigurationError(
      `${environment} evidence storage requires a real object adapter; rehearsal object storage is testnet-only`
    );
  }
}

export function assertProductionStorageURI(storageURI: string): void {
  if (/^https?:\/\//i.test(storageURI)) {
    throw new EvidenceStorageConfigurationError("production-like evidence storageURI must not be an HTTP URL or presigned download URL");
  }
  if (/^[^:/?#]+:\/\/[^?#]*[?#]/.test(storageURI)) {
    throw new EvidenceStorageConfigurationError("production-like evidence storageURI must not contain query strings or fragments");
  }
  if (/[?&](x-amz-signature|x-amz-credential|x-goog-signature|x-goog-credential|awsaccesskeyid|access_token|signature|sig)=/i.test(storageURI)) {
    throw new EvidenceStorageConfigurationError("production-like evidence storageURI must not contain private bucket credentials");
  }
  if (/^[^:/?#]+:\/\/[^/?#]*@/.test(storageURI)) {
    throw new EvidenceStorageConfigurationError("production-like evidence storageURI must not contain embedded credentials");
  }
}

export function defaultEvidenceStorageRoot(): string {
  return process.env.UVP_EVIDENCE_STORAGE_DIR ?? resolve(process.cwd(), "cache", "evidence");
}

function storageURIForEvidenceId(evidenceId: string): string {
  return `local://evidence/${encodeURIComponent(evidenceId)}`;
}

function copyBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
