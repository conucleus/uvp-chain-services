import type {
  StateMachineDockedSignalBindingProjection,
  StateMachineOrderProjection,
  StateMachineSignalProjection
} from "../indexer/projections.js";
import type { Address, Hex } from "../shared/types.js";

export interface DockedSignalAutomationConfig {
  readonly enabled: boolean;
  readonly maxCandidatesPerRun: number;
  readonly maxGasPerTx?: bigint;
  readonly waitForReceipt: boolean;
}

export interface DockedSignalCandidate {
  readonly candidateId: Hex;
  readonly chainId: number;
  readonly dockingModuleAddress: Address;
  readonly localOrder: StateMachineOrderProjection;
  readonly linkedOrder: StateMachineOrderProjection;
  readonly binding: StateMachineDockedSignalBindingProjection;
  readonly linkedSignal: StateMachineSignalProjection;
  readonly idempotencyKey: Hex;
}

export type DockedSignalBroadcastStatus = "submitted" | "confirmed" | "skipped" | "failed";

export interface DockedSignalBroadcastAttempt {
  readonly status: DockedSignalBroadcastStatus;
  readonly gasPayer?: Address;
  readonly estimatedGas?: string;
  readonly txHash?: Hex;
  readonly blockNumber?: string;
  readonly errorCode?: string;
  readonly message?: string;
  readonly retryable: boolean;
}

export interface DockedSignalBroadcastResult {
  readonly status: DockedSignalBroadcastStatus;
  readonly candidateId: Hex;
  readonly txHash?: Hex;
  readonly blockNumber?: string;
  readonly errorCode?: string;
  readonly reason?: string;
  readonly attempt: DockedSignalBroadcastAttempt;
}

export interface DockedSignalBroadcastAdapter {
  broadcast(candidate: DockedSignalCandidate): Promise<DockedSignalBroadcastResult>;
}

export interface DockedSignalAutomationSummary {
  readonly enabled: boolean;
  readonly scannedBindings: number;
  readonly candidateCount: number;
  readonly submittedCount: number;
  readonly confirmedCount: number;
  readonly skippedCount: number;
  readonly failedCount: number;
  readonly capped: boolean;
}
