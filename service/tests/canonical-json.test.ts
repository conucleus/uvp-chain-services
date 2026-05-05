import { describe, expect, it } from "vitest";
import { canonicalJson, hashCanonicalJson } from "../src/shared/canonical-json.js";

describe("shared canonical JSON", () => {
  it("sorts nested object keys consistently", () => {
    const left = {
      z: 2,
      a: {
        c: 3,
        b: [{ y: 2, x: 1 }]
      }
    };
    const right = {
      a: {
        b: [{ x: 1, y: 2 }],
        c: 3
      },
      z: 2
    };

    expect(canonicalJson(left)).toBe(canonicalJson(right));
    expect(hashCanonicalJson(left, "canonicalHash")).toBe(hashCanonicalJson(right, "canonicalHash"));
  });
});
