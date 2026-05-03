import { loadConfigFromEnv } from "../config/index.js";
import { isDirectRun } from "../shared/runtime.js";
import {
  consoleLogger,
  noopLogger,
  normalizeBytes32,
  type Hex,
  type LifecycleService,
  type Logger
} from "../shared/types.js";

export type ProofCheckStatus = "matched" | "missing" | "mismatch";

export interface HashExpectation {
  readonly actual?: Hex;
  readonly expected?: Hex;
}

export interface ProofBundle {
  readonly zhixuHash?: HashExpectation;
  readonly metadataHash?: HashExpectation;
  readonly evidenceHash?: HashExpectation;
}

export interface ProofCheck {
  readonly name: "zhixuHash" | "metadataHash" | "evidenceHash";
  readonly status: ProofCheckStatus;
  readonly actual?: Hex;
  readonly expected?: Hex;
}

export interface ProofVerificationResult {
  readonly valid: boolean;
  readonly checks: readonly ProofCheck[];
}

export class ProofVerifierService implements LifecycleService {
  readonly name = "proof-verifier";

  #running = false;
  readonly #logger: Logger;

  constructor(logger: Logger = noopLogger) {
    this.#logger = logger;
  }

  async start(): Promise<void> {
    this.#running = true;
    this.#logger.info("proof verifier started");
  }

  async stop(): Promise<void> {
    this.#running = false;
    this.#logger.info("proof verifier stopped");
  }

  verify(bundle: ProofBundle): ProofVerificationResult {
    return verifyProofBundle(bundle);
  }

  get running(): boolean {
    return this.#running;
  }
}

export function verifyProofBundle(bundle: ProofBundle): ProofVerificationResult {
  const checks = [
    compareHash("zhixuHash", bundle.zhixuHash),
    compareHash("metadataHash", bundle.metadataHash),
    compareHash("evidenceHash", bundle.evidenceHash)
  ];

  return {
    valid: checks.every((check) => check.status === "matched" || check.status === "missing"),
    checks
  };
}

export function createProofVerifierService(logger?: Logger): ProofVerifierService {
  return new ProofVerifierService(logger);
}

function compareHash(
  name: ProofCheck["name"],
  expectation: HashExpectation | undefined
): ProofCheck {
  if (!expectation?.actual && !expectation?.expected) {
    return { name, status: "missing" };
  }

  const actual = expectation.actual ? normalizeBytes32(expectation.actual, `${name}.actual`) : undefined;
  const expected = expectation.expected ? normalizeBytes32(expectation.expected, `${name}.expected`) : undefined;

  if (!actual || !expected) {
    return {
      name,
      status: "missing",
      ...(actual ? { actual } : {}),
      ...(expected ? { expected } : {})
    };
  }

  return {
    name,
    status: actual === expected ? "matched" : "mismatch",
    actual,
    expected
  };
}

async function main(): Promise<void> {
  const config = loadConfigFromEnv();
  consoleLogger.info("proof verifier framework ready", {
    chainId: config.network.chainId
  });
}

if (isDirectRun(import.meta.url)) {
  void main();
}
