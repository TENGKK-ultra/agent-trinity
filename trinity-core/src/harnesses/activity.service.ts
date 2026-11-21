import type { DatabaseSync } from 'node:sqlite';
import { parseBoundedInteger } from '../common/validation.ts';
import * as conversationRepository from '../conversations/conversation.repository.ts';
import { ACTIVITY_MESSAGE_TYPES, appError, type MessageType } from '../types/index.ts';
import { getAdapter, SUPPORTED_HARNESSES } from './registry.ts';
import { sanitizeSummary, sanitizeToolName } from './activity-summary.ts';
import { safeSlice } from '../common/text.ts';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
// One timeline row is one line: a multi-line output would break the layout and
// a longer preview buys nothing the detail view does not already show.
const MAX_PREVIEW_CHARS = 200;

/** Only these metadata keys leave Core; tool input and raw payloads stay in. */
const METADATA_KEYS = [
  'turn_id',
  'tool',
  'ref',
  'summary',
  'task_id',
  'kind',
  'target_agent',
  'source_agent',
] as const;

export interface ActivityItem {
  seq: number;
  message_id: string;
  conversation_id: string;
  agent: string | null;
  sender_id: string | null;
  kind: MessageType;
  content_preview: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export interface ActivityPage {
  items: ActivityItem[];
  head_seq: number;
  has_more: boolean;
  limit: number;
}

/** One row, with its full body — what the list deliberately previews. */
export interface ActivityDetail extends ActivityItem {
  content: string;
}

interface ActivityRow {
  seq: number;
  message_id: string;
  conversation_id: string;
  sender_id: string | null;
  message_type: MessageType;
  content: string;
  metadata_json: string | null;
  created_at: string;
}

let displayNames: Map<string, string> | null = null;

function agentTypeOf(senderId: string | null): string | null {
  if (senderId === null) return null;

  if (displayNames === null) {
    displayNames = new Map();
    for (const type of SUPPORTED_HARNESSES) displayNames.set(getAdapter(type).displayName, type);
  }

  return displayNames.get(senderId) ?? null;
}

function previewOf(content: string): string {
  const line = content
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return line.length > MAX_PREVIEW_CHARS ? `${safeSlice(line, MAX_PREVIEW_CHARS - 1)}…` : line;
}

function metadataOf(raw: string | null): Record<string, unknown> | null {
  if (raw === null) return null;

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

  const source = parsed as Record<string, unknown>;
  const picked: Record<string, unknown> = {};

  for (const key of METADATA_KEYS) {
    if (source[key] !== undefined) picked[key] = source[key];
  }

  // Second gate: a tool name is a name, never a payload, before it leaves Core.
  if (picked.tool !== undefined) {
    const tool = sanitizeToolName(picked.tool);

    if (tool === null) delete picked.tool;
    else picked.tool = tool;
  }

  // Second gate: a summary is re-cleaned and re-capped before it leaves Core.
  if (picked.summary !== undefined) {
    const summary = sanitizeSummary(picked.summary);

    if (summary === null) delete picked.summary;
    else picked.summary = summary;
  }

  return Object.keys(picked).length > 0 ? picked : null;
}

export function getActivityItem(
  db: DatabaseSync,
  conversationId: string,
  messageId: string,
): ActivityDetail {
  if (!conversationRepository.findConversation(db, conversationId)) {
    throw appError('conversation_not_found', 'Conversation not found', 404);
  }

  const placeholders = ACTIVITY_MESSAGE_TYPES.map(() => '?').join(', ');

  const row = db
    .prepare(
      `SELECT c.seq AS seq, m.id AS message_id, m.conversation_id AS conversation_id,
              m.sender_id AS sender_id, m.message_type AS message_type,
              m.content AS content, m.metadata_json AS metadata_json,
              m.created_at AS created_at
         FROM change_log c
         JOIN messages m ON m.id = c.entity_id
        WHERE c.entity_type = 'message'
          AND c.conversation_id = ?
          AND m.id = ?
          AND m.message_type IN (${placeholders})
        LIMIT 1`,
    )
    .get(conversationId, messageId, ...ACTIVITY_MESSAGE_TYPES) as unknown as ActivityRow | undefined;

  if (!row) {
    throw appError('activity_not_found', 'Activity not found', 404);
  }

  return { ...toItem(row), content: row.content };
}

function toItem(row: ActivityRow): ActivityItem {
  return {
    seq: Number(row.seq),
    message_id: row.message_id,
    conversation_id: row.conversation_id,
    agent: agentTypeOf(row.sender_id),
    sender_id: row.sender_id,
    kind: row.message_type,
    content_preview: previewOf(row.content),
    metadata: metadataOf(row.metadata_json),
    created_at: row.created_at,
  };
}

function parsePageSize(value: unknown): number {
  return parseBoundedInteger(value, 'limit', {
    min: 1,
    max: MAX_PAGE_SIZE,
    defaultValue: DEFAULT_PAGE_SIZE,
  });
}

function parseCursor(value: unknown, field: string): number | null {
  if (value === undefined || value === null || value === '') return null;

  return parseBoundedInteger(value, field, {
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
    defaultValue: 0,
  });
}

/**
 * The activity timeline is built from the change log, not from a timestamp:
 * `seq` is the only ordering that cannot tie, reorder or skip under concurrent
 * writes. Each activity message has exactly one insert entry, written in the
 * same transaction as the message itself.
 */
export function listActivity(
  db: DatabaseSync,
  conversationId: string,
  query: unknown,
): ActivityPage {
  if (!conversationRepository.findConversation(db, conversationId)) {
    throw appError('conversation_not_found', 'Conversation not found', 404);
  }

  const params = (query ?? {}) as Record<string, unknown>;
  const limit = parsePageSize(params.limit);
  const afterSeq = parseCursor(params.after_seq, 'after_seq');
  const beforeSeq = parseCursor(params.before_seq, 'before_seq');

  if (afterSeq !== null && beforeSeq !== null) {
    throw appError('invalid_cursor', 'Use either after_seq or before_seq, not both', 400);
  }

  const placeholders = ACTIVITY_MESSAGE_TYPES.map(() => '?').join(', ');
  const types = [...ACTIVITY_MESSAGE_TYPES];
  const scope = `
      FROM change_log c
      JOIN messages m ON m.id = c.entity_id
     WHERE c.entity_type = 'message'
       AND c.conversation_id = ?
       AND m.message_type IN (${placeholders})`;

  // head_seq counts activity only: a chat message also writes change_log, and
  // its seq would otherwise look like unseen activity. Both queries run in one
  // synchronous block, so head_seq and the page describe the same state.
  const headRow = db
    .prepare(`SELECT COALESCE(MAX(c.seq), 0) AS head ${scope}`)
    .get(conversationId, ...types) as { head: number };

  const sql = `
    SELECT c.seq AS seq, m.id AS message_id, m.conversation_id AS conversation_id,
           m.sender_id AS sender_id, m.message_type AS message_type,
           m.content AS content, m.metadata_json AS metadata_json,
           m.created_at AS created_at
    ${scope}`;
  let rows: ActivityRow[];
  let newestFirst = false;

  if (afterSeq !== null) {
    rows = db
      .prepare(`${sql} AND c.seq > ? ORDER BY c.seq ASC LIMIT ?`)
      .all(conversationId, ...types, afterSeq, limit + 1) as unknown as ActivityRow[];
  } else if (beforeSeq !== null) {
    newestFirst = true;
    rows = db
      .prepare(`${sql} AND c.seq < ? ORDER BY c.seq DESC LIMIT ?`)
      .all(conversationId, ...types, beforeSeq, limit + 1) as unknown as ActivityRow[];
  } else {
    newestFirst = true;
    rows = db
      .prepare(`${sql} ORDER BY c.seq DESC LIMIT ?`)
      .all(conversationId, ...types, limit + 1) as unknown as ActivityRow[];
  }

  const hasMore = rows.length > limit;

  if (newestFirst) {
    rows.reverse();
    if (hasMore) rows = rows.slice(1);
  } else {
    rows = rows.slice(0, limit);
  }

  return {
    items: rows.map(toItem),
    head_seq: Number(headRow.head),
    has_more: hasMore,
    limit,
  };
}
