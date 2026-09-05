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
    // 簇 N 修正（审计三轮）：missing=invalid——缺一侧（或两侧）哈希的
    // 证明项不再被计为通过；只有全部 matched 才 valid。此前
    // `matched || missing` 让空证明/半证明恒真。
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

  const actual = expectation.actual ? normalizeBytes32(expectation.actual, `${name}.actual`) : undefined;
  const expected = expectation.expected ? normalizeBytes32(expectation.expected, `${name}.expected`) : undefined;

  if (!actual || !expected) {
    // 单侧缺失按 mismatch 记（材料不完整），两侧缺失记 missing。
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
