import { describe, expect, it } from "vitest";
import { createApiRouter } from "../src/api/routes.js";
import type { ChainEvent } from "../src/indexer/events.js";
import { rebuildIdentityProjections } from "../src/indexer/identity-projections.js";
import { MemoryProjectionStore } from "../src/storage/projection-store.js";

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
  });

  it("exposes bindings through the projection store and public API", async () => {
    const store = new MemoryProjectionStore();
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
    const response = await createApiRouter(store, { productRuntimeEnvironment: "local", submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111" }).handle({
      method: "GET",
      pathname: "/identity/bindings",
      query: { registryAddress, account },
    });
    expect(response).toMatchObject({ status: 200 });
    expect((response.body as { bindings: unknown[] }).bindings).toHaveLength(1);
  });

  it("parses activeOnly=false as boolean false so revoked records stay visible", async () => {
    // activeOnly 的字符串 "false" 若原样透传给投影（truthy），撤销记录
    // 会被错误过滤——路由层必须收敛为 boolean。
    const store = new MemoryProjectionStore();
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
    const router = createApiRouter(store, { productRuntimeEnvironment: "local", submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111" });

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
