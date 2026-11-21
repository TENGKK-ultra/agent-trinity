export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id         TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  title      TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conversations_created ON conversations(created_at);
CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at);

CREATE TABLE IF NOT EXISTS messages (
  id                TEXT PRIMARY KEY,
  conversation_id   TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_kind       TEXT NOT NULL CHECK (sender_kind IN ('user', 'agent', 'system')),
  sender_id         TEXT,
  message_type      TEXT NOT NULL CHECK (message_type IN (
    'user_message', 'agent_message', 'agent_final',
    'tool_call', 'tool_result', 'system_event', 'task_status'
  )),
  content           TEXT NOT NULL,
  metadata_json     TEXT,
  parent_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  created_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_time
  ON messages(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS agent_participants (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  agent_name      TEXT NOT NULL,
  state           TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'paused')),
  joined_at       TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (conversation_id, agent_name)
);

CREATE TABLE IF NOT EXISTS harness_sessions (
  id                   TEXT PRIMARY KEY,
  harness_type         TEXT NOT NULL,
  native_session_id    TEXT NOT NULL,
  project_id           TEXT REFERENCES projects(id) ON DELETE SET NULL,
  conversation_id      TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  source               TEXT,
  last_read_at         TEXT,
  last_summary_version INTEGER,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_harness_sessions_conversation
  ON harness_sessions(conversation_id);

CREATE TABLE IF NOT EXISTS harness_session_locks (
  id                  TEXT PRIMARY KEY,
  harness_session_id  TEXT NOT NULL REFERENCES harness_sessions(id) ON DELETE CASCADE,
  owner_task_id       TEXT NOT NULL,
  acquired_at         TEXT NOT NULL,
  expires_at          TEXT,
  status              TEXT NOT NULL DEFAULT 'held' CHECK (status IN ('held', 'released', 'expired'))
);

CREATE INDEX IF NOT EXISTS idx_harness_session_locks_session
  ON harness_session_locks(harness_session_id, status);

CREATE TABLE IF NOT EXISTS project_memory (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  content    TEXT NOT NULL,
  confirmed  INTEGER NOT NULL DEFAULT 0 CHECK (confirmed IN (0, 1)),
  version    INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_project_memory_project
  ON project_memory(project_id, kind);

CREATE TABLE IF NOT EXISTS context_snapshots (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version    INTEGER NOT NULL,
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, version)
);
`;
