import type { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL } from '../schema.ts';
import { migration002 } from './002-phase2-memory-and-snapshots.ts';
import { migration003 } from './003-d3-harness-session-status.ts';
import { migration004 } from './004-d3-3-multi-agent-sessions.ts';
import { migration005 } from './005-d3-5-1-change-log.ts';
import { migration006 } from './006-d3-5-2a-approvals.ts';
import { migration007 } from './007-d3-5-3-agent-tasks.ts';
import { migration008 } from './008-d3-5-3b-session-quarantine.ts';
import { migration009 } from './009-d3-5-3-command-debug.ts';
import { migration010 } from './010-d3-5-3d-agent-usage.ts';
import { migration011 } from './011-d3-5-3d-usage-model.ts';
import { migration012 } from './012-collab-message-bus.ts';
import { migration013 } from './013-collab-message-reason.ts';
import { migration014 } from './014-collab-budgets-and-orchestration.ts';
import { migration015 } from './015-collab-contributions.ts';
import { migration016 } from './016-agent-participation.ts';
import { migration017 } from './017-board-and-cross-review.ts';
import { migration018 } from './018-board-requested-agent.ts';
import { migration019 } from './019-workspaces.ts';
import { migration020 } from './020-project-background.ts';
import { migration021 } from './021-session-permission-mode.ts';
import { migration022 } from './022-conversation-title-source.ts';
import type { Migration } from './types.ts';

export type { Migration };

export const migrations: Migration[] = [
  {
    id: '001_initial_schema',
    up: (db) => {
      db.exec(SCHEMA_SQL);
    },
  },
  migration002,
  migration003,
  migration004,
  migration005,
  migration006,
  migration007,
  migration008,
  migration009,
  migration010,
  migration011,
  migration012,
  migration013,
  migration014,
  migration015,
  migration016,
  migration017,
  migration018,
  migration019,
  migration020,
  migration021,
  migration022,
];

export function runMigrations(db: DatabaseSync): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)',
  );

  const appliedRows = db.prepare('SELECT id FROM schema_migrations').all() as Array<{ id: string }>;
  const applied = new Set(appliedRows.map((row) => row.id));

  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;

    db.exec('BEGIN IMMEDIATE');
    try {
      migration.up(db);
      db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(
        migration.id,
        new Date().toISOString(),
      );
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}
