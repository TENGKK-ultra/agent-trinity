import type { Migration } from './types.ts';

/*
 * One global append-only log of state changes. Messages remain the source of
 * truth: reading, restoring or continuing a conversation never depends on this
 * table, so a future retention policy cannot make old conversations unusable.
 *
 * Retention is deliberately not implemented yet: there is no floor, no prune
 * path and no delete trigger exception. Migration 006 will add those together
 * with a cursor-expiry rule once Companion actually consumes the log.
 */
const CHANGE_LOG_SQL = `
CREATE TABLE IF NOT EXISTS change_log (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type     TEXT NOT NULL,
  entity_id       TEXT NOT NULL,
  operation       TEXT NOT NULL CHECK (operation IN ('insert', 'update', 'delete')),
  actor_type      TEXT NOT NULL CHECK (actor_type IN ('user', 'agent', 'system', 'device')),
  actor_id        TEXT,
  conversation_id TEXT,
  payload_json    TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_change_log_conversation
  ON change_log(conversation_id, seq);
CREATE INDEX IF NOT EXISTS idx_change_log_entity
  ON change_log(entity_type, entity_id, seq);

CREATE TRIGGER IF NOT EXISTS trg_change_log_no_update
BEFORE UPDATE ON change_log
BEGIN
  SELECT RAISE(ABORT, 'change_log is append-only: UPDATE is not allowed');
END;

CREATE TRIGGER IF NOT EXISTS trg_change_log_no_delete
BEFORE DELETE ON change_log
BEGIN
  SELECT RAISE(ABORT, 'change_log is append-only: DELETE is not allowed');
END;
`;

export const migration005: Migration = {
  id: '005_d3_5_1_change_log',
  up: (db) => {
    db.exec(CHANGE_LOG_SQL);
  },
};
