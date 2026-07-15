import { normalizeBytes32, type Hex } from "../shared/types.js";

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
