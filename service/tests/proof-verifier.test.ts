import { describe, expect, it } from "vitest";
import { verifyProofBundle } from "../src/proof-verifier/service.js";

const hashA = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const hashB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("proof verifier", () => {
  it("reports aligned metadata, evidence, and Zhixu hashes", () => {
    const result = verifyProofBundle({
      zhixuHash: { actual: hashA, expected: hashA },
      metadataHash: { actual: hashA, expected: hashA },
      evidenceHash: { actual: hashA, expected: hashA }
    });

    expect(result.valid).toBe(true);
    expect(result.checks.map((check) => check.status)).toEqual(["matched", "matched", "matched"]);
  });

  it("reports mismatches without deciding business state", () => {
    const result = verifyProofBundle({
      evidenceHash: { actual: hashA, expected: hashB }
    });

    expect(result.valid).toBe(false);
    expect(result.checks.find((check) => check.name === "evidenceHash")?.status).toBe("mismatch");
  });

  it("collapses malformed hash inputs into an invalid check instead of throwing", () => {
    // 契约：任何输入都产出 ProofVerificationResult——畸形哈希不抛
    // ConfigError 逃逸，折叠为 invalid 检查项且 valid=false。
    const result = verifyProofBundle({
      zhixuHash: { actual: "0x1234" as `0x${string}`, expected: hashA }
    });

    expect(result.valid).toBe(false);
    expect(result.checks.find((check) => check.name === "zhixuHash")?.status).toBe("invalid");
    expect(result.checks.find((check) => check.name === "metadataHash")?.status).toBe("missing");
  });
});
