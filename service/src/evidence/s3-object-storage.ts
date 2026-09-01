import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { Readable } from "node:stream";
import {
  assertProductionStorageURI,
  EvidenceStorageConfigurationError,
  type EvidenceStoragePutInput,
  type EvidenceStoragePutResult,
  type ObjectEvidenceStorageClient
} from "./storage.js";

export type S3EvidenceStorageURIMode = "s3" | "object";

export interface S3EvidenceStorageClientOptions {
  readonly bucket: string;
  readonly prefix?: string;
  readonly region: string;
  readonly endpoint?: string;
  readonly forcePathStyle?: boolean;
  readonly accessKeyIdEnv: string;
  readonly secretAccessKeyEnv: string;
  /** Optional name of the env variable holding an STS session token; required to be populated when set (audit #19). */
  readonly sessionTokenEnv?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly objectClient?: S3CompatibleObjectClient;
  readonly uriMode?: S3EvidenceStorageURIMode;
  readonly objectNamespace?: string;
}

export interface S3ObjectOperationInput {
  readonly bucket: string;
  readonly key: string;
}

export interface S3ObjectPutOperationInput extends S3ObjectOperationInput {
  readonly bytes: Uint8Array;
}

export interface S3CompatibleObjectClient {
  putObject(input: S3ObjectPutOperationInput): Promise<void>;
  getObject(input: S3ObjectOperationInput): Promise<Uint8Array | undefined>;
  headObject(input: S3ObjectOperationInput): Promise<boolean>;
  deleteObject(input: S3ObjectOperationInput): Promise<void>;
}

export class S3EvidenceStorageClient implements ObjectEvidenceStorageClient {
  readonly #bucket: string;
  readonly #prefix: string;
  readonly #objectClient: S3CompatibleObjectClient;
  readonly #uriMode: S3EvidenceStorageURIMode;
  readonly #objectNamespace: string | undefined;

  constructor(options: S3EvidenceStorageClientOptions) {
    this.#bucket = normalizeBucket(options.bucket);
    this.#prefix = normalizeObjectPrefix(options.prefix);
    const region = normalizeRequiredLabel(options.region, "UVP_EVIDENCE_S3_REGION");
    const endpoint = normalizeEndpoint(options.endpoint);
    const accessKeyIdEnv = normalizeCredentialEnvName(
      options.accessKeyIdEnv,
      "UVP_EVIDENCE_S3_ACCESS_KEY_ID_ENV"
    );
    const secretAccessKeyEnv = normalizeCredentialEnvName(
      options.secretAccessKeyEnv,
      "UVP_EVIDENCE_S3_SECRET_ACCESS_KEY_ENV"
    );
    const env = options.env ?? process.env;
    const accessKeyId = readCredentialValue(env, accessKeyIdEnv, "UVP_EVIDENCE_S3_ACCESS_KEY_ID_ENV");
    const secretAccessKey = readCredentialValue(env, secretAccessKeyEnv, "UVP_EVIDENCE_S3_SECRET_ACCESS_KEY_ENV");
    // Audit #19: a configured STS session-token env must resolve here, at
    // construction time. Skipping it used to produce a client that passed
    // preflight but failed every first upload/read with a credential 403.
    const sessionToken = options.sessionTokenEnv
      ? readCredentialValue(
          env,
          normalizeCredentialEnvName(options.sessionTokenEnv, "UVP_EVIDENCE_S3_SESSION_TOKEN_ENV"),
          "UVP_EVIDENCE_S3_SESSION_TOKEN_ENV"
        )
      : undefined;
    this.#uriMode = options.uriMode ?? "s3";
    this.#objectNamespace = this.#uriMode === "object"
      ? normalizeObjectNamespace(options.objectNamespace)
      : undefined;
    this.#objectClient = options.objectClient ?? new AwsS3CompatibleObjectClient({
      region,
      ...(endpoint ? { endpoint } : {}),
      forcePathStyle: options.forcePathStyle ?? false,
      accessKeyId,
      secretAccessKey,
      ...(sessionToken ? { sessionToken } : {})
    });
    assertProductionStorageURI(this.storageURIForKey(this.objectKeyForEvidenceId("ev_probe")));
  }

  async put(input: EvidenceStoragePutInput): Promise<EvidenceStoragePutResult> {
    const key = this.objectKeyForEvidenceId(input.evidenceId);
    const bytes = copyBytes(input.bytes);
    await this.#objectClient.putObject({
      bucket: this.#bucket,
      key,
      bytes
    });
    const storageURI = this.storageURIForKey(key);
    assertProductionStorageURI(storageURI);
    return {
      storageURI,
      size: bytes.byteLength
    };
  }

  async get(storageURI: string): Promise<Uint8Array | undefined> {
    const key = this.objectKeyForStorageURI(storageURI);
    const bytes = await this.#objectClient.getObject({
      bucket: this.#bucket,
      key
    });
    return bytes ? copyBytes(bytes) : undefined;
  }

  async exists(storageURI: string): Promise<boolean> {
    const key = this.objectKeyForStorageURI(storageURI);
    return this.#objectClient.headObject({
      bucket: this.#bucket,
      key
    });
  }

  async delete(storageURI: string): Promise<void> {
    const key = this.objectKeyForStorageURI(storageURI);
    await this.#objectClient.deleteObject({
      bucket: this.#bucket,
      key
    });
  }

  private objectKeyForEvidenceId(value: string): string {
    const evidenceId = normalizeEvidenceObjectId(value);
    return this.#prefix ? `${this.#prefix}/${evidenceId}` : evidenceId;
  }

  private storageURIForKey(key: string): string {
    if (this.#uriMode === "object") {
      return `object://${this.#objectNamespace}/${key}`;
    }
    return `s3://${this.#bucket}/${key}`;
  }

  private objectKeyForStorageURI(storageURI: string): string {
    assertProductionStorageURI(storageURI);
    const prefix = this.#uriMode === "object"
      ? `object://${this.#objectNamespace}/`
      : `s3://${this.#bucket}/`;
    if (!storageURI.startsWith(prefix)) {
      throw new Error("storageURI is not managed by S3EvidenceStorageClient");
    }
    const key = storageURI.slice(prefix.length);
    if (this.#prefix && !key.startsWith(`${this.#prefix}/`)) {
      throw new Error("storageURI is not managed by S3EvidenceStorageClient");
    }
    const evidenceId = this.#prefix ? key.slice(this.#prefix.length + 1) : key;
    normalizeEvidenceObjectId(evidenceId);
    return key;
  }
}

export interface AwsS3CompatibleObjectClientOptions {
  readonly region: string;
  readonly endpoint?: string;
  readonly forcePathStyle: boolean;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

export class AwsS3CompatibleObjectClient implements S3CompatibleObjectClient {
  readonly #client: S3Client;

  constructor(options: AwsS3CompatibleObjectClientOptions) {
    this.#client = new S3Client({
      region: options.region,
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
      forcePathStyle: options.forcePathStyle,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
        ...(options.sessionToken ? { sessionToken: options.sessionToken } : {})
      }
    });
  }

  async putObject(input: S3ObjectPutOperationInput): Promise<void> {
    await this.#client.send(new PutObjectCommand({
      Bucket: input.bucket,
      Key: input.key,
      Body: Buffer.from(input.bytes)
    }));
  }

  async getObject(input: S3ObjectOperationInput): Promise<Uint8Array | undefined> {
    try {
      const response = await this.#client.send(new GetObjectCommand({
        Bucket: input.bucket,
        Key: input.key
      }));
      return bytesFromBody(response.Body);
    } catch (error) {
      if (isObjectNotFoundError(error)) {
        return undefined;
      }
      throw error;
    }
  }

  async headObject(input: S3ObjectOperationInput): Promise<boolean> {
    try {
      await this.#client.send(new HeadObjectCommand({
        Bucket: input.bucket,
        Key: input.key
      }));
      return true;
    } catch (error) {
      if (isObjectNotFoundError(error)) {
        return false;
      }
      throw error;
    }
  }

  async deleteObject(input: S3ObjectOperationInput): Promise<void> {
    await this.#client.send(new DeleteObjectCommand({
      Bucket: input.bucket,
      Key: input.key
    }));
  }
}

function normalizeBucket(value: string): string {
  const bucket = normalizeRequiredLabel(value, "UVP_EVIDENCE_S3_BUCKET");
  if (
    bucket.length > 255 ||
    bucket.includes("/") ||
    bucket.includes("@") ||
    bucket.includes("?") ||
    bucket.includes("#") ||
    /^[^:/?#]+:\/\//.test(bucket) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/.test(bucket)
  ) {
    throw new EvidenceStorageConfigurationError("UVP_EVIDENCE_S3_BUCKET must be a private bucket name, not a URL");
  }
  return bucket;
}

function normalizeObjectPrefix(value: string | undefined): string {
  const prefix = (value ?? "").trim().replace(/^\/+|\/+$/g, "");
  if (!prefix) {
    return "";
  }
  if (
    prefix.includes("\\") ||
    prefix.includes("@") ||
    prefix.includes("?") ||
    prefix.includes("#") ||
    prefix.includes("//") ||
    /(^|\/)\.\.?(\/|$)/.test(prefix) ||
    /^[^:/?#]+:\/\//.test(prefix) ||
    !/^[a-zA-Z0-9._:/-]+$/.test(prefix)
  ) {
    throw new EvidenceStorageConfigurationError("UVP_EVIDENCE_S3_PREFIX must be a private object key prefix");
  }
  return prefix;
}

function normalizeObjectNamespace(value: string | undefined): string {
  const namespace = normalizeRequiredLabel(value, "UVP_EVIDENCE_S3_OBJECT_NAMESPACE");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,126}$/.test(namespace)) {
    throw new EvidenceStorageConfigurationError("UVP_EVIDENCE_S3_OBJECT_NAMESPACE must be a private object namespace label");
  }
  return namespace;
}

function normalizeCredentialEnvName(value: string, fieldName: string): string {
  const envName = normalizeRequiredLabel(value, fieldName);
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(envName)) {
    throw new EvidenceStorageConfigurationError(`${fieldName} must name an environment variable`);
  }
  return envName;
}

function readCredentialValue(
  env: Readonly<Record<string, string | undefined>>,
  envName: string,
  fieldName: string
): string {
  const value = env[envName];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new EvidenceStorageConfigurationError(`${fieldName} must name a populated environment variable`);
  }
  return value;
}

function normalizeEndpoint(value: string | undefined): string | undefined {
  const endpoint = value?.trim();
  if (!endpoint) {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new EvidenceStorageConfigurationError("UVP_EVIDENCE_S3_ENDPOINT must be an HTTP(S) S3-compatible endpoint");
  }
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== "" && parsed.pathname !== "/")
  ) {
    throw new EvidenceStorageConfigurationError("UVP_EVIDENCE_S3_ENDPOINT must not contain credentials, paths, query strings, or fragments");
  }
  return endpoint;
}

function normalizeRequiredLabel(value: string | undefined, fieldName: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new EvidenceStorageConfigurationError(`${fieldName} is required`);
  }
  return normalized;
}

function normalizeEvidenceObjectId(value: string): string {
  const evidenceId = value.trim();
  if (!/^[a-zA-Z0-9._:-]+$/.test(evidenceId)) {
    throw new Error("evidence object id contains unsupported characters");
  }
  return evidenceId;
}

async function bytesFromBody(body: unknown): Promise<Uint8Array> {
  if (!body) {
    return new Uint8Array();
  }
  if (body instanceof Uint8Array) {
    return copyBytes(body);
  }
  if (typeof body === "string") {
    return new TextEncoder().encode(body);
  }
  const transformable = body as { readonly transformToByteArray?: () => Promise<Uint8Array> };
  if (typeof transformable.transformToByteArray === "function") {
    return copyBytes(await transformable.transformToByteArray());
  }
  if (body instanceof Readable) {
    return readNodeStream(body);
  }
  if (isAsyncIterable(body)) {
    return readAsyncIterable(body);
  }
  throw new Error("S3 GetObject response body is not readable");
}

async function readNodeStream(stream: Readable): Promise<Uint8Array> {
  return readAsyncIterable(stream);
}

async function readAsyncIterable(iterable: AsyncIterable<Uint8Array | Buffer | string>): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of iterable) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function isAsyncIterable(value: unknown): value is AsyncIterable<Uint8Array | Buffer | string> {
  return typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value;
}

function copyBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

function isObjectNotFoundError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const named = error as { readonly name?: string; readonly $metadata?: { readonly httpStatusCode?: number } };
  return named.$metadata?.httpStatusCode === 404 ||
    named.name === "NoSuchKey" ||
    named.name === "NotFound" ||
    named.name === "NotFoundError";
}
