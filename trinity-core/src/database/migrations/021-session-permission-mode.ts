import type { Migration } from './types.ts';

/*
 * Per-conversation approval behaviour for the harness. Null keeps today's
 * behaviour (every tool asks); the value is passed to the CLI that supports it.
 */
export const migration021: Migration = {
  id: '021_session_permission_mode',
  up: (db) => {
    db.exec('ALTER TABLE harness_sessions ADD COLUMN permission_mode TEXT;');
  },
};
