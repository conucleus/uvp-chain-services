import { randomUUID } from "node:crypto";
import { onchainStageId, ONCHAIN_HOOK_PLAN_SCHEMA_VERSION } from "@uvp-eth/compiler";
import {
  hashSignalAuthorizations,
  type SelectorBindingPayload,
  type SignalAuthorizationPayload
} from "@uvp-eth/protocol-bindings";
import type { StoreProductSchemaDTO } from "@uvp-eth/product-dto";
import type { ChainServicesRuntimeEnv } from "../config/index.js";
import { canonicalJson } from "@uvp-eth/canonical-json";
import {
  STAGE_EXECUTOR_PATCH_SIGNAL_ID,
  STAGE_RESOURCE_PATCH_SIGNAL_ID,
} from "../shared/protocol-constants.js";
import {
  ConfigError,
  compareChainPointers,
  normalizeAddress,
  normalizeBytes32,
  type Address,
  type Hex,
} from "../shared/types.js";
import { releaseRelayNonce, reserveRelayNonce } from "../relay/nonce.js";
import type {
  StateMachineOrderProjection,
  StateMachinePlanProjection,
  StateMachineSignalCapabilityProjection,
  StateMachineStageSelectorBindingProjection,
  StateMachineTaskProjection,
} from "../indexer/projection-types.js";
import { signalProjectionKey } from "../indexer/projections/signal.js";
import type { ProjectionProvenance } from "../indexer/projections/proof.js";
import type { ProjectionStore } from "../storage/projection-store.js";
import type { ChainClock } from "../shared/chain-clock.js";
import {
  executorCandidateProofFor,
  selectorBindingProofForPatch,
  type PlanCapabilityTables
} from "../submissions/capability-proofs.js";
import {
  buildStageExecutorPatchTypedData,
  buildStageResourcePatchTypedData,
  executorPatchModeHash,
  hashStageExecutorPatchPayload,
  hashStageResourcePatchPayload,
  normalizeSignature,
  recoverStageExecutorPatchSigner,
  recoverStageResourcePatchSigner,
  signatureHashFor,
  textHash,
} from "./typed-data.js";
import {
  notSupportedStageExecutorPatchBroadcastAdapter,
  notSupportedStageResourcePatchBroadcastAdapter,
} from "./broadcast-adapter.js";
import { stagePatchNonceKey } from "./keys.js";
import type {
  PrepareProductStageExecutorPatchInput,
  PrepareProductStageResourcePatchInput,
  PreparedPatchRecordBase,
  PreparedStageExecutorPatchDTO,
  PreparedStageExecutorPatchRecord,
  PreparedStageResourcePatchDTO,
  PreparedStageResourcePatchRecord,
  ProductStagePatchStore,
  ProductStageExecutorPatchStore,
  ProductStageResourcePatchStore,
  StageExecutorPatchMode,
  StageExecutorPatchBroadcastAdapter,
  StageExecutorPatchSubmissionDTO,
  PreviousExecutorSignatureStatus,
  StagePatchBroadcastResult,
  StagePatchSubmissionBase,
  StageResourcePatchBroadcastAdapter,
  StageResourcePatchSubmissionDTO,
  SubmitProductStageExecutorPatchInput,
  SubmitProductStageResourcePatchInput,
} from "./types.js";

const DEFAULT_PREPARE_TTL_SECONDS = 10 * 60;

export interface ProductSchemaResolver {
  getProductSchemaByPlan(
    planId: string,
    planHash: string,
  ): Promise<StoreProductSchemaDTO | undefined>;
}

function requireChainClockNowSeconds(
  options: ProductStagePatchServiceOptions,
): Promise<number> {
  if (!options.chainClock) {
    throw new ConfigError(
      "stage patch prepare requires a chain clock (latest block timestamp) to derive the signature deadline; wire options.chainClock"
    );
  }
  return options.chainClock.latestBlockTimestampSeconds();
}
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
const ZERO_BYTES32 =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as const;
const EXECUTOR_PATCH_SIGNAL_ID = STAGE_EXECUTOR_PATCH_SIGNAL_ID;
const RESOURCE_PATCH_SIGNAL_ID = STAGE_RESOURCE_PATCH_SIGNAL_ID;

export {
  STAGE_EXECUTOR_PATCH_SIGNAL_ID,
  STAGE_RESOURCE_PATCH_SIGNAL_ID,
} from "../shared/protocol-constants.js";

export class ProductStagePatchError extends Error {
  override readonly name = "ProductStagePatchError";

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export interface ProductStagePatchServiceOptions {
  readonly store: ProjectionStore;
  readonly productSchemaResolver?: ProductSchemaResolver;
  readonly productBffStore?: StagePatchProductBffPort;
  readonly chainId?: number;
  readonly verifyingContract?: Address;
  readonly stagePatchModuleAddress?: Address;
  readonly dockingModuleAddress?: Address;
  readonly now?: () => Date;
  readonly chainClock?: ChainClock;
  readonly prepareTtlSeconds?: number;
  readonly prepareIdFactory?: () => string;
  readonly submissionIdFactory?: () => string;
  readonly runtimeEnvironment?: ChainServicesRuntimeEnv;
}

export interface ProductStageExecutorPatchServiceOptions
  extends ProductStagePatchServiceOptions {
  readonly stageExecutorPatchStore: ProductStageExecutorPatchStore;
  readonly broadcastAdapter?: StageExecutorPatchBroadcastAdapter;
}

export interface ProductStageResourcePatchServiceOptions
  extends ProductStagePatchServiceOptions {
  readonly stageResourcePatchStore: ProductStageResourcePatchStore;
  readonly broadcastAdapter?: StageResourcePatchBroadcastAdapter;
}


export interface StagePatchProductBffPort {
  listRegistrations(): Promise<
    readonly {
      readonly orderId: string;
      readonly planId: string;
      readonly stateMachineAddress?: string;
      readonly draftId: string;
    }[]
  >;
  listParticipants(draftId: string): Promise<
    readonly {
      readonly status: string;
      readonly roleSlotId: string;
      readonly walletAddress?: string;
    }[]
  >;
}

export interface ProductStageExecutorPatchService {
  prepareStageExecutorPatch(
    taskId: string,
    input: PrepareProductStageExecutorPatchInput,
  ): Promise<PreparedStageExecutorPatchDTO>;
  submitStageExecutorPatch(
    taskId: string,
    input: SubmitProductStageExecutorPatchInput,
  ): Promise<StageExecutorPatchSubmissionDTO>;
  getStageExecutorPatchSubmission(
    submissionId: string,
  ): Promise<StageExecutorPatchSubmissionDTO | undefined>;
}

export interface ProductStageResourcePatchService {
  prepareStageResourcePatch(
    taskId: string,
    input: PrepareProductStageResourcePatchInput,
  ): Promise<PreparedStageResourcePatchDTO>;
  submitStageResourcePatch(
    taskId: string,
    input: SubmitProductStageResourcePatchInput,
  ): Promise<StageResourcePatchSubmissionDTO>;
  getStageResourcePatchSubmission(
    submissionId: string,
  ): Promise<StageResourcePatchSubmissionDTO | undefined>;
}


export function createProductStageExecutorPatchService(
  options: ProductStageExecutorPatchServiceOptions,
): ProductStageExecutorPatchService {
  const stageExecutorPatchStore = options.stageExecutorPatchStore;
  const now = options.now ?? (() => new Date());
  const ttlSeconds = options.prepareTtlSeconds ?? DEFAULT_PREPARE_TTL_SECONDS;
  const prepareIdFactory =
    options.prepareIdFactory ??
    (() => `stage_executor_patch_prep_${randomUUID()}`);
  const submissionIdFactory =
    options.submissionIdFactory ??
    (() => `stage_executor_patch_sub_${randomUUID()}`);
  const broadcastAdapter =
    options.broadcastAdapter ??
    notSupportedStageExecutorPatchBroadcastAdapter();

  return {
    async prepareStageExecutorPatch(taskId, input) {
      const context = await resolveSelectorPatchContext(options, taskId, {
        selectorWallet: input.selectorWallet,
        targetStageId: input.targetStageId,
        patchLabel: "stage executor patch",
        patchSignalId: EXECUTOR_PATCH_SIGNAL_ID,
        allowSubmittedTargetSignals: true,
      });
      const plan = await findProjectedPlan(options.store, context.order);
      const governance = resolveExecutorPatchGovernance(
        context.order,
        context.targetStageId,
        {
          ...(input.mode ? { mode: input.mode } : {}),
          ...(input.previousExecutorWallet
            ? { previousExecutor: input.previousExecutorWallet }
            : {}),
        },
        context.planSignalCapabilities,
      );
      const executorWallet = normalizeNonZeroAddress(
        input.executorWallet,
        "executorWallet",
      );
      assertExecutorInCandidateSet(
        plan,
        context.targetStageId,
        executorWallet,
        true,
      );
      const executorMetadataHash = normalizeNonZeroBytes32(
        input.executorMetadataHash ?? input.supplierReferenceHash,
        "executorMetadataHash",
      );
      const roleHash = input.roleHash
        ? normalizeNonZeroBytes32(input.roleHash, "roleHash")
        : context.targetStageId;
      const executorAuthorizations = executorAuthorizationsForTargetStage(
        plan,
        context.targetStageId,
        executorWallet,
        roleHash,
        executorMetadataHash,
      );
      const authorizationsHash = hashSignalAuthorizations(executorAuthorizations);
      const patchNonce = nextStageExecutorPatchNonce(
        context.order,
        context.targetStageId,
      );
      const metadataURI = normalizedMetadataURI(input.metadataURI);
      const patchHash = hashStageExecutorPatchPayload({
        orderId: context.order.orderId,
        selectorStageId: context.task.stageIdentifier,
        targetStageId: context.targetStageId,
        executor: executorWallet,
        role: roleHash,
        executorMetadataHash,
        mode: governance.modeHash,
        previousExecutor: governance.previousExecutorForPatch,
        authorizationsHash,
        patchNonce,
        metadataURI,
      });
      const createdAt = now();
      const deadlineSeconds =
        (await requireChainClockNowSeconds(options)) + ttlSeconds;
      const deadline = deadlineSeconds.toString();
      const chainId = requiredChainId(options.chainId);
      const stateMachineAddress = stateMachineAddressFor(context, options);
      const stagePatchModuleAddress = stagePatchModuleAddressFor(options);
      const typedData = buildStageExecutorPatchTypedData({
        chainId,
        verifyingContract: stagePatchModuleAddress,
        planId: context.order.planId,
        orderId: context.order.orderId,
        selectorStageId: context.task.stageIdentifier,
        targetStageId: context.targetStageId,
        executor: executorWallet,
        role: roleHash,
        executorMetadataHash,
        mode: governance.modeHash,
        previousExecutor: governance.previousExecutorForPatch,
        authorizationsHash,
        patchHash,
        patchNonce,
        metadataURI,
        selector: context.selectorWallet,
        deadline,
      });
      const prepareId = prepareIdFactory();
      const prepared: PreparedStageExecutorPatchRecord = {
        prepareId,
        taskId,
        orderId: context.order.orderId,
        onchainOrderId: context.order.orderId,
        stateMachineAddress,
        planId: context.order.planId,
        selectorStageId: context.task.stageIdentifier,
        targetStageId: context.targetStageId,
        selectorWallet: context.selectorWallet,
        executorWallet,
        mode: governance.mode,
        modeHash: governance.modeHash,
        ...(governance.previousExecutor
          ? { previousExecutor: governance.previousExecutor }
          : {}),
        executorAuthorizations,
        authorizationsHash,
        roleHash,
        executorMetadataHash,
        patchHash,
        patchNonce,
        metadataURI,
        deadline,
        expiresAt: new Date(deadlineSeconds * 1000).toISOString(),
        status: "prepared",
        typedData,
        humanSummary: {
          purpose: "UVP stage executor patch selector authorization",
          orderId: context.order.orderId,
          selectorTaskId: taskId,
          selectorStageId: context.task.stageIdentifier,
          targetStageId: context.targetStageId,
          executorWallet,
          mode: governance.mode,
          modeHash: governance.modeHash,
          ...(governance.previousExecutor
            ? { previousExecutor: governance.previousExecutor }
            : {}),
          authorizationsHash,
          patchHash,
          patchNonce,
          metadataURI,
          selectorWallet: context.selectorWallet,
          selectorSignatureStatus: "required",
          previousExecutorSignatureStatus:
            governance.mode === "handoff" ? "required" : "not_required",
          validUntil: new Date(deadlineSeconds * 1000).toISOString(),
          chainId,
          verifyingContract: stagePatchModuleAddress,
        },
        nonceKey: stagePatchNonceKey({
          kind: "executor",
          chainId,
          stateMachineAddress,
          orderId: context.order.orderId,
          targetStageId: context.targetStageId,
          patchNonce,
        }),
      };
      await stageExecutorPatchStore.deleteExpiredPrepared?.(
        String(Math.floor(now().getTime() / 1000)),
      );
      await stageExecutorPatchStore.putPrepared(prepared);
      return executorDtoFromPrepared(prepared);
    },

    async submitStageExecutorPatch(taskId, input) {
      const prepareId = prepareIdForSubmit(input, "stage executor patch");
      const prepared = await stageExecutorPatchStore.getPrepared(prepareId);
      if (!prepared) {
        throw new ProductStagePatchError(
          404,
          "prepare_not_found",
          "prepared stage executor patch was not found",
        );
      }
      validateSubmittedPreparedEnvelope(
        input,
        executorDtoFromPrepared(prepared),
        "stage executor patch",
      );
      validatePreparedForSubmit(
        prepared,
        taskId,
        input.selectorWallet,
        "stage executor patch",
      );

      const signature = normalizeSignature(input.signature);
      const recoveredSelector = await recoverExecutorSelector(
        prepared,
        signature,
      );
      if (recoveredSelector !== prepared.selectorWallet) {
        throw new ProductStagePatchError(
          400,
          "invalid_signature",
          "signature recovery did not match prepared selector",
          {
            recoveredSelector,
          },
        );
      }

      const currentSeconds = BigInt(Math.floor(now().getTime() / 1000));
      if (BigInt(prepared.deadline) < currentSeconds) {
        const submission = expiredExecutorSubmission(
          prepared,
          submissionIdFactory(),
          now().toISOString(),
        );
        await withStagePatchStoreTransaction(stageExecutorPatchStore, async () => {
          await stageExecutorPatchStore.putSubmission(submission);
          await stageExecutorPatchStore.markPreparedUsed(
            prepared.prepareId,
            submission.submissionId,
            submission.updatedAt,
          );
        });
        return submission;
      }

      const context = await resolveSelectorTaskContext(options.store, taskId);
      const plan = await findProjectedPlan(options.store, context.order);
      await ensureExecutorPreparedStillCurrent(
        options,
        context.order,
        prepared,
        plan,
      );
      const bindingProof = stagePatchBindingProofFromPlan(
        plan,
        prepared.selectorStageId,
        prepared.targetStageId,
      );
      const candidateProof = candidateProofForPrepared(
        plan,
        prepared.targetStageId,
        prepared.executorWallet,
      );

      const previousSignature = signatureForPreviousExecutor(
        prepared,
        input.previousExecutorSignature,
      );
      const recoveredPreviousExecutor = previousSignature
        ? await recoverExecutorPreviousExecutor(prepared, previousSignature)
        : undefined;
      if (
        previousSignature &&
        recoveredPreviousExecutor !== prepared.previousExecutor
      ) {
        throw new ProductStagePatchError(
          400,
          "invalid_previous_executor_signature",
          "previous executor signature recovery did not match prepared previous executor",
          { recoveredPreviousExecutor },
        );
      }
      const reserved = await reserveRelayNonce(stageExecutorPatchStore, prepared.nonceKey, {
        staleBefore: new Date(now().getTime() - ttlSeconds * 1000).toISOString(),
      });
      if (!reserved) {
        throw new ProductStagePatchError(
          409,
          "duplicate_stage_executor_patch_nonce",
          "stage executor patch nonce has already been used",
        );
      }

      let broadcastTxHash: Hex | undefined;
      let notAttempted = false;
      let submission: StageExecutorPatchSubmissionDTO;
      let broadcastSubmissionId: string | undefined;
      try {
        const broadcast = await broadcastAdapter.broadcast({
          prepared: executorDtoFromPrepared(prepared),
          signature,
          ...(previousSignature
            ? { previousExecutorSignature: previousSignature }
            : {}),
          recoveredSelector,
          ...(recoveredPreviousExecutor ? { recoveredPreviousExecutor } : {}),
          bindingProof,
          candidateProof,
          executorAuthorizations: prepared.executorAuthorizations,
        });
        broadcastTxHash = broadcast.status === "failed"
          ? broadcast.attempt?.txHash
          : broadcast.status === "not_attempted"
            ? undefined
            : broadcast.txHash;
        notAttempted = broadcast.status === "not_attempted";
        broadcastSubmissionId = submissionIdFactory();
        const timestamp = now().toISOString();
        submission = executorSubmissionFromBroadcast(prepared, {
          submissionId: broadcastSubmissionId,
          signatureHash: signatureHashFor(signature),
          ...(previousSignature
            ? {
              previousExecutorSignatureHash:
                signatureHashFor(previousSignature),
            }
            : {}),
          recoveredSelector,
          ...(recoveredPreviousExecutor ? { recoveredPreviousExecutor } : {}),
          broadcast,
          timestamp,
        });
        const reopenForRetry =
          broadcast.status === "failed" && !submission.txHash;
        await withStagePatchStoreTransaction(stageExecutorPatchStore, async () => {
          await stageExecutorPatchStore.putSubmission(submission);
          if (notAttempted || reopenForRetry) {
            await releaseRelayNonce(stageExecutorPatchStore, prepared.nonceKey);
            return;
          }
          await stageExecutorPatchStore.markPreparedUsed(
            prepared.prepareId,
            submission.submissionId,
            submission.updatedAt,
          );
        });
      } catch (error) {
        if (!broadcastTxHash || !broadcastSubmissionId) {
          await releaseRelayNonce(stageExecutorPatchStore, prepared.nonceKey);
          throw error;
        }
        try {
          await stageExecutorPatchStore.putSubmission(executorSubmissionFromBroadcast(prepared, {
            submissionId: broadcastSubmissionId,
            signatureHash: signatureHashFor(signature),
            ...(previousSignature
              ? { previousExecutorSignatureHash: signatureHashFor(previousSignature) }
              : {}),
            recoveredSelector,
            ...(recoveredPreviousExecutor ? { recoveredPreviousExecutor } : {}),
            broadcast: {
              status: "failed",
              txHash: broadcastTxHash,
              errorCode: "persist_failed",
              message: "broadcast succeeded but persisting the stage executor patch failed; the receipt is unknown and the nonce stays consumed",
              retryable: false
            },
            timestamp: now().toISOString()
          }));
        } catch {
        }
        throw error;
      }
      if (notAttempted) {
        throw new ProductStagePatchError(
          503,
          "broadcast_disabled",
          "stage executor patch relayer broadcast is not configured; the verified signature was recorded but the prepare and nonce were not consumed",
          { submissionId: submission.submissionId, retryable: true },
        );
      }
      return submission;
    },

    async getStageExecutorPatchSubmission(submissionId) {
      return stageExecutorPatchStore.getSubmission(submissionId);
    },
  };
}

export function createProductStageResourcePatchService(
  options: ProductStageResourcePatchServiceOptions,
): ProductStageResourcePatchService {
  const stageResourcePatchStore = options.stageResourcePatchStore;
  const now = options.now ?? (() => new Date());
  const ttlSeconds = options.prepareTtlSeconds ?? DEFAULT_PREPARE_TTL_SECONDS;
  const prepareIdFactory =
    options.prepareIdFactory ??
    (() => `stage_resource_patch_prep_${randomUUID()}`);
  const submissionIdFactory =
    options.submissionIdFactory ??
    (() => `stage_resource_patch_sub_${randomUUID()}`);
  const broadcastAdapter =
    options.broadcastAdapter ??
    notSupportedStageResourcePatchBroadcastAdapter();
  const runtimeEnvironment = options.runtimeEnvironment ?? "local";

  return {
    async prepareStageResourcePatch(taskId, input) {
      const context = await resolveSelectorPatchContext(options, taskId, {
        selectorWallet: input.selectorWallet,
        targetStageId: input.targetStageId,
        patchLabel: "stage resource patch",
        patchSignalId: RESOURCE_PATCH_SIGNAL_ID,
      });
      const resourceKey = normalizeResourceKey(input.resourceKey);
      const manifestHash = normalizeNonZeroBytes32(
        input.manifestHash,
        "manifestHash",
      );
      const policyHash = normalizeNonZeroBytes32(
        input.policyHash,
        "policyHash",
      );
      const manifestURI = normalizedManifestURI(
        input.manifestURI,
        runtimeEnvironment,
      );
      const patchNonce = nextStageResourcePatchNonce(
        context.order,
        context.targetStageId,
        resourceKey,
      );
      const patchHash = hashStageResourcePatchPayload({
        orderId: context.order.orderId,
        selectorStageId: context.task.stageIdentifier,
        targetStageId: context.targetStageId,
        resourceKey,
        manifestHash,
        policyHash,
        patchNonce,
        manifestURI,
      });
      const createdAt = now();
      const deadlineSeconds =
        (await requireChainClockNowSeconds(options)) + ttlSeconds;
      const deadline = deadlineSeconds.toString();
      const chainId = requiredChainId(options.chainId);
      const stateMachineAddress = stateMachineAddressFor(context, options);
      const stagePatchModuleAddress = stagePatchModuleAddressFor(options);
      const typedData = buildStageResourcePatchTypedData({
        chainId,
        verifyingContract: stagePatchModuleAddress,
        planId: context.order.planId,
        orderId: context.order.orderId,
        selectorStageId: context.task.stageIdentifier,
        targetStageId: context.targetStageId,
        resourceKey,
        manifestHash,
        policyHash,
        patchHash,
        patchNonce,
        manifestURI,
        selector: context.selectorWallet,
        deadline,
      });
      const prepareId = prepareIdFactory();
      const prepared: PreparedStageResourcePatchRecord = {
        prepareId,
        taskId,
        orderId: context.order.orderId,
        onchainOrderId: context.order.orderId,
        stateMachineAddress,
        planId: context.order.planId,
        selectorStageId: context.task.stageIdentifier,
        targetStageId: context.targetStageId,
        resourceKey,
        selectorWallet: context.selectorWallet,
        manifestHash,
        policyHash,
        patchHash,
        patchNonce,
        manifestURI,
        deadline,
        expiresAt: new Date(deadlineSeconds * 1000).toISOString(),
        status: "prepared",
        typedData,
        humanSummary: {
          purpose: "UVP stage resource patch selector authorization",
          orderId: context.order.orderId,
          selectorTaskId: taskId,
          selectorStageId: context.task.stageIdentifier,
          targetStageId: context.targetStageId,
          resourceKey,
          manifestHash,
          policyHash,
          patchHash,
          patchNonce,
          manifestURI,
          selectorWallet: context.selectorWallet,
          validUntil: new Date(deadlineSeconds * 1000).toISOString(),
          chainId,
          verifyingContract: stagePatchModuleAddress,
        },
        nonceKey: stagePatchNonceKey({
          kind: "resource",
          chainId,
          stateMachineAddress,
          orderId: context.order.orderId,
          targetStageId: context.targetStageId,
          resourceKey,
          patchNonce,
        }),
      };
      await stageResourcePatchStore.deleteExpiredPrepared?.(
        String(Math.floor(now().getTime() / 1000)),
      );
      await stageResourcePatchStore.putPrepared(prepared);
      return resourceDtoFromPrepared(prepared);
    },

    async submitStageResourcePatch(taskId, input) {
      const prepareId = prepareIdForSubmit(input, "stage resource patch");
      const prepared = await stageResourcePatchStore.getPrepared(prepareId);
      if (!prepared) {
        throw new ProductStagePatchError(
          404,
          "prepare_not_found",
          "prepared stage resource patch was not found",
        );
      }
      validateSubmittedPreparedEnvelope(
        input,
        resourceDtoFromPrepared(prepared),
        "stage resource patch",
      );
      validatePreparedForSubmit(
        prepared,
        taskId,
        input.selectorWallet,
        "stage resource patch",
      );

      const signature = normalizeSignature(input.signature);
      const recoveredSelector = await recoverResourceSelector(
        prepared,
        signature,
      );
      if (recoveredSelector !== prepared.selectorWallet) {
        throw new ProductStagePatchError(
          400,
          "invalid_signature",
          "signature recovery did not match prepared selector",
          {
            recoveredSelector,
          },
        );
      }

      const currentSeconds = BigInt(Math.floor(now().getTime() / 1000));
      if (BigInt(prepared.deadline) < currentSeconds) {
        const submission = expiredResourceSubmission(
          prepared,
          submissionIdFactory(),
          now().toISOString(),
        );
        await withStagePatchStoreTransaction(stageResourcePatchStore, async () => {
          await stageResourcePatchStore.putSubmission(submission);
          await stageResourcePatchStore.markPreparedUsed(
            prepared.prepareId,
            submission.submissionId,
            submission.updatedAt,
          );
        });
        return submission;
      }

      const context = await resolveSelectorTaskContext(options.store, taskId);
      const plan = await findProjectedPlan(options.store, context.order);
      ensureResourcePreparedStillCurrent(
        context.order,
        prepared,
        plan?.signalCapabilities ?? [],
      );
      const bindingProof = stagePatchBindingProofFromPlan(
        plan,
        prepared.selectorStageId,
        prepared.targetStageId,
      );
      const reserved = await reserveRelayNonce(stageResourcePatchStore, prepared.nonceKey, {
        staleBefore: new Date(now().getTime() - ttlSeconds * 1000).toISOString(),
      });
      if (!reserved) {
        throw new ProductStagePatchError(
          409,
          "duplicate_stage_resource_patch_nonce",
          "stage resource patch nonce has already been used",
        );
      }

      let broadcastTxHash: Hex | undefined;
      let notAttempted = false;
      let submission: StageResourcePatchSubmissionDTO;
      let broadcastSubmissionId: string | undefined;
      try {
        const broadcast = await broadcastAdapter.broadcast({
          prepared: resourceDtoFromPrepared(prepared),
          signature,
          recoveredSelector,
          bindingProof,
        });
        broadcastTxHash = broadcast.status === "failed"
          ? broadcast.attempt?.txHash
          : broadcast.status === "not_attempted"
            ? undefined
            : broadcast.txHash;
        notAttempted = broadcast.status === "not_attempted";
        broadcastSubmissionId = submissionIdFactory();
        const timestamp = now().toISOString();
        submission = resourceSubmissionFromBroadcast(prepared, {
          submissionId: broadcastSubmissionId,
          signatureHash: signatureHashFor(signature),
          recoveredSelector,
          broadcast,
          timestamp,
        });
        const reopenForRetry =
          broadcast.status === "failed" && !submission.txHash;
        await withStagePatchStoreTransaction(stageResourcePatchStore, async () => {
          await stageResourcePatchStore.putSubmission(submission);
          if (notAttempted || reopenForRetry) {
            await releaseRelayNonce(stageResourcePatchStore, prepared.nonceKey);
            return;
          }
          await stageResourcePatchStore.markPreparedUsed(
            prepared.prepareId,
            submission.submissionId,
            submission.updatedAt,
          );
        });
      } catch (error) {
        if (!broadcastTxHash || !broadcastSubmissionId) {
          await releaseRelayNonce(stageResourcePatchStore, prepared.nonceKey);
          throw error;
        }
        try {
          await stageResourcePatchStore.putSubmission(resourceSubmissionFromBroadcast(prepared, {
            submissionId: broadcastSubmissionId,
            signatureHash: signatureHashFor(signature),
            recoveredSelector,
            broadcast: {
              status: "failed",
              txHash: broadcastTxHash,
              errorCode: "persist_failed",
              message: "broadcast succeeded but persisting the stage resource patch failed; the receipt is unknown and the nonce stays consumed",
              retryable: false
            },
            timestamp: now().toISOString()
          }));
        } catch {
        }
        throw error;
      }
      if (notAttempted) {
        throw new ProductStagePatchError(
          503,
          "broadcast_disabled",
          "stage resource patch relayer broadcast is not configured; the verified signature was recorded but the prepare and nonce were not consumed",
          { submissionId: submission.submissionId, retryable: true },
        );
      }
      return submission;
    },

    async getStageResourcePatchSubmission(submissionId) {
      return stageResourcePatchStore.getSubmission(submissionId);
    },
  };
}


interface SelectorTaskContext {
  readonly task: StateMachineTaskProjection;
  readonly order: StateMachineOrderProjection;
}

interface SelectorPatchContext extends SelectorTaskContext {
  readonly selectorWallet: Address;
  readonly targetStageId: Hex;
  readonly planSignalCapabilities: readonly StateMachineSignalCapabilityProjection[];
}

async function withStagePatchStoreTransaction(
  store: ProductStagePatchStore<PreparedPatchRecordBase, StagePatchSubmissionBase>,
  operation: () => Promise<void>
): Promise<void> {
  return store.withTransaction ? store.withTransaction(operation) : operation();
}

async function resolveSelectorPatchContext(
  options: ProductStagePatchServiceOptions,
  taskId: string,
  input: {
    readonly selectorWallet: string;
    readonly targetStageId: string;
    readonly patchLabel: string;
    readonly patchSignalId: Hex;
    readonly allowSubmittedTargetSignals?: boolean;
  },
): Promise<SelectorPatchContext> {
  const context = await resolveSelectorTaskContext(options.store, taskId);
  const selectorWallet = normalizeAddress(
    input.selectorWallet,
    "selectorWallet",
  );
  if (context.task.status !== "ready") {
    throw new ProductStagePatchError(
      409,
      "executor_patch_task_not_ready",
      `executor patch task is not ready for ${input.patchLabel}`,
      {
        taskStatus: context.task.status,
      },
    );
  }
  if (
    !(await isSelectorWalletAssignedToTask(options, context, selectorWallet))
  ) {
    throw new ProductStagePatchError(
      403,
      "selector_wallet_not_authorized",
      "selector wallet is not assigned to this task",
    );
  }

  const target = normalizeTargetStage(input.targetStageId);
  const planSignalCapabilities =
    (await findProjectedPlan(options.store, context.order))?.signalCapabilities ?? [];
  const binding = await findAllowedSelectorBinding(
    options.store,
    options.productSchemaResolver,
    context.order,
    {
      selectorStageId: context.task.stageIdentifier,
      targetStageId: target.stageId,
      targetStageInput: input.targetStageId,
    },
  );
  if (!binding) {
    throw new ProductStagePatchError(
      400,
      "invalid_target_stage",
      "target stage is not allowed by plan selector bindings",
      {
        selectorStageId: context.task.stageIdentifier,
        targetStageId: target.stageId,
      },
    );
  }
  ensureSelectorPatchSignalAuthorization(context.order, {
    selectorStageId: context.task.stageIdentifier,
    signalId: input.patchSignalId,
    selectorWallet,
    patchLabel: input.patchLabel,
  });
  if (
    !input.allowSubmittedTargetSignals &&
    hasSubmittedTargetSignal(context.order, target.stageId, planSignalCapabilities)
  ) {
    throw new ProductStagePatchError(
      409,
      "target_stage_locked",
      "target stage already has a submitted signal",
    );
  }

  return {
    ...context,
    selectorWallet,
    targetStageId: target.stageId,
    planSignalCapabilities,
  };
}

async function isSelectorWalletAssignedToTask(
  options: ProductStagePatchServiceOptions,
  context: SelectorTaskContext,
  selectorWallet: Address,
): Promise<boolean> {
  if (context.task.assigneeWallet) {
    return (
      context.task.assigneeWallet.toLowerCase() === selectorWallet.toLowerCase()
    );
  }

  const productStore = options.productBffStore;
  if (!productStore) {
    return false;
  }
  const plan = await findProjectedPlan(options.store, context.order);
  const schema = await findProductSchema(
    options.productSchemaResolver,
    context.order,
    plan,
  );
  if (!schema) {
    return false;
  }
  const registration = (await productStore.listRegistrations()).find(
    (record) =>
      record.orderId.toLowerCase() === context.order.orderId.toLowerCase() &&
      record.planId.toLowerCase() === context.order.planId.toLowerCase() &&
      (!record.stateMachineAddress ||
        record.stateMachineAddress.toLowerCase() ===
          context.order.contractAddress.toLowerCase()),
  );
  if (!registration) {
    return false;
  }
  const participants = await productStore.listParticipants(
    registration.draftId,
  );
  return participants.some(
    (participant) =>
      participant.status === "accepted" &&
      participant.walletAddress?.toLowerCase() === selectorWallet.toLowerCase(),
  );
}

function schemaStageMatchesProjectedStage(
  schemaStageId: string,
  projectedStageId: Hex,
): boolean {
  const normalizedProjected = projectedStageId.toLowerCase();
  if (schemaStageId.toLowerCase() === normalizedProjected) {
    return true;
  }
  const derivedStageId = /^0x[0-9a-fA-F]{64}$/.test(schemaStageId)
    ? normalizeBytes32(schemaStageId, "schema.stageId")
    : normalizeBytes32(onchainStageId(schemaStageId), "schema.stageId");
  return derivedStageId.toLowerCase() === normalizedProjected;
}

async function resolveSelectorTaskContext(
  store: ProjectionStore,
  taskId: string,
): Promise<SelectorTaskContext> {
  const task = await store.getStateMachineTask(taskId);
  if (!task) {
    throw new ProductStagePatchError(
      404,
      "product_task_not_found",
      "product task not found",
    );
  }
  const orders = await store.listStateMachineOrders();
  const order = orders.find(
    (item) =>
      item.orderId.toLowerCase() === task.orderId.toLowerCase() &&
      item.contractAddress.toLowerCase() ===
        task.stateMachineAddress.toLowerCase() &&
      Object.prototype.hasOwnProperty.call(item.tasks, task.taskId),
  );
  if (!order) {
    throw new ProductStagePatchError(
      404,
      "product_order_not_found",
      "state-machine order for task was not found",
    );
  }
  return { task, order };
}


async function findAllowedSelectorBinding(
  store: ProjectionStore,
  productSchemaResolver: ProductSchemaResolver | undefined,
  order: StateMachineOrderProjection,
  input: {
    readonly selectorStageId: Hex;
    readonly targetStageId: Hex;
    readonly targetStageInput: string;
  },
): Promise<StateMachineStageSelectorBindingProjection | undefined> {
  const plan = await findProjectedPlan(store, order);
  const planBinding = plan?.selectorBindings.find(
    (binding) =>
      binding.selectorStageId === input.selectorStageId &&
      bindingMatchesTarget(
        binding,
        input.targetStageId,
        input.targetStageInput,
      ),
  );
  if (planBinding) {
    return planBinding;
  }

  const schema = await findProductSchema(productSchemaResolver, order, plan);
  return selectorBindingsFromProductSchema(schema).find(
    (binding) =>
      binding.selectorStageId === input.selectorStageId &&
      bindingMatchesTarget(
        binding,
        input.targetStageId,
        input.targetStageInput,
      ),
  );
}

async function findProjectedPlan(
  store: ProjectionStore,
  order: StateMachineOrderProjection,
): Promise<StateMachinePlanProjection | undefined> {
  const snapshot = await store.getOrderSnapshot?.();
  if (!snapshot) {
    return undefined;
  }
  return Object.values(snapshot.stateMachinePlans).find(
    (plan) =>
      plan.planId === order.planId &&
      plan.stateMachineAddress.toLowerCase() ===
        order.contractAddress.toLowerCase(),
  );
}

function stagePatchBindingProofFromPlan(
  plan: StateMachinePlanProjection | undefined,
  selectorStageId: Hex,
  targetStageId: Hex,
): SelectorBindingPayload {
  const tables: PlanCapabilityTables = {
    selectorBindings: plan?.selectorBindings ?? [],
    signalCapabilities: plan?.signalCapabilities ?? [],
  };
  const bindingProof = selectorBindingProofForPatch(
    tables,
    selectorStageId,
    targetStageId,
  );
  if (!bindingProof) {
    throw new ProductStagePatchError(
      409,
      "stage_patch_capability_tables_unavailable",
      "plan capability vocabulary is unavailable in the projection; the stage patch cannot carry the required binding proof",
      { planId: plan?.planId, selectorStageId, targetStageId },
    );
  }
  return bindingProof;
}

function candidateProofForPrepared(
  plan: StateMachinePlanProjection | undefined,
  targetStageId: Hex,
  executorWallet: Address,
): readonly Hex[] {
  assertExecutorInCandidateSet(plan, targetStageId, executorWallet, true);
  const proof = executorCandidateProofFor(
    plan?.executorCandidates ?? [],
    targetStageId,
    executorWallet,
  );
  if (!proof) {
    throw new ProductStagePatchError(
      409,
      "executor_not_in_candidate_set",
      "the patch executor is not a member of the plan's committed executor candidate set for the target stage",
      { planId: plan?.planId, targetStageId, executorWallet },
    );
  }
  return proof;
}

function assertExecutorInCandidateSet(
  plan: StateMachinePlanProjection | undefined,
  targetStageId: Hex,
  executorWallet: Address,
  failOnMissingList: boolean,
): void {
  const candidates = plan?.executorCandidates ?? [];
  if (candidates.length === 0) {
    if (!failOnMissingList) {
      return;
    }
    throw new ProductStagePatchError(
      409,
      "executor_candidate_set_unavailable",
      "the plan's executor candidate list is unavailable in the projection (not carried by the compiled artifact or not committed on chain); executor patches for this plan would revert on chain",
      { planId: plan?.planId, targetStageId },
    );
  }
  const inSet = executorCandidateProofFor(
    candidates,
    targetStageId,
    executorWallet,
  ) !== undefined;
  if (!inSet) {
    throw new ProductStagePatchError(
      409,
      "executor_not_in_candidate_set",
      "the patch executor is not a member of the plan's committed executor candidate set for the target stage",
      { planId: plan?.planId, targetStageId, executorWallet },
    );
  }
}

function executorAuthorizationsForTargetStage(
  plan: StateMachinePlanProjection | undefined,
  targetStageId: Hex,
  executorWallet: Address,
  roleHash: Hex,
  executorMetadataHash: Hex,
): readonly SignalAuthorizationPayload[] {
  const normalizedTarget = targetStageId.toLowerCase();
  const facts = (plan?.signalCapabilities ?? []).filter(
    (capability) =>
      capability.stageId.toLowerCase() === normalizedTarget &&
      capability.targetOrderRelation === "current",
  );
  return facts.map((fact) => ({
    sourceId: fact.targetSourceId,
    signalId: fact.signalId,
    submitter: executorWallet,
    role: roleHash,
    metadataHash: executorMetadataHash,
  }));
}

async function findProductSchema(
  productSchemaResolver: ProductSchemaResolver | undefined,
  order: StateMachineOrderProjection,
  plan: StateMachinePlanProjection | undefined,
): Promise<StoreProductSchemaDTO | undefined> {
  const planHash = order.planHash ?? plan?.planHash;
  if (!productSchemaResolver || !planHash) {
    return undefined;
  }
  return productSchemaResolver.getProductSchemaByPlan(order.planId, planHash);
}

function selectorBindingsFromProductSchema(
  schema: StoreProductSchemaDTO | undefined,
): readonly StateMachineStageSelectorBindingProjection[] {
  if (!schema) {
    return [];
  }
  const record = schema as unknown as {
    readonly selectorBindings?: readonly unknown[];
    readonly selectedStageBindings?: readonly unknown[];
  };
  const rawBindings =
    record.selectorBindings ?? record.selectedStageBindings ?? [];
  return rawBindings.flatMap((binding) => selectorBindingFromUnknown(binding));
}

function selectorBindingFromUnknown(
  value: unknown,
): readonly StateMachineStageSelectorBindingProjection[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  const record = value as Record<string, unknown>;
  const selectorStageId = stringField(record, "selectorStageId");
  const targetStageId = stringField(record, "targetStageId");
  const selectorStageIdentifier = stringField(
    record,
    "selectorStageIdentifier",
  );
  const targetStageIdentifier = stringField(record, "targetStageIdentifier");
  if (!selectorStageId && !selectorStageIdentifier) {
    return [];
  }
  if (!targetStageId && !targetStageIdentifier) {
    return [];
  }
  const normalizedSelectorStageId = selectorStageId
    ? normalizeBytes32(selectorStageId, "selectorBinding.selectorStageId")
    : normalizeBytes32(
        onchainStageId(selectorStageIdentifier!),
        "selectorBinding.selectorStageIdentifier",
      );
  const normalizedTargetStageId = targetStageId
    ? normalizeBytes32(targetStageId, "selectorBinding.targetStageId")
    : normalizeBytes32(
        onchainStageId(targetStageIdentifier!),
        "selectorBinding.targetStageIdentifier",
      );
  const bindingHash = stringField(record, "bindingHash");
  return [
    {
      ...(selectorStageIdentifier ? { selectorStageIdentifier } : {}),
      ...(targetStageIdentifier ? { targetStageIdentifier } : {}),
      selectorStageId: normalizedSelectorStageId,
      targetStageId: normalizedTargetStageId,
      ...(bindingHash
        ? {
            bindingHash: normalizeBytes32(
              bindingHash,
              "selectorBinding.bindingHash",
            ),
          }
        : {}),
    },
  ];
}

function bindingMatchesTarget(
  binding: StateMachineStageSelectorBindingProjection,
  targetStageId: Hex,
  targetStageInput: string,
): boolean {
  return (
    binding.targetStageId === targetStageId ||
    binding.targetStageIdentifier === targetStageInput ||
    binding.targetStageIdentifier === targetStageInput.toLowerCase()
  );
}

function ensureSelectorPatchSignalAuthorization(
  order: StateMachineOrderProjection,
  input: {
    readonly selectorStageId: Hex;
    readonly signalId: Hex;
    readonly selectorWallet: Address;
    readonly patchLabel: string;
  },
): void {
  const authorized = Object.values(order.authorizations).some(
    (authorization) =>
      authorization.sourceId.toLowerCase() ===
        input.selectorStageId.toLowerCase() &&
      authorization.signalId.toLowerCase() === input.signalId.toLowerCase() &&
      authorization.submitter.toLowerCase() ===
        input.selectorWallet.toLowerCase(),
  );
  if (!authorized) {
    throw new ProductStagePatchError(
      403,
      "order_signal_authorization_missing",
      `selector wallet is not authorized on chain for ${input.patchLabel}`,
      {
        sourceId: input.selectorStageId,
        signalId: input.signalId,
        selectorWallet: input.selectorWallet,
      },
    );
  }
}

function normalizeTargetStage(value: string): { readonly stageId: Hex } {
  if (/^0x[0-9a-fA-F]{64}$/.test(value)) {
    return { stageId: normalizeBytes32(value, "targetStageId") };
  }
  if (value.trim().length === 0) {
    throw new ProductStagePatchError(
      400,
      "invalid_target_stage",
      "targetStageId must be a stage identifier or bytes32 id",
    );
  }
  return { stageId: normalizeBytes32(onchainStageId(value), "targetStageId") };
}

function normalizeResourceKey(value: string): Hex {
  if (/^0x[0-9a-fA-F]{64}$/.test(value)) {
    return normalizeBytes32(value, "resourceKey");
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new ProductStagePatchError(
      400,
      "invalid_body",
      "resourceKey must be a non-empty string or bytes32 id",
    );
  }
  return textHash(trimmed);
}

function normalizeOptionalBytes32(
  value: string | undefined,
  fieldName: string,
): Hex {
  if (!value || value.trim().length === 0) {
    return ZERO_BYTES32;
  }
  return normalizeBytes32(value, fieldName);
}


function normalizeNonZeroAddress(value: string, fieldName: string): Address {
  const address = normalizeAddress(value, fieldName);
  if (address === ZERO_ADDRESS) {
    throw new ProductStagePatchError(
      400,
      "invalid_body",
      `${fieldName} must not be zero`,
    );
  }
  return address;
}

function normalizeNonZeroBytes32(
  value: string | undefined,
  fieldName: string,
): Hex {
  if (!value) {
    throw new ProductStagePatchError(
      400,
      "invalid_body",
      `${fieldName} is required`,
    );
  }
  const hash = normalizeBytes32(value, fieldName);
  if (hash === ZERO_BYTES32) {
    throw new ProductStagePatchError(
      400,
      "invalid_body",
      `${fieldName} must not be zero`,
    );
  }
  return hash;
}

function normalizedMetadataURI(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new ProductStagePatchError(
      400,
      "invalid_body",
      "metadataURI must be a non-empty string",
    );
  }
  return trimmed;
}

function normalizedManifestURI(
  value: string,
  runtimeEnvironment: ChainServicesRuntimeEnv,
): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new ProductStagePatchError(
      400,
      "invalid_body",
      "manifestURI must be a non-empty string",
    );
  }
  if (
    runtimeEnvironment === "production" &&
    !isContentAddressedManifestReference(trimmed)
  ) {
    throw new ProductStagePatchError(
      400,
      "invalid_manifest_uri",
      "production resource patches must use encrypted content-addressed manifest references",
    );
  }
  return trimmed;
}

function isContentAddressedManifestReference(value: string): boolean {
  return /^(ipfs:\/\/|ar:\/\/)/i.test(value);
}

interface ExecutorPatchGovernance {
  readonly mode: StageExecutorPatchMode;
  readonly modeHash: Hex;
  readonly previousExecutor?: Address;
  readonly previousExecutorForPatch: Address;
}

function resolveExecutorPatchGovernance(
  order: StateMachineOrderProjection,
  targetStageId: Hex,
  input: {
    readonly mode?: string;
    readonly previousExecutor?: string;
  },
  planSignalCapabilities: readonly StateMachineSignalCapabilityProjection[],
): ExecutorPatchGovernance {
  const mode = normalizeExecutorPatchMode(input.mode);
  const modeHash = executorPatchModeHash(mode);
  const progress = targetStageProgress(order, targetStageId, planSignalCapabilities);
  if (mode === "assign") {
    if (progress.signalCount > 0) {
      throw new ProductStagePatchError(
        409,
        "target_stage_started_assign_rejected",
        "assign mode is only allowed before the target stage has submitted signals",
        { signalCount: progress.signalCount },
      );
    }
    rejectUnexpectedPreviousExecutor(input.previousExecutor, mode);
    return {
      mode,
      modeHash,
      previousExecutorForPatch: ZERO_ADDRESS,
    };
  }

  if (progress.signalCount === 0) {
    throw new ProductStagePatchError(
      409,
      "target_stage_not_started",
      `${mode} mode requires a target-stage signal first`,
    );
  }

  const previousExecutor = normalizeRequiredPreviousExecutor(
    input.previousExecutor,
    mode,
  );
  const expectedPreviousExecutor = expectedPreviousExecutorForPatch(
    order,
    targetStageId,
    progress,
  );
  if (expectedPreviousExecutor.kind === "ambiguous") {
    throw new ProductStagePatchError(
      409,
      "previous_executor_ambiguous",
      "the previous executor cannot be uniquely determined for the target stage: "
        + "signals tied at the same block carry different submitters, or the compiled-plan "
        + "capability facts and the source==stage fallback facts disagree on the latest "
        + "submitter. The chain reverts this shape with StagePreviousExecutorAmbiguous; "
        + "resubmit after the tie is broken on chain.",
      {
        targetStageId,
        signalCount: progress.signalCount,
        tieBlockNumber: expectedPreviousExecutor.tieBlockNumber?.toString(),
      },
    );
  }
  if (
    expectedPreviousExecutor.value &&
    previousExecutor !== expectedPreviousExecutor.value
  ) {
    throw new ProductStagePatchError(
      409,
      "previous_executor_mismatch",
      "previousExecutor must match the active overlay executor or last target-stage signal submitter",
      { expectedPreviousExecutor: expectedPreviousExecutor.value, previousExecutor },
    );
  }

  return {
    mode,
    modeHash,
    previousExecutor,
    previousExecutorForPatch: previousExecutor,
  };
}

function normalizeExecutorPatchMode(
  value: string | undefined,
): StageExecutorPatchMode {
  const normalized = (value ?? "assign").trim().toLowerCase();
  if (normalized === "assign" || normalized === "handoff") {
    return normalized;
  }
  throw new ProductStagePatchError(
    400,
    "invalid_executor_patch_mode",
    "mode must be assign or handoff",
  );
}

function rejectUnexpectedPreviousExecutor(
  value: string | undefined,
  mode: StageExecutorPatchMode,
): void {
  if (!value) {
    return;
  }
  const previousExecutor = normalizeAddress(value, "previousExecutor");
  if (previousExecutor !== ZERO_ADDRESS) {
    throw new ProductStagePatchError(
      400,
      "previous_executor_not_allowed",
      `previousExecutor is not used for ${mode} mode`,
    );
  }
}

function normalizeRequiredPreviousExecutor(
  value: string | undefined,
  mode: StageExecutorPatchMode,
): Address {
  if (!value) {
    throw new ProductStagePatchError(
      400,
      "previous_executor_required",
      `previousExecutor is required for ${mode} mode`,
    );
  }
  return normalizeNonZeroAddress(value, "previousExecutor");
}

function hasSubmittedTargetSignal(
  order: StateMachineOrderProjection,
  targetStageId: Hex,
  planSignalCapabilities: readonly StateMachineSignalCapabilityProjection[],
): boolean {
  return targetStageProgress(order, targetStageId, planSignalCapabilities).signalCount > 0;
}

interface TargetStageProgress {
  readonly signalCount: number;
  readonly lastSignalSubmitter?: Address;
  readonly lastSignalAmbiguous?: boolean;
  readonly lastSignalTieBlockNumber?: bigint;
}

function targetStageProgress(
  order: StateMachineOrderProjection,
  targetStageId: Hex,
  planSignalCapabilities: readonly StateMachineSignalCapabilityProjection[],
): TargetStageProgress {
  const normalizedTargetStageId = targetStageId.toLowerCase();
  const capabilityFacts = new Set(
    planSignalCapabilities
      .filter(
        (capability) =>
          capability.stageId.toLowerCase() === normalizedTargetStageId &&
          capability.targetOrderRelation === "current",
      )
      .map((capability) =>
        signalProjectionKey(capability.targetSourceId, capability.signalId),
      ),
  );
  const orderSignals = Object.values(order.signals);
  const capabilitySignals = orderSignals.filter((signal) =>
    capabilityFacts.has(signalProjectionKey(signal.sourceId, signal.signalId)),
  );
  const fallbackSignals = orderSignals.filter(
    (signal) => signal.sourceId.toLowerCase() === normalizedTargetStageId,
  );
  const countedFacts = new Set<string>(fallbackSignals.map((signal) =>
    signalProjectionKey(signal.sourceId, signal.signalId),
  ));
  for (const signal of capabilitySignals) {
    countedFacts.add(signalProjectionKey(signal.sourceId, signal.signalId));
  }
  if (countedFacts.size === 0) {
    return { signalCount: 0 };
  }

  const capabilityLatest = latestSubmitterByChainOrder(capabilitySignals);
  const fallbackLatest = latestSubmitterByChainOrder(fallbackSignals);
  const mergeLatest = (
    ambiguous: boolean,
    submitter?: Address,
    tieBlockNumber?: bigint,
  ): TargetStageProgress => ({
    signalCount: countedFacts.size,
    ...(submitter !== undefined ? { lastSignalSubmitter: submitter } : {}),
    ...(ambiguous
      ? {
          lastSignalAmbiguous: true,
          ...(tieBlockNumber !== undefined ? { lastSignalTieBlockNumber: tieBlockNumber } : {}),
        }
      : {}),
  });
  if (capabilitySignals.length > 0 && fallbackSignals.length > 0) {
    const crossFlowAmbiguous =
      capabilityLatest.submitter !== undefined &&
      fallbackLatest.submitter !== undefined &&
      capabilityLatest.submitter !== fallbackLatest.submitter;
    return mergeLatest(
      capabilityLatest.ambiguous ||
        fallbackLatest.ambiguous ||
        crossFlowAmbiguous,
      capabilityLatest.submitter ?? fallbackLatest.submitter,
      capabilityLatest.tieBlockNumber ?? fallbackLatest.tieBlockNumber,
    );
  }
  if (capabilitySignals.length > 0) {
    return mergeLatest(
      capabilityLatest.ambiguous,
      capabilityLatest.submitter,
      capabilityLatest.tieBlockNumber,
    );
  }
  return mergeLatest(false, fallbackLatest.submitter, fallbackLatest.tieBlockNumber);
}

function latestSubmitterByChainOrder(
  signals: readonly {
    readonly submitter: Address;
    readonly submittedAt: ProjectionProvenance;
  }[],
): {
  readonly submitter?: Address;
  readonly ambiguous: boolean;
  readonly tieBlockNumber?: bigint;
} {
  if (signals.length === 0) {
    return { ambiguous: false };
  }
  const ordered = [...signals].sort(compareSignalSubmissionOrder);
  const last = ordered[ordered.length - 1]!;
  const maxBlock = last.submittedAt.blockNumber;
  const submittersAtMaxBlock = new Set(
    ordered
      .filter((signal) => signal.submittedAt.blockNumber === maxBlock)
      .map((signal) => signal.submitter.toLowerCase()),
  );
  return {
    submitter: last.submitter,
    ambiguous: submittersAtMaxBlock.size > 1,
    ...(submittersAtMaxBlock.size > 1 ? { tieBlockNumber: maxBlock } : {}),
  };
}

type ExpectedPreviousExecutor =
  | { readonly kind: "resolved"; readonly value?: Address }
  | { readonly kind: "ambiguous"; readonly tieBlockNumber?: bigint };

function expectedPreviousExecutorForPatch(
  order: StateMachineOrderProjection,
  targetStageId: Hex,
  progress: TargetStageProgress,
): ExpectedPreviousExecutor {
  const overlay =
    order.stageExecutorOverlays[targetStageId.toLowerCase()];
  if (overlay) {
    return overlay.activeExecutorWallet === undefined
      ? { kind: "resolved" as const }
      : { kind: "resolved" as const, value: overlay.activeExecutorWallet };
  }
  if (progress.lastSignalAmbiguous) {
    return {
      kind: "ambiguous",
      ...(progress.lastSignalTieBlockNumber !== undefined
        ? { tieBlockNumber: progress.lastSignalTieBlockNumber }
        : {}),
    };
  }
  return progress.lastSignalSubmitter === undefined
    ? { kind: "resolved" as const }
    : { kind: "resolved" as const, value: progress.lastSignalSubmitter };
}

function compareSignalSubmissionOrder(
  left: {
    readonly submittedAt: {
      readonly chainId: number;
      readonly blockNumber: bigint;
      readonly transactionIndex?: number;
      readonly transactionHash: Hex;
      readonly logIndex: number;
    };
  },
  right: {
    readonly submittedAt: {
      readonly chainId: number;
      readonly blockNumber: bigint;
      readonly transactionIndex?: number;
      readonly transactionHash: Hex;
      readonly logIndex: number;
    };
  },
): number {
  return compareChainPointers(left.submittedAt, right.submittedAt);
}

function nextStageExecutorPatchNonce(
  order: StateMachineOrderProjection,
  targetStageId: Hex,
): string {
  const current =
    order.stageExecutorOverlays[targetStageId.toLowerCase()]?.patchNonce;
  return ((current ? BigInt(current) : 0n) + 1n).toString();
}

function nextStageResourcePatchNonce(
  order: StateMachineOrderProjection,
  targetStageId: Hex,
  resourceKey: Hex,
): string {
  const current =
    order.stageResourceOverlays[
      stageResourceOverlayProjectionKey(targetStageId, resourceKey)
    ]?.patchNonce;
  return ((current ? BigInt(current) : 0n) + 1n).toString();
}


async function ensureExecutorPreparedStillCurrent(
  options: ProductStagePatchServiceOptions,
  order: StateMachineOrderProjection,
  prepared: PreparedStageExecutorPatchRecord,
  plan: StateMachinePlanProjection | undefined,
): Promise<void> {
  const planSignalCapabilities = plan?.signalCapabilities ?? [];
  resolveExecutorPatchGovernance(order, prepared.targetStageId, {
    mode: prepared.mode,
    ...(prepared.previousExecutor
      ? { previousExecutor: prepared.previousExecutor }
      : {}),
  }, planSignalCapabilities);
  await assertTargetStageNotBirthStage(options, order, prepared.targetStageId, plan);
  assertExecutorInCandidateSet(
    plan,
    prepared.targetStageId,
    prepared.executorWallet,
    true,
  );
  const currentNonce =
    order.stageExecutorOverlays[prepared.targetStageId.toLowerCase()]
      ?.patchNonce;
  if (currentNonce && BigInt(currentNonce) >= BigInt(prepared.patchNonce)) {
    throw new ProductStagePatchError(
      409,
      "stale_stage_executor_patch_nonce",
      "prepared stage executor patch nonce is no longer current",
      {
        currentNonce,
        preparedNonce: prepared.patchNonce,
      },
    );
  }
}

async function assertTargetStageNotBirthStage(
  options: ProductStagePatchServiceOptions,
  order: StateMachineOrderProjection,
  targetStageId: Hex,
  plan: StateMachinePlanProjection | undefined,
): Promise<void> {
  const schema = await findProductSchema(
    options.productSchemaResolver,
    order,
    plan,
  );
  const artifact = (schema as
    | { readonly onchainHookPlanArtifact?: unknown }
    | undefined)?.onchainHookPlanArtifact as
    | {
        readonly schemaVersion?: unknown;
        readonly compiledHooks?: readonly {
          readonly stageId?: unknown;
          readonly stageIdentifier?: unknown;
          readonly orderTriggerKind?: unknown;
        }[];
      }
    | undefined;
  if (
    artifact &&
    artifact.schemaVersion !== ONCHAIN_HOOK_PLAN_SCHEMA_VERSION
  ) {
    throw new ConfigError(
      `product schema artifact carries schemaVersion ${String(artifact.schemaVersion)}; this consumer only interprets ${ONCHAIN_HOOK_PLAN_SCHEMA_VERSION}`
    );
  }
  const isBirthStage = (artifact?.compiledHooks ?? []).some((hook) =>
    (hook.orderTriggerKind === "mint" || hook.orderTriggerKind === "dock") &&
    hookStageMatchesTarget(hook, targetStageId));
  if (isBirthStage) {
    throw new ProductStagePatchError(
      409,
      "executor_patch_forbidden_on_birth_stage",
      "the target stage is a birth stage (mint/dock order trigger); its executor is immutable and the on-chain patch would revert",
      { targetStageId },
    );
  }
}

function hookStageMatchesTarget(
  hook: { readonly stageId?: unknown; readonly stageIdentifier?: unknown },
  targetStageId: Hex
): boolean {
  const target = targetStageId.toLowerCase();
  if (typeof hook.stageId === "string" && hook.stageId.toLowerCase() === target) {
    return true;
  }
  if (typeof hook.stageIdentifier === "string") {
    const padded = identifierPaddedBytes32(hook.stageIdentifier);
    if (padded && padded === target) {
      return true;
    }
  }
  return false;
}

function identifierPaddedBytes32(identifier: string): Hex | undefined {
  const bytes = new TextEncoder().encode(identifier);
  if (bytes.length > 32) {
    return undefined;
  }
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `0x${hex.padEnd(64, "0")}` as Hex;
}


function ensureResourcePreparedStillCurrent(
  order: StateMachineOrderProjection,
  prepared: PreparedStageResourcePatchRecord,
  planSignalCapabilities: readonly StateMachineSignalCapabilityProjection[],
): void {
  if (
    hasSubmittedTargetSignal(order, prepared.targetStageId, planSignalCapabilities)
  ) {
    throw new ProductStagePatchError(
      409,
      "target_stage_locked",
      "target stage already has a submitted signal",
    );
  }
  const currentNonce =
    order.stageResourceOverlays[
      stageResourceOverlayProjectionKey(
        prepared.targetStageId,
        prepared.resourceKey,
      )
    ]?.patchNonce;
  if (currentNonce && BigInt(currentNonce) >= BigInt(prepared.patchNonce)) {
    throw new ProductStagePatchError(
      409,
      "stale_stage_resource_patch_nonce",
      "prepared stage resource patch nonce is no longer current",
      {
        currentNonce,
        preparedNonce: prepared.patchNonce,
      },
    );
  }
}

function stateMachineAddressFor(
  context: SelectorTaskContext,
  options: ProductStagePatchServiceOptions,
): Address {
  const stateMachineAddress = normalizeAddress(
    context.task.stateMachineAddress ||
      context.order.contractAddress ||
      options.verifyingContract ||
      ZERO_ADDRESS,
    "stateMachineAddress",
  );
  if (stateMachineAddress === ZERO_ADDRESS) {
    throw new ProductStagePatchError(
      409,
      "state_machine_address_missing",
      "state machine address is required for stage patch typed data",
    );
  }
  return stateMachineAddress;
}

function stagePatchModuleAddressFor(
  options: ProductStagePatchServiceOptions,
): Address {
  return moduleAddressFor(options.stagePatchModuleAddress, "stagePatchModuleAddress");
}

function dockingModuleAddressFor(
  options: ProductStagePatchServiceOptions,
): Address {
  return moduleAddressFor(options.dockingModuleAddress, "dockingModuleAddress");
}

function moduleAddressFor(
  configured: Address | undefined,
  label: string
): Address {
  if (!configured) {
    throw new ProductStagePatchError(
      409,
      "module_address_missing",
      `${label} is required for stage patch typed data`,
    );
  }
  return normalizeAddress(configured, label);
}

function requiredChainId(configured: number | undefined): number {
  if (configured === undefined) {
    throw new ProductStagePatchError(
      409,
      "chain_id_missing",
      "chainId is required for stage patch typed data",
    );
  }
  return configured;
}

function stageResourceOverlayProjectionKey(
  targetStageId: Hex,
  resourceKey: Hex,
): string {
  return `${targetStageId.toLowerCase()}:${resourceKey.toLowerCase()}`;
}

function validatePreparedForSubmit(
  prepared: {
    readonly taskId: string;
    readonly usedAt?: string;
    readonly submissionId?: string;
    readonly selectorWallet: Address;
  },
  taskId: string,
  selectorWalletInput: string,
  patchLabel: string,
): void {
  if (prepared.taskId !== taskId) {
    throw new ProductStagePatchError(
      409,
      "prepare_task_mismatch",
      `prepared ${patchLabel} belongs to a different task`,
    );
  }
  if (prepared.usedAt || prepared.submissionId) {
    throw new ProductStagePatchError(
      409,
      "prepare_already_used",
      `prepared ${patchLabel} has already been used`,
      {
        submissionId: prepared.submissionId,
      },
    );
  }
  const selectorWallet = normalizeAddress(
    selectorWalletInput,
    "selectorWallet",
  );
  if (selectorWallet !== prepared.selectorWallet) {
    throw new ProductStagePatchError(
      400,
      "wallet_mismatch",
      "selectorWallet does not match prepared selector",
    );
  }
}

function prepareIdForSubmit(
  input: {
    readonly prepareId?: string;
    readonly patch?: { readonly prepareId?: string };
  },
  patchLabel: string,
): string {
  if (input.prepareId && input.prepareId.trim().length > 0) {
    return input.prepareId.trim();
  }
  if (input.patch?.prepareId && input.patch.prepareId.trim().length > 0) {
    return input.patch.prepareId.trim();
  }
  throw new ProductStagePatchError(
    400,
    "invalid_body",
    `${patchLabel} submit requires prepareId or prepared patch`,
  );
}

function validateSubmittedPreparedEnvelope<
  TPrepared extends
    | PreparedStageExecutorPatchDTO
    | PreparedStageResourcePatchDTO,
>(
  input: {
    readonly typedData?: unknown;
    readonly patch?: TPrepared;
  },
  prepared: TPrepared,
  patchLabel: string,
): void {
  if (
    input.patch !== undefined &&
    canonicalJson(input.patch) !== canonicalJson(prepared)
  ) {
    throw new ProductStagePatchError(
      400,
      "prepared_patch_mismatch",
      `submitted ${patchLabel} does not match the server-prepared patch`,
    );
  }
  if (
    input.typedData !== undefined &&
    canonicalJson(input.typedData) !== canonicalJson(prepared.typedData)
  ) {
    throw new ProductStagePatchError(
      400,
      "typed_data_mismatch",
      `submitted typedData does not match the prepared ${patchLabel}`,
    );
  }
}

async function recoverExecutorSelector(
  prepared: PreparedStageExecutorPatchRecord,
  signature: Hex,
): Promise<Address> {
  try {
    return await recoverStageExecutorPatchSigner(prepared.typedData, signature);
  } catch (error) {
    throw new ProductStagePatchError(
      400,
      "invalid_signature",
      error instanceof Error ? error.message : "invalid signature",
    );
  }
}

function signatureForPreviousExecutor(
  prepared: PreparedStageExecutorPatchRecord,
  signatureInput: string | undefined,
): Hex | undefined {
  if (prepared.mode !== "handoff") {
    if (signatureInput) {
      throw new ProductStagePatchError(
        400,
        "previous_executor_signature_not_allowed",
        "previousExecutorSignature is only accepted in handoff mode; remove it or re-prepare with mode=handoff",
        { mode: prepared.mode },
      );
    }
    return undefined;
  }
  if (!signatureInput) {
    throw new ProductStagePatchError(
      400,
      "previous_executor_signature_required",
      "handoff mode requires previousExecutorSignature",
    );
  }
  return normalizeSignature(signatureInput);
}

async function recoverExecutorPreviousExecutor(
  prepared: PreparedStageExecutorPatchRecord,
  signature: Hex,
): Promise<Address> {
  try {
    return await recoverStageExecutorPatchSigner(prepared.typedData, signature);
  } catch (error) {
    throw new ProductStagePatchError(
      400,
      "invalid_previous_executor_signature",
      error instanceof Error
        ? error.message
        : "invalid previous executor signature",
    );
  }
}

async function recoverResourceSelector(
  prepared: PreparedStageResourcePatchRecord,
  signature: Hex,
): Promise<Address> {
  try {
    return await recoverStageResourcePatchSigner(prepared.typedData, signature);
  } catch (error) {
    throw new ProductStagePatchError(
      400,
      "invalid_signature",
      error instanceof Error ? error.message : "invalid signature",
    );
  }
}


function executorDtoFromPrepared(
  record: PreparedStageExecutorPatchRecord,
): PreparedStageExecutorPatchDTO {
  const {
    nonceKey: _nonceKey,
    usedAt: _usedAt,
    submissionId: _submissionId,
    ...dto
  } = record;
  return dto;
}

function resourceDtoFromPrepared(
  record: PreparedStageResourcePatchRecord,
): PreparedStageResourcePatchDTO {
  const {
    nonceKey: _nonceKey,
    usedAt: _usedAt,
    submissionId: _submissionId,
    ...dto
  } = record;
  return dto;
}

function expiredExecutorSubmission(
  prepared: PreparedStageExecutorPatchRecord,
  submissionId: string,
  timestamp: string,
): StageExecutorPatchSubmissionDTO {
  return {
    ...executorSubmissionCommon(prepared, {
      submissionId,
      createdAt: timestamp,
    }),
    status: "expired",
    signatureStatus: "signature_verified",
    selectorSignatureStatus: "signature_verified",
    previousExecutorSignatureStatus: previousExecutorSignatureStatus(
      prepared,
      false,
    ),
    broadcastStatus: "not_attempted",
    errorCode: "stage_executor_patch_expired",
    errorMessage: "prepared stage executor patch deadline has expired",
    retryable: false,
    proofRows: proofRows({
      label: "Stage executor patch status",
      status: "expired",
      selector: prepared.selectorWallet,
      executor: prepared.executorWallet,
      mode: prepared.mode,
      ...(prepared.previousExecutor
        ? { previousExecutor: prepared.previousExecutor }
        : {}),
      authorizationsHash: prepared.authorizationsHash,
      selectorSignatureStatus: "signature_verified",
      previousExecutorSignatureStatus: previousExecutorSignatureStatus(
        prepared,
        false,
      ),
      patchHash: prepared.patchHash,
      errorCode: "stage_executor_patch_expired",
    }),
  };
}

function expiredResourceSubmission(
  prepared: PreparedStageResourcePatchRecord,
  submissionId: string,
  timestamp: string,
): StageResourcePatchSubmissionDTO {
  return {
    ...resourceSubmissionCommon(prepared, {
      submissionId,
      createdAt: timestamp,
    }),
    status: "expired",
    signatureStatus: "signature_verified",
    broadcastStatus: "not_attempted",
    errorCode: "stage_resource_patch_expired",
    errorMessage: "prepared stage resource patch deadline has expired",
    retryable: false,
    proofRows: proofRows({
      label: "Stage resource patch status",
      status: "expired",
      selector: prepared.selectorWallet,
      patchHash: prepared.patchHash,
      errorCode: "stage_resource_patch_expired",
    }),
  };
}

function executorSubmissionFromBroadcast(
  prepared: PreparedStageExecutorPatchRecord,
  input: {
    readonly submissionId: string;
    readonly signatureHash: Hex;
    readonly previousExecutorSignatureHash?: Hex;
    readonly recoveredSelector: Address;
    readonly recoveredPreviousExecutor?: Address;
    readonly broadcast: StagePatchBroadcastResult;
    readonly timestamp: string;
  },
): StageExecutorPatchSubmissionDTO {
  const common = executorSubmissionCommon(prepared, {
    submissionId: input.submissionId,
    signatureHash: input.signatureHash,
    recoveredSelector: input.recoveredSelector,
    ...(input.previousExecutorSignatureHash
      ? { previousExecutorSignatureHash: input.previousExecutorSignatureHash }
      : {}),
    ...(input.recoveredPreviousExecutor
      ? { recoveredPreviousExecutor: input.recoveredPreviousExecutor }
      : {}),
    createdAt: input.timestamp,
  });
  return submissionFromBroadcastCommon(
    common,
    input.broadcast,
    "Stage executor patch status",
  );
}

function resourceSubmissionFromBroadcast(
  prepared: PreparedStageResourcePatchRecord,
  input: {
    readonly submissionId: string;
    readonly signatureHash: Hex;
    readonly recoveredSelector: Address;
    readonly broadcast: StagePatchBroadcastResult;
    readonly timestamp: string;
  },
): StageResourcePatchSubmissionDTO {
  const common = resourceSubmissionCommon(prepared, {
    submissionId: input.submissionId,
    signatureHash: input.signatureHash,
    recoveredSelector: input.recoveredSelector,
    createdAt: input.timestamp,
  });
  return submissionFromBroadcastCommon(
    common,
    input.broadcast,
    "Stage resource patch status",
  );
}

function submissionFromBroadcastCommon<
  TSubmission extends
    | StageExecutorPatchSubmissionDTO
    | StageResourcePatchSubmissionDTO,
>(
  common: Omit<
    TSubmission,
    "status" | "signatureStatus" | "broadcastStatus" | "retryable" | "proofRows"
  >,
  broadcast: StagePatchBroadcastResult,
  proofStatusLabel: string,
): TSubmission {
  if (broadcast.status === "submitted" || broadcast.status === "confirmed") {
    return {
      ...common,
      status: broadcast.status,
      signatureStatus: "signature_verified",
      broadcastStatus: broadcast.status,
      txHash: broadcast.txHash,
      ...(broadcast.blockNumber ? { blockNumber: broadcast.blockNumber } : {}),
      retryable: false,
      proofRows: proofRowsForCommon(common, {
        label: proofStatusLabel,
        status: broadcast.status,
        txHash: broadcast.txHash,
      }),
    } as TSubmission;
  }
  if (broadcast.status === "broadcasting") {
    return {
      ...common,
      status: "broadcasting",
      signatureStatus: "signature_verified",
      broadcastStatus: "broadcasting",
      ...(broadcast.txHash ? { txHash: broadcast.txHash } : {}),
      retryable: false,
      proofRows: proofRowsForCommon(common, {
        label: proofStatusLabel,
        status: "broadcasting",
        ...(broadcast.txHash ? { txHash: broadcast.txHash } : {}),
      }),
    } as TSubmission;
  }
  if (broadcast.status === "failed") {
    return {
      ...common,
      status: "failed",
      signatureStatus: "signature_verified",
      broadcastStatus: "failed",
      ...(broadcast.txHash ? { txHash: broadcast.txHash } : {}),
      ...(broadcast.blockNumber ? { blockNumber: broadcast.blockNumber } : {}),
      errorCode: broadcast.errorCode,
      errorMessage: broadcast.message,
      retryable: broadcast.retryable,
      proofRows: proofRowsForCommon(common, {
        label: proofStatusLabel,
        status: "failed",
        ...(broadcast.txHash ? { txHash: broadcast.txHash } : {}),
        errorCode: broadcast.errorCode,
      }),
    } as TSubmission;
  }
  return {
    ...common,
    status: "signature_received",
    signatureStatus: "signature_verified",
    broadcastStatus: "not_attempted",
    errorCode: broadcast.errorCode,
    errorMessage: broadcast.reason,
    retryable: false,
    proofRows: proofRowsForCommon(common, {
      label: proofStatusLabel,
      status: "signature_received",
      errorCode: broadcast.errorCode,
    }),
  } as TSubmission;
}

function executorSubmissionCommon(
  prepared: PreparedStageExecutorPatchRecord,
  input: {
    readonly submissionId: string;
    readonly signatureHash?: Hex;
    readonly previousExecutorSignatureHash?: Hex;
    readonly recoveredSelector?: Address;
    readonly recoveredPreviousExecutor?: Address;
    readonly createdAt: string;
  },
): Omit<
  StageExecutorPatchSubmissionDTO,
  "status" | "signatureStatus" | "broadcastStatus" | "retryable" | "proofRows"
> {
  return {
    submissionId: input.submissionId,
    prepareId: prepared.prepareId,
    taskId: prepared.taskId,
    orderId: prepared.orderId,
    onchainOrderId: prepared.onchainOrderId,
    stateMachineAddress: prepared.stateMachineAddress,
    planId: prepared.planId,
    selectorStageId: prepared.selectorStageId,
    targetStageId: prepared.targetStageId,
    selectorWallet: prepared.selectorWallet,
    executorWallet: prepared.executorWallet,
    mode: prepared.mode,
    modeHash: prepared.modeHash,
    ...(prepared.previousExecutor
      ? { previousExecutor: prepared.previousExecutor }
      : {}),
    executorAuthorizations: prepared.executorAuthorizations,
    authorizationsHash: prepared.authorizationsHash,
    roleHash: prepared.roleHash,
    executorMetadataHash: prepared.executorMetadataHash,
    patchHash: prepared.patchHash,
    patchNonce: prepared.patchNonce,
    metadataURI: prepared.metadataURI,
    deadline: prepared.deadline,
    selectorSignatureStatus: input.signatureHash
      ? "signature_verified"
      : "not_verified",
    previousExecutorSignatureStatus: previousExecutorSignatureStatus(
      prepared,
      Boolean(input.previousExecutorSignatureHash),
    ),
    ...(input.signatureHash ? { signatureHash: input.signatureHash } : {}),
    ...(input.previousExecutorSignatureHash
      ? { previousExecutorSignatureHash: input.previousExecutorSignatureHash }
      : {}),
    ...(input.recoveredSelector
      ? { recoveredSelector: input.recoveredSelector }
      : {}),
    ...(input.recoveredPreviousExecutor
      ? { recoveredPreviousExecutor: input.recoveredPreviousExecutor }
      : {}),
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

function resourceSubmissionCommon(
  prepared: PreparedStageResourcePatchRecord,
  input: {
    readonly submissionId: string;
    readonly signatureHash?: Hex;
    readonly recoveredSelector?: Address;
    readonly createdAt: string;
  },
): Omit<
  StageResourcePatchSubmissionDTO,
  "status" | "signatureStatus" | "broadcastStatus" | "retryable" | "proofRows"
> {
  return {
    submissionId: input.submissionId,
    prepareId: prepared.prepareId,
    taskId: prepared.taskId,
    orderId: prepared.orderId,
    onchainOrderId: prepared.onchainOrderId,
    stateMachineAddress: prepared.stateMachineAddress,
    planId: prepared.planId,
    selectorStageId: prepared.selectorStageId,
    targetStageId: prepared.targetStageId,
    resourceKey: prepared.resourceKey,
    selectorWallet: prepared.selectorWallet,
    manifestHash: prepared.manifestHash,
    policyHash: prepared.policyHash,
    patchHash: prepared.patchHash,
    patchNonce: prepared.patchNonce,
    manifestURI: prepared.manifestURI,
    deadline: prepared.deadline,
    ...(input.signatureHash ? { signatureHash: input.signatureHash } : {}),
    ...(input.recoveredSelector
      ? { recoveredSelector: input.recoveredSelector }
      : {}),
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

function previousExecutorSignatureStatus(
  prepared: PreparedStageExecutorPatchRecord,
  verified: boolean,
): PreviousExecutorSignatureStatus {
  if (prepared.mode !== "handoff") {
    return "not_required";
  }
  return verified ? "signature_verified" : "not_verified";
}

function proofRowsForCommon(
  common: {
    readonly selectorWallet: Address;
    readonly patchHash?: Hex;
    readonly linkHash?: Hex;
    readonly executorWallet?: Address;
    readonly mode?: StageExecutorPatchMode;
    readonly previousExecutor?: Address;
    readonly authorizationsHash?: Hex;
    readonly selectorSignatureStatus?: string;
    readonly previousExecutorSignatureStatus?: string;
  },
  input: {
    readonly label: string;
    readonly status: string;
    readonly txHash?: Hex;
    readonly errorCode?: string;
  },
): readonly { readonly label: string; readonly value: string }[] {
  return proofRows({
    label: input.label,
    status: input.status,
    selector: common.selectorWallet,
    ...(common.executorWallet ? { executor: common.executorWallet } : {}),
    ...(common.mode ? { mode: common.mode } : {}),
    ...(common.previousExecutor
      ? { previousExecutor: common.previousExecutor }
      : {}),
    ...(common.authorizationsHash
      ? { authorizationsHash: common.authorizationsHash }
      : {}),
    ...(common.selectorSignatureStatus
      ? { selectorSignatureStatus: common.selectorSignatureStatus }
      : {}),
    ...(common.previousExecutorSignatureStatus
      ? {
          previousExecutorSignatureStatus:
            common.previousExecutorSignatureStatus,
        }
      : {}),
    patchHash: common.patchHash ?? common.linkHash ?? ZERO_BYTES32,
    ...(input.txHash ? { txHash: input.txHash } : {}),
    ...(input.errorCode ? { errorCode: input.errorCode } : {}),
  });
}

function proofRows(input: {
  readonly label: string;
  readonly status: string;
  readonly selector: Address;
  readonly executor?: Address;
  readonly mode?: StageExecutorPatchMode;
  readonly previousExecutor?: Address;
  readonly authorizationsHash?: Hex;
  readonly selectorSignatureStatus?: string;
  readonly previousExecutorSignatureStatus?: string;
  readonly patchHash: Hex;
  readonly txHash?: Hex;
  readonly errorCode?: string;
}): readonly { readonly label: string; readonly value: string }[] {
  return [
    { label: input.label, value: input.status },
    ...(input.mode ? [{ label: "Mode", value: input.mode }] : []),
    { label: "Selector", value: input.selector },
    ...(input.executor
      ? [{ label: "New executor", value: input.executor }]
      : []),
    ...(input.previousExecutor
      ? [{ label: "Previous executor", value: input.previousExecutor }]
      : []),
    ...(input.authorizationsHash
      ? [{ label: "Authorizations hash", value: input.authorizationsHash }]
      : []),
    ...(input.selectorSignatureStatus
      ? [{ label: "Selector signature", value: input.selectorSignatureStatus }]
      : []),
    ...(input.previousExecutorSignatureStatus
      ? [
          {
            label: "Previous executor signature",
            value: input.previousExecutorSignatureStatus,
          },
        ]
      : []),
    { label: "Patch hash", value: input.patchHash },
    ...(input.txHash ? [{ label: "Transaction", value: input.txHash }] : []),
    ...(input.errorCode ? [{ label: "Error", value: input.errorCode }] : []),
  ];
}

function stringField(
  record: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = record[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function normalizeStagePatchServiceError(
  error: unknown,
): ProductStagePatchError {
  if (error instanceof ProductStagePatchError) {
    return error;
  }
  if (error instanceof ConfigError) {
    return new ProductStagePatchError(400, "invalid_body", error.message);
  }
  return new ProductStagePatchError(
    500,
    "stage_patch_failed",
    error instanceof Error ? error.message : "stage patch failed",
  );
}
