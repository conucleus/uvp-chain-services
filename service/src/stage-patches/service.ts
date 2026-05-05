import { randomUUID } from "node:crypto";
import { onchainStageId } from "@uvp-eth/compiler";
import type { StoreProductSchemaDTO } from "@uvp-eth/product-dto";
import type { ChainServicesRuntimeEnv } from "../config/index.js";
import { ConfigError, normalizeAddress, normalizeBytes32, type Address, type Hex } from "../shared/types.js";
import type {
  StateMachineOrderProjection,
  StateMachinePlanProjection,
  StateMachineStageSelectorBindingProjection,
  StateMachineTaskProjection
} from "../indexer/projections.js";
import type { ProjectionStore } from "../storage/projection-store.js";
import type { ProductSchemaResolver } from "../product/service.js";
import type { ProductBffStore } from "../product/bff/store.js";
import { InMemoryProductStagePatchStore } from "./store.js";
import {
  buildDockedOrderLinkTypedData,
  buildStageExecutorPatchTypedData,
  buildStageResourcePatchTypedData,
  executorPatchModeHash,
  hashDockedOrderLinkPayload,
  hashStageExecutorPatchPayload,
  hashStageResourcePatchPayload,
  normalizeSignature,
  recoverDockedOrderLinkSigner,
  recoverStageExecutorPatchSigner,
  recoverStageResourcePatchSigner,
  signatureHashFor,
  textHash
} from "./typed-data.js";
import {
  notSupportedDockedOrderLinkBroadcastAdapter,
  notSupportedStageExecutorPatchBroadcastAdapter,
  notSupportedStageResourcePatchBroadcastAdapter
} from "./broadcast-adapter.js";
import type {
  DockedOrderLinkBroadcastAdapter,
  DockedOrderLinkSubmissionDTO,
  DockedSignalBindingDTO,
  PrepareProductDockedOrderLinkInput,
  PrepareProductStageExecutorPatchInput,
  PrepareProductStageResourcePatchInput,
  PreparedDockedOrderLinkDTO,
  PreparedDockedOrderLinkRecord,
  PreparedStageExecutorPatchDTO,
  PreparedStageExecutorPatchRecord,
  PreparedStageResourcePatchDTO,
  PreparedStageResourcePatchRecord,
  ProductDockedOrderLinkStore,
  ProductStageExecutorPatchStore,
  ProductStageResourcePatchStore,
  StageExecutorPatchMode,
  StageExecutorPatchBroadcastAdapter,
  StageExecutorPatchSubmissionDTO,
  PreviousExecutorSignatureStatus,
  StagePatchBroadcastResult,
  StageResourcePatchBroadcastAdapter,
  StageResourcePatchSubmissionDTO,
  SubmitProductDockedOrderLinkInput,
  SubmitProductStageExecutorPatchInput,
  SubmitProductStageResourcePatchInput
} from "./types.js";

const DEFAULT_PREPARE_TTL_SECONDS = 10 * 60;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000" as const;
export const STAGE_EXECUTOR_PATCH_SIGNAL_ID = "0xbbb1770c9313f4029a89e03f4719037cdad52864ab4da5f623bc7c8a0c489e97" as const;
export const STAGE_RESOURCE_PATCH_SIGNAL_ID = "0x6dff331f2bb7b785cbcd99a911e6d30dc8714f43b3b9ba80c658215445ddd0ba" as const;
export const DOCKED_ORDER_LINK_SIGNAL_ID = "0x52b1d5b596f048e1b5e95de9dbd94755a086b00efb351fbd7810a9afc9ce1e83" as const;
const EXECUTOR_PATCH_SIGNAL_ID = STAGE_EXECUTOR_PATCH_SIGNAL_ID;
const RESOURCE_PATCH_SIGNAL_ID = STAGE_RESOURCE_PATCH_SIGNAL_ID;

export class ProductStagePatchError extends Error {
  override readonly name = "ProductStagePatchError";

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
  }
}

export interface ProductStagePatchServiceOptions {
  readonly store: ProjectionStore;
  readonly productSchemaResolver?: ProductSchemaResolver;
  readonly productBffStore?: ProductBffStore;
  readonly chainId?: number;
  readonly verifyingContract?: Address;
  readonly stagePatchModuleAddress?: Address;
  readonly dockingModuleAddress?: Address;
  readonly now?: () => Date;
  readonly prepareTtlSeconds?: number;
  readonly prepareIdFactory?: () => string;
  readonly submissionIdFactory?: () => string;
  readonly runtimeEnvironment?: ChainServicesRuntimeEnv;
}

export interface ProductStageExecutorPatchServiceOptions extends ProductStagePatchServiceOptions {
  readonly stageExecutorPatchStore?: ProductStageExecutorPatchStore;
  readonly broadcastAdapter?: StageExecutorPatchBroadcastAdapter;
}

export interface ProductStageResourcePatchServiceOptions extends ProductStagePatchServiceOptions {
  readonly stageResourcePatchStore?: ProductStageResourcePatchStore;
  readonly broadcastAdapter?: StageResourcePatchBroadcastAdapter;
}

export interface ProductDockedOrderLinkServiceOptions extends ProductStagePatchServiceOptions {
  readonly dockedOrderLinkStore?: ProductDockedOrderLinkStore;
  readonly broadcastAdapter?: DockedOrderLinkBroadcastAdapter;
}

export interface ProductStageExecutorPatchService {
  prepareStageExecutorPatch(
    taskId: string,
    input: PrepareProductStageExecutorPatchInput
  ): Promise<PreparedStageExecutorPatchDTO>;
  submitStageExecutorPatch(
    taskId: string,
    input: SubmitProductStageExecutorPatchInput
  ): Promise<StageExecutorPatchSubmissionDTO>;
  getStageExecutorPatchSubmission(submissionId: string): Promise<StageExecutorPatchSubmissionDTO | undefined>;
}

export interface ProductStageResourcePatchService {
  prepareStageResourcePatch(
    taskId: string,
    input: PrepareProductStageResourcePatchInput
  ): Promise<PreparedStageResourcePatchDTO>;
  submitStageResourcePatch(
    taskId: string,
    input: SubmitProductStageResourcePatchInput
  ): Promise<StageResourcePatchSubmissionDTO>;
  getStageResourcePatchSubmission(submissionId: string): Promise<StageResourcePatchSubmissionDTO | undefined>;
}

export interface ProductDockedOrderLinkService {
  prepareDockedOrderLink(
    taskId: string,
    input: PrepareProductDockedOrderLinkInput
  ): Promise<PreparedDockedOrderLinkDTO>;
  submitDockedOrderLink(
    taskId: string,
    input: SubmitProductDockedOrderLinkInput
  ): Promise<DockedOrderLinkSubmissionDTO>;
  getDockedOrderLinkSubmission(submissionId: string): Promise<DockedOrderLinkSubmissionDTO | undefined>;
}

export function createProductStageExecutorPatchService(
  options: ProductStageExecutorPatchServiceOptions
): ProductStageExecutorPatchService {
  const stageExecutorPatchStore = options.stageExecutorPatchStore ??
    new InMemoryProductStagePatchStore<PreparedStageExecutorPatchRecord, StageExecutorPatchSubmissionDTO>();
  const now = options.now ?? (() => new Date());
  const ttlSeconds = options.prepareTtlSeconds ?? DEFAULT_PREPARE_TTL_SECONDS;
  const prepareIdFactory = options.prepareIdFactory ?? (() => `stage_executor_patch_prep_${randomUUID()}`);
  const submissionIdFactory = options.submissionIdFactory ?? (() => `stage_executor_patch_sub_${randomUUID()}`);
  const broadcastAdapter = options.broadcastAdapter ?? notSupportedStageExecutorPatchBroadcastAdapter();
  const chainId = options.chainId ?? 31337;

  return {
    async prepareStageExecutorPatch(taskId, input) {
      const context = await resolveSelectorPatchContext(options, taskId, {
        selectorWallet: input.selectorWallet,
        targetStageId: input.targetStageId,
        patchLabel: "stage executor patch",
        patchSignalId: EXECUTOR_PATCH_SIGNAL_ID,
        allowSubmittedTargetSignals: true
      });
      const governance = resolveExecutorPatchGovernance(context.order, context.targetStageId, {
        ...(input.mode ? { mode: input.mode } : {}),
        ...(input.previousExecutorWallet ? { previousExecutor: input.previousExecutorWallet } : input.previousExecutor ? { previousExecutor: input.previousExecutor } : {}),
        ...(input.approvalSourceId ? { approvalSourceId: input.approvalSourceId } : {}),
        ...(input.approvalSignalId ? { approvalSignalId: input.approvalSignalId } : {})
      });
      const executorWallet = normalizeNonZeroAddress(input.executorWallet, "executorWallet");
      const executorMetadataHash = normalizeNonZeroBytes32(
        input.executorMetadataHash ?? input.supplierReferenceHash,
        "executorMetadataHash"
      );
      const roleHash = input.roleHash
        ? normalizeNonZeroBytes32(input.roleHash, "roleHash")
        : context.targetStageId;
      const patchNonce = nextStageExecutorPatchNonce(context.order, context.targetStageId);
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
        approvalSourceId: governance.approvalSourceIdForPatch,
        approvalSignalId: governance.approvalSignalIdForPatch,
        patchNonce,
        metadataURI
      });
      const createdAt = now();
      const deadlineSeconds = Math.floor(createdAt.getTime() / 1000) + ttlSeconds;
      const deadline = deadlineSeconds.toString();
      const stateMachineAddress = stateMachineAddressFor(context, options);
      const stagePatchModuleAddress = stagePatchModuleAddressFor(context, options);
      const typedData = buildStageExecutorPatchTypedData({
        chainId,
        verifyingContract: stagePatchModuleAddress,
        orderId: context.order.orderId,
        selectorStageId: context.task.stageIdentifier,
        targetStageId: context.targetStageId,
        executor: executorWallet,
        role: roleHash,
        executorMetadataHash,
        mode: governance.modeHash,
        previousExecutor: governance.previousExecutorForPatch,
        approvalSourceId: governance.approvalSourceIdForPatch,
        approvalSignalId: governance.approvalSignalIdForPatch,
        patchHash,
        patchNonce,
        metadataURI,
        selector: context.selectorWallet,
        deadline
      });
      const prepareId = prepareIdFactory();
      const prepared: PreparedStageExecutorPatchRecord = {
        prepareId,
        taskId,
        orderId: context.order.orderId,
        onchainOrderId: context.order.orderId,
        stateMachineAddress,
        selectorStageId: context.task.stageIdentifier,
        targetStageId: context.targetStageId,
        selectorWallet: context.selectorWallet,
        executorWallet,
        mode: governance.mode,
        modeHash: governance.modeHash,
        ...(governance.previousExecutor ? { previousExecutor: governance.previousExecutor } : {}),
        ...(governance.approvalSourceId ? { approvalSourceId: governance.approvalSourceId } : {}),
        ...(governance.approvalSignalId ? { approvalSignalId: governance.approvalSignalId } : {}),
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
          ...(governance.previousExecutor ? { previousExecutor: governance.previousExecutor } : {}),
          ...(governance.approvalSourceId ? { approvalSourceId: governance.approvalSourceId } : {}),
          ...(governance.approvalSignalId ? { approvalSignalId: governance.approvalSignalId } : {}),
          patchHash,
          patchNonce,
          metadataURI,
          selectorWallet: context.selectorWallet,
          selectorSignatureStatus: "required",
          previousExecutorSignatureStatus: governance.mode === "handoff" ? "required" : "not_required",
          validUntil: new Date(deadlineSeconds * 1000).toISOString(),
          chainId,
          verifyingContract: stagePatchModuleAddress
        },
        nonceKey: stagePatchNonceKey({
          kind: "executor",
          chainId,
          stateMachineAddress,
          orderId: context.order.orderId,
          targetStageId: context.targetStageId,
          patchNonce
        })
      };
      await stageExecutorPatchStore.putPrepared(prepared);
      return executorDtoFromPrepared(prepared);
    },

    async submitStageExecutorPatch(taskId, input) {
      const prepareId = prepareIdForSubmit(input, "stage executor patch");
      const prepared = await stageExecutorPatchStore.getPrepared(prepareId);
      if (!prepared) {
        throw new ProductStagePatchError(404, "prepare_not_found", "prepared stage executor patch was not found");
      }
      validateSubmittedPreparedEnvelope(input, executorDtoFromPrepared(prepared), "stage executor patch");
      validatePreparedForSubmit(prepared, taskId, input.selectorWallet, "stage executor patch");

      const currentSeconds = BigInt(Math.floor(now().getTime() / 1000));
      if (BigInt(prepared.deadline) < currentSeconds) {
        const submission = expiredExecutorSubmission(prepared, submissionIdFactory(), now().toISOString());
        await stageExecutorPatchStore.putSubmission(submission);
        await stageExecutorPatchStore.markPreparedUsed(prepared.prepareId, submission.submissionId, submission.updatedAt);
        return submission;
      }

      const context = await resolveSelectorTaskContext(options.store, taskId);
      ensureExecutorPreparedStillCurrent(context.order, prepared);

      const signature = normalizeSignature(input.signature);
      const recoveredSelector = await recoverExecutorSelector(prepared, signature);
      if (recoveredSelector !== prepared.selectorWallet) {
        throw new ProductStagePatchError(400, "invalid_signature", "signature recovery did not match prepared selector", {
          recoveredSelector
        });
      }
      const previousSignature = signatureForPreviousExecutor(prepared, input.previousExecutorSignature);
      const recoveredPreviousExecutor = previousSignature
        ? await recoverExecutorPreviousExecutor(prepared, previousSignature)
        : undefined;
      if (previousSignature && recoveredPreviousExecutor !== prepared.previousExecutor) {
        throw new ProductStagePatchError(
          400,
          "invalid_previous_executor_signature",
          "previous executor signature recovery did not match prepared previous executor",
          { recoveredPreviousExecutor }
        );
      }
      const reserved = await stageExecutorPatchStore.reserveNonce(prepared.nonceKey);
      if (!reserved) {
        throw new ProductStagePatchError(409, "duplicate_stage_executor_patch_nonce", "stage executor patch nonce has already been used");
      }

      const broadcast = await broadcastAdapter.broadcast({
        prepared: executorDtoFromPrepared(prepared),
        signature,
        ...(previousSignature ? { previousExecutorSignature: previousSignature } : {}),
        recoveredSelector,
        ...(recoveredPreviousExecutor ? { recoveredPreviousExecutor } : {})
      });
      const timestamp = now().toISOString();
      const submission = executorSubmissionFromBroadcast(prepared, {
        submissionId: submissionIdFactory(),
        signatureHash: signatureHashFor(signature),
        ...(previousSignature ? { previousExecutorSignatureHash: signatureHashFor(previousSignature) } : {}),
        recoveredSelector,
        ...(recoveredPreviousExecutor ? { recoveredPreviousExecutor } : {}),
        broadcast,
        timestamp
      });
      await stageExecutorPatchStore.putSubmission(submission);
      await stageExecutorPatchStore.markPreparedUsed(prepared.prepareId, submission.submissionId, submission.updatedAt);
      return submission;
    },

    async getStageExecutorPatchSubmission(submissionId) {
      return stageExecutorPatchStore.getSubmission(submissionId);
    }
  };
}

export function createProductStageResourcePatchService(
  options: ProductStageResourcePatchServiceOptions
): ProductStageResourcePatchService {
  const stageResourcePatchStore = options.stageResourcePatchStore ??
    new InMemoryProductStagePatchStore<PreparedStageResourcePatchRecord, StageResourcePatchSubmissionDTO>();
  const now = options.now ?? (() => new Date());
  const ttlSeconds = options.prepareTtlSeconds ?? DEFAULT_PREPARE_TTL_SECONDS;
  const prepareIdFactory = options.prepareIdFactory ?? (() => `stage_resource_patch_prep_${randomUUID()}`);
  const submissionIdFactory = options.submissionIdFactory ?? (() => `stage_resource_patch_sub_${randomUUID()}`);
  const broadcastAdapter = options.broadcastAdapter ?? notSupportedStageResourcePatchBroadcastAdapter();
  const chainId = options.chainId ?? 31337;
  const runtimeEnvironment = options.runtimeEnvironment ?? "local";

  return {
    async prepareStageResourcePatch(taskId, input) {
      const context = await resolveSelectorPatchContext(options, taskId, {
        selectorWallet: input.selectorWallet,
        targetStageId: input.targetStageId,
        patchLabel: "stage resource patch",
        patchSignalId: RESOURCE_PATCH_SIGNAL_ID
      });
      const resourceKey = normalizeResourceKey(input.resourceKey);
      const manifestHash = normalizeNonZeroBytes32(input.manifestHash, "manifestHash");
      const policyHash = normalizeNonZeroBytes32(input.policyHash, "policyHash");
      const manifestURI = normalizedManifestURI(input.manifestURI, runtimeEnvironment);
      const patchNonce = nextStageResourcePatchNonce(context.order, context.targetStageId, resourceKey);
      const patchHash = hashStageResourcePatchPayload({
        orderId: context.order.orderId,
        selectorStageId: context.task.stageIdentifier,
        targetStageId: context.targetStageId,
        resourceKey,
        manifestHash,
        policyHash,
        patchNonce,
        manifestURI
      });
      const createdAt = now();
      const deadlineSeconds = Math.floor(createdAt.getTime() / 1000) + ttlSeconds;
      const deadline = deadlineSeconds.toString();
      const stateMachineAddress = stateMachineAddressFor(context, options);
      const stagePatchModuleAddress = stagePatchModuleAddressFor(context, options);
      const typedData = buildStageResourcePatchTypedData({
        chainId,
        verifyingContract: stagePatchModuleAddress,
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
        deadline
      });
      const prepareId = prepareIdFactory();
      const prepared: PreparedStageResourcePatchRecord = {
        prepareId,
        taskId,
        orderId: context.order.orderId,
        onchainOrderId: context.order.orderId,
        stateMachineAddress,
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
          verifyingContract: stagePatchModuleAddress
        },
        nonceKey: stagePatchNonceKey({
          kind: "resource",
          chainId,
          stateMachineAddress,
          orderId: context.order.orderId,
          targetStageId: context.targetStageId,
          resourceKey,
          patchNonce
        })
      };
      await stageResourcePatchStore.putPrepared(prepared);
      return resourceDtoFromPrepared(prepared);
    },

    async submitStageResourcePatch(taskId, input) {
      const prepareId = prepareIdForSubmit(input, "stage resource patch");
      const prepared = await stageResourcePatchStore.getPrepared(prepareId);
      if (!prepared) {
        throw new ProductStagePatchError(404, "prepare_not_found", "prepared stage resource patch was not found");
      }
      validateSubmittedPreparedEnvelope(input, resourceDtoFromPrepared(prepared), "stage resource patch");
      validatePreparedForSubmit(prepared, taskId, input.selectorWallet, "stage resource patch");

      const currentSeconds = BigInt(Math.floor(now().getTime() / 1000));
      if (BigInt(prepared.deadline) < currentSeconds) {
        const submission = expiredResourceSubmission(prepared, submissionIdFactory(), now().toISOString());
        await stageResourcePatchStore.putSubmission(submission);
        await stageResourcePatchStore.markPreparedUsed(prepared.prepareId, submission.submissionId, submission.updatedAt);
        return submission;
      }

      const context = await resolveSelectorTaskContext(options.store, taskId);
      ensureResourcePreparedStillCurrent(context.order, prepared);

      const signature = normalizeSignature(input.signature);
      const recoveredSelector = await recoverResourceSelector(prepared, signature);
      if (recoveredSelector !== prepared.selectorWallet) {
        throw new ProductStagePatchError(400, "invalid_signature", "signature recovery did not match prepared selector", {
          recoveredSelector
        });
      }
      const reserved = await stageResourcePatchStore.reserveNonce(prepared.nonceKey);
      if (!reserved) {
        throw new ProductStagePatchError(409, "duplicate_stage_resource_patch_nonce", "stage resource patch nonce has already been used");
      }

      const broadcast = await broadcastAdapter.broadcast({
        prepared: resourceDtoFromPrepared(prepared),
        signature,
        recoveredSelector
      });
      const timestamp = now().toISOString();
      const submission = resourceSubmissionFromBroadcast(prepared, {
        submissionId: submissionIdFactory(),
        signatureHash: signatureHashFor(signature),
        recoveredSelector,
        broadcast,
        timestamp
      });
      await stageResourcePatchStore.putSubmission(submission);
      await stageResourcePatchStore.markPreparedUsed(prepared.prepareId, submission.submissionId, submission.updatedAt);
      return submission;
    },

    async getStageResourcePatchSubmission(submissionId) {
      return stageResourcePatchStore.getSubmission(submissionId);
    }
  };
}

export function createProductDockedOrderLinkService(
  options: ProductDockedOrderLinkServiceOptions
): ProductDockedOrderLinkService {
  const dockedOrderLinkStore = options.dockedOrderLinkStore ??
    new InMemoryProductStagePatchStore<PreparedDockedOrderLinkRecord, DockedOrderLinkSubmissionDTO>();
  const now = options.now ?? (() => new Date());
  const ttlSeconds = options.prepareTtlSeconds ?? DEFAULT_PREPARE_TTL_SECONDS;
  const prepareIdFactory = options.prepareIdFactory ?? (() => `docked_order_link_prep_${randomUUID()}`);
  const submissionIdFactory = options.submissionIdFactory ?? (() => `docked_order_link_sub_${randomUUID()}`);
  const broadcastAdapter = options.broadcastAdapter ?? notSupportedDockedOrderLinkBroadcastAdapter();
  const chainId = options.chainId ?? 31337;

  return {
    async prepareDockedOrderLink(taskId, input) {
      const context = await resolveSelectorPatchContext(options, taskId, {
        selectorWallet: input.selectorWallet,
        targetStageId: input.localSourceId,
        patchLabel: "docked order link",
        patchSignalId: DOCKED_ORDER_LINK_SIGNAL_ID,
        allowSubmittedTargetSignals: true
      });
      const linkedOrderId = normalizeNonZeroBytes32(input.linkedOrderId, "linkedOrderId");
      const linkedPlanId = normalizeNonZeroBytes32(input.linkedPlanId, "linkedPlanId");
      await ensureLinkedOrderExists(options.store, linkedOrderId, linkedPlanId);
      const signalBindings = normalizeDockedSignalBindings(input.signalBindings);
      const metadataURI = normalizedMetadataURI(input.metadataURI);
      const linkNonce = nextDockedOrderLinkNonce(context.order, linkedOrderId);
      const linkHash = hashDockedOrderLinkPayload({
        localOrderId: context.order.orderId,
        selectorStageId: context.task.stageIdentifier,
        localSourceId: context.targetStageId,
        linkedOrderId,
        linkedPlanId,
        linkNonce,
        metadataURI,
        signalBindings
      });
      const createdAt = now();
      const deadlineSeconds = Math.floor(createdAt.getTime() / 1000) + ttlSeconds;
      const deadline = deadlineSeconds.toString();
      const stateMachineAddress = stateMachineAddressFor(context, options);
      const dockingModuleAddress = dockingModuleAddressFor(context, options);
      const typedData = buildDockedOrderLinkTypedData({
        chainId,
        verifyingContract: dockingModuleAddress,
        localOrderId: context.order.orderId,
        selectorStageId: context.task.stageIdentifier,
        localSourceId: context.targetStageId,
        linkedOrderId,
        linkedPlanId,
        linkHash,
        linkNonce,
        metadataURI,
        signalBindings,
        selector: context.selectorWallet,
        deadline
      });
      const prepareId = prepareIdFactory();
      const prepared: PreparedDockedOrderLinkRecord = {
        prepareId,
        taskId,
        localOrderId: context.order.orderId,
        onchainLocalOrderId: context.order.orderId,
        stateMachineAddress,
        selectorStageId: context.task.stageIdentifier,
        localSourceId: context.targetStageId,
        linkedOrderId,
        linkedPlanId,
        selectorWallet: context.selectorWallet,
        linkHash,
        linkNonce,
        metadataURI,
        signalBindings,
        deadline,
        expiresAt: new Date(deadlineSeconds * 1000).toISOString(),
        status: "prepared",
        typedData,
        humanSummary: {
          purpose: "UVP docked order link selector authorization",
          localOrderId: context.order.orderId,
          selectorTaskId: taskId,
          selectorStageId: context.task.stageIdentifier,
          localSourceId: context.targetStageId,
          linkedOrderId,
          linkedPlanId,
          linkHash,
          linkNonce,
          metadataURI,
          selectorWallet: context.selectorWallet,
          signalBindings,
          validUntil: new Date(deadlineSeconds * 1000).toISOString(),
          chainId,
          verifyingContract: dockingModuleAddress
        },
        nonceKey: stagePatchNonceKey({
          kind: "docked_order_link",
          chainId,
          stateMachineAddress,
          orderId: context.order.orderId,
          targetStageId: context.targetStageId,
          linkedOrderId,
          patchNonce: linkNonce
        })
      };
      await dockedOrderLinkStore.putPrepared(prepared);
      return dockedDtoFromPrepared(prepared);
    },

    async submitDockedOrderLink(taskId, input) {
      const prepareId = prepareIdForSubmit(input, "docked order link");
      const prepared = await dockedOrderLinkStore.getPrepared(prepareId);
      if (!prepared) {
        throw new ProductStagePatchError(404, "prepare_not_found", "prepared docked order link was not found");
      }
      validateSubmittedPreparedEnvelope(input, dockedDtoFromPrepared(prepared), "docked order link");
      validatePreparedForSubmit(prepared, taskId, input.selectorWallet, "docked order link");

      const currentSeconds = BigInt(Math.floor(now().getTime() / 1000));
      if (BigInt(prepared.deadline) < currentSeconds) {
        const submission = expiredDockedSubmission(prepared, submissionIdFactory(), now().toISOString());
        await dockedOrderLinkStore.putSubmission(submission);
        await dockedOrderLinkStore.markPreparedUsed(prepared.prepareId, submission.submissionId, submission.updatedAt);
        return submission;
      }

      const context = await resolveSelectorTaskContext(options.store, taskId);
      ensureDockedPreparedStillCurrent(context.order, prepared);

      const signature = normalizeSignature(input.signature);
      const recoveredSelector = await recoverDockedSelector(prepared, signature);
      if (recoveredSelector !== prepared.selectorWallet) {
        throw new ProductStagePatchError(400, "invalid_signature", "signature recovery did not match prepared selector", {
          recoveredSelector
        });
      }
      const reserved = await dockedOrderLinkStore.reserveNonce(prepared.nonceKey);
      if (!reserved) {
        throw new ProductStagePatchError(409, "duplicate_docked_order_link_nonce", "docked order link nonce has already been used");
      }

      const broadcast = await broadcastAdapter.broadcast({
        prepared: dockedDtoFromPrepared(prepared),
        signature,
        recoveredSelector
      });
      const timestamp = now().toISOString();
      const submission = dockedSubmissionFromBroadcast(prepared, {
        submissionId: submissionIdFactory(),
        signatureHash: signatureHashFor(signature),
        recoveredSelector,
        broadcast,
        timestamp
      });
      await dockedOrderLinkStore.putSubmission(submission);
      await dockedOrderLinkStore.markPreparedUsed(prepared.prepareId, submission.submissionId, submission.updatedAt);
      return submission;
    },

    async getDockedOrderLinkSubmission(submissionId) {
      return dockedOrderLinkStore.getSubmission(submissionId);
    }
  };
}

interface SelectorTaskContext {
  readonly task: StateMachineTaskProjection;
  readonly order: StateMachineOrderProjection;
}

interface SelectorPatchContext extends SelectorTaskContext {
  readonly selectorWallet: Address;
  readonly targetStageId: Hex;
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
  }
): Promise<SelectorPatchContext> {
  const context = await resolveSelectorTaskContext(options.store, taskId);
  const selectorWallet = normalizeAddress(input.selectorWallet, "selectorWallet");
  if (context.task.status !== "ready") {
    throw new ProductStagePatchError(409, "executor_patch_task_not_ready", `executor patch task is not ready for ${input.patchLabel}`, {
      taskStatus: context.task.status
    });
  }
  if (!await isSelectorWalletAssignedToTask(options, context, selectorWallet)) {
    throw new ProductStagePatchError(403, "selector_wallet_not_authorized", "selector wallet is not assigned to this task");
  }

  const target = normalizeTargetStage(input.targetStageId);
  const binding = await findAllowedSelectorBinding(options.store, options.productSchemaResolver, context.order, {
    selectorStageId: context.task.stageIdentifier,
    targetStageId: target.stageId,
    targetStageInput: input.targetStageId
  });
  if (!binding) {
    throw new ProductStagePatchError(400, "invalid_target_stage", "target stage is not allowed by plan selector bindings", {
      selectorStageId: context.task.stageIdentifier,
      targetStageId: target.stageId
    });
  }
  ensureSelectorPatchSignalAuthorization(context.order, {
    selectorStageId: context.task.stageIdentifier,
    signalId: input.patchSignalId,
    selectorWallet,
    patchLabel: input.patchLabel
  });
  if (!input.allowSubmittedTargetSignals && hasSubmittedTargetSignal(context.order, target.stageId)) {
    throw new ProductStagePatchError(409, "target_stage_locked", "target stage already has a submitted signal");
  }

  return {
    ...context,
    selectorWallet,
    targetStageId: target.stageId
  };
}

async function isSelectorWalletAssignedToTask(
  options: ProductStagePatchServiceOptions,
  context: SelectorTaskContext,
  selectorWallet: Address
): Promise<boolean> {
  if (context.task.assigneeWallet) {
    return context.task.assigneeWallet.toLowerCase() === selectorWallet.toLowerCase();
  }

  const productStore = options.productBffStore;
  if (!productStore) {
    return false;
  }
  const plan = await findProjectedPlan(options.store, context.order);
  const schema = await findProductSchema(options.productSchemaResolver, context.order, plan);
  if (!schema) {
    return false;
  }
  const matchingRoleSlots = roleSlotIdsForTaskStage(schema, context.task.stageIdentifier);
  if (matchingRoleSlots.size === 0) {
    return false;
  }
  const registration = (await productStore.listRegistrations()).find((record) =>
    record.orderId.toLowerCase() === context.order.orderId.toLowerCase() &&
    record.planId.toLowerCase() === context.order.planId.toLowerCase() &&
    (!record.stateMachineAddress || record.stateMachineAddress.toLowerCase() === context.order.contractAddress.toLowerCase())
  );
  if (!registration) {
    return false;
  }
  const participants = await productStore.listParticipants(registration.draftId);
  return participants.some((participant) =>
    participant.status === "accepted" &&
    matchingRoleSlots.has(participant.roleSlotId) &&
    participant.walletAddress?.toLowerCase() === selectorWallet.toLowerCase()
  );
}

function roleSlotIdsForTaskStage(schema: StoreProductSchemaDTO, stageIdentifier: Hex): ReadonlySet<string> {
  const roleSlotIds = new Set<string>();
  for (const entry of schema.orderPermissionTable) {
    if (schemaStageMatchesProjectedStage(entry.stageId, stageIdentifier)) {
      roleSlotIds.add(entry.roleSlotId);
    }
  }
  for (const slot of schema.roleSlots) {
    if ((slot.capabilityPlugins ?? []).some((plugin) =>
      plugin.stageIds.some((stageId) => schemaStageMatchesProjectedStage(stageId, stageIdentifier))
    )) {
      roleSlotIds.add(slot.slotId);
    }
  }
  return roleSlotIds;
}

function schemaStageMatchesProjectedStage(schemaStageId: string, projectedStageId: Hex): boolean {
  const normalizedProjected = projectedStageId.toLowerCase();
  if (schemaStageId.toLowerCase() === normalizedProjected) {
    return true;
  }
  const derivedStageId = /^0x[0-9a-fA-F]{64}$/.test(schemaStageId)
    ? normalizeBytes32(schemaStageId, "schema.stageId")
    : normalizeBytes32(onchainStageId(schemaStageId), "schema.stageId");
  return derivedStageId.toLowerCase() === normalizedProjected;
}

async function resolveSelectorTaskContext(store: ProjectionStore, taskId: string): Promise<SelectorTaskContext> {
  const task = await store.getStateMachineTask(taskId);
  if (!task) {
    throw new ProductStagePatchError(404, "product_task_not_found", "product task not found");
  }
  const orders = await store.listStateMachineOrders();
  const order = orders.find((item) =>
    item.orderId.toLowerCase() === task.orderId.toLowerCase() &&
    item.contractAddress.toLowerCase() === task.stateMachineAddress.toLowerCase() &&
    Object.prototype.hasOwnProperty.call(item.tasks, task.taskId)
  );
  if (!order) {
    throw new ProductStagePatchError(404, "product_order_not_found", "state-machine order for task was not found");
  }
  return { task, order };
}

async function ensureLinkedOrderExists(store: ProjectionStore, linkedOrderId: Hex, linkedPlanId: Hex): Promise<void> {
  const orders = await store.listStateMachineOrders();
  const linkedOrder = orders.find((order) => order.orderId.toLowerCase() === linkedOrderId.toLowerCase());
  if (!linkedOrder) {
    throw new ProductStagePatchError(404, "linked_order_not_found", "linked order for docked zhixu link was not found", {
      linkedOrderId
    });
  }
  if (linkedOrder.planId.toLowerCase() !== linkedPlanId.toLowerCase()) {
    throw new ProductStagePatchError(409, "linked_plan_mismatch", "linked order plan does not match linkedPlanId", {
      linkedOrderId,
      expectedPlanId: linkedOrder.planId,
      linkedPlanId
    });
  }
}

async function findAllowedSelectorBinding(
  store: ProjectionStore,
  productSchemaResolver: ProductSchemaResolver | undefined,
  order: StateMachineOrderProjection,
  input: {
    readonly selectorStageId: Hex;
    readonly targetStageId: Hex;
    readonly targetStageInput: string;
  }
): Promise<StateMachineStageSelectorBindingProjection | undefined> {
  const plan = await findProjectedPlan(store, order);
  const planBinding = plan?.selectorBindings.find((binding) =>
    binding.selectorStageId === input.selectorStageId &&
    bindingMatchesTarget(binding, input.targetStageId, input.targetStageInput)
  );
  if (planBinding) {
    return planBinding;
  }

  const schema = await findProductSchema(productSchemaResolver, order, plan);
  return selectorBindingsFromProductSchema(schema).find((binding) =>
    binding.selectorStageId === input.selectorStageId &&
    bindingMatchesTarget(binding, input.targetStageId, input.targetStageInput)
  );
}

async function findProjectedPlan(
  store: ProjectionStore,
  order: StateMachineOrderProjection
): Promise<StateMachinePlanProjection | undefined> {
  const snapshot = await store.getOrderSnapshot?.();
  if (!snapshot) {
    return undefined;
  }
  return Object.values(snapshot.stateMachinePlans).find((plan) =>
    plan.planId === order.planId &&
    plan.stateMachineAddress.toLowerCase() === order.contractAddress.toLowerCase()
  );
}

async function findProductSchema(
  productSchemaResolver: ProductSchemaResolver | undefined,
  order: StateMachineOrderProjection,
  plan: StateMachinePlanProjection | undefined
): Promise<StoreProductSchemaDTO | undefined> {
  const planHash = order.planHash ?? plan?.planHash;
  if (!productSchemaResolver || !planHash) {
    return undefined;
  }
  return productSchemaResolver.getProductSchemaByPlan(order.planId, planHash);
}

function selectorBindingsFromProductSchema(schema: StoreProductSchemaDTO | undefined): readonly StateMachineStageSelectorBindingProjection[] {
  if (!schema) {
    return [];
  }
  const record = schema as unknown as {
    readonly selectorBindings?: readonly unknown[];
    readonly selectedStageBindings?: readonly unknown[];
  };
  const rawBindings = record.selectorBindings ?? record.selectedStageBindings ?? [];
  return rawBindings.flatMap((binding) => selectorBindingFromUnknown(binding));
}

function selectorBindingFromUnknown(value: unknown): readonly StateMachineStageSelectorBindingProjection[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  const record = value as Record<string, unknown>;
  const selectorStageId = stringField(record, "selectorStageId");
  const targetStageId = stringField(record, "targetStageId");
  const selectorStageIdentifier = stringField(record, "selectorStageIdentifier");
  const targetStageIdentifier = stringField(record, "targetStageIdentifier");
  if (!selectorStageId && !selectorStageIdentifier) {
    return [];
  }
  if (!targetStageId && !targetStageIdentifier) {
    return [];
  }
  const normalizedSelectorStageId = selectorStageId
    ? normalizeBytes32(selectorStageId, "selectorBinding.selectorStageId")
    : normalizeBytes32(onchainStageId(selectorStageIdentifier!), "selectorBinding.selectorStageIdentifier");
  const normalizedTargetStageId = targetStageId
    ? normalizeBytes32(targetStageId, "selectorBinding.targetStageId")
    : normalizeBytes32(onchainStageId(targetStageIdentifier!), "selectorBinding.targetStageIdentifier");
  const bindingHash = stringField(record, "bindingHash");
  return [{
    ...(selectorStageIdentifier ? { selectorStageIdentifier } : {}),
    ...(targetStageIdentifier ? { targetStageIdentifier } : {}),
    selectorStageId: normalizedSelectorStageId,
    targetStageId: normalizedTargetStageId,
    ...(bindingHash ? { bindingHash: normalizeBytes32(bindingHash, "selectorBinding.bindingHash") } : {})
  }];
}

function bindingMatchesTarget(
  binding: StateMachineStageSelectorBindingProjection,
  targetStageId: Hex,
  targetStageInput: string
): boolean {
  return binding.targetStageId === targetStageId ||
    binding.targetStageIdentifier === targetStageInput ||
    binding.targetStageIdentifier === targetStageInput.toLowerCase();
}

function ensureSelectorPatchSignalAuthorization(
  order: StateMachineOrderProjection,
  input: {
    readonly selectorStageId: Hex;
    readonly signalId: Hex;
    readonly selectorWallet: Address;
    readonly patchLabel: string;
  }
): void {
  const authorized = Object.values(order.authorizations).some((authorization) =>
    authorization.sourceId.toLowerCase() === input.selectorStageId.toLowerCase() &&
    authorization.signalId.toLowerCase() === input.signalId.toLowerCase() &&
    authorization.submitter.toLowerCase() === input.selectorWallet.toLowerCase()
  );
  if (!authorized) {
    throw new ProductStagePatchError(403, "order_signal_authorization_missing", `selector wallet is not authorized on chain for ${input.patchLabel}`, {
      sourceId: input.selectorStageId,
      signalId: input.signalId,
      selectorWallet: input.selectorWallet
    });
  }
}

function normalizeTargetStage(value: string): { readonly stageId: Hex } {
  if (/^0x[0-9a-fA-F]{64}$/.test(value)) {
    return { stageId: normalizeBytes32(value, "targetStageId") };
  }
  if (value.trim().length === 0) {
    throw new ProductStagePatchError(400, "invalid_target_stage", "targetStageId must be a stage identifier or bytes32 id");
  }
  return { stageId: normalizeBytes32(onchainStageId(value), "targetStageId") };
}

function normalizeResourceKey(value: string): Hex {
  if (/^0x[0-9a-fA-F]{64}$/.test(value)) {
    return normalizeBytes32(value, "resourceKey");
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new ProductStagePatchError(400, "invalid_body", "resourceKey must be a non-empty string or bytes32 id");
  }
  return textHash(trimmed);
}

function normalizeOptionalBytes32(value: string | undefined, fieldName: string): Hex {
  if (!value || value.trim().length === 0) {
    return ZERO_BYTES32;
  }
  return normalizeBytes32(value, fieldName);
}

function normalizeDockedSignalBindings(
  bindings: PrepareProductDockedOrderLinkInput["signalBindings"]
): readonly DockedSignalBindingDTO[] {
  if (!Array.isArray(bindings) || bindings.length === 0) {
    throw new ProductStagePatchError(400, "invalid_body", "signalBindings must contain at least one mapping");
  }
  return bindings.map((binding, index) => ({
    localSourceId: normalizeNonZeroBytes32(binding.localSourceId, `signalBindings.${index}.localSourceId`),
    localSignalId: normalizeNonZeroBytes32(binding.localSignalId, `signalBindings.${index}.localSignalId`),
    linkedSourceId: normalizeNonZeroBytes32(binding.linkedSourceId, `signalBindings.${index}.linkedSourceId`),
    linkedSignalId: normalizeNonZeroBytes32(binding.linkedSignalId, `signalBindings.${index}.linkedSignalId`)
  }));
}

function normalizeNonZeroAddress(value: string, fieldName: string): Address {
  const address = normalizeAddress(value, fieldName);
  if (address === ZERO_ADDRESS) {
    throw new ProductStagePatchError(400, "invalid_body", `${fieldName} must not be zero`);
  }
  return address;
}

function normalizeNonZeroBytes32(value: string | undefined, fieldName: string): Hex {
  if (!value) {
    throw new ProductStagePatchError(400, "invalid_body", `${fieldName} is required`);
  }
  const hash = normalizeBytes32(value, fieldName);
  if (hash === ZERO_BYTES32) {
    throw new ProductStagePatchError(400, "invalid_body", `${fieldName} must not be zero`);
  }
  return hash;
}

function normalizedMetadataURI(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new ProductStagePatchError(400, "invalid_body", "metadataURI must be a non-empty string");
  }
  return trimmed;
}

function normalizedManifestURI(value: string, runtimeEnvironment: ChainServicesRuntimeEnv): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new ProductStagePatchError(400, "invalid_body", "manifestURI must be a non-empty string");
  }
  if (runtimeEnvironment === "production" && isLegacyProductionResourceHandle(trimmed)) {
    throw new ProductStagePatchError(
      400,
      "legacy_resource_handle_rejected",
      "production resource patches must use encrypted content-addressed manifest references"
    );
  }
  return trimmed;
}

function isLegacyProductionResourceHandle(value: string): boolean {
  return /^(https?:\/\/|txcloud(?::|:\/\/)|plain_text(?::|:\/\/|$))/i.test(value);
}

interface ExecutorPatchGovernance {
  readonly mode: StageExecutorPatchMode;
  readonly modeHash: Hex;
  readonly previousExecutor?: Address;
  readonly previousExecutorForPatch: Address;
  readonly approvalSourceId?: Hex;
  readonly approvalSignalId?: Hex;
  readonly approvalSourceIdForPatch: Hex;
  readonly approvalSignalIdForPatch: Hex;
}

function resolveExecutorPatchGovernance(
  order: StateMachineOrderProjection,
  targetStageId: Hex,
  input: {
    readonly mode?: string;
    readonly previousExecutor?: string;
    readonly approvalSourceId?: string;
    readonly approvalSignalId?: string;
  }
): ExecutorPatchGovernance {
  const mode = normalizeExecutorPatchMode(input.mode);
  const modeHash = executorPatchModeHash(mode);
  const progress = targetStageProgress(order, targetStageId);
  if (mode === "assign") {
    if (progress.signalCount > 0) {
      throw new ProductStagePatchError(
        409,
        "target_stage_started_assign_rejected",
        "assign mode is only allowed before the target stage has submitted signals",
        { signalCount: progress.signalCount }
      );
    }
    rejectUnexpectedPreviousExecutor(input.previousExecutor, mode);
    rejectUnexpectedApprovalSignal(input.approvalSourceId, input.approvalSignalId, mode);
    return {
      mode,
      modeHash,
      previousExecutorForPatch: ZERO_ADDRESS,
      approvalSourceIdForPatch: ZERO_BYTES32,
      approvalSignalIdForPatch: ZERO_BYTES32
    };
  }

  if (progress.signalCount === 0) {
    throw new ProductStagePatchError(409, "target_stage_not_started", `${mode} mode requires a target-stage signal first`);
  }

  const previousExecutor = normalizeRequiredPreviousExecutor(input.previousExecutor, mode);
  const expectedPreviousExecutor = expectedPreviousExecutorForPatch(order, targetStageId, progress);
  if (expectedPreviousExecutor && previousExecutor !== expectedPreviousExecutor) {
    throw new ProductStagePatchError(
      409,
      "previous_executor_mismatch",
      "previousExecutor must match the active overlay executor or last target-stage signal submitter",
      { expectedPreviousExecutor, previousExecutor }
    );
  }

  if (mode === "handoff") {
    rejectUnexpectedApprovalSignal(input.approvalSourceId, input.approvalSignalId, mode);
    return {
      mode,
      modeHash,
      previousExecutor,
      previousExecutorForPatch: previousExecutor,
      approvalSourceIdForPatch: ZERO_BYTES32,
      approvalSignalIdForPatch: ZERO_BYTES32
    };
  }

  const approvalSourceId = normalizeNonZeroBytes32(input.approvalSourceId, "approvalSourceId");
  const approvalSignalId = normalizeNonZeroBytes32(input.approvalSignalId, "approvalSignalId");
  if (!hasSignal(order, approvalSourceId, approvalSignalId)) {
    throw new ProductStagePatchError(
      409,
      "approval_signal_missing",
      "replacement mode requires the referenced approval signal to exist in the projected order",
      { approvalSourceId, approvalSignalId }
    );
  }
  return {
    mode,
    modeHash,
    previousExecutor,
    previousExecutorForPatch: previousExecutor,
    approvalSourceId,
    approvalSignalId,
    approvalSourceIdForPatch: approvalSourceId,
    approvalSignalIdForPatch: approvalSignalId
  };
}

function normalizeExecutorPatchMode(value: string | undefined): StageExecutorPatchMode {
  const normalized = (value ?? "assign").trim().toLowerCase();
  if (normalized === "replace") {
    return "replacement";
  }
  if (normalized === "assign" || normalized === "handoff" || normalized === "replacement") {
    return normalized;
  }
  throw new ProductStagePatchError(400, "invalid_executor_patch_mode", "mode must be assign, handoff, replace, or replacement");
}

function rejectUnexpectedPreviousExecutor(value: string | undefined, mode: StageExecutorPatchMode): void {
  if (!value) {
    return;
  }
  const previousExecutor = normalizeAddress(value, "previousExecutor");
  if (previousExecutor !== ZERO_ADDRESS) {
    throw new ProductStagePatchError(400, "previous_executor_not_allowed", `previousExecutor is not used for ${mode} mode`);
  }
}

function rejectUnexpectedApprovalSignal(
  approvalSourceId: string | undefined,
  approvalSignalId: string | undefined,
  mode: StageExecutorPatchMode
): void {
  if (!approvalSourceId && !approvalSignalId) {
    return;
  }
  throw new ProductStagePatchError(400, "approval_signal_not_allowed", `approvalSourceId and approvalSignalId are only used for replacement mode`, {
    mode
  });
}

function normalizeRequiredPreviousExecutor(value: string | undefined, mode: StageExecutorPatchMode): Address {
  if (!value) {
    throw new ProductStagePatchError(400, "previous_executor_required", `previousExecutor is required for ${mode} mode`);
  }
  return normalizeNonZeroAddress(value, "previousExecutor");
}

function hasSubmittedTargetSignal(order: StateMachineOrderProjection, targetStageId: Hex): boolean {
  return targetStageProgress(order, targetStageId).signalCount > 0;
}

function hasSignal(order: StateMachineOrderProjection, sourceId: Hex, signalId: Hex): boolean {
  return Object.values(order.signals).some((signal) =>
    signal.sourceId === sourceId && signal.signalId === signalId
  );
}

interface TargetStageProgress {
  readonly signalCount: number;
  readonly lastSignalSubmitter?: Address;
}

function targetStageProgress(order: StateMachineOrderProjection, targetStageId: Hex): TargetStageProgress {
  const targetSignals = Object.values(order.signals)
    .filter((signal) => signal.sourceId === targetStageId)
    .sort((left, right) => compareSignalSubmissionOrder(left, right));
  return {
    signalCount: targetSignals.length,
    ...(targetSignals.length > 0 ? { lastSignalSubmitter: targetSignals[targetSignals.length - 1]!.submitter } : {})
  };
}

function expectedPreviousExecutorForPatch(
  order: StateMachineOrderProjection,
  targetStageId: Hex,
  progress: TargetStageProgress
): Address | undefined {
  return order.stageExecutorOverlays[targetStageId.toLowerCase()]?.activeExecutorWallet ?? progress.lastSignalSubmitter;
}

function compareSignalSubmissionOrder(
  left: { readonly submittedAt: { readonly blockNumber: bigint; readonly logIndex: number } },
  right: { readonly submittedAt: { readonly blockNumber: bigint; readonly logIndex: number } }
): number {
  if (left.submittedAt.blockNumber !== right.submittedAt.blockNumber) {
    return left.submittedAt.blockNumber < right.submittedAt.blockNumber ? -1 : 1;
  }
  return left.submittedAt.logIndex - right.submittedAt.logIndex;
}

function nextStageExecutorPatchNonce(order: StateMachineOrderProjection, targetStageId: Hex): string {
  const current = order.stageExecutorOverlays[targetStageId.toLowerCase()]?.patchNonce;
  return ((current ? BigInt(current) : 0n) + 1n).toString();
}

function nextStageResourcePatchNonce(order: StateMachineOrderProjection, targetStageId: Hex, resourceKey: Hex): string {
  const current = order.stageResourceOverlays[stageResourceOverlayProjectionKey(targetStageId, resourceKey)]?.patchNonce;
  return ((current ? BigInt(current) : 0n) + 1n).toString();
}

function nextDockedOrderLinkNonce(order: StateMachineOrderProjection, linkedOrderId: Hex): string {
  const current = dockedOrderLinkRecord(order)[linkedOrderId.toLowerCase()]?.linkNonce;
  return ((current ? BigInt(current) : 0n) + 1n).toString();
}

function ensureExecutorPreparedStillCurrent(order: StateMachineOrderProjection, prepared: PreparedStageExecutorPatchRecord): void {
  resolveExecutorPatchGovernance(order, prepared.targetStageId, {
    mode: prepared.mode,
    ...(prepared.previousExecutor ? { previousExecutor: prepared.previousExecutor } : {}),
    ...(prepared.approvalSourceId ? { approvalSourceId: prepared.approvalSourceId } : {}),
    ...(prepared.approvalSignalId ? { approvalSignalId: prepared.approvalSignalId } : {})
  });
  const currentNonce = order.stageExecutorOverlays[prepared.targetStageId.toLowerCase()]?.patchNonce;
  if (currentNonce && BigInt(currentNonce) >= BigInt(prepared.patchNonce)) {
    throw new ProductStagePatchError(409, "stale_stage_executor_patch_nonce", "prepared stage executor patch nonce is no longer current", {
      currentNonce,
      preparedNonce: prepared.patchNonce
    });
  }
}

function ensureDockedPreparedStillCurrent(order: StateMachineOrderProjection, prepared: PreparedDockedOrderLinkRecord): void {
  const currentNonce = dockedOrderLinkRecord(order)[prepared.linkedOrderId.toLowerCase()]?.linkNonce;
  if (currentNonce && BigInt(currentNonce) >= BigInt(prepared.linkNonce)) {
    throw new ProductStagePatchError(409, "stale_docked_order_link_nonce", "prepared docked order link nonce is no longer current", {
      currentNonce,
      preparedNonce: prepared.linkNonce
    });
  }
}

function ensureResourcePreparedStillCurrent(order: StateMachineOrderProjection, prepared: PreparedStageResourcePatchRecord): void {
  if (hasSubmittedTargetSignal(order, prepared.targetStageId)) {
    throw new ProductStagePatchError(409, "target_stage_locked", "target stage already has a submitted signal");
  }
  const currentNonce = order.stageResourceOverlays[stageResourceOverlayProjectionKey(prepared.targetStageId, prepared.resourceKey)]?.patchNonce;
  if (currentNonce && BigInt(currentNonce) >= BigInt(prepared.patchNonce)) {
    throw new ProductStagePatchError(409, "stale_stage_resource_patch_nonce", "prepared stage resource patch nonce is no longer current", {
      currentNonce,
      preparedNonce: prepared.patchNonce
    });
  }
}

function stateMachineAddressFor(context: SelectorTaskContext, options: ProductStagePatchServiceOptions): Address {
  const stateMachineAddress = normalizeAddress(
    context.task.stateMachineAddress || context.order.contractAddress || options.verifyingContract || ZERO_ADDRESS,
    "stateMachineAddress"
  );
  if (stateMachineAddress === ZERO_ADDRESS) {
    throw new ProductStagePatchError(409, "state_machine_address_missing", "state machine address is required for stage patch typed data");
  }
  return stateMachineAddress;
}

function stagePatchModuleAddressFor(context: SelectorTaskContext, options: ProductStagePatchServiceOptions): Address {
  return moduleAddressFor(context, options, options.stagePatchModuleAddress, "stagePatchModuleAddress");
}

function dockingModuleAddressFor(context: SelectorTaskContext, options: ProductStagePatchServiceOptions): Address {
  return moduleAddressFor(context, options, options.dockingModuleAddress, "dockingModuleAddress");
}

function moduleAddressFor(
  context: SelectorTaskContext,
  options: ProductStagePatchServiceOptions,
  configured: Address | undefined,
  label: string
): Address {
  const moduleAddress = normalizeAddress(configured ?? options.verifyingContract ?? stateMachineAddressFor(context, options), label);
  if (moduleAddress === ZERO_ADDRESS) {
    throw new ProductStagePatchError(409, "module_address_missing", `${label} is required for stage patch typed data`);
  }
  return moduleAddress;
}

function stagePatchNonceKey(input: {
  readonly kind: "executor" | "resource" | "docked_order_link";
  readonly chainId: number;
  readonly stateMachineAddress: Address;
  readonly orderId: Hex;
  readonly targetStageId: Hex;
  readonly targetSignalId?: Hex;
  readonly resourceKey?: Hex;
  readonly linkedOrderId?: Hex;
  readonly patchNonce: string;
}): string {
  return [
    input.kind,
    input.chainId,
    input.stateMachineAddress,
    input.orderId,
    input.targetStageId,
    input.targetSignalId ?? "",
    input.resourceKey ?? "",
    input.linkedOrderId ?? "",
    input.patchNonce
  ].join(":");
}

function stageResourceOverlayProjectionKey(targetStageId: Hex, resourceKey: Hex): string {
  return `${targetStageId.toLowerCase()}:${resourceKey.toLowerCase()}`;
}

function dockedOrderLinkRecord(order: StateMachineOrderProjection): Readonly<Record<string, { readonly linkNonce: string }>> {
  return (order as StateMachineOrderProjection & {
    readonly dockedOrderLinks?: Readonly<Record<string, { readonly linkNonce: string }>>;
  }).dockedOrderLinks ?? {};
}

function validatePreparedForSubmit(
  prepared: { readonly taskId: string; readonly usedAt?: string; readonly submissionId?: string; readonly selectorWallet: Address },
  taskId: string,
  selectorWalletInput: string,
  patchLabel: string
): void {
  if (prepared.taskId !== taskId) {
    throw new ProductStagePatchError(409, "prepare_task_mismatch", `prepared ${patchLabel} belongs to a different task`);
  }
  if (prepared.usedAt || prepared.submissionId) {
    throw new ProductStagePatchError(409, "prepare_already_used", `prepared ${patchLabel} has already been used`, {
      submissionId: prepared.submissionId
    });
  }
  const selectorWallet = normalizeAddress(selectorWalletInput, "selectorWallet");
  if (selectorWallet !== prepared.selectorWallet) {
    throw new ProductStagePatchError(400, "wallet_mismatch", "selectorWallet does not match prepared selector");
  }
}

function prepareIdForSubmit(
  input: {
    readonly prepareId?: string;
    readonly patch?: { readonly prepareId?: string };
  },
  patchLabel: string
): string {
  if (input.prepareId && input.prepareId.trim().length > 0) {
    return input.prepareId.trim();
  }
  if (input.patch?.prepareId && input.patch.prepareId.trim().length > 0) {
    return input.patch.prepareId.trim();
  }
  throw new ProductStagePatchError(400, "invalid_body", `${patchLabel} submit requires prepareId or prepared patch`);
}

function validateSubmittedPreparedEnvelope<
  TPrepared extends
    | PreparedStageExecutorPatchDTO
    | PreparedStageResourcePatchDTO
    | PreparedDockedOrderLinkDTO
>(
  input: {
    readonly typedData?: unknown;
    readonly patch?: TPrepared;
  },
  prepared: TPrepared,
  patchLabel: string
): void {
  if (input.patch !== undefined && canonicalJson(input.patch) !== canonicalJson(prepared)) {
    throw new ProductStagePatchError(400, "prepared_patch_mismatch", `submitted ${patchLabel} does not match the server-prepared patch`);
  }
  if (input.typedData !== undefined && canonicalJson(input.typedData) !== canonicalJson(prepared.typedData)) {
    throw new ProductStagePatchError(400, "typed_data_mismatch", `submitted typedData does not match the prepared ${patchLabel}`);
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalValue(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalValue(nested)])
    );
  }
  return value;
}

async function recoverExecutorSelector(prepared: PreparedStageExecutorPatchRecord, signature: Hex): Promise<Address> {
  try {
    return await recoverStageExecutorPatchSigner(prepared.typedData, signature);
  } catch (error) {
    throw new ProductStagePatchError(400, "invalid_signature", error instanceof Error ? error.message : "invalid signature");
  }
}

function signatureForPreviousExecutor(
  prepared: PreparedStageExecutorPatchRecord,
  signatureInput: string | undefined
): Hex | undefined {
  if (prepared.mode !== "handoff") {
    return undefined;
  }
  if (!signatureInput) {
    throw new ProductStagePatchError(
      400,
      "previous_executor_signature_required",
      "handoff mode requires previousExecutorSignature"
    );
  }
  return normalizeSignature(signatureInput);
}

async function recoverExecutorPreviousExecutor(prepared: PreparedStageExecutorPatchRecord, signature: Hex): Promise<Address> {
  try {
    return await recoverStageExecutorPatchSigner(prepared.typedData, signature);
  } catch (error) {
    throw new ProductStagePatchError(
      400,
      "invalid_previous_executor_signature",
      error instanceof Error ? error.message : "invalid previous executor signature"
    );
  }
}

async function recoverResourceSelector(prepared: PreparedStageResourcePatchRecord, signature: Hex): Promise<Address> {
  try {
    return await recoverStageResourcePatchSigner(prepared.typedData, signature);
  } catch (error) {
    throw new ProductStagePatchError(400, "invalid_signature", error instanceof Error ? error.message : "invalid signature");
  }
}

async function recoverDockedSelector(prepared: PreparedDockedOrderLinkRecord, signature: Hex): Promise<Address> {
  try {
    return await recoverDockedOrderLinkSigner(prepared.typedData, signature);
  } catch (error) {
    throw new ProductStagePatchError(400, "invalid_signature", error instanceof Error ? error.message : "invalid signature");
  }
}

function executorDtoFromPrepared(record: PreparedStageExecutorPatchRecord): PreparedStageExecutorPatchDTO {
  const { nonceKey: _nonceKey, usedAt: _usedAt, submissionId: _submissionId, ...dto } = record;
  return dto;
}

function resourceDtoFromPrepared(record: PreparedStageResourcePatchRecord): PreparedStageResourcePatchDTO {
  const { nonceKey: _nonceKey, usedAt: _usedAt, submissionId: _submissionId, ...dto } = record;
  return dto;
}

function dockedDtoFromPrepared(record: PreparedDockedOrderLinkRecord): PreparedDockedOrderLinkDTO {
  const { nonceKey: _nonceKey, usedAt: _usedAt, submissionId: _submissionId, ...dto } = record;
  return dto;
}

function expiredExecutorSubmission(
  prepared: PreparedStageExecutorPatchRecord,
  submissionId: string,
  timestamp: string
): StageExecutorPatchSubmissionDTO {
  return {
    ...executorSubmissionCommon(prepared, {
      submissionId,
      createdAt: timestamp
    }),
    status: "expired",
    signatureStatus: "not_verified",
    selectorSignatureStatus: "not_verified",
    previousExecutorSignatureStatus: previousExecutorSignatureStatus(prepared, false),
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
      ...(prepared.previousExecutor ? { previousExecutor: prepared.previousExecutor } : {}),
      ...(prepared.approvalSourceId ? { approvalSourceId: prepared.approvalSourceId } : {}),
      ...(prepared.approvalSignalId ? { approvalSignalId: prepared.approvalSignalId } : {}),
      selectorSignatureStatus: "not_verified",
      previousExecutorSignatureStatus: previousExecutorSignatureStatus(prepared, false),
      patchHash: prepared.patchHash,
      errorCode: "stage_executor_patch_expired"
    })
  };
}

function expiredResourceSubmission(
  prepared: PreparedStageResourcePatchRecord,
  submissionId: string,
  timestamp: string
): StageResourcePatchSubmissionDTO {
  return {
    ...resourceSubmissionCommon(prepared, {
      submissionId,
      createdAt: timestamp
    }),
    status: "expired",
    signatureStatus: "not_verified",
    broadcastStatus: "not_attempted",
    errorCode: "stage_resource_patch_expired",
    errorMessage: "prepared stage resource patch deadline has expired",
    retryable: false,
    proofRows: proofRows({
      label: "Stage resource patch status",
      status: "expired",
      selector: prepared.selectorWallet,
      patchHash: prepared.patchHash,
      errorCode: "stage_resource_patch_expired"
    })
  };
}

function expiredDockedSubmission(
  prepared: PreparedDockedOrderLinkRecord,
  submissionId: string,
  timestamp: string
): DockedOrderLinkSubmissionDTO {
  return {
    ...dockedSubmissionCommon(prepared, {
      submissionId,
      createdAt: timestamp
    }),
    status: "expired",
    signatureStatus: "not_verified",
    broadcastStatus: "not_attempted",
    errorCode: "docked_order_link_expired",
    errorMessage: "prepared docked order link deadline has expired",
    retryable: false,
    proofRows: proofRows({
      label: "Docked order link status",
      status: "expired",
      selector: prepared.selectorWallet,
      patchHash: prepared.linkHash,
      errorCode: "docked_order_link_expired"
    })
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
  }
): StageExecutorPatchSubmissionDTO {
  const common = executorSubmissionCommon(prepared, {
    submissionId: input.submissionId,
    signatureHash: input.signatureHash,
    recoveredSelector: input.recoveredSelector,
    ...(input.previousExecutorSignatureHash ? { previousExecutorSignatureHash: input.previousExecutorSignatureHash } : {}),
    ...(input.recoveredPreviousExecutor ? { recoveredPreviousExecutor: input.recoveredPreviousExecutor } : {}),
    createdAt: input.timestamp
  });
  return submissionFromBroadcastCommon(common, input.broadcast, "Stage executor patch status");
}

function resourceSubmissionFromBroadcast(
  prepared: PreparedStageResourcePatchRecord,
  input: {
    readonly submissionId: string;
    readonly signatureHash: Hex;
    readonly recoveredSelector: Address;
    readonly broadcast: StagePatchBroadcastResult;
    readonly timestamp: string;
  }
): StageResourcePatchSubmissionDTO {
  const common = resourceSubmissionCommon(prepared, {
    submissionId: input.submissionId,
    signatureHash: input.signatureHash,
    recoveredSelector: input.recoveredSelector,
    createdAt: input.timestamp
  });
  return submissionFromBroadcastCommon(common, input.broadcast, "Stage resource patch status");
}

function dockedSubmissionFromBroadcast(
  prepared: PreparedDockedOrderLinkRecord,
  input: {
    readonly submissionId: string;
    readonly signatureHash: Hex;
    readonly recoveredSelector: Address;
    readonly broadcast: StagePatchBroadcastResult;
    readonly timestamp: string;
  }
): DockedOrderLinkSubmissionDTO {
  const common = dockedSubmissionCommon(prepared, {
    submissionId: input.submissionId,
    signatureHash: input.signatureHash,
    recoveredSelector: input.recoveredSelector,
    createdAt: input.timestamp
  });
  return submissionFromBroadcastCommon(common, input.broadcast, "Docked order link status");
}

function submissionFromBroadcastCommon<
  TSubmission extends
    | StageExecutorPatchSubmissionDTO
    | StageResourcePatchSubmissionDTO
    | DockedOrderLinkSubmissionDTO
>(
  common: Omit<TSubmission, "status" | "signatureStatus" | "broadcastStatus" | "retryable" | "proofRows">,
  broadcast: StagePatchBroadcastResult,
  proofStatusLabel: string
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
        txHash: broadcast.txHash
      })
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
        ...(broadcast.txHash ? { txHash: broadcast.txHash } : {})
      })
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
        errorCode: broadcast.errorCode
      })
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
      errorCode: broadcast.errorCode
    })
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
  }
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
    selectorStageId: prepared.selectorStageId,
    targetStageId: prepared.targetStageId,
    selectorWallet: prepared.selectorWallet,
    executorWallet: prepared.executorWallet,
    mode: prepared.mode,
    modeHash: prepared.modeHash,
    ...(prepared.previousExecutor ? { previousExecutor: prepared.previousExecutor } : {}),
    ...(prepared.approvalSourceId ? { approvalSourceId: prepared.approvalSourceId } : {}),
    ...(prepared.approvalSignalId ? { approvalSignalId: prepared.approvalSignalId } : {}),
    roleHash: prepared.roleHash,
    executorMetadataHash: prepared.executorMetadataHash,
    patchHash: prepared.patchHash,
    patchNonce: prepared.patchNonce,
    metadataURI: prepared.metadataURI,
    deadline: prepared.deadline,
    selectorSignatureStatus: input.signatureHash ? "signature_verified" : "not_verified",
    previousExecutorSignatureStatus: previousExecutorSignatureStatus(prepared, Boolean(input.previousExecutorSignatureHash)),
    ...(input.signatureHash ? { signatureHash: input.signatureHash } : {}),
    ...(input.previousExecutorSignatureHash ? { previousExecutorSignatureHash: input.previousExecutorSignatureHash } : {}),
    ...(input.recoveredSelector ? { recoveredSelector: input.recoveredSelector } : {}),
    ...(input.recoveredPreviousExecutor ? { recoveredPreviousExecutor: input.recoveredPreviousExecutor } : {}),
    createdAt: input.createdAt,
    updatedAt: input.createdAt
  };
}

function resourceSubmissionCommon(
  prepared: PreparedStageResourcePatchRecord,
  input: {
    readonly submissionId: string;
    readonly signatureHash?: Hex;
    readonly recoveredSelector?: Address;
    readonly createdAt: string;
  }
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
    ...(input.recoveredSelector ? { recoveredSelector: input.recoveredSelector } : {}),
    createdAt: input.createdAt,
    updatedAt: input.createdAt
  };
}

function dockedSubmissionCommon(
  prepared: PreparedDockedOrderLinkRecord,
  input: {
    readonly submissionId: string;
    readonly signatureHash?: Hex;
    readonly recoveredSelector?: Address;
    readonly createdAt: string;
  }
): Omit<
  DockedOrderLinkSubmissionDTO,
  "status" | "signatureStatus" | "broadcastStatus" | "retryable" | "proofRows"
> {
  return {
    submissionId: input.submissionId,
    prepareId: prepared.prepareId,
    taskId: prepared.taskId,
    localOrderId: prepared.localOrderId,
    onchainLocalOrderId: prepared.onchainLocalOrderId,
    stateMachineAddress: prepared.stateMachineAddress,
    selectorStageId: prepared.selectorStageId,
    localSourceId: prepared.localSourceId,
    linkedOrderId: prepared.linkedOrderId,
    linkedPlanId: prepared.linkedPlanId,
    selectorWallet: prepared.selectorWallet,
    linkHash: prepared.linkHash,
    linkNonce: prepared.linkNonce,
    metadataURI: prepared.metadataURI,
    signalBindings: prepared.signalBindings,
    deadline: prepared.deadline,
    ...(input.signatureHash ? { signatureHash: input.signatureHash } : {}),
    ...(input.recoveredSelector ? { recoveredSelector: input.recoveredSelector } : {}),
    createdAt: input.createdAt,
    updatedAt: input.createdAt
  };
}

function previousExecutorSignatureStatus(
  prepared: PreparedStageExecutorPatchRecord,
  verified: boolean
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
    readonly approvalSourceId?: Hex;
    readonly approvalSignalId?: Hex;
    readonly selectorSignatureStatus?: string;
    readonly previousExecutorSignatureStatus?: string;
  },
  input: {
    readonly label: string;
    readonly status: string;
    readonly txHash?: Hex;
    readonly errorCode?: string;
  }
): readonly { readonly label: string; readonly value: string }[] {
  return proofRows({
    label: input.label,
    status: input.status,
    selector: common.selectorWallet,
    ...(common.executorWallet ? { executor: common.executorWallet } : {}),
    ...(common.mode ? { mode: common.mode } : {}),
    ...(common.previousExecutor ? { previousExecutor: common.previousExecutor } : {}),
    ...(common.approvalSourceId ? { approvalSourceId: common.approvalSourceId } : {}),
    ...(common.approvalSignalId ? { approvalSignalId: common.approvalSignalId } : {}),
    ...(common.selectorSignatureStatus ? { selectorSignatureStatus: common.selectorSignatureStatus } : {}),
    ...(common.previousExecutorSignatureStatus ? { previousExecutorSignatureStatus: common.previousExecutorSignatureStatus } : {}),
    patchHash: common.patchHash ?? common.linkHash ?? ZERO_BYTES32,
    ...(input.txHash ? { txHash: input.txHash } : {}),
    ...(input.errorCode ? { errorCode: input.errorCode } : {})
  });
}

function proofRows(input: {
  readonly label: string;
  readonly status: string;
  readonly selector: Address;
  readonly executor?: Address;
  readonly mode?: StageExecutorPatchMode;
  readonly previousExecutor?: Address;
  readonly approvalSourceId?: Hex;
  readonly approvalSignalId?: Hex;
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
    ...(input.executor ? [{ label: "New executor", value: input.executor }] : []),
    ...(input.previousExecutor ? [{ label: "Previous executor", value: input.previousExecutor }] : []),
    ...(input.approvalSourceId && input.approvalSignalId
      ? [{ label: "Approval signal", value: `${input.approvalSourceId}:${input.approvalSignalId}` }]
      : []),
    ...(input.selectorSignatureStatus ? [{ label: "Selector signature", value: input.selectorSignatureStatus }] : []),
    ...(input.previousExecutorSignatureStatus
      ? [{ label: "Previous executor signature", value: input.previousExecutorSignatureStatus }]
      : []),
    { label: "Patch hash", value: input.patchHash },
    ...(input.txHash ? [{ label: "Transaction", value: input.txHash }] : []),
    ...(input.errorCode ? [{ label: "Error", value: input.errorCode }] : [])
  ];
}

function stringField(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function normalizeStagePatchServiceError(error: unknown): ProductStagePatchError {
  if (error instanceof ProductStagePatchError) {
    return error;
  }
  if (error instanceof ConfigError) {
    return new ProductStagePatchError(400, "invalid_body", error.message);
  }
  return new ProductStagePatchError(500, "stage_patch_failed", error instanceof Error ? error.message : "stage patch failed");
}
