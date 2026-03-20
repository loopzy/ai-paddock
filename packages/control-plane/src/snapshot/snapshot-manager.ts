import Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import type { Snapshot } from '../types.js';

/**
 * Snapshot Manager — handles creation and restoration of VM snapshots.
 *
 * Snapshots are tied to event sequences, allowing time-travel rollback.
 */

export class SnapshotManager {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.migrate();
  }

  private migrate() {
    const cols = this.db.prepare('PRAGMA table_info(snapshots)').all() as Array<{ name: string }>;
    const names = new Set(cols.map((col) => col.name));
    if (!names.has('size_bytes')) {
      this.db.exec('ALTER TABLE snapshots ADD COLUMN size_bytes INTEGER');
    }
    if (!names.has('container_disk_bytes')) {
      this.db.exec('ALTER TABLE snapshots ADD COLUMN container_disk_bytes INTEGER');
    }
    if (!names.has('consistency_mode')) {
      this.db.exec("ALTER TABLE snapshots ADD COLUMN consistency_mode TEXT NOT NULL DEFAULT 'live'");
    }
  }

  /**
   * Create a snapshot record.
   */
  create(
    sessionId: string,
    seq: number,
    boxliteSnapshotId: string,
    label?: string,
    metrics?: { sizeBytes?: number; containerDiskBytes?: number },
    consistencyMode: 'live' | 'stopped' = 'live',
  ): Snapshot {
    const snapshot: Snapshot = {
      id: nanoid(),
      sessionId,
      seq,
      label,
      createdAt: Date.now(),
      boxliteSnapshotId,
      sizeBytes: metrics?.sizeBytes,
      containerDiskBytes: metrics?.containerDiskBytes,
      consistencyMode,
    };

    this.db
      .prepare(`INSERT INTO snapshots (id, session_id, seq, label, created_at, boxlite_snapshot_id, size_bytes, container_disk_bytes, consistency_mode)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        snapshot.id,
        snapshot.sessionId,
        snapshot.seq,
        snapshot.label ?? null,
        snapshot.createdAt,
        snapshot.boxliteSnapshotId,
        snapshot.sizeBytes ?? null,
        snapshot.containerDiskBytes ?? null,
        snapshot.consistencyMode,
      );

    return snapshot;
  }

  /**
   * Get all snapshots for a session.
   */
  list(sessionId: string): Snapshot[] {
    const rows = this.db
      .prepare('SELECT * FROM snapshots WHERE session_id = ? ORDER BY seq ASC')
      .all(sessionId) as Array<{
        id: string; session_id: string; seq: number; label: string | null;
        created_at: number; boxlite_snapshot_id: string; size_bytes: number | null; container_disk_bytes: number | null; consistency_mode: 'live' | 'stopped';
      }>;

    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      seq: r.seq,
      label: r.label ?? undefined,
      createdAt: r.created_at,
      boxliteSnapshotId: r.boxlite_snapshot_id,
      sizeBytes: r.size_bytes ?? undefined,
      containerDiskBytes: r.container_disk_bytes ?? undefined,
      consistencyMode: r.consistency_mode,
    }));
  }

  /**
   * Get a specific snapshot.
   */
  get(snapshotId: string): Snapshot | null {
    const row = this.db
      .prepare('SELECT * FROM snapshots WHERE id = ?')
      .get(snapshotId) as {
        id: string; session_id: string; seq: number; label: string | null;
        created_at: number; boxlite_snapshot_id: string; size_bytes: number | null; container_disk_bytes: number | null; consistency_mode: 'live' | 'stopped';
      } | undefined;

    if (!row) return null;

    return {
      id: row.id,
      sessionId: row.session_id,
      seq: row.seq,
      label: row.label ?? undefined,
      createdAt: row.created_at,
      boxliteSnapshotId: row.boxlite_snapshot_id,
      sizeBytes: row.size_bytes ?? undefined,
      containerDiskBytes: row.container_disk_bytes ?? undefined,
      consistencyMode: row.consistency_mode,
    };
  }

  /**
   * Delete a snapshot.
   */
  delete(snapshotId: string): void {
    this.db.prepare('DELETE FROM snapshots WHERE id = ?').run(snapshotId);
  }
}
