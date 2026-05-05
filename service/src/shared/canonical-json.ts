import { canonicalStringify, keccak256Hex } from "@uvp-eth/compiler";
import { normalizeBytes32, type Hex } from "./types.js";

export function canonicalJson(value: unknown): string {
  return canonicalStringify(value);
}

export function hashCanonicalJson(value: unknown, fieldName: string): Hex {
  return normalizeBytes32(keccak256Hex(canonicalJson(value)), fieldName);
}
