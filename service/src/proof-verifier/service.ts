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
    // missing=invalid：缺任一侧（或两侧）哈希的证明项不算通过；
    // 只有全部 matched 才 valid，空证明/半证明不得恒真。
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

  // 契约：任何输入都产出 ProofVerificationResult——畸形哈希（非 32 字节
  // hex）折叠为 invalid 检查项而不是抛 ConfigError 逃逸调用方；valid 只
  // 认全部 matched，invalid 自然判 false。
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

/** 单侧哈希读取：缺失返回 undefined，畸形返回 Error（由调用方折叠为
 * invalid），合法返回规范化小写 hex。 */
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
