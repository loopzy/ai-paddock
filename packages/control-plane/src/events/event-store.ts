import Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import { createHash } from 'node:crypto';
import type { PaddockEvent, EventType } from '../types.js';

export type EventListener = (event: PaddockEvent) => void;
type AppendOptions = { snapshotRef?: string; correlationId?: string; causedBy?: string };
type AppendInput = { type: EventType; payload: Record<string, unknown> } & AppendOptions;

export class EventStore {
  public db: Database.Database;
  private listeners: EventListener[] = [];

  constructor(dbPath = 'paddock.db') {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id             TEXT PRIMARY KEY,
        session_id     TEXT NOT NULL,
        seq            INTEGER NOT NULL,
        timestamp      INTEGER NOT NULL,
        type           TEXT NOT NULL,
        payload        TEXT NOT NULL DEFAULT '{}',
        snapshot_ref   TEXT,
        correlation_id TEXT,
        caused_by      TEXT,
        prev_hash      TEXT,
        hash           TEXT,
        rolled_back    INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_events_session_seq
        ON events(session_id, seq);
      CREATE INDEX IF NOT EXISTS idx_events_session_type
        ON events(session_id, type);
      CREATE INDEX IF NOT EXISTS idx_events_correlation
        ON events(correlation_id);

      CREATE TABLE IF NOT EXISTS sessions (
        id           TEXT PRIMARY KEY,
        status       TEXT NOT NULL DEFAULT 'created',
        agent_type   TEXT NOT NULL,
        sandbox_type TEXT NOT NULL DEFAULT 'simple-box',
        vm_id        TEXT,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS snapshots (
        id                  TEXT PRIMARY KEY,
        session_id          TEXT NOT NULL,
        seq                 INTEGER NOT NULL,
        label               TEXT,
        created_at          INTEGER NOT NULL,
        boxlite_snapshot_id TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_snapshots_session
        ON snapshots(session_id, seq);
    `);
  }

  private nextSeq(sessionId: string): number {
    const row = this.db.prepare('SELECT MAX(seq) as max_seq FROM events WHERE session_id = ?').get(sessionId) as { max_seq: number | null } | undefined;
    return (row?.max_seq ?? 0) + 1;
  }

  private getLastHash(sessionId: string): string {
    const row = this.db.prepare('SELECT hash FROM events WHERE session_id = ? ORDER BY seq DESC LIMIT 1').get(sessionId) as { hash: string } | undefined;
    return row?.hash ?? '0'.repeat(64);
  }

  private computeHash(prevHash: string, content: string): string {
    return createHash('sha256').update(prevHash + content).digest('hex');
  }

  append(sessionId: string, type: EventType, payload: Record<string, unknown>, opts?: AppendOptions): PaddockEvent {
    const seq = this.nextSeq(sessionId);
    const prevHash = this.getLastHash(sessionId);
    const id = nanoid();
    const timestamp = Date.now();
    const payloadStr = JSON.stringify(payload);
    const hash = this.computeHash(prevHash, `${id}:${seq}:${type}:${payloadStr}`);
    const event: PaddockEvent = { id, sessionId, seq, timestamp, type, payload, correlationId: opts?.correlationId, causedBy: opts?.causedBy, snapshotRef: opts?.snapshotRef };
    this.db.prepare('INSERT INTO events (id, session_id, seq, timestamp, type, payload, snapshot_ref, correlation_id, caused_by, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, sessionId, seq, timestamp, type, payloadStr, opts?.snapshotRef ?? null, opts?.correlationId ?? null, opts?.causedBy ?? null, prevHash, hash);
    for (const fn of this.listeners) fn(event);
    return event;
  }

  appendMany(sessionId: string, inputs: AppendInput[]): PaddockEvent[] {
    if (inputs.length === 0) {
      return [];
    }

    const appended: PaddockEvent[] = [];
    const run = this.db.transaction((batch: AppendInput[]) => {
      let seq = this.nextSeq(sessionId);
      let prevHash = this.getLastHash(sessionId);

      for (const input of batch) {
        const id = nanoid();
        const timestamp = Date.now();
        const payloadStr = JSON.stringify(input.payload);
        const hash = this.computeHash(prevHash, `${id}:${seq}:${input.type}:${payloadStr}`);
        const event: PaddockEvent = {
          id,
          sessionId,
          seq,
          timestamp,
          type: input.type,
          payload: input.payload,
          correlationId: input.correlationId,
          causedBy: input.causedBy,
          snapshotRef: input.snapshotRef,
        };
        this.db
          .prepare(
            'INSERT INTO events (id, session_id, seq, timestamp, type, payload, snapshot_ref, correlation_id, caused_by, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .run(
            id,
            sessionId,
            seq,
            timestamp,
            input.type,
            payloadStr,
            input.snapshotRef ?? null,
            input.correlationId ?? null,
            input.causedBy ?? null,
            prevHash,
            hash,
          );
        appended.push(event);
        prevHash = hash;
        seq += 1;
      }
    });

    run(inputs);
    for (const event of appended) {
      for (const fn of this.listeners) fn(event);
    }
    return appended;
  }

  getEvents(sessionId: string, opts?: { since?: number; types?: EventType[]; limit?: number }): PaddockEvent[] {
    let sql = 'SELECT * FROM events WHERE session_id = ? AND rolled_back = 0';
    const params: unknown[] = [sessionId];
    if (opts?.since) { sql += ' AND seq > ?'; params.push(opts.since); }
    if (opts?.types?.length) { sql += ` AND type IN (${opts.types.map(() => '?').join(',')})`; params.push(...opts.types); }
    sql += ' ORDER BY seq ASC';
    if (opts?.limit) { sql += ' LIMIT ?'; params.push(opts.limit); }
    const rows = this.db.prepare(sql).all(...params) as Array<{ id: string; session_id: string; seq: number; timestamp: number; type: string; payload: string; snapshot_ref: string | null; correlation_id: string | null; caused_by: string | null }>;
    return rows.map((r) => ({ id: r.id, sessionId: r.session_id, seq: r.seq, timestamp: r.timestamp, type: r.type as EventType, payload: JSON.parse(r.payload), correlationId: r.correlation_id ?? undefined, causedBy: r.caused_by ?? undefined, snapshotRef: r.snapshot_ref ?? undefined }));
  }

  getCorrelatedEvents(correlationId: string): PaddockEvent[] {
    const rows = this.db.prepare('SELECT * FROM events WHERE correlation_id = ? AND rolled_back = 0 ORDER BY seq ASC').all(correlationId) as Array<{ id: string; session_id: string; seq: number; timestamp: number; type: string; payload: string; snapshot_ref: string | null; correlation_id: string | null; caused_by: string | null }>;
    return rows.map((r) => ({ id: r.id, sessionId: r.session_id, seq: r.seq, timestamp: r.timestamp, type: r.type as EventType, payload: JSON.parse(r.payload), correlationId: r.correlation_id ?? undefined, causedBy: r.caused_by ?? undefined, snapshotRef: r.snapshot_ref ?? undefined }));
  }

  verifyIntegrity(sessionId: string): { valid: boolean; brokenAt?: number } {
    const rows = this.db.prepare('SELECT id, seq, type, payload, prev_hash, hash FROM events WHERE session_id = ? ORDER BY seq ASC').all(sessionId) as Array<{ id: string; seq: number; type: string; payload: string; prev_hash: string; hash: string }>;
    let expectedPrev = '0'.repeat(64);
    for (const row of rows) {
      if (row.prev_hash !== expectedPrev) return { valid: false, brokenAt: row.seq };
      const computed = this.computeHash(row.prev_hash, `${row.id}:${row.seq}:${row.type}:${row.payload}`);
      if (computed !== row.hash) return { valid: false, brokenAt: row.seq };
      expectedPrev = row.hash;
    }
    return { valid: true };
  }

  markRolledBack(sessionId: string, afterSeq: number): number {
    return this.db.prepare('UPDATE events SET rolled_back = 1 WHERE session_id = ? AND seq > ?').run(sessionId, afterSeq).changes;
  }

  close() { this.db.close(); }

  onEvent(fn: EventListener) { this.listeners.push(fn); }
  offEvent(fn: EventListener) { this.listeners = this.listeners.filter(l => l !== fn); }
}
