import type { DatabaseSync } from 'node:sqlite';
import type { Migration } from './types.ts';

const SESSION_COLUMNS: Array<{ name: string; definition: string }> = [
  { name: 'status', definition: "TEXT NOT NULL DEFAULT 'idle'" },
  { name: 'last_seen_at', definition: 'TEXT' },
  { name: 'cwd', definition: 'TEXT' },
  { name: 'model', definition: 'TEXT' },
];

// At most one run may hold a session. Enforced by the database so a race cannot
// slip past an application-level check.
const SINGLE_RUN_INDEX_SQL = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_harness_locks_single_held
  ON harness_session_locks(harness_session_id)
  WHERE status = 'held';
`;

function columnExists(db: DatabaseSync, table: string, column: string): boolean {
  const columns = db.prepare('SELECT name FROM pragma_table_info(?)').all(table) as Array<{
    name: string;
  }>;

  return columns.some((entry) => entry.name === column);
}

export const migration003: Migration = {
  id: '003_d3_harness_session_status',
  up: (db) => {
    for (const column of SESSION_COLUMNS) {
      if (columnExists(db, 'harness_sessions', column.name)) continue;
      db.exec(`ALTER TABLE harness_sessions ADD COLUMN ${column.name} ${column.definition}`);
    }

    db.exec(SINGLE_RUN_INDEX_SQL);
  },
};
