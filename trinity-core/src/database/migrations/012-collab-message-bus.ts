import type { Migration } from './types.ts';

/*
 * The collaboration bus. Five tables, each answering one question:
 *
 *   collab_rounds  — what is this round trying to deliver, and did it?
 *   agent_messages — what did one agent say to another, and did it arrive?
 *   round_roles    — who holds which responsibility right now
 *   role_events    — why the responsibility changed (append-only)
 *   round_reviews  — who reviewed which delivery, and how independent it was
 *
 * Boundaries that keep one fact in one place:
 *   - the chat transcript stays in `messages`; this table is machine traffic
 *   - a task's state stays in `agent_tasks`; a message only says it arrived
 *   - a role's history is `role_events`; `round_roles` is only the current row
 */
const COLLAB_SQL = `
CREATE TABLE IF NOT EXISTS collab_rounds (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  goal            TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN (
    'created', 'planning', 'running', 'reviewing',
    'blocked', 'delivered', 'failed', 'cancelled'
  )),
  outcome         TEXT CHECK (outcome IS NULL OR outcome IN (
    'completed', 'partially_completed', 'failed', 'cancelled'
  )),
  coordinator     TEXT,
  review_required INTEGER NOT NULL DEFAULT 0 CHECK (review_required IN (0, 1)),
  budget_hops     INTEGER NOT NULL DEFAULT 6 CHECK (budget_hops >= 0),
  hops_used       INTEGER NOT NULL DEFAULT 0 CHECK (hops_used >= 0),
  blocked_reason  TEXT,
  wake_condition  TEXT,
  created_at      TEXT NOT NULL,
  closed_at       TEXT
);

CREATE INDEX IF NOT EXISTS idx_collab_rounds_conversation
  ON collab_rounds(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS agent_messages (
  id                TEXT PRIMARY KEY,
  round_id          TEXT NOT NULL REFERENCES collab_rounds(id) ON DELETE CASCADE,
  conversation_id   TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  kind              TEXT NOT NULL CHECK (kind IN ('utterance', 'notice', 'assignment')),
  from_agent        TEXT NOT NULL,
  to_agent          TEXT,
  content           TEXT NOT NULL,
  parent_message_id TEXT REFERENCES agent_messages(id) ON DELETE SET NULL,
  task_id           TEXT REFERENCES agent_tasks(id) ON DELETE SET NULL,
  request_id        TEXT NOT NULL UNIQUE,
  fingerprint       TEXT NOT NULL,
  state             TEXT NOT NULL CHECK (state IN (
    'queued', 'delivered', 'consumed', 'task_running', 'task_completed',
    'task_failed', 'refused', 'expired', 'failed', 'uncertain'
  )),
  refusal_reason    TEXT,
  hop               INTEGER NOT NULL DEFAULT 1 CHECK (hop >= 0),
  created_at        TEXT NOT NULL,
  delivered_at      TEXT,
  consumed_at       TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_messages_inbox
  ON agent_messages(to_agent, state, created_at);

CREATE INDEX IF NOT EXISTS idx_agent_messages_round
  ON agent_messages(round_id, created_at);

-- One assignment per (round, target, content): a retry cannot create a second
-- task. Notices and utterances are deliberately outside this index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_messages_assignment_once
  ON agent_messages(round_id, to_agent, fingerprint)
  WHERE kind = 'assignment';

CREATE TABLE IF NOT EXISTS round_roles (
  round_id    TEXT NOT NULL REFERENCES collab_rounds(id) ON DELETE CASCADE,
  agent       TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('coordinator', 'contributor', 'reviewer', 'observer')),
  assigned_by TEXT NOT NULL,
  reason      TEXT,
  assigned_at TEXT NOT NULL,
  PRIMARY KEY (round_id, agent)
);

CREATE TABLE IF NOT EXISTS role_events (
  id          TEXT PRIMARY KEY,
  round_id    TEXT NOT NULL REFERENCES collab_rounds(id) ON DELETE CASCADE,
  agent       TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('coordinator', 'contributor', 'reviewer', 'observer')),
  action      TEXT NOT NULL CHECK (action IN ('grant', 'revoke', 'handover')),
  successor   TEXT,
  assigned_by TEXT NOT NULL,
  reason      TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_role_events_round
  ON role_events(round_id, created_at);

CREATE TABLE IF NOT EXISTS round_reviews (
  id             TEXT PRIMARY KEY,
  round_id       TEXT NOT NULL REFERENCES collab_rounds(id) ON DELETE CASCADE,
  producer       TEXT NOT NULL,
  reviewer       TEXT,
  producer_model TEXT,
  reviewer_model TEXT,
  same_provider  INTEGER CHECK (same_provider IS NULL OR same_provider IN (0, 1)),
  status         TEXT NOT NULL CHECK (status IN ('pass', 'needs_changes', 'review_unavailable')),
  findings_json  TEXT,
  created_at     TEXT NOT NULL
);
`;

export const migration012: Migration = {
  id: '012_collab_message_bus',
  up: (db) => {
    db.exec(COLLAB_SQL);
  },
};
