import type { DatabaseSync } from 'node:sqlite';
import {
  ACTIVITY_MESSAGE_TYPES,
  type Message,
  type MessageType,
  type SenderKind,
} from '../types/index.ts';

export interface MessageListFilters {
  messageType?: MessageType;
  senderKind?: SenderKind;
  /** Leave internal activity out of the conversation view. */
  excludeActivity?: boolean;
  limit: number;
  offset: number;
}

function buildWhere(
  conversationId: string,
  filters: Pick<MessageListFilters, 'messageType' | 'senderKind' | 'excludeActivity'>,
): { whereSql: string; params: Array<string> } {
  const conditions: string[] = ['conversation_id = ?'];
  const params: Array<string> = [conversationId];

  if (filters.messageType) {
    conditions.push('message_type = ?');
    params.push(filters.messageType);
  }

  if (filters.excludeActivity) {
    const placeholders = ACTIVITY_MESSAGE_TYPES.map(() => '?').join(', ');
    conditions.push(`message_type NOT IN (${placeholders})`);
    params.push(...ACTIVITY_MESSAGE_TYPES);
  }

  if (filters.senderKind) {
    conditions.push('sender_kind = ?');
    params.push(filters.senderKind);
  }

  return { whereSql: ` WHERE ${conditions.join(' AND ')}`, params };
}

export function insertMessage(db: DatabaseSync, message: Message): void {
  db.prepare(
    `INSERT INTO messages
       (id, conversation_id, sender_kind, sender_id, message_type, content,
        metadata_json, parent_message_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    message.id,
    message.conversation_id,
    message.sender_kind,
    message.sender_id,
    message.message_type,
    message.content,
    message.metadata_json,
    message.parent_message_id,
    message.created_at,
  );
}

export function findMessage(db: DatabaseSync, id: string): Message | undefined {
  return db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Message | undefined;
}

export function listMessages(
  db: DatabaseSync,
  conversationId: string,
  filters: MessageListFilters,
): Message[] {
  const { whereSql, params } = buildWhere(conversationId, filters);

  // rowid breaks ties when several messages share the same millisecond timestamp.
  return db
    .prepare(
      `SELECT * FROM messages${whereSql}
       ORDER BY created_at ASC, rowid ASC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, filters.limit, filters.offset) as unknown as Message[];
}

export function countMessages(
  db: DatabaseSync,
  conversationId: string,
  filters: Pick<MessageListFilters, 'messageType' | 'senderKind' | 'excludeActivity'>,
): number {
  const { whereSql, params } = buildWhere(conversationId, filters);
  const row = db
    .prepare(`SELECT COUNT(*) AS total FROM messages${whereSql}`)
    .get(...params) as { total: number } | undefined;

  return row?.total ?? 0;
}
