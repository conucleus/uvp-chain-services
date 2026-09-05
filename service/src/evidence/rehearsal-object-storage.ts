import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  assertProductionStorageURI,
  EvidenceStorageConfigurationError,
  type EvidenceStorage,
  type EvidenceStoragePutInput,
  type EvidenceStoragePutResult
} from "./storage.js";

export interface RehearsalObjectEvidenceStorageOptions {
  readonly rootDir?: string;
  readonly namespace?: string;
}

const DEFAULT_NAMESPACE = "uvp-rehearsal";

export class RehearsalObjectEvidenceStorage implements EvidenceStorage {
  readonly adapterKind = "object";
  readonly productionSafe = true;
  readonly rehearsalOnly = true;

  readonly #rootDir: string;
  readonly #namespace: string;

  constructor(options: RehearsalObjectEvidenceStorageOptions = {}) {
    this.#namespace = normalizeObjectNamespace(options.namespace ?? DEFAULT_NAMESPACE);
    this.#rootDir = resolve(options.rootDir ?? defaultRehearsalObjectStorageRoot());
    assertProductionStorageURI(`object://${this.#namespace}/`);
  }

  async put(input: EvidenceStoragePutInput): Promise<EvidenceStoragePutResult> {
    const evidenceId = normalizeEvidenceObjectId(input.evidenceId);
    const storageURI = this.storageURIForEvidenceId(evidenceId);
    await mkdir(this.#rootDir, { recursive: true });
    await writeFile(this.pathForStorageURI(storageURI), input.bytes);
    return {
      storageURI,
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
      await stat(this.pathForStorageURI(storageURI));
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
    const prefix = `object://${this.#namespace}/`;
    if (!storageURI.startsWith(prefix)) {
      throw new Error("storageURI is not managed by RehearsalObjectEvidenceStorage");
    }
    const evidenceId = normalizeEvidenceObjectId(decodeURIComponent(storageURI.slice(prefix.length)));
    return join(this.#rootDir, `${evidenceId}.bin`);
  }

  // EvidenceStorage 的可选翻译方法；BackupEvidenceStorage 的主/备 URI
  // 空间翻译需要它。
  storageURIForEvidenceId(evidenceId: string): string {
    return `object://${this.#namespace}/${encodeURIComponent(evidenceId)}`;
  }
}

/**
 * The default root must be stable across restarts. Evidence
 * metadata references bytes under this root, so a per-process directory
 * (timestamp or pid) breaks every stored storageURI after a restart. Deployments
 * that need a different location set UVP_EVIDENCE_OBJECT_ROOT_DIR explicitly.
 */
export function defaultRehearsalObjectStorageRoot(): string {
  return resolve(process.cwd(), "data", "evidence-object");
}

function normalizeObjectNamespace(value: string): string {
  const namespace = value.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,126}$/.test(namespace)) {
    throw new EvidenceStorageConfigurationError(
      "UVP_EVIDENCE_OBJECT_NAMESPACE must be a private object namespace label"
    );
  }
  return namespace;
}

function normalizeEvidenceObjectId(value: string): string {
  const evidenceId = value.trim();
  if (!/^[a-zA-Z0-9._:-]+$/.test(evidenceId)) {
    throw new Error("evidence object id contains unsupported characters");
  }
  return evidenceId;
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
