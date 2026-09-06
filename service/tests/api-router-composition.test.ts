import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createApiRouter } from "../src/api/routes.js";
import { ObjectEvidenceStorage } from "../src/evidence/index.js";
import { MemoryProjectionStore } from "../src/storage/projection-store.js";

describe("API router composition", () => {
  it("returns not_found for unknown routes", async () => {
    const router = createApiRouter(new MemoryProjectionStore(), { submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111" });

    await expect(router.handle({ method: "GET", pathname: "/unknown-route" }))
      .resolves.toEqual({
        status: 404,
        body: { error: "not_found" }
      });
  });

  it("serves production reads without demo fallback data", async () => {
    const router = createApiRouter(new MemoryProjectionStore(), { submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111",
      productRuntimeEnvironment: "production",
      evidenceStorage: productionSafeEvidenceStorage()
    });

    await expect(router.handle({
      method: "GET",
      pathname: "/product/zhixus",
      query: { fallback: "demo" }
    })).resolves.toMatchObject({
      status: 200,
      body: { zhixus: [] }
    });
  });

  it("route modules do not cross-import; composition stays in the public factory", () => {
    const apiDir = new URL("../src/api/", import.meta.url);
    const modulesDir = new URL("routes/", apiDir);
    for (const filename of readdirSync(modulesDir).filter((name) => name.endsWith(".ts"))) {
      const source = readFileSync(new URL(filename, modulesDir), "utf8");
      expect(source, filename).not.toMatch(/from\s+["']\.\/[^"']+\.js["']/);
      expect(source, filename).not.toMatch(/from\s+["']\.\.\/routes\//);
    }
  });
});

function productionSafeEvidenceStorage(): ObjectEvidenceStorage {
  return new ObjectEvidenceStorage({
    client: {
      async put(input) {
        return {
          storageURI: `object://evidence/${encodeURIComponent(input.evidenceId)}`,
          size: input.bytes.byteLength
        };
      },
      async get() {
        return undefined;
      },
      async exists() {
        return false;
      }
    }
  });
}
