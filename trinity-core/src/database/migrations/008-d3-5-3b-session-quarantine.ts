import type { DatabaseSync } from 'node:sqlite';
import type { Migration } from './types.ts';

/*
 * A session whose process could not be confirmed dead must never be reused
 * until a human says so. This is deliberately not a TTL: lock expiry only
 * releases the lock row, never this.
 */
function columnExists(db: DatabaseSync, table: string, column: string): boolean {
  const columns = db.prepare('SELECT name FROM pragma_table_info(?)').all(table) as Array<{
    name: string;
  }>;

  return columns.some((row) => row.name === column);
}

export const migration008: Migration = {
  id: '008_d3_5_3b_session_quarantine',
  up: (db) => {
    if (!columnExists(db, 'harness_sessions', 'quarantine_reason')) {
      db.exec('ALTER TABLE harness_sessions ADD COLUMN quarantine_reason TEXT');
    }

    if (!columnExists(db, 'harness_sessions', 'quarantined_at')) {
      db.exec('ALTER TABLE harness_sessions ADD COLUMN quarantined_at TEXT');
    }

    if (!columnExists(db, 'harness_sessions', 'quarantine_pid')) {
      db.exec('ALTER TABLE harness_sessions ADD COLUMN quarantine_pid INTEGER');
    }
  },
};
