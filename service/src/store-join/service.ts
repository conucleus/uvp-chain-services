import { randomUUID } from "node:crypto";
import { keccak256Hex, onchainStageId } from "@uvp-eth/compiler";
import { normalizeAddress, normalizeBytes32, type Address, type Hex } from "../shared/types.js";
import type { ProjectionStore } from "../storage/projection-store.js";
import type { IdentityBindingProjection } from "../indexer/identity-projections.js";
import type { ProductService } from "../product/service.js";
import { productSignalId, productSignalSourceId } from "../product/bff/trigger.js";
import type { StoreSupplierService, StoreOperatorPrincipal } from "../store-suppliers/service.js";
import { InMemoryStoreJoinApplicationStore } from "./memory-store.js";
import type {
  StoreJoinActor,
  StoreJoinApplicationDetailDTO,
  StoreJoinApplicationEventRecord,
  StoreJoinApplicationRecord,
  StoreJoinApplicationStore,
  StoreJoinApplicationStatus,
  StoreJoinAuthorizationKind,
  StoreJoinTxEvidence
} from "./types.js";
import { StoreJoinServiceError } from "./types.js";

export interface StoreJoinServiceOptions {
  readonly projectionStore: ProjectionStore;
  readonly productService: ProductService;
  readonly supplierService: StoreSupplierService;
  /** 红线：加入入口必须被 listing 状态与锚核验抑制（与详情页同口径）。 */
  readonly listingGate?: {
    readonly getListingForPlan: (planId: Hex) => Promise<{
      readonly status: "imported" | "public" | "rejected" | "delisted";
      readonly anchorVerification: { readonly status: "consistent" | "conflict" | "pending_indexing" };
    } | undefined>;
  };
  /** publisher/委托核验（由装修域提供同一张权限根表）。 */
  readonly publisherAccess: {
    hasPublisherWriteAccess(planId: Hex, address: Address): Promise<boolean>;
  };
  readonly joinStore?: StoreJoinApplicationStore;
  readonly now?: () => Date;
  readonly audit?: (event: StoreJoinAuditEvent) => Promise<void> | void;
}

export interface StoreJoinAuditEvent {
  readonly action:
    | "join.submitted"
    | "join.review_started"
    | "join.approved"
    | "join.rejected"
    | "join.revoked"
    | "join.activated";
  readonly applicationId: string;
  readonly planId: Hex;
  readonly actorAddress?: Address;
  readonly outcome: "succeeded" | "blocked";
  readonly errorCode?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export interface StoreJoinListQuery {
  readonly planId?: Hex;
  readonly applicantAddress?: Address;
  readonly status?: StoreJoinApplicationStatus;
}

export interface StoreJoinService {
  submitApplication(input: unknown, actor: StoreJoinActor): Promise<StoreJoinApplicationDetailDTO>;
  listApplications(query: StoreJoinListQuery, actor: StoreJoinActor): Promise<readonly StoreJoinApplicationDetailDTO[]>;
  getApplication(applicationId: string, actor: StoreJoinActor): Promise<StoreJoinApplicationDetailDTO>;
  startReview(applicationId: string, actor: StoreJoinActor): Promise<StoreJoinApplicationDetailDTO>;
  approveApplication(applicationId: string, input: unknown, actor: StoreJoinActor): Promise<StoreJoinApplicationDetailDTO>;
  rejectApplication(applicationId: string, input: unknown, actor: StoreJoinActor): Promise<StoreJoinApplicationDetailDTO>;
  revokeApplication(applicationId: string, input: unknown, actor: StoreJoinActor): Promise<StoreJoinApplicationDetailDTO>;
}

const OPERATOR_LEVELS = new Set(["store_operator", "store_admin"]);

export function createStoreJoinService(options: StoreJoinServiceOptions): StoreJoinService {
  const projectionStore = options.projectionStore;
  const joinStore = options.joinStore ?? new InMemoryStoreJoinApplicationStore();
  const now = options.now ?? (() => new Date());

  return {
    async submitApplication(input, actor) {
      const anchoredAddress = requireAnchored(actor);
      const record = requireBodyRecord(input);
      const planId = planIdField(record);
      const roleSlotId = requiredString(record, "roleSlotId");
      const authorizationKind = parseAuthorizationKind(optionalString(record, "authorizationKind") ?? "signal_submitter");
      const stageId = optionalString(record, "stageId");
      const applicantSubjectId = optionalBytes32(record, "applicantSubjectId")
        ?? deriveSubjectForAddress(anchoredAddress);
      const applicantDisplayName = optionalString(record, "displayName");
      const statement = optionalString(record, "statement");

      const zhixu = await resolveZhixuForPlan(planId);
      if (authorizationKind === "stage_executor" && !stageId) {
        throw new StoreJoinServiceError(400, "invalid_body", "stageId is required for stage_executor applications");
      }
      validateSlotAndStage(zhixu.detail as Parameters<typeof validateSlotAndStage>[0], roleSlotId, authorizationKind, stageId);
      await assertJoinEntryAllowedNow(planId);

      const openDuplicate = (await joinStore.listApplications({ planId, applicantAddress: anchoredAddress }))
        .find((application) => application.status === "applied" || application.status === "under_review");
      if (openDuplicate) {
        throw new StoreJoinServiceError(409, "application_exists", "an open application already exists for this address and plan", {
          applicationId: openDuplicate.applicationId
        });
      }

      const timestamp = now().toISOString();
      const application: StoreJoinApplicationRecord = {
        applicationId: `join_${randomUUID()}`,
        planId,
        zhixuId: zhixu.zhixuId,
        roleSlotId,
        authorizationKind,
        ...(stageId ? { stageId } : {}),
        applicantAddress: anchoredAddress,
        ...(actor.accountId ? { applicantAccountId: actor.accountId } : {}),
        applicantSubjectId,
        ...(applicantDisplayName ? { applicantDisplayName } : {}),
        ...(statement ? { statement } : {}),
        status: "applied",
        txEvidence: [],
        submittedAt: timestamp,
        updatedAt: timestamp
      };
      await joinStore.putApplication(application);
      await appendEvent(application.applicationId, "submitted", { ...actor, anchoredAddress }, undefined, undefined, timestamp);
      await emitAudit({
        action: "join.submitted",
        applicationId: application.applicationId,
        planId,
        actorAddress: anchoredAddress,
        outcome: "succeeded",
        createdAt: timestamp
      });
      return this.getApplication(application.applicationId, actor);
    },

    async listApplications(query, actor) {
      const anchoredAddress = requireAnchored(actor);
      const isOperator = OPERATOR_LEVELS.has(actor.accessLevel);
      const reviewerForPlan = query.planId
        ? await options.publisherAccess.hasPublisherWriteAccess(query.planId, anchoredAddress)
        : false;
      if (!isOperator && !reviewerForPlan && query.applicantAddress && query.applicantAddress.toLowerCase() !== anchoredAddress.toLowerCase()) {
        throw new StoreJoinServiceError(403, "join_scope_forbidden", "sessions may only list their own applications");
      }
      const effectiveQuery: StoreJoinListQuery = isOperator || reviewerForPlan
        ? {
          ...(query.planId ? { planId: query.planId } : {}),
          ...(query.status ? { status: query.status } : {}),
          ...(query.applicantAddress ? { applicantAddress: query.applicantAddress } : {})
        }
        : {
          ...(query.planId ? { planId: query.planId } : {}),
          ...(query.status ? { status: query.status } : {}),
          applicantAddress: anchoredAddress
        };
      const applications = await joinStore.listApplications(effectiveQuery);
      const details: StoreJoinApplicationDetailDTO[] = [];
      for (const application of applications) {
        details.push(await resolveApplicationDetail(application));
      }
      return details;
    },

    async getApplication(applicationId, actor) {
      const application = await requireApplication(applicationId);
      const isOperator = OPERATOR_LEVELS.has(actor.accessLevel);
      const isApplicant = actor.anchoredAddress?.toLowerCase() === application.applicantAddress.toLowerCase();
      const isReviewer = actor.anchoredAddress
        ? await options.publisherAccess.hasPublisherWriteAccess(application.planId, actor.anchoredAddress)
        : false;
      if (!isOperator && !isApplicant && !isReviewer) {
        throw new StoreJoinServiceError(403, "join_scope_forbidden", "only the applicant, the plan publisher, or a store operator can read this application");
      }
      return resolveApplicationDetail(application);
    },

    async startReview(applicationId, actor) {
      const anchoredAddress = requireAnchored(actor);
      const application = await requireReviewer(applicationId, actor, "join.review_started");
      assertTransition(application.status, "under_review");
      const timestamp = now().toISOString();
      const updated: StoreJoinApplicationRecord = { ...application, status: "under_review", updatedAt: timestamp };
      await joinStore.putApplication(updated);
      await appendEvent(applicationId, "review_started", { ...actor, anchoredAddress }, undefined, undefined, timestamp);
      await emitAudit({
        action: "join.review_started",
        applicationId,
        planId: application.planId,
        actorAddress: anchoredAddress,
        outcome: "succeeded",
        createdAt: timestamp
      });
      return resolveApplicationDetail(updated);
    },

    async approveApplication(applicationId, input, actor) {
      const anchoredAddress = requireAnchored(actor);
      const application = await requireReviewer(applicationId, actor, "join.approved");
      if (application.status !== "under_review") {
        throw new StoreJoinServiceError(409, "invalid_application_transition", `${application.status} application cannot be approved`);
      }
      const record = requireBodyRecord(input ?? {});
      const note = optionalString(record, "note");
      await assertJoinEntryAllowedNow(application.planId);

      const timestamp = now().toISOString();
      const pairing = await ensureIdentityPairing(application, actor);

      const evidence: StoreJoinTxEvidence[] = [
        ...application.txEvidence,
        {
          kind: "identity_binding",
          ...(pairing.txHash ? { txHash: pairing.txHash } : {}),
          ...(pairing.txLogId ? { txLogId: pairing.txLogId } : {}),
          ...(pairing.executionMode ? { executionMode: pairing.executionMode } : {}),
          planId: application.planId,
          slot: application.roleSlotId,
          address: application.applicantAddress,
          status: "recorded",
          recordedAt: timestamp
        }
      ];
      const updated: StoreJoinApplicationRecord = {
        ...application,
        status: "authorized",
        ...(pairing.supplierId ? { supplierId: pairing.supplierId } : (application.supplierId ? { supplierId: application.supplierId } : {})),
        txEvidence: evidence,
        decidedByAddress: anchoredAddress,
        decidedAt: timestamp,
        updatedAt: timestamp
      };
      await joinStore.putApplication(updated);
      await appendEvent(applicationId, "approved", { ...actor, anchoredAddress }, note, undefined, timestamp);
      await appendEvent(applicationId, "authorized", { ...actor, anchoredAddress }, note, pairing.txHash, timestamp);
      await emitAudit({
        action: "join.approved",
        applicationId,
        planId: application.planId,
        actorAddress: anchoredAddress,
        outcome: "succeeded",
        metadata: {
          authorizationKind: application.authorizationKind,
          ...(pairing.txHash ? { txHash: pairing.txHash } : {}),
          ...(pairing.executionMode ? { executionMode: pairing.executionMode } : {})
        },
        createdAt: timestamp
      });
      return resolveApplicationDetail(updated);
    },

    async rejectApplication(applicationId, input, actor) {
      const anchoredAddress = requireAnchored(actor);
      const application = await requireReviewer(applicationId, actor, "join.rejected");
      if (application.status !== "applied" && application.status !== "under_review") {
        throw new StoreJoinServiceError(409, "invalid_application_transition", `${application.status} application cannot be rejected`);
      }
      const record = requireBodyRecord(input);
      const reason = requiredString(record, "reason");
      const timestamp = now().toISOString();
      const updated: StoreJoinApplicationRecord = {
        ...application,
        status: "rejected",
        rejectionReason: reason,
        decidedByAddress: anchoredAddress,
        decidedAt: timestamp,
        updatedAt: timestamp
      };
      await joinStore.putApplication(updated);
      await appendEvent(applicationId, "rejected", { ...actor, anchoredAddress }, reason, undefined, timestamp);
      await emitAudit({
        action: "join.rejected",
        applicationId,
        planId: application.planId,
        actorAddress: anchoredAddress,
        outcome: "succeeded",
        createdAt: timestamp
      });
      return resolveApplicationDetail(updated);
    },

    async revokeApplication(applicationId, input, actor) {
      const application = await requireApplication(applicationId);
      const isOperator = OPERATOR_LEVELS.has(actor.accessLevel);
      const isReviewer = actor.anchoredAddress
        ? await options.publisherAccess.hasPublisherWriteAccess(application.planId, actor.anchoredAddress)
        : false;
      const isApplicant = actor.anchoredAddress?.toLowerCase() === application.applicantAddress.toLowerCase();
      if (!isOperator && !isReviewer && !isApplicant) {
        throw new StoreJoinServiceError(403, "join_scope_forbidden", "only the applicant, the plan publisher, or a store operator can revoke this application");
      }
      if (application.status === "revoked" || application.status === "rejected") {
        throw new StoreJoinServiceError(409, "invalid_application_transition", `${application.status} application cannot be revoked`);
      }
      const record = requireBodyRecord(input ?? {});
      const reason = optionalString(record, "reason") ?? "revoked via store join loop";
      const timestamp = now().toISOString();
      const decidedBy = actor.anchoredAddress ?? application.decidedByAddress;
      const updated: StoreJoinApplicationRecord = {
        ...application,
        status: "revoked",
        revocationReason: reason,
        ...(decidedBy ? { decidedByAddress: decidedBy } : {}),
        decidedAt: timestamp,
        updatedAt: timestamp
      };
      await joinStore.putApplication(updated);
      await appendEvent(applicationId, "revoked", actor, reason, undefined, timestamp);
      await emitAudit({
        action: "join.revoked",
        applicationId,
        planId: application.planId,
        ...(actor.anchoredAddress ? { actorAddress: actor.anchoredAddress } : {}),
        outcome: "succeeded",
        createdAt: timestamp
      });
      return resolveApplicationDetail(updated);
    }
  };

  /**
   * 审批通过后的身份配对链（配对红线）：
   * 1. 双向占用核验（account→subject 与 subject→account，冲突即 409）；
   * 2. 无供应商元数据则以申请信息创建；
   * 3. 治理 review 先行（approved_for_broadcast 落 governance 记录）；
   * 4. 链上身份绑定：地址已有同主体 active binding → 复用其交易证据；
   *    无绑定 → registerIdentity（要求审批者持有 governance_admin 权威，
   *    与供应商登记路由的能力门禁同口径——publisher 审批不绕过）。
   * 任何一步失败，申请留在 under_review，不落后续状态。
   */
  async function ensureIdentityPairing(
    application: StoreJoinApplicationRecord,
    actor: StoreJoinActor
  ): Promise<{
    readonly supplierId?: string;
    readonly txHash?: Hex;
    readonly txLogId?: string;
    readonly executionMode?: "simulated" | "on_chain";
  }> {
    // 先做双向占用核验，再创建任何经营数据：409 时不留下孤儿供应商记录。
    const activeBinding = selectActiveBinding(
      await projectionStore.listIdentityBindings({ account: application.applicantAddress, activeOnly: true })
    );
    if (activeBinding && activeBinding.subjectId.toLowerCase() !== application.applicantSubjectId.toLowerCase()) {
      throw new StoreJoinServiceError(
        409,
        "account_already_bound",
        "the applicant address already holds an active identity binding for another subject; resolve the binding before approving",
        { boundSubjectId: activeBinding.subjectId }
      );
    }
    // subjectId→account 方向同样核验：缺了这一向，审批会静默覆写
    // 既有供应商钱包 / 为其广播新绑定。
    const subjectBinding = selectActiveBinding(
      await projectionStore.listIdentityBindings({ subjectId: application.applicantSubjectId, activeOnly: true })
    );
    if (subjectBinding && subjectBinding.account.toLowerCase() !== application.applicantAddress.toLowerCase()) {
      throw new StoreJoinServiceError(
        409,
        "subject_already_bound",
        "the applicant subject already has an active identity binding to another account; approve would overwrite the existing supplier wallet",
        { boundAccount: subjectBinding.account }
      );
    }
    const principal: StoreOperatorPrincipal = {
      operatorId: actor.anchoredAddress ?? actor.principalId ?? "join-reviewer",
      role: actor.governanceAdmin ? "governance_admin" : "store_operator"
    };
    let supplierId = application.supplierId;
    const existingSupplier = await options.supplierService.listSuppliers()
      .then((list) => list.suppliers.find((supplier) =>
        supplier.supplierSubjectId.toLowerCase() === application.applicantSubjectId.toLowerCase()
      ));
    if (!existingSupplier) {
      const created = await options.supplierService.createSupplier(
        {
          supplierSubjectId: application.applicantSubjectId,
          displayName: application.applicantDisplayName ?? `供应商 ${application.applicantAddress.slice(0, 10)}`,
          wallet: application.applicantAddress,
          supportedRoleSlotIds: [application.roleSlotId],
          ...(application.stageId ? { supportedStageIds: [application.stageId] } : {}),
          reviewStatus: "submitted"
        },
        principal
      );
      supplierId = created.supplier.supplierId;
    } else {
      supplierId = existingSupplier.supplierId;
    }

    if (activeBinding) {
      return {
        supplierId,
        txHash: activeBinding.registeredAt.transactionHash,
        executionMode: "on_chain"
      };
    }

    if (existingSupplier?.reviewStatus !== "approved_for_broadcast") {
      await options.supplierService.reviewSupplier(
        supplierId!,
        {
          reviewStatus: "approved_for_broadcast",
          ...(application.applicantDisplayName ? { displayName: application.applicantDisplayName } : {}),
          wallet: application.applicantAddress,
          supportedRoleSlotIds: [application.roleSlotId],
          ...(application.stageId ? { supportedStageIds: [application.stageId] } : {}),
          publicSummary: "approved via store join loop"
        },
        principal
      );
    }
    // 链上身份登记的门禁与
    // /store/suppliers/:id/request-identity-registration 一致——governance
    // _admin 权威。publisher 审批到此为止；无权威时申请留在 under_review
    // 并提示由治理管理员完成登记。
    if (!actor.governanceAdmin) {
      throw new StoreJoinServiceError(
        403,
        "governance_admin_required",
        "on-chain identity registration requires a governance admin (the plan publisher approval alone must not broadcast identity bindings); re-run the approval with a governance-admin session or use the supplier identity-registration endpoint",
        { applicationId: application.applicationId }
      );
    }
    const registration = await options.supplierService.requestIdentityRegistration(
      supplierId!,
      { wallet: application.applicantAddress },
      principal
    );
    const log = (registration.governance as { readonly log?: { readonly txHash?: Hex; readonly txLogId?: string; readonly executionMode?: string } }).log;
    return {
      supplierId,
      ...(log?.txHash ? { txHash: log.txHash } : {}),
      ...(log?.txLogId ? { txLogId: log.txLogId } : {}),
      ...(log?.executionMode === "on_chain" || log?.executionMode === "simulated" ? { executionMode: log.executionMode } : { executionMode: "simulated" })
    };
  }

  /**
   * 惰性收敛（读取时）：
   * - binding 撤销 → 申请进入 revoked（联动红线）。
   * - authorized 的申请在投影观察到被授权地址的链上授权事件
   *   （SignalSubmitterAuthorized / stageExecutorOverlay.activeExecutorWallet）
   *   → 落为 active 并补记 tx 证据。
   */
  async function resolveApplicationDetail(
    application: StoreJoinApplicationRecord
  ): Promise<StoreJoinApplicationDetailDTO> {
    let current = application;
    const timestamp = now().toISOString();

    const bindings = await projectionStore.listIdentityBindings({
      subjectId: current.applicantSubjectId,
      activeOnly: true
    });
    const binding = selectActiveBinding(bindings);
    const bindingAccountMatches = binding
      ? binding.account.toLowerCase() === current.applicantAddress.toLowerCase()
      : false;

    if (!binding && (current.status === "authorized" || current.status === "active")) {
      const anyBinding = selectAnyBinding(await projectionStore.listIdentityBindings({
        subjectId: current.applicantSubjectId
      }));
      if (anyBinding?.status === "revoked") {
        current = await forceStatus(current, "revoked", `binding revoked at block ${anyBinding.revokedAt?.blockNumber?.toString() ?? "?"}`, "binding_revoked", timestamp);
      }
    } else if (binding && !bindingAccountMatches && current.status === "active") {
      current = await forceStatus(current, "revoked", "active binding no longer points at the applicant address", "binding_revoked", timestamp);
    }

    if (current.status === "authorized" && bindingAccountMatches) {
      const materialized = await findOnChainAuthorizationEvidence(current);
      if (materialized) {
        const activatedEventExists = (await joinStore.listEvents(current.applicationId))
          .some((event) => event.type === "activated");
        const hasRecordedMaterialization = activatedEventExists ||
          current.txEvidence.some((entry) => entry.kind === current.authorizationKind && entry.status === "materialized");
        if (!hasRecordedMaterialization) {
          const evidence: StoreJoinTxEvidence[] = [
            ...current.txEvidence,
            {
              kind: current.authorizationKind,
              ...(materialized.txHash ? { txHash: materialized.txHash } : {}),
              planId: current.planId,
              slot: current.authorizationKind === "stage_executor" ? (current.stageId ?? current.roleSlotId) : current.roleSlotId,
              address: current.applicantAddress,
              status: "materialized",
              recordedAt: timestamp,
              materializedAt: timestamp
            }
          ];
          const refreshed = { ...current, status: "active" as StoreJoinApplicationStatus, txEvidence: evidence, updatedAt: timestamp };
          await joinStore.putApplication(refreshed);
          await appendEvent(refreshed.applicationId, "activated", undefined, undefined, materialized.txHash, timestamp);
          await emitAudit({
            action: "join.activated",
            applicationId: refreshed.applicationId,
            planId: refreshed.planId,
            outcome: "succeeded",
            metadata: { authorizationKind: refreshed.authorizationKind },
            createdAt: timestamp
          });
          current = refreshed;
        } else {
          current = { ...current, status: "active" };
        }
      }
    }

    return {
      application: current,
      events: await joinStore.listEvents(current.applicationId),
      identityPairing: {
        bindingStatus: binding ? binding.status : (await hasAnyRevokedBinding(current.applicantSubjectId) ? "revoked" : "not_found"),
        ...(binding ? { bindingAccount: binding.account } : {}),
        ...(binding ? { bindingTxHash: binding.registeredAt.transactionHash } : {})
      }
    };
  }

  async function forceStatus(
    application: StoreJoinApplicationRecord,
    status: StoreJoinApplicationStatus,
    reason: string,
    eventType: StoreJoinApplicationEventRecord["type"],
    timestamp: string
  ): Promise<StoreJoinApplicationRecord> {
    const hasEvent = (await joinStore.listEvents(application.applicationId)).some((event) => event.type === eventType);
    const updated: StoreJoinApplicationRecord = {
      ...application,
      status,
      revocationReason: application.revocationReason ?? reason,
      updatedAt: timestamp
    };
    await joinStore.putApplication(updated);
    if (!hasEvent) {
      await appendEvent(application.applicationId, eventType, undefined, reason, undefined, timestamp);
    }
    return updated;
  }

  /**
   * 激活判定不是"任一订单存在 submitter==申请人"
   * 即通过——链上授权信号必须与申请的槽位对应：
   * - signal_submitter：authorization 的 (sourceId, signalId) 必须落在该
   *   roleSlot 的 orderPermissionTable 能力集合内；
   * - stage_executor：overlay 的 targetStageId 必须是申请的 stageId。
   */
  async function findOnChainAuthorizationEvidence(
    application: StoreJoinApplicationRecord
  ): Promise<{ readonly txHash?: Hex } | undefined> {
    const zhixu = await resolveZhixuForPlan(application.planId).catch(() => undefined);
    const slotPermissionKeys = new Set(
      (zhixu?.detail?.orderPermissionTable ?? [])
        .filter((entry) => entry.roleSlotId === application.roleSlotId)
        .map((entry) => `${productSignalSourceId(entry.source).toLowerCase()}:${productSignalId(entry.signalName).toLowerCase()}`)
    );
    const applicationStageId = application.stageId
      ? onchainStageId(application.stageId).toLowerCase()
      : undefined;
    const snapshot = await projectionStore.getOrderSnapshot();
    const orders = [...new Set(Object.values(snapshot.stateMachineOrders))]
      .filter((order) => order.planId.toLowerCase() === application.planId.toLowerCase());
    for (const order of orders) {
      if (application.authorizationKind === "signal_submitter") {
        for (const authorization of Object.values(order.authorizations)) {
          if (authorization.submitter.toLowerCase() !== application.applicantAddress.toLowerCase()) {
            continue;
          }
          const key = `${authorization.sourceId.toLowerCase()}:${authorization.signalId.toLowerCase()}`;
          // 槽位/信号对应：该 plan 无 schema 权限表可比对时 fail-closed
          //（不激活），不允许"同 plan 任意信号"充数。
          if (slotPermissionKeys.size === 0 || !slotPermissionKeys.has(key)) {
            continue;
          }
          return { txHash: authorization.authorizedAt.transactionHash };
        }
      } else {
        for (const overlay of Object.values(order.stageExecutorOverlays)) {
          if (overlay.activeExecutorWallet.toLowerCase() !== application.applicantAddress.toLowerCase()) {
            continue;
          }
          if (!applicationStageId || overlay.targetStageId.toLowerCase() !== applicationStageId) {
            continue;
          }
          return { txHash: overlay.updatedAt.transactionHash };
        }
      }
    }
    return undefined;
  }

  async function hasAnyRevokedBinding(subjectId: Hex): Promise<boolean> {
    const bindings = await projectionStore.listIdentityBindings({ subjectId });
    return bindings.some((entry) => entry.status === "revoked");
  }

  async function requireApplication(applicationId: string): Promise<StoreJoinApplicationRecord> {
    const application = await joinStore.getApplication(applicationId);
    if (!application) {
      throw new StoreJoinServiceError(404, "application_not_found", "join application not found");
    }
    return application;
  }

  async function requireReviewer(
    applicationId: string,
    actor: StoreJoinActor,
    auditAction: StoreJoinAuditEvent["action"]
  ): Promise<StoreJoinApplicationRecord> {
    const anchoredAddress = requireAnchored(actor);
    const application = await requireApplication(applicationId);
    const allowed = await options.publisherAccess.hasPublisherWriteAccess(application.planId, anchoredAddress);
    if (!allowed) {
      await emitAudit({
        action: auditAction,
        applicationId,
        planId: application.planId,
        actorAddress: anchoredAddress,
        outcome: "blocked",
        errorCode: "not_plan_publisher",
        createdAt: now().toISOString()
      });
      throw new StoreJoinServiceError(
        403,
        "not_plan_publisher",
        "only the plan publisher (or an active delegate) can review join applications",
        { planId: application.planId }
      );
    }
    return application;
  }

  /**
   * 红线（服务端强制，与前端抑制同口径）：
   * listing 已下架/未公开或锚核验冲突时，加入入口关闭。
   * 无 listing（未走上架流）时按链投影可查即放行——上架是 Store 经营动作，
   * 不是链上事实的前置。
   */
  async function assertJoinEntryAllowedNow(planId: Hex): Promise<void> {
    const gate = options.listingGate;
    if (!gate) {
      return;
    }
    const listing = await gate.getListingForPlan(planId).catch(() => undefined);
    if (listing && (listing.status === "delisted" || listing.anchorVerification.status === "conflict")) {
      throw new StoreJoinServiceError(
        409,
        "join_entry_suppressed",
        listing.status === "delisted"
          ? "this zhixu is delisted; the join entry is closed"
          : "listing anchors conflict with chain facts; the join entry is suppressed",
        { planId, listingStatus: listing.status }
      );
    }
  }

  async function resolveZhixuForPlan(planId: Hex): Promise<{ readonly zhixuId: string; readonly detail: Awaited<ReturnType<ProductService["getZhixu"]>> }> {
    const summaries = await options.productService.listZhixu();
    const summary = summaries.find((candidate) =>
      candidate.planPublication.planId.toLowerCase() === planId.toLowerCase()
    );
    if (!summary) {
      throw new StoreJoinServiceError(409, "zhixu_not_found", "no catalog zhixu matches this planId");
    }
    const detail = await options.productService.getZhixu(summary.zhixuId);
    if (!detail) {
      throw new StoreJoinServiceError(409, "zhixu_not_found", "zhixu detail is not resolvable for this planId");
    }
    return { zhixuId: summary.zhixuId, detail: detail as NonNullable<typeof detail> };
  }

  async function appendEvent(
    applicationId: string,
    type: StoreJoinApplicationEventRecord["type"],
    actor: StoreJoinActor | undefined,
    reason: string | undefined,
    txHash: Hex | undefined,
    timestamp: string
  ): Promise<void> {
    await joinStore.appendEvent({
      eventId: `joinevt_${randomUUID()}`,
      applicationId,
      type,
      ...(actor?.anchoredAddress ? { actorAddress: actor.anchoredAddress } : {}),
      ...(actor?.accountId ? { actorAccountId: actor.accountId } : {}),
      ...(actor?.authMode ? { actorAuthMode: actor.authMode } : {}),
      ...(reason ? { reason } : {}),
      ...(txHash ? { txHash } : {}),
      createdAt: timestamp
    });
  }

  async function emitAudit(event: StoreJoinAuditEvent): Promise<void> {
    if (options.audit) {
      await options.audit(event);
    }
  }
}

function requireAnchored(actor: StoreJoinActor): Address {
  if (!actor.anchoredAddress) {
    throw new StoreJoinServiceError(
      401,
      "store_address_anchor_required",
      "a session anchored to a wallet address is required; log in with a wallet session"
    );
  }
  return actor.anchoredAddress;
}

function assertTransition(status: StoreJoinApplicationStatus, next: StoreJoinApplicationStatus): void {
  if (status === "applied" && next === "under_review") {
    return;
  }
  throw new StoreJoinServiceError(409, "invalid_application_transition", `${status} application cannot transition to ${next}`);
}

function validateSlotAndStage(
  detail: NonNullable<Awaited<ReturnType<ProductService["getZhixu"]>>>,
  roleSlotId: string,
  authorizationKind: StoreJoinAuthorizationKind,
  stageId: string | undefined
): void {
  const slot = detail.roleSlots.find((candidate) => candidate.slotId === roleSlotId);
  if (!slot) {
    throw new StoreJoinServiceError(400, "invalid_role_slot", "roleSlotId does not exist on this zhixu");
  }
  if (authorizationKind === "stage_executor") {
    const stage = detail.stages.find((candidate) => candidate.stageId === stageId);
    if (!stage) {
      throw new StoreJoinServiceError(400, "invalid_stage", "stageId does not exist on this zhixu");
    }
  }
}

function selectActiveBinding(bindings: readonly IdentityBindingProjection[]): IdentityBindingProjection | undefined {
  return bindings.find((binding) => binding.status === "active");
}

function selectAnyBinding(bindings: readonly IdentityBindingProjection[]): IdentityBindingProjection | undefined {
  return bindings.find((binding) => binding.status === "revoked") ?? bindings[0];
}

function deriveSubjectForAddress(address: Address): Hex {
  return keccak256Hex(`uvp:store:join:subject:v1:${address.toLowerCase()}`);
}

function planIdField(record: Record<string, unknown>): Hex {
  const value = requiredString(record, "planId");
  try {
    return normalizeBytes32(value, "planId");
  } catch {
    throw new StoreJoinServiceError(400, "invalid_body", "planId must be a bytes32 hex value");
  }
}

function optionalBytes32(record: Record<string, unknown>, field: string): Hex | undefined {
  const value = optionalString(record, field);
  if (!value) {
    return undefined;
  }
  try {
    return normalizeBytes32(value, field);
  } catch {
    throw new StoreJoinServiceError(400, "invalid_body", `${field} must be a bytes32 hex value`);
  }
}

function parseAuthorizationKind(value: string): StoreJoinAuthorizationKind {
  if (value === "signal_submitter" || value === "stage_executor") {
    return value;
  }
  throw new StoreJoinServiceError(400, "invalid_body", "authorizationKind must be signal_submitter or stage_executor");
}

function requireBodyRecord(body: unknown): Record<string, unknown> {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  throw new StoreJoinServiceError(400, "invalid_body", "request body must be a JSON object");
}

function requiredString(record: Record<string, unknown>, field: string): string {
  const value = optionalString(record, field);
  if (!value) {
    throw new StoreJoinServiceError(400, "invalid_body", `${field} must be a non-empty string`);
  }
  return value;
}

function optionalString(record: Record<string, unknown>, field: string): string | undefined {
  if (!Object.hasOwn(record, field)) {
    return undefined;
  }
  const value = record[field];
  if (value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new StoreJoinServiceError(400, "invalid_body", `${field} must be a string`);
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
