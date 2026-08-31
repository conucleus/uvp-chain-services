import type { Logger } from "../shared/types.js";
import { redactSecrets } from "./redaction.js";

export type AuditOutcome = "accepted" | "blocked" | "failed" | "succeeded" | "duplicate" | "rejected" | "retry" | "skipped";

export interface AuditEvent {
  readonly type: string;
  readonly action?: string;
  readonly outcome: AuditOutcome;
  readonly actor?: string;
  readonly subject?: Readonly<Record<string, unknown>>;
  readonly txHash?: string;
  readonly errorCode?: string;
  readonly retryable?: boolean;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly createdAt?: string;
}

export interface AuditSink {
  record(event: AuditEvent): void | Promise<void>;
}

export const noopAuditSink: AuditSink = {
  record: () => undefined
};

export class InMemoryAuditSink implements AuditSink {
  readonly #events: AuditEvent[] = [];

  record(event: AuditEvent): void {
    this.#events.push(redactSecrets({
      ...event,
      createdAt: event.createdAt ?? new Date().toISOString()
    }));
  }

  list(): readonly AuditEvent[] {
    return [...this.#events];
  }
}

export function createLoggerAuditSink(logger: Logger, now: () => Date = () => new Date()): AuditSink {
  return {
    record(event) {
      logger.info("audit event", redactSecrets({
        ...event,
        createdAt: event.createdAt ?? now().toISOString()
      }));
    }
  };
}
