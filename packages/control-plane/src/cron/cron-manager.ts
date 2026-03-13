import Database from 'better-sqlite3';
import { nanoid } from 'nanoid';

type JsonRecord = Record<string, unknown>;

export type CronSchedule =
  | { kind: 'at'; at: string }
  | { kind: 'every'; everyMs: number; anchorMs?: number }
  | { kind: 'cron'; expr: string; tz?: string; staggerMs?: number };

export type CronPayload =
  | { kind: 'systemEvent'; text: string }
  | { kind: 'agentTurn'; message: string; model?: string; thinking?: string; timeoutSeconds?: number };

export type CronSessionTarget = 'main' | 'current' | 'isolated' | `session:${string}`;

export interface CronJob {
  id: string;
  ownerSessionId: string;
  sessionTarget: CronSessionTarget;
  enabled: boolean;
  schedule: CronSchedule;
  payload: CronPayload;
  delivery?: JsonRecord;
  deleteAfterRun: boolean;
  createdAt: number;
  updatedAt: number;
  lastRunAt?: number;
  nextRunAt?: number;
  running: boolean;
}

export interface CronRun {
  id: string;
  jobId: string;
  ownerSessionId: string;
  startedAt: number;
  finishedAt?: number;
  status: 'running' | 'succeeded' | 'failed';
  mode: 'force' | 'due';
  result?: JsonRecord;
  error?: string;
}

type CronExecutor = (job: CronJob, run: CronRun) => Promise<JsonRecord>;

interface CronListOptions {
  includeDisabled?: boolean;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class CronManager {
  private db: Database.Database;
  private executor: CronExecutor;
  private timer?: ReturnType<typeof setInterval>;

  constructor(db: Database.Database, executor: CronExecutor) {
    this.db = db;
    this.executor = executor;
    this.ensureSchema();
  }

  start(intervalMs = 1000) {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((err) => {
        console.error('[cron-manager] tick failed', err);
      });
    }, intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async add(ownerSessionId: string, rawInput: JsonRecord): Promise<CronJob> {
    const now = Date.now();
    const normalized = this.normalizeCreate(ownerSessionId, rawInput, now);
    this.db
      .prepare(
        `INSERT INTO cron_jobs (
          id, owner_session_id, session_target, enabled, schedule_json, payload_json, delivery_json,
          delete_after_run, created_at, updated_at, last_run_at, next_run_at, running
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        normalized.id,
        normalized.ownerSessionId,
        normalized.sessionTarget,
        normalized.enabled ? 1 : 0,
        JSON.stringify(normalized.schedule),
        JSON.stringify(normalized.payload),
        normalized.delivery ? JSON.stringify(normalized.delivery) : null,
        normalized.deleteAfterRun ? 1 : 0,
        normalized.createdAt,
        normalized.updatedAt,
        normalized.lastRunAt ?? null,
        normalized.nextRunAt ?? null,
        normalized.running ? 1 : 0,
      );
    return normalized;
  }

  async get(jobId: string): Promise<CronJob | null> {
    const row = this.db.prepare('SELECT * FROM cron_jobs WHERE id = ?').get(jobId) as CronJobRow | undefined;
    return row ? this.rowToJob(row) : null;
  }

  async list(opts?: CronListOptions): Promise<CronJob[]> {
    const includeDisabled = opts?.includeDisabled ?? false;
    const rows = this.db
      .prepare(
        `SELECT * FROM cron_jobs ${includeDisabled ? '' : 'WHERE enabled = 1'} ORDER BY created_at ASC`,
      )
      .all() as CronJobRow[];
    return rows.map((row) => this.rowToJob(row));
  }

  async status() {
    const rows = await this.list({ includeDisabled: true });
    const enabledJobs = rows.filter((row) => row.enabled);
    const nextWakeAt = enabledJobs
      .map((row) => row.nextRunAt)
      .filter((value): value is number => typeof value === 'number')
      .sort((a, b) => a - b)[0];

    return {
      ok: true,
      enabled: true,
      jobCount: rows.length,
      enabledJobCount: enabledJobs.length,
      runningCount: rows.filter((row) => row.running).length,
      nextWakeAt: nextWakeAt ?? null,
    };
  }

  async update(jobId: string, patch: JsonRecord): Promise<CronJob> {
    const existing = await this.get(jobId);
    if (!existing) {
      throw new Error(`Cron job not found: ${jobId}`);
    }

    const now = Date.now();
    const merged: CronJob = {
      ...existing,
      updatedAt: now,
    };

    if (typeof patch.enabled === 'boolean') {
      merged.enabled = patch.enabled;
    }
    if (typeof patch.sessionTarget === 'string') {
      merged.sessionTarget = patch.sessionTarget as CronSessionTarget;
    }
    if (typeof patch.deleteAfterRun === 'boolean') {
      merged.deleteAfterRun = patch.deleteAfterRun;
    }
    if (isRecord(patch.schedule)) {
      merged.schedule = this.normalizeSchedule(patch.schedule);
    }
    if (isRecord(patch.payload)) {
      merged.payload = this.normalizePayload(patch.payload);
    }
    if (isRecord(patch.delivery)) {
      merged.delivery = patch.delivery;
    }

    merged.nextRunAt = this.computeNextRunAt(merged, now);

    this.persistJob(merged);
    return merged;
  }

  async remove(jobId: string) {
    const deleted = this.db.prepare('DELETE FROM cron_jobs WHERE id = ?').run(jobId).changes;
    this.db.prepare('DELETE FROM cron_runs WHERE job_id = ?').run(jobId);
    return { ok: true, deleted: deleted > 0 };
  }

  async run(jobId: string, mode: 'force' | 'due' = 'force') {
    const job = await this.get(jobId);
    if (!job) {
      return { ok: false, ran: false, reason: 'missing_job' };
    }
    if (!job.enabled) {
      return { ok: true, ran: false, reason: 'disabled' };
    }
    if (job.running) {
      return { ok: true, ran: false, reason: 'already_running' };
    }

    const now = Date.now();
    if (mode === 'due') {
      const nextRunAt = job.nextRunAt ?? this.computeNextRunAt(job, now);
      if (typeof nextRunAt !== 'number' || nextRunAt > now) {
        return { ok: true, ran: false, reason: 'not_due' };
      }
    }

    const run: CronRun = {
      id: nanoid(),
      jobId: job.id,
      ownerSessionId: job.ownerSessionId,
      startedAt: now,
      status: 'running',
      mode,
    };
    this.db
      .prepare(
        `INSERT INTO cron_runs (id, job_id, owner_session_id, started_at, finished_at, status, mode, result_json, error_text)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(run.id, run.jobId, run.ownerSessionId, run.startedAt, null, run.status, run.mode, null, null);

    job.running = true;
    job.updatedAt = now;
    this.persistJob(job);

    try {
      const result = await this.executor(job, run);
      const finishedAt = Date.now();
      const updatedJob = await this.get(job.id);
      if (!updatedJob) {
        throw new Error(`Cron job disappeared during execution: ${job.id}`);
      }

      updatedJob.running = false;
      updatedJob.lastRunAt = finishedAt;
      updatedJob.updatedAt = finishedAt;
      updatedJob.enabled = updatedJob.schedule.kind === 'at' && updatedJob.deleteAfterRun ? false : updatedJob.enabled;
      updatedJob.nextRunAt = this.computeNextRunAt(updatedJob, finishedAt);
      this.persistJob(updatedJob);

      this.db
        .prepare(
          `UPDATE cron_runs
              SET finished_at = ?, status = ?, result_json = ?, error_text = NULL
            WHERE id = ?`,
        )
        .run(finishedAt, 'succeeded', JSON.stringify(result), run.id);

      return { ok: true, ran: true, runId: run.id, result };
    } catch (err) {
      const finishedAt = Date.now();
      const updatedJob = await this.get(job.id);
      if (updatedJob) {
        updatedJob.running = false;
        updatedJob.lastRunAt = finishedAt;
        updatedJob.updatedAt = finishedAt;
        updatedJob.nextRunAt = this.computeNextRunAt(updatedJob, finishedAt);
        this.persistJob(updatedJob);
      }

      this.db
        .prepare(
          `UPDATE cron_runs
              SET finished_at = ?, status = ?, result_json = NULL, error_text = ?
            WHERE id = ?`,
        )
        .run(finishedAt, 'failed', String(err), run.id);

      return { ok: false, ran: true, runId: run.id, error: String(err) };
    }
  }

  async runs(jobId: string, limit = 50): Promise<CronRun[]> {
    const rows = this.db
      .prepare('SELECT * FROM cron_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT ?')
      .all(jobId, limit) as CronRunRow[];
    return rows.map((row) => this.rowToRun(row));
  }

  async wake(mode: 'now' | 'next-heartbeat' = 'next-heartbeat') {
    if (mode !== 'now') {
      const status = await this.status();
      return { ok: true, ran: 0, nextWakeAt: status.nextWakeAt };
    }
    const ran = await this.tick();
    return { ok: true, ran };
  }

  async tick(now = Date.now()): Promise<number> {
    const jobs = await this.list({ includeDisabled: false });
    let ran = 0;

    for (const job of jobs) {
      if (job.running) continue;
      if (typeof job.nextRunAt !== 'number' || job.nextRunAt > now) continue;
      const result = await this.run(job.id, 'due');
      if (result.ran) {
        ran += 1;
      }
    }

    return ran;
  }

  private ensureSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cron_jobs (
        id TEXT PRIMARY KEY,
        owner_session_id TEXT NOT NULL,
        session_target TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        schedule_json TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        delivery_json TEXT,
        delete_after_run INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_run_at INTEGER,
        next_run_at INTEGER,
        running INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS cron_runs (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        owner_session_id TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        status TEXT NOT NULL,
        mode TEXT NOT NULL,
        result_json TEXT,
        error_text TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_cron_jobs_next_run
        ON cron_jobs(enabled, next_run_at);
      CREATE INDEX IF NOT EXISTS idx_cron_runs_job
        ON cron_runs(job_id, started_at DESC);
    `);
  }

  private normalizeCreate(ownerSessionId: string, rawInput: JsonRecord, now: number): CronJob {
    const source = isRecord(rawInput.job) ? rawInput.job : rawInput;
    const schedule = this.normalizeSchedule(source.schedule);
    const payload = this.normalizePayload(source.payload ?? source);
    const sessionTarget = this.normalizeSessionTarget(source.sessionTarget);
    const enabled = source.enabled !== false;
    const deleteAfterRun =
      typeof source.deleteAfterRun === 'boolean' ? source.deleteAfterRun : schedule.kind === 'at';

    const job: CronJob = {
      id: nanoid(),
      ownerSessionId,
      sessionTarget,
      enabled,
      schedule,
      payload,
      delivery: isRecord(source.delivery) ? source.delivery : undefined,
      deleteAfterRun,
      createdAt: now,
      updatedAt: now,
      running: false,
    };
    job.nextRunAt = this.computeNextRunAt(job, now);
    return job;
  }

  private normalizeSchedule(value: unknown): CronSchedule {
    if (!isRecord(value) || typeof value.kind !== 'string') {
      throw new Error('cron schedule is required');
    }

    switch (value.kind) {
      case 'at':
        if (typeof value.at !== 'string' || Number.isNaN(Date.parse(value.at))) {
          throw new Error('cron schedule.at must be an ISO timestamp');
        }
        return { kind: 'at', at: value.at };
      case 'every':
        if (typeof value.everyMs !== 'number' || !Number.isFinite(value.everyMs) || value.everyMs <= 0) {
          throw new Error('cron schedule.everyMs must be a positive number');
        }
        return {
          kind: 'every',
          everyMs: value.everyMs,
          anchorMs: typeof value.anchorMs === 'number' && Number.isFinite(value.anchorMs) ? value.anchorMs : undefined,
        };
      case 'cron':
        if (typeof value.expr !== 'string' || !value.expr.trim()) {
          throw new Error('cron schedule.expr is required');
        }
        return {
          kind: 'cron',
          expr: value.expr,
          tz: typeof value.tz === 'string' && value.tz.trim() ? value.tz : undefined,
          staggerMs:
            typeof value.staggerMs === 'number' && Number.isFinite(value.staggerMs) ? value.staggerMs : undefined,
        };
      default:
        throw new Error(`unsupported cron schedule kind: ${String(value.kind)}`);
    }
  }

  private normalizePayload(value: unknown): CronPayload {
    if (isRecord(value) && value.kind === 'systemEvent' && typeof value.text === 'string') {
      return { kind: 'systemEvent', text: value.text };
    }
    if (isRecord(value) && value.kind === 'agentTurn' && typeof value.message === 'string') {
      return {
        kind: 'agentTurn',
        message: value.message,
        model: typeof value.model === 'string' ? value.model : undefined,
        thinking: typeof value.thinking === 'string' ? value.thinking : undefined,
        timeoutSeconds:
          typeof value.timeoutSeconds === 'number' && Number.isFinite(value.timeoutSeconds)
            ? value.timeoutSeconds
            : undefined,
      };
    }
    if (isRecord(value) && typeof value.message === 'string') {
      return { kind: 'agentTurn', message: value.message };
    }
    if (isRecord(value) && typeof value.text === 'string') {
      return { kind: 'systemEvent', text: value.text };
    }
    throw new Error('cron payload is required');
  }

  private normalizeSessionTarget(value: unknown): CronSessionTarget {
    if (typeof value !== 'string' || !value.trim()) {
      return 'current';
    }
    const normalized = value.trim();
    if (normalized === 'main' || normalized === 'current' || normalized === 'isolated') {
      return normalized;
    }
    if (normalized.startsWith('session:')) {
      return normalized as CronSessionTarget;
    }
    return 'current';
  }

  private computeNextRunAt(job: CronJob, now: number): number | undefined {
    if (!job.enabled) return undefined;

    switch (job.schedule.kind) {
      case 'at': {
        const atMs = Date.parse(job.schedule.at);
        if (Number.isNaN(atMs)) return undefined;
        if (job.lastRunAt && job.deleteAfterRun) return undefined;
        return atMs;
      }
      case 'every': {
        const anchorMs = job.schedule.anchorMs ?? job.createdAt;
        if (job.lastRunAt) {
          return job.lastRunAt + job.schedule.everyMs;
        }
        if (now <= anchorMs) {
          return anchorMs;
        }
        const elapsed = now - anchorMs;
        const periods = Math.ceil(elapsed / job.schedule.everyMs);
        return anchorMs + periods * job.schedule.everyMs;
      }
      case 'cron':
        return undefined;
      default:
        return undefined;
    }
  }

  private persistJob(job: CronJob) {
    this.db
      .prepare(
        `UPDATE cron_jobs
            SET session_target = ?, enabled = ?, schedule_json = ?, payload_json = ?, delivery_json = ?,
                delete_after_run = ?, updated_at = ?, last_run_at = ?, next_run_at = ?, running = ?
          WHERE id = ?`,
      )
      .run(
        job.sessionTarget,
        job.enabled ? 1 : 0,
        JSON.stringify(job.schedule),
        JSON.stringify(job.payload),
        job.delivery ? JSON.stringify(job.delivery) : null,
        job.deleteAfterRun ? 1 : 0,
        job.updatedAt,
        job.lastRunAt ?? null,
        job.nextRunAt ?? null,
        job.running ? 1 : 0,
        job.id,
      );
  }

  private rowToJob(row: CronJobRow): CronJob {
    return {
      id: row.id,
      ownerSessionId: row.owner_session_id,
      sessionTarget: row.session_target as CronSessionTarget,
      enabled: row.enabled === 1,
      schedule: JSON.parse(row.schedule_json) as CronSchedule,
      payload: JSON.parse(row.payload_json) as CronPayload,
      delivery: row.delivery_json ? (JSON.parse(row.delivery_json) as JsonRecord) : undefined,
      deleteAfterRun: row.delete_after_run === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastRunAt: row.last_run_at ?? undefined,
      nextRunAt: row.next_run_at ?? undefined,
      running: row.running === 1,
    };
  }

  private rowToRun(row: CronRunRow): CronRun {
    return {
      id: row.id,
      jobId: row.job_id,
      ownerSessionId: row.owner_session_id,
      startedAt: row.started_at,
      finishedAt: row.finished_at ?? undefined,
      status: row.status as CronRun['status'],
      mode: row.mode as CronRun['mode'],
      result: row.result_json ? (JSON.parse(row.result_json) as JsonRecord) : undefined,
      error: row.error_text ?? undefined,
    };
  }
}

type CronJobRow = {
  id: string;
  owner_session_id: string;
  session_target: string;
  enabled: number;
  schedule_json: string;
  payload_json: string;
  delivery_json: string | null;
  delete_after_run: number;
  created_at: number;
  updated_at: number;
  last_run_at: number | null;
  next_run_at: number | null;
  running: number;
};

type CronRunRow = {
  id: string;
  job_id: string;
  owner_session_id: string;
  started_at: number;
  finished_at: number | null;
  status: string;
  mode: string;
  result_json: string | null;
  error_text: string | null;
};
