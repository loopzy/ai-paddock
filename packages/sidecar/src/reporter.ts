import type { EventType } from './types.js';
import { ControlPlaneClient } from './control-plane-client.js';

interface ReportOptions {
  correlationId?: string;
  causedBy?: string;
  snapshotRef?: string;
}

interface PendingReport {
  type: EventType;
  payload: Record<string, unknown>;
  opts?: ReportOptions;
  resolve: (ok: boolean) => void;
  reject: (reason?: unknown) => void;
}

interface ReportEnvelope {
  type: EventType;
  payload: Record<string, unknown>;
  correlationId?: string;
  causedBy?: string;
  snapshotRef?: string;
}

const BULKABLE_EVENT_TYPES = new Set<EventType>([
  'fs.change',
  'llm.request',
  'llm.response',
  'amp.trace',
  'amp.session.start',
  'amp.command.status',
  'amp.user.command',
  'amp.tool.result',
  'amp.agent.message',
  'amp.agent.error',
]);

const EXTENDED_TIMEOUT_EVENT_TYPES = new Set<EventType>([
  'fs.change',
  'llm.request',
  'llm.response',
  'amp.trace',
  'amp.session.start',
  'amp.command.status',
  'amp.user.command',
  'amp.tool.result',
  'amp.agent.message',
  'amp.agent.error',
]);

function getReportRetryAttempts(): number {
  const parsed = Number(process.env.PADDOCK_EVENT_REPORT_ATTEMPTS ?? 3);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 3;
}

function getReportRetryDelayMs(): number {
  const parsed = Number(process.env.PADDOCK_EVENT_REPORT_RETRY_DELAY_MS ?? 150);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 150;
}

function getReportTimeoutMs(type?: EventType): number {
  const parsed = Number(process.env.PADDOCK_EVENT_REPORT_TIMEOUT_MS ?? 5000);
  const baseTimeout = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 5000;
  if (type && EXTENDED_TIMEOUT_EVENT_TYPES.has(type)) {
    const extended = Number(process.env.PADDOCK_EVENT_REPORT_EXTENDED_TIMEOUT_MS ?? 15000);
    return Number.isFinite(extended) && extended > 0 ? Math.floor(extended) : Math.max(baseTimeout, 15000);
  }
  return baseTimeout;
}

function getReportBatchSize(): number {
  const parsed = Number(process.env.PADDOCK_EVENT_REPORT_BATCH_SIZE ?? 8);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 8;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toEnvelope(item: PendingReport): ReportEnvelope {
  return {
    type: item.type,
    payload: item.payload,
    correlationId: item.opts?.correlationId,
    causedBy: item.opts?.causedBy,
    snapshotRef: item.opts?.snapshotRef,
  };
}

function canBatch(items: PendingReport[]): boolean {
  return items.length > 1 && items.every((item) => BULKABLE_EVENT_TYPES.has(item.type));
}

function maxTimeoutFor(items: PendingReport[]): number {
  return items.reduce((max, item) => Math.max(max, getReportTimeoutMs(item.type)), 0);
}

export class EventReporter {
  private controlPlaneClient: ControlPlaneClient;
  private sessionId: string;
  private pending: PendingReport[] = [];
  private flushing = false;
  private flushScheduled = false;

  constructor(controlPlaneClient: ControlPlaneClient, sessionId: string) {
    this.controlPlaneClient = controlPlaneClient;
    this.sessionId = sessionId;
  }

  async report(type: EventType, payload: Record<string, unknown>, opts?: ReportOptions): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      this.pending.push({ type, payload, opts, resolve, reject });
      this.scheduleFlush();
    });
  }

  private scheduleFlush(): void {
    if (this.flushing || this.flushScheduled) {
      return;
    }
    this.flushScheduled = true;
    queueMicrotask(() => {
      this.flushScheduled = false;
      void this.flush();
    });
  }

  private async flush(): Promise<void> {
    if (this.flushing) {
      return;
    }
    this.flushing = true;

    try {
      while (this.pending.length > 0) {
        const batch = this.nextBatch();
        const ok = await this.reportBatch(batch);
        for (const item of batch) {
          item.resolve(ok);
        }
      }
    } catch (error) {
      while (this.pending.length > 0) {
        const item = this.pending.shift();
        item?.reject(error);
      }
    } finally {
      this.flushing = false;
      if (this.pending.length > 0) {
        this.scheduleFlush();
      }
    }
  }

  private nextBatch(): PendingReport[] {
    if (this.pending.length === 0) {
      return [];
    }

    const first = this.pending[0];
    if (!BULKABLE_EVENT_TYPES.has(first.type)) {
      return [this.pending.shift() as PendingReport];
    }

    const batchSize = getReportBatchSize();
    const batch: PendingReport[] = [];
    while (this.pending.length > 0 && batch.length < batchSize) {
      const next = this.pending[0];
      if (!BULKABLE_EVENT_TYPES.has(next.type)) {
        break;
      }
      batch.push(this.pending.shift() as PendingReport);
    }
    return batch;
  }

  private async reportBatch(batch: PendingReport[]): Promise<boolean> {
    if (batch.length === 0) {
      return true;
    }

    if (batch.length === 1 || !canBatch(batch)) {
      return this.reportSingle(batch[0]);
    }

    const attempts = getReportRetryAttempts();
    const baseDelayMs = getReportRetryDelayMs();

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const ok = await this.sendBulk(batch);
      if (ok) {
        return true;
      }
      if (attempt < attempts) {
        await sleep(baseDelayMs * attempt);
      }
    }

    console.warn(
      `[event-reporter] bulk delivery failed for ${batch.length} events, retrying individually: ${batch.map((item) => item.type).join(', ')}`,
    );
    const results = await Promise.all(batch.map((item) => this.reportSingle(item)));
    return results.every(Boolean);
  }

  private async reportSingle(item: PendingReport): Promise<boolean> {
    const attempts = getReportRetryAttempts();
    const baseDelayMs = getReportRetryDelayMs();

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const ok = await this.sendSingle(item);
      if (ok || attempt >= attempts) {
        return ok;
      }
      await sleep(baseDelayMs * attempt);
    }

    return false;
  }

  private async sendSingle(item: PendingReport): Promise<boolean> {
    try {
      const response = await this.controlPlaneClient.fetch(`/api/sessions/${this.sessionId}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(getReportTimeoutMs(item.type)),
        body: JSON.stringify(toEnvelope(item)),
      });
      if (!response.ok) {
        console.error(`Failed to report event ${item.type}: HTTP ${response.status}`);
        return false;
      }
      return true;
    } catch (err) {
      console.error(`Failed to report event ${item.type}:`, err);
      return false;
    }
  }

  private async sendBulk(batch: PendingReport[]): Promise<boolean> {
    try {
      const response = await this.controlPlaneClient.fetch(`/api/sessions/${this.sessionId}/events/bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(maxTimeoutFor(batch)),
        body: JSON.stringify({
          events: batch.map((item) => toEnvelope(item)),
        }),
      });
      if (!response.ok) {
        console.error(`Failed to report ${batch.length} events in bulk: HTTP ${response.status}`);
        return false;
      }
      return true;
    } catch (err) {
      console.error(`Failed to report ${batch.length} events in bulk:`, err);
      return false;
    }
  }
}
