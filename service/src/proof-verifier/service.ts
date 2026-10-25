import { ConfigError, normalizeBytes32, type Hex } from "../shared/types.js";

export type ProofCheckStatus = "matched" | "missing" | "mismatch" | "invalid";

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

export function verifyProofBundle(bundle: ProofBundle): ProofVerificationResult {
  const checks = [
    compareHash("zhixuHash", bundle.zhixuHash),
    compareHash("metadataHash", bundle.metadataHash),
    compareHash("evidenceHash", bundle.evidenceHash)
  ];

  return {
    valid: checks.every((check) => check.status === "matched"),
    checks
  };
}

function compareHash(
  name: ProofCheck["name"],
  expectation: HashExpectation | undefined
): ProofCheck {
  if (!expectation?.actual && !expectation?.expected) {
    return { name, status: "missing" };
  }

  const actual = readHashSide(name, "actual", expectation.actual);
  const expected = readHashSide(name, "expected", expectation.expected);

  if (actual instanceof Error || expected instanceof Error) {
    return {
      name,
      status: "invalid",
      ...(actual instanceof Error ? {} : actual !== undefined ? { actual } : {}),
      ...(expected instanceof Error ? {} : expected !== undefined ? { expected } : {})
    };
  }

  if (!actual || !expected) {
    return {
      name,
      status: "mismatch",
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

function readHashSide(
  name: ProofCheck["name"],
  side: "actual" | "expected",
  value: Hex | undefined
): Hex | undefined | Error {
  if (!value) {
    return undefined;
  }
  try {
    return normalizeBytes32(value, `${name}.${side}`);
  } catch (error) {
    return error instanceof ConfigError ? error : new ConfigError(`${name}.${side} is not a 32-byte hex string`);
  }
}
