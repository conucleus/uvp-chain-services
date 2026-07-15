import { describe, expect, it } from "vitest";
import type { StoreSupplierDTO } from "@uvp-eth/product-dto";
import {
  crossBorderPlanIds,
  CROSS_BORDER_ZHIXU_ID,
} from "@uvp-eth/product-dto/fixtures";
import { createApiRouter, type ApiRouter } from "../src/api/routes.js";
import {
  createGovernanceService,
  type GovernanceChainAdapter,
  type GovernanceChainRequestDTO,
} from "../src/governance/index.js";
import type { ChainEvent } from "../src/indexer/events.js";
import { MemoryProjectionStore } from "../src/storage/projection-store.js";
import {
  createStoreSupplierService,
  InMemoryStoreSupplierMetadataStore,
  type StoreSupplierAuditRecord,
  type StoreSupplierMetadataRecord,
} from "../src/store-suppliers/index.js";
import type { StoreIdentityProvider } from "../src/store-console/access.js";
import type {
  ProductService,
  ProductTaskApiDTO,
} from "../src/product/service.js";
import type { Address, Hex } from "../src/shared/types.js";
import type { ProductOrderDraftDTO } from "../src/product/bff/types.js";

const storeHeaders = {
  "x-uvp-store-operator-id": "store-operator-1",
  "x-uvp-store-operator-role": "store_operator",
};

const adminHeaders = {
  "x-uvp-admin-id": "store-admin-1",
  "x-uvp-admin-role": "admin",
};

const contractAddress = "0x1111111111111111111111111111111111111111";
const registryAddress = contractAddress as Address;
const deploymentRegistryAddress = "0x9999999999999999999999999999999999999999";
const activeDeploymentId =
  "0x0000000000000000000000000000000000000000000000000000000000000d02";
const registrar = "0x2222222222222222222222222222222222222222";
const supplierWallet = "0x4444444444444444444444444444444444444444";
const revokedWallet = "0x0000000000000000000000000000000000000001";
const supplierSubjectId =
  "0x0000000000000000000000000000000000000000000000000000000000003001" as Hex;
const revokedSupplierSubjectId =
  "0x0000000000000000000000000000000000000000000000000000000000003002" as Hex;
const metadataOnlySupplierSubjectId =
  "0x0000000000000000000000000000000000000000000000000000000000003003" as Hex;
const metadataOnlyWallet = "0x0000000000000000000000000000000000000045";
const stateMachineOrderId =
  "0x0000000000000000000000000000000000000000000000000000000000000202" as Hex;
const metadataOnlyOrderId =
  "0x0000000000000000000000000000000000000000000000000000000000000203" as Hex;
const hookId =
  "0x0000000000000000000000000000000000000000000000000000000000000303" as Hex;
const metadataOnlyHookId =
  "0x0000000000000000000000000000000000000000000000000000000000000304" as Hex;
const stageId = bytes32Text("export.customs") as Hex;
const hookName = bytes32Text("customs-review") as Hex;
const profileHash =
  "0x9999999999999999999999999999999999999999999999999999999999999999";
const capabilityHash =
  "0x8888888888888888888888888888888888888888888888888888888888888888";
const reputationHash =
  "0x7777777777777777777777777777777777777777777777777777777777777777";
const metadataHash =
  "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const policyHash =
  "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const reasonHash =
  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const artifactHash = crossBorderPlanIds.artifactHash;
const simulatedTx =
  "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" as Hex;
const bindingId =
  "0xabababababababababababababababababababababababababababababababab" as Hex;

describe("Store supplier directory API", () => {
  it("combines Store metadata, capability tags, and identity projection", async () => {
    const { router } = await createRouter([identityRegisteredEvent(2n)]);

    const created = await createSupplier(router);
    expect(created.identityStatus).toBe("active");
    expect(created.capabilityTags).toEqual(["customs", "logistics"]);
    expect(created.wallet).toBe(supplierWallet.toLowerCase());
    expect(created.proofRows).toContainEqual(
      expect.objectContaining({ value: "IdentityBindingRegistered" }),
    );

    const listResponse = await router.handle({
      method: "GET",
      pathname: "/store/suppliers",
      query: { identity: "active", tag: "logistics", query: "Shenzhen" },
    });

    expect(listResponse.status).toBe(200);
    const suppliers = (listResponse.body as { suppliers: StoreSupplierDTO[] })
      .suppliers;
    expect(suppliers).toHaveLength(1);
    expect(suppliers[0]).toMatchObject({
      supplierId: "supplier-shenzhen-logistics",
      supplierSubjectId,
      identityStatus: "active",
      identityLabel: "身份映射有效",
      reviewStatus: "draft",
    });
  });

  it("projects identity status across registration and revocation replay", async () => {
    const store = new MemoryProjectionStore();
    const metadataStore = new InMemoryStoreSupplierMetadataStore();
    let router = createApiRouter(store, {
      storeSupplierMetadataStore: metadataStore,
    });
    await createSupplier(router);

    const missing = await getSupplier(router, "supplier-shenzhen-logistics");
    expect(missing.identityStatus).toBe("not_found");

    await store.resetFromEvents({
      deploymentBlock: 0n,
      events: [identityRegisteredEvent(2n)],
    });
    const registered = await getSupplier(router, "supplier-shenzhen-logistics");
    expect(registered.identityStatus).toBe("active");

    await store.resetFromEvents({
      deploymentBlock: 0n,
      events: [identityRegisteredEvent(2n), identityRevokedEvent(3n)],
    });
    router = createApiRouter(store, {
      storeSupplierMetadataStore: metadataStore,
    });
    const revoked = await getSupplier(router, "supplier-shenzhen-logistics");
    expect(revoked.identityStatus).toBe("revoked");
    expect(revoked.proofRows).toContainEqual(
      expect.objectContaining({ value: "IdentityBindingRevoked" }),
    );

    const listResponse = await router.handle({
      method: "GET",
      pathname: "/store/suppliers",
      query: { identity: "revoked" },
    });
    expect(
      (listResponse.body as { suppliers: StoreSupplierDTO[] }).suppliers,
    ).toContainEqual(
      expect.objectContaining({
        supplierId: "supplier-shenzhen-logistics",
        identityStatus: "revoked",
      }),
    );
  });

  it("audits tag edits and delegates identity registration and revocation", async () => {
    const requests: GovernanceChainRequestDTO[] = [];
    const adapter: GovernanceChainAdapter = {
      async registerIdentity(request) {
        requests.push(request);
        return {
          status: "submitted",
          txHash: simulatedTx,
          signer: registrar,
          retryable: false,
          simulated: false,
        };
      },
      async revokeIdentity(request) {
        requests.push(request);
        return {
          status: "submitted",
          txHash: simulatedTx,
          signer: registrar,
          retryable: false,
          simulated: false,
        };
      },
    };
    const metadataStore = new InMemoryStoreSupplierMetadataStore();
    const projectionStore = new MemoryProjectionStore();
    const router = createApiRouter(projectionStore, {
      storeSupplierMetadataStore: metadataStore,
      governanceService: createGovernanceService({ adapter }),
    });
    await createSupplier(router);

    const review = await router.handle({
      method: "POST",
      pathname: "/store/suppliers/supplier-shenzhen-logistics/review",
      headers: storeHeaders,
      body: {
        reviewStatus: "approved_for_broadcast",
        capabilityTags: ["inspection", "logistics"],
        supportedRoleSlotIds: ["customs-broker", "logistics-operator"],
        supportedStageIds: ["export.customs"],
        publicSummary: "Approved for Store broadcast.",
        confirmation: {
          supplierId: "supplier-shenzhen-logistics",
        },
      },
    });
    expect(review.status).toBe(200);
    expect(
      (review.body as { supplier: StoreSupplierDTO }).supplier,
    ).toMatchObject({
      capabilityTags: ["inspection", "logistics"],
      supportedRoleSlotIds: ["customs-broker", "logistics-operator"],
      supportedStageIds: ["export.customs"],
    });

    const registration = await router.handle({
      method: "POST",
      pathname:
        "/store/suppliers/supplier-shenzhen-logistics/request-identity-registration",
      headers: adminHeaders,
      body: {
        confirmation: {
          supplierId: "supplier-shenzhen-logistics",
        },
      },
    });
    expect(registration.status).toBe(202);
    expect(registration.body).toMatchObject({
      supplier: {
        identityStatus: "not_found",
      },
      governance: {
        request: {
          kind: "registerIdentity",
          subjectId: supplierSubjectId,
          account: supplierWallet.toLowerCase(),
        },
      },
    });

    await projectionStore.resetFromEvents({
      deploymentBlock: 0n,
      events: [identityRegisteredEvent(2n)],
    });

    const revoke = await router.handle({
      method: "POST",
      pathname:
        "/store/suppliers/supplier-shenzhen-logistics/request-identity-revocation",
      headers: adminHeaders,
      body: {
        reason: "Operator review requested revocation.",
        confirmation: {
          supplierId: "supplier-shenzhen-logistics",
        },
      },
    });
    expect(revoke.status).toBe(202);
    expect(requests.map((request) => request.kind)).toEqual([
      "registerIdentity",
      "revokeIdentity",
    ]);

    const tagAudit = (
      await metadataStore.listAudits("supplier-shenzhen-logistics")
    ).find(
      (audit): audit is StoreSupplierAuditRecord =>
        audit.action === "tags_updated",
    );
    expect(tagAudit).toMatchObject({
      beforeTags: ["customs", "logistics"],
      afterTags: ["inspection", "logistics"],
      beforeSupportedRoleSlotIds: ["delivery"],
      afterSupportedRoleSlotIds: ["customs-broker", "logistics-operator"],
      beforeSupportedStageIds: ["customs-complete", "shipping"],
      afterSupportedStageIds: ["export.customs"],
    });

    const auditReadback = await router.handle({
      method: "GET",
      pathname: "/store/suppliers/supplier-shenzhen-logistics/audits",
      headers: storeHeaders,
    });
    expect(auditReadback.status).toBe(200);
    expect(auditReadback.body).toMatchObject({
      nonAuthoritative: true,
      identitySourceOfTruth:
        "IdentityBindingRegistered/IdentityBindingRevoked projection",
      records: expect.arrayContaining([
        expect.objectContaining({
          action: "tags_updated",
          actor: "store-operator-1",
          beforeTags: ["customs", "logistics"],
          afterTags: ["inspection", "logistics"],
          beforeSupportedRoleSlotIds: ["delivery"],
          afterSupportedRoleSlotIds: ["customs-broker", "logistics-operator"],
          beforeSupportedStageIds: ["customs-complete", "shipping"],
          afterSupportedStageIds: ["export.customs"],
        }),
      ]),
    });
  });

  it("does not let Store capability tags create signal authorization", async () => {
    const { router } = await createRouter([planRegisteredEvent(1n)]);
    await createSupplier(router, {
      wallet: "0x0000000000000000000000000000000000000009",
      capabilityTags: ["logistics", "inspection"],
    });

    const draft = await createDraft(router);
    const submitWithoutParticipants = await router.handle({
      method: "POST",
      pathname: `/product/order-drafts/${draft.draftId}/prepare-trigger`,
      body: { walletAddress: revokedWallet },
    });

    expect(submitWithoutParticipants.status).toBe(409);
    expect(submitWithoutParticipants.body).toMatchObject({
      error: "trigger_executor_not_accepted",
    });
  });

  it("counts open tasks by the supplier wallet stored in Store metadata", async () => {
    const store = new MemoryProjectionStore();
    const metadataStore = new InMemoryStoreSupplierMetadataStore();
    await store.resetFromEvents({
      deploymentBlock: 0n,
      events: [
        planRegisteredEvent(1n),
        ...stateMachineTaskEvents({
          blockNumber: 3n,
          orderId: stateMachineOrderId,
          hookId,
          wallet: supplierWallet,
        }),
        identityRegisteredEvent(7n, supplierSubjectId, supplierWallet),
        ...stateMachineTaskEvents({
          blockNumber: 8n,
          orderId: metadataOnlyOrderId,
          hookId: metadataOnlyHookId,
          wallet: metadataOnlyWallet,
        }),
      ],
    });
    const router = createApiRouter(store, {
      storeSupplierMetadataStore: metadataStore,
    });

    await createSupplier(router);
    await createSupplier(router, {
      supplierId: "supplier-wallet-only",
      supplierSubjectId: metadataOnlySupplierSubjectId,
      displayName: "Wallet Only Supplier",
      wallet: metadataOnlyWallet,
      capabilityTags: ["inspection"],
      supportedRoleSlotIds: ["inspection"],
      supportedStageIds: ["export.customs"],
    });

    await expect(
      getSupplier(router, "supplier-shenzhen-logistics"),
    ).resolves.toMatchObject({
      supplierSubjectId,
      identityStatus: "active",
      recentOrderCount: 1,
      openTaskCount: 1,
    });
    await expect(
      getSupplier(router, "supplier-wallet-only"),
    ).resolves.toMatchObject({
      supplierSubjectId: metadataOnlySupplierSubjectId,
      wallet: metadataOnlyWallet,
      identityStatus: "not_found",
      recentOrderCount: 1,
      openTaskCount: 1,
    });
  });

  it("does not turn identity revocation into a Product BFF authorization ban", async () => {
    const { router } = await createRouter([
      ...activeDeploymentEvents(),
      planRegisteredEvent(1n),
      identityRegisteredEvent(2n, revokedSupplierSubjectId, revokedWallet),
      identityRevokedEvent(3n, revokedSupplierSubjectId),
    ]);
    const draft = await createReadyDraft(router);

    const response = await router.handle({
      method: "POST",
      pathname: `/product/order-drafts/${draft.draftId}/prepare-trigger`,
      body: { walletAddress: revokedWallet },
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      prepared: { submitter: revokedWallet },
    });
  });

  it("returns 403 for unauthorized Store supplier write routes", async () => {
    const { router } = await createRouter([]);

    await expect(
      router.handle({
        method: "POST",
        pathname: "/store/suppliers",
        body: supplierBody(),
      }),
    ).resolves.toMatchObject({ status: 401 });

    await createSupplier(router);
    await expect(
      router.handle({
        method: "POST",
        pathname: "/store/suppliers/supplier-shenzhen-logistics/review",
        body: { reviewStatus: "submitted" },
      }),
    ).resolves.toMatchObject({ status: 401 });
    await expect(
      router.handle({
        method: "GET",
        pathname: "/store/suppliers/supplier-shenzhen-logistics/audits",
      }),
    ).resolves.toMatchObject({ status: 401 });
  });

  it("requires store.supplier.tags.update for role-slot and stage support edits", async () => {
    const metadataStore = new InMemoryStoreSupplierMetadataStore();
    const store = new MemoryProjectionStore();
    const router = createApiRouter(store, {
      storeSupplierMetadataStore: metadataStore,
    });
    await createSupplier(router);

    const reviewOnlyRouter = createApiRouter(store, {
      storeSupplierMetadataStore: metadataStore,
      storeIdentityProvider: reviewOnlyStoreIdentityProvider(),
    });

    await expect(
      reviewOnlyRouter.handle({
        method: "POST",
        pathname: "/store/suppliers/supplier-shenzhen-logistics/review",
        body: {
          reviewStatus: "submitted",
          supportedRoleSlotIds: ["customs-broker"],
          supportedStageIds: ["export.customs"],
        },
      }),
    ).resolves.toMatchObject({
      status: 403,
      body: {
        error: "forbidden",
        requiredCapability: "store.supplier.tags.update",
      },
    });
  });
});

async function createRouter(events: readonly ChainEvent[]): Promise<{
  readonly router: ApiRouter;
  readonly store: MemoryProjectionStore;
}> {
  const store = new MemoryProjectionStore();
  await store.resetFromEvents({ deploymentBlock: 0n, events });
  return {
    router: createApiRouter(store),
    store,
  };
}

function supplierBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    supplierId: "supplier-shenzhen-logistics",
    supplierSubjectId,
    displayName: "Shenzhen Logistics Partner",
    wallet: supplierWallet,
    capabilityTags: ["logistics", "customs"],
    supportedRoleSlotIds: ["delivery"],
    supportedStageIds: ["customs-complete", "shipping"],
    registryAddresses: [registryAddress],
    ...overrides,
  };
}

function reviewOnlyStoreIdentityProvider(): StoreIdentityProvider {
  return {
    async resolve() {
      return {
        level: "store_operator",
        principalId: "review-only-operator",
        roles: ["store_operator"],
        capabilities: [
          "store.read",
          "store.audit.read",
          "store.supplier.review",
        ],
        authMode: "jwt",
        canWrite: true,
        canAdmin: false,
      };
    },
  };
}

function metadataRecord(input: {
  readonly supplierId: string;
  readonly supplierSubjectId: Hex;
  readonly displayName: string;
  readonly wallet?: string;
}): StoreSupplierMetadataRecord {
  const record: Omit<StoreSupplierMetadataRecord, "wallet"> = {
    supplierId: input.supplierId,
    supplierSubjectId: input.supplierSubjectId,
    displayName: input.displayName,
    capabilityTags: [],
    supportedRoleSlotIds: [],
    supportedStageIds: [],
    registryAddresses: [registryAddress],
    reviewStatus: "draft",
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
  };
  return input.wallet
    ? {
        ...record,
        wallet: input.wallet as NonNullable<
          StoreSupplierMetadataRecord["wallet"]
        >,
      }
    : record;
}

function productTaskRecord(input: {
  readonly taskId: string;
  readonly orderId: string;
  readonly supplierSubjectId?: Hex;
  readonly assigneeWallet?: string;
}): ProductTaskApiDTO {
  return {
    taskId: input.taskId,
    orderId: input.orderId,
    orderTitle: "Chain order",
    zhixuId: CROSS_BORDER_ZHIXU_ID,
    title: "Supplier task",
    subtitle: "Supplier task",
    assigneeRole: "链上授权执行方",
    ...(input.assigneeWallet ? { assigneeWallet: input.assigneeWallet } : {}),
    ...(input.supplierSubjectId
      ? { supplierSubjectId: input.supplierSubjectId }
      : {}),
    stageId: "export.customs",
    stageName: "export.customs",
    deadline: "以业务约定为准",
    fundingImpact: "条件满足后进入下一步",
    requiredEvidence: [],
    status: "open",
    responsibilityStatements: [],
    proofRows: [],
  };
}

function taskOnlyProductService(
  tasks: readonly ProductTaskApiDTO[],
): ProductService {
  return {
    async listTasks() {
      return tasks;
    },
  } as ProductService;
}

async function createSupplier(
  router: ApiRouter,
  overrides: Record<string, unknown> = {},
): Promise<StoreSupplierDTO> {
  const response = await router.handle({
    method: "POST",
    pathname: "/store/suppliers",
    headers: storeHeaders,
    body: supplierBody(overrides),
  });
  expect(response.status).toBe(201);
  return (response.body as { supplier: StoreSupplierDTO }).supplier;
}

async function getSupplier(
  router: ApiRouter,
  supplierId: string,
): Promise<StoreSupplierDTO> {
  const response = await router.handle({
    method: "GET",
    pathname: `/store/suppliers/${supplierId}`,
  });
  expect(response.status).toBe(200);
  return (response.body as { supplier: StoreSupplierDTO }).supplier;
}

async function createDraft(router: ApiRouter): Promise<ProductOrderDraftDTO> {
  const response = await router.handle({
    method: "POST",
    pathname: "/product/order-drafts",
    body: {
      zhixuId: CROSS_BORDER_ZHIXU_ID,
      title: "A company purchase",
      businessType: "parallel-export",
      totalAmount: "10000",
      currency: "USDC",
      createdBy: "creator-wallet",
    },
  });
  expect(response.status).toBe(201);
  return (response.body as { draft: ProductOrderDraftDTO }).draft;
}

async function createReadyDraft(
  router: ApiRouter,
): Promise<ProductOrderDraftDTO> {
  const draft = await createDraft(router);
  const participantsResponse = await router.handle({
    method: "GET",
    pathname: `/product/orders/${draft.draftId}/participants`,
  });
  const participants = (
    participantsResponse.body as {
      participants: Array<{
        readonly roleSlotId: string;
        readonly required: boolean;
      }>;
    }
  ).participants.filter((participant) => participant.required);

  for (const [index, participant] of participants.entries()) {
    const inviteResponse = await router.handle({
      method: "POST",
      pathname: `/product/orders/${draft.draftId}/invites`,
      body: {
        roleSlotId: participant.roleSlotId,
        contact: `${participant.roleSlotId}@example.com`,
      },
    });
    const inviteId = (inviteResponse.body as { invite: { inviteId: string } })
      .invite.inviteId;
    const acceptResponse = await router.handle({
      method: "POST",
      pathname: `/product/invites/${inviteId}/accept`,
      body: {
        displayName: `${participant.roleSlotId} participant`,
        walletAddress: index === 0 ? revokedWallet : testWallet(index + 10),
        contact: `${participant.roleSlotId}@example.com`,
      },
    });
    expect(acceptResponse.status).toBe(200);
  }

  const readyResponse = await router.handle({
    method: "GET",
    pathname: `/product/order-drafts/${draft.draftId}`,
  });
  expect(
    (readyResponse.body as { draft: ProductOrderDraftDTO }).draft.status,
  ).toBe("ready_to_trigger");
  return (readyResponse.body as { draft: ProductOrderDraftDTO }).draft;
}

function planRegisteredEvent(blockNumber: bigint): ChainEvent {
  return chainEvent(blockNumber, 0, "PlanRegistered", {
    planId: crossBorderPlanIds.planId,
    planHash: crossBorderPlanIds.planHash,
    hookCount: 1n,
  });
}

function activeDeploymentEvents(): readonly ChainEvent[] {
  return [
    chainEvent(
      1n,
      0,
      "DeploymentRegistered",
      {
        deploymentId: activeDeploymentId,
        stateMachine: contractAddress,
        artifactHash,
        abiHash: metadataHash,
        deploymentBlock: 1n,
        metadataURI: "uvp-eth://deployments/store-suppliers",
      },
      deploymentRegistryAddress,
    ),
    chainEvent(
      2n,
      0,
      "DeploymentCanaryMarked",
      {
        deploymentId: activeDeploymentId,
        evidenceHash: metadataHash,
        evidenceURI: "uvp-eth://evidence/store-suppliers",
      },
      deploymentRegistryAddress,
    ),
    chainEvent(
      3n,
      0,
      "DeploymentActivated",
      {
        previousDeploymentId:
          "0x0000000000000000000000000000000000000000000000000000000000000000",
        newDeploymentId: activeDeploymentId,
        evidenceHash: metadataHash,
        evidenceURI: "uvp-eth://evidence/store-suppliers",
      },
      deploymentRegistryAddress,
    ),
  ];
}

function stateMachineTaskEvents(input: {
  readonly blockNumber: bigint;
  readonly orderId: Hex;
  readonly hookId: Hex;
  readonly wallet: string;
}): readonly ChainEvent[] {
  return [
    chainEvent(input.blockNumber, 0, "SignalCapabilityRegistered", {
      planId: crossBorderPlanIds.planId,
      stageId,
      targetSourceId: stageId,
      signalId: hookName,
      targetOrderRelation: 0,
    }),
    chainEvent(input.blockNumber + 1n, 0, "OrderRegistered", {
      orderId: input.orderId,
      planId: crossBorderPlanIds.planId,
    }),
    chainEvent(input.blockNumber + 2n, 0, "SignalSubmitterAuthorized", {
      orderId: input.orderId,
      sourceId: stageId,
      signalId: hookName,
      submitter: input.wallet,
      role: bytes32Text("customs-broker"),
      metadataHash,
    }),
    chainEvent(input.blockNumber + 3n, 0, "HookReady", {
      orderId: input.orderId,
      hookId: input.hookId,
      stageId,
      hookName,
    }),
  ];
}

function identityRegisteredEvent(
  blockNumber: bigint,
  subjectId: Hex = supplierSubjectId,
  wallet = supplierWallet,
): ChainEvent {
  return chainEvent(blockNumber, 0, "IdentityBindingRegistered", {
    bindingId,
    subjectId,
    account: wallet,
    descriptorHash: profileHash,
    descriptorURI: "https://store.example/suppliers/1",
    registrar: registrar,
  });
}

function identityRevokedEvent(
  blockNumber: bigint,
  subjectId: Hex = supplierSubjectId,
): ChainEvent {
  void subjectId;
  return chainEvent(blockNumber, 1, "IdentityBindingRevoked", {
    bindingId,
    reasonHash,
    reasonURI: "https://store.example/supplier-revocations/1",
    revoker: registrar,
  });
}

function chainEvent(
  blockNumber: bigint,
  logIndex: number,
  eventName: string,
  args: Record<string, unknown>,
  eventContractAddress: Address = contractAddress as Address,
): ChainEvent {
  return {
    chainId: 31337,
    contractAddress: eventContractAddress,
    blockNumber,
    transactionHash: `0x${blockNumber.toString(16).padStart(64, "0")}` as Hex,
    logIndex,
    eventName,
    args,
  };
}

function testWallet(index: number): string {
  return `0x${index.toString(16).padStart(40, "0")}`;
}

function bytes32Text(value: string): string {
  return `0x${Buffer.from(value, "utf8").toString("hex").padEnd(64, "0")}`;
}
