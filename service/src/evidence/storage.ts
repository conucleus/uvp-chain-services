import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

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
}

export interface ObjectEvidenceStorageClient {
  put(input: EvidenceStoragePutInput): Promise<EvidenceStoragePutResult>;
  get(storageURI: string): Promise<Uint8Array | undefined>;
  exists(storageURI: string): Promise<boolean>;
  delete?(storageURI: string): Promise<void>;
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
