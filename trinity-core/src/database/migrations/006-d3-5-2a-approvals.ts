import type { Migration } from './types.ts';

/*
 * One row per permission request an agent raised while a turn was running.
 *
 * Unlike change_log this table is mutable: a request moves pending -> decided.
 * The decision and its delivery are two different facts, so they are two
 * columns: `status` is what the user decided, `delivery_status` is whether that
 * decision reached the CLI. A failed delivery never rewrites the decision.
 */
const APPROVALS_SQL = `
CREATE TABLE IF NOT EXISTS approvals (
  id                 TEXT PRIMARY KEY,
  conversation_id    TEXT NOT NULL,
  harness_session_id TEXT NOT NULL,
  turn_id            TEXT NOT NULL,
  agent              TEXT NOT NULL,
  kind               TEXT NOT NULL CHECK (kind IN ('tool_approval', 'question')),
  native_request_id  TEXT NOT NULL,
  tool_use_id        TEXT,
  tool_name          TEXT,
  payload_json       TEXT NOT NULL DEFAULT '{}',
  status             TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired', 'cancelled')),
  delivery_status    TEXT NOT NULL DEFAULT 'pending' CHECK (delivery_status IN ('pending', 'delivered', 'failed')),
  decision_json      TEXT,
  created_at         TEXT NOT NULL,
  decided_at         TEXT,
  expires_at         TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_approvals_native
  ON approvals(harness_session_id, native_request_id);

CREATE INDEX IF NOT EXISTS ix_approvals_open
  ON approvals(conversation_id, status);
`;

export const migration006: Migration = {
  id: '006_d3_5_2a_approvals',
  up: (db) => {
    db.exec(APPROVALS_SQL);
  },
};
