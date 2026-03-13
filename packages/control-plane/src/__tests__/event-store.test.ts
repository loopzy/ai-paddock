import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { EventStore } from '../events/event-store.js';

describe('EventStore', () => {
  let store: EventStore;

  beforeEach(() => {
    store = new EventStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  describe('append', () => {
    it('should append an event and return it with correct fields', () => {
      const event = store.append('sess-1', 'session.status', { status: 'created' });
      expect(event.id).toBeTruthy();
      expect(event.sessionId).toBe('sess-1');
      expect(event.seq).toBe(1);
      expect(event.type).toBe('session.status');
      expect(event.payload).toEqual({ status: 'created' });
      expect(event.timestamp).toBeGreaterThan(0);
    });

    it('should auto-increment seq per session', () => {
      const e1 = store.append('sess-1', 'session.status', { status: 'created' });
      const e2 = store.append('sess-1', 'session.status', { status: 'running' });
      const e3 = store.append('sess-2', 'session.status', { status: 'created' });
      expect(e1.seq).toBe(1);
      expect(e2.seq).toBe(2);
      expect(e3.seq).toBe(1); // different session resets seq
    });

    it('should store correlationId and causedBy', () => {
      const event = store.append('sess-1', 'tool.result', { result: 'ok' }, {
        correlationId: 'corr-1',
        causedBy: 'cause-1',
      });
      expect(event.correlationId).toBe('corr-1');
      expect(event.causedBy).toBe('cause-1');
    });
  });

  describe('getEvents', () => {
    beforeEach(() => {
      store.append('sess-1', 'session.status', { status: 'created' });
      store.append('sess-1', 'session.status', { status: 'running' });
      store.append('sess-1', 'tool.result', { result: 'ok' });
      store.append('sess-2', 'session.status', { status: 'created' });
    });

    it('should return all events for a session', () => {
      const events = store.getEvents('sess-1');
      expect(events).toHaveLength(3);
      expect(events[0].seq).toBe(1);
      expect(events[2].seq).toBe(3);
    });

    it('should filter by since (seq)', () => {
      const events = store.getEvents('sess-1', { since: 1 });
      expect(events).toHaveLength(2);
      expect(events[0].seq).toBe(2);
    });

    it('should filter by types', () => {
      const events = store.getEvents('sess-1', { types: ['tool.result'] });
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('tool.result');
    });

    it('should respect limit', () => {
      const events = store.getEvents('sess-1', { limit: 2 });
      expect(events).toHaveLength(2);
    });

    it('should not return rolled-back events', () => {
      store.markRolledBack('sess-1', 1);
      const events = store.getEvents('sess-1');
      expect(events).toHaveLength(1);
      expect(events[0].seq).toBe(1);
    });
  });

  describe('getCorrelatedEvents', () => {
    it('should return events with matching correlationId', () => {
      store.append('sess-1', 'tool.intent', { tool: 'exec' }, { correlationId: 'corr-1' });
      store.append('sess-1', 'tool.result', { result: 'ok' }, { correlationId: 'corr-1' });
      store.append('sess-1', 'tool.intent', { tool: 'read' }, { correlationId: 'corr-2' });

      const events = store.getCorrelatedEvents('corr-1');
      expect(events).toHaveLength(2);
      expect(events.every(e => e.correlationId === 'corr-1')).toBe(true);
    });
  });

  describe('verifyIntegrity', () => {
    it('should verify a valid chain', () => {
      store.append('sess-1', 'session.status', { status: 'created' });
      store.append('sess-1', 'session.status', { status: 'running' });
      store.append('sess-1', 'tool.result', { result: 'ok' });

      const result = store.verifyIntegrity('sess-1');
      expect(result.valid).toBe(true);
      expect(result.brokenAt).toBeUndefined();
    });

    it('should detect tampered events', () => {
      store.append('sess-1', 'session.status', { status: 'created' });
      store.append('sess-1', 'session.status', { status: 'running' });

      // Tamper with the payload directly in DB
      store.db.prepare("UPDATE events SET payload = '{\"status\":\"hacked\"}' WHERE session_id = 'sess-1' AND seq = 1").run();

      const result = store.verifyIntegrity('sess-1');
      expect(result.valid).toBe(false);
      expect(result.brokenAt).toBe(1);
    });
  });

  describe('markRolledBack', () => {
    it('should mark events after given seq as rolled back', () => {
      store.append('sess-1', 'session.status', { status: 'created' });
      store.append('sess-1', 'session.status', { status: 'running' });
      store.append('sess-1', 'tool.result', { result: 'ok' });

      const count = store.markRolledBack('sess-1', 1);
      expect(count).toBe(2);

      const events = store.getEvents('sess-1');
      expect(events).toHaveLength(1);
    });
  });
});
