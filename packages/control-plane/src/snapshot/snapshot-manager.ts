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
  }

  /**
   * Create a snapshot record.
   */
  create(sessionId: string, seq: number, boxliteSnapshotId: string, label?: string): Snapshot {
    const snapshot: Snapshot = {
      id: nanoid(),
      sessionId,
      seq,
      label,
      createdAt: Date.now(),
      boxliteSnapshotId,
    };

    this.db
      .prepare(`INSERT INTO snapshots (id, session_id, seq, label, created_at, boxlite_snapshot_id)
                VALUES (?, ?, ?, ?, ?, ?)`)
      .run(snapshot.id, snapshot.sessionId, snapshot.seq, snapshot.label ?? null, snapshot.createdAt, snapshot.boxliteSnapshotId);

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
        created_at: number; boxlite_snapshot_id: string;
      }>;

    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      seq: r.seq,
      label: r.label ?? undefined,
      createdAt: r.created_at,
      boxliteSnapshotId: r.boxlite_snapshot_id,
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
        created_at: number; boxlite_snapshot_id: string;
      } | undefined;

    if (!row) return null;

    return {
      id: row.id,
      sessionId: row.session_id,
      seq: row.seq,
      label: row.label ?? undefined,
      createdAt: row.created_at,
      boxliteSnapshotId: row.boxlite_snapshot_id,
    };
  }

  /**
   * Delete a snapshot.
   */
  delete(snapshotId: string): void {
    this.db.prepare('DELETE FROM snapshots WHERE id = ?').run(snapshotId);
  }
}
