import type { Migration } from './types.ts';

/*
 * Raw command lines live away from `messages` on purpose. Everything in
 * `messages` is served to the dashboard; this table is served by nothing. It is
 * separate so that clearing debug data can never touch chat or activity rows.
 */
const COMMAND_DEBUG_SQL = `
CREATE TABLE IF NOT EXISTS command_debug (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id      TEXT,
  turn_id         TEXT NOT NULL,
  agent           TEXT NOT NULL,
  program         TEXT NOT NULL,
  command         TEXT NOT NULL,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_command_debug_created
  ON command_debug(created_at);
CREATE INDEX IF NOT EXISTS ix_command_debug_conversation
  ON command_debug(conversation_id, created_at);
`;

export const migration009: Migration = {
  id: '009_d3_5_3_command_debug',
  up: (db) => {
    db.exec(COMMAND_DEBUG_SQL);
  },
};
