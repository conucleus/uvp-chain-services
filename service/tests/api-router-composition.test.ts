import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createApiRouter } from "../src/api/routes.js";
import { ObjectEvidenceStorage } from "../src/evidence/index.js";
import { MemoryProjectionStore } from "../src/storage/projection-store.js";

describe("API router composition", () => {
  it("returns not_found for unknown routes", async () => {
    const router = createApiRouter(new MemoryProjectionStore(), { productRuntimeEnvironment: "local", submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111" });

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

  it("rejects malformed percent-encoded path parameters with 400 instead of 500", async () => {
    const router = createApiRouter(new MemoryProjectionStore(), { submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111", productRuntimeEnvironment: "local" });

    // "%ZZ" 不是合法的百分号编码：decodeURIComponent 抛 URIError，
    // 必须落 400 而不是兜底 500。
    const productOrder = await router.handle({
      method: "GET",
      pathname: "/product/orders/%ZZ",
      headers: { "x-uvp-wallet-address": "0x9999999999999999999999999999999999999999" }
    });
    expect(productOrder).toMatchObject({ status: 400, body: { error: "invalid_path_parameter" } });

    const storeOrder = await router.handle({
      method: "GET",
      pathname: "/store/zhixus/%E0%A4%A/orders",
      headers: { "x-uvp-wallet-address": "0x9999999999999999999999999999999999999999" }
    });
    expect(storeOrder).toMatchObject({ status: 400, body: { error: "invalid_path_parameter" } });
  });

  it("store runtime reads and submission/trigger reads require session identity", async () => {
    const router = createApiRouter(new MemoryProjectionStore(), { submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111", productRuntimeEnvironment: "local" });

    for (const pathname of [
      "/store/runtime/summary",
      "/store/zhixus/zhixu-1/orders",
      "/store/orders/0xabc/candidates",
      "/product/submissions/sub_1",
      "/product/order-triggers/trg_1"
    ]) {
      const anonymous = await router.handle({ method: "GET", pathname });
      expect(anonymous).toMatchObject({ status: 401, body: { error: "wallet_identity_required" } });
    }
  });

  it("active-executor overlay authorization only covers the task's recorded submit signal", async () => {
    const { productBffStoreSubmissionAuthorization } = await import("../src/api/routes.js");
    const { MemoryProductBffStore } = await import("../src/product/bff/store.js");
    const authorization = productBffStoreSubmissionAuthorization(new MemoryProductBffStore());
    const executor = "0x8888888888888888888888888888888888888888";
    const targetStageId = "0x" + "1".repeat(64);
    const recordedSignalId = "0x" + "2".repeat(64);
    const derivedSignalId = "0x" + "3".repeat(64);
    const onchainOrderId = "0x" + "4".repeat(64) as `0x${string}`;
    const baseRequest = {
      orderId: "order-1",
      taskId: "task-1",
      stageIdentifier: "stage-1",
      signalName: "confirm_stage",
      onchainOrderId,
      sourceId: targetStageId as `0x${string}`,
      intent: "confirm_stage" as const,
      submitter: executor as `0x${string}`
    };

    // signalId 与任务记录的提交信号不一致（推导值）：overlay 不得授权——
    // 链上必 revert 的信号不应被完成授权并签名广播。
    const derived = await authorization.authorize({
      ...baseRequest,
      signalId: derivedSignalId as `0x${string}`,
      task: {
        taskId: "task-1",
        stageExecutorOverlay: { targetStageId, activeExecutorWallet: executor }
        // proof.signalId 缺失：chainSignal 推导 signalId。
      } as never
    });
    expect(derived).toMatchObject({
      authorized: false,
      source: "active_stage_executor_overlay"
    });

    // proof 记录的信号与请求一致：按在任执行者授权。
    const recorded = await authorization.authorize({
      ...baseRequest,
      signalId: recordedSignalId as `0x${string}`,
      task: {
        taskId: "task-1",
        stageExecutorOverlay: { targetStageId, activeExecutorWallet: executor },
        proof: { signalId: recordedSignalId }
      } as never
    });
    expect(recorded).toMatchObject({ authorized: true, source: "active_stage_executor_overlay" });
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
