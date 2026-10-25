import type { Address, Hex } from "../shared/types.js";

export interface TimerKeeperConfig {
  readonly enabled: boolean;
  readonly pollIntervalMs: number;
  readonly maxCandidatesPerRun: number;
  readonly maxGasPerTx?: bigint;
  readonly redeliveryWindowMs: number;
  readonly privateKeyEnv: string;
  readonly expectedAddress?: Address;
}

export interface TimerPokeTarget {
  readonly planId: Hex;
  readonly orderId: Hex;
  readonly hookId: Hex;
  readonly gas?: bigint;
}

export interface TimerPokeOutcome {
  readonly txHash: Hex;
  readonly receipt: "confirmed" | "unknown";
}

export class TimerPokeReceiptRevertedError extends Error {
  override readonly name = "TimerPokeReceiptRevertedError";

  constructor(message: string) {
    super(message);
  }
}

export interface TimerKeeperSubmitter {
  pokeTimer(target: TimerPokeTarget): Promise<TimerPokeOutcome>;
}

export interface TimerKeeperRunSummary {
  scannedOrders: number;
  waitingHooks: number;
  pokeCandidates: number;
  attempted: number;
  submitted: number;
  receiptReverted: number;
  receiptUnknown: number;
  deduplicated: number;
  converged: string[];
  skipped: string[];
}
