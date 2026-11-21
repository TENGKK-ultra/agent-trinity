import type { Migration } from './types.ts';

/*
 * A binding and "takes part in this conversation" are different facts.
 *
 * `harness_sessions.active` already says which single agent answers a normal
 * turn. The top bar needs a separate, persistent set: an agent can stay bound
 * (its native session untouched) while being switched out of the current
 * conversation, and three bound agents can take part one at a time.
 *
 * Default 1 keeps every existing binding participating, which is what it meant
 * before this column existed.
 */
const SQL = `
ALTER TABLE harness_sessions ADD COLUMN participating INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_harness_sessions_participating
  ON harness_sessions(conversation_id, participating);
`;

export const migration016: Migration = {
  id: '016_agent_participation',
  up: (db) => {
    db.exec(SQL);
  },
};
