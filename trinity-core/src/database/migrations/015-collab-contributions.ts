import type { Migration } from './types.ts';

/*
 * P3 acceptance found one fact with nowhere to live: what the coordinator
 * itself produced. A planning turn can be the whole deliverable, yet the ledger
 * only knew about tasks, so the round reported "nothing was done".
 *
 *   round_contributions  what an agent produced in its own turn, with the chat
 *                        message that carries it as evidence
 *
 * A contribution is deliberately not a task: it has no target, no delivery
 * state and no chain. Keeping it in its own table is what stops "the planning
 * text was a task result" from becoming true by accident.
 *
 * The two round columns record a requirement the user stated in the round:
 * `min_assignments` is how many distinct agents must take part before the round
 * may claim it is done, and `blocked_phase` tells resume where to go back to.
 */
const SQL = `
CREATE TABLE IF NOT EXISTS round_contributions (
  id              TEXT PRIMARY KEY,
  round_id        TEXT NOT NULL REFERENCES collab_rounds(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  agent           TEXT NOT NULL,
  phase           TEXT NOT NULL CHECK (phase IN ('planning', 'checkpoint', 'rework')),
  content         TEXT NOT NULL,
  message_id      TEXT,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_round_contributions_round
  ON round_contributions(round_id, created_at);

ALTER TABLE collab_rounds ADD COLUMN min_assignments INTEGER NOT NULL DEFAULT 0;
ALTER TABLE collab_rounds ADD COLUMN blocked_phase TEXT;
`;

export const migration015: Migration = {
  id: '015_collab_contributions',
  up: (db) => {
    db.exec(SQL);
  },
};
