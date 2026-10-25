import { orderRequirementsConsentMessage } from "@uvp-eth/product-dto";
import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { createApiRouter, type ApiRouter } from "../src/api/routes.js";
import { MemoryProductBffStore } from "../src/product/query/bff/store.js";
import type {
  DraftParticipantDTO,
  ProductOrderDraftDTO,
} from "../src/product/query/bff/types.js";
import type { Hex } from "../src/shared/types.js";
import { MemoryProjectionStore } from "../src/storage/projection-store.js";

/**
 * V1 订单要求包行为：声明/读回与 hash 稳定、相对方合意绑定当前 hash、
 * 含凭据的句柄被拒、草稿进入触发生命周期后要求包冻结。
 */

const draftId = "draft_v1_requirements";
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
    const { router } = await draftFixture();
    const declaration = requirementsDeclaration();

    const declared = await putRequirements(router, declaration);
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

    // 同一份声明重报：hash 稳定（服务端 canonical JSON，不随重报漂移）。
    const redeclared = await putRequirements(router, declaration);
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
    const { router } = await draftFixture();
    const declaredBody = (await putRequirements(router, requirementsDeclaration()))
      .body as DeclarationResultBody;
    const requirementsHash = declaredBody.bundle.requirementsHash;
    // 读面下发的消息即签名消息：客户端不自拼格式，服务端按同一单源校验。
    const message = declaredBody.consentMessage;

    const signed = await postConsent(router, {
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

    // 签名覆盖的 hash 不是当前包：合意不成立，精确到 requirements_hash_mismatch。
    const otherHash = `0x${"c".repeat(64)}` as `0x${string}`;
    const otherMessage = orderRequirementsConsentMessage(draftId, otherHash);
    const mismatched = await postConsent(router, {
      requirementsHash: otherHash,
      signature: await counterpartyAccount.signMessage({
        message: otherMessage,
      }),
    });
    expect(mismatched).toMatchObject({
      status: 409,
      body: { error: "requirements_hash_mismatch" },
    });

    // 请求声明当前 hash，但签名来自别的钱包：签名不合，精确到 consent_signature_invalid。
    const wrongSigner = await postConsent(router, {
      requirementsHash,
      signature: await creatorAccount.signMessage({ message }),
    });
    expect(wrongSigner).toMatchObject({
      status: 400,
      body: { error: "consent_signature_invalid" },
    });
  });

  it("rejects a file handle that carries credential material", async () => {
    const { router } = await draftFixture();
    const declaration = requirementsDeclaration();
    const requirement = declaration.requirements[0]!;
    const handle = requirement.handles[1]!;
    const response = await putRequirements(router, {
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

    // 拒绝即不落库：读取仍是“未声明”，不是空的成功结果。
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
    const { router, bffStore } = await draftFixture();
    const draft = await bffStore.getDraft(draftId);
    expect(draft).toBeDefined();
    await bffStore.updateDraft({ ...draft!, status: "triggering" });

    const response = await putRequirements(router, requirementsDeclaration());
    expect(response).toMatchObject({
      status: 409,
      body: { error: "draft_not_editable" },
    });
  });
});

async function draftFixture(): Promise<{
  readonly router: ApiRouter;
  readonly bffStore: MemoryProductBffStore;
}> {
  const bffStore = new MemoryProductBffStore();
  const draft: ProductOrderDraftDTO = {
    draftId,
    zhixuId: "zx-requirements-test",
    planId: zeroHash,
    planHash: zeroHash,
    title: "requirements test",
    businessType: "parallel-export",
    goods: [],
    totalAmount: "1000",
    currency: "USDC",
    status: "draft",
    createdBy: creator,
    createdAt: declaredAt,
    updatedAt: declaredAt,
  };
  const participants: readonly DraftParticipantDTO[] = [
    {
      participantId: "participant_seller",
      draftId,
      roleSlotId: "seller",
      roleLabel: "seller",
      displayName: "Seller",
      walletAddress: counterparty,
      contact: "seller@example.com",
      status: "accepted",
      required: true,
      acceptedAt: declaredAt,
    },
  ];
  await bffStore.createDraft(draft, participants);
  const router = createApiRouter(new MemoryProjectionStore(), {
    productRuntimeEnvironment: "local",
    submissionChainId: 84532,
    submissionVerifyingContract: "0x1111111111111111111111111111111111111111",
    productBffStore: bffStore,
  });
  return { router, bffStore };
}

function creatorHeaders(): Record<string, string> {
  return { "x-uvp-wallet-address": creator };
}

function counterpartyHeaders(): Record<string, string> {
  return { "x-uvp-wallet-address": counterparty };
}

async function putRequirements(router: ApiRouter, body: unknown) {
  return router.handle({
    method: "PUT",
    pathname: `/product/order-drafts/${draftId}/requirements`,
    headers: creatorHeaders(),
    body,
  });
}

async function postConsent(
  router: ApiRouter,
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
        stageId: "inspection",
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
            metadata: { note: "buyer-designated inspector" },
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
          name: "example-inspection",
          version: "1.0.0",
          hash: presetHash,
        },
      },
    ],
    presets: [
      { name: "example-inspection", version: "1.0.0", hash: presetHash },
    ],
  };
}
