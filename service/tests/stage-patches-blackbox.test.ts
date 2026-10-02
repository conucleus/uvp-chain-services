// stage-patches 产品流黑盒对抗测试。
//
// 视角：BFF 外部攻击者/鲁莽调用方。只按行为规格构造请求，不断言内部
// 实现，重点挖掘：
// - 模式词表边界（大小写/词表外/空串/非字符串 mode）；
// - patchNonce 严格递增与并发/重放/submit 后再 prepare；
// - 授权集 prepare 时点冻结与 digest 档案一致性（含空授权集语义）；
// - 候选集 fail-closed 门（无清单/不在集内/大小写地址造证材料）；
// - 载荷边界（零值哈希、超长 metadataURI、未知字段接受面）。
import { describe, expect, it, vi } from "vitest";
import type { StoreProductSchemaDTO } from "@uvp-eth/product-dto";
import {
  capabilitiesRootOf,
  onchainSignalId,
  onchainSourceId,
} from "@uvp-eth/compiler";
import type { PlanCapabilityTablesInput } from "../src/indexer/projections/plan.js";
import { hashSignalAuthorizations } from "@uvp-eth/protocol-bindings";
import {
  executorCandidateProofFor,
  executorCandidatesRootOf,
} from "../src/submissions/capability-proofs.js";
import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createApiRouter, type ApiRouter } from "../src/api/routes.js";
import type { ChainEvent } from "../src/indexer/events.js";
import {
  createProductStageExecutorPatchService,
  type PreparedStageExecutorPatchDTO,
  type StageExecutorPatchBroadcastAdapter,
  type StageExecutorPatchBroadcastRequest,
  type StagePatchBroadcastResult,
} from "../src/stage-patches/index.js";
import { MemoryProjectionStore } from "../src/storage/projection-store.js";
import {
  normalizeAddress,
  type Address,
  type Hex,
} from "../src/shared/types.js";

const chainId = 31337;
const contractAddress = "0x1111111111111111111111111111111111111111" as Address;
const planId = bytes32Hex("101");
const planHash =
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex;
const orderId = bytes32Hex("202");
const selectorStageId = bytes32Text("selector.stage");
const selectorHookId = bytes32Hex("303");
const selectorHookName = bytes32Text("select-executor");
const targetStageId = bytes32Text("target.stage");
const executorPatchSignalId =
  "0xbbb1770c9313f4029a89e03f4719037cdad52864ab4da5f623bc7c8a0c489e97" as Hex;
const resourcePatchSignalId =
  "0x6dff331f2bb7b785cbcd99a911e6d30dc8714f43b3b9ba80c658215445ddd0ba" as Hex;
const roleHash = bytes32Text("target.executor");
const executorMetadataHash = bytes32Hex("404");
const executorPatchHash = bytes32Hex("505");
const txHash = bytes32Hex("707");
const ZERO_BYTES32 =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as const;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
const selectorAccount = privateKeyToAccount(
  "0x1111111111111111111111111111111111111111111111111111111111111111",
);
const previousExecutorAccount = privateKeyToAccount(
  "0x2222222222222222222222222222222222222222222222222222222222222222",
);
const selectorWallet = normalizeAddress(selectorAccount.address, "selector");
const previousExecutorWallet = normalizeAddress(
  previousExecutorAccount.address,
  "previousExecutor",
);
const outsiderWallet = "0x9999999999999999999999999999999999999999" as Address;
const executorWallet = "0x3333333333333333333333333333333333333333" as Address;
const baseNow = new Date("2026-04-30T00:00:00Z");

describe("stage-patches black-box adversarial", () => {
  // ------------------------------------------------------------------
  // 模式词表（规格 1：词表外一律 invalid_executor_patch_mode）
  // ------------------------------------------------------------------
  it("rejects executor patch modes outside the assign/handoff vocabulary verbatim", async () => {
    // 词表外字符串（含大小写变体词表外的词、非协作换人暗示词）必须 400，
    // 不得落成任何默认模式。
    const { router } = await routerFixture();
    for (const mode of [
      "REPLACEMENT",
      "replace",
      "replacement",
      "replacement ",
      " forkorder",
      "forkOrder",
      "rotate",
      "transfer",
      "reassign",
    ]) {
      await expect(
        router.handle({
          method: "POST",
          pathname: `/product/tasks/${selectorTaskId()}/prepare-stage-executor-patch`,
          body: prepareExecutorBody({ mode }),
        }),
      ).resolves.toMatchObject({
        status: 400,
        body: { error: "invalid_executor_patch_mode" },
      });
    }
  });

  it("accepts assign mode case-insensitively (documents lenient normalization)", async () => {
    // 现状：normalizeExecutorPatchMode trim+lowercase 后比对——"ASSIGN"
    // 属词表内的大小写变体，按宽松口径接受。规格未声明大小写敏感，
    // 这里钉住现状（宽松接受、等价语义），不构成越权。
    const { router } = await routerFixture();
    for (const mode of ["ASSIGN", " Assign ", "assign"]) {
      const response = await router.handle({
        method: "POST",
        pathname: `/product/tasks/${selectorTaskId()}/prepare-stage-executor-patch`,
        body: prepareExecutorBody({ mode }),
      });
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({ mode: "assign" });
    }
  });

  it("silently defaults non-string and empty-string mode to assign (documents acceptance-surface leniency)", async () => {
    // 现状：路由 optionalString 把非字符串/空串 mode 丢弃，服务层缺省
    // 补 "assign"——显式 mode:"" / mode:5 / mode:{} 不会得到
    // invalid_executor_patch_mode，而是静默落成 assign。语义上 mode 是
    // 可选字段、缺省 assign 成立；但显式传入的类型外值被静默归一，
    // 调用方无从感知。此处钉住现状，评估结论见测试报告：
    // 宽松解析隐患（低危），非越权漏洞——assign 仍是 selector 签名
    // 授权的合作换人，不产生任何非协作车道。
    const { router } = await routerFixture();
    for (const mode of ["", 5, null, {}, true]) {
      const response = await router.handle({
        method: "POST",
        pathname: `/product/tasks/${selectorTaskId()}/prepare-stage-executor-patch`,
        body: prepareExecutorBody({ mode: mode as unknown as string }),
      });
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({ mode: "assign" });
    }
  });

  it("rejects a non-zero previousExecutorWallet on assign mode but accepts the zero address", async () => {
    // assign 模式没有"上一执行者"概念：显式带非零 previousExecutor 必须
    // 拒绝（与合约同口径），零地址视为占位放行。
    const { router } = await routerFixture();
    await expect(
      router.handle({
        method: "POST",
        pathname: `/product/tasks/${selectorTaskId()}/prepare-stage-executor-patch`,
        body: prepareExecutorBody({ previousExecutorWallet: outsiderWallet }),
      }),
    ).resolves.toMatchObject({
      status: 400,
      body: { error: "previous_executor_not_allowed" },
    });

    const response = await router.handle({
      method: "POST",
      pathname: `/product/tasks/${selectorTaskId()}/prepare-stage-executor-patch`,
      body: prepareExecutorBody({ previousExecutorWallet: ZERO_ADDRESS }),
    });
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ mode: "assign" });
    expect((response.body as PreparedStageExecutorPatchDTO).previousExecutor).toBeUndefined();
  });

  it("rejects handoff prepare when the claimed previous executor mismatches the last submitter", async () => {
    // handoff 的会签对象是链上事实推定的上一执行者：谎报他人不得备签。
    const { router } = await routerFixture({
      events: [...baseEvents(), targetSignalSubmittedEvent(5n)],
    });
    await expect(
      router.handle({
        method: "POST",
        pathname: `/product/tasks/${selectorTaskId()}/prepare-stage-executor-patch`,
        body: prepareExecutorBody({
          mode: "handoff",
          previousExecutorWallet: outsiderWallet,
        }),
      }),
    ).resolves.toMatchObject({
      status: 409,
      body: { error: "previous_executor_mismatch" },
    });
  });

  // ------------------------------------------------------------------
  // patchNonce（规格 2：分配严格递增；submit 后广播实参与档案一致）
  // ------------------------------------------------------------------
  it("gives concurrent prepares the same nonce and lets exactly one submit win", async () => {
    // 并发 prepare 同单同阶段：链上投影未变 → 两次 prepare 派生同一
    // nonce（=1）。首写者赢：第一个 submit 成功，第二个 submit（另一个
    // prepareId、同一 nonce 键）撞 409 duplicate nonce，广播恰好一次。
    let broadcastCalls = 0;
    const { router } = await routerFixture({
      executorBroadcastAdapter: {
        broadcast: async (): Promise<StagePatchBroadcastResult> => {
          broadcastCalls += 1;
          return { status: "submitted", txHash };
        },
      },
    });
    const first = await prepareStageExecutorPatch(router);
    const second = await prepareStageExecutorPatch(router, {
      metadataURI: "ipfs://stage-executor-patches/race",
    });
    expect(first.patchNonce).toBe("1");
    expect(second.patchNonce).toBe("1");

    const firstSubmit = await router.handle({
      method: "POST",
      pathname: `/product/tasks/${selectorTaskId()}/submit-stage-executor-patch`,
      body: {
        prepareId: first.prepareId,
        selectorWallet,
        signature: await signExecutorPrepared(first),
      },
    });
    expect(firstSubmit.status).toBe(200);

    await expect(
      router.handle({
        method: "POST",
        pathname: `/product/tasks/${selectorTaskId()}/submit-stage-executor-patch`,
        body: {
          prepareId: second.prepareId,
          selectorWallet,
          signature: await signExecutorPrepared(second),
        },
      }),
    ).resolves.toMatchObject({
      status: 409,
      body: { error: "duplicate_stage_executor_patch_nonce" },
    });
    expect(broadcastCalls).toBe(1);
  });

  it("keeps replaying the consumed nonce fail-closed when the chain projection has not caught up", async () => {
    // submit 成功后链上事件未回放：再 prepare 仍派生旧 nonce（=1），
    // 其 submit 必须被 store 的 nonce 预留门 409 拒绝，绝不二次广播。
    let broadcastCalls = 0;
    const { router, store } = await routerFixture({
      executorBroadcastAdapter: {
        broadcast: async (): Promise<StagePatchBroadcastResult> => {
          broadcastCalls += 1;
          return { status: "submitted", txHash };
        },
      },
    });
    const first = await prepareStageExecutorPatch(router);
    const firstSubmit = await router.handle({
      method: "POST",
      pathname: `/product/tasks/${selectorTaskId()}/submit-stage-executor-patch`,
      body: {
        prepareId: first.prepareId,
        selectorWallet,
        signature: await signExecutorPrepared(first),
      },
    });
    expect(firstSubmit.status).toBe(200);

    // 投影原样重建（无 StageExecutorPatchApplied 事件）模拟索引滞后。
    await store.resetFromEvents({
      deploymentBlock: 0n,
      events: baseEvents(),
      planCapabilityTables: planCapabilityTablesFor(baseEvents()),
    });
    const replayed = await prepareStageExecutorPatch(router, {
      metadataURI: "ipfs://stage-executor-patches/replay",
    });
    expect(replayed.patchNonce).toBe("1");

    await expect(
      router.handle({
        method: "POST",
        pathname: `/product/tasks/${selectorTaskId()}/submit-stage-executor-patch`,
        body: {
          prepareId: replayed.prepareId,
          selectorWallet,
          signature: await signExecutorPrepared(replayed),
        },
      }),
    ).resolves.toMatchObject({
      status: 409,
      body: { error: "duplicate_stage_executor_patch_nonce" },
    });
    expect(broadcastCalls).toBe(1);
  });

  it("allocates a strictly increasing nonce once the applied patch lands in the projection", async () => {
    // 链上 StageExecutorPatchApplied(nonce=1) 回放后：下一次 prepare 必须
    // 分配 nonce=2（严格递增），且 submit 全链路成功。
    let broadcastCalls = 0;
    const events = [
      ...baseEvents(),
      stageExecutorPatchAppliedEvent(5n, 1n),
    ];
    const { router } = await routerFixture({
      events,
      executorBroadcastAdapter: {
        broadcast: async (): Promise<StagePatchBroadcastResult> => {
          broadcastCalls += 1;
          return { status: "submitted", txHash };
        },
      },
    });
    const prepared = await prepareStageExecutorPatch(router, {
      metadataURI: "ipfs://stage-executor-patches/2",
    });
    expect(prepared.patchNonce).toBe("2");

    const response = await router.handle({
      method: "POST",
      pathname: `/product/tasks/${selectorTaskId()}/submit-stage-executor-patch`,
      body: {
        prepareId: prepared.prepareId,
        selectorWallet,
        signature: await signExecutorPrepared(prepared),
      },
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ patchNonce: "2" });
    expect(broadcastCalls).toBe(1);
  });

  // ------------------------------------------------------------------
  // 授权集（规格 2：prepare 时点冻结；digest 与档案一致；空集语义）
  // ------------------------------------------------------------------
  it("broadcasts the authorization set frozen at prepare even when the plan projection gains facts before submit", async () => {
    // prepare 后投影重新富集出更多目标阶段事实：授权集不得随投影漂移
    // ——selector 签名覆盖的是 prepare 时点冻结的集，submit 广播实参
    // 必须与档案逐字节一致。
    const vocabBefore = registerPlanVocabulary({
      selectorBindings: [{ selectorStageId, targetStageId }],
      signalCapabilities: [
        {
          stageId: selectorStageId,
          targetSourceId: selectorStageId,
          signalId: selectorHookName,
          targetOrderRelation: 0,
        },
        {
          stageId: targetStageId,
          targetSourceId: onchainSourceId("origin.a"),
          signalId: onchainSignalId("a.action"),
          targetOrderRelation: 0,
        },
      ],
    });
    const vocabAfter = registerPlanVocabulary({
      selectorBindings: [{ selectorStageId, targetStageId }],
      signalCapabilities: [
        {
          stageId: selectorStageId,
          targetSourceId: selectorStageId,
          signalId: selectorHookName,
          targetOrderRelation: 0,
        },
        {
          stageId: targetStageId,
          targetSourceId: onchainSourceId("origin.a"),
          signalId: onchainSignalId("a.action"),
          targetOrderRelation: 0,
        },
        {
          stageId: targetStageId,
          targetSourceId: onchainSourceId("origin.b"),
          signalId: onchainSignalId("b.action"),
          targetOrderRelation: 0,
        },
      ],
    });
    const broadcast = vi.fn(
      async (
        request: StageExecutorPatchBroadcastRequest,
      ): Promise<StagePatchBroadcastResult> => ({
        status: "submitted",
        txHash,
      }),
    );
    const { router, store } = await routerFixture({
      events: baseEvents({ vocabulary: vocabBefore }),
      executorBroadcastAdapter: { broadcast },
    });
    const prepared = await prepareStageExecutorPatch(router);
    expect(prepared.executorAuthorizations).toHaveLength(1);
    const frozenAuthorizations = prepared.executorAuthorizations;

    // 投影重放：plan 词表升级为含两条目标阶段事实的版本。
    await store.resetFromEvents({
      deploymentBlock: 0n,
      events: baseEvents({ vocabulary: vocabAfter }),
      planCapabilityTables: planCapabilityTablesFor(
        baseEvents({ vocabulary: vocabAfter }),
      ),
    });

    const response = await router.handle({
      method: "POST",
      pathname: `/product/tasks/${selectorTaskId()}/submit-stage-executor-patch`,
      body: {
        prepareId: prepared.prepareId,
        selectorWallet,
        signature: await signExecutorPrepared(prepared),
      },
    });
    expect(response.status).toBe(200);
    expect(broadcast).toHaveBeenCalledOnce();
    const request = broadcast.mock.calls[0]![0];
    expect(request.executorAuthorizations).toEqual(frozenAuthorizations);
    expect(request.prepared.authorizationsHash).toBe(
      prepared.authorizationsHash,
    );
    expect(request.executorAuthorizations).toHaveLength(1);
  });

  it("derives an empty authorization set for plans without target-stage capability facts and still submits", async () => {
    // 空授权集语义：词表无目标阶段 relation=current 事实 → 授权集为空、
    // authorizationsHash = hashSignalAuthorizations([])。合约接受空集
    // （patch 合法、不授予任何提交权），服务面同口径放行。
    const broadcast = vi.fn(
      async (
        _request: StageExecutorPatchBroadcastRequest,
      ): Promise<StagePatchBroadcastResult> => ({
        status: "submitted",
        txHash,
      }),
    );
    const { router } = await routerFixture({
      executorBroadcastAdapter: { broadcast },
    });
    const prepared = await prepareStageExecutorPatch(router);
    expect(prepared.executorAuthorizations).toEqual([]);
    expect(prepared.authorizationsHash).toBe(hashSignalAuthorizations([]));

    const response = await router.handle({
      method: "POST",
      pathname: `/product/tasks/${selectorTaskId()}/submit-stage-executor-patch`,
      body: {
        prepareId: prepared.prepareId,
        selectorWallet,
        signature: await signExecutorPrepared(prepared),
      },
    });
    expect(response.status).toBe(200);
    const request = broadcast.mock.calls[0]![0];
    expect(request.executorAuthorizations).toEqual([]);
  });

  it("maps target-stage capability facts to the new executor with the patch role and metadata commitments", async () => {
    // 非空授权集推导：目标阶段 relation=current 事实全表 → submitter=
    // 新执行者、role/metadataHash 取 patch 承诺值；哈希与
    // hashSignalAuthorizations 一致（digest 面可复算）。
    const factA = {
      stageId: targetStageId,
      targetSourceId: onchainSourceId("origin.a"),
      signalId: onchainSignalId("a.action"),
      targetOrderRelation: 0 as const,
    };
    const factB = {
      stageId: targetStageId,
      targetSourceId: onchainSourceId("origin.b"),
      signalId: onchainSignalId("b.action"),
      targetOrderRelation: 0 as const,
    };
    const vocabulary = registerPlanVocabulary({
      selectorBindings: [{ selectorStageId, targetStageId }],
      signalCapabilities: [
        {
          stageId: selectorStageId,
          targetSourceId: selectorStageId,
          signalId: selectorHookName,
          targetOrderRelation: 0,
        },
        factA,
        factB,
      ],
    });
    const { router } = await routerFixture({
      events: baseEvents({ vocabulary }),
    });
    const prepared = await prepareStageExecutorPatch(router);
    expect(prepared.executorAuthorizations).toEqual([
      {
        sourceId: factA.targetSourceId,
        signalId: factA.signalId,
        submitter: executorWallet,
        role: roleHash,
        metadataHash: executorMetadataHash,
      },
      {
        sourceId: factB.targetSourceId,
        signalId: factB.signalId,
        submitter: executorWallet,
        role: roleHash,
        metadataHash: executorMetadataHash,
      },
    ]);
    expect(prepared.authorizationsHash).toBe(
      hashSignalAuthorizations(prepared.executorAuthorizations),
    );
    expect(prepared.typedData.message.authorizationsHash).toBe(
      prepared.authorizationsHash,
    );
  });

  it("rejects a submitted patch envelope whose authorizationsHash diverges from the archive", async () => {
    // 提交方篡改回传的 patch 档案（换授权集哈希）：canonical 比对必须
    // 400 prepared_patch_mismatch，且不广播。
    const broadcast = vi.fn(async (): Promise<StagePatchBroadcastResult> => ({
      status: "submitted",
      txHash,
    }));
    const { router } = await routerFixture({
      executorBroadcastAdapter: { broadcast },
    });
    const prepared = await prepareStageExecutorPatch(router);
    const tampered = {
      ...prepared,
      authorizationsHash: bytes32Hex("fff"),
    };
    await expect(
      router.handle({
        method: "POST",
        pathname: `/product/tasks/${selectorTaskId()}/submit-stage-executor-patch`,
        body: {
          prepareId: prepared.prepareId,
          selectorWallet,
          patch: tampered,
          signature: await signExecutorPrepared(prepared),
        },
      }),
    ).resolves.toMatchObject({
      status: 400,
      body: { error: "prepared_patch_mismatch" },
    });
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("rejects a submitted typedData envelope whose digest diverges from the prepared one", async () => {
    // 回传 typedData 被篡改（digest 面授权集哈希换掉）：
    // 400 typed_data_mismatch，不广播。
    const broadcast = vi.fn(async (): Promise<StagePatchBroadcastResult> => ({
      status: "submitted",
      txHash,
    }));
    const { router } = await routerFixture({
      executorBroadcastAdapter: { broadcast },
    });
    const prepared = await prepareStageExecutorPatch(router);
    const tamperedTypedData = {
      ...prepared.typedData,
      message: {
        ...prepared.typedData.message,
        authorizationsHash: bytes32Hex("ffe"),
      },
    };
    await expect(
      router.handle({
        method: "POST",
        pathname: `/product/tasks/${selectorTaskId()}/submit-stage-executor-patch`,
        body: {
          prepareId: prepared.prepareId,
          selectorWallet,
          typedData: tamperedTypedData,
          signature: await signExecutorPrepared(prepared),
        },
      }),
    ).resolves.toMatchObject({
      status: 400,
      body: { error: "typed_data_mismatch" },
    });
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("rejects a signature produced over a tampered digest even without envelopes", async () => {
    // 不回传 envelope、只换签：selector 对"另一个 digest"签名，服务端
    // 按档案 typedData 恢复地址 → 与 selector 不符 → 400 invalid_signature。
    // 封面校验不是唯一防线，验签本身绑定档案摘要。
    const broadcast = vi.fn(async (): Promise<StagePatchBroadcastResult> => ({
      status: "submitted",
      txHash,
    }));
    const { router } = await routerFixture({
      executorBroadcastAdapter: { broadcast },
    });
    const prepared = await prepareStageExecutorPatch(router);
    const tamperedTypedData = {
      ...prepared.typedData,
      message: {
        ...prepared.typedData.message,
        authorizationsHash: bytes32Hex("ffd"),
      },
    };
    await expect(
      router.handle({
        method: "POST",
        pathname: `/product/tasks/${selectorTaskId()}/submit-stage-executor-patch`,
        body: {
          prepareId: prepared.prepareId,
          selectorWallet,
          signature: await selectorAccount.signTypedData(
            tamperedTypedData as unknown as Parameters<
              typeof selectorAccount.signTypedData
            >[0],
          ),
        },
      }),
    ).resolves.toMatchObject({
      status: 400,
      body: { error: "invalid_signature" },
    });
    expect(broadcast).not.toHaveBeenCalled();
  });

  // ------------------------------------------------------------------
  // 候选集门（规格 3：409 fail-closed，不发必 revert 的交易）
  // ------------------------------------------------------------------
  it("fails closed at submit when the re-projected plan lost the candidate list", async () => {
    // prepare 时点候选集在、submit 时投影重放成无候选集清单：
    // executor_candidate_set_unavailable，不广播。
    // 注意：词表产物按 planId 单源——重放词表必须换 capabilitiesRoot
    // （追加一条无关能力事实）才能携带不同的候选集清单，这里在夹具
    // 创建之后再注册，避免与默认词表同根互相覆盖。
    const broadcast = vi.fn(async (): Promise<StagePatchBroadcastResult> => ({
      status: "submitted",
      txHash,
    }));
    const { router, store } = await routerFixture({
      executorBroadcastAdapter: { broadcast },
    });
    const prepared = await prepareStageExecutorPatch(router);

    const emptyCandidates = registerPlanVocabulary({
      selectorBindings: [{ selectorStageId, targetStageId }],
      signalCapabilities: [
        {
          stageId: selectorStageId,
          targetSourceId: selectorStageId,
          signalId: selectorHookName,
          targetOrderRelation: 0,
        },
        {
          stageId: selectorStageId,
          targetSourceId: onchainSourceId("origin.note"),
          signalId: onchainSignalId("selector.note"),
          targetOrderRelation: 0,
        },
      ],
      executorCandidates: [],
    });

    await store.resetFromEvents({
      deploymentBlock: 0n,
      events: baseEvents({ vocabulary: emptyCandidates }),
      planCapabilityTables: planCapabilityTablesFor(
        baseEvents({ vocabulary: emptyCandidates }),
      ),
    });

    await expect(
      router.handle({
        method: "POST",
        pathname: `/product/tasks/${selectorTaskId()}/submit-stage-executor-patch`,
        body: {
          prepareId: prepared.prepareId,
          selectorWallet,
          signature: await signExecutorPrepared(prepared),
        },
      }),
    ).resolves.toMatchObject({
      status: 409,
      body: { error: "executor_candidate_set_unavailable" },
    });
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("fails closed at submit when the executor was removed from the candidate set", async () => {
    // prepare 后执行者被移出候选集（投影按修正后的产物重放，候选集
    // 同根约束下换成新词表 root）：executor_not_in_candidate_set，
    // 不广播（链上 StageExecutorNotCandidate 恒拒）。
    const broadcast = vi.fn(async (): Promise<StagePatchBroadcastResult> => ({
      status: "submitted",
      txHash,
    }));
    const { router, store } = await routerFixture({
      executorBroadcastAdapter: { broadcast },
    });
    const prepared = await prepareStageExecutorPatch(router);

    const evicted = registerPlanVocabulary({
      selectorBindings: [{ selectorStageId, targetStageId }],
      signalCapabilities: [
        {
          stageId: selectorStageId,
          targetSourceId: selectorStageId,
          signalId: selectorHookName,
          targetOrderRelation: 0,
        },
        {
          stageId: selectorStageId,
          targetSourceId: onchainSourceId("origin.note"),
          signalId: onchainSignalId("selector.note"),
          targetOrderRelation: 0,
        },
      ],
      executorCandidates: [
        { stageId: targetStageId, executor: outsiderWallet },
      ],
    });

    await store.resetFromEvents({
      deploymentBlock: 0n,
      events: baseEvents({ vocabulary: evicted }),
      planCapabilityTables: planCapabilityTablesFor(
        baseEvents({ vocabulary: evicted }),
      ),
    });

    await expect(
      router.handle({
        method: "POST",
        pathname: `/product/tasks/${selectorTaskId()}/submit-stage-executor-patch`,
        body: {
          prepareId: prepared.prepareId,
          selectorWallet,
          signature: await signExecutorPrepared(prepared),
        },
      }),
    ).resolves.toMatchObject({
      status: 409,
      body: { error: "executor_not_in_candidate_set" },
    });
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("builds the candidate proof through case-insensitive address normalization", async () => {
    // 造证材料大小写：候选集清单以 EIP-55 checksummed 地址登记、请求
    // executorWallet 用大写变体——成员资格必须经小写归一命中，proof
    // 与小写规范形态逐字节一致（否则合法执行者被误伤 fail-closed）。
    // 全数字地址无 EIP-55 大写位，选含字母的执行者地址验证大小写归一。
    const letteredExecutor =
      "0xabc000000000000000000000000000000000de01" as Address;
    const checksummedExecutor = getAddress(letteredExecutor);
    expect(checksummedExecutor).not.toBe(letteredExecutor);
    const checksummedCandidates = [
      { stageId: targetStageId, executor: checksummedExecutor },
    ];
    const vocabulary = registerPlanVocabulary({
      selectorBindings: [{ selectorStageId, targetStageId }],
      signalCapabilities: [
        {
          stageId: selectorStageId,
          targetSourceId: selectorStageId,
          signalId: selectorHookName,
          targetOrderRelation: 0,
        },
      ],
      executorCandidates: checksummedCandidates,
    });
    const broadcast = vi.fn(
      async (
        _request: StageExecutorPatchBroadcastRequest,
      ): Promise<StagePatchBroadcastResult> => ({
        status: "submitted",
        txHash,
      }),
    );
    const { router } = await routerFixture({
      events: baseEvents({ vocabulary }),
      executorBroadcastAdapter: { broadcast },
    });
    const prepared = await prepareStageExecutorPatch(router, {
      executorWallet: checksummedExecutor.toUpperCase().replace(/^0X/, "0x"),
    });
    expect(prepared.executorWallet).toBe(letteredExecutor);
    expect(prepared.status).toBe("prepared");

    const response = await router.handle({
      method: "POST",
      pathname: `/product/tasks/${selectorTaskId()}/submit-stage-executor-patch`,
      body: {
        prepareId: prepared.prepareId,
        selectorWallet,
        signature: await signExecutorPrepared(prepared),
      },
    });
    expect(response.status).toBe(200);
    const request = broadcast.mock.calls[0]![0];
    expect(request.candidateProof).toEqual(
      executorCandidateProofFor(
        [{ stageId: targetStageId, executor: letteredExecutor }],
        targetStageId,
        letteredExecutor,
      ),
    );
  });

  // ------------------------------------------------------------------
  // 载荷边界与接受面
  // ------------------------------------------------------------------
  it("rejects zero-valued roleHash, executorMetadataHash, and executorWallet", async () => {
    // 零值承诺=未承诺：role/metadataHash/executor 零值必须 400
    // invalid_body，不得备签出全零承诺的补丁。
    const { router } = await routerFixture();
    for (const overrides of [
      { roleHash: ZERO_BYTES32 },
      { executorMetadataHash: ZERO_BYTES32 },
      { executorWallet: ZERO_ADDRESS },
    ]) {
      await expect(
        router.handle({
          method: "POST",
          pathname: `/product/tasks/${selectorTaskId()}/prepare-stage-executor-patch`,
          body: prepareExecutorBody(overrides),
        }),
      ).resolves.toMatchObject({
        status: 400,
        body: { error: "invalid_body" },
      });
    }
  });

  it("accepts an oversized metadataURI (documents the absent length cap)", async () => {
    // 现状：metadataURI 只做 trim 非空校验，无长度上限——超长 URI 可
    // 备签、digest 可计算。链下接受面不设限，把 gas 上限压力留给链上
    // 合约与 relayer。钉住现状，评估见报告（低危：prepare 表有硬上限
    // 兜底，非无界堆积）。
    const oversizedURI = `ipfs://stage-executor-patches/${"x".repeat(100_000)}`;
    const { router } = await routerFixture();
    const response = await router.handle({
      method: "POST",
      pathname: `/product/tasks/${selectorTaskId()}/prepare-stage-executor-patch`,
      body: prepareExecutorBody({ metadataURI: oversizedURI }),
    });
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      metadataURI: oversizedURI,
      status: "prepared",
    });
  });

  it("ignores unknown prepare fields, including non-cooperative lane phrasing (documents the acceptance surface)", async () => {
    // 现状：路由只挑已知字段，未知字段静默忽略——即使字段名暗示非协作
    // 换人（规格 4：本服务面无此车道），也只产生一个普通 assign 补丁。
    // 不存在越权（补丁仍是 selector 签名的合作换人），但"看似请求了
    // force-replace 实际得到 assign"是接受面误导：调用方以为表达了
    // 非协作语义，服务面无任何提示。评估见报告。
    const broadcast = vi.fn(async (): Promise<StagePatchBroadcastResult> => ({
      status: "submitted",
      txHash,
    }));
    const { router } = await routerFixture({
      executorBroadcastAdapter: { broadcast },
    });
    const response = await router.handle({
      method: "POST",
      pathname: `/product/tasks/${selectorTaskId()}/prepare-stage-executor-patch`,
      body: {
        ...prepareExecutorBody(),
        executorPatchStrategy: "force-replace",
        replacementExecutor: outsiderWallet,
        forkOrder: true,
        nonCooperative: { eject: outsiderWallet },
        previousExecutorSignature: "0xdeadbeef",
      },
    });
    expect(response.status).toBe(201);
    const prepared = response.body as PreparedStageExecutorPatchDTO;
    expect(prepared.mode).toBe("assign");
    expect(prepared.executorWallet).toBe(executorWallet);
    expect(JSON.stringify(prepared)).not.toContain("force-replace");
    expect(JSON.stringify(prepared)).not.toContain(outsiderWallet.slice(2, 10));

    // 附加字段不改变 digest：同参干净请求的 patchHash 与带杂音的一致。
    const clean = await prepareStageExecutorPatch(await routerFixture().then((f) => f.router));
    expect(clean.patchHash).toBe(prepared.patchHash);
    expect(clean.authorizationsHash).toBe(prepared.authorizationsHash);
  });

  it("keeps stage resource patches blocked once the target stage started (non-executor lane stays closed)", async () => {
    // 规格 4 侧写：非协作换人不在本服务面（无入口/字段）。资源补丁车道
    // 在目标阶段开工后同样锁定，防止借资源补丁通道变相换人面扩张。
    const { router } = await routerFixture({
      events: [...baseEvents(), targetSignalSubmittedEvent(5n)],
    });
    await expect(
      router.handle({
        method: "POST",
        pathname: `/product/tasks/${selectorTaskId()}/prepare-stage-resource-patch`,
        body: prepareResourceBody(),
      }),
    ).resolves.toMatchObject({
      status: 409,
      body: { error: "target_stage_locked" },
    });
  });
});

// ---------------------------------------------------------------------------
// 造桩（与 stage-patches.test.ts 同口径的自包含夹具）
// ---------------------------------------------------------------------------

async function routerFixture(
  options: {
    readonly executorBroadcastAdapter?: StageExecutorPatchBroadcastAdapter;
    readonly events?: readonly ChainEvent[];
    readonly productSchema?: StoreProductSchemaDTO;
  } = {},
): Promise<{
  readonly router: ApiRouter;
  readonly store: MemoryProjectionStore;
}> {
  const store = new MemoryProjectionStore();
  const events = options.events ?? baseEvents();
  await store.resetFromEvents({
    deploymentBlock: 0n,
    events,
    planCapabilityTables: planCapabilityTablesFor(events),
  });
  const productSchemaResolver = options.productSchema
    ? {
        getProductSchemaByPlan: async (
          requestedPlanId: string,
          requestedPlanHash: string,
        ) =>
          requestedPlanId === options.productSchema!.planId &&
          requestedPlanHash === options.productSchema!.artifactHash
            ? options.productSchema
            : undefined,
      }
    : undefined;
  let prepareCount = 0;
  let submissionCount = 0;
  const commonOptions = {
    store,
    ...(productSchemaResolver ? { productSchemaResolver } : {}),
    chainId,
    stagePatchModuleAddress: contractAddress,
    dockingModuleAddress: contractAddress,
    now: () => baseNow,
    prepareIdFactory: () => `prep_${++prepareCount}`,
    submissionIdFactory: () => `sub_${++submissionCount}`,
  };
  const executorService = createProductStageExecutorPatchService({
    ...commonOptions,
    ...(options.executorBroadcastAdapter
      ? { broadcastAdapter: options.executorBroadcastAdapter }
      : {}),
  });
  return {
    store,
    router: createApiRouter(store, {
      productRuntimeEnvironment: "local",
      submissionChainId: 84532,
      submissionVerifyingContract:
        "0x1111111111111111111111111111111111111111",
      productStageExecutorPatchService: executorService,
    }),
  };
}

async function prepareStageExecutorPatch(
  router: ApiRouter,
  overrides: Record<string, unknown> = {},
): Promise<PreparedStageExecutorPatchDTO> {
  const response = await router.handle({
    method: "POST",
    pathname: `/product/tasks/${selectorTaskId()}/prepare-stage-executor-patch`,
    body: prepareExecutorBody(overrides),
  });
  expect(response.status).toBe(201);
  return response.body as PreparedStageExecutorPatchDTO;
}

function prepareExecutorBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    selectorWallet,
    targetStageId,
    executorWallet,
    mode: "assign",
    roleHash,
    executorMetadataHash,
    metadataURI: "ipfs://stage-executor-patches/1",
    ...overrides,
  };
}

function prepareResourceBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    selectorWallet,
    targetStageId,
    resourceKey: "invoice-pdf",
    manifestHash: bytes32Hex("a11"),
    policyHash: bytes32Hex("b22"),
    manifestURI: "ipfs://resource-manifests/invoice-v1",
    ...overrides,
  };
}

async function signExecutorPrepared(
  prepared: PreparedStageExecutorPatchDTO,
): Promise<Hex> {
  return await selectorAccount.signTypedData(
    prepared.typedData as unknown as Parameters<
      typeof selectorAccount.signTypedData
    >[0],
  );
}

const vocabularyRegistry = new Map<string, PlanCapabilityTablesInput>();

interface VocabularyFixture extends PlanCapabilityTablesInput {
  readonly capabilitiesRoot: Hex;
  readonly executorCandidatesRoot: Hex;
}

function registerPlanVocabulary(tables: {
  readonly selectorBindings: readonly { readonly selectorStageId: Hex; readonly targetStageId: Hex }[];
  readonly signalCapabilities?: readonly {
    readonly stageId: Hex;
    readonly targetSourceId: Hex;
    readonly signalId: Hex;
    readonly targetOrderRelation: 0 | 1;
  }[];
  readonly executorCandidates?: readonly { readonly stageId: Hex; readonly executor: Address }[];
}): VocabularyFixture {
  const signalCapabilities = tables.signalCapabilities ?? [];
  const executorCandidates = tables.executorCandidates ?? tables.selectorBindings.map(
    (binding) => ({ stageId: binding.targetStageId, executor: executorWallet }),
  );
  const capabilitiesRoot = capabilitiesRootOf(tables.selectorBindings, signalCapabilities);
  const executorCandidatesRoot = executorCandidatesRootOf(executorCandidates);
  vocabularyRegistry.set(capabilitiesRoot, {
    planId,
    planHash,
    selectorBindings: tables.selectorBindings,
    signalCapabilities,
    executorCandidates,
  });
  return {
    planId,
    planHash,
    selectorBindings: tables.selectorBindings,
    signalCapabilities,
    executorCandidates,
    capabilitiesRoot,
    executorCandidatesRoot,
  };
}

function planCapabilityTablesFor(events: readonly ChainEvent[]): readonly PlanCapabilityTablesInput[] {
  const roots = new Set(events
    .filter((event) => event.eventName === "PlanCommitted" || event.eventName === "PlanFinalized")
    .map((event) => String(event.args["capabilitiesRoot"] ?? "").toLowerCase()));
  return [...vocabularyRegistry.entries()]
    .filter(([root]) => roots.has(root))
    .map(([, tables]) => tables);
}

function baseEvents(
  options: {
    readonly vocabulary?: VocabularyFixture;
  } = {},
): readonly ChainEvent[] {
  const vocabulary = options.vocabulary ?? registerPlanVocabulary({
    selectorBindings: [{ selectorStageId, targetStageId }],
    signalCapabilities: [{
      stageId: selectorStageId,
      targetSourceId: selectorStageId,
      signalId: selectorHookName,
      targetOrderRelation: 0,
    }],
  });
  return [
    chainEvent(1n, "PlanCommitted", {
      planId,
      planHash,
      publisher: selectorWallet,
      hooksHash: bytes32Hex("806"),
      capabilitiesRoot: vocabulary.capabilitiesRoot,
      hookCount: 1n,
      dockRoutesRoot: bytes32Hex("807"),
      dockInterfaceRoot: bytes32Hex("808"),
      executorCandidatesRoot: vocabulary.executorCandidatesRoot,
    }),
    chainEvent(1n, "PlanPublisherRecorded", {
      planId,
      publisher: selectorWallet,
    }, 1),
    chainEvent(1n, "PlanFinalized", {
      planId,
      planHash,
      capabilitiesRoot: vocabulary.capabilitiesRoot,
    }, 2),
    chainEvent(1n, "PlanRegistered", {
      planId,
      planHash,
      hookCount: 1n,
    }, 3),
    chainEvent(2n, "OrderRegistered", {
      orderId,
      planId,
    }),
    chainEvent(3n, "SignalSubmitterAuthorized", {
      orderId,
      sourceId: selectorStageId,
      signalId: selectorHookName,
      submitter: selectorWallet,
      role: bytes32Text("selector"),
      metadataHash: bytes32Hex("909"),
    }),
    chainEvent(3n, "SignalSubmitterAuthorized", {
      orderId,
      sourceId: selectorStageId,
      signalId: executorPatchSignalId,
      submitter: selectorWallet,
      role: bytes32Text("selector"),
      metadataHash: bytes32Hex("90a"),
    }, 1),
    chainEvent(3n, "SignalSubmitterAuthorized", {
      orderId,
      sourceId: selectorStageId,
      signalId: resourcePatchSignalId,
      submitter: selectorWallet,
      role: bytes32Text("selector"),
      metadataHash: bytes32Hex("90b"),
    }, 2),
    chainEvent(4n, "HookReady", {
      orderId,
      hookId: selectorHookId,
      stageId: selectorStageId,
      hookName: selectorHookName,
    }),
  ];
}

function stageExecutorPatchAppliedEvent(
  blockNumber: bigint,
  patchNonce: bigint,
): ChainEvent {
  return chainEvent(blockNumber, "StageExecutorPatchApplied", {
    orderId,
    selectorStageId,
    targetStageId,
    selector: selectorWallet,
    executor: executorWallet,
    role: roleHash,
    executorMetadataHash,
    patchHash: executorPatchHash,
    patchNonce,
    metadataURI: "ipfs://stage-executor-patches/1",
  });
}

function targetSignalSubmittedEvent(blockNumber: bigint): ChainEvent {
  return chainEvent(blockNumber, "SignalSubmitted", {
    orderId,
    sourceId: targetStageId,
    signalId: bytes32Text("target-started"),
    payloadHash: bytes32Hex("515"),
    idempotencyKey: bytes32Hex("616"),
    submitter: previousExecutorWallet,
  });
}

function selectorTaskId(): string {
  return `${contractAddress}:${orderId}:${selectorHookId}`;
}

function chainEvent(
  blockNumber: bigint,
  eventName: string,
  args: Record<string, unknown>,
  logIndex = 0,
): ChainEvent {
  return {
    chainId,
    contractAddress,
    blockNumber,
    transactionHash: bytes32Hex(blockNumber.toString(16)) as Hex,
    logIndex,
    eventName,
    args,
  };
}

function bytes32Text(value: string): Hex {
  return `0x${Buffer.from(value, "utf8").toString("hex").padEnd(64, "0")}` as Hex;
}

function bytes32Hex(value: string): Hex {
  return `0x${value.padStart(64, "0")}` as Hex;
}
