import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { Address } from "viem";
import { createApiRouter } from "../src/api/routes.js";
import { createNotificationService, createSupplierNotificationProfileConfigService, MemorySupplierNotificationProfileConfigStore } from "../src/notifications/index.js";
import type { ApiRouter } from "../src/api/routes.js";
import {
  createEvidenceService,
  InMemoryEvidenceMetadataStore,
  LocalEvidenceStorage,
  ObjectEvidenceStorage,
  RehearsalObjectEvidenceStorage,
  S3EvidenceStorageClient,
  type S3CompatibleObjectClient,
  type S3ObjectOperationInput,
  type S3ObjectPutOperationInput
} from "../src/evidence/index.js";
import { createChainServicesStores, type ChainServicesStores } from "../src/storage/factory.js";
import { createPostgresTestDatabase } from "./postgres.js";

let stores: ChainServicesStores;

beforeAll(async () => {
  stores = createChainServicesStores({
    database: { url: await createPostgresTestDatabase(), migrationsAutoRun: true }
  });
});

afterAll(async () => {
  await stores.close();
});

function requiredRouterStores() {
  return {
    storeSupplierMetadataStore: stores.storeSupplierMetadataStore,
    storeEntityRegistrationStore: stores.storeEntityRegistrationStore,
    storeWalletSessionStore: stores.storeWalletSessionStore,
    storeDecorationStore: stores.storeDecorationStore,
    storePublisherDelegationStore: stores.storePublisherDelegationStore,
    identityDescriptorSnapshots: stores.identityDescriptorSnapshots,
    storeListingStore: stores.storeListingStore,
    storeJoinApplicationStore: stores.storeJoinApplicationStore,
    productBffStore: stores.productBffStore,
    orderStore: stores.orderStore,
    orderRequirementsStore: stores.orderRequirementsStore,
    evidenceMetadataStore: stores.evidenceMetadataStore,
    submissionStore: stores.submissionStore,
    governanceStore: stores.governanceStore,
    stageExecutorPatchStore: stores.stageExecutorPatchStore,
    stageResourcePatchStore: stores.stageResourcePatchStore,
    storeZhixuDraftStore: stores.storeZhixuDraftStore,
    storeZhixuVersionMetadataStore: stores.storeZhixuVersionMetadataStore,
    storeDockingSessionStore: stores.storeDockingSessionStore,
    storeAuditStore: stores.storeAuditStore,
    notificationService: createNotificationService({
      store: stores.projectionStore,
      supplierMetadataStore: stores.storeSupplierMetadataStore,
      deliveryStore: stores.notificationStateStore,
      participantReadStateStore: stores.notificationStateStore
    }),
    supplierNotificationConfigService: createSupplierNotificationProfileConfigService({
      store: new MemorySupplierNotificationProfileConfigStore()
    })
  };
}

describe("evidence API routes", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uploads text evidence and serves its proof for an authorized participant", async () => {
    const router = createApiRouter(stores.projectionStore, { ...requiredRouterStores(), submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111",
      productRuntimeEnvironment: "local",
      evidenceService: createEvidenceService({
    metadataStore: new InMemoryEvidenceMetadataStore(),
    runtimeEnvironment: "local",
        storage: new LocalEvidenceStorage({ rootDir: tempDir(tempDirs) }),
        now: () => new Date("2026-04-28T00:00:00Z")
      })
    });

    const uploadResponse = await router.handle({
      method: "POST",
      pathname: "/product/evidence",
      headers: { "x-uvp-principal-id": "slot-b" },
      body: {
        orderId: "order-1",
        taskId: "task-1",
        stageIdentifier: "stage-1",
        documentType: "doc-1",
        fileName: "doc-1.txt",
        textPayload: "doc-1 payload",
        metadata: {
          businessLabel: "Doc-1",
          fields: { "doc-1": "DOC-1" }
        },
        accessPolicy: {
          readers: ["slot-a"]
        }
      }
    });

    expect(uploadResponse.status).toBe(201);
    const upload = uploadResponse.body as { evidence: { evidenceId: string; payloadHash: string } };
    const proofResponse = await router.handle({
      method: "GET",
      pathname: `/product/evidence/${upload.evidence.evidenceId}/proof`,
      headers: { "x-uvp-principal-id": "slot-a" }
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
    const router = createApiRouter(stores.projectionStore, { ...requiredRouterStores(), productRuntimeEnvironment: "local", submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111",
      evidenceStorage: new RehearsalObjectEvidenceStorage({
        rootDir: tempDir(tempDirs),
        namespace: "uvp-route-rehearsal"
      }),
      evidenceRuntimeEnvironment: "testnet"
    });

    const session = await loginWalletSession(router, "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
    const uploadResponse = await router.handle({
      method: "POST",
      pathname: "/product/evidence",
      headers: { "x-uvp-store-session": session.token },
      body: {
        orderId: "order-1",
        taskId: "task-1",
        stageIdentifier: "stage-1",
        documentType: "doc-1",
        textPayload: "doc-1 payload",
        metadata: {
          fields: { "doc-1": "DOC-1" }
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
    const router = createApiRouter(stores.projectionStore, { ...requiredRouterStores(), productRuntimeEnvironment: "local", submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111",
      // 隔离元数据：rehearsal 用例已把同 payloadHash/owner 的记录写入共享库，
      // 复用会命中 findOwnedByPayloadHash 幂等去重而绕过这里的 S3 存储。
      evidenceMetadataStore: new InMemoryEvidenceMetadataStore(),
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

    const session = await loginWalletSession(router, "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
    const uploadResponse = await router.handle({
      method: "POST",
      pathname: "/product/evidence",
      headers: { "x-uvp-store-session": session.token },
      body: {
        orderId: "order-1",
        taskId: "task-1",
        stageIdentifier: "stage-1",
        documentType: "doc-1",
        textPayload: "doc-1 payload",
        metadata: {
          fields: { "doc-1": "DOC-1" }
        },
        accessPolicy: {
          readers: ["slot-a"]
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
      headers: { "x-uvp-store-session": session.token }
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
    const router = createApiRouter(stores.projectionStore, { ...requiredRouterStores(), submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111",
      productRuntimeEnvironment: "local",
      evidenceService: createEvidenceService({
    metadataStore: new InMemoryEvidenceMetadataStore(),
    runtimeEnvironment: "local",
        storage: new LocalEvidenceStorage({ rootDir: tempDir(tempDirs) }),
        now: () => new Date("2026-04-28T00:00:00Z")
      })
    });
    const uploadResponse = await router.handle({
      method: "POST",
      pathname: "/product/evidence",
      headers: { "x-uvp-principal-id": "slot-b" },
      body: {
        orderId: "order-1",
        stageIdentifier: "example-complete",
        documentType: "example-declaration",
        base64Payload: Buffer.from("example declaration").toString("base64"),
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
      status: 404,
      body: { error: "evidence_not_found" }
    });

    await expect(router.handle({
      method: "GET",
      pathname: `/product/evidence/${upload.evidence.evidenceId}`
    })).resolves.toMatchObject({
      status: 401,
      body: { error: "unauthenticated" }
    });

    await expect(router.handle({
      method: "GET",
      pathname: `/product/evidence/ev_missing`,
      headers: { "x-uvp-principal-id": "slot-b" }
    })).resolves.toMatchObject({
      status: 404,
      body: { error: "evidence_not_found" }
    });

    await expect(router.handle({
      method: "GET",
      pathname: `/product/evidence/ev_missing/proof`,
      headers: { "x-uvp-principal-id": "slot-b" }
    })).resolves.toMatchObject({
      status: 404,
      body: { error: "evidence_not_found" }
    });
  });

  it("audits admin proof reads through the route boundary", async () => {
    const metadataStore = new InMemoryEvidenceMetadataStore();
    const router = createApiRouter(stores.projectionStore, { ...requiredRouterStores(), submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111",
      productRuntimeEnvironment: "local",
      evidenceService: createEvidenceService({
    runtimeEnvironment: "local",
        metadataStore,
        storage: new LocalEvidenceStorage({ rootDir: tempDir(tempDirs) }),
        now: () => new Date("2026-04-28T00:00:00Z")
      })
    });
    const uploadResponse = await router.handle({
      method: "POST",
      pathname: "/product/evidence",
      headers: { "x-uvp-principal-id": "slot-b" },
      body: {
        orderId: "order-1",
        stageIdentifier: "example-complete",
        documentType: "example-declaration",
        textPayload: "example declaration",
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

async function loginWalletSession(
  router: ApiRouter,
  privateKey: `0x${string}`
): Promise<{ readonly token: string; readonly address: Address }> {
  const account = privateKeyToAccount(privateKey);
  const challengeResponse = await router.handle({
    method: "POST",
    pathname: "/store/auth/challenge",
    body: { address: account.address }
  });
  expect(challengeResponse.status).toBe(201);
  const { nonce, message } = (challengeResponse.body as { challenge: { nonce: string; message: string } }).challenge;
  const signature = await account.signMessage({ message });
  const verifyResponse = await router.handle({
    method: "POST",
    pathname: "/store/auth/verify",
    body: { nonce, signature }
  });
  expect(verifyResponse.status).toBe(201);
  const { token } = verifyResponse.body as { token: string };
  return { token, address: account.address };
}
