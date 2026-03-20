import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { EventStore } from '../events/event-store.js';
import { SnapshotManager } from '../snapshot/snapshot-manager.js';

describe('SnapshotManager', () => {
  let eventStore: EventStore;
  let manager: SnapshotManager;

  beforeEach(() => {
    eventStore = new EventStore(':memory:');
    manager = new SnapshotManager(eventStore.db);
  });

  afterEach(() => {
    eventStore.close();
  });

  describe('create', () => {
    it('should create a snapshot record', () => {
      const snap = manager.create('sess-1', 5, 'bx-snap-1', 'before refactor', {
        sizeBytes: 1234,
        containerDiskBytes: 5678,
      });
      expect(snap.id).toBeTruthy();
      expect(snap.sessionId).toBe('sess-1');
      expect(snap.seq).toBe(5);
      expect(snap.label).toBe('before refactor');
      expect(snap.boxliteSnapshotId).toBe('bx-snap-1');
      expect(snap.createdAt).toBeGreaterThan(0);
      expect(snap.sizeBytes).toBe(1234);
      expect(snap.containerDiskBytes).toBe(5678);
      expect(snap.consistencyMode).toBe('live');
    });

    it('should create snapshot without label', () => {
      const snap = manager.create('sess-1', 3, 'bx-snap-2');
      expect(snap.label).toBeUndefined();
    });
  });

  describe('list', () => {
    it('should list snapshots for a session ordered by seq', () => {
      manager.create('sess-1', 3, 'bx-1');
      manager.create('sess-1', 7, 'bx-2');
      manager.create('sess-2', 1, 'bx-3');

      const snaps = manager.list('sess-1');
      expect(snaps).toHaveLength(2);
      expect(snaps[0].seq).toBe(3);
      expect(snaps[1].seq).toBe(7);
    });

    it('should return empty array for unknown session', () => {
      expect(manager.list('nonexistent')).toEqual([]);
    });
  });

  describe('get', () => {
    it('should get a snapshot by id', () => {
      const snap = manager.create('sess-1', 5, 'bx-1', 'test', { sizeBytes: 42 });
      const found = manager.get(snap.id);
      expect(found).toBeTruthy();
      expect(found!.id).toBe(snap.id);
      expect(found!.label).toBe('test');
      expect(found!.sizeBytes).toBe(42);
      expect(found!.consistencyMode).toBe('live');
    });

    it('should return null for unknown snapshot', () => {
      expect(manager.get('nonexistent')).toBeNull();
    });
  });

  describe('delete', () => {
    it('should delete a snapshot', () => {
      const snap = manager.create('sess-1', 5, 'bx-1');
      manager.delete(snap.id);
      expect(manager.get(snap.id)).toBeNull();
    });
  });
});
