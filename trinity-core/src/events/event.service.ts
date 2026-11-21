import type { DatabaseSync } from 'node:sqlite';
import { parseBoundedInteger, parseEnumWithDefault } from '../common/validation.ts';

/**
 * 事件页的数据来源只有两张"Core 亲口说的话"：
 *   - task_status：一次委派任务的开始/结束
 *   - system_event：Core 观察到的异常（启动失败、超时、进程没退干净）
 * 它们都是 Core 自己写的，接口不接受客户端伪造。
 */
export const EVENT_FILTERS = ['all', 'task', 'system', 'error'] as const;
export type EventFilter = (typeof EVENT_FILTERS)[number];
type NamedFilter = Exclude<EventFilter, 'all'>;

/** 这几个 reason 意味着一次回合没有正常收尾。 */
const FAILURE_REASONS = ['launch_failed', 'run_failed', 'timeout', 'process_exit_unconfirmed'];

const BASE_WHERE = "m.message_type IN ('system_event', 'task_status')";
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

export interface EventItem {
  id: string;
  conversation_id: string;
  conversation_title: string | null;
  source: 'task' | 'system';
  reason: string | null;
  failed: boolean;
  content: string;
  created_at: string;
}

export interface EventListResult {
  items: EventItem[];
  total: number;
  limit: number;
  offset: number;
  counts: Record<NamedFilter, number>;
}

interface EventRow {
  id: string;
  conversation_id: string;
  conversation_title: string | null;
  message_type: string;
  content: string;
  metadata_json: string | null;
  created_at: string;
}

function readReason(metadataJson: string | null): string | null {
  if (!metadataJson) return null;

  try {
    const parsed: unknown = JSON.parse(metadataJson);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const reason = (parsed as Record<string, unknown>).reason;
    return typeof reason === 'string' ? reason : null;
  } catch {
    // 元数据坏掉不该让整页读不出来
    return null;
  }
}

function whereFor(filter: EventFilter): { sql: string; params: string[] } {
  if (filter === 'task') {
    return { sql: ` AND m.message_type = 'task_status'`, params: [] };
  }
  if (filter === 'system') {
    return { sql: ` AND m.message_type = 'system_event'`, params: [] };
  }
  if (filter === 'error') {
    const placeholders = FAILURE_REASONS.map(() => '?').join(', ');
    return {
      sql:
        ` AND m.message_type = 'system_event'` +
        ` AND m.metadata_json IS NOT NULL` +
        ` AND json_valid(m.metadata_json)` +
        ` AND json_extract(m.metadata_json, '$.reason') IN (${placeholders})`,
      params: [...FAILURE_REASONS],
    };
  }
  return { sql: '', params: [] };
}

export function listEvents(
  db: DatabaseSync,
  options: { filter?: unknown; limit?: unknown; offset?: unknown },
): EventListResult {
  const filter = parseEnumWithDefault(options.filter, 'filter', EVENT_FILTERS, 'all');
  const limit = parseBoundedInteger(options.limit, 'limit', {
    min: 1,
    max: MAX_LIMIT,
    defaultValue: DEFAULT_LIMIT,
  });
  const offset = parseBoundedInteger(options.offset, 'offset', {
    min: 0,
    max: 10_000_000,
    defaultValue: 0,
  });

  const where = whereFor(filter);

  const rows = db
    .prepare(
      `SELECT m.id, m.conversation_id, m.message_type, m.content, m.metadata_json, m.created_at,
              c.title AS conversation_title
         FROM messages m
         LEFT JOIN conversations c ON c.id = m.conversation_id
        WHERE ${BASE_WHERE}${where.sql}
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT ? OFFSET ?`,
    )
    .all(...where.params, limit, offset) as unknown as EventRow[];

  const totalRow = db
    .prepare(`SELECT COUNT(*) AS n FROM messages m WHERE ${BASE_WHERE}${where.sql}`)
    .get(...where.params) as { n: number } | undefined;

  const items: EventItem[] = rows.map((row) => {
    const reason = readReason(row.metadata_json);
    return {
      id: row.id,
      conversation_id: row.conversation_id,
      conversation_title: row.conversation_title,
      source: row.message_type === 'task_status' ? 'task' : 'system',
      reason,
      failed: reason !== null && FAILURE_REASONS.includes(reason),
      content: row.content,
      created_at: row.created_at,
    };
  });

  return {
    items,
    total: totalRow?.n ?? 0,
    limit,
    offset,
    counts: {
      task: countFor(db, 'task'),
      system: countFor(db, 'system'),
      error: countFor(db, 'error'),
    },
  };
}

function countFor(db: DatabaseSync, filter: NamedFilter): number {
  const where = whereFor(filter);
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM messages m WHERE ${BASE_WHERE}${where.sql}`)
    .get(...where.params) as { n: number } | undefined;
  return row?.n ?? 0;
}
