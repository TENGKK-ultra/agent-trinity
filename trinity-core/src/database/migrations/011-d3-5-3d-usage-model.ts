import type { DatabaseSync } from 'node:sqlite';
import type { Migration } from './types.ts';

function columnExists(db: DatabaseSync, table: string, column: string): boolean {
  const columns = db.prepare('SELECT name FROM pragma_table_info(?)').all(table) as Array<{
    name: string;
  }>;

  return columns.some((row) => row.name === column);
}

/*
 * The model recorded here is the one configured when the turn started, not the
 * one a provider might report in its stream. Historical rows stay null: nothing
 * backfills them from today's session settings.
 */
export const migration011: Migration = {
  id: '011_d3_5_3d_usage_model',
  up: (db) => {
    if (!columnExists(db, 'agent_usage', 'model')) {
      db.exec('ALTER TABLE agent_usage ADD COLUMN model TEXT');
    }
  },
};
