import { afterEach, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { Server } from "node:http";
import { loadConfigFromEnv } from "../src/config/index.js";
import { startApiServer } from "../src/api/server.js";
import { MemoryProjectionStore } from "../src/storage/projection-store.js";
import type { ChainEventSource } from "../src/indexer/service.js";
import type { Address } from "../src/shared/types.js";

/**
 * HTTP 包装层（server.ts）的响应契约验收：路由返回的业务载荷必须
 * 原样上线。曾发生包装层对全部 2xx 响应做键名脱敏，/store/auth/verify
 * 签发的会话 token 命中 secret 键名模式被替换成 [redacted:secret]，
 * 钱包会话登录整体失效——此测试必须走真实 HTTP 服务器而非 router。
 */

const walletKey = "0x1111111111111111111111111111111111111111111111111111111111111111";
const account = privateKeyToAccount(walletKey);
const wallet = account.address as Address;

const noOpEventSource: ChainEventSource = {
  async getFinalizedBlock() {
    return 0n;
  },
  async readEvents() {
    return [];
  }
};

describe("api server response contract", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server!.close((error) => (error ? reject(error) : resolve()));
      });
      server = undefined;
    }
  });

  it("delivers the wallet session token verbatim through the HTTP wrapper", async () => {
    server = await startApiServer({
      config: localMemoryConfig(),
      store: new MemoryProjectionStore(),
      eventSource: noOpEventSource
    });
    const base = `http://127.0.0.1:${serverPort(server)}`;
    const jsonHeaders = { "content-type": "application/json" };

    const challengeResponse = await fetch(`${base}/store/auth/challenge`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ address: wallet })
    });
    expect(challengeResponse.status).toBe(201);
    const challenge = (await challengeResponse.json()) as { challenge: { nonce: string; message: string } };

    const verifyResponse = await fetch(`${base}/store/auth/verify`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({
        nonce: challenge.challenge.nonce,
        signature: await account.signMessage({ message: challenge.challenge.message })
      })
    });
    expect(verifyResponse.status).toBe(201);
    const verified = (await verifyResponse.json()) as { token: string };
    // 脱敏发生在日志侧；线上 token 必须是原样会话凭据，客户端才能登录。
    expect(verified.token).toMatch(/^uvs_[0-9a-f]{64}$/);
    expect(verified.token).not.toContain("redacted");

    const sessionResponse = await fetch(`${base}/store/auth/session`, {
      headers: { "x-uvp-store-session": verified.token }
    });
    expect(sessionResponse.status).toBe(200);
    const session = (await sessionResponse.json()) as { session: { anchoredAddress?: string } };
    expect(session.session.anchoredAddress?.toLowerCase()).toBe(wallet.toLowerCase());
  });
});

function serverPort(server: Server): number {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected TCP server address");
  }
  return address.port;
}

function localMemoryConfig() {
  return loadConfigFromEnv({
    CHAIN_SERVICES_RUNTIME_ENV: "local",
    CHAIN_SERVICES_DATABASE_DRIVER: "memory",
    CHAIN_SERVICES_DATABASE_URL: "memory://projection-store",
    UVP_PRODUCT_BFF_REGISTRATION_ADAPTER: "memory-trigger",
    UVP_CONTRACTS_JSON: JSON.stringify({
      UVPStateMachine: "0x1111111111111111111111111111111111111111"
    }),
    UVP_API_HOST: "127.0.0.1",
    UVP_API_PORT: "0"
  });
}
