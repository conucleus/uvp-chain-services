import { keccak256, stringToBytes } from "viem";
import {
  stateMachineScopedKey,
  type ProjectionSnapshot,
  type StateMachineDockedSignalBindingProjection,
  type StateMachineOrderProjection,
  type StateMachineSignalProjection
} from "../indexer/projections.js";
import type { TrustProjectionSnapshot } from "../indexer/trust-projections.js";
import { noopLogger, type Address, type Hex, type Logger } from "../shared/types.js";
import type {
  DockedSignalAutomationConfig,
  DockedSignalAutomationSummary,
  DockedSignalBroadcastAdapter,
  DockedSignalBroadcastResult,
  DockedSignalCandidate
} from "./types.js";

export interface DockedSignalAutomationServiceOptions {
  readonly config: DockedSignalAutomationConfig;
  readonly dockingModuleAddress?: Address;
  readonly broadcastAdapter: DockedSignalBroadcastAdapter;
  readonly logger?: Logger;
}

export interface DockedSignalAutomationService {
  processProjection(
    snapshot: ProjectionSnapshot,
    trustSnapshot?: TrustProjectionSnapshot
  ): Promise<DockedSignalAutomationSummary>;
}

const ZERO_SUMMARY: DockedSignalAutomationSummary = {
  enabled: false,
  scannedBindings: 0,
  candidateCount: 0,
  submittedCount: 0,
  confirmedCount: 0,
  skippedCount: 0,
  failedCount: 0,
  capped: false
};

export function createDockedSignalAutomationService(
  options: DockedSignalAutomationServiceOptions
): DockedSignalAutomationService {
  const logger = options.logger ?? noopLogger;
  const inFlight = new Set<string>();
  const submitted = new Set<string>();

  return {
    async processProjection(snapshot, trustSnapshot): Promise<DockedSignalAutomationSummary> {
      if (!options.config.enabled || !options.dockingModuleAddress || options.config.maxCandidatesPerRun <= 0) {
        return { ...ZERO_SUMMARY, enabled: options.config.enabled };
      }

      reconcileSubmitted(snapshot, submitted, {
        requireTrustedPlans: options.config.requireTrustedPlans,
        ...(trustSnapshot ? { trustSnapshot } : {})
      });
      const discovery = discoverDockedSignalCandidates(snapshot, {
        dockingModuleAddress: options.dockingModuleAddress,
        maxCandidates: options.config.maxCandidatesPerRun,
        excludedCandidateIds: new Set([...inFlight, ...submitted]),
        requireTrustedPlans: options.config.requireTrustedPlans,
        ...(trustSnapshot ? { trustSnapshot } : {})
      });

      const results: DockedSignalBroadcastResult[] = [];
      for (const candidate of discovery.candidates) {
        inFlight.add(candidate.candidateId);
        try {
          const result = await options.broadcastAdapter.broadcast(candidate);
          results.push(result);
          if (result.status === "submitted" || result.status === "confirmed") {
            submitted.add(candidate.candidateId);
          }
        } catch (error) {
          logger.warn("docked signal automation failed", {
            candidateId: candidate.candidateId,
            message: error instanceof Error ? error.message : "unknown error"
          });
          results.push({
            status: "failed",
            candidateId: candidate.candidateId,
            errorCode: "docked_signal_automation_failed",
            reason: error instanceof Error ? error.message : "unknown error",
            attempt: {
              status: "failed",
              errorCode: "docked_signal_automation_failed",
              message: error instanceof Error ? error.message : "unknown error",
              retryable: true
            }
          });
        } finally {
          inFlight.delete(candidate.candidateId);
        }
      }

      const summary = {
        enabled: true,
        scannedBindings: discovery.scannedBindings,
        candidateCount: discovery.candidates.length,
        submittedCount: results.filter((result) => result.status === "submitted").length,
        confirmedCount: results.filter((result) => result.status === "confirmed").length,
        skippedCount: results.filter((result) => result.status === "skipped").length,
        failedCount: results.filter((result) => result.status === "failed").length,
        capped: discovery.capped
      };
      if (summary.candidateCount > 0 || summary.capped || summary.failedCount > 0) {
        logger.info("docked signal automation processed projection", summary);
      }
      return summary;
    }
  };
}

export interface DockedSignalCandidateDiscoveryOptions {
  readonly dockingModuleAddress: Address;
  readonly maxCandidates: number;
  readonly excludedCandidateIds?: ReadonlySet<string>;
  readonly requireTrustedPlans?: boolean;
  readonly trustSnapshot?: TrustProjectionSnapshot;
}

export interface DockedSignalCandidateDiscovery {
  readonly scannedBindings: number;
  readonly candidates: readonly DockedSignalCandidate[];
  readonly capped: boolean;
}

export function discoverDockedSignalCandidates(
  snapshot: ProjectionSnapshot,
  options: DockedSignalCandidateDiscoveryOptions
): DockedSignalCandidateDiscovery {
  const candidates: DockedSignalCandidate[] = [];
  let scannedBindings = 0;
  let capped = false;

  for (const localOrder of Object.values(snapshot.stateMachineOrders)) {
    for (const link of Object.values(localOrder.dockedOrderLinks)) {
      const linkedOrder = snapshot.stateMachineOrders[
        stateMachineScopedKey(localOrder.chainId, localOrder.contractAddress, link.linkedOrderId)
      ];
      if (!linkedOrder) {
        continue;
      }
      if (!ordersPassTrustPolicy(localOrder, linkedOrder, options)) {
        continue;
      }
      for (const binding of Object.values(link.signalBindings)) {
        scannedBindings += 1;
        if (hasSignal(localOrder, binding.localSourceId, binding.localSignalId)) {
          continue;
        }
        const linkedSignal = signalFor(linkedOrder, binding.linkedSourceId, binding.linkedSignalId);
        if (!linkedSignal) {
          continue;
        }
        const candidateId = dockedSignalCandidateId(localOrder, binding, linkedSignal);
        if (options.excludedCandidateIds?.has(candidateId)) {
          continue;
        }
        if (candidates.length >= options.maxCandidates) {
          capped = true;
          continue;
        }
        candidates.push({
          candidateId,
          chainId: localOrder.chainId,
          dockingModuleAddress: options.dockingModuleAddress,
          localOrder,
          linkedOrder,
          binding,
          linkedSignal,
          idempotencyKey: dockedSignalIdempotencyKey(localOrder, binding, linkedSignal)
        });
      }
    }
  }

  return { scannedBindings, candidates, capped };
}

export function dockedSignalIdempotencyKey(
  localOrder: StateMachineOrderProjection,
  binding: StateMachineDockedSignalBindingProjection,
  linkedSignal: StateMachineSignalProjection
): Hex {
  return keccak256(stringToBytes([
    "uvp:docked-signal:idempotency:v1",
    String(localOrder.chainId),
    localOrder.contractAddress,
    binding.localOrderId,
    binding.localSourceId,
    binding.localSignalId,
    binding.linkedOrderId,
    binding.linkedSourceId,
    binding.linkedSignalId,
    linkedSignal.idempotencyKey
  ].join("|"))) as Hex;
}

function dockedSignalCandidateId(
  localOrder: StateMachineOrderProjection,
  binding: StateMachineDockedSignalBindingProjection,
  linkedSignal: StateMachineSignalProjection
): Hex {
  return keccak256(stringToBytes([
    "uvp:docked-signal:candidate:v1",
    String(localOrder.chainId),
    localOrder.contractAddress,
    binding.localOrderId,
    binding.localSourceId,
    binding.localSignalId,
    binding.linkedOrderId,
    binding.linkedSourceId,
    binding.linkedSignalId,
    linkedSignal.proof.eventId
  ].join("|"))) as Hex;
}

function reconcileSubmitted(
  snapshot: ProjectionSnapshot,
  submitted: Set<string>,
  options: Pick<DockedSignalCandidateDiscoveryOptions, "requireTrustedPlans" | "trustSnapshot">
): void {
  for (const candidateId of [...submitted]) {
    if (!projectionStillNeedsCandidate(snapshot, candidateId, options)) {
      submitted.delete(candidateId);
    }
  }
}

function projectionStillNeedsCandidate(
  snapshot: ProjectionSnapshot,
  candidateId: string,
  options: Pick<DockedSignalCandidateDiscoveryOptions, "requireTrustedPlans" | "trustSnapshot">
): boolean {
  const discovery = discoverDockedSignalCandidates(snapshot, {
    dockingModuleAddress: "0x0000000000000000000000000000000000000000" as Address,
    maxCandidates: Number.MAX_SAFE_INTEGER,
    ...options
  });
  return discovery.candidates.some((candidate) => candidate.candidateId === candidateId);
}

function ordersPassTrustPolicy(
  localOrder: StateMachineOrderProjection,
  linkedOrder: StateMachineOrderProjection,
  options: DockedSignalCandidateDiscoveryOptions
): boolean {
  if (!options.requireTrustedPlans) {
    return true;
  }
  if (!options.trustSnapshot) {
    return false;
  }
  return isOrderPlanTrusted(options.trustSnapshot, localOrder) &&
    isOrderPlanTrusted(options.trustSnapshot, linkedOrder);
}

function isOrderPlanTrusted(
  trustSnapshot: TrustProjectionSnapshot,
  order: StateMachineOrderProjection
): boolean {
  if (!order.planHash) {
    return false;
  }
  const orderPlanHash = order.planHash;
  return Object.values(trustSnapshot.plans).some((plan) =>
    plan.status === "attested" &&
    !plan.revoked &&
    plan.planId.toLowerCase() === order.planId.toLowerCase() &&
    plan.planHash.toLowerCase() === orderPlanHash.toLowerCase()
  );
}

function hasSignal(order: StateMachineOrderProjection, sourceId: Hex, signalId: Hex): boolean {
  return Boolean(signalFor(order, sourceId, signalId));
}

function signalFor(
  order: StateMachineOrderProjection,
  sourceId: Hex,
  signalId: Hex
): StateMachineSignalProjection | undefined {
  return order.signals[signalKey(sourceId, signalId)];
}

function signalKey(sourceId: Hex, signalId: Hex): string {
  return `${sourceId.toLowerCase()}:${signalId.toLowerCase()}`;
}
