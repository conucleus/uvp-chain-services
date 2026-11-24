// RPC/viem and storage failures embed the full endpoint URL (provider path keys
// such as /v2/<key>, userinfo, and query secrets); every read surface and log
// line that relays such a failure exposes only the redacted form.

import { redactErrorMessage } from "@uvp-eth/service-runtime";

const EMBEDDED_URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>)\]]+/gi;
const REDACTED_URL = "[redacted:url]";

export function redactEndpointErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "unknown error");
  return redactErrorMessage(message)
    .replace(EMBEDDED_URL_PATTERN, REDACTED_URL)
    .replace(/\s+/g, " ")
    .trim();
}
