import { afterEach, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { connect } from "node:net";
import type { Server } from "node:http";
import { loadConfigFromEnv } from "../src/config/index.js";
import { startApiServer } from "../src/api/server.js";
import { createPostgresTestDatabase } from "./postgres.js";
import type { ChainEventSource } from "../src/indexer/service.js";
import type { Address } from "../src/shared/types.js";

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
      config: await localConfig(),
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
    expect(verified.token).toMatch(/^uvs_[0-9a-f]{64}$/);
    expect(verified.token).not.toContain("redacted");

    const sessionResponse = await fetch(`${base}/store/auth/session`, {
      headers: { "x-uvp-store-session": verified.token }
    });
    expect(sessionResponse.status).toBe(200);
    const session = (await sessionResponse.json()) as { session: { anchoredAddress?: string } };
    expect(session.session.anchoredAddress?.toLowerCase()).toBe(wallet.toLowerCase());
  });

  it("echoes a sanitized client request id and rebuilds unsafe ones instead of trusting raw header bytes", async () => {
    server = await startApiServer({
      config: await localConfig(),
      eventSource: noOpEventSource
    });
    const base = `http://127.0.0.1:${serverPort(server)}`;

    const validId = "req-abc_DEF.012:3";
    const validResponse = await fetch(`${base}/healthz`, {
      headers: { "x-request-id": validId }
    });
    expect(validResponse.status).toBe(200);
    expect(validResponse.headers.get("x-request-id")).toBe(validId);

    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    for (const unsafeId of [
      `ok${String.fromCharCode(10)}2026-01-01T00:00:00Z injected-log-line`,
      `ok${String.fromCharCode(13)}crlf`,
      `tab${String.fromCharCode(9)}id`,
      `bad id with spaces`,
      `id;drop--'quote"double`,
      `x`.repeat(129)
    ]) {
      const raw = await rawHttpRequest(base, "/healthz", unsafeId);
      if (raw.status === 400) {
        continue;
      }
      expect(raw.status, `unsafe id must not fail the request`).toBe(200);
      expect(raw.requestId, `unsafe id must be rebuilt, got: ${JSON.stringify(raw.requestId)}`).toMatch(uuidPattern);
      expect(raw.requestId).not.toContain(String.fromCharCode(10));
      expect(raw.requestId).not.toContain(String.fromCharCode(13));
    }

    const absentResponse = await fetch(`${base}/healthz`);
    expect(absentResponse.headers.get("x-request-id")).toMatch(uuidPattern);
  });
});

function rawHttpRequest(
  base: string,
  path: string,
  requestId: string
): Promise<{ readonly status: number; readonly requestId: string | undefined }> {
  const url = new URL(path, base);
  return new Promise((resolve, reject) => {
    const socket = connect(Number(url.port), url.hostname);
    socket.on("error", reject);
    socket.on("connect", () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: ${url.host}\r\nx-request-id: ${requestId}\r\nConnection: close\r\n\r\n`
      );
    });
    let raw = "";
    socket.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
    });
    socket.on("close", () => {
      const statusLine = raw.split("\r\n", 1)[0] ?? "";
      const status = Number(statusLine.split(" ")[1] ?? 0);
      const headerLine = raw
        .split("\r\n")
        .find((line) => line.toLowerCase().startsWith("x-request-id:"));
      resolve({
        status,
        requestId: headerLine ? headerLine.slice("x-request-id:".length).trim() : undefined
      });
    });
  });
}

function serverPort(server: Server): number {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected TCP server address");
  }
  return address.port;
}

async function localConfig() {
  return loadConfigFromEnv({
    CHAIN_SERVICES_RUNTIME_ENV: "local",
    CHAIN_SERVICES_DATABASE_URL: await createPostgresTestDatabase(),
    UVP_PRODUCT_BFF_REGISTRATION_ADAPTER: "memory-trigger",
    UVP_CONTRACTS_JSON: JSON.stringify({
      UVPStateMachine: "0x1111111111111111111111111111111111111111"
    }),
    UVP_API_HOST: "127.0.0.1",
    UVP_API_PORT: "0"
  });
}
