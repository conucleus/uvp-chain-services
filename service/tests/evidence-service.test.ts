import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BackupEvidenceStorage,
  buildPayloadHashDocument,
  createEvidenceService,
  EvidenceServiceError,
  EvidenceStorageConfigurationError,
  hashEvidenceBytes,
  hashEvidencePayload,
  InMemoryEvidenceMetadataStore,
  InMemoryEvidenceStorage,
  LocalEvidenceStorage,
  ObjectEvidenceStorage,
  RehearsalObjectEvidenceStorage,
  defaultRehearsalObjectStorageRoot,
  S3EvidenceStorageClient,
  type EvidenceStorage,
  type S3CompatibleObjectClient,
  type S3ObjectOperationInput,
  type S3ObjectPutOperationInput,
  type EvidencePrincipal,
  type EvidenceUploadResponseDTO
} from "../src/evidence/index.js";

const owner: EvidencePrincipal = { id: "seller", role: "participant" };
const tempDirs: string[] = [];

describe("evidence service", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("generates stable hashes from canonical JSON metadata and payload content", async () => {
    const service = testEvidenceService();
    const first = await uploadJsonEvidence(service, {
      fileName: "packing-list-a.json",
      content: { z: 2, a: { c: 3, b: 1 } },
      metadataFields: { invoice: "INV-1", amount: 100 }
    });
    const second = await uploadJsonEvidence(service, {
      fileName: "renamed.json",
      content: { a: { b: 1, c: 3 }, z: 2 },
      metadataFields: { amount: 100, invoice: "INV-1" }
    });

    expect(first.evidence.contentHash).toBe(second.evidence.contentHash);
    expect(first.evidence.metadataHash).toBe(second.evidence.metadataHash);
    expect(first.evidence.payloadHash).toBe(second.evidence.payloadHash);
    expect(first.evidence.evidenceId).not.toBe(second.evidence.evidenceId);
    expect(first.evidence.fileName).not.toBe(second.evidence.fileName);
    expect(first.evidence.payloadHash).toBe(hashEvidencePayload({
      contentHash: first.evidence.contentHash,
      metadataHash: first.evidence.metadataHash,
      documentType: first.metadata.documentType,
      ...(first.evidence.orderId ? { orderId: first.evidence.orderId } : {}),
      stageIdentifier: first.evidence.stageIdentifier
    }));
    expect(buildPayloadHashDocument({
      contentHash: first.evidence.contentHash,
      metadataHash: first.evidence.metadataHash,
      documentType: first.metadata.documentType,
      ...(first.evidence.orderId ? { orderId: first.evidence.orderId } : {}),
      stageIdentifier: first.evidence.stageIdentifier
    })).not.toHaveProperty("fileName");
    expect(buildPayloadHashDocument({
      contentHash: first.evidence.contentHash,
      metadataHash: first.evidence.metadataHash,
      documentType: first.metadata.documentType,
      ...(first.evidence.orderId ? { orderId: first.evidence.orderId } : {}),
      stageIdentifier: first.evidence.stageIdentifier
    })).not.toHaveProperty("evidenceId");
  });

  it("changes metadataHash and payloadHash when canonical metadata changes", async () => {
    const service = testEvidenceService();
    const first = await uploadTextEvidence(service, { invoice: "INV-1" });
    const second = await uploadTextEvidence(service, { invoice: "INV-2" });

    expect(first.evidence.contentHash).toBe(second.evidence.contentHash);
    expect(first.evidence.metadataHash).not.toBe(second.evidence.metadataHash);
    expect(first.evidence.payloadHash).not.toBe(second.evidence.payloadHash);
  });

  it("keeps metadataHash stable while payloadHash changes for order or stage binding changes", async () => {
    const service = testEvidenceService();
    const first = await uploadTextEvidence(service, { invoice: "INV-1" });
    const differentOrder = await service.uploadEvidence({
      orderId: "order-2",
      taskId: "task-1",
      stageIdentifier: "export-documents",
      documentType: "invoice",
      fileName: "invoice.txt",
      textPayload: "invoice payload",
      metadata: {
        businessLabel: "Commercial invoice",
        fields: { invoice: "INV-1" }
      }
    }, owner);
    const differentStage = await service.uploadEvidence({
      orderId: "order-1",
      taskId: "task-1",
      stageIdentifier: "customs-complete",
      documentType: "invoice",
      fileName: "invoice.txt",
      textPayload: "invoice payload",
      metadata: {
        businessLabel: "Commercial invoice",
        fields: { invoice: "INV-1" }
      }
    }, owner);

    expect(first.evidence.contentHash).toBe(differentOrder.evidence.contentHash);
    expect(first.evidence.metadataHash).toBe(differentOrder.evidence.metadataHash);
    expect(first.evidence.payloadHash).not.toBe(differentOrder.evidence.payloadHash);
    expect(first.evidence.metadataHash).toBe(differentStage.evidence.metadataHash);
    expect(first.evidence.payloadHash).not.toBe(differentStage.evidence.payloadHash);
  });

  it("changes contentHash and payloadHash when file bytes change", async () => {
    const service = testEvidenceService();
    const first = await uploadTextEvidence(service, { invoice: "INV-1" });
    const second = await service.uploadEvidence({
      orderId: "order-1",
      taskId: "task-1",
      stageIdentifier: "export-documents",
      documentType: "invoice",
      fileName: "invoice.txt",
      textPayload: "different invoice payload",
      metadata: {
        businessLabel: "Commercial invoice",
        fields: { invoice: "INV-1" }
      }
    }, owner);

    expect(first.evidence.metadataHash).toBe(second.evidence.metadataHash);
    expect(first.evidence.contentHash).not.toBe(second.evidence.contentHash);
    expect(first.evidence.payloadHash).not.toBe(second.evidence.payloadHash);
  });

  it("enforces owner, participant, adjudicator, admin, and outsider read rules", async () => {
    const metadataStore = new InMemoryEvidenceMetadataStore();
    const service = createEvidenceService({
      metadataStore,
      storage: new InMemoryEvidenceStorage(),
      now: () => new Date("2026-04-28T00:00:00Z")
    });
    const upload = await service.uploadEvidence({
      orderId: "order-1",
      taskId: "task-1",
      stageIdentifier: "export-documents",
      documentType: "invoice",
      textPayload: "paid",
      accessPolicy: {
        readers: ["buyer", "reviewer-1"],
        adminReaders: ["ops"],
        disputeReaders: ["arbiter-1"]
      }
    }, owner);

    await expect(service.getEvidence(upload.evidence.evidenceId, owner)).resolves.toBeDefined();
    await expect(service.getEvidence(upload.evidence.evidenceId, { id: "buyer", role: "participant" })).resolves.toBeDefined();
    await expect(service.getEvidence(upload.evidence.evidenceId, { id: "reviewer-1", role: "participant" })).resolves.toBeDefined();
    await expect(service.getEvidence(upload.evidence.evidenceId, { id: "arbiter-1", role: "adjudicator" })).resolves.toBeDefined();
    await expect(service.getEvidence(upload.evidence.evidenceId, { id: "ops-admin", role: "admin" })).resolves.toBeDefined();
    await expect(service.getProof(upload.evidence.evidenceId, { id: "ops-admin", role: "admin" }))
      .resolves.toMatchObject({ verificationStatus: "unbound" });
    await expect(service.getEvidence(upload.evidence.evidenceId, { id: "outsider", role: "participant" }))
      .rejects.toMatchObject({ code: "forbidden", status: 403 });
    await expect(service.getEvidence(upload.evidence.evidenceId, { id: "ops", role: "participant" }))
      .rejects.toMatchObject({ code: "forbidden", status: 403 });
    await expect(metadataStore.listAdminReads()).resolves.toEqual([
      expect.objectContaining({ principalId: "ops-admin", route: "evidence" }),
      expect.objectContaining({ principalId: "ops-admin", route: "proof" })
    ]);
  });

  it("rejects attributing uploaded evidence to another participant via ownerParticipantId or request writers", async () => {
    const metadataStore = new InMemoryEvidenceMetadataStore();
    const service = createEvidenceService({
      metadataStore,
      storage: new InMemoryEvidenceStorage(),
      now: () => new Date("2026-04-28T00:00:00Z"),
      evidenceIdFactory: () => "ev_forge"
    });
    const attacker: EvidencePrincipal = { id: "attacker", role: "participant" };

    // A self-asserted writers list in the same request body must not vouch
    // for attributing the record to someone else.
    await expect(service.uploadEvidence({
      orderId: "order-1",
      taskId: "task-1",
      stageIdentifier: "export-documents",
      documentType: "invoice",
      textPayload: "forged invoice",
      ownerParticipantId: "seller",
      accessPolicy: { writers: ["attacker"] }
    }, attacker)).rejects.toMatchObject({ code: "forbidden", status: 403 });

    await expect(metadataStore.get("ev_forge")).resolves.toBeUndefined();

    // A plain writers grant without the owner claim is equally rejected: the
    // request body cannot create evidence owned by another participant.
    await expect(service.uploadEvidence({
      orderId: "order-1",
      taskId: "task-1",
      stageIdentifier: "export-documents",
      documentType: "invoice",
      textPayload: "forged invoice",
      ownerParticipantId: "seller",
      accessPolicy: { writers: ["attacker"], readers: ["seller"] }
    }, attacker)).rejects.toMatchObject({ code: "forbidden", status: 403 });
    await expect(metadataStore.get("ev_forge")).resolves.toBeUndefined();

    // The principal can still declare itself as owner explicitly.
    const own = await service.uploadEvidence({
      orderId: "order-1",
      taskId: "task-1",
      stageIdentifier: "export-documents",
      documentType: "invoice",
      textPayload: "own invoice",
      ownerParticipantId: "attacker",
      accessPolicy: { writers: ["attacker"] }
    }, attacker);
    expect(own.evidence.ownerParticipantId).toBe("attacker");

    // Admin keeps the existing on-behalf ability, and an omitted owner
    // defaults to the authenticated principal.
    const onBehalf = await service.uploadEvidence({
      orderId: "order-1",
      taskId: "task-1",
      stageIdentifier: "export-documents",
      documentType: "invoice",
      textPayload: "admin invoice",
      ownerParticipantId: "seller"
    }, { id: "ops-admin", role: "admin" });
    expect(onBehalf.evidence.ownerParticipantId).toBe("seller");

    const defaulted = await service.uploadEvidence({
      orderId: "order-1",
      taskId: "task-1",
      stageIdentifier: "export-documents",
      documentType: "invoice",
      textPayload: "default owner invoice"
    }, owner);
    expect(defaulted.evidence.ownerParticipantId).toBe("seller");
  });

  it("returns proof and reports missing_file or mismatch without deleting evidence metadata", async () => {
    const storage = new InMemoryEvidenceStorage();
    const service = createEvidenceService({
      storage,
      now: () => new Date("2026-04-28T00:00:00Z")
    });
    const upload = await uploadTextEvidence(service, { invoice: "INV-1" });

    await expect(service.getProof(upload.evidence.evidenceId, owner))
      .resolves.toMatchObject({
        evidenceId: upload.evidence.evidenceId,
        payloadHash: upload.evidence.payloadHash,
        verificationStatus: "unbound"
      });

    await storage.delete(upload.evidence.storageURI);
    await expect(service.getProof(upload.evidence.evidenceId, owner))
      .resolves.toMatchObject({
        evidenceId: upload.evidence.evidenceId,
        payloadHash: upload.evidence.payloadHash,
        verificationStatus: "missing_file"
      });

    await storage.put({
      evidenceId: upload.evidence.evidenceId,
      bytes: new TextEncoder().encode("tampered invoice payload")
    });
    await expect(service.getProof(upload.evidence.evidenceId, owner))
      .resolves.toMatchObject({
        evidenceId: upload.evidence.evidenceId,
        payloadHash: upload.evidence.payloadHash,
        verificationStatus: "mismatch"
      });
  });

  it("rejects oversized payloads and unsupported MIME types", async () => {
    const service = createEvidenceService({
      storage: new InMemoryEvidenceStorage(),
      maxPayloadBytes: 4
    });

    await expect(uploadTextEvidence(service, { invoice: "INV-1" }))
      .rejects.toMatchObject({ code: "payload_too_large", status: 413 });
    await expect(service.uploadEvidence({
      orderId: "order-1",
      stageIdentifier: "export-documents",
      documentType: "invoice",
      mimeType: "application/x-msdownload",
      textPayload: "bin"
    }, owner)).rejects.toMatchObject({ code: "unsupported_mime_type", status: 415 });
  });

  it("marks evidence bound only through explicit signal binding", async () => {
    const service = testEvidenceService();
    const upload = await uploadTextEvidence(service, { invoice: "INV-1" });
    const binding = {
      evidenceId: upload.evidence.evidenceId,
      submissionId: "sub_1",
      txHash: txHash("1"),
      orderId: "order-1",
      onchainOrderId: txHash("2"),
      sourceId: txHash("3"),
      signalId: txHash("4"),
      boundAt: "2026-04-28T00:00:01.000Z"
    };

    await expect(service.bindEvidence(binding)).resolves.toMatchObject({
      evidence: {
        status: "bound",
        boundSignalTxHash: txHash("1"),
        boundSubmissionId: "sub_1",
        boundOnchainOrderId: txHash("2"),
        boundSourceId: txHash("3"),
        boundSignalId: txHash("4"),
        boundAt: "2026-04-28T00:00:01.000Z"
      }
    });
    await expect(service.getProof(upload.evidence.evidenceId, owner)).resolves.toMatchObject({
      verificationStatus: "matched",
      boundSignalTxHash: txHash("1")
    });
    await expect(service.bindEvidence({ ...binding, txHash: txHash("5"), signalId: txHash("5") }))
      .resolves.toMatchObject({
        evidence: {
          status: "bound",
          boundSignalTxHash: txHash("1"),
          boundSignalId: txHash("4")
        }
      });
  });

  it("rejects non-object evidence storage in production mode", () => {
    expect(() => createEvidenceService({
      storage: new InMemoryEvidenceStorage(),
      runtimeEnvironment: "production"
    })).toThrow(EvidenceStorageConfigurationError);
    expect(() => createEvidenceService({
      storage: new LocalEvidenceStorage(),
      runtimeEnvironment: "production"
    })).toThrow(EvidenceStorageConfigurationError);
  });

  it("rejects memory and local evidence storage in testnet rehearsal mode", () => {
    expect(() => createEvidenceService({
      storage: new InMemoryEvidenceStorage(),
      runtimeEnvironment: "testnet"
    })).toThrow(EvidenceStorageConfigurationError);
    expect(() => createEvidenceService({
      storage: new LocalEvidenceStorage(),
      runtimeEnvironment: "testnet"
    })).toThrow(EvidenceStorageConfigurationError);
  });

  it("rejects rehearsal object storage in staging and production", () => {
    const storage = new RehearsalObjectEvidenceStorage({
      rootDir: tempDir(),
      namespace: "uvp-rehearsal-staging"
    });

    expect(() => createEvidenceService({
      storage,
      runtimeEnvironment: "staging"
    })).toThrow(EvidenceStorageConfigurationError);
    expect(() => createEvidenceService({
      storage,
      runtimeEnvironment: "production"
    })).toThrow(EvidenceStorageConfigurationError);
  });

  it("stores rehearsal object evidence under private object URIs", async () => {
    const rootDir = tempDir();
    const storage = new RehearsalObjectEvidenceStorage({
      rootDir,
      namespace: "uvp-rehearsal-test"
    });
    const service = createEvidenceService({
      storage,
      runtimeEnvironment: "testnet"
    });

    const upload = await uploadTextEvidence(service, { invoice: "INV-1" });

    expect(storage.adapterKind).toBe("object");
    expect(storage.productionSafe).toBe(true);
    expect(upload.evidence.storageURI).toBe(`object://uvp-rehearsal-test/${upload.evidence.evidenceId}`);
    await expect(storage.exists(upload.evidence.storageURI)).resolves.toBe(true);
    await expect(service.getProof(upload.evidence.evidenceId, owner)).resolves.toMatchObject({
      verificationStatus: "unbound"
    });
  });

  it("keeps the default rehearsal object root stable across process restarts", () => {
    // Audit #20: stored metadata references bytes under this root, so the
    // default must never embed a timestamp or pid that changes on restart.
    const first = new RehearsalObjectEvidenceStorage();
    const second = new RehearsalObjectEvidenceStorage();
    const expected = join(process.cwd(), "data", "evidence-object", "ev_restart.bin");

    expect(first.pathForStorageURI("object://uvp-rehearsal/ev_restart")).toBe(expected);
    expect(second.pathForStorageURI("object://uvp-rehearsal/ev_restart")).toBe(expected);
    expect(defaultRehearsalObjectStorageRoot()).toBe(join(process.cwd(), "data", "evidence-object"));
  });

  it("accepts production-like object storage but rejects public or credential-bearing storage URIs", async () => {
    const objectStorage = objectStorageWithUri("object://private-evidence/ev_object");
    const service = createEvidenceService({
      storage: objectStorage,
      runtimeEnvironment: "production"
    });
    await expect(uploadTextEvidence(service, { invoice: "INV-1" }))
      .resolves.toMatchObject({ evidence: { storageURI: "object://private-evidence/ev_object" } });

    for (const unsafeURI of [
      "https://bucket.example.com/evidence/ev_public",
      "s3://bucket/evidence/ev_public?X-Amz-Signature=secret",
      "s3://access:secret@bucket/evidence/ev_public"
    ]) {
      const unsafeService = createEvidenceService({
        storage: objectStorageWithUri(unsafeURI),
        runtimeEnvironment: "testnet"
      });
      await expect(uploadTextEvidence(unsafeService, { invoice: "INV-1" }))
        .rejects.toThrow(EvidenceStorageConfigurationError);
    }
  });

  it("stores S3 object evidence under private s3 URIs", async () => {
    const mockClient = new MockS3CompatibleObjectClient();
    const storage = new ObjectEvidenceStorage({
      client: new S3EvidenceStorageClient({
        bucket: "private-evidence-bucket",
        prefix: "orders/evidence",
        region: "auto",
        accessKeyIdEnv: "S3_ACCESS_KEY_ID",
        secretAccessKeyEnv: "S3_SECRET_ACCESS_KEY",
        env: s3CredentialEnv(),
        objectClient: mockClient
      })
    });
    const service = createEvidenceService({
      storage,
      runtimeEnvironment: "staging"
    });

    const upload = await uploadTextEvidence(service, { invoice: "INV-1" });

    expect(upload.evidence.storageURI).toBe(
      `s3://private-evidence-bucket/orders/evidence/${upload.evidence.evidenceId}`
    );
    expect(mockClient.puts).toEqual([
      expect.objectContaining({
        bucket: "private-evidence-bucket",
        key: `orders/evidence/${upload.evidence.evidenceId}`
      })
    ]);
    expect(JSON.stringify(upload)).not.toContain("access-key-value");
    expect(JSON.stringify(upload)).not.toContain("secret-key-value");
    await expect(storage.exists(upload.evidence.storageURI)).resolves.toBe(true);
    await expect(service.getProof(upload.evidence.evidenceId, owner)).resolves.toMatchObject({
      storageURI: upload.evidence.storageURI,
      verificationStatus: "unbound"
    });

    await storage.delete(upload.evidence.storageURI);
    await expect(storage.exists(upload.evidence.storageURI)).resolves.toBe(false);
    await expect(service.getProof(upload.evidence.evidenceId, owner)).resolves.toMatchObject({
      verificationStatus: "missing_file"
    });
  });

  it("supports explicit object URI namespace mode for S3-compatible storage", async () => {
    const mockClient = new MockS3CompatibleObjectClient();
    const client = new S3EvidenceStorageClient({
      bucket: "private-evidence-bucket",
      prefix: "evidence",
      region: "us-east-1",
      accessKeyIdEnv: "S3_ACCESS_KEY_ID",
      secretAccessKeyEnv: "S3_SECRET_ACCESS_KEY",
      env: s3CredentialEnv(),
      objectClient: mockClient,
      uriMode: "object",
      objectNamespace: "uvp-private-evidence"
    });

    await expect(client.put({
      evidenceId: "ev_s3_object",
      bytes: new TextEncoder().encode("object namespace payload")
    })).resolves.toEqual({
      storageURI: "object://uvp-private-evidence/evidence/ev_s3_object",
      size: 24
    });
    await expect(client.get("object://uvp-private-evidence/evidence/ev_s3_object"))
      .resolves.toEqual(new TextEncoder().encode("object namespace payload"));
  });

  it("rejects public, presigned, credential-bearing, and unmanaged S3 URIs", async () => {
    const client = new S3EvidenceStorageClient({
      bucket: "private-evidence-bucket",
      prefix: "evidence",
      region: "us-east-1",
      accessKeyIdEnv: "S3_ACCESS_KEY_ID",
      secretAccessKeyEnv: "S3_SECRET_ACCESS_KEY",
      env: s3CredentialEnv(),
      objectClient: new MockS3CompatibleObjectClient()
    });

    await expect(client.get("https://objects.example/evidence/ev_public"))
      .rejects.toThrow(EvidenceStorageConfigurationError);
    await expect(client.get("s3://private-evidence-bucket/evidence/ev_public?X-Amz-Signature=secret"))
      .rejects.toThrow(EvidenceStorageConfigurationError);
    await expect(client.get("s3://access:secret@private-evidence-bucket/evidence/ev_public"))
      .rejects.toThrow(EvidenceStorageConfigurationError);
    await expect(client.get("s3://other-bucket/evidence/ev_public"))
      .rejects.toThrow(/not managed/);
  });

  it("requires credential env var names without exposing credential values", () => {
    const secretEnv = {
      S3_ACCESS_KEY_ID: "access-value-that-must-not-leak"
    };

    expect(() => new S3EvidenceStorageClient({
      bucket: "private-evidence-bucket",
      region: "us-east-1",
      accessKeyIdEnv: "S3_ACCESS_KEY_ID",
      secretAccessKeyEnv: "S3_SECRET_ACCESS_KEY",
      env: secretEnv,
      objectClient: new MockS3CompatibleObjectClient()
    })).toThrow(EvidenceStorageConfigurationError);

    try {
      new S3EvidenceStorageClient({
        bucket: "private-evidence-bucket",
        region: "us-east-1",
        accessKeyIdEnv: "S3_ACCESS_KEY_ID",
        secretAccessKeyEnv: "S3_SECRET_ACCESS_KEY",
        env: secretEnv,
        objectClient: new MockS3CompatibleObjectClient()
      });
    } catch (error) {
      expect(error instanceof Error ? error.message : String(error)).not.toContain("access-value-that-must-not-leak");
    }
  });

  it("resolves a configured STS session token env at construction time", () => {
    // Audit #19: the session token must reach the S3 client when configured,
    // and a configured-but-empty token env must fail construction instead of
    // producing a client that passes preflight and 403s on first use.
    expect(() => new S3EvidenceStorageClient({
      bucket: "private-evidence-bucket",
      region: "us-east-1",
      accessKeyIdEnv: "S3_ACCESS_KEY_ID",
      secretAccessKeyEnv: "S3_SECRET_ACCESS_KEY",
      sessionTokenEnv: "S3_SESSION_TOKEN",
      env: {
        ...s3CredentialEnv(),
        S3_SESSION_TOKEN: "sts-session-token-value"
      },
      objectClient: new MockS3CompatibleObjectClient()
    })).not.toThrow();

    expect(() => new S3EvidenceStorageClient({
      bucket: "private-evidence-bucket",
      region: "us-east-1",
      accessKeyIdEnv: "S3_ACCESS_KEY_ID",
      secretAccessKeyEnv: "S3_SECRET_ACCESS_KEY",
      sessionTokenEnv: "S3_SESSION_TOKEN",
      env: s3CredentialEnv(),
      objectClient: new MockS3CompatibleObjectClient()
    })).toThrow(EvidenceStorageConfigurationError);
  });

  it("returns undefined for missing evidence records", async () => {
    const service = testEvidenceService();

    await expect(service.getEvidence("ev_missing", owner)).resolves.toBeUndefined();
    await expect(service.getProof("ev_missing", owner)).resolves.toBeUndefined();
  });
});

function objectStorageWithUri(storageURI: string): ObjectEvidenceStorage {
  const objects = new Map<string, Uint8Array>();
  return new ObjectEvidenceStorage({
    client: {
      async put(input) {
        const bytes = new Uint8Array(input.bytes);
        objects.set(storageURI, bytes);
        return {
          storageURI,
          size: bytes.byteLength
        };
      },
      async get(uri) {
        const bytes = objects.get(uri);
        return bytes ? new Uint8Array(bytes) : undefined;
      },
      async exists(uri) {
        return objects.has(uri);
      }
    }
  });
}

class MockS3CompatibleObjectClient implements S3CompatibleObjectClient {
  readonly objects = new Map<string, Uint8Array>();
  readonly puts: S3ObjectPutOperationInput[] = [];

  async putObject(input: S3ObjectPutOperationInput): Promise<void> {
    const stored = {
      bucket: input.bucket,
      key: input.key,
      bytes: new Uint8Array(input.bytes)
    };
    this.puts.push(stored);
    this.objects.set(objectMapKey(input), stored.bytes);
  }

  async getObject(input: S3ObjectOperationInput): Promise<Uint8Array | undefined> {
    const bytes = this.objects.get(objectMapKey(input));
    return bytes ? new Uint8Array(bytes) : undefined;
  }

  async headObject(input: S3ObjectOperationInput): Promise<boolean> {
    return this.objects.has(objectMapKey(input));
  }

  async deleteObject(input: S3ObjectOperationInput): Promise<void> {
    this.objects.delete(objectMapKey(input));
  }
}

function objectMapKey(input: S3ObjectOperationInput): string {
  return `${input.bucket}/${input.key}`;
}

function s3CredentialEnv(): Record<string, string> {
  return {
    S3_ACCESS_KEY_ID: "access-key-value",
    S3_SECRET_ACCESS_KEY: "secret-key-value"
  };
}

function testEvidenceService() {
  return createEvidenceService({
    storage: new InMemoryEvidenceStorage(),
    now: () => new Date("2026-04-28T00:00:00Z")
  });
}

function txHash(value: string) {
  return `0x${value.padStart(64, "0")}` as const;
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "uvp-evidence-object-"));
  tempDirs.push(dir);
  return dir;
}

async function uploadJsonEvidence(
  service: ReturnType<typeof createEvidenceService>,
  input: {
    readonly fileName: string;
    readonly content: unknown;
    readonly metadataFields: Record<string, unknown>;
  }
): Promise<EvidenceUploadResponseDTO> {
  return service.uploadEvidence({
    orderId: "order-1",
    taskId: "task-1",
    stageIdentifier: "export-documents",
    documentType: "invoice",
    fileName: input.fileName,
    content: { encoding: "json", value: input.content },
    metadata: {
      businessLabel: "Commercial invoice",
      fields: input.metadataFields
    }
  }, owner);
}

async function uploadTextEvidence(
  service: ReturnType<typeof createEvidenceService>,
  metadataFields: Record<string, unknown>
): Promise<EvidenceUploadResponseDTO> {
  return service.uploadEvidence({
    orderId: "order-1",
    taskId: "task-1",
    stageIdentifier: "export-documents",
    documentType: "invoice",
    fileName: "invoice.txt",
    textPayload: "invoice payload",
    metadata: {
      businessLabel: "Commercial invoice",
      fields: metadataFields
    }
  }, owner).catch((error: unknown) => {
    if (error instanceof EvidenceServiceError) {
      throw error;
    }
    throw error;
  });
}

describe("evidence backup storage (ETH-05)", () => {
  it("writes a second copy on put and restores the primary object from the verified backup", async () => {
    const primary = new InMemoryEvidenceStorage();
    const backup = new InMemoryEvidenceStorage();
    const storage = new BackupEvidenceStorage({ primary, backup });
    const evidenceId = "ev_backup_1";
    const bytes = new TextEncoder().encode("evidence-bytes-for-backup");

    await storage.put({ evidenceId, bytes });

    const primaryURI = `memory://evidence/${evidenceId}`;
    await expect(backup.exists(primaryURI)).resolves.toBe(true);
    const storedHash = hashEvidenceBytes(bytes);

    // 主对象被"损坏"：内容被替换，hash 不再匹配。
    await primary.put({ evidenceId, bytes: new TextEncoder().encode("corrupted-bytes") });
    await expect(storage.verifyBackup(primaryURI, storedHash)).resolves.toEqual({
      backupPresent: true,
      hashMatches: true
    });

    await expect(storage.restoreFromBackup(primaryURI, evidenceId, storedHash)).resolves.toBe(true);
    await expect(primary.get(primaryURI)).resolves.toEqual(bytes);

    // 副本 hash 不匹配时拒绝恢复。
    await backup.put({ evidenceId, bytes: new TextEncoder().encode("tampered-backup") });
    await expect(storage.restoreFromBackup(primaryURI, evidenceId, storedHash)).resolves.toBe(false);

    // 缺失副本时报告不可用。
    await backup.delete(primaryURI);
    await expect(storage.verifyBackup(primaryURI, storedHash)).resolves.toEqual({
      backupPresent: false,
      hashMatches: false
    });
  });

  it("propagates backup write failures instead of pretending a copy exists", async () => {
    const primary = new InMemoryEvidenceStorage();
    const failingBackup: EvidenceStorage = {
      adapterKind: "memory",
      productionSafe: false,
      put: async () => {
        throw new Error("backup bucket unavailable");
      },
      get: async () => undefined,
      exists: async () => false
    };
    const storage = new BackupEvidenceStorage({ primary, backup: failingBackup });

    await expect(storage.put({
      evidenceId: "ev_backup_fail",
      bytes: new TextEncoder().encode("payload")
    })).rejects.toThrow(/backup bucket unavailable/);
  });
});
