import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CronManager } from '../cron/cron-manager.js';

describe('CronManager', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('adds jobs and reports scheduler status', async () => {
    const manager = new CronManager(db, vi.fn(async () => ({ delivered: true })));

    const job = await manager.add('session-owner', {
      sessionTarget: 'current',
      schedule: { kind: 'at', at: '2035-01-01T00:00:00.000Z' },
      payload: { kind: 'agentTurn', message: 'hello from cron' },
    });

    const status = await manager.status();
    const listed = await manager.list({ includeDisabled: true });

    expect(job.id).toBeTruthy();
    expect(status.jobCount).toBe(1);
    expect(status.runningCount).toBe(0);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      id: job.id,
      ownerSessionId: 'session-owner',
      sessionTarget: 'current',
      enabled: true,
    });
    expect(typeof listed[0]?.nextRunAt).toBe('number');
  });

  it('runs due jobs and records run history', async () => {
    const executor = vi.fn(async () => ({ delivered: true, targetSessionId: 'session-owner' }));
    const manager = new CronManager(db, executor);

    const job = await manager.add('session-owner', {
      sessionTarget: 'current',
      schedule: { kind: 'at', at: '2000-01-01T00:00:00.000Z' },
      payload: { kind: 'agentTurn', message: 'wake up' },
    });

    const wakeResult = await manager.wake('now');
    const runs = await manager.runs(job.id, 10);
    const listed = await manager.list({ includeDisabled: true });

    expect(wakeResult).toMatchObject({ ok: true, ran: 1 });
    expect(executor).toHaveBeenCalledTimes(1);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      jobId: job.id,
      status: 'succeeded',
    });
    expect(listed[0]?.enabled).toBe(false);
  });
});
