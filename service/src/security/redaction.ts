import type { Logger } from "../shared/types.js";

const REDACTED = "[redacted]";
const REDACTED_CALLDATA = "[redacted:calldata]";
const REDACTED_EVIDENCE = "[redacted:evidence]";
const REDACTED_PRESIGNED_URL = "[redacted:presigned-url]";
const REDACTED_SECRET = "[redacted:secret]";

const SECRET_KEY_PATTERN = /(^|[_-])(private[_-]?key|secret|token|authorization|signature|admin[_-]?token|password)($|[_-])/i;
const CALLDATA_KEY_PATTERN = /(^|[_-])(calldata|raw[_-]?calldata|data|input)($|[_-])/i;
const EVIDENCE_PAYLOAD_KEY_PATTERN = /(^|[_-])(textpayload|base64payload|jsonpayload|evidence[_-]?plaintext|plaintext|raw[_-]?evidence|evidence[_-]?payload|file[_-]?bytes|bytes|content)($|[_-])/i;
const RPC_SECRET_PARAM_PATTERN = /^(api[_-]?key|apikey|access[_-]?token|auth|key|token|secret|signature|password|x-amz-signature|x-amz-credential|awsaccesskeyid|sig)$/i;
const PRESIGNED_URL_PARAM_PATTERN = /^(x-amz-signature|x-amz-credential|x-goog-signature|x-goog-credential|awsaccesskeyid|sig|signature)$/i;

export function redactSecrets<T>(value: T): T {
  return redactUnknown(value, undefined, new WeakSet()) as T;
}

export function redactErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "unknown error");
  return redactSecretLikeErrorHex(redactString(message));
}

export function createRedactingLogger(logger: Logger, enabled = true): Logger {
  if (!enabled) {
    return logger;
  }
  return {
    debug: (message, context) => logger.debug(redactString(message), redactContext(context)),
    info: (message, context) => logger.info(redactString(message), redactContext(context)),
    warn: (message, context) => logger.warn(redactString(message), redactContext(context)),
    error: (message, context) => logger.error(redactString(message), redactContext(context))
  };
}

function redactContext(context: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  return context ? redactSecrets(context) : undefined;
}

function redactUnknown(value: unknown, key: string | undefined, seen: WeakSet<object>): unknown {
  if (typeof value === "string") {
    return redactStringForKey(value, key);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return "[redacted:circular]";
  }
  seen.add(value);

  if (Array.isArray(value)) {
    const redactedArray = value.map((item) => redactUnknown(item, key, seen));
    seen.delete(value);
    return redactedArray;
  }

  const redacted: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    redacted[entryKey] = redactUnknown(entryValue, entryKey, seen);
  }
  seen.delete(value);
  return redacted;
}

function redactStringForKey(value: string, key: string | undefined): string {
  if (key && SECRET_KEY_PATTERN.test(key)) {
    return REDACTED_SECRET;
  }
  if (key && EVIDENCE_PAYLOAD_KEY_PATTERN.test(key)) {
    return REDACTED_EVIDENCE;
  }
  if (key && CALLDATA_KEY_PATTERN.test(key) && isLongHex(value)) {
    return REDACTED_CALLDATA;
  }
  return redactString(value);
}

function redactString(value: string): string {
  let redacted = redactRpcUrl(value);
  redacted = redacted.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED_SECRET}`);
  redacted = redacted.replace(
    /\b(api[_-]?key|apikey|access[_-]?token|auth|key|token|secret|signature|password)(\s*[:=]\s*)[^;,\s]+/gi,
    (_match, label: string, separator: string) => `${label}${separator}${REDACTED_SECRET}`
  );
  redacted = redacted.replace(/\b0x[0-9a-fA-F]{130}\b/g, REDACTED_SECRET);
  redacted = redacted.replace(/0x[0-9a-fA-F]{128,}/g, REDACTED_CALLDATA);
  return redacted;
}

function redactSecretLikeErrorHex(value: string): string {
  let redacted = value.replace(
    /\b(private[_\s-]?key|secret|token|authorization|signature|password)(\s*[:=]?\s*)0x[0-9a-fA-F]{64,}/gi,
    (_match, label: string, separator: string) => `${label}${separator}${REDACTED_SECRET}`
  );
  redacted = redacted.replace(/\b0x[0-9a-fA-F]{130}\b/g, REDACTED_SECRET);
  redacted = redacted.replace(/\b0x[0-9a-fA-F]{64}\b/g, REDACTED_SECRET);
  return redacted;
}

function redactRpcUrl(value: string): string {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    return value;
  }

  try {
    const url = new URL(value);
    if (url.username || url.password) {
      url.username = REDACTED;
      url.password = REDACTED;
    }
    if ([...url.searchParams.keys()].some((key) => PRESIGNED_URL_PARAM_PATTERN.test(key))) {
      return REDACTED_PRESIGNED_URL;
    }
    for (const key of [...url.searchParams.keys()]) {
      if (RPC_SECRET_PARAM_PATTERN.test(key)) {
        url.searchParams.set(key, REDACTED);
      }
    }
    return url.toString();
  } catch {
    return value;
  }
}

function isLongHex(value: string): boolean {
  return /^0x[0-9a-fA-F]{64,}$/.test(value);
}
