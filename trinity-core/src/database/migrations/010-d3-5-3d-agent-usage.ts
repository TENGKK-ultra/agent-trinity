import type { Migration } from './types.ts';

/*
 * One row per reported usage event. Provider fields are stored exactly as the
 * provider reported them; the normalised columns are what cross-agent totals
 * are built from. Keeping both is what stops Codex's "cached inside input"
 * from being added to Claude's "input excludes cache".
 *
 * `provider_turn` / `provider_step` default to -1 rather than NULL: SQLite
 * treats NULLs as distinct in a UNIQUE index, which would let duplicates in.
 */
const AGENT_USAGE_SQL = `
CREATE TABLE IF NOT EXISTS agent_usage (
  id                              TEXT PRIMARY KEY,
  agent                           TEXT NOT NULL,
  conversation_id                 TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  turn_id                         TEXT NOT NULL,
  provider_session_id             TEXT,
  task_id                         TEXT,
  scope                           TEXT NOT NULL CHECK (scope IN ('turn', 'step')),
  provider_turn                   INTEGER NOT NULL DEFAULT -1,
  provider_step                   INTEGER NOT NULL DEFAULT -1,
  counter_scope                   TEXT NOT NULL CHECK (counter_scope IN ('turn', 'thread')),
  provider_input_tokens           INTEGER,
  provider_output_tokens          INTEGER,
  provider_reasoning_output_tokens INTEGER,
  provider_cache_read_tokens      INTEGER,
  provider_cache_write_tokens     INTEGER,
  provider_total_tokens           INTEGER,
  provider_cost_usd               REAL,
  cache_in_input                  INTEGER NOT NULL CHECK (cache_in_input IN (0, 1)),
  normalized_input_tokens         INTEGER,
  normalized_total_tokens         INTEGER,
  anomaly                         TEXT,
  usage_source                    TEXT NOT NULL DEFAULT 'provider',
  recorded_at                     TEXT NOT NULL,
  UNIQUE (agent, turn_id, scope, provider_turn, provider_step)
);

CREATE INDEX IF NOT EXISTS ix_agent_usage_conversation
  ON agent_usage(conversation_id, recorded_at);
CREATE INDEX IF NOT EXISTS ix_agent_usage_task
  ON agent_usage(task_id);
CREATE INDEX IF NOT EXISTS ix_agent_usage_session
  ON agent_usage(agent, conversation_id, provider_session_id, recorded_at);
`;

export const migration010: Migration = {
  id: '010_d3_5_3d_agent_usage',
  up: (db) => {
    db.exec(AGENT_USAGE_SQL);
  },
};
