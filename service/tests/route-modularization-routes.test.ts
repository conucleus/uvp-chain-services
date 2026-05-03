import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createApiRouter } from "../src/api/routes.js";
import { ObjectEvidenceStorage } from "../src/evidence/index.js";
import { MemoryProjectionStore } from "../src/storage/projection-store.js";

describe("API route modularization", () => {
  it("keeps the composed router fallback behavior stable", async () => {
    const router = createApiRouter(new MemoryProjectionStore());

    await expect(router.handle({ method: "GET", pathname: "/unknown-route" }))
      .resolves.toEqual({
        status: 404,
        body: { error: "not_found" }
      });
  });

  it("keeps production demo and E2E controls fail-closed", async () => {
    const router = createApiRouter(new MemoryProjectionStore(), {
      productRuntimeEnvironment: "production",
      productDemoMode: true,
      productE2eControlsEnabled: true,
      evidenceStorage: productionSafeEvidenceStorage()
    });

    await expect(router.handle({
      method: "POST",
      pathname: "/product/e2e/fixtures/revoked-zhixu"
    })).resolves.toEqual({
      status: 404,
      body: { error: "not_found" }
    });

    await expect(router.handle({
      method: "GET",
      pathname: "/product/zhixus",
      query: { fallback: "demo" }
    })).resolves.toEqual({
      status: 403,
      body: { error: "demo_mode_disabled" }
    });
  });

  it("keeps route composition in the public factory and not in route modules", () => {
    const apiDir = new URL("../src/api/", import.meta.url);
    const routesSource = readFileSync(new URL("routes.ts", apiDir), "utf8");
    expect(routesSource.split("\n").length).toBeLessThan(400);

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
