import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiRouter } from "../src/api/routes.js";
import type { ChainEvent } from "../src/indexer/events.js";
import { rebuildIdentityProjections } from "../src/indexer/identity-projections.js";
import { createChainServicesStores, type ChainServicesStores } from "../src/storage/factory.js";
import type { ProjectionStore } from "../src/storage/projection-store.js";
import { StorageUnavailableError } from "../src/storage/errors.js";
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

const registryAddress = "0x1111111111111111111111111111111111111111";
const registrar = "0x2222222222222222222222222222222222222222";
const account = "0x4444444444444444444444444444444444444444";
const subjectId = "0x0000000000000000000000000000000000000000000000000000000000003001";
const bindingId = "0xabababababababababababababababababababababababababababababababab";
const descriptorHash = "0x9999999999999999999999999999999999999999999999999999999999999999";
const reasonHash = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

describe("identity registry projection", () => {
  it("projects registration and revocation", () => {
    const snapshot = rebuildIdentityProjections([
      event(2n, 0, "IdentityBindingRegistered", {
        bindingId,
        subjectId,
        account,
        descriptorHash,
        descriptorURI: "https://store/identities/1",
        registrar,
      }),
      event(3n, 0, "IdentityBindingRevoked", {
        bindingId,
        reasonHash,
        reasonURI: "https://store/identity-revocations/1",
        revoker: registrar,
      }),
    ]);

    expect(Object.values(snapshot.bindings)).toEqual([
      expect.objectContaining({
        bindingId,
        subjectId,
        account: account.toLowerCase(),
        status: "revoked",
        revokeReasonHash: reasonHash,
      }),
    ]);
    expect(snapshot.unresolvedRevokeEventCount).toBe(0);
  });

  it("counts revocations that point at an unknown binding instead of silently dropping them", () => {
    const snapshot = rebuildIdentityProjections([
      event(2n, 0, "IdentityBindingRegistered", {
        bindingId,
        subjectId,
        account,
        descriptorHash,
        descriptorURI: "https://store/identities/1",
        registrar,
      }),
      event(3n, 0, "IdentityBindingRevoked", {
        bindingId: "0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
        reasonHash,
        reasonURI: "https://store/identity-revocations/2",
        revoker: registrar,
      }),
    ]);

    expect(snapshot.unresolvedRevokeEventCount).toBe(1);
    expect(Object.values(snapshot.bindings)).toEqual([
      expect.objectContaining({ bindingId, status: "active" }),
    ]);
    expect(snapshot.eventCount).toBe(2);
  });

  it("exposes bindings through the projection store and public API", async () => {
    const store = stores.projectionStore;
    await store.resetFromEvents({
      deploymentBlock: 0n,
      events: [event(2n, 0, "IdentityBindingRegistered", {
        bindingId,
        subjectId,
        account,
        descriptorHash,
        descriptorURI: "https://store/identities/1",
        registrar,
      })],
    });

    expect(await store.listIdentityBindings({ account })).toHaveLength(1);
    const response = await createApiRouter(store, { runtimeEnvironment: "local" }).handle({
      method: "GET",
      pathname: "/identity/bindings",
      query: { registryAddress, account },
    });
    expect(response).toMatchObject({ status: 200 });
    expect((response.body as { bindings: unknown[] }).bindings).toHaveLength(1);
  });

  it("returns a retryable 503 without PG internals when projection storage is unavailable", async () => {
    const failingStore = {
      hasProjectionSnapshot: async () => true,
      getSyncState: async () => undefined,
      listIdentityBindings: async () => {
        throw new StorageUnavailableError(
          "connect ECONNREFUSED tcp://db.internal:5432/uvp_projection"
        );
      }
    } as unknown as ProjectionStore;
    const response = await createApiRouter(failingStore, { runtimeEnvironment: "local" }).handle({
      method: "GET",
      pathname: "/identity/bindings",
      query: { account }
    });

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      error: "identity_read_unavailable",
      retryable: true
    });
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain("db.internal");
    expect(serialized).not.toContain("ECONNREFUSED");
  });

  it("does not serve an unbuilt identity projection as an empty binding list", async () => {
    const unbuiltStore = {
      hasProjectionSnapshot: async () => false,
      getSyncState: async () => undefined,
      listIdentityBindings: async () => []
    } as unknown as ProjectionStore;
    const response = await createApiRouter(unbuiltStore, { runtimeEnvironment: "local" }).handle({
      method: "GET",
      pathname: "/identity/bindings",
      query: { account }
    });

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      error: "chain_projection_unavailable",
      retryable: true,
      syncStatus: "not_started"
    });
  });

  it("parses activeOnly=false as boolean false so revoked records stay visible", async () => {
    const store = stores.projectionStore;
    await store.resetFromEvents({
      deploymentBlock: 0n,
      events: [
        event(2n, 0, "IdentityBindingRegistered", {
          bindingId,
          subjectId,
          account,
          descriptorHash,
          descriptorURI: "https://store/identities/1",
          registrar,
        }),
        event(3n, 1, "IdentityBindingRevoked", {
          bindingId,
          reasonHash,
          reasonURI: "https://store/identity-revocations/1",
          revoker: registrar,
        }),
      ],
    });
    const router = createApiRouter(store, { runtimeEnvironment: "local" });

    const all = await router.handle({
      method: "GET",
      pathname: "/identity/bindings",
      query: { account, activeOnly: "false" },
    });
    expect(all).toMatchObject({ status: 200 });
    const allBindings = (all.body as { bindings: { status: string }[] }).bindings;
    expect(allBindings).toHaveLength(1);
    expect(allBindings[0]?.status).toBe("revoked");

    const active = await router.handle({
      method: "GET",
      pathname: "/identity/bindings",
      query: { account, activeOnly: "true" },
    });
    expect(active).toMatchObject({ status: 200 });
    expect((active.body as { bindings: unknown[] }).bindings).toHaveLength(0);
  });
});

function event(
  blockNumber: bigint,
  logIndex: number,
  eventName: string,
  args: Record<string, unknown>,
): ChainEvent {
  return {
    chainId: 31337,
    contractAddress: registryAddress,
    blockNumber,
    transactionHash: `0x${blockNumber.toString(16).padStart(64, "0")}`,
    logIndex,
    eventName,
    args,
  };
}
