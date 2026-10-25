import { orderRequirementsConsentMessage } from "@uvp-eth/product-dto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { createApiRouter, type ApiRouter } from "../src/api/routes.js";
import { createNotificationService, createSupplierNotificationProfileConfigService, MemorySupplierNotificationProfileConfigStore } from "../src/notifications/index.js";
import type { ProductBffStore } from "../src/product/query/bff/store.js";
import type {
  DraftParticipantDTO,
  ProductOrderDraftDTO,
} from "../src/product/query/bff/types.js";
import type { Hex } from "../src/shared/types.js";
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

const draftIdBase = "draft_v1_requirements";
const zeroHash = `0x${"0".repeat(64)}` as Hex;
const contentHash = `0x${"a".repeat(64)}` as Hex;
const presetHash = `0x${"b".repeat(64)}` as Hex;
const creatorAccount = privateKeyToAccount(
  `0x${(1).toString(16).padStart(64, "0")}`,
);
const counterpartyAccount = privateKeyToAccount(
  `0x${(2).toString(16).padStart(64, "0")}`,
);
const creator = creatorAccount.address.toLowerCase();
const counterparty = counterpartyAccount.address.toLowerCase();
const declaredAt = "2026-04-01T00:00:00.000Z";

interface DeclarationResultBody {
  readonly draft: ProductOrderDraftDTO;
  readonly bundle: {
    readonly schemaVersion: string;
    readonly requirementsHash: string;
    readonly declaredBy: string;
    readonly consents?: readonly { readonly walletAddress: string }[];
  };
  readonly consentMessage: string;
  readonly triggerAnchor: {
    readonly requirementsHash: string;
    readonly consentedWallets: readonly string[];
  };
  readonly editable: boolean;
}

describe("V1 order requirement bundle", () => {
  it("declares a requirement bundle and reads back the server-computed hash", async () => {
    const { router, draftId } = await draftFixture();
    const declaration = requirementsDeclaration();

    const declared = await putRequirements(router, draftId, declaration);
    expect(declared.status, JSON.stringify(declared.body)).toBe(200);
    const declaredBody = declared.body as DeclarationResultBody;
    const requirementsHash = declaredBody.bundle.requirementsHash;
    expect(requirementsHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(declaredBody.draft.requirementsHash).toBe(requirementsHash);
    expect(declaredBody.bundle.declaredBy).toBe(creator);
    expect(declaredBody.triggerAnchor).toMatchObject({
      requirementsHash,
      consentedWallets: [],
    });
    expect(declaredBody.editable).toBe(true);

    const redeclared = await putRequirements(router, draftId, declaration);
    expect(
      (redeclared.body as DeclarationResultBody).bundle.requirementsHash,
    ).toBe(requirementsHash);

    const read = await router.handle({
      method: "GET",
      pathname: `/product/order-drafts/${draftId}/requirements`,
      headers: creatorHeaders(),
    });
    expect(read.status).toBe(200);
    expect((read.body as DeclarationResultBody).bundle).toEqual(
      declaredBody.bundle,
    );
    expect((read.body as DeclarationResultBody).consentMessage).toBe(
      declaredBody.consentMessage,
    );
  });

  it("binds counterparty consent to the declared hash and rejects another signature", async () => {
    const { router, draftId } = await draftFixture();
    const declaredBody = (await putRequirements(router, draftId, requirementsDeclaration()))
      .body as DeclarationResultBody;
    const requirementsHash = declaredBody.bundle.requirementsHash;
    const message = declaredBody.consentMessage;

    const signed = await postConsent(router, draftId, {
      requirementsHash,
      signature: await counterpartyAccount.signMessage({ message }),
    });
    expect(signed.status, JSON.stringify(signed.body)).toBe(200);
    const signedBody = signed.body as {
      readonly consent: { readonly walletAddress: string };
      readonly triggerAnchor: { readonly consentedWallets: readonly string[] };
    };
    expect(signedBody.consent.walletAddress).toBe(counterparty);
    expect(signedBody.triggerAnchor.consentedWallets).toEqual([counterparty]);

    const read = await router.handle({
      method: "GET",
      pathname: `/product/order-drafts/${draftId}/requirements`,
      headers: creatorHeaders(),
    });
    const consents = (read.body as DeclarationResultBody).bundle.consents ?? [];
    expect(consents.map((consent) => consent.walletAddress)).toEqual([
      counterparty,
    ]);

    const otherHash = `0x${"c".repeat(64)}` as `0x${string}`;
    const otherMessage = orderRequirementsConsentMessage(draftId, otherHash);
    const mismatched = await postConsent(router, draftId, {
      requirementsHash: otherHash,
      signature: await counterpartyAccount.signMessage({
        message: otherMessage,
      }),
    });
    expect(mismatched).toMatchObject({
      status: 409,
      body: { error: "requirements_hash_mismatch" },
    });

    const wrongSigner = await postConsent(router, draftId, {
      requirementsHash,
      signature: await creatorAccount.signMessage({ message }),
    });
    expect(wrongSigner).toMatchObject({
      status: 400,
      body: { error: "consent_signature_invalid" },
    });
  });

  it("rejects a file handle that carries credential material", async () => {
    const { router, draftId } = await draftFixture();
    const declaration = requirementsDeclaration();
    const requirement = declaration.requirements[0]!;
    const handle = requirement.handles[1]!;
    const response = await putRequirements(router, draftId, {
      ...declaration,
      requirements: [
        {
          ...requirement,
          handles: [
            requirement.handles[0]!,
            {
              ...handle,
              locator: {
                txCloudFile: {
                  ...handle.locator.txCloudFile!,
                  secretKey: "cos-secret-value",
                },
              },
            },
          ],
        },
      ],
    });
    expect(response).toMatchObject({
      status: 400,
      body: { error: "contains_secret_field" },
    });

    const read = await router.handle({
      method: "GET",
      pathname: `/product/order-drafts/${draftId}/requirements`,
      headers: creatorHeaders(),
    });
    expect(read).toMatchObject({
      status: 404,
      body: { error: "requirements_not_found" },
    });
  });

  it("refuses requirement edits once the draft entered the trigger lifecycle", async () => {
    const { router, bffStore, draftId } = await draftFixture();
    const draft = await bffStore.getDraft(draftId);
    expect(draft).toBeDefined();
    await bffStore.updateDraft({ ...draft!, status: "triggering" });

    const response = await putRequirements(router, draftId, requirementsDeclaration());
    expect(response).toMatchObject({
      status: 409,
      body: { error: "draft_not_editable" },
    });
  });
});

let fixtureSequence = 0;

// 草稿与要求包同引擎落 PG：order_requirement_bundle.draft_id 有指向
// product_order_draft 的外键，内存 BFF 台账会让 FK 直接拒绝。PG 主键为
// draft_id / participant_id，故每用例分配独立序号以保留草稿隔离语义。
async function draftFixture(): Promise<{
  readonly router: ApiRouter;
  readonly bffStore: ProductBffStore;
  readonly draftId: string;
}> {
  fixtureSequence += 1;
  const fixtureDraftId = `${draftIdBase}_${fixtureSequence}`;
  const bffStore = stores.productBffStore;
  const draft: ProductOrderDraftDTO = {
    draftId: fixtureDraftId,
    zhixuId: "zx-requirements-test",
    planId: zeroHash,
    planHash: zeroHash,
    title: "requirements test",
    businessType: "type-1",
    goods: [],
    totalAmount: "1000",
    currency: "tok-1",
    status: "draft",
    createdBy: creator,
    createdAt: declaredAt,
    updatedAt: declaredAt,
  };
  const participants: readonly DraftParticipantDTO[] = [
    {
      participantId: `participant_slot-b_${fixtureSequence}`,
      draftId: fixtureDraftId,
      roleSlotId: "slot-b",
      roleLabel: "slot-b",
      displayName: "Slot-b",
      walletAddress: counterparty,
      contact: "slot-b@example.com",
      status: "accepted",
      required: true,
      acceptedAt: declaredAt,
    },
  ];
  await bffStore.createDraft(draft, participants);
  const router = createApiRouter(stores.projectionStore, {
    productRuntimeEnvironment: "local",
    submissionChainId: 84532,
    submissionVerifyingContract: "0x1111111111111111111111111111111111111111",
    ...requiredRouterStores(),
  });
  return { router, bffStore, draftId: fixtureDraftId };
}

function creatorHeaders(): Record<string, string> {
  return { "x-uvp-wallet-address": creator };
}

function counterpartyHeaders(): Record<string, string> {
  return { "x-uvp-wallet-address": counterparty };
}

async function putRequirements(router: ApiRouter, draftId: string, body: unknown) {
  return router.handle({
    method: "PUT",
    pathname: `/product/order-drafts/${draftId}/requirements`,
    headers: creatorHeaders(),
    body,
  });
}

async function postConsent(
  router: ApiRouter,
  draftId: string,
  body: { readonly requirementsHash: string; readonly signature: string },
) {
  return router.handle({
    method: "POST",
    pathname: `/product/order-drafts/${draftId}/requirements/consents`,
    headers: counterpartyHeaders(),
    body,
  });
}

interface RequirementsDeclarationFixture {
  readonly schemaVersion: "uvp.order-requirements.v1";
  readonly requirements: readonly [
    {
      key: string;
      stageId: string;
      label: string;
      dueAt: string;
      handles: readonly [
        {
          key: string;
          fileType: "http";
          locator: { httpFile: { url: string } };
          contentHash: Hex;
          visibility: "protected";
          cipher: { alg: string; keyRef: string };
          metadata: { readonly note: string };
        },
        {
          key: string;
          fileType: "txcloud";
          locator: {
            txCloudFile: {
              bucket: string;
              region: string;
              objectKey: string;
            };
          };
        },
      ];
      presetRef: { name: string; version: string; hash: Hex };
    },
  ];
  readonly presets: readonly [
    { name: string; version: string; hash: Hex },
  ];
}

function requirementsDeclaration(): RequirementsDeclarationFixture {
  return {
    schemaVersion: "uvp.order-requirements.v1",
    requirements: [
      {
        key: "condition_report",
        stageId: "stage-1",
        label: "condition report",
        dueAt: "2026-05-01T00:00:00.000Z",
        handles: [
          {
            key: "condition_report_pdf",
            fileType: "http",
            locator: {
              httpFile: { url: "https://assets.example.com/report.pdf" },
            },
            contentHash,
            visibility: "protected",
            cipher: { alg: "aes256-gcm", keyRef: "keyring/example/evidence" },
            metadata: { note: "slot-a-designated slot-e2" },
          },
          {
            key: "acceptance_criteria",
            fileType: "txcloud",
            locator: {
              txCloudFile: {
                bucket: "example-evidence",
                region: "ap-guangzhou",
                objectKey: "criteria/v1.json",
              },
            },
          },
        ],
        presetRef: {
          name: "example-stage-1",
          version: "1.0.0",
          hash: presetHash,
        },
      },
    ],
    presets: [
      { name: "example-stage-1", version: "1.0.0", hash: presetHash },
    ],
  };
}
