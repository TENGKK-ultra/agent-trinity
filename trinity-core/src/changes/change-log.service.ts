import type { DatabaseSync } from 'node:sqlite';
import { isInTransaction } from '../database/transaction.ts';

export type ChangeOperation = 'insert' | 'update' | 'delete';
export type ChangeActorType = 'user' | 'agent' | 'system' | 'device';

export interface ChangeActor {
  type: ChangeActorType;
  id?: string | null;
}

export const USER_ACTOR: ChangeActor = { type: 'user' };
export const SYSTEM_ACTOR: ChangeActor = { type: 'system', id: 'core' };

export function agentActor(agent: string): ChangeActor {
  return { type: 'agent', id: agent };
}

export interface ChangeEntry {
  entityType:
    | 'conversation'
    | 'message'
    | 'harness_session'
    | 'approval'
    | 'agent_task'
    | 'board_card'
    | 'app_setting'
    | 'workspace'
    | 'project';
  entityId: string;
  operation: ChangeOperation;
  actor: ChangeActor;
  conversationId?: string | null;
  /** Metadata only: never the message body. Full data is read from its table. */
  payload?: Record<string, unknown>;
}

/**
 * Records one change. It must run inside the transaction that wrote the business
 * row, so either both land or neither does; calling it outside is a programming
 * error rather than a silent gap in the log.
 */
export function appendChange(db: DatabaseSync, entry: ChangeEntry): number {
  if (!isInTransaction()) {
    throw new Error(
      `appendChange(${entry.entityType}/${entry.operation}) must run inside the business transaction`,
    );
  }

  const result = db
    .prepare(
      `INSERT INTO change_log
         (entity_type, entity_id, operation, actor_type, actor_id,
          conversation_id, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      entry.entityType,
      entry.entityId,
      entry.operation,
      entry.actor.type,
      entry.actor.id ?? null,
      entry.conversationId ?? null,
      JSON.stringify(entry.payload ?? {}),
      new Date().toISOString(),
    );

  return Number(result.lastInsertRowid);
}

export interface ChangeRow {
  seq: number;
  entity_type: string;
  entity_id: string;
  operation: ChangeOperation;
  actor_type: ChangeActorType;
  actor_id: string | null;
  conversation_id: string | null;
  payload_json: string;
  created_at: string;
}

/** Read path used by tests today; the Companion sync API comes later. */
export function listChangesAfter(
  db: DatabaseSync,
  afterSeq: number,
  options: { conversationId?: string; limit?: number } = {},
): ChangeRow[] {
  const limit = Math.min(Math.max(options.limit ?? 200, 1), 1000);

  if (options.conversationId) {
    return db
      .prepare(
        `SELECT * FROM change_log
         WHERE conversation_id = ? AND seq > ?
         ORDER BY seq ASC
         LIMIT ?`,
      )
      .all(options.conversationId, afterSeq, limit) as unknown as ChangeRow[];
  }

  return db
    .prepare(
      `SELECT * FROM change_log
       WHERE seq > ?
       ORDER BY seq ASC
       LIMIT ?`,
    )
    .all(afterSeq, limit) as unknown as ChangeRow[];
}
