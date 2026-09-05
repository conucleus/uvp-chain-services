import { createHmac } from "node:crypto";
import { redactSecrets } from "../security/redaction.js";
import type {
  NotificationDispatcher,
  NotificationDispatchRequest,
  NotificationDispatchResult
} from "./service.js";

export const NOTIFICATION_WEBHOOK_SIGNATURE_HEADER = "x-uvp-webhook-signature";

export interface WebhookNotificationDispatcherOptions {
  readonly url: string;
  /** 可选：配置后对 POST body 计算 HMAC-SHA256，放 x-uvp-webhook-signature: sha256=<hex>。 */
  readonly secret?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
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
    const body = JSON.stringify(redactSecrets(webhookBodyFrom(request, this.#now().toISOString())));
    const headers: Record<string, string> = {
      "content-type": "application/json"
    };
    if (this.#secret) {
      headers[NOTIFICATION_WEBHOOK_SIGNATURE_HEADER] = `sha256=${createHmac("sha256", this.#secret).update(body).digest("hex")}`;
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
        error: error instanceof Error ? error.message : "webhook dispatch failed"
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
