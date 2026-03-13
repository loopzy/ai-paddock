import type { EventType } from './types.js';
import { ControlPlaneClient } from './control-plane-client.js';

function getReportRetryAttempts(): number {
  const parsed = Number(process.env.PADDOCK_EVENT_REPORT_ATTEMPTS ?? 3);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 3;
}

function getReportRetryDelayMs(): number {
  const parsed = Number(process.env.PADDOCK_EVENT_REPORT_RETRY_DELAY_MS ?? 150);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 150;
}

function getReportTimeoutMs(): number {
  const parsed = Number(process.env.PADDOCK_EVENT_REPORT_TIMEOUT_MS ?? 5000);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 5000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class EventReporter {
  private controlPlaneClient: ControlPlaneClient;
  private sessionId: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(controlPlaneClient: ControlPlaneClient, sessionId: string) {
    this.controlPlaneClient = controlPlaneClient;
    this.sessionId = sessionId;
  }

  async report(
    type: EventType,
    payload: Record<string, unknown>,
    opts?: { correlationId?: string; causedBy?: string; snapshotRef?: string },
  ): Promise<boolean> {
    const task = this.queue.then(
      () => this.reportOnce(type, payload, opts),
      () => this.reportOnce(type, payload, opts),
    );
    this.queue = task.catch(() => undefined);
    return task;
  }

  private async reportOnce(
    type: EventType,
    payload: Record<string, unknown>,
    opts?: { correlationId?: string; causedBy?: string; snapshotRef?: string },
  ): Promise<boolean> {
    const attempts = getReportRetryAttempts();
    const baseDelayMs = getReportRetryDelayMs();

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const ok = await this.send(type, payload, opts);
      if (ok || attempt >= attempts) {
        return ok;
      }
      await sleep(baseDelayMs * attempt);
    }

    return false;
  }

  private async send(
    type: EventType,
    payload: Record<string, unknown>,
    opts?: { correlationId?: string; causedBy?: string; snapshotRef?: string },
  ): Promise<boolean> {
    try {
      const response = await this.controlPlaneClient.fetch(`/api/sessions/${this.sessionId}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(getReportTimeoutMs()),
        body: JSON.stringify({
          type,
          payload,
          correlationId: opts?.correlationId,
          causedBy: opts?.causedBy,
          snapshotRef: opts?.snapshotRef,
        }),
      });
      if (!response.ok) {
        console.error(`Failed to report event ${type}: HTTP ${response.status}`);
        return false;
      }
      return true;
    } catch (err) {
      console.error(`Failed to report event ${type}:`, err);
      return false;
    }
  }
}
