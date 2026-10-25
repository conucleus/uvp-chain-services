import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildPayloadHashDocument,
  createEvidenceService,
  EvidenceServiceError,
  EvidenceStorageConfigurationError,
  InMemoryEvidenceMetadataStore,
  LocalEvidenceStorage,
  ObjectEvidenceStorage,
  RehearsalObjectEvidenceStorage,
  S3EvidenceStorageClient,
  type S3CompatibleObjectClient,
  type S3ObjectOperationInput,
  type S3ObjectPutOperationInput,
  type EvidencePrincipal,
  type EvidenceUploadResponseDTO
} from "../src/evidence/index.js";

const owner: EvidencePrincipal = { id: "slot-b", role: "participant" };
const tempDirs: string[] = [];

describe("evidence service", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps same-owner evidence on different tasks distinct via the taskId fingerprint component", async () => {
    const service = testEvidenceService();
    const base = {
      stageIdentifier: "stage-1",
      documentType: "doc-1",
      fileName: "doc-1.json",
      content: { encoding: "json" as const, value: { amount: 100 } },
      metadata: { businessLabel: "Doc-1", fields: { "doc-1": "DOC-9" } }
    };
    const taskA = await service.uploadEvidence({ orderId: "order-1", taskId: "task-a", ...base }, owner);
    const taskB = await service.uploadEvidence({ orderId: "order-1", taskId: "task-b", ...base }, owner);
    expect(taskA.evidence.taskId).toBe("task-a");
    expect(taskB.evidence.taskId).toBe("task-b");
    expect(taskA.evidence.payloadHash).not.toBe(taskB.evidence.payloadHash);
    expect(taskB.evidence.evidenceId).not.toBe(taskA.evidence.evidenceId);
  });

  it("rejects bindEvidence from a principal that does not own the evidence", async () => {
    const service = testEvidenceService();
    const uploaded = await uploadJsonEvidence(service, {
      fileName: "example.txt",
      content: { note: "declaration" },
      metadataFields: { "doc-1": "DOC-2" }
    });
    await expect(service.bindEvidence({
      evidenceId: uploaded.evidence.evidenceId,
      txHash: txHash("21"),
      orderId: "order-1",
      onchainOrderId: txHash("aa"),
      sourceId: txHash("bb"),
      signalId: txHash("cc")
    }, { id: "another-participant", role: "participant" })).rejects.toMatchObject({
      code: "forbidden",
      status: 403
    });
    const bound = await service.bindEvidence({
      evidenceId: uploaded.evidence.evidenceId,
      txHash: txHash("21"),
      orderId: "order-1",
      onchainOrderId: txHash("aa"),
      sourceId: txHash("bb"),
      signalId: txHash("cc")
    }, owner);
    expect(bound?.evidence.status).toBe("bound");
    const second = await service.bindEvidence({
      evidenceId: uploaded.evidence.evidenceId,
      txHash: txHash("21"),
      orderId: "order-1",
      onchainOrderId: txHash("aa"),
      sourceId: txHash("bb"),
      signalId: txHash("cc")
    }, { id: "admin-1", role: "admin" });
    expect(second?.evidence.status).toBe("bound");
  });

  it("settles a concurrent double-bind by first-writer-wins and rejects the cross-order loser", async () => {
    const backing = new InMemoryEvidenceMetadataStore();
    let staleReadPending = false;
    const racingStore: typeof backing = new Proxy(backing, {
      get(target, property, receiver) {
        if (property === "get") {
          return async (evidenceId: string) => {
            const latest = await target.get(evidenceId);
            if (staleReadPending && latest) {
              staleReadPending = false;
              return { ...latest, evidence: { ...latest.evidence, status: "uploaded" as const } };
            }
            return latest;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const service = createEvidenceService({
      runtimeEnvironment: "local",
      storage: new LocalEvidenceStorage({ rootDir: tempDir() }),
      metadataStore: racingStore,
    });
    const uploaded = await uploadJsonEvidence(service, {
      fileName: "double-bind.txt",
      content: { note: "race" },
      metadataFields: { "doc-1": "DOC-RACE" },
    });
    const evidenceId = uploaded.evidence.evidenceId;

    const winnerBinding = {
      evidenceId,
      txHash: txHash("31"),
      orderId: "order-1",
      onchainOrderId: txHash("a1"),
      sourceId: txHash("b1"),
      signalId: txHash("c1")
    };
    await service.bindEvidence(winnerBinding, owner);

    staleReadPending = true;
    await expect(service.bindEvidence({
      ...winnerBinding,
      txHash: txHash("32"),
      onchainOrderId: txHash("a2")
    }, owner)).rejects.toMatchObject({
      code: "invalid_request",
      status: 409
    });

    staleReadPending = true;
    const idempotent = await service.bindEvidence(winnerBinding, owner);
    expect(idempotent?.evidence).toMatchObject({
      status: "bound",
      boundOnchainOrderId: txHash("a1"),
    });
  });

  it("changes metadataHash and payloadHash when canonical metadata changes", async () => {
    const service = testEvidenceService();
    const first = await uploadTextEvidence(service, { "doc-1": "DOC-1" });
    const second = await uploadTextEvidence(service, { "doc-1": "DOC-2" });

    expect(first.evidence.contentHash).toBe(second.evidence.contentHash);
    expect(first.evidence.metadataHash).not.toBe(second.evidence.metadataHash);
    expect(first.evidence.payloadHash).not.toBe(second.evidence.payloadHash);
  });

  it("keeps metadataHash stable while payloadHash changes for order or stage binding changes", async () => {
    const service = testEvidenceService();
    const first = await uploadTextEvidence(service, { "doc-1": "DOC-1" });
    const differentOrder = await service.uploadEvidence({
      orderId: "order-2",
      taskId: "task-1",
      stageIdentifier: "stage-1",
      documentType: "doc-1",
      fileName: "doc-1.txt",
      textPayload: "doc-1 payload",
      metadata: {
        businessLabel: "Doc-1",
        fields: { "doc-1": "DOC-1" }
      }
    }, owner);
    const differentStage = await service.uploadEvidence({
      orderId: "order-1",
      taskId: "task-1",
      stageIdentifier: "example-complete",
      documentType: "doc-1",
      fileName: "doc-1.txt",
      textPayload: "doc-1 payload",
      metadata: {
        businessLabel: "Doc-1",
        fields: { "doc-1": "DOC-1" }
      }
    }, owner);

    expect(first.evidence.contentHash).toBe(differentOrder.evidence.contentHash);
    expect(first.evidence.metadataHash).toBe(differentOrder.evidence.metadataHash);
    expect(first.evidence.payloadHash).not.toBe(differentOrder.evidence.payloadHash);
    expect(first.evidence.metadataHash).toBe(differentStage.evidence.metadataHash);
    expect(first.evidence.payloadHash).not.toBe(differentStage.evidence.payloadHash);
  });

  it("separates draft evidence fingerprints by draftId (先存后绑)", async () => {
    const service = testEvidenceService();
    const uploadDraft = async (draftId: string) => service.uploadEvidence({
      draftId,
      stageIdentifier: "stage-1",
      documentType: "doc-1",
      fileName: "doc-1.txt",
      textPayload: "doc-1 payload",
      metadata: {
        businessLabel: "Doc-1",
        fields: { "doc-1": "DOC-1" }
      }
    }, owner);

    const draftA = await uploadDraft("draft-1");
    const draftB = await uploadDraft("draft-2");
    expect(draftA.evidence.payloadHash).not.toBe(draftB.evidence.payloadHash);
    expect(draftB.evidence.evidenceId).not.toBe(draftA.evidence.evidenceId);
    expect(draftB.evidence.draftId).toBe("draft-2");

    const draftAgain = await uploadDraft("draft-1");
    expect(draftAgain.evidence.evidenceId).toBe(draftA.evidence.evidenceId);

    expect(buildPayloadHashDocument({
      contentHash: draftA.evidence.contentHash,
      metadataHash: draftA.evidence.metadataHash,
      documentType: draftA.metadata.documentType,
      orderId: "order-9",
      draftId: "draft-1",
      stageIdentifier: draftA.evidence.stageIdentifier
    })).not.toHaveProperty("draftId");
  });

  it("changes contentHash and payloadHash when file bytes change", async () => {
    const service = testEvidenceService();
    const first = await uploadTextEvidence(service, { "doc-1": "DOC-1" });
    const second = await service.uploadEvidence({
      orderId: "order-1",
      taskId: "task-1",
      stageIdentifier: "stage-1",
      documentType: "doc-1",
      fileName: "doc-1.txt",
      textPayload: "different doc-1 payload",
      metadata: {
        businessLabel: "Doc-1",
        fields: { "doc-1": "DOC-1" }
      }
    }, owner);

    expect(first.evidence.metadataHash).toBe(second.evidence.metadataHash);
    expect(first.evidence.contentHash).not.toBe(second.evidence.contentHash);
    expect(first.evidence.payloadHash).not.toBe(second.evidence.payloadHash);
  });

  it("enforces owner, participant, operator, admin, and outsider read rules", async () => {
    const metadataStore = new InMemoryEvidenceMetadataStore();
    const service = createEvidenceService({
    runtimeEnvironment: "local",
      metadataStore,
      storage: new LocalEvidenceStorage({ rootDir: tempDir() }),
      now: () => new Date("2026-04-28T00:00:00Z")
    });
    const upload = await service.uploadEvidence({
      orderId: "order-1",
      taskId: "task-1",
      stageIdentifier: "stage-1",
      documentType: "doc-1",
      textPayload: "paid",
      accessPolicy: {
        readers: ["slot-a", "reviewer-1"],
        adminReaders: ["ops"],
        adjudicatorReaders: ["arbiter-1"]
      }
    }, owner);

    await expect(service.getEvidence(upload.evidence.evidenceId, owner)).resolves.toBeDefined();
    await expect(service.getEvidence(upload.evidence.evidenceId, { id: "slot-a", role: "participant" })).resolves.toBeDefined();
    await expect(service.getEvidence(upload.evidence.evidenceId, { id: "reviewer-1", role: "participant" })).resolves.toBeDefined();
    await expect(service.getEvidence(upload.evidence.evidenceId, { id: "arbiter-1", role: "adjudicator" })).resolves.toBeDefined();
    await expect(service.getEvidence(upload.evidence.evidenceId, { id: "ops-admin", role: "admin" })).resolves.toBeDefined();
    await expect(service.getProof(upload.evidence.evidenceId, { id: "ops-admin", role: "admin" }))
      .resolves.toMatchObject({ verificationStatus: "unbound" });
    await expect(service.getEvidence(upload.evidence.evidenceId, { id: "outsider", role: "participant" }))
      .resolves.toBeUndefined();
    await expect(service.getEvidence(upload.evidence.evidenceId, { id: "ops", role: "participant" }))
      .resolves.toBeUndefined();
    await expect(service.getEvidence(upload.evidence.evidenceId, { role: "anonymous" }))
      .rejects.toMatchObject({ code: "unauthenticated", status: 401 });
    await expect(service.getEvidence("ev_missing", { role: "anonymous" }))
      .rejects.toMatchObject({ code: "unauthenticated", status: 401 });
    await expect(metadataStore.listAdminReads()).resolves.toEqual([
      expect.objectContaining({ principalId: "ops-admin", route: "evidence" }),
      expect.objectContaining({ principalId: "ops-admin", route: "proof" })
    ]);
  });

  it("rejects attributing uploaded evidence to another participant via ownerParticipantId or request writers", async () => {
    const metadataStore = new InMemoryEvidenceMetadataStore();
    const service = createEvidenceService({
    runtimeEnvironment: "local",
      metadataStore,
      storage: new LocalEvidenceStorage({ rootDir: tempDir() }),
      now: () => new Date("2026-04-28T00:00:00Z"),
      evidenceIdFactory: () => "ev_forge"
    });
    const attacker: EvidencePrincipal = { id: "attacker", role: "participant" };

    await expect(service.uploadEvidence({
      orderId: "order-1",
      taskId: "task-1",
      stageIdentifier: "stage-1",
      documentType: "doc-1",
      textPayload: "forged doc-1",
      ownerParticipantId: "slot-b",
      accessPolicy: { writers: ["attacker"] }
    }, attacker)).rejects.toMatchObject({ code: "forbidden", status: 403 });

    await expect(metadataStore.get("ev_forge")).resolves.toBeUndefined();

    await expect(service.uploadEvidence({
      orderId: "order-1",
      taskId: "task-1",
      stageIdentifier: "stage-1",
      documentType: "doc-1",
      textPayload: "forged doc-1",
      ownerParticipantId: "slot-b",
      accessPolicy: { writers: ["attacker"], readers: ["slot-b"] }
    }, attacker)).rejects.toMatchObject({ code: "forbidden", status: 403 });
    await expect(metadataStore.get("ev_forge")).resolves.toBeUndefined();

    const own = await service.uploadEvidence({
      orderId: "order-1",
      taskId: "task-1",
      stageIdentifier: "stage-1",
      documentType: "doc-1",
      textPayload: "own doc-1",
      ownerParticipantId: "attacker",
      accessPolicy: { writers: ["attacker"] }
    }, attacker);
    expect(own.evidence.ownerParticipantId).toBe("attacker");

    const onBehalf = await service.uploadEvidence({
      orderId: "order-1",
      taskId: "task-1",
      stageIdentifier: "stage-1",
      documentType: "doc-1",
      textPayload: "admin doc-1",
      ownerParticipantId: "slot-b"
    }, { id: "ops-admin", role: "admin" });
    expect(onBehalf.evidence.ownerParticipantId).toBe("slot-b");

    const defaulted = await service.uploadEvidence({
      orderId: "order-1",
      taskId: "task-1",
      stageIdentifier: "stage-1",
      documentType: "doc-1",
      textPayload: "default owner doc-1"
    }, owner);
    expect(defaulted.evidence.ownerParticipantId).toBe("slot-b");
  });

  it("returns proof and reports missing_file or mismatch without deleting evidence metadata", async () => {
    const storage = new LocalEvidenceStorage({ rootDir: tempDir() });
    const service = createEvidenceService({
    metadataStore: new InMemoryEvidenceMetadataStore(),
    runtimeEnvironment: "local",
      storage,
      now: () => new Date("2026-04-28T00:00:00Z")
    });
    const upload = await uploadTextEvidence(service, { "doc-1": "DOC-1" });

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
      bytes: new TextEncoder().encode("tampered doc-1 payload")
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
    metadataStore: new InMemoryEvidenceMetadataStore(),
    runtimeEnvironment: "local",
      storage: new LocalEvidenceStorage({ rootDir: tempDir() }),
      maxPayloadBytes: 4
    });

    await expect(uploadTextEvidence(service, { "doc-1": "DOC-1" }))
      .rejects.toMatchObject({ code: "payload_too_large", status: 413 });
    await expect(service.uploadEvidence({
      orderId: "order-1",
      stageIdentifier: "stage-1",
      documentType: "doc-1",
      mimeType: "application/x-msdownload",
      textPayload: "bin"
    }, owner)).rejects.toMatchObject({ code: "unsupported_mime_type", status: 415 });
  });

  it("marks evidence bound only through explicit signal binding", async () => {
    const service = testEvidenceService();
    const upload = await uploadTextEvidence(service, { "doc-1": "DOC-1" });
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

    await expect(service.bindEvidence(binding, owner)).resolves.toMatchObject({
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
    await expect(service.bindEvidence({ ...binding, txHash: txHash("5"), signalId: txHash("5") }, owner))
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
      metadataStore: new InMemoryEvidenceMetadataStore(),
      storage: new LocalEvidenceStorage(),
      runtimeEnvironment: "production"
    })).toThrow(EvidenceStorageConfigurationError);
  });

  it("rejects local evidence storage in testnet rehearsal mode", () => {
    expect(() => createEvidenceService({
      metadataStore: new InMemoryEvidenceMetadataStore(),
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
      metadataStore: new InMemoryEvidenceMetadataStore(),
      storage,
      runtimeEnvironment: "staging"
    })).toThrow(EvidenceStorageConfigurationError);
    expect(() => createEvidenceService({
      metadataStore: new InMemoryEvidenceMetadataStore(),
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
      metadataStore: new InMemoryEvidenceMetadataStore(),
      storage,
      runtimeEnvironment: "testnet"
    });

    const upload = await uploadTextEvidence(service, { "doc-1": "DOC-1" });

    expect(storage.adapterKind).toBe("object");
    expect(storage.productionSafe).toBe(true);
    expect(upload.evidence.storageURI).toBe(`object://uvp-rehearsal-test/${upload.evidence.evidenceId}`);
    await expect(storage.exists(upload.evidence.storageURI)).resolves.toBe(true);
    await expect(service.getProof(upload.evidence.evidenceId, owner)).resolves.toMatchObject({
      verificationStatus: "unbound"
    });
  });

  it("accepts production-like object storage but rejects public or credential-bearing storage URIs", async () => {
    const objectStorage = objectStorageWithUri("object://private-evidence/ev_object");
    const service = createEvidenceService({
      metadataStore: new InMemoryEvidenceMetadataStore(),
      storage: objectStorage,
      runtimeEnvironment: "production"
    });
    await expect(uploadTextEvidence(service, { "doc-1": "DOC-1" }))
      .resolves.toMatchObject({ evidence: { storageURI: "object://private-evidence/ev_object" } });

    for (const unsafeURI of [
      "https://bucket.example.com/evidence/ev_public",
      "s3://bucket/evidence/ev_public?X-Amz-Signature=secret",
      "s3://access:secret@bucket/evidence/ev_public"
    ]) {
      const unsafeService = createEvidenceService({
        metadataStore: new InMemoryEvidenceMetadataStore(),
        storage: objectStorageWithUri(unsafeURI),
        runtimeEnvironment: "testnet"
      });
      await expect(uploadTextEvidence(unsafeService, { "doc-1": "DOC-1" }))
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
      metadataStore: new InMemoryEvidenceMetadataStore(),
      storage,
      runtimeEnvironment: "staging"
    });

    const upload = await uploadTextEvidence(service, { "doc-1": "DOC-1" });

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

  it("rejects uploads carrying both orderId and draftId (U4)", async () => {
    const service = testEvidenceService();
    await expect(service.uploadEvidence({
      orderId: "order-1",
      draftId: "draft-1",
      stageIdentifier: "stage-1",
      documentType: "doc-1",
      textPayload: "doc-1 payload"
    }, owner)).rejects.toMatchObject({ code: "invalid_request", status: 400 });
  });

  it("binds draft evidence only to the order created from its draft (U4)", async () => {
    const metadataStore = new InMemoryEvidenceMetadataStore();
    const storage = new LocalEvidenceStorage({ rootDir: tempDir() });
    const serviceFor = (resolveDraftOrder?: (draftId: string) => Promise<string | undefined>) =>
      createEvidenceService({
        runtimeEnvironment: "local",
        metadataStore,
        storage,
        now: () => new Date("2026-04-28T00:00:00Z"),
        ...(resolveDraftOrder ? { resolveDraftOrder } : {})
      });
    const service = serviceFor();
    const uploaded = await service.uploadEvidence({
      draftId: "draft-1",
      stageIdentifier: "stage-1",
      documentType: "doc-1",
      fileName: "doc-1.txt",
      textPayload: "draft doc-1"
    }, owner);
    const bindTo = (svc: ReturnType<typeof createEvidenceService>, orderId: string, onchainOrderId: ReturnType<typeof txHash>) =>
      svc.bindEvidence({
        evidenceId: uploaded.evidence.evidenceId,
        txHash: txHash("31"),
        orderId,
        onchainOrderId,
        sourceId: txHash("bb"),
        signalId: txHash("cc")
      }, owner);

    await expect(bindTo(service, "order-1", txHash("aa"))).rejects.toMatchObject({ code: "invalid_request", status: 409 });

    await expect(bindTo(serviceFor(async () => "order-other"), "order-1", txHash("aa")))
      .rejects.toMatchObject({ code: "invalid_request", status: 409 });

    await expect(bindTo(serviceFor(async () => undefined), "order-1", txHash("aa")))
      .rejects.toMatchObject({ code: "invalid_request", status: 409 });

    await expect(bindTo(serviceFor(async (draftId) => draftId === "draft-1" ? "order-1" : undefined), "order-1", txHash("aa")))
      .resolves.toMatchObject({ evidence: { status: "bound" } });

    await expect(bindTo(serviceFor(async () => "order-2"), "order-2", txHash("dd")))
      .rejects.toMatchObject({ code: "invalid_request", status: 409 });
  });

  it("refuses idempotent returns when the stored binding tuple differs from the request (U4)", async () => {
    const base = new InMemoryEvidenceMetadataStore();
    const seeding = createEvidenceService({
      runtimeEnvironment: "local",
      metadataStore: base,
      storage: new LocalEvidenceStorage({ rootDir: tempDir() }),
      now: () => new Date("2026-04-28T00:00:00Z")
    });
    const stored = await seeding.uploadEvidence({
      orderId: "order-1",
      stageIdentifier: "stage-1",
      documentType: "doc-1",
      textPayload: "tuple guard"
    }, owner);
    const record = await base.get(stored.evidence.evidenceId);
    const service = createEvidenceService({
      runtimeEnvironment: "local",
      metadataStore: {
        put: (input) => base.put(input),
        insertIfPayloadHashAbsent: (input) => base.insertIfPayloadHashAbsent(input),
        get: (evidenceId) => base.get(evidenceId),
        recordAdminRead: (entry) => base.recordAdminRead(entry),
        findOwnedByPayloadHash: async (payloadHash, ownerParticipantId) =>
          payloadHash.toLowerCase() === stored.evidence.payloadHash.toLowerCase() &&
          ownerParticipantId.toLowerCase() === stored.evidence.ownerParticipantId.toLowerCase() &&
          record
            ? { ...record, evidence: { ...record.evidence, orderId: "order-2" } }
            : undefined
      },
      storage: new LocalEvidenceStorage({ rootDir: tempDir() }),
      now: () => new Date("2026-04-28T00:00:00Z")
    });
    await expect(service.uploadEvidence({
      orderId: "order-1",
      stageIdentifier: "stage-1",
      documentType: "doc-1",
      textPayload: "tuple guard"
    }, owner)).rejects.toMatchObject({ code: "evidence_already_bound", status: 409 });
  });

  it("rejects replaying a bound evidence to a different chain order under the same order id (U4)", async () => {    const service = testEvidenceService();
    const upload = await uploadTextEvidence(service, { "doc-1": "DOC-1" });
    await service.bindEvidence({
      evidenceId: upload.evidence.evidenceId,
      txHash: txHash("1"),
      orderId: "order-1",
      onchainOrderId: txHash("2"),
      sourceId: txHash("3"),
      signalId: txHash("4")
    }, owner);

    await expect(service.bindEvidence({
      evidenceId: upload.evidence.evidenceId,
      txHash: txHash("9"),
      orderId: "order-1",
      onchainOrderId: txHash("5"),
      sourceId: txHash("3"),
      signalId: txHash("4")
    }, owner)).rejects.toMatchObject({ code: "invalid_request", status: 409 });

    await expect(service.bindEvidence({
      evidenceId: upload.evidence.evidenceId,
      txHash: txHash("9"),
      orderId: "order-1",
      onchainOrderId: txHash("2"),
      sourceId: txHash("3"),
      signalId: txHash("4")
    }, owner)).resolves.toMatchObject({ evidence: { boundOnchainOrderId: txHash("2") } });
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
    metadataStore: new InMemoryEvidenceMetadataStore(),
    runtimeEnvironment: "local",
    storage: new LocalEvidenceStorage({ rootDir: tempDir() }),
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
    stageIdentifier: "stage-1",
    documentType: "doc-1",
    fileName: input.fileName,
    content: { encoding: "json", value: input.content },
    metadata: {
      businessLabel: "Doc-1",
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
    stageIdentifier: "stage-1",
    documentType: "doc-1",
    fileName: "doc-1.txt",
    textPayload: "doc-1 payload",
    metadata: {
      businessLabel: "Doc-1",
      fields: metadataFields
    }
  }, owner).catch((error: unknown) => {
    if (error instanceof EvidenceServiceError) {
      throw error;
    }
    throw error;
  });
}

describe("evidence PDF magic validation (STORE-02)", () => {
  it("rejects a declared application/pdf payload without the %PDF- magic header", async () => {
    const service = testEvidenceService();

    await expect(service.uploadEvidence({
      orderId: "order-1",
      stageIdentifier: "stage-1",
      documentType: "example-declaration",
      fileName: "fake.pdf",
      mimeType: "application/pdf",
      content: { encoding: "base64", value: Buffer.from("this is not a pdf document").toString("base64") }
    }, owner)).rejects.toMatchObject({
      code: "pdf_magic_mismatch",
      status: 400
    });

    await expect(service.uploadEvidence({
      orderId: "order-1",
      stageIdentifier: "stage-1",
      documentType: "example-declaration",
      fileName: "truncated.pdf",
      mimeType: "application/pdf",
      content: { encoding: "base64", value: Buffer.from("%PD").toString("base64") }
    }, owner)).rejects.toMatchObject({
      code: "pdf_magic_mismatch",
      status: 400
    });

    const accepted = await service.uploadEvidence({
      orderId: "order-1",
      stageIdentifier: "stage-1",
      documentType: "example-declaration",
      fileName: "real.pdf",
      mimeType: "application/pdf",
      content: { encoding: "base64", value: Buffer.from("%PDF-1.7 real payload").toString("base64") }
    }, owner);
    expect(accepted.evidence.mimeType).toBe("application/pdf");
  });

  it("does not apply PDF magic validation to non-PDF evidence accepts", async () => {
    const service = testEvidenceService();
    const uploaded = await service.uploadEvidence({
      orderId: "order-1",
      stageIdentifier: "stage-1",
      documentType: "example-declaration",
      fileName: "notes.txt",
      mimeType: "text/plain",
      content: { encoding: "text", value: "%PDF- is not required here" }
    }, owner);
    expect(uploaded.evidence.mimeType).toBe("text/plain");
  });
});
