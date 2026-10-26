import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { createViemReconcileReceiptClient } from "../src/reconcile/index.js";
import type { Hex } from "../src/shared/types.js";

describe("reconcile receipt client", () => {
  it("classifies RPC receipt errors through the viem client boundary", async () => {
    let rpcErrorMessage = "transaction not found";
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32000, message: rpcErrorMessage }
      }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      const client = createViemReconcileReceiptClient({
        rpcUrl: `http://127.0.0.1:${port}`,
        chainId: 31337
      });
      await expect(client.getTransactionReceipt(bytes32("bbbb"))).resolves.toBeUndefined();

      rpcErrorMessage = "upstream not found";
      await expect(client.getTransactionReceipt(bytes32("cccc"))).rejects.toThrow(/not found/i);
    } finally {
      server.close();
    }
  });
});

function bytes32(value: string): Hex {
  return `0x${value.padStart(64, "0")}` as Hex;
}
