import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { redactErrorMessage, redactSecrets } from "../security/redaction.js";
import type {
  NotificationDispatcher,
  NotificationDispatchRequest,
  NotificationDispatchResult
} from "./service.js";

export const NOTIFICATION_WEBHOOK_SIGNATURE_HEADER = "x-uvp-webhook-signature";
export const NOTIFICATION_WEBHOOK_TIMESTAMP_HEADER = "x-uvp-webhook-timestamp";
export const NOTIFICATION_WEBHOOK_NONCE_HEADER = "x-uvp-webhook-nonce";

export const NOTIFICATION_WEBHOOK_TIMESTAMP_TOLERANCE_MS = 5 * 60_000;
const NOTIFICATION_WEBHOOK_REPLAY_MAX_NONCES = 10_000;

export interface WebhookNotificationDispatcherOptions {
  readonly url: string;
  readonly secret?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
}

export interface WebhookSignatureFields {
  readonly timestamp: string;
  readonly nonce: string;
}

export function newWebhookSignatureFields(nowMs: () => number = Date.now): WebhookSignatureFields {
  return {
    timestamp: Math.floor(nowMs() / 1000).toString(),
    nonce: randomBytes(16).toString("hex")
  };
}

export function signWebhookBody(
  secret: string,
  body: string | Uint8Array,
  fields: WebhookSignatureFields
): string {
  return `sha256=${createHmac("sha256", secret)
    .update(webhookSignedPayload(body, fields))
    .digest("hex")}`;
}

function webhookSignedPayload(body: string | Uint8Array, fields: WebhookSignatureFields): string {
  return `${fields.timestamp}.${fields.nonce}.${typeof body === "string" ? body : Buffer.from(body).toString("utf8")}`;
}

export interface VerifyWebhookSignatureOptions {
  readonly timestamp?: string;
  readonly nonce?: string;
  readonly nowMs?: () => number;
  readonly toleranceMs?: number;
}

export function verifyWebhookSignature(
  body: string | Uint8Array,
  signature: string | undefined,
  secret: string,
  options: VerifyWebhookSignatureOptions = {}
): boolean {
  if (!signature || !secret) return false;
  const match = /^sha256=([0-9a-f]{64})$/i.exec(signature.trim());
  if (!match) return false;
  const timestamp = options.timestamp?.trim();
  const nonce = options.nonce?.trim();
  if (!timestamp || !/^(0|[1-9][0-9]{0,9})$/.test(timestamp)) return false;
  if (!nonce || !/^[0-9a-f]{16,64}$/i.test(nonce)) return false;

  const nowMs = (options.nowMs ?? Date.now)();
  const toleranceMs = options.toleranceMs ?? NOTIFICATION_WEBHOOK_TIMESTAMP_TOLERANCE_MS;
  const timestampMs = Number(timestamp) * 1000;
  if (Math.abs(nowMs - timestampMs) > toleranceMs) return false;

  const expected = createHmac("sha256", secret)
    .update(webhookSignedPayload(body, { timestamp, nonce }))
    .digest();
  const supplied = Buffer.from(match[1]!, "hex");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export interface WebhookReplayGuard {
  observe(nonce: string, timestampMs: number, nowMs?: number): boolean;
}

export function createWebhookReplayGuard(options: {
  readonly toleranceMs?: number;
  readonly maxTrackedNonces?: number;
} = {}): WebhookReplayGuard {
  const toleranceMs = options.toleranceMs ?? NOTIFICATION_WEBHOOK_TIMESTAMP_TOLERANCE_MS;
  const maxTrackedNonces = options.maxTrackedNonces ?? NOTIFICATION_WEBHOOK_REPLAY_MAX_NONCES;
  const seen = new Map<string, number>();
  return {
    observe(nonce: string, timestampMs: number, nowMs: number = Date.now()): boolean {
      const previous = seen.get(nonce);
      if (previous !== undefined && Math.abs(nowMs - previous) <= toleranceMs) {
        return false;
      }
      seen.delete(nonce);
      seen.set(nonce, timestampMs);
      if (seen.size > maxTrackedNonces) {
        for (const [trackedNonce, observedMs] of seen) {
          if (seen.size <= maxTrackedNonces) {
            break;
          }
          if (Math.abs(nowMs - observedMs) > toleranceMs) {
            seen.delete(trackedNonce);
          }
        }
        while (seen.size > maxTrackedNonces) {
          const oldest = seen.keys().next().value;
          if (oldest === undefined) {
            break;
          }
          seen.delete(oldest);
        }
      }
      return true;
    }
  };
}

export class WebhookNotificationDispatcher implements NotificationDispatcher {
  readonly #url: string;
  readonly #secret: string | undefined;
  readonly #timeoutMs: number;
  readonly #fetchImpl: typeof fetch;
  readonly #now: () => Date;

  constructor(options: WebhookNotificationDispatcherOptions) {
    this.#url = options.url;
    this.#secret = options.secret;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#fetchImpl = options.fetchImpl ?? fetch;
    this.#now = options.now ?? (() => new Date());
  }

  async send(request: NotificationDispatchRequest): Promise<NotificationDispatchResult> {
    const nowMs = this.#now().getTime();
    const body = JSON.stringify(redactSecrets(webhookBodyFrom(request, this.#now().toISOString())));
    const headers: Record<string, string> = {
      "content-type": "application/json"
    };
    if (this.#secret) {
      const fields = newWebhookSignatureFields(() => nowMs);
      headers[NOTIFICATION_WEBHOOK_SIGNATURE_HEADER] = signWebhookBody(this.#secret, body, fields);
      headers[NOTIFICATION_WEBHOOK_TIMESTAMP_HEADER] = fields.timestamp;
      headers[NOTIFICATION_WEBHOOK_NONCE_HEADER] = fields.nonce;
    }

    try {
      const response = await this.#fetchImpl(this.#url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(this.#timeoutMs)
      });
      if (!response.ok) {
        return {
          ok: false,
          error: `webhook_http_${response.status}`
        };
      }
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: redactErrorMessage(
          error instanceof Error ? error.message : "webhook dispatch failed"
        )
      };
    }
  }
}

function webhookBodyFrom(request: NotificationDispatchRequest, sentAt: string): Record<string, unknown> {
  const record = request.record;
  return {
    schemaVersion: "uvp.notification-webhook.v1",
    sentAt,
    deliveryId: record.deliveryId,
    kind: record.kind,
    status: record.status,
    orderId: record.orderId,
    ...(record.taskId ? { taskId: record.taskId } : {}),
    chainId: record.chainId,
    stateMachineAddress: record.stateMachineAddress,
    ...(record.supplierSubjectId ? { supplierSubjectId: record.supplierSubjectId } : {}),
    ...(record.transportType ? { transportType: record.transportType } : {}),
    ...(record.activationStatus ? { activationStatus: record.activationStatus } : {}),
    ...(record.reason ? { reason: record.reason } : {}),
    ...(record.lastError ? { lastError: record.lastError } : {}),
    attempts: record.attempts,
    proof: {
      eventName: record.payload.proof.eventName,
      chainId: record.payload.proof.chainId,
      contractAddress: record.payload.proof.contractAddress,
      blockNumber: record.payload.proof.blockNumber,
      transactionHash: record.payload.proof.transactionHash,
      logIndex: record.payload.proof.logIndex
    }
  };
}
