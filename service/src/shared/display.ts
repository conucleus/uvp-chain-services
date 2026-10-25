const BYTES32_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const PRINTABLE_ASCII_PATTERN = /^[\x20-\x7E]+$/;
const DISPLAYABLE_UNICODE_PATTERN =
  /^[\p{Letter}\p{Number}\p{Punctuation}\p{Separator}]+$/u;

export function decodeBytes32Text(value: string): string | undefined {
  if (!BYTES32_PATTERN.test(value)) {
    return undefined;
  }
  const bytes = Buffer.from(value.slice(2), "hex");
  const end = bytes.indexOf(0);
  const text = (end >= 0 ? bytes.subarray(0, end) : bytes)
    .toString("utf8")
    .trim();
  if (text.length === 0) {
    return undefined;
  }
  return PRINTABLE_ASCII_PATTERN.test(text) ||
      DISPLAYABLE_UNICODE_PATTERN.test(text)
    ? text
    : undefined;
}

export function shortBytes32(value: string): string {
  return value.length > 18
    ? `${value.slice(0, 8)}...${value.slice(-8)}`
    : value;
}

export function displayBytes32(value: string | undefined, fallback = ""): string {
  if (!value) {
    return fallback;
  }
  if (!BYTES32_PATTERN.test(value)) {
    return value;
  }
  const text = decodeBytes32Text(value);
  if (text !== undefined) {
    return text;
  }
  return fallback ? `${fallback} ${shortBytes32(value)}` : shortBytes32(value);
}
