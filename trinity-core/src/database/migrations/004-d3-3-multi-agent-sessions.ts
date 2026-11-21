import type { DatabaseSync } from 'node:sqlite';
import type { Migration } from './types.ts';

// A conversation may keep one session per harness; exactly one of them is the
// active one. The partial unique index makes "two active agents" impossible at
// the storage layer rather than by convention.
const ACTIVATE_ONE_PER_CONVERSATION = `
UPDATE harness_sessions SET active = 1
WHERE id IN (
  SELECT id FROM (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY conversation_id
        ORDER BY updated_at DESC, created_at DESC, id
      ) AS rank
    FROM harness_sessions
    WHERE conversation_id IS NOT NULL
  )
  WHERE rank = 1
);
`;

const ONE_ACTIVE_INDEX = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_harness_sessions_one_active
  ON harness_sessions(conversation_id)
  WHERE active = 1;
`;

function columnExists(db: DatabaseSync, table: string, column: string): boolean {
  const columns = db.prepare('SELECT name FROM pragma_table_info(?)').all(table) as Array<{
    name: string;
  }>;

  return columns.some((entry) => entry.name === column);
}

export const migration004: Migration = {
  id: '004_d3_3_multi_agent_sessions',
  up: (db) => {
    if (!columnExists(db, 'harness_sessions', 'active')) {
      db.exec('ALTER TABLE harness_sessions ADD COLUMN active INTEGER NOT NULL DEFAULT 0');
    }

    // Existing databases hold at most one row per conversation; pick it before
    // the index exists, so the backfill cannot conflict with itself.
    db.exec(ACTIVATE_ONE_PER_CONVERSATION);
    db.exec(ONE_ACTIVE_INDEX);
  },
};
