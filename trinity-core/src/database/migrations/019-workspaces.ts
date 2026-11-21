import type { Migration } from './types.ts';

/*
 * A workspace is a named directory an agent may work in. Sessions already store
 * the resolved `cwd`; this table is the catalog the user picks from, so the same
 * folder can be chosen again without retyping a path.
 */
export const migration019: Migration = {
  id: '019_workspaces',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS workspaces (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        path       TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  },
};
