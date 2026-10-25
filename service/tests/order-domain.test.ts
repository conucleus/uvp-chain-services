import { planIdForPublisher } from "@uvp-eth/compiler";
import { deriveTriggerOrderId } from "@uvp-eth/protocol-bindings";
import { keccak256, stringToHex } from "viem";
import type { ConfigBundle, ConfigStage } from "@uvp-eth/product-dto";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiRouter, type ApiRouter } from "../src/api/routes.js";
import { createNotificationService, createSupplierNotificationProfileConfigService, MemorySupplierNotificationProfileConfigStore } from "../src/notifications/index.js";
import {
  ProtocolOrderBirthAdapter,
  PostgresOrderStore,
  configWindowValues,
  type OrderBirthInput,
  type OrderStageRecord,
  type OrderTriggerInput,
} from "../src/order/index.js";
import { StorageConstraintError } from "../src/storage/errors.js";
import { createChainServicesStores, type ChainServicesStores } from "../src/storage/factory.js";
import { PostgresDatabase } from "../src/storage/postgres-client.js";
import { listAppliedPostgresMigrations } from "../src/storage/postgres-migrations.js";
import { PostgresProjectionStore } from "../src/storage/postgres.js";
import { createPostgresTestDatabase } from "./postgres.js";
import type { Address } from "../src/shared/types.js";

const stateMachine = "0x9999999999999999999999999999999999999999" as Address;
const operator = privateKeyToAccount(`0x${"01".repeat(32)}`);
const slotA = privateKeyToAccount(`0x${"02".repeat(32)}`);
const performer = privateKeyToAccount(`0x${"03".repeat(32)}`);
const stranger = privateKeyToAccount(`0x${"04".repeat(32)}`);
const birthAuthorizer = privateKeyToAccount(`0x${"07".repeat(32)}`);
const birthRoute = {
  triggerHookId: `0x${"0a".repeat(32)}`,
  triggerStageId: `0x${"0b".repeat(32)}`,
  sourceId: `0x${"0c".repeat(32)}`,
  signalId: `0x${"0d".repeat(32)}`,
  birthAuthorizer: birthAuthorizer.address.toLowerCase(),
  attribution: {
    sourceId: `0x${"0c".repeat(32)}`,
    signalId: `0x${"0d".repeat(32)}`,
    stageId: `0x${"0e".repeat(32)}`,
    capabilityProof: [`0x${"0f".repeat(32)}`],
  },
  authorizations: [
    {
      sourceId: `0x${"0c".repeat(32)}`,
      signalId: `0x${"0d".repeat(32)}`,
      submitter: birthAuthorizer.address.toLowerCase(),
      role: `0x${"1a".repeat(32)}`,
      metadataHash: `0x${"1b".repeat(32)}`,
    },
  ],
};
const publishedPlanId = `0x${"11".repeat(32)}`;
const publishedPlanHash = `0x${"22".repeat(32)}`;
const orderId = `0x${"33".repeat(32)}`;
const alphaHash = `sha256:${"ab".repeat(32)}`;

let clock = new Date("2026-10-25T00:00:00.000Z");
const now = () => clock;

let projectionStore: PostgresProjectionStore;
const fixtureStores: ChainServicesStores[] = [];

beforeAll(async () => {
  projectionStore = new PostgresProjectionStore({
    databaseUrl: await createPostgresTestDatabase()
  });
});

afterAll(async () => {
  await projectionStore.close();
  for (const stores of fixtureStores.splice(0)) {
    await stores.close();
  }
});

function requiredRouterStores(stores: ChainServicesStores) {
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

function configBundle(overrides: Record<string, unknown> = {}) {
  return {
    configId: "test/flow",
    version: "1.0.0",
    status: "published",
    title: "Test flow",
    currency: "tok-1",
    defaults: { fees: { feeBps: 100, feeRecipientPolicy: "policy-1" } },
    windows: [
      { key: "win_a", default: "7d", min: "1h", max: "30d" },
      { key: "win_b", default: "10d", min: "1d", max: "30d" },
    ],
    timeDefaults: [
      { name: "win_a", expr: "approved +{{win_a}}" },
      { name: "win_b", expr: "approved +{{win_b}}" },
    ],
    slots: [
      { key: "slot-a", label: "Slot-a", kind: "participant" },
      { key: "performer", label: "Performer", kind: "participant" },
      { key: "verifier", label: "Verifier", kind: "participant" },
    ],
    stages: [
      {
        key: "alpha",
        name: "Alpha",
        index: 1,
        funded: true,
        slots: { performer: "performer" },
        senders: ["performer"],
        acceptance: { mode: "self", verifierSlot: "slot-a" },
        time: [{ name: "win_a" }],
        feeBps: 100,
        fileResources: ["std/alpha"],
      },
      {
        key: "beta",
        name: "Beta",
        index: 2,
        funded: true,
        slots: { performer: "performer", verifier: "verifier" },
        senders: ["performer", "verifier"],
        acceptance: { mode: "third_party", verifierSlot: "verifier" },
        time: [{ name: "win_b" }],
        feeBps: 100,
        fileResources: ["std/alpha"],
      },
    ],
    fileResources: [{ name: "std/alpha", ref: "harness/alpha.md", version: "1" }],
    hashes: { algorithm: "sha256", fileResources: { "std/alpha": alphaHash } },
    ...overrides,
  };
}

function term(stageKey: string, extra: Record<string, unknown> = {}) {
  return {
    stageKey,
    amount: "1000000",
    feeBps: 100,
    inviteDeadline: "2026-11-01T00:00:00.000Z",
    workDeadline: "2026-11-20T00:00:00.000Z",
    ...extra,
  };
}

function identityProvider() {
  return {
    async resolve(headers: Record<string, string | undefined> | undefined) {
      const wallet = headers?.["x-test-wallet"];
      if (!wallet) {
        return {
          level: "anonymous_read" as const,
          roles: [] as const,
          capabilities: [] as const,
          authMode: "anonymous" as const,
          canWrite: false,
          canAdmin: false,
        };
      }
      return {
        level: "store_operator" as const,
        roles: [] as const,
        capabilities: [] as const,
        authMode: "dev_store_headers" as const,
        canWrite: true,
        canAdmin: false,
        anchoredAddress: wallet as Address,
        anchorSource: "dev_header" as const,
      };
    },
  };
}

interface Fixture {
  readonly router: ApiRouter;
  readonly triggerCalls: OrderTriggerInput[];
  readonly birthInputs: OrderBirthInput[];
}

async function fixture(options: {
  readonly publishProviderFails?: boolean;
  readonly publishProviderMismatch?: boolean;
} = {}): Promise<Fixture> {
  clock = new Date("2026-10-25T00:00:00.000Z");
  const bundle = createChainServicesStores({
    database: { url: await createPostgresTestDatabase(), migrationsAutoRun: true }
  });
  fixtureStores.push(bundle);
  const triggerCalls: OrderTriggerInput[] = [];
  const birthInputs: OrderBirthInput[] = [];
  const protocolBirth = new ProtocolOrderBirthAdapter({
    triggerSigner: (typedData) => birthAuthorizer.signTypedData(typedData),
  });
  const router = createApiRouter(projectionStore, {
    ...requiredRouterStores(bundle),
    productRuntimeEnvironment: "local",
    submissionChainId: 31337,
    submissionVerifyingContract: stateMachine,
    productTriggerChainId: 31337,
    orderChainId: 31337,
    orderStateMachineAddress: stateMachine,
    orderConfigPublisherWallets: [operator.address.toLowerCase() as Address],
    ...(options.publishProviderFails
      ? {
        orderPublishedPlanProvider: {
          async resolvePublishedPlan() {
            throw new Error("published plan bridge offline");
          },
        },
      }
      : options.publishProviderMismatch
        ? {
          orderPublishedPlanProvider: {
            async resolvePublishedPlan() {
              return { planId: `0x${"88".repeat(32)}`, planHash: publishedPlanHash as `0x${string}` };
            },
          },
        }
        : {}),
    orderBirthPort: {
      async birthOrder(input) {
        birthInputs.push(input);
        return protocolBirth.birthOrder(input);
      },
    },
    storeIdentityProvider: identityProvider() as never,
    now,
  });
  return { router, triggerCalls, birthInputs };
}

function headers(wallet: string | undefined): Record<string, string> {
  return wallet ? { "x-test-wallet": wallet.toLowerCase() } : {};
}

async function publishConfig(
  router: ApiRouter,
  bundle: unknown,
  extra: Record<string, unknown> = {},
) {
  const { omitPlan = false, omitBirth = false, ...rest } = extra;
  return router.handle({
    method: "POST",
    pathname: "/product/v3/configs",
    headers: { ...headers(operator.address), "content-type": "application/json" },
    body: {
      config: bundle,
      ...(omitPlan ? {} : { planId: publishedPlanId, planHash: publishedPlanHash }),
      ...(omitBirth ? {} : { birth: birthRoute }),
      ...rest,
    },
  });
}

async function createDraft(
  router: ApiRouter,
  wallet: Address,
  body: Record<string, unknown>,
  idempotencyKey?: string,
) {
  return router.handle({
    method: "POST",
    pathname: "/product/v3/order-drafts",
    headers: {
      ...headers(wallet),
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    },
    body,
  });
}

function draftBody(overrides: Record<string, unknown> = {}) {
  return {
    configId: "test/flow",
    configVersion: "1.0.0",
    title: "Order",
    currency: "tok-1",
    stageSubset: ["alpha"],
    stageTerms: [term("alpha")],
    ...overrides,
  };
}

async function inviteAndPreview(
  router: ApiRouter,
  draftId: string,
  wallet: Address,
  slotKey = "performer",
  bindWallet = true,
) {
  const invite = await router.handle({
    method: "POST",
    pathname: `/product/v3/order-drafts/${draftId}/invites`,
    headers: headers(slotA.address),
    body: {
      stageKey: "alpha",
      slotKey,
      subjectLabel: "Performer",
      ...(bindWallet ? { wallet: wallet.toLowerCase() } : {}),
      expiresAt: "2026-11-01T00:00:00.000Z",
    },
  });
  expect(invite.status, JSON.stringify(invite.body)).toBe(201);
  const created = invite.body as { inviteId: string; inviteToken: string };
  const preview = await router.handle({
    method: "POST",
    pathname: `/product/v3/invites/${created.inviteId}/preview`,
    headers: headers(wallet),
    body: { token: created.inviteToken },
  });
  return { created, preview };
}

async function acceptInvite(
  router: ApiRouter,
  inviteId: string,
  token: string,
  signer: typeof performer,
  previewBody: Record<string, unknown>,
  idempotencyKey?: string,
) {
  const typed = previewBody as unknown as {
    typedData: Parameters<typeof signer.signTypedData>[0];
    terms: { termsHash: string };
  };
  expect(typed.typedData).toBeTruthy();
  const signature = await signer.signTypedData(typed.typedData);
  return router.handle({
    method: "POST",
    pathname: `/product/v3/invites/${inviteId}/accept`,
    headers: {
      ...headers(signer.address),
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    },
    body: {
      token,
      signature,
      termsHash: typed.terms.termsHash,
      nonce: (typed.typedData.message as { nonce: string }).nonce,
    },
  });
}

async function prepareFinalize(router: ApiRouter, draftId: string) {
  return router.handle({
    method: "POST",
    pathname: `/product/v3/order-drafts/${draftId}/finalize/prepare`,
    headers: headers(slotA.address),
    body: {},
  });
}

async function finalizeWithSignature(
  router: ApiRouter,
  draftId: string,
  signer: typeof slotA = slotA,
  idempotencyKey?: string,
) {
  const prepared = await prepareFinalize(router, draftId);
  expect(prepared.status, JSON.stringify(prepared.body)).toBe(200);
  const typed = (prepared.body as { typedData: Parameters<typeof signer.signTypedData>[0] }).typedData;
  const signature = await signer.signTypedData(typed);
  return router.handle({
    method: "POST",
    pathname: `/product/v3/order-drafts/${draftId}/finalize`,
    headers: {
      ...headers(slotA.address),
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    },
    body: { signature },
  });
}

describe("order config registry", () => {
  it("publishes an immutable version and rejects hash mismatch / content drift", async () => {
    const { router } = await fixture();
    const bundle = configBundle();
    const published = await publishConfig(router, bundle);
    expect(published.status, JSON.stringify(published.body)).toBe(201);
    const body = published.body as { configHash: string; version: string; status: string };
    expect(body.configHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(body.version).toBe("1.0.0");

    const read = await router.handle({
      method: "GET",
      pathname: "/product/v3/configs/test/flow/1.0.0",
      headers: headers(slotA.address),
    });
    expect(read.status).toBe(200);
    expect((read.body as { configHash: string }).configHash).toBe(body.configHash);

    const badHash = await publishConfig(router, configBundle(), { configHash: `0x${"00".repeat(32)}` });
    expect(badHash.status).toBe(422);
    expect((badHash.body as { error: string }).error).toBe("config_hash_mismatch");

    const drift = await publishConfig(router, configBundle({ title: "Changed" }));
    expect(drift.status).toBe(409);
    expect((drift.body as { error: string }).error).toBe("config_version_exists");

    const republished = await publishConfig(router, bundle);
    expect(republished.status).toBe(201);
    expect((republished.body as { configHash: string }).configHash).toBe(body.configHash);

    const deprecated = await router.handle({
      method: "POST",
      pathname: "/product/v3/configs/test/flow/1.0.0/deprecate",
      headers: headers(operator.address),
    });
    expect(deprecated.status).toBe(200);
    expect((deprecated.body as { status: string }).status).toBe("deprecated");

    const irrelevant = await publishConfig(router, configBundle());
    expect(irrelevant.status).toBe(201);

    const draftAgainstDeprecated = await createDraft(router, slotA.address as Address, draftBody());
    expect(draftAgainstDeprecated.status).toBe(409);
    expect((draftAgainstDeprecated.body as { error: string }).error).toBe("config_not_published");

    const forbidden = await router.handle({
      method: "POST",
      pathname: "/product/v3/configs",
      headers: headers(slotA.address),
      body: { config: configBundle({ version: "2.0.0" }) },
    });
    expect(forbidden.status).toBe(403);
  });

  it("stores the registration planId, rejects contentPlanId, and verifies publisher+runtimePlanHash", async () => {
    const runtimePlanHash = `0x${"3a".repeat(32)}` as const;
    const registrationPlanId = planIdForPublisher(operator.address, runtimePlanHash);
    {
      const { router } = await fixture();
      const published = await publishConfig(router, configBundle(), {
        omitPlan: true,
        planId: registrationPlanId,
        planHash: publishedPlanHash,
        publisher: operator.address,
        runtimePlanHash,
      });
      expect(published.status, JSON.stringify(published.body)).toBe(201);
      const read = await router.handle({
        method: "GET",
        pathname: "/product/v3/configs/test/flow/versions/1.0.0",
        headers: headers(slotA.address),
      });
      expect((read.body as { planId: string }).planId).toBe(registrationPlanId);
    }
    {
      const { router } = await fixture();
      const contentPlanId = `0x${"99".repeat(32)}`;
      const rejected = await router.handle({
        method: "POST",
        pathname: "/product/v3/configs",
        headers: headers(operator.address),
        body: { config: configBundle(), plan: { contentPlanId } },
      });
      expect(rejected.status).toBe(422);
      expect((rejected.body as { error: string }).error).toBe("registration_plan_required");
    }
    {
      const { router } = await fixture();
      const mismatch = await publishConfig(router, configBundle(), {
        omitPlan: true,
        planId: `0x${"77".repeat(32)}`,
        planHash: publishedPlanHash,
        publisher: operator.address,
        runtimePlanHash,
      });
      expect(mismatch.status).toBe(422);
      expect((mismatch.body as { error: string }).error).toBe("registration_plan_mismatch");
    }
  });

  it("derives windows from the bound config version only", () => {
    const v1 = configBundle();
    const v2 = configBundle({
      version: "2.0.0",
      windows: [
        { key: "win_a", default: "10d", min: "1h", max: "30d" },
        { key: "win_b", default: "10d", min: "1d", max: "30d" },
      ],
    });
    const stage1 = (v1.stages as unknown as ConfigStage[])[0]!;
    const stage2 = (v2.stages as unknown as ConfigStage[])[0]!;
    expect(configWindowValues(v1 as unknown as ConfigBundle, stage1)).toEqual({ win_a: 604800 });
    expect(configWindowValues(v2 as unknown as ConfigBundle, stage2)).toEqual({ win_a: 864000 });
  });
});

describe("order draft lifecycle", () => {
  it("creates, invites, accepts, finalizes with canonical stage ids and the published plan", async () => {
    const { router, birthInputs } = await fixture();
    await publishConfig(router, configBundle(), { planId: publishedPlanId, planHash: publishedPlanHash });
    const created = await createDraft(router, slotA.address as Address, draftBody());
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const detail = created.body as {
      draft: {
        draftId: string;
        status: string;
        stages: { stageKey: string; stageId: string; inviteDeadline: string; workDeadline: string }[];
        termsHash: string | null;
      };
      slots: { slotKey: string; status: string }[];
    };
    expect(detail.draft.status).toBe("draft");
    expect(detail.draft.termsHash).toBeNull();
    const alpha = detail.draft.stages[0]!;
    expect(alpha.stageKey).toBe("alpha");
    expect(alpha.stageId).toBe(keccak256(stringToHex("alpha")));
    expect(alpha.inviteDeadline).toBe("2026-11-01T00:00:00.000Z");
    expect(alpha.workDeadline).toBe("2026-11-20T00:00:00.000Z");
    expect((alpha as { windowValues?: unknown }).windowValues).toBeUndefined();

    const { created: invite, preview } = await inviteAndPreview(router, detail.draft.draftId, performer.address as Address);
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    const previewBody = preview.body as {
      terms: { termsHash: string; stageId: string };
      typedData: { domain: { name: string; version: string; verifyingContract: string }; primaryType: string; message: { stageId: string; invitee: string } };
    };
    expect(previewBody.terms.stageId).toBe(keccak256(stringToHex("alpha")));
    expect(previewBody.typedData.domain.name).toBe("UVPOrderBook");
    expect(previewBody.typedData.domain.version).toBe("1");
    expect(previewBody.typedData.domain.verifyingContract.toLowerCase()).toBe(stateMachine);
    expect(previewBody.typedData.primaryType).toBe("UVPStageInviteAccept");

    const accepted = await acceptInvite(router, invite.inviteId, invite.inviteToken, performer, preview.body as never);
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect((accepted.body as { draftStatus: string }).draftStatus).toBe("ready");

    const finalize = await finalizeWithSignature(router, detail.draft.draftId);
    expect(finalize.status, JSON.stringify(finalize.body)).toBe(200);
    const result = finalize.body as {
      orderId: string;
      planId: string;
      stateMachine: string;
      status: string;
      fundedStageKeys: string[];
      skippedStageKeys: string[];
    };
    expect(result).toMatchObject({
      planId: publishedPlanId,
      status: "unknown",
      fundedStageKeys: ["alpha"],
      skippedStageKeys: [],
    });
    expect(birthInputs).toHaveLength(1);
    expect(birthInputs[0]!.planId).toBe(publishedPlanId);
    expect(birthInputs[0]!.planHash).toBe(publishedPlanHash);
    expect(birthInputs[0]!.birth.birthAuthorizer).toBe(birthRoute.birthAuthorizer);
    expect(birthInputs[0]!.birth.attribution).toEqual(birthRoute.attribution);
    expect(birthInputs[0]!.birth.authorizations).toEqual(birthRoute.authorizations);
    expect(birthInputs[0]!.stageBindings.some((binding) => binding.slotKey === "performer")).toBe(true);
    expect(result.orderId).toBe(
      deriveTriggerOrderId(
        publishedPlanId,
        birthRoute.sourceId,
        birthRoute.signalId,
        birthInputs[0]!.payloadHash,
      ),
    );

    const updateAfterTrigger = await router.handle({
      method: "PATCH",
      pathname: `/product/v3/order-drafts/${detail.draft.draftId}`,
      headers: headers(slotA.address),
      body: { title: "changed" },
    });
    expect(updateAfterTrigger.status).toBe(409);
    expect((updateAfterTrigger.body as { error: string }).error).toBe("draft_frozen");
  });

  it("rejects order-level window overrides and keeps opener deadlines", async () => {
    const { router } = await fixture();
    await publishConfig(router, configBundle());

    for (const body of [
      draftBody({ stageTerms: [term("alpha", { windowValues: { win_a: "10d" } })] }),
      draftBody({ windowValues: { alpha: { win_a: "10d" } } }),
    ]) {
      const rejected = await createDraft(router, slotA.address as Address, body);
      expect(rejected.status, JSON.stringify(rejected.body)).toBe(422);
      expect((rejected.body as { error: string }).error).toBe("window_override_forbidden");
    }

    const accepted = await createDraft(router, slotA.address as Address, draftBody());
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
    const draft = accepted.body as {
      draft: {
        draftId: string;
        stages: { inviteDeadline: string; workDeadline: string }[];
      };
    };
    expect(draft.draft.stages[0]!.inviteDeadline).toBe("2026-11-01T00:00:00.000Z");
    expect(draft.draft.stages[0]!.workDeadline).toBe("2026-11-20T00:00:00.000Z");

    const patchRejected = await router.handle({
      method: "PATCH",
      pathname: `/product/v3/order-drafts/${draft.draft.draftId}`,
      headers: headers(slotA.address),
      body: { stageTerms: [term("alpha", { windowValues: { win_a: 86400 } })] },
    });
    expect(patchRejected.status).toBe(422);
    expect((patchRejected.body as { error: string }).error).toBe("window_override_forbidden");

    const finalizeRejected = await router.handle({
      method: "POST",
      pathname: `/product/v3/order-drafts/${draft.draft.draftId}/finalize`,
      headers: headers(slotA.address),
      body: { windowValues: { alpha: { win_a: "10d" } } },
    });
    expect(finalizeRejected.status).toBe(422);
    expect((finalizeRejected.body as { error: string }).error).toBe("window_override_forbidden");

    const clientStageId = await createDraft(
      router,
      slotA.address as Address,
      draftBody({ stageTerms: [term("alpha", { stageId: `0x${"00".repeat(32)}` })] }),
    );
    expect(clientStageId.status).toBe(422);
    expect((clientStageId.body as { error: string }).error).toBe("invalid_stage_terms");
  });

  it("is idempotent for draft creation and rejects key reuse", async () => {
    const { router } = await fixture();
    await publishConfig(router, configBundle());
    const first = await createDraft(router, slotA.address as Address, draftBody(), "create-key-1");
    expect(first.status).toBe(201);
    const draftId = (first.body as { draft: { draftId: string } }).draft.draftId;
    const replay = await createDraft(router, slotA.address as Address, draftBody(), "create-key-1");
    expect(replay.status).toBe(201);
    expect((replay.body as { draft: { draftId: string } }).draft.draftId).toBe(draftId);
    const reuse = await createDraft(router, slotA.address as Address, draftBody({ title: "other" }), "create-key-1");
    expect(reuse.status).toBe(409);
    expect((reuse.body as { error: string }).error).toBe("idempotency_key_reuse");
  });
});

describe("finalize binds the curator's published plan", () => {
  async function readyDraft(router: ApiRouter): Promise<string> {
    const created = (await createDraft(router, slotA.address as Address, draftBody())).body as {
      draft: { draftId: string };
    };
    const draftId = created.draft.draftId;
    const { created: invite, preview } = await inviteAndPreview(router, draftId, performer.address as Address);
    const accepted = await acceptInvite(router, invite.inviteId, invite.inviteToken, performer, preview.body as never);
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    return draftId;
  }

  it("fails closed when the bound config version has no published plan", async () => {
    const { router } = await fixture();
    await publishConfig(router, configBundle(), { omitPlan: true });
    const draftId = await readyDraft(router);
    const prepared = await prepareFinalize(router, draftId);
    expect(prepared.status).toBe(409);
    expect((prepared.body as { error: string }).error).toBe("published_plan_missing");
  });

  it("reuses the same published plan across orders and only mints new order ids", async () => {
    const { router, birthInputs } = await fixture();
    await publishConfig(router, configBundle());

    const results = [];
    for (let index = 0; index < 2; index += 1) {
      const draftId = await readyDraft(router);
      const finalize = await finalizeWithSignature(router, draftId);
      expect(finalize.status, JSON.stringify(finalize.body)).toBe(200);
      results.push(finalize.body as { orderId: string; planId: string });
    }
    expect(results.map((result) => result.planId)).toEqual([publishedPlanId, publishedPlanId]);
    expect(results[0]!.orderId).not.toBe(results[1]!.orderId);
    expect(birthInputs.map((call) => call.planId)).toEqual([publishedPlanId, publishedPlanId]);
  });

  it("rejects a provider planId that differs from the registered planId", async () => {
    const { router } = await fixture({ publishProviderMismatch: true });
    await publishConfig(router, configBundle());
    const draftId = await readyDraft(router);
    const prepared = await prepareFinalize(router, draftId);
    expect(prepared.status).toBe(503);
    expect((prepared.body as { error: string }).error).toBe("published_plan_mismatch");
  });

  it("returns 503 when the published-plan provider is unavailable", async () => {
    const { router } = await fixture({ publishProviderFails: true });
    await publishConfig(router, configBundle());
    const draftId = await readyDraft(router);
    const prepared = await prepareFinalize(router, draftId);
    expect(prepared.status).toBe(503);
    expect((prepared.body as { error: string }).error).toBe("published_plan_unavailable");
  });
});

describe("order birth channel (outside-trigger + birthAuthorizer)", () => {
  async function makeReadyDraft(router: ApiRouter, body: Record<string, unknown> = draftBody()): Promise<string> {
    const created = (await createDraft(router, slotA.address as Address, body)).body as {
      draft: { draftId: string };
    };
    const draftId = created.draft.draftId;
    const { created: invite, preview } = await inviteAndPreview(router, draftId, performer.address as Address);
    const accepted = await acceptInvite(router, invite.inviteId, invite.inviteToken, performer, preview.body as never);
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    return draftId;
  }

  it("requires slot-a signature, is idempotent, and never re-births an unknown order", async () => {
    const { router, birthInputs } = await fixture();
    await publishConfig(router, configBundle());
    const draftId = await makeReadyDraft(router);

    const unsigned = await router.handle({
      method: "POST",
      pathname: `/product/v3/order-drafts/${draftId}/finalize`,
      headers: headers(slotA.address),
      body: {},
    });
    expect(unsigned.status).toBe(422);
    expect((unsigned.body as { error: string }).error).toBe("finalize_signature_required");

    const prepared = await prepareFinalize(router, draftId);
    expect(prepared.status, JSON.stringify(prepared.body)).toBe(200);
    const preparation = prepared.body as {
      typedData: Parameters<typeof slotA.signTypedData>[0];
      planId: string;
      payloadHash: string;
      fundedStageKeys: string[];
    };
    expect(preparation.planId).toBe(publishedPlanId);
    expect(preparation.typedData.primaryType).toBe("UVPOrderFinalize");
    const signature = await slotA.signTypedData(preparation.typedData);

    const first = await router.handle({
      method: "POST",
      pathname: `/product/v3/order-drafts/${draftId}/finalize`,
      headers: { ...headers(slotA.address), "idempotency-key": "birth-key-1" },
      body: { signature },
    });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const firstBody = first.body as { orderId: string; planId: string; status: string };
    expect(firstBody.planId).toBe(publishedPlanId);
    expect(firstBody.status).toBe("unknown");
    const expectedOrderId = deriveTriggerOrderId(
      publishedPlanId,
      birthRoute.sourceId,
      birthRoute.signalId,
      preparation.payloadHash,
    );
    expect(firstBody.orderId).toBe(expectedOrderId);

    const replay = await router.handle({
      method: "POST",
      pathname: `/product/v3/order-drafts/${draftId}/finalize`,
      headers: { ...headers(slotA.address), "idempotency-key": "birth-key-1" },
      body: { signature },
    });
    expect(replay.status).toBe(200);
    expect((replay.body as { orderId: string }).orderId).toBe(expectedOrderId);
    expect(birthInputs).toHaveLength(1);

    const conflict = await router.handle({
      method: "POST",
      pathname: `/product/v3/order-drafts/${draftId}/finalize`,
      headers: { ...headers(slotA.address), "idempotency-key": "birth-key-2" },
      body: { signature },
    });
    expect(conflict.status).toBe(409);
    expect((conflict.body as { error: string }).error).toBe("order_already_triggered");
    expect(birthInputs).toHaveLength(1);

    const order = await router.handle({
      method: "GET",
      pathname: `/product/v3/orders/${expectedOrderId}`,
      headers: headers(slotA.address),
    });
    expect(order.status).toBe(200);
    expect((order.body as { status: string }).status).toBe("unknown");
  });

  it("only slot-a may prepare/finalize and the signature must recover to slot-a", async () => {
    const { router } = await fixture();
    await publishConfig(router, configBundle());
    const draftId = await makeReadyDraft(router);

    const performerPrepare = await router.handle({
      method: "POST",
      pathname: `/product/v3/order-drafts/${draftId}/finalize/prepare`,
      headers: headers(performer.address),
      body: {},
    });
    expect(performerPrepare.status).toBe(403);

    const prepared = await prepareFinalize(router, draftId);
    const typed = (prepared.body as { typedData: Parameters<typeof performer.signTypedData>[0] }).typedData;
    const performerSignature = await performer.signTypedData(typed);
    const forged = await router.handle({
      method: "POST",
      pathname: `/product/v3/order-drafts/${draftId}/finalize`,
      headers: headers(slotA.address),
      body: { signature: performerSignature },
    });
    expect(forged.status).toBe(403);
    expect((forged.body as { error: string }).error).toBe("finalize_authorization_mismatch");

    const performerSubmit = await router.handle({
      method: "POST",
      pathname: `/product/v3/order-drafts/${draftId}/finalize`,
      headers: headers(performer.address),
      body: { signature: performerSignature },
    });
    expect(performerSubmit.status).toBe(403);
  });

  it("skips zero-amount stages: no invites, no funding, still present in the order", async () => {
    const { router, birthInputs } = await fixture();
    await publishConfig(router, configBundle());
    const draftId = await makeReadyDraft(
      router,
      draftBody({
        stageSubset: ["alpha", "beta"],
        stageTerms: [term("alpha"), term("beta", { amount: "0" })],
      }),
    );

    const betaInvite = await router.handle({
      method: "POST",
      pathname: `/product/v3/order-drafts/${draftId}/invites`,
      headers: headers(slotA.address),
      body: { stageKey: "beta", slotKey: "performer", subjectLabel: "Skipped" },
    });
    expect(betaInvite.status).toBe(409);
    expect((betaInvite.body as { error: string }).error).toBe("stage_skipped");

    const detail = await router.handle({
      method: "GET",
      pathname: `/product/v3/order-drafts/${draftId}`,
      headers: headers(slotA.address),
    });
    const finalize = await finalizeWithSignature(router, draftId);
    expect(finalize.status, JSON.stringify(finalize.body)).toBe(200);
    const result = finalize.body as {
      orderId: string;
      fundedStageKeys: string[];
      skippedStageKeys: string[];
    };
    expect(result.fundedStageKeys).toEqual(["alpha"]);
    expect(result.skippedStageKeys).toEqual(["beta"]);
    expect(birthInputs[0]!.fundedStageKeys).toEqual(["alpha"]);
    expect(birthInputs[0]!.skippedStageKeys).toEqual(["beta"]);
    expect(birthInputs[0]!.stageBindings.every((binding) => binding.stageKey === "alpha")).toBe(true);

    const order = await router.handle({
      method: "GET",
      pathname: `/product/v3/orders/${result.orderId}`,
      headers: headers(slotA.address),
    });
    expect(order.status).toBe(200);
    expect((order.body as { stages: { stageKey: string }[] }).stages.map((stage) => stage.stageKey)).toEqual([
      "alpha",
      "beta",
    ]);
  });

  it("fails closed when the config version has no birth route", async () => {
    const { router } = await fixture();
    await publishConfig(router, configBundle(), { omitBirth: true });
    const draftId = await makeReadyDraft(router);
    const prepared = await prepareFinalize(router, draftId);
    expect(prepared.status).toBe(409);
    expect((prepared.body as { error: string }).error).toBe("birth_route_missing");
  });

  it("needs no capability/permission/trigger/evidence-spec fields to birth an order", async () => {
    expect(JSON.stringify(configBundle())).not.toMatch(
      /capabilityPlugin|orderPermissionTable|createOrderTrigger|evidenceSpec/,
    );
    const { router } = await fixture();
    await publishConfig(router, configBundle());
    const draftId = await makeReadyDraft(router);
    const finalize = await finalizeWithSignature(router, draftId);
    expect(finalize.status, JSON.stringify(finalize.body)).toBe(200);
  });
});

describe("invites and EIP-712 accept", () => {
  it("rejects wrong signer, terms mismatch, replay and expired token", async () => {
    const { router } = await fixture();
    await publishConfig(router, configBundle());
    const detail = (await createDraft(router, slotA.address as Address, draftBody())).body as {
      draft: { draftId: string };
    };
    const draftId = detail.draft.draftId;
    const { created, preview } = await inviteAndPreview(router, draftId, performer.address as Address);
    const previewBody = preview.body as { typedData: never; terms: { termsHash: string } };

    const wrongWalletPreview = await router.handle({
      method: "POST",
      pathname: `/product/v3/invites/${created.inviteId}/preview`,
      headers: headers(stranger.address),
      body: { token: created.inviteToken },
    });
    expect(wrongWalletPreview.status).toBe(403);
    expect((wrongWalletPreview.body as { error: string }).error).toBe("wrong_wallet");

    const wrongSignature = await stranger.signTypedData(previewBody.typedData);
    const wrong = await router.handle({
      method: "POST",
      pathname: `/product/v3/invites/${created.inviteId}/accept`,
      headers: headers(performer.address),
      body: {
        token: created.inviteToken,
        signature: wrongSignature,
        termsHash: previewBody.terms.termsHash,
        nonce: (previewBody.typedData as unknown as { message: { nonce: string } }).message.nonce,
      },
    });
    expect(wrong.status).toBe(403);
    expect((wrong.body as { error: string }).error).toBe("invalid_invite_signature");

    const signed = await performer.signTypedData(previewBody.typedData);
    const mismatch = await router.handle({
      method: "POST",
      pathname: `/product/v3/invites/${created.inviteId}/accept`,
      headers: headers(performer.address),
      body: {
        token: created.inviteToken,
        signature: signed,
        termsHash: `0x${"ff".repeat(32)}`,
        nonce: (previewBody.typedData as unknown as { message: { nonce: string } }).message.nonce,
      },
    });
    expect(mismatch.status).toBe(422);
    expect((mismatch.body as { error: string }).error).toBe("stage_terms_mismatch");

    const once = await acceptInvite(router, created.inviteId, created.inviteToken, performer, preview.body as never);
    expect(once.status, JSON.stringify(once.body)).toBe(200);
    const replay = await acceptInvite(router, created.inviteId, created.inviteToken, performer, preview.body as never);
    expect([409, 410]).toContain(replay.status);
    expect((replay.body as { error: string }).error).toBe("invite_already_accepted");

    clock = new Date("2026-11-02T00:00:00.000Z");
    const secondDraft = (await createDraft(router, slotA.address as Address, draftBody())).body as {
      draft: { draftId: string };
    };
    const expiredInvite = await router.handle({
      method: "POST",
      pathname: `/product/v3/order-drafts/${secondDraft.draft.draftId}/invites`,
      headers: headers(slotA.address),
      body: {
        stageKey: "alpha",
        slotKey: "performer",
        subjectLabel: "Late",
        expiresAt: "2026-11-03T00:00:00.000Z",
      },
    });
    expect(expiredInvite.status).toBe(201);
    const expiredId = (expiredInvite.body as { inviteId: string; inviteToken: string }).inviteId;
    const expiredToken = (expiredInvite.body as { inviteToken: string }).inviteToken;
    clock = new Date("2026-11-04T00:00:00.000Z");
    const expired = await router.handle({
      method: "POST",
      pathname: `/product/v3/invites/${expiredId}/preview`,
      headers: headers(performer.address),
      body: { token: expiredToken },
    });
    expect(expired.status).toBe(410);
    expect((expired.body as { error: string }).error).toBe("invite_expired");
  });

  it("rejects invite creation for an active slot and hidden drafts", async () => {
    const { router } = await fixture();
    await publishConfig(router, configBundle());
    const detail = (await createDraft(router, slotA.address as Address, draftBody())).body as {
      draft: { draftId: string };
    };
    const draftId = detail.draft.draftId;
    const first = await router.handle({
      method: "POST",
      pathname: `/product/v3/order-drafts/${draftId}/invites`,
      headers: headers(slotA.address),
      body: { stageKey: "alpha", slotKey: "performer", subjectLabel: "A", expiresAt: "2026-11-01T00:00:00.000Z" },
    });
    expect(first.status).toBe(201);
    const duplicate = await router.handle({
      method: "POST",
      pathname: `/product/v3/order-drafts/${draftId}/invites`,
      headers: headers(slotA.address),
      body: { stageKey: "alpha", slotKey: "performer", subjectLabel: "B", expiresAt: "2026-11-01T00:00:00.000Z" },
    });
    expect(duplicate.status).toBe(409);
    expect((duplicate.body as { error: string }).error).toBe("invite_already_active");

    const hidden = await router.handle({
      method: "GET",
      pathname: `/product/v3/order-drafts/${draftId}`,
      headers: headers(performer.address),
    });
    expect(hidden.status).toBe(403);

    const missing = await router.handle({
      method: "GET",
      pathname: "/product/v3/orders/0x0000000000000000000000000000000000000000000000000000000000000000",
      headers: headers(stranger.address),
    });
    expect(missing.status).toBe(404);

    const anonymous = await router.handle({
      method: "GET",
      pathname: `/product/v3/order-drafts/${draftId}`,
      headers: {},
    });
    expect(anonymous.status).toBe(401);
  });

  it("scopes stage reads to participants and returns 403 for another stage", async () => {
    const { router } = await fixture();
    await publishConfig(router, configBundle(), { planId: publishedPlanId, planHash: publishedPlanHash });
    const detail = (await createDraft(router, slotA.address as Address, draftBody({
      stageSubset: ["alpha", "beta"],
      stageTerms: [term("alpha"), term("beta")],
    }))).body as { draft: { draftId: string } };
    const draftId = detail.draft.draftId;
    const { created, preview } = await inviteAndPreview(router, draftId, performer.address as Address);
    expect(preview.status).toBe(200);
    const accepted = await acceptInvite(router, created.inviteId, created.inviteToken, performer, preview.body as never);
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);

    const betaPerformer = privateKeyToAccount(`0x${"06".repeat(32)}`);
    const verifier = privateKeyToAccount(`0x${"05".repeat(32)}`);
    for (const [slotKey, account] of [
      ["performer", betaPerformer],
      ["verifier", verifier],
    ] as const) {
      const betaInvite = await router.handle({
        method: "POST",
        pathname: `/product/v3/order-drafts/${draftId}/invites`,
        headers: headers(slotA.address),
        body: {
          stageKey: "beta",
          slotKey,
          subjectLabel: slotKey,
          wallet: account.address.toLowerCase(),
          expiresAt: "2026-11-01T00:00:00.000Z",
        },
      });
      expect(betaInvite.status, JSON.stringify(betaInvite.body)).toBe(201);
      const betaCreated = betaInvite.body as { inviteId: string; inviteToken: string };
      const betaPreview = await router.handle({
        method: "POST",
        pathname: `/product/v3/invites/${betaCreated.inviteId}/preview`,
        headers: headers(account.address),
        body: { token: betaCreated.inviteToken },
      });
      expect(betaPreview.status, JSON.stringify(betaPreview.body)).toBe(200);
      const betaAccepted = await acceptInvite(
        router,
        betaCreated.inviteId,
        betaCreated.inviteToken,
        account,
        betaPreview.body as never,
      );
      expect(betaAccepted.status, JSON.stringify(betaAccepted.body)).toBe(200);
    }

    const finalize = await finalizeWithSignature(router, draftId);
    expect(finalize.status, JSON.stringify(finalize.body)).toBe(200);
    const bornOrderId = (finalize.body as { orderId: string }).orderId;

    const ownStage = await router.handle({
      method: "GET",
      pathname: `/product/v3/orders/${bornOrderId}/stages/alpha`,
      headers: headers(performer.address),
    });
    expect(ownStage.status).toBe(200);
    const otherStage = await router.handle({
      method: "GET",
      pathname: `/product/v3/orders/${bornOrderId}/stages/beta`,
      headers: headers(performer.address),
    });
    expect(otherStage.status).toBe(403);
    expect(["stage_scope_forbidden", "wallet_scope_forbidden"]).toContain(
      (otherStage.body as { error: string }).error,
    );

    const slotAOrder = await router.handle({
      method: "GET",
      pathname: `/product/v3/orders/${bornOrderId}`,
      headers: headers(slotA.address),
    });
    expect(slotAOrder.status).toBe(200);
    const stageIds = (slotAOrder.body as { stages: { stageId: string }[] }).stages.map((stage) => stage.stageId);
    expect(stageIds).toEqual([keccak256(stringToHex("alpha")), keccak256(stringToHex("beta"))]);
  });
});

describe("order Postgres persistence", () => {
  it("round-trips config/draft/invite against migrations/postgres/0001_schema.sql", async () => {
    const database = new PostgresDatabase({ databaseUrl: await createPostgresTestDatabase() });
    try {
      expect(
        (await listAppliedPostgresMigrations(database)).map((migration) => migration.version),
      ).toContain("0001_schema");

      const store = new PostgresOrderStore({ database });
      const bundle = configBundle();
      await store.saveConfig({
        configId: "test/flow",
        version: "1.0.0",
        status: "published",
        configHash: `0x${"aa".repeat(32)}`,
        bundle: bundle as never,
        createdBy: operator.address.toLowerCase() as Address,
        createdAt: "2026-10-25T00:00:00.000Z",
        publishedAt: "2026-10-25T00:00:00.000Z",
        updatedAt: "2026-10-25T00:00:00.000Z",
      });
      expect((await store.getConfig("test/flow", "1.0.0"))?.configHash).toBe(`0x${"aa".repeat(32)}`);

      await store.createDraft({
        draftId: "draft-pg",
        configId: "test/flow",
        configVersion: "1.0.0",
        configHash: `0x${"aa".repeat(32)}`,
        buyerWallet: slotA.address.toLowerCase() as Address,
        chainId: 31337,
        stateMachine,
        title: "Order",
        currency: "tok-1",
        stageSubset: ["alpha"],
        status: "inviting",
        createdAt: "2026-10-25T00:00:00.000Z",
        updatedAt: "2026-10-25T00:00:00.000Z",
      });
      const stage: OrderStageRecord = {
        draftId: "draft-pg",
        stageKey: "alpha",
        stageId: keccak256(stringToHex("alpha")),
        stageIndex: 0,
        amount: "1000000",
        slots: {},
        finalStandardHash: `0x${"ab".repeat(32)}` as never,
        inviteDeadline: "2026-11-01T00:00:00.000Z",
        workDeadline: "2026-11-20T00:00:00.000Z",
        termsHash: `0x${"cd".repeat(32)}` as never,
        status: "draft",
        createdAt: "2026-10-25T00:00:00.000Z",
        updatedAt: "2026-10-25T00:00:00.000Z",
      };
      await store.createStages([stage]);
      expect((await store.listStages("draft-pg"))[0]!.stageId).toBe(keccak256(stringToHex("alpha")));

      await store.createInvite({
        inviteId: "invite-pg",
        draftId: "draft-pg",
        stageKey: "alpha",
        stageId: keccak256(stringToHex("alpha")),
        slotKey: "performer",
        subjectLabel: "Performer",
        tokenHash: "f".repeat(64),
        nonce: "1",
        status: "active",
        expiresAt: "2026-11-01T00:00:00.000Z",
        createdBy: slotA.address.toLowerCase() as Address,
        createdAt: "2026-10-25T00:00:00.000Z",
        updatedAt: "2026-10-25T00:00:00.000Z",
      });
      await expect(
        store.createInvite({
          inviteId: "invite-pg-2",
          draftId: "draft-pg",
          stageKey: "alpha",
          stageId: keccak256(stringToHex("alpha")),
          slotKey: "performer",
          subjectLabel: "Other",
          tokenHash: "e".repeat(64),
          nonce: "2",
          status: "active",
          expiresAt: "2026-11-01T00:00:00.000Z",
          createdBy: slotA.address.toLowerCase() as Address,
          createdAt: "2026-10-25T00:00:00.000Z",
          updatedAt: "2026-10-25T00:00:00.000Z",
        }),
      ).rejects.toThrow(StorageConstraintError);
      expect(
        await store.transitionInvite("invite-pg", "active", "accepted", {
          acceptedBy: performer.address.toLowerCase() as Address,
          acceptedAt: "2026-10-25T01:00:00.000Z",
          updatedAt: "2026-10-25T01:00:00.000Z",
        }),
      ).toBe(true);
      expect(
        await store.transitionInvite("invite-pg", "active", "accepted", {
          updatedAt: "2026-10-25T02:00:00.000Z",
        }),
      ).toBe(false);
    } finally {
      await database.close();
    }
  });

  it("updates an existing stage through saveStage for the invite-accept path", async () => {
    const store = new PostgresOrderStore({ databaseUrl: await createPostgresTestDatabase() });
    try {
      await store.createDraft({
        draftId: "draft-stage-update",
        configId: "test/flow",
        configVersion: "1.0.0",
        configHash: `0x${"aa".repeat(32)}`,
        buyerWallet: slotA.address.toLowerCase() as Address,
        chainId: 31337,
        stateMachine,
        title: "Order",
        currency: "tok-1",
        stageSubset: ["alpha"],
        status: "inviting",
        createdAt: "2026-10-25T00:00:00.000Z",
        updatedAt: "2026-10-25T00:00:00.000Z",
      });
      const stage: OrderStageRecord = {
        draftId: "draft-stage-update",
        stageKey: "alpha",
        stageId: keccak256(stringToHex("alpha")),
        stageIndex: 0,
        amount: "1000000",
        slots: {},
        finalStandardHash: `0x${"ab".repeat(32)}`,
        inviteDeadline: "2026-11-01T00:00:00.000Z",
        workDeadline: "2026-11-20T00:00:00.000Z",
        termsHash: `0x${"cd".repeat(32)}`,
        status: "draft",
        createdAt: "2026-10-25T00:00:00.000Z",
        updatedAt: "2026-10-25T00:00:00.000Z",
      };
      await store.createStages([stage]);

      const accepted: OrderStageRecord = {
        ...stage,
        slots: { performer: performer.address.toLowerCase() as Address },
        termsHash: `0x${"12".repeat(32)}`,
        status: "ready",
        updatedAt: "2026-10-25T01:00:00.000Z",
      };
      await expect(store.saveStage(accepted)).resolves.toBeUndefined();
      await expect(store.getStage("draft-stage-update", "alpha")).resolves.toMatchObject({
        slots: { performer: performer.address.toLowerCase() },
        termsHash: `0x${"12".repeat(32)}`,
        status: "ready",
        updatedAt: "2026-10-25T01:00:00.000Z",
      });
    } finally {
      await store.close();
    }
  });
});
