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

/** 与 executor-kit 的 DEFAULT_WEBHOOK_TIMESTAMP_TOLERANCE_MS 一致：±5 分钟。 */
export const NOTIFICATION_WEBHOOK_TIMESTAMP_TOLERANCE_MS = 5 * 60_000;
const NOTIFICATION_WEBHOOK_REPLAY_MAX_NONCES = 10_000;

export interface WebhookNotificationDispatcherOptions {
  readonly url: string;
  /** 可选：配置后以 timestamp.nonce.body 计算 HMAC-SHA256 并附带三个签名头。 */
  readonly secret?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
}

/**
 * 时间戳+nonce 的 HMAC 签名字段。裸 body HMAC 可被永久重放：截获
 * (body, signature) 即可在任意时刻重投。签名覆盖 timestamp.nonce.body，
 * 时间戳超出容窗即拒绝，nonce 经 replay guard 在窗口内单次消费——
 * 截获的请求随窗口一起失效。
 */
export interface WebhookSignatureFields {
  /** Unix 秒，随时间戳头发送。 */
  readonly timestamp: string;
  /** 随机 hex nonce，随 nonce 头发送。 */
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
  /** x-uvp-webhook-timestamp 头的值（unix 秒）。 */
  readonly timestamp?: string;
  /** x-uvp-webhook-nonce 头的值。 */
  readonly nonce?: string;
  readonly nowMs?: () => number;
  readonly toleranceMs?: number;
}

/**
 * 校验 x-uvp-webhook-signature 对原始请求 body 及其时间戳/nonce 头的
 * 覆盖。接收方应在解析 JSON 之前调用，并对缺失、畸形、过期签名一律
 * 拒绝。常量时间比较防时序泄露。
 *
 * 时间戳/nonce 缺失时 fail-closed：不带这两个头的旧 body-only 形态
 * 正是本方案要消灭的永久可重放形态。±5 分钟容窗由
 * NOTIFICATION_WEBHOOK_TIMESTAMP_TOLERANCE_MS 缺省强制。
 */
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
  /**
   * 记录一次 nonce 出现。同一 nonce 在容窗内再次出现时返回 false——
   * 该请求是重放。应在 MAC 校验通过后再调用，避免攻击者用垃圾 nonce
   * 挤占追踪容量。
   */
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
        const oldest = seen.keys().next().value;
        if (oldest !== undefined) {
          seen.delete(oldest);
        }
      }
      return true;
    }
  };
}

/**
 * 通用 webhook 通知 transport。产品渠道决策仍未做，默认关闭：
 * 只在显式配置 UVP_NOTIFY_WEBHOOK_URL 时由 server 装配；secret 可选。
 * body 为投递记录的脱敏摘要，不包含通知 payload 明文与外部端点。
 */
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
        // L-10：错误消息先脱敏再回写——fetch 异常文本可能携带完整端点
        // URL（含凭据查询参数），不得原样进入投递台账。
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
