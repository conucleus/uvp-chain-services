import { afterEach, describe, expect, it } from "vitest";
import { connect } from "node:net";
import type { Server } from "node:http";
import { loadConfigFromEnv } from "../src/config/index.js";
import { startApiServer } from "../src/api/server.js";
import { createPostgresTestDatabase } from "./postgres.js";
import type { ChainEventSource } from "../src/indexer/service.js";
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

  it("echoes sanitized request and run ids and rebuilds unsafe ones instead of trusting raw header bytes", async () => {
    server = await startApiServer({
      config: await localConfig(),
      eventSource: noOpEventSource
    });
    const base = `http://127.0.0.1:${serverPort(server)}`;
    await waitForReady(base);

    const validId = "req-abc_DEF.012:3";
    const validRunId = "run-abc_DEF.012:3";
    const validResponse = await fetch(`${base}/healthz`, {
      headers: { "x-request-id": validId, "x-uvp-run-id": validRunId }
    });
    expect(validResponse.status).toBe(200);
    expect(validResponse.headers.get("x-request-id")).toBe(validId);
    expect(validResponse.headers.get("x-uvp-run-id")).toBe(validRunId);

    const alternateRunId = await fetch(`${base}/healthz`, {
      headers: { "x-run-id": validRunId }
    });
    expect(alternateRunId.headers.get("x-uvp-run-id")).toBe(validRunId);

    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    for (const unsafeId of [
      `ok${String.fromCharCode(10)}2026-01-01T00:00:00Z injected-log-line`,
      `ok${String.fromCharCode(13)}crlf`,
      `tab${String.fromCharCode(9)}id`,
      `bad id with spaces`,
      `id;drop--'quote"double`,
      `x`.repeat(129)
    ]) {
      const raw = await rawHttpRequest(base, "/healthz", { "x-request-id": unsafeId });
      if (raw.status === 400) {
        continue;
      }
      expect(raw.status, `unsafe id must not fail the request`).toBe(200);
      const requestId = raw.headers["x-request-id"];
      expect(requestId ?? "", `unsafe id must be rebuilt, got: ${JSON.stringify(requestId)}`).toMatch(uuidPattern);
      expect(requestId ?? "").not.toContain(String.fromCharCode(10));
      expect(requestId ?? "").not.toContain(String.fromCharCode(13));
    }

    for (const unsafeRunId of [
      `run${String.fromCharCode(10)}injected-log-line`,
      `run${String.fromCharCode(13)}crlf`,
      `run${String.fromCharCode(9)}tab`,
      `run id with spaces`,
      `r`.repeat(129)
    ]) {
      const raw = await rawHttpRequest(base, "/healthz", { "x-run-id": unsafeRunId });
      if (raw.status === 400) {
        continue;
      }
      expect(raw.status, `unsafe run id must not fail the request`).toBe(200);
      expect(raw.headers["x-uvp-run-id"]).toBeUndefined();
      expect(JSON.stringify(raw.headers)).not.toContain(String.fromCharCode(10));
      expect(JSON.stringify(raw.headers)).not.toContain(String.fromCharCode(13));
    }

    const absentResponse = await fetch(`${base}/healthz`);
    expect(absentResponse.headers.get("x-request-id")).toMatch(uuidPattern);
  });
});

async function waitForReady(base: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await fetch(`${base}/readyz`);
    if (response.status === 200) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("api server did not become ready");
}

function rawHttpRequest(
  base: string,
  path: string,
  headers: Readonly<Record<string, string>>
): Promise<{ readonly status: number; readonly headers: Readonly<Record<string, string>> }> {
  const url = new URL(path, base);
  return new Promise((resolve, reject) => {
    const socket = connect(Number(url.port), url.hostname);
    socket.on("error", reject);
    socket.on("connect", () => {
      const headerLines = Object.entries(headers)
        .map(([name, value]) => `${name}: ${value}\r\n`)
        .join("");
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: ${url.host}\r\n${headerLines}Connection: close\r\n\r\n`
      );
    });
    let raw = "";
    socket.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
    });
    socket.on("close", () => {
      const lines = raw.split("\r\n");
      const statusLine = lines[0] ?? "";
      const status = Number(statusLine.split(" ")[1] ?? 0);
      const responseHeaders: Record<string, string> = {};
      for (const line of lines.slice(1)) {
        if (line.length === 0) {
          break;
        }
        const separator = line.indexOf(":");
        if (separator === -1) {
          continue;
        }
        responseHeaders[line.slice(0, separator).toLowerCase()] = line.slice(separator + 1).trim();
      }
      resolve({ status, headers: responseHeaders });
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
