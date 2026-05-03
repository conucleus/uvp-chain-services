const BIGINT_TAG = "__uvp_storage_bigint__";

export function stringifyStorageJson(value: unknown): string {
  return JSON.stringify(value, (_key, current) => {
    if (typeof current === "bigint") {
      return { [BIGINT_TAG]: current.toString() };
    }
    return current;
  });
}

export function parseStorageJson<TValue>(raw: string): TValue {
  return JSON.parse(raw, (_key, current: unknown) => {
    if (isBigIntRecord(current)) {
      return BigInt(current[BIGINT_TAG]);
    }
    return current;
  }) as TValue;
}

function isBigIntRecord(value: unknown): value is Record<typeof BIGINT_TAG, string> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>)[BIGINT_TAG] === "string"
  );
}
