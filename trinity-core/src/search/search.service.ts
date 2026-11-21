import type { DatabaseSync } from 'node:sqlite';
import { parseBoundedInteger } from '../common/validation.ts';

/**
 * 全局搜索只翻两样东西：对话标题和对话正文。
 * 工具调用、系统事件这些内部记录不参与——它们不是"我写过的话"。
 */
const SEARCHABLE_MESSAGE_TYPES = ['user_message', 'agent_message', 'agent_final'];

const MAX_QUERY_LENGTH = 100;
const SNIPPET_RADIUS = 42;
const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 12;

export interface ConversationHit {
  id: string;
  title: string;
  updated_at: string;
}

export interface MessageHit {
  message_id: string;
  conversation_id: string;
  conversation_title: string;
  sender_kind: string;
  snippet: string;
  created_at: string;
}

export interface SearchResult {
  query: string;
  conversations: ConversationHit[];
  messages: MessageHit[];
}

/** LIKE 的通配符必须转义，否则用户打一个 % 就把整库翻出来了。 */
function likePattern(query: string): string {
  const escaped = query.replace(/[\\%_]/g, (ch) => `\\${ch}`);
  return `%${escaped}%`;
}

function snippetOf(content: string, query: string): string {
  const flat = content.replace(/\s+/g, ' ').trim();
  const at = flat.toLowerCase().indexOf(query.toLowerCase());

  if (at < 0) {
    return flat.length > SNIPPET_RADIUS * 2 ? `${flat.slice(0, SNIPPET_RADIUS * 2)}…` : flat;
  }

  const start = Math.max(0, at - SNIPPET_RADIUS);
  const end = Math.min(flat.length, at + query.length + SNIPPET_RADIUS);
  const head = start > 0 ? '…' : '';
  const tail = end < flat.length ? '…' : '';
  return `${head}${flat.slice(start, end)}${tail}`;
}

export function search(
  db: DatabaseSync,
  rawQuery: unknown,
  options: { limit?: unknown } = {},
): SearchResult {
  const query = String(rawQuery ?? '').trim().slice(0, MAX_QUERY_LENGTH);
  const limit = parseBoundedInteger(options.limit, 'limit', {
    min: 1,
    max: MAX_LIMIT,
    defaultValue: DEFAULT_LIMIT,
  });

  if (query === '') {
    return { query, conversations: [], messages: [] };
  }

  const pattern = likePattern(query);

  const conversations = db
    .prepare(
      `SELECT id, title, updated_at
         FROM conversations
        WHERE lower(title) LIKE lower(?) ESCAPE '\\'
        ORDER BY updated_at DESC
        LIMIT ?`,
    )
    .all(pattern, limit) as unknown as ConversationHit[];

  const placeholders = SEARCHABLE_MESSAGE_TYPES.map(() => '?').join(', ');
  const messageRows = db
    .prepare(
      `SELECT m.id AS message_id, m.conversation_id, c.title AS conversation_title,
              m.sender_kind, m.content, m.created_at
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
        WHERE lower(m.content) LIKE lower(?) ESCAPE '\\'
          AND m.message_type IN (${placeholders})
        ORDER BY m.created_at DESC
        LIMIT ?`,
    )
    .all(pattern, ...SEARCHABLE_MESSAGE_TYPES, limit) as unknown as Array<{
    message_id: string;
    conversation_id: string;
    conversation_title: string;
    sender_kind: string;
    content: string;
    created_at: string;
  }>;

  return {
    query,
    conversations,
    messages: messageRows.map((row) => ({
      message_id: row.message_id,
      conversation_id: row.conversation_id,
      conversation_title: row.conversation_title,
      sender_kind: row.sender_kind,
      snippet: snippetOf(row.content, query),
      created_at: row.created_at,
    })),
  };
}
