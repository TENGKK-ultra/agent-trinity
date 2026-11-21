import type { DatabaseSync } from 'node:sqlite';
import type { Conversation, ConversationStatus } from '../types/index.ts';

export interface ConversationListFilters {
  status?: ConversationStatus;
  title?: string;
  sort: 'created' | 'updated';
  order: 'asc' | 'desc';
  limit: number;
  offset: number;
}

function buildWhere(filters: Pick<ConversationListFilters, 'status' | 'title'>): {
  whereSql: string;
  params: Array<string>;
} {
  const conditions: string[] = [];
  const params: string[] = [];

  if (filters.status) {
    conditions.push('status = ?');
    params.push(filters.status);
  }

  if (filters.title) {
    conditions.push('title LIKE ?');
    params.push(`%${filters.title}%`);
  }

  return {
    whereSql: conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '',
    params,
  };
}

export function insertConversation(db: DatabaseSync, conversation: Conversation): void {
  db.prepare(
    `INSERT INTO conversations (id, project_id, title, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    conversation.id,
    conversation.project_id,
    conversation.title,
    conversation.status,
    conversation.created_at,
    conversation.updated_at,
  );
}

export function findConversation(db: DatabaseSync, id: string): Conversation | undefined {
  return db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as Conversation | undefined;
}

export function listConversations(
  db: DatabaseSync,
  filters: ConversationListFilters,
): Conversation[] {
  const { whereSql, params } = buildWhere(filters);
  // sort/order come from closed sets validated by the service, so interpolation is safe here.
  const sortColumn = filters.sort === 'created' ? 'created_at' : 'updated_at';
  const direction = filters.order === 'asc' ? 'ASC' : 'DESC';

  return db
    .prepare(
      `SELECT * FROM conversations${whereSql}
       ORDER BY ${sortColumn} ${direction}, rowid ${direction}
       LIMIT ? OFFSET ?`,
    )
    .all(...params, filters.limit, filters.offset) as unknown as Conversation[];
}

export function countConversations(
  db: DatabaseSync,
  filters: Pick<ConversationListFilters, 'status' | 'title'>,
): number {
  const { whereSql, params } = buildWhere(filters);
  const row = db
    .prepare(`SELECT COUNT(*) AS total FROM conversations${whereSql}`)
    .get(...params) as { total: number } | undefined;

  return row?.total ?? 0;
}

export function updateConversation(
  db: DatabaseSync,
  id: string,
  patch: { title?: string; status?: ConversationStatus; updated_at: string },
): void {
  const assignments: string[] = ['updated_at = ?'];
  const params: Array<string> = [patch.updated_at];

  if (patch.title !== undefined) {
    assignments.push('title = ?');
    params.push(patch.title);
  }

  if (patch.status !== undefined) {
    assignments.push('status = ?');
    params.push(patch.status);
  }

  params.push(id);

  db.prepare(`UPDATE conversations SET ${assignments.join(', ')} WHERE id = ?`).run(...params);
}

export function touchConversation(db: DatabaseSync, id: string, updatedAt: string): void {
  db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(updatedAt, id);
}
