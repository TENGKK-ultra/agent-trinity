import type { Migration } from './types.ts';

/*
 * One row per delegated task. A task records three independent facts:
 *
 *   status           — whether the target agent ran, and how it ended
 *   result_message_id— whether the result is persisted (completed only)
 *   delivery_status  — whether the result reached the caller's transport
 *
 * They never overwrite each other: a completed task whose result was never
 * delivered is `completed` + `failed`, not a failure of execution.
 */
const AGENT_TASKS_SQL = `
CREATE TABLE IF NOT EXISTS agent_tasks (
  id                TEXT PRIMARY KEY,
  conversation_id   TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  parent_task_id    TEXT REFERENCES agent_tasks(id) ON DELETE SET NULL,
  chain_id          TEXT NOT NULL,
  depth             INTEGER NOT NULL DEFAULT 0,
  source_agent      TEXT,
  source_turn_id    TEXT,
  target_agent      TEXT NOT NULL,
  target_turn_id    TEXT,
  title             TEXT NOT NULL,
  instruction       TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN
                      ('queued', 'running', 'completed', 'failed', 'timeout', 'cancelled')),
  delivery_status   TEXT NOT NULL DEFAULT 'pending' CHECK (delivery_status IN
                      ('pending', 'delivered', 'failed')),
  result_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  error_text        TEXT,
  created_at        TEXT NOT NULL,
  started_at        TEXT,
  finished_at       TEXT,
  CHECK (status <> 'completed' OR result_message_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS ix_agent_tasks_conversation
  ON agent_tasks(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS ix_agent_tasks_parent
  ON agent_tasks(parent_task_id);
CREATE INDEX IF NOT EXISTS ix_agent_tasks_open
  ON agent_tasks(conversation_id, status);
CREATE INDEX IF NOT EXISTS ix_agent_tasks_chain
  ON agent_tasks(chain_id, status);
`;

export const migration007: Migration = {
  id: '007_d3_5_3_agent_tasks',
  up: (db) => {
    db.exec(AGENT_TASKS_SQL);
  },
};
