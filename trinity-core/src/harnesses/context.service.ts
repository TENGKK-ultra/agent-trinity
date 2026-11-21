import type { DatabaseSync } from 'node:sqlite';
import { withTransaction } from '../database/transaction.ts';
import * as sessionService from './session.service.ts';
import type { HarnessType } from './types.ts';

/**
 * The per-agent read cursor.
 *
 * A bare timestamp is not a safe cutoff: two messages can share a millisecond,
 * and `created_at > cursor` would then either skip one or repeat one. The
 * cursor is therefore `created_at|message_id`, stored in the existing TEXT
 * column `harness_sessions.last_read_at` (no migration). Ordering by
 * `(created_at, id)` makes the position exact.
 */
export interface Cursor {
  createdAt: string;
  id: string;
}

const SEPARATOR = '|';
const DEFAULT_LIMIT = 20;
const DEFAULT_MAX_CHARS = 600;

const DISPLAY_NAME: Record<HarnessType, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  deepseek: 'DeepSeek Harness',
};

export function encodeCursor(cursor: Cursor): string {
  return `${cursor.createdAt}${SEPARATOR}${cursor.id}`;
}

export function parseCursor(raw: string | null | undefined): Cursor | null {
  if (raw === null || raw === undefined || raw === '') return null;

  const index = raw.indexOf(SEPARATOR);

  if (index <= 0 || index === raw.length - 1) return null;

  const createdAt = raw.slice(0, index);
  const id = raw.slice(index + 1);

  if (Number.isNaN(Date.parse(createdAt))) return null;

  return { createdAt, id };
}

export function cursorOf(message: { created_at: string; id: string }): Cursor {
  return { createdAt: message.created_at, id: message.id };
}

/** Negative when `a` is older than `b`. */
export function compareCursors(a: Cursor, b: Cursor): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;

  return a.id === b.id ? 0 : a.id < b.id ? -1 : 1;
}

interface HistoryRow {
  id: string;
  created_at: string;
  sender_kind: string;
  sender_id: string | null;
  content: string;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * The shared conversation as this agent has not seen it: user messages and
 * other agents' replies after its cursor and before the current input. Tool
 * activity, system events and its own messages are excluded.
 */
export function buildSharedHistory(
  db: DatabaseSync,
  conversationId: string,
  agent: HarnessType,
  before: Cursor | null,
  options: { limit?: number; maxChars?: number } = {},
): string {
  const session = sessionService.findSession(db, conversationId, agent);
  const after = parseCursor(session?.last_read_at ?? null);

  const clauses = [
    `conversation_id = ?`,
    `message_type IN ('user_message', 'agent_final', 'agent_message')`,
    `NOT (sender_kind = 'agent' AND sender_id = ?)`,
  ];
  const params: Array<string | number> = [conversationId, DISPLAY_NAME[agent]];

  if (after !== null) {
    clauses.push('(created_at > ? OR (created_at = ? AND id > ?))');
    params.push(after.createdAt, after.createdAt, after.id);
  }

  if (before !== null) {
    clauses.push('(created_at < ? OR (created_at = ? AND id < ?))');
    params.push(before.createdAt, before.createdAt, before.id);
  }

  const limit = options.limit ?? DEFAULT_LIMIT;

  const rows = db
    .prepare(
      `SELECT id, created_at, sender_kind, sender_id, content
         FROM messages
        WHERE ${clauses.join(' AND ')}
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    )
    .all(...params, limit) as unknown as HistoryRow[];

  if (rows.length === 0) return '';

  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const lines = rows.reverse().map((row) => {
    const who = row.sender_kind === 'user' ? '用户' : (row.sender_id ?? 'Agent');
    return `${who}：${truncate(row.content, maxChars)}`;
  });

  return [
    '[共享对话记录]',
    '以下是本对话中你未参与时产生的内容，仅供了解上下文：',
    ...lines,
    '[/共享对话记录]',
  ].join('\n');
}

/**
 * Moves one agent's cursor forward. It never moves backwards, and an unusable
 * value is ignored rather than guessed. Each agent has its own row, so
 * concurrent agents cannot overwrite one another's position.
 */
export function advanceLastReadAt(
  db: DatabaseSync,
  sessionId: string,
  cursorRaw: string,
): boolean {
  const next = parseCursor(cursorRaw);

  if (next === null) return false;

  return withTransaction(db, () => {
    const row = db
      .prepare('SELECT last_read_at FROM harness_sessions WHERE id = ?')
      .get(sessionId) as { last_read_at: string | null } | undefined;

    if (!row) return false;

    const current = parseCursor(row.last_read_at);

    if (current !== null && compareCursors(next, current) <= 0) return false;

    db.prepare('UPDATE harness_sessions SET last_read_at = ? WHERE id = ?').run(
      encodeCursor(next),
      sessionId,
    );

    return true;
  });
}
