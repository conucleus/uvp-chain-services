import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApiRouter } from "../src/api/routes.js";
import {
  createEvidenceService,
  InMemoryEvidenceMetadataStore,
  InMemoryEvidenceStorage,
  ObjectEvidenceStorage,
  RehearsalObjectEvidenceStorage,
  S3EvidenceStorageClient,
  type S3CompatibleObjectClient,
  type S3ObjectOperationInput,
  type S3ObjectPutOperationInput
} from "../src/evidence/index.js";
import { MemoryProjectionStore } from "../src/storage/projection-store.js";

describe("evidence API routes", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uploads text evidence and serves its proof for an authorized participant", async () => {
    const router = createApiRouter(new MemoryProjectionStore(), { submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111",
      evidenceService: createEvidenceService({
        storage: new InMemoryEvidenceStorage(),
        now: () => new Date("2026-04-28T00:00:00Z")
      })
    });

    const uploadResponse = await router.handle({
      method: "POST",
      pathname: "/product/evidence",
      headers: { "x-uvp-principal-id": "seller" },
      body: {
        orderId: "order-1",
        taskId: "task-1",
        stageIdentifier: "export-documents",
        documentType: "invoice",
        fileName: "invoice.txt",
        textPayload: "invoice payload",
        metadata: {
          businessLabel: "Commercial invoice",
          fields: { invoice: "INV-1" }
        },
        accessPolicy: {
          readers: ["buyer"]
        }
      }
    });

    expect(uploadResponse.status).toBe(201);
    const upload = uploadResponse.body as { evidence: { evidenceId: string; payloadHash: string } };
    const proofResponse = await router.handle({
      method: "GET",
      pathname: `/product/evidence/${upload.evidence.evidenceId}/proof`,
      headers: { "x-uvp-principal-id": "buyer" }
    });

    expect(proofResponse.status).toBe(200);
    expect(proofResponse.body).toMatchObject({
      proof: {
        evidenceId: upload.evidence.evidenceId,
        payloadHash: upload.evidence.payloadHash,
        verificationStatus: "unbound"
      }
    });
  });

  it("uploads through rehearsal object storage in testnet mode", async () => {
    const router = createApiRouter(new MemoryProjectionStore(), { submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111",
      evidenceStorage: new RehearsalObjectEvidenceStorage({
        rootDir: tempDir(tempDirs),
        namespace: "uvp-route-rehearsal"
      }),
      evidenceRuntimeEnvironment: "testnet"
    });

    const uploadResponse = await router.handle({
      method: "POST",
      pathname: "/product/evidence",
      headers: { "x-uvp-principal-id": "seller" },
      body: {
        orderId: "order-1",
        taskId: "task-1",
        stageIdentifier: "export-documents",
        documentType: "invoice",
        textPayload: "invoice payload",
        metadata: {
          fields: { invoice: "INV-1" }
        }
      }
    });

    expect(uploadResponse.status).toBe(201);
    expect(uploadResponse.body).toMatchObject({
      evidence: {
        storageURI: expect.stringMatching(/^object:\/\/uvp-route-rehearsal\/ev_/)
      }
    });
  });

  it("uploads through S3-compatible storage and returns private object proof", async () => {
    const mockClient = new MockS3CompatibleObjectClient();
    const router = createApiRouter(new MemoryProjectionStore(), { submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111",
      evidenceStorage: new ObjectEvidenceStorage({
        client: new S3EvidenceStorageClient({
          bucket: "private-evidence-bucket",
          prefix: "route-evidence",
          region: "auto",
          accessKeyIdEnv: "S3_ACCESS_KEY_ID",
          secretAccessKeyEnv: "S3_SECRET_ACCESS_KEY",
          env: s3CredentialEnv(),
          objectClient: mockClient
        })
      }),
      evidenceRuntimeEnvironment: "staging"
    });

    const uploadResponse = await router.handle({
      method: "POST",
      pathname: "/product/evidence",
      headers: { "x-uvp-principal-id": "seller" },
      body: {
        orderId: "order-1",
        taskId: "task-1",
        stageIdentifier: "export-documents",
        documentType: "invoice",
        textPayload: "invoice payload",
        metadata: {
          fields: { invoice: "INV-1" }
        },
        accessPolicy: {
          readers: ["buyer"]
        }
      }
    });

    expect(uploadResponse.status).toBe(201);
    const upload = uploadResponse.body as {
      evidence: {
        evidenceId: string;
        contentHash: string;
        metadataHash: string;
        payloadHash: string;
        storageURI: string;
      };
    };
    expect(upload.evidence.storageURI).toBe(
      `s3://private-evidence-bucket/route-evidence/${upload.evidence.evidenceId}`
    );
    expect(JSON.stringify(uploadResponse.body)).not.toContain("secret-key-value");
    expect(mockClient.puts).toEqual([
      expect.objectContaining({
        bucket: "private-evidence-bucket",
        key: `route-evidence/${upload.evidence.evidenceId}`
      })
    ]);

    const proofResponse = await router.handle({
      method: "GET",
      pathname: `/product/evidence/${upload.evidence.evidenceId}/proof`,
      headers: { "x-uvp-principal-id": "buyer" }
    });

    expect(proofResponse.status).toBe(200);
    expect(proofResponse.body).toMatchObject({
      proof: {
        evidenceId: upload.evidence.evidenceId,
        contentHash: upload.evidence.contentHash,
        metadataHash: upload.evidence.metadataHash,
        payloadHash: upload.evidence.payloadHash,
        storageURI: upload.evidence.storageURI,
        verificationStatus: "unbound"
      }
    });
  });

  it("rejects unauthorized evidence reads and returns 404 for missing evidence", async () => {
    const router = createApiRouter(new MemoryProjectionStore(), { submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111",
      evidenceService: createEvidenceService({
        storage: new InMemoryEvidenceStorage(),
        now: () => new Date("2026-04-28T00:00:00Z")
      })
    });
    const uploadResponse = await router.handle({
      method: "POST",
      pathname: "/product/evidence",
      headers: { "x-uvp-principal-id": "seller" },
      body: {
        orderId: "order-1",
        stageIdentifier: "customs-complete",
        documentType: "customs-declaration",
        base64Payload: Buffer.from("customs declaration").toString("base64"),
        metadata: {
          fields: { declarationNo: "CD-1" }
        }
      }
    });
    const upload = uploadResponse.body as { evidence: { evidenceId: string } };

    await expect(router.handle({
      method: "GET",
      pathname: `/product/evidence/${upload.evidence.evidenceId}`,
      headers: { "x-uvp-principal-id": "outsider" }
    })).resolves.toMatchObject({
      status: 403,
      body: { error: "forbidden" }
    });

    await expect(router.handle({
      method: "GET",
      pathname: "/product/evidence/ev_missing/proof",
      headers: { "x-uvp-principal-id": "seller" }
    })).resolves.toMatchObject({
      status: 404,
      body: { error: "evidence_not_found" }
    });
  });

  it("audits admin proof reads through the route boundary", async () => {
    const metadataStore = new InMemoryEvidenceMetadataStore();
    const router = createApiRouter(new MemoryProjectionStore(), { submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111",
      evidenceService: createEvidenceService({
        metadataStore,
        storage: new InMemoryEvidenceStorage(),
        now: () => new Date("2026-04-28T00:00:00Z")
      })
    });
    const uploadResponse = await router.handle({
      method: "POST",
      pathname: "/product/evidence",
      headers: { "x-uvp-principal-id": "seller" },
      body: {
        orderId: "order-1",
        stageIdentifier: "customs-complete",
        documentType: "customs-declaration",
        textPayload: "customs declaration",
        metadata: {
          fields: { declarationNo: "CD-1" }
        }
      }
    });
    const upload = uploadResponse.body as { evidence: { evidenceId: string } };

    await expect(router.handle({
      method: "GET",
      pathname: `/product/evidence/${upload.evidence.evidenceId}/proof`,
      headers: {
        "x-uvp-principal-id": "ops-admin",
        "x-uvp-principal-role": "admin"
      }
    })).resolves.toMatchObject({
      status: 200,
      body: {
        proof: {
          evidenceId: upload.evidence.evidenceId,
          verificationStatus: "unbound"
        }
      }
    });
    await expect(metadataStore.listAdminReads()).resolves.toEqual([
      expect.objectContaining({
        evidenceId: upload.evidence.evidenceId,
        principalId: "ops-admin",
        route: "proof"
      })
    ]);
  });
});

function tempDir(tempDirs: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "uvp-evidence-route-"));
  tempDirs.push(dir);
  return dir;
}

class MockS3CompatibleObjectClient implements S3CompatibleObjectClient {
  readonly objects = new Map<string, Uint8Array>();
  readonly puts: S3ObjectPutOperationInput[] = [];

  async putObject(input: S3ObjectPutOperationInput): Promise<void> {
    const bytes = new Uint8Array(input.bytes);
    this.puts.push({
      bucket: input.bucket,
      key: input.key,
      bytes
    });
    this.objects.set(objectMapKey(input), bytes);
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
