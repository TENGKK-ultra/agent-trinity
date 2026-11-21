import type { Migration } from './types.ts';

/*
 * The whiteboard: a card is a unit of work, a claim is a lease on it, and the
 * events are the record of what happened. Five tables, each with one job:
 *
 *   board_cards     what is to be done, who holds it, and how far the review loop got
 *   board_events    append-only history of a card
 *   board_messages  agent-to-agent traffic about cards (not the chat log)
 *   board_findings  issues raised by the verifier; the right-hand todo page reads this
 *   app_settings    global knobs such as the cross-review round limit
 *
 * Boundaries kept from the design:
 *   - a card is not a task; `agent_tasks` stays the execution ledger
 *   - the chat stays in `messages`; board traffic lives here
 *   - the lease lives on the card, so there is one truth about who holds it
 */
const SQL = `
CREATE TABLE IF NOT EXISTS board_cards (
  id                       TEXT PRIMARY KEY,
  conversation_id          TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  title                    TEXT NOT NULL,
  goal                     TEXT NOT NULL,
  inputs_json              TEXT,
  acceptance_json          TEXT,
  constraints_text         TEXT,
  required_capabilities_json TEXT,
  status                   TEXT NOT NULL CHECK (status IN (
    'open', 'claimed', 'running', 'done', 'failed', 'cancelled'
  )),
  created_by_kind          TEXT NOT NULL CHECK (created_by_kind IN ('user', 'agent')),
  created_by               TEXT NOT NULL,
  claimed_by               TEXT,
  claim_token              TEXT,
  claim_expires_at         TEXT,
  result_message_id        TEXT REFERENCES messages(id) ON DELETE SET NULL,
  execution_task_id        TEXT REFERENCES agent_tasks(id) ON DELETE SET NULL,
  cross_round_limit        INTEGER NOT NULL DEFAULT 5 CHECK (cross_round_limit BETWEEN 1 AND 10),
  cross_round_used         INTEGER NOT NULL DEFAULT 0 CHECK (cross_round_used >= 0),
  cross_phase              TEXT NOT NULL DEFAULT 'idle' CHECK (cross_phase IN (
    'idle', 'dispatched', 'cc_work', 'dsh_review', 'summary', 'waiting_user'
  )),
  cross_pass_streak        INTEGER NOT NULL DEFAULT 0 CHECK (cross_pass_streak >= 0),
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL,
  closed_at                TEXT
);

CREATE INDEX IF NOT EXISTS idx_board_cards_conversation
  ON board_cards(conversation_id, status, created_at);

CREATE INDEX IF NOT EXISTS idx_board_cards_claimant
  ON board_cards(claimed_by, claim_expires_at);

CREATE TABLE IF NOT EXISTS board_events (
  id          TEXT PRIMARY KEY,
  card_id     TEXT NOT NULL REFERENCES board_cards(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN (
    'created', 'claimed', 'renewed', 'released',
    'round_started', 'reviewed', 'round_limit_reached',
    'summarized', 'completed', 'failed', 'cancelled', 'expired'
  )),
  actor_kind  TEXT NOT NULL CHECK (actor_kind IN ('user', 'agent', 'system')),
  actor       TEXT NOT NULL,
  detail_json TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_board_events_card
  ON board_events(card_id, created_at);

CREATE TRIGGER IF NOT EXISTS board_events_no_update
BEFORE UPDATE ON board_events
BEGIN
  SELECT RAISE(ABORT, 'board_events is append-only');
END;

CREATE TRIGGER IF NOT EXISTS board_events_no_delete
BEFORE DELETE ON board_events
BEGIN
  SELECT RAISE(ABORT, 'board_events is append-only');
END;

CREATE TABLE IF NOT EXISTS board_messages (
  id                TEXT PRIMARY KEY,
  conversation_id   TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  card_id           TEXT REFERENCES board_cards(id) ON DELETE SET NULL,
  kind              TEXT NOT NULL CHECK (kind IN (
    'utterance', 'notice', 'assignment', 'question', 'result', 'review'
  )),
  from_kind         TEXT NOT NULL CHECK (from_kind IN ('user', 'agent', 'system')),
  from_agent        TEXT,
  to_agent          TEXT,
  content           TEXT NOT NULL,
  parent_message_id TEXT REFERENCES board_messages(id) ON DELETE SET NULL,
  request_id        TEXT NOT NULL UNIQUE,
  fingerprint       TEXT NOT NULL,
  hop               INTEGER NOT NULL DEFAULT 0 CHECK (hop >= 0),
  state             TEXT NOT NULL CHECK (state IN (
    'queued', 'delivered', 'consumed', 'expired'
  )),
  created_at        TEXT NOT NULL,
  delivered_at      TEXT,
  consumed_at       TEXT
);

CREATE INDEX IF NOT EXISTS idx_board_messages_inbox
  ON board_messages(to_agent, state, created_at);

CREATE INDEX IF NOT EXISTS idx_board_messages_card
  ON board_messages(card_id, created_at);

CREATE TABLE IF NOT EXISTS board_findings (
  id          TEXT PRIMARY KEY,
  card_id     TEXT NOT NULL REFERENCES board_cards(id) ON DELETE CASCADE,
  round_no    INTEGER NOT NULL CHECK (round_no >= 1),
  title       TEXT NOT NULL,
  detail      TEXT,
  status      TEXT NOT NULL CHECK (status IN ('open', 'addressed', 'resolved', 'wontfix')),
  raised_by   TEXT NOT NULL,
  resolved_by TEXT,
  created_at  TEXT NOT NULL,
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_board_findings_open
  ON board_findings(card_id, status, round_no);

CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO app_settings (key, value, updated_at)
VALUES ('cross_round_limit', '5', '2026-11-20T00:00:00.000Z');
`;

export const migration017: Migration = {
  id: '017_board_and_cross_review',
  up: (db) => {
    db.exec(SQL);
  },
};
