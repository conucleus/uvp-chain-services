import { randomUUID } from "node:crypto";
import { keccak256Hex, onchainStageId } from "@uvp-eth/compiler";
import { normalizeAddress, normalizeBytes32, type Address, type Hex } from "../../shared/types.js";
import type { ProjectionStore } from "../../storage/projection-store.js";
import type { IdentityBindingProjection } from "../../indexer/identity-projections.js";
import type { ProductService } from "../../product/application/service.js";
import { productSignalId, productSignalSourceId } from "../../product/query/bff/trigger.js";
import type { StoreSupplierService, StoreOperatorPrincipal } from "../suppliers/service.js";
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
import { StoreJoinServiceError, StoreJoinOpenApplicationExistsError } from "./types.js";

export interface StoreJoinServiceOptions {
  readonly projectionStore: ProjectionStore;
  readonly productService: ProductService;
  readonly supplierService: StoreSupplierService;
  readonly listingGate?: {
    readonly getListingForPlan: (planId: Hex) => Promise<{
      readonly status: "imported" | "public" | "rejected" | "delisted";
      readonly anchorVerification: {
        readonly status: "consistent" | "conflict" | "pending_indexing";
        readonly chainReadFailed?: boolean;
      };
    } | undefined>;
  };
  readonly publisherAccess: {
    hasPublisherWriteAccess(planId: Hex, address: Address): Promise<boolean>;
  };
  readonly joinStore: StoreJoinApplicationStore;
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
  const joinStore = options.joinStore;
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
      try {
        await joinStore.putApplication(application);
      } catch (error) {
        if (!(error instanceof StoreJoinOpenApplicationExistsError)) {
          throw error;
        }
        const winner = (await joinStore.listApplications({ planId, applicantAddress: anchoredAddress }))
          .find((row) => row.status === "applied" || row.status === "under_review");
        throw new StoreJoinServiceError(409, "application_exists", "an open application already exists for this address and plan", {
          applicationId: winner?.applicationId
        });
      }
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
      if (!(await joinStore.updateApplicationIfStatus(updated, application.status))) {
        const latest = await requireApplication(applicationId);
        if (latest.status !== "under_review") {
          throw new StoreJoinServiceError(409, "invalid_application_transition", `${latest.status} application cannot transition to under_review`);
        }
      }
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
      if (!(await joinStore.updateApplicationIfStatus(updated, "under_review"))) {
        const latest = await requireApplication(applicationId);
        await emitAudit({
          action: "join.approved",
          applicationId,
          planId: application.planId,
          actorAddress: anchoredAddress,
          outcome: "blocked",
          errorCode: "application_decision_conflict",
          metadata: { currentStatus: latest.status, identityRegistered: Boolean(pairing.txHash) },
          createdAt: now().toISOString()
        });
        throw new StoreJoinServiceError(
          409,
          "application_decision_conflict",
          `the application moved to ${latest.status} while the approval was pairing the on-chain identity; the registration evidence is retained, re-run the approval to reconcile`,
          { currentStatus: latest.status, identityRegistered: Boolean(pairing.txHash) }
        );
      }
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
      if (!(await joinStore.updateApplicationIfStatus(updated, application.status))) {
        const latest = await requireApplication(applicationId);
        throw new StoreJoinServiceError(
          409,
          "application_decision_conflict",
          `the application moved to ${latest.status} while the rejection was being recorded`,
          { currentStatus: latest.status }
        );
      }
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
      if (!(await joinStore.updateApplicationIfStatus(updated, application.status))) {
        const latest = await requireApplication(applicationId);
        if (latest.status !== "revoked") {
          throw new StoreJoinServiceError(
            409,
            "application_decision_conflict",
            `the application moved to ${latest.status} while the revocation was being recorded`,
            { currentStatus: latest.status }
          );
        }
      }
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

  async function ensureIdentityPairing(
    application: StoreJoinApplicationRecord,
    actor: StoreJoinActor
  ): Promise<{
    readonly supplierId?: string;
    readonly txHash?: Hex;
    readonly txLogId?: string;
    readonly executionMode?: "simulated" | "on_chain";
  }> {
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
    const existingMetadata = await options.supplierService.findSupplierMetadataBySubjectId(application.applicantSubjectId);
    if (existingMetadata?.wallet && existingMetadata.wallet.toLowerCase() !== application.applicantAddress.toLowerCase()) {
      throw new StoreJoinServiceError(
        409,
        "supplier_subject_conflict",
        "the applicant subject already belongs to a supplier record with a different wallet; approve would misattribute the application",
        { supplierId: existingMetadata.supplierId }
      );
    }
    if (!activeBinding && !actor.governanceAdmin) {
      await emitAudit({
        action: "join.approved",
        applicationId: application.applicationId,
        planId: application.planId,
        ...(actor.anchoredAddress ? { actorAddress: actor.anchoredAddress } : {}),
        outcome: "blocked",
        errorCode: "governance_admin_required",
        createdAt: now().toISOString()
      });
      throw new StoreJoinServiceError(
        403,
        "governance_admin_required",
        "on-chain identity registration requires a governance admin (the plan publisher approval alone must not broadcast identity bindings); re-run the approval with a governance-admin session or use the supplier identity-registration endpoint",
        { applicationId: application.applicationId }
      );
    }
    const needsOperationalReview = !existingMetadata || existingMetadata.reviewStatus !== "approved_for_broadcast";
    const actorHoldsOperatorCapability = OPERATOR_LEVELS.has(actor.accessLevel);
    if (!activeBinding && needsOperationalReview && !actorHoldsOperatorCapability) {
      throw new StoreJoinServiceError(
        409,
        "supplier_review_required",
        "the supplier has not passed Store operational review (approved_for_broadcast); complete /store/suppliers/{id}/review with an operator session or re-run the approval with an operator-capable reviewer",
        { supplierId: existingMetadata?.supplierId, applicationId: application.applicationId }
      );
    }
    const principal: StoreOperatorPrincipal = {
      operatorId: actor.anchoredAddress ?? actor.principalId ?? "join-reviewer",
      role: actor.governanceAdmin
        ? "governance_admin"
        : actor.accessLevel === "store_admin"
          ? "store_admin"
          : actor.accessLevel === "store_operator"
            ? "store_operator"
            : "plan_publisher"
    };
    let supplierId = existingMetadata?.supplierId;
    if (!existingMetadata) {
      const created = await options.supplierService.createSupplier(
        {
          supplierSubjectId: application.applicantSubjectId,
          displayName: application.applicantDisplayName ?? `供应商 ${application.applicantAddress.slice(0, 10)}`,
          wallet: application.applicantAddress,
          supportedRoleSlotIds: [application.roleSlotId],
          ...(application.stageId ? { supportedStageIds: [application.stageId] } : {}),
          reviewStatus: activeBinding ? "approved_for_broadcast" : "submitted"
        },
        principal
      );
      supplierId = created.supplier.supplierId;
    }

    if (activeBinding) {
      return {
        ...(supplierId ? { supplierId } : {}),
        txHash: activeBinding.registeredAt.transactionHash,
        executionMode: "on_chain"
      };
    }

    if (needsOperationalReview) {
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
    const registration = await options.supplierService.requestIdentityRegistration(
      supplierId!,
      { wallet: application.applicantAddress },
      principal
    );
    const registrationBroadcast = (registration.governance as { readonly broadcast?: { readonly status?: string; readonly errorCode?: string } }).broadcast;
    if (registrationBroadcast?.status === "failed") {
      throw new StoreJoinServiceError(
        502,
        "identity_registration_broadcast_failed",
        "on-chain identity registration broadcast failed; the application stays under review and the approval can be retried",
        {
          applicationId: application.applicationId,
          ...(registrationBroadcast.errorCode ? { errorCode: registrationBroadcast.errorCode } : {})
        }
      );
    }
    const log = (registration.governance as { readonly log?: { readonly txHash?: Hex; readonly txLogId?: string; readonly executionMode?: string } }).log;
    return {
      ...(supplierId ? { supplierId } : {}),
      ...(log?.txHash ? { txHash: log.txHash } : {}),
      ...(log?.txLogId ? { txLogId: log.txLogId } : {}),
      ...(log?.executionMode === "on_chain" || log?.executionMode === "simulated" ? { executionMode: log.executionMode } : {})
    };
  }

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
          if (await joinStore.updateApplicationIfStatus(refreshed, current.status)) {
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
            current = await requireApplication(current.applicationId);
          }
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
    if (await joinStore.updateApplicationIfStatus(updated, application.status)) {
      if (!hasEvent) {
        await appendEvent(application.applicationId, eventType, undefined, reason, undefined, timestamp);
      }
      return updated;
    }
    return requireApplication(application.applicationId);
  }

  async function findOnChainAuthorizationEvidence(
    application: StoreJoinApplicationRecord
  ): Promise<{ readonly txHash?: Hex } | undefined> {
    const zhixu = await resolveZhixuForPlan(application.planId).catch(() => undefined);
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

  async function assertJoinEntryAllowedNow(planId: Hex): Promise<void> {
    const gate = options.listingGate;
    if (!gate) {
      return;
    }
    let listing: Awaited<ReturnType<typeof gate.getListingForPlan>> | undefined;
    try {
      listing = await gate.getListingForPlan(planId);
    } catch {
      throw new StoreJoinServiceError(
        503,
        "listing_gate_unavailable",
        "the join listing gate could not read the listing state; the join entry stays closed until the listing read recovers",
        { planId }
      );
    }
    if (!listing) {
      return;
    }
    if (listing.anchorVerification.chainReadFailed === true) {
      throw new StoreJoinServiceError(
        409,
        "join_entry_suppressed",
        "listing chain read is configured but failing; the join entry is suppressed until the chain read recovers",
        { planId, listingStatus: listing.status }
      );
    }
    if (listing.status !== "public" || listing.anchorVerification.status === "conflict") {
      throw new StoreJoinServiceError(
        409,
        "join_entry_suppressed",
        listing.status === "delisted"
          ? "this zhixu is delisted; the join entry is closed"
          : listing.anchorVerification.status === "conflict"
            ? "listing anchors conflict with chain facts; the join entry is suppressed"
            : "this zhixu listing is not public; the join entry is closed until the listing review completes",
        { planId, listingStatus: listing.status }
      );
    }
  }

  async function resolveZhixuForPlan(planId: Hex): Promise<{ readonly zhixuId: string; readonly detail: Awaited<ReturnType<ProductService["getZhixu"]>> }> {
    const summaries = await options.productService.listZhixu();
    const matches = summaries.filter((candidate) =>
      candidate.planPublication.planId.toLowerCase() === planId.toLowerCase()
    );
    if (matches.length === 0) {
      throw new StoreJoinServiceError(409, "zhixu_not_found", "no catalog zhixu matches this planId");
    }
    if (matches.length > 1) {
      throw new StoreJoinServiceError(
        409,
        "plan_projection_ambiguous",
        "planId matches multiple zhixu catalog entries; the join target cannot be attributed uniquely",
        { planId, matches: matches.length }
      );
    }
    const detail = await options.productService.getZhixu(matches[0]!.zhixuId);
    if (!detail) {
      throw new StoreJoinServiceError(409, "zhixu_not_found", "zhixu detail is not resolvable for this planId");
    }
    return { zhixuId: matches[0]!.zhixuId, detail: detail as NonNullable<typeof detail> };
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
