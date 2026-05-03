export function rowObject(row: unknown, context = "Postgres query"): Record<string, unknown> {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new Error(`${context} returned a malformed row`);
  }
  return row as Record<string, unknown>;
}

export function stringColumn(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`Postgres column ${key} must be a string`);
  }
  return value;
}

export function nullableStringColumn(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`Postgres column ${key} must be a string or null`);
  }
  return value;
}

export function optionalStringColumn(record: Record<string, unknown>, key: string): string | undefined {
  const value = nullableStringColumn(record, key);
  return value === null ? undefined : value;
}

export function numberColumn(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number") {
    throw new Error(`Postgres column ${key} must be a number`);
  }
  return value;
}

export function booleanColumn(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") {
    throw new Error(`Postgres column ${key} must be a boolean`);
  }
  return value;
}
