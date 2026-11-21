import type { Migration } from './types.ts';

/*
 * P3 adds the state the orchestrator needs and nothing it does not:
 *
 *   collab_rounds   two more budgets (exec / usage), their counters, the moment
 *                   a round blocked, and which chat message carried the delivery
 *   agent_messages  how many checkpoint turns already saw a message, so an
 *                   undecided request wakes an agent a bounded number of times
 *   agent_tasks     what kind of work a task was, so capability is judged from
 *                   evidence rather than a hard-coded table
 *   agent_usage     which round a turn belonged to, so the usage budget reads
 *                   the same ledger the usage pages already read
 *
 * Every column is additive with a default; no row is rewritten and no backfill
 * is needed. Rolling back means dropping the columns (SQLite >= 3.35 ALTER TABLE
 * DROP COLUMN); nothing here is referenced by a constraint that would prevent it.
 */
const SQL = `
ALTER TABLE collab_rounds ADD COLUMN budget_exec INTEGER NOT NULL DEFAULT 12;
ALTER TABLE collab_rounds ADD COLUMN exec_used INTEGER NOT NULL DEFAULT 0;
ALTER TABLE collab_rounds ADD COLUMN budget_usage_tokens INTEGER;
ALTER TABLE collab_rounds ADD COLUMN blocked_at TEXT;
ALTER TABLE collab_rounds ADD COLUMN delivery_message_id TEXT;

ALTER TABLE agent_messages ADD COLUMN presented_count INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_agent_messages_round_state
  ON agent_messages(round_id, state);

ALTER TABLE agent_tasks ADD COLUMN task_type TEXT NOT NULL DEFAULT 'general';

ALTER TABLE agent_usage ADD COLUMN round_id TEXT;
CREATE INDEX IF NOT EXISTS idx_agent_usage_round ON agent_usage(round_id);
`;

export const migration014: Migration = {
  id: '014_collab_budgets_and_orchestration',
  up: (db) => {
    db.exec(SQL);
  },
};
